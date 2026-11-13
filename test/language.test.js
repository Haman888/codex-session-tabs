'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { t, errorText, setLanguage, resolveLanguage, formatDate } = require('../i18n');
const { activateLanguage } = require('../ui-language');
const { Titles } = require('../titles');
const { createSessionReader } = require('../sessions');
const manifest = require('../package.json');
const ID = '00000000-0000-0000-0000-000000000001';

test('both dictionaries cover every message and use matching named parameters', async () => {
  const root = path.resolve(__dirname, '..');
  const en = require('../translations/en.json'), ru = require('../translations/ru.json');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
  for (const key of Object.keys(en)) {
    assert.equal(typeof ru[key], 'string');
    assert.ok(en[key] && ru[key]);
    const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(placeholders(en[key]), placeholders(ru[key]), key);
  }
  for (const file of ['extension.js', 'titles.js', 'sessions.js', 'update-core.js', 'update-ui.js', 'ui-language.js']) {
    const source = await fs.readFile(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/\bt\('([^']+)'/g)) assert.ok(en[match[1]], `${file}: ${match[1]}`);
    assert.ok(!/[А-Яа-яЁё]/.test(source.replace('Language / Язык', '').replace('Русский', '')), `${file}: untranslated runtime string`);
  }
  assert.equal(resolveLanguage('auto', 'ru-RU'), 'ru');
  assert.equal(resolveLanguage('auto', 'de'), 'en');
  assert.equal(resolveLanguage('en', 'ru'), 'en');
  assert.equal(resolveLanguage('ru', 'en'), 'ru');
  setLanguage('en');
  assert.equal(t('update.downloadFailed', { status: 403 }), 'Could not download Codex: HTTP 403.');
  assert.equal(errorText({ sessionTabsKey: 'error.renameTimeout', message: 'fallback' }), 'Codex did not respond to the rename request.');
  setLanguage('ru');
  assert.equal(errorText({ sessionTabsKey: 'error.renameTimeout', message: 'fallback' }), 'Codex не ответил на запрос переименования.');
  assert.equal(errorText(new Error('Vendor error')), 'Vendor error');
  const time = Date.UTC(2026, 0, 2, 3, 4);
  assert.equal(formatDate(time), new Date(time).toLocaleString('ru-RU'));
});

function host(editorLanguage = 'en') {
  const handlers = new Map(), contexts = new Map(), listeners = new Set();
  let preference = 'auto', picked, target;
  const pickers = [];
  const config = {
    get: () => preference,
    update: async (name, value, where) => {
      assert.equal(name, 'language'); preference = value; target = where;
      for (const listener of listeners) listener({ affectsConfiguration: name => name === 'codexSessionTabs.language' });
    },
  };
  const vscode = {
    env: { language: editorLanguage }, ConfigurationTarget: { Global: 1 },
    workspace: {
      getConfiguration: name => { assert.equal(name, 'codexSessionTabs'); return config; },
      onDidChangeConfiguration: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    },
    commands: {
      registerCommand: (name, handler) => { assert.ok(!handlers.has(name)); handlers.set(name, handler); return { dispose: () => handlers.delete(name) }; },
      executeCommand: async (name, ...args) => {
        if (name === 'setContext') { contexts.set(args[0], args[1]); return; }
        assert.ok(handlers.has(name), name); return handlers.get(name)(...args);
      },
    },
    window: {
      showQuickPick: async (options, settings) => { pickers.push({ options, settings }); return picked ? options.find(option => option.value === picked) : undefined; },
      showErrorMessage: message => assert.fail(message),
    },
  };
  return { vscode, contexts, handlers, pickers, context: { subscriptions: [] }, pick: value => { picked = value; }, target: () => target };
}

test('the picker switches both ways without changing VS Code language and aliases forward arguments', async () => {
  const f = host('ru'), events = [];
  const api = activateLanguage(f.vscode, f.context, language => { events.push(language); });
  await api.ready;
  assert.equal(f.contexts.get('codexSessionTabs.uiLanguage'), 'ru');
  f.pick('en'); await f.vscode.commands.executeCommand('codexSessionTabs.language');
  assert.equal(f.contexts.get('codexSessionTabs.uiLanguage'), 'en');
  assert.equal(f.target(), f.vscode.ConfigurationTarget.Global);
  assert.equal(f.vscode.env.language, 'ru');
  const calls = [];
  f.handlers.set('codexSessionTabs.rename', (...args) => calls.push(args));
  const row = { id: ID };
  await f.vscode.commands.executeCommand('codexSessionTabs.rename.en', row, 'Manual name');
  assert.deepEqual(calls, [[row, 'Manual name']]);
  f.pick('ru'); await f.vscode.commands.executeCommand('codexSessionTabs.language');
  f.pick('auto'); await f.vscode.commands.executeCommand('codexSessionTabs.language');
  assert.deepEqual(events, ['ru', 'en', 'ru'], 'An equivalent preference does not repeat UI work');
  for (const disposable of f.context.subscriptions) disposable.dispose();
  assert.ok(!f.handlers.has('codexSessionTabs.language'));
});

test('each menu and palette action exposes only the selected language', () => {
  const commands = new Map(manifest.contributes.commands.map(item => [item.command, item]));
  const bases = new Set();
  for (const { command, when } of manifest.contributes.menus.commandPalette) {
    const lang = command.slice(-2), base = command.slice(0, -3);
    assert.ok(commands.has(command));
    assert.equal(when, `codexSessionTabs.uiLanguage == ${lang}`);
    assert.ok(commands.has(base + '.en') && commands.has(base + '.ru'));
    assert.notEqual(commands.get(base + '.en').title, commands.get(base + '.ru').title);
    bases.add(base);
  }
  assert.equal(manifest.contributes.menus.commandPalette.length, bases.size * 2);
  for (const base of bases) assert.ok(manifest.activationEvents.includes(`onCommand:${base}`), 'Existing command IDs still activate the companion');
  for (const base of bases) {
    const key = 'command.' + base.split('.').at(-1);
    assert.equal(commands.get(base + '.en').title, require('../translations/en.json')[key]);
    assert.equal(commands.get(base + '.ru').title, require('../translations/ru.json')[key]);
  }
  for (const [location, entries] of Object.entries(manifest.contributes.menus)) {
    if (location === 'commandPalette') continue;
    for (const item of entries) {
      assert.ok(commands.has(item.command));
      if (item.command === 'codexSessionTabs.language') continue;
      assert.ok(item.when.endsWith(`codexSessionTabs.uiLanguage == ${item.command.slice(-2)}`));
    }
  }
  assert.equal(manifest.contributes.viewsWelcome.length, 2);
  assert.equal(manifest.contributes.configuration.properties['codexSessionTabs.language'].default, 'auto');
});

test('switching languages preserves saved/manual names and avoids numbered draft collisions', async () => {
  setLanguage('ru');
  const saved = new Map(), controls = new Map();
  const context = { globalState: { get: (key, fallback) => saved.get(key) ?? fallback, update: async (key, value) => saved.set(key, value) } };
  const titles = new Titles(context, async () => [{ id: ID, title: 'Сохранённый разговор' }], () => {}, { appendLine() {} });
  const panel = key => {
    controls.set(key, { title: 'Codex' });
    return { key, getTitle: () => controls.get(key).title, setTitle: title => { controls.get(key).title = title; }, rename: async () => assert.fail('Language switching must not rename conversations') };
  };
  await titles.attach({ ...panel('saved'), id: ID });
  await titles.attach(panel('draft'));
  await titles.attach(panel('manual'));
  await titles.rename({ key: 'manual' }, 'New chat 1');
  assert.equal(controls.get('draft').title, 'Новый диалог 1');
  setLanguage('en'); await titles.localizeDrafts();
  assert.equal(controls.get('saved').title, 'Сохранённый разговор');
  assert.equal(controls.get('manual').title, 'New chat 1');
  assert.equal(controls.get('draft').title, 'New chat 3', 'The translated automatic label skips the manual name and current counter');
  await titles.attach(panel('next'));
  assert.equal(controls.get('next').title, 'New chat 4');
  setLanguage('ru'); await titles.localizeDrafts();
  assert.equal(controls.get('draft').title, 'Новый диалог 3');
  assert.equal(controls.get('manual').title, 'New chat 1');
  assert.equal(controls.get('saved').title, 'Сохранённый разговор');
  await titles.persistence;
  assert.equal(saved.get('draftTitles').manual.custom, true);
});

test('cached history errors change language without retrying the database', async () => {
  setLanguage('en');
  let calls = 0;
  const reader = createSessionReader({ load: async () => { calls++; throw Error('unavailable'); } });
  await assert.rejects(reader.list(), /temporarily unavailable/);
  setLanguage('ru');
  assert.match(reader.status().error, /временно недоступна/);
  await assert.rejects(reader.list(), /временно недоступна/);
  assert.equal(calls, 1);
});

test('activation connects the language picker to sidebar titles, history and actual title controls', async () => {
  const f = host('ru'), trees = new Map(), saved = new Map();
  const disposable = () => ({ dispose() {} });
  const rows = [
    { id: ID, title: 'Сохранённый разговор', updatedAt: 1000 },
    { id: '00000000-0000-0000-0000-000000000002', title: 'Closed conversation', updatedAt: 2000 },
  ];
  class CustomInput { constructor(uri) { this.uri = uri; this.viewType = 'chatgpt.conversationEditor'; } }
  const uri = { scheme: 'openai-codex', authority: 'route', path: '/local/' + ID, toString: () => 'openai-codex://route/local/' + ID };
  const tab = { input: new CustomInput(uri), label: rows[0].title };
  const group = { tabs: [tab] };
  Object.assign(f.vscode, {
    TabInputCustom: CustomInput, ExtensionMode: { Production: 1, Test: 3 },
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class {}, ThemeColor: class {},
    EventEmitter: class { constructor() { this.event = disposable; } fire() {} dispose() {} },
  });
  Object.assign(f.vscode.window, {
    state: { focused: true },
    tabGroups: { all: [group], activeTabGroup: { activeTab: tab }, onDidChangeTabs: disposable, onDidChangeTabGroups: disposable },
    createOutputChannel: () => ({ appendLine: message => assert.fail(message), dispose() {} }),
    createTreeView: id => { const tree = { id, onDidChangeVisibility: disposable, dispose() {} }; trees.set(id, tree); return tree; },
    onDidChangeWindowState: disposable,
  });
  Object.assign(f.vscode.workspace, { workspaceFolders: [], onDidChangeWorkspaceFolders: disposable });
  f.context.extensionMode = 3;
  f.context.globalState = { get: (key, fallback) => saved.get(key) ?? fallback, update: async (key, value) => saved.set(key, value) };
  const file = path.resolve(__dirname, '../extension.js'), nativeRequire = createRequire(file), module = { exports: {} };
  vm.runInNewContext(await fs.readFile(file, 'utf8'), {
    module, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    require: name => {
      if (name === 'vscode') return f.vscode;
      if (name === 'node:fs') return { watch: () => ({ close() {} }) };
      if (name === './sessions') return { codexHome: () => '/artificial-home', listSessions: async () => rows, getSessionStatus: () => ({}), resetSessions() {} };
      if (name === './badges') return { prepareBadges: async () => ({}) };
      if (name === './update-ui') return { activateUpdates: () => ({ check: async () => ({ status: 'ready' }) }) };
      if (name === './usage') return require('./usage-host').loadUsage(f.vscode);
      return nativeRequire(name);
    },
  });
  f.vscode.window.registerUriHandler = disposable;
  const api = module.exports.activate(f.context);
  await api.language.ready;
  await api.titles.attach({ key: uri.toString(), id: ID, getTitle: () => tab.label, setTitle: title => { tab.label = title; } });
  assert.equal(api.view.title, 'Открытые сессии');
  assert.equal(api.historyView.title, 'История');
  f.pick('en'); await f.vscode.commands.executeCommand('codexSessionTabs.language');
  assert.equal(api.view.title, 'Open sessions');
  assert.equal(api.historyView.title, 'History');
  assert.equal(api.historyView.description, 'All folders');
  assert.equal(tab.label, rows[0].title);
  const item = api.provider.getTreeItem(rows[0]);
  assert.ok(item.tooltip.includes('Updated:'));
  assert.equal(api.provider.getTreeItem({ ...rows[0], title: '' }).label, 'Codex conversation');
  await f.vscode.commands.executeCommand('codexSessionTabs.history.en');
  assert.equal(f.pickers.at(-1).settings.title, 'Codex history');
  f.pick('ru'); await f.vscode.commands.executeCommand('codexSessionTabs.language');
  assert.equal(api.view.title, 'Открытые сессии');
  assert.equal(tab.label, rows[0].title);
  await api.titles.persistence;
  for (const entry of f.context.subscriptions) entry.dispose();
});
