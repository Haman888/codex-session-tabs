'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const IDS = [1, 2, 3].map(n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`);

function clock() {
  let now = 0, next = 0;
  const jobs = new Map();
  const schedule = (fn, delay, interval = false) => {
    const id = ++next;
    jobs.set(id, { fn, at: now + delay, delay, interval });
    return id;
  };
  return {
    setTimeout: (fn, delay) => schedule(fn, delay),
    clearTimeout: id => jobs.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true),
    clearInterval: id => jobs.delete(id),
    async tick(ms) {
      const end = now + ms;
      while (true) {
        const first = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        const [id, job] = first;
        now = job.at;
        if (job.interval) job.at += job.delay;
        else jobs.delete(id);
        job.fn();
        await Promise.resolve(); await Promise.resolve();
      }
      now = end;
      await Promise.resolve();
    },
  };
}

async function fixture(saved = new Map([['unreadSessions', IDS.slice()]]), { beforeWrite = async () => {} } = {}) {
  const timers = clock();
  class EventEmitter {
    constructor() { this.listeners = new Set(); }
    event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; };
    fire(value) { for (const fn of [...this.listeners]) fn(value); }
    dispose() { this.listeners.clear(); }
  }
  class TabInputCustom {
    constructor(uri) { this.uri = uri; this.viewType = 'chatgpt.conversationEditor'; }
  }
  const events = { tabs: new EventEmitter(), groups: new EventEmitter(), focus: new EventEmitter(), folders: new EventEmitter() };
  const tabs = IDS.map(id => {
    const uri = { scheme: 'openai-codex', authority: 'route', path: `/local/${id}`, toString: () => `openai-codex://route/local/${id}` };
    return { input: new TabInputCustom(uri), label: 'Synthetic chat' };
  });
  const group = { tabs, activeTab: tabs[0], viewColumn: 1 };
  const commands = new Map();
  const panels = new Map();
  const icons = { light: { toString: () => 'file:///synthetic/light.svg' }, dark: { toString: () => 'file:///synthetic/dark.svg' } };
  const vscode = {
    EventEmitter, TabInputCustom,
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    ExtensionMode: { Production: 1, Test: 3 },
    env: { language: 'en' },
    workspace: {
      workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      onDidChangeWorkspaceFolders: events.folders.event,
    },
    window: {
      state: { focused: true }, onDidChangeWindowState: events.focus.event,
      tabGroups: { all: [group], activeTabGroup: group, onDidChangeTabs: events.tabs.event, onDidChangeTabGroups: events.groups.event },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      registerUriHandler: () => ({ dispose() {} }),
      createTreeView: () => ({ visible: true, onDidChangeVisibility: new EventEmitter().event, dispose() {} }),
    },
    commands: {
      registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() { commands.delete(name); } }; },
      executeCommand: async (name, ...args) => commands.get(name)?.(...args),
    },
  };
  const rows = IDS.map(id => ({ id, title: 'Synthetic chat', cwd: '/synthetic', updatedAt: 1 }));
  const context = { subscriptions: [], extensionMode: 3, globalState: {
    get: (key, fallback) => saved.has(key) ? saved.get(key) : fallback,
    update: async (key, value) => { await beforeWrite(key); saved.set(key, value); },
  } };
  const module = { exports: {} };
  const localRequire = name => {
    if (name === 'vscode') return vscode;
    if (name === 'node:fs') return { watch: () => ({ close() {} }) };
    if (name === './sessions') return { codexHome: () => '/synthetic', listSessions: async () => rows, getSessionStatus: () => ({}), resetSessions() {} };
    if (name === './badges') return { prepareBadges: async () => icons };
    if (name === './update-ui') return { activateUpdates: () => ({ check: async () => {} }) };
    if (name === './ui-language') return { activateLanguage: () => ({ ready: Promise.resolve() }) };
    if (name === './usage') return require('./usage-host').loadUsage(vscode);
    return name.startsWith('./') ? require(path.join(__dirname, '..', name)) : require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8'), { module, require: localRequire, ...timers });
  const api = module.exports.activate(context);
  await api.titles.options.iconsReady;
  const activateTab = index => { group.activeTab = tabs[index]; events.tabs.fire({ changed: [tabs[index]] }); };
  const bind = async (index, { ready = false, visible = true } = {}) => {
    const state = { ready, visible, icon: 'original', iconWrites: 0 };
    const binding = {
      key: tabs[index].input.uri.toString(), id: IDS[index],
      isReady: () => state.ready, isVisible: () => state.visible && vscode.window.state.focused,
      getTitle: () => tabs[index].label, setTitle: value => { tabs[index].label = value; },
      getIcon: () => state.icon, setUnread: (value, valueIcons) => { state.iconWrites++; state.icon = value ? valueIcons : 'original'; },
    };
    panels.set(index, state);
    await commands.get('codexSessionTabs.nativePanel')(binding);
    return state;
  };
  return { api, saved, commands, timers, events, vscode, bind, activateTab, panels, icons,
    unread: () => IDS.filter(id => api.titles.isUnread(id)),
    sidebarUnread: index => api.provider.getTreeItem(rows[index]).iconPath.id === 'circle-filled',
    sidebarItem: index => api.provider.getTreeItem(rows[index]),
    dispose: () => { for (const subscription of [...context.subscriptions].reverse()) subscription.dispose?.(); },
    deactivate: () => module.exports.deactivate?.(),
  };
}

test('restoring tabs and refreshing history never reads an unready conversation', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < IDS.length; i++) { await f.bind(i); f.activateTab(i); }
    await f.commands.get('codexSessionTabs.refresh')();
    await f.timers.tick(10000);
    assert.equal(f.unread().length, 3);
    assert.ok(IDS.every((_, i) => f.sidebarUnread(i)));
    await f.api.titles.persistence;
    const restarted = await fixture(f.saved);
    try { assert.equal(restarted.unread().length, 3); } finally { restarted.dispose(); }
  } finally { f.dispose(); }
});

test('a ready visible conversation is read only after a continuous viewing interval', async () => {
  const f = await fixture();
  try {
    await f.bind(0, { ready: true });
    f.activateTab(0);
    await f.timers.tick(999);
    assert.equal(f.unread().length, 3);
    await f.timers.tick(1);
    assert.equal(f.api.titles.isUnread(IDS[0]), false);
    assert.equal(f.sidebarUnread(0), false);
    assert.equal(f.panels.get(0).icon, 'original');
    assert.equal(f.unread().length, 2);
  } finally { f.dispose(); }
});

test('switching tabs during restoration cancels premature read confirmation', async () => {
  const f = await fixture();
  try {
    await f.bind(0, { ready: true }); await f.bind(1, { ready: true });
    f.activateTab(0); await f.timers.tick(600);
    f.activateTab(1); await f.timers.tick(600);
    assert.equal(f.unread().length, 3);
    await f.timers.tick(400);
    assert.equal(f.api.titles.isUnread(IDS[1]), false);
    assert.equal(f.api.titles.isUnread(IDS[0]), true);
  } finally { f.dispose(); }
});

test('focus loss and hidden panels cancel reading until the conversation is visible again', async () => {
  const f = await fixture();
  try {
    const panel = await f.bind(0, { ready: true });
    f.activateTab(0); await f.timers.tick(600);
    f.vscode.window.state.focused = false; f.events.focus.fire({ focused: false });
    await f.timers.tick(2000);
    assert.equal(f.unread().length, 3);
    panel.visible = false;
    f.vscode.window.state.focused = true; f.events.focus.fire({ focused: true });
    await f.timers.tick(2000);
    assert.equal(f.unread().length, 3);
    panel.visible = true; f.events.tabs.fire({});
    await f.timers.tick(1000);
    assert.equal(f.api.titles.isUnread(IDS[0]), false);
  } finally { f.dispose(); }
});

test('completion on an active but unready restored tab remains unread', async () => {
  const f = await fixture(new Map());
  try {
    const panel = await f.bind(0);
    f.activateTab(0);
    f.commands.get('codexSessionTabs.nativeActivity')({ id: IDS[0], phase: 'completed', turnId: 'synthetic-turn' });
    assert.equal(f.api.titles.isUnread(IDS[0]), true);
    await f.timers.tick(5000);
    assert.equal(f.sidebarUnread(0), true);
    panel.ready = true; f.events.tabs.fire({});
    await f.timers.tick(1000);
    assert.equal(f.api.titles.isUnread(IDS[0]), false);
  } finally { f.dispose(); }
});

test('refresh repaints an unread tab icon after the native editor overwrites it', async () => {
  const f = await fixture();
  try {
    const panel = await f.bind(1);
    assert.equal(panel.icon, f.icons);
    panel.icon = 'native icon overwritten';
    await f.api.titles.sync();
    assert.equal(panel.icon, f.icons);
    assert.equal(f.sidebarUnread(1), true);
  } finally { f.dispose(); }
});

test('shutdown cancels a pending read timer and waits for queued state writes', async () => {
  let unblock, blocked = false;
  const gate = new Promise(resolve => { unblock = resolve; });
  const f = await fixture(undefined, { beforeWrite: async key => {
    if (key === 'unreadSessions') { blocked = true; await gate; }
  } });
  try {
    await f.bind(0, { ready: true }); f.activateTab(0);
    await f.timers.tick(500);
    f.commands.get('codexSessionTabs.nativeActivity')({ id: IDS[1], phase: 'completed', turnId: 'save-before-shutdown' });
    const shutdown = f.deactivate();
    let completed = false;
    assert.equal(typeof shutdown?.then, 'function');
    shutdown.then(() => { completed = true; });
    for (let i = 0; i < 20 && !blocked; i++) await Promise.resolve();
    assert.equal(blocked, true);
    assert.equal(completed, false, 'Deactivation waits for storage, not just its in-memory update');
    unblock(); await shutdown;
    await f.timers.tick(1000);
    assert.equal(f.api.titles.isUnread(IDS[0]), true);
    assert.ok(Array.isArray(f.saved.get('unreadSessions')));
    assert.equal(f.saved.get('unreadSessions').length, 3);
  } finally { unblock(); f.dispose(); }
});

test('equivalent reconstructed light/dark icon URIs do not trigger endless repainting', async () => {
  const f = await fixture();
  try {
    const panel = await f.bind(1);
    const writes = panel.iconWrites;
    panel.icon = { light: { toString: () => 'file:///synthetic/light.svg' }, dark: { toString: () => 'file:///synthetic/dark.svg' } };
    await f.api.titles.sync(); await f.api.titles.sync();
    assert.equal(panel.iconWrites, writes);
    assert.equal(f.sidebarUnread(1), true);
  } finally { f.dispose(); }
});

test('closing a viewed tab cancels its delayed acknowledgement', async () => {
  const f = await fixture();
  try {
    await f.bind(0, { ready: true }); f.activateTab(0);
    await f.timers.tick(500);
    const key = 'openai-codex://route/local/' + IDS[0];
    f.commands.get('codexSessionTabs.nativeClosed')(key);
    await f.timers.tick(1000);
    assert.equal(f.api.titles.isUnread(IDS[0]), true);
    assert.equal(f.sidebarUnread(0), true);
  } finally { f.dispose(); }
});

test('background work shows a spinner immediately, then an unread dot, then a normal icon after viewing', async () => {
  const f = await fixture(new Map());
  try {
    await f.bind(1, { ready: true });
    let changed = 0;
    const subscription = f.api.provider.onDidChangeTreeData(() => { changed++; });
    f.commands.get('codexSessionTabs.nativeActivity')({ id: IDS[1], phase: 'started', turnId: 'work' });
    assert.equal(f.sidebarItem(1).iconPath.id, 'loading~spin');
    assert.ok(changed > 0, 'The started notification refreshes the tree without waiting for polling');
    assert.match(f.sidebarItem(1).tooltip, /Working|Работает/);
    f.commands.get('codexSessionTabs.nativeActivity')({ id: IDS[1], phase: 'completed', turnId: 'work' });
    assert.equal(f.sidebarItem(1).iconPath.id, 'circle-filled');
    f.activateTab(1); await f.timers.tick(1000);
    assert.equal(f.sidebarItem(1).iconPath.id, 'comment-discussion');
    subscription.dispose();
  } finally { f.dispose(); }
});

test('a running spinner takes priority over an older unread answer without deleting it', async () => {
  const f = await fixture();
  try {
    f.commands.get('codexSessionTabs.nativeActivity')({ id: IDS[1], phase: 'started', turnId: 'next' });
    assert.equal(f.sidebarItem(1).iconPath.id, 'loading~spin');
    assert.equal(f.api.titles.isUnread(IDS[1]), true);
    assert.doesNotMatch(f.sidebarItem(1).tooltip, /Done|Готово/);
  } finally { f.dispose(); }
});

test('parallel spinners are independent and stale turn events cannot stop current work', async () => {
  const f = await fixture(new Map());
  const activity = (id, phase, turnId) => f.commands.get('codexSessionTabs.nativeActivity')({ id, phase, turnId });
  try {
    activity(IDS[1], 'started', 'older'); activity(IDS[1], 'started', 'current');
    activity(IDS[2], 'started', 'parallel');
    activity(IDS[1], 'completed', 'older');
    assert.equal(f.sidebarItem(1).iconPath.id, 'loading~spin');
    assert.equal(f.sidebarItem(2).iconPath.id, 'loading~spin');
    activity(IDS[1], 'completed', 'current');
    activity(IDS[1], 'started', 'older');
    assert.equal(f.sidebarItem(1).iconPath.id, 'circle-filled');
    assert.equal(f.sidebarItem(2).iconPath.id, 'loading~spin');
    activity(IDS[2], 'completed', 'parallel');
    assert.equal(f.sidebarItem(2).iconPath.id, 'circle-filled');
  } finally { f.dispose(); }
});

test('a foreground response stops spinning without creating an unread dot', async () => {
  const f = await fixture(new Map());
  try {
    await f.bind(0, { ready: true });
    f.commands.get('codexSessionTabs.nativeActivity')({ id: IDS[0], phase: 'started', turnId: 'foreground' });
    assert.equal(f.sidebarItem(0).iconPath.id, 'loading~spin');
    f.commands.get('codexSessionTabs.nativeActivity')({ id: IDS[0], phase: 'completed', turnId: 'foreground' });
    assert.equal(f.sidebarItem(0).iconPath.id, 'comment-discussion');
    assert.equal(f.api.titles.isUnread(IDS[0]), false);
  } finally { f.dispose(); }
});

test('an ID-less duplicate start retains correlation and the spinner until the matching completion', async () => {
  const f = await fixture(new Map());
  try {
    const activity = (phase, turnId) => f.commands.get('codexSessionTabs.nativeActivity')({ id: IDS[1], phase, turnId });
    activity('started', 'known'); activity('started'); activity('completed', 'unrelated');
    assert.equal(f.sidebarItem(1).iconPath.id, 'loading~spin');
    activity('completed', 'known');
    assert.equal(f.sidebarItem(1).iconPath.id, 'circle-filled');
  } finally { f.dispose(); }
});

test('restart does not replay a historical running marker without live activity evidence', async () => {
  const f = await fixture();
  try {
    f.commands.get('codexSessionTabs.nativeActivity')({ id: IDS[1], phase: 'started', turnId: 'previous-process' });
    assert.equal(f.sidebarItem(1).iconPath.id, 'loading~spin');
    await f.api.titles.persist();
    const restarted = await fixture(f.saved);
    try { assert.equal(restarted.sidebarItem(1).iconPath.id, 'circle-filled'); }
    finally { restarted.dispose(); }
  } finally { f.dispose(); }
});
