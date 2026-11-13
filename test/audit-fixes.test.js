'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { makeTemp } = require('./temp');
const { setLanguage } = require('../i18n');
const { createSessionReader, readSessions } = require('../sessions');
const { Titles } = require('../titles');

const root = path.resolve(__dirname, '..');
const ID = '00000000-0000-0000-0000-000000000001';
const LONG = 'Разобрать ошибки сборки за неделю и предложить исправление конфигурации';
const disposable = () => ({ dispose() {} });

async function host() {
  setLanguage('ru');
  const commands = new Map(), inputs = [], renames = [], closed = [], errors = [];
  let tick, listCalls = 0, answer;
  class EventEmitter {
    constructor() { this.listeners = new Set(); }
    event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; };
    fire(value) { for (const fn of [...this.listeners]) fn(value); }
    dispose() { this.listeners.clear(); }
  }
  class TabInputCustom { constructor(uri) { this.uri = uri; this.viewType = 'chatgpt.conversationEditor'; } }
  const uri = { scheme: 'openai-codex', authority: 'route', path: `/local/${ID}`, toString: () => `openai-codex://route/local/${ID}` };
  const tab = { input: new TabInputCustom(uri), label: 'Codex' };
  const group = { tabs: [tab], activeTab: tab, viewColumn: 1 };
  const vscode = {
    EventEmitter, TabInputCustom,
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    ExtensionMode: { Production: 1, Test: 3 },
    env: { language: 'ru' },
    extensions: { getExtension: () => undefined },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }), onDidChangeWorkspaceFolders: disposable },
    window: {
      state: { focused: true }, onDidChangeWindowState: disposable,
      tabGroups: { all: [group], activeTabGroup: group, onDidChangeTabs: disposable, onDidChangeTabGroups: disposable,
        close: async closing => { closed.push(closing); } },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      registerUriHandler: disposable,
      createTreeView: () => ({ visible: false, onDidChangeVisibility: disposable, dispose() {} }),
      showInputBox: async options => { inputs.push(options); return answer; },
      showQuickPick: async () => undefined,
      showErrorMessage: async (...args) => { errors.push(args); },
      showInformationMessage: async () => {},
    },
    commands: {
      registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() { commands.delete(name); } }; },
      executeCommand: async (name, ...args) => commands.get(name)?.(...args),
    },
  };
  const rows = [{ id: ID, title: LONG, cwd: '/synthetic', updatedAt: 1 }];
  const saved = new Map();
  const context = { subscriptions: [], extensionMode: vscode.ExtensionMode.Test, globalState: {
    get: (key, fallback) => saved.has(key) ? saved.get(key) : fallback,
    update: async (key, value) => { saved.set(key, value); },
  } };
  const module = { exports: {} };
  const localRequire = name => {
    if (name === 'vscode') return vscode;
    if (name === 'node:fs') return { watch: () => ({ close() {} }) };
    if (name === './sessions') return { codexHome: () => '/synthetic', listSessions: async () => { listCalls++; return rows; },
      getSessionStatus: () => ({}), resetSessions() {}, invalidateSessions() {} };
    if (name === './badges') return { prepareBadges: async () => ({}) };
    if (name === './update-ui') return { activateUpdates: () => ({ check: async () => ({ status: 'ready' }) }) };
    if (name === './ui-language') return { activateLanguage: () => ({ ready: Promise.resolve() }) };
    if (name === './usage') return require('./usage-host').loadUsage(vscode);
    return name.startsWith('./') ? require(path.join(root, name)) : require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension.js'), 'utf8'), {
    module, require: localRequire, setTimeout, clearTimeout,
    setInterval: fn => { tick = fn; return 1; }, clearInterval() {},
  });
  const api = module.exports.activate(context);
  await commands.get('codexSessionTabs.nativePanel')({
    key: uri.toString(), id: ID, getTitle: () => tab.label, setTitle: value => { tab.label = value; },
    rename: async (id, name) => { renames.push({ id, name }); },
  });
  return { api, commands, inputs, renames, closed, errors, uri, tab, vscode,
    tick: () => tick(), listCalls: () => listCalls, answer: value => { answer = value; },
    dispose: () => { for (const subscription of [...context.subscriptions].reverse()) subscription.dispose?.(); } };
}

test('renaming from a tab menu asks for the full name and never saves the menu context', async () => {
  const f = await host();
  try {
    assert.equal(f.tab.label, 'Разобрать ошибки сборки за неделю…');
    // VS Code runs editor title menu commands with (resource, {groupId, editorIndex}).
    await f.commands.get('codexSessionTabs.rename')(f.uri, { groupId: 1, editorIndex: 0 });
    assert.equal(f.inputs.length, 1, 'The menu context is not a name');
    assert.equal(f.inputs[0].value, LONG, 'The box starts from the full conversation name');
    assert.deepEqual(f.renames, []);
    f.answer('Новое название');
    await f.commands.get('codexSessionTabs.rename')(f.uri, { groupId: 1, editorIndex: 0 });
    assert.deepEqual(f.renames, [{ id: ID, name: 'Новое название' }]);
    assert.equal(f.tab.label, 'Новое название');
    assert.deepEqual(f.errors, []);
  } finally { f.dispose(); }
});

test('a conversation name must be text, and a restored conversation missing from history is not a new chat', async () => {
  setLanguage('en');
  const saved = new Map(), renames = [];
  const context = { globalState: { get: (key, fallback) => saved.has(key) ? saved.get(key) : fallback, update: async (key, value) => { saved.set(key, value); } } };
  const titles = new Titles(context, async () => [], () => {}, { appendLine() {} });
  const key = `openai-codex://route/local/${ID}`;
  let label = 'Codex';
  await titles.attach({ key, id: ID, getTitle: () => label, setTitle: value => { label = value; }, rename: async (_id, name) => { renames.push(name); } });
  assert.equal(label, 'Codex conversation');
  await assert.rejects(titles.rename({ key, id: ID }, { groupId: 1, editorIndex: 0 }));
  assert.deepEqual(renames, []);
});

test('“Close tab” from the Command Palette closes the active Codex tab', async () => {
  const f = await host();
  try {
    await f.commands.get('codexSessionTabs.close')();
    assert.deepEqual(f.closed, [f.tab]);
    await f.commands.get('codexSessionTabs.close')(f.uri);
    assert.deepEqual(f.closed, [f.tab, f.tab]);
    assert.deepEqual(f.errors, []);
  } finally { f.dispose(); }
});

test('a background window does not poll history; a focused one does', async () => {
  const f = await host();
  try {
    const before = f.listCalls();
    f.vscode.window.state.focused = false;
    f.tick();
    assert.equal(f.listCalls(), before);
    f.vscode.window.state.focused = true;
    f.tick();
    assert.equal(f.listCalls(), before + 1);
    await f.api.titles.syncing;
  } finally { f.dispose(); }
});

test('a database change reloads history soon but not more often than the interval; idle reads reuse the cache', async () => {
  let clock = 0, loads = 0;
  const reader = createSessionReader({ now: () => clock, ttl: 30000, minInterval: 5000, load: async () => { loads++; return []; } });
  await reader.list(); assert.equal(loads, 1);
  clock = 4000; await reader.list(); assert.equal(loads, 1, 'Cached');
  reader.invalidate();
  clock = 4500; await reader.list(); assert.equal(loads, 1, 'Not more often than once per interval');
  clock = 5000; await reader.list(); assert.equal(loads, 2, 'Reloaded after the change');
  clock = 20000; await reader.list(); assert.equal(loads, 2, 'An idle refresh uses the long cache');
  clock = 35000; await reader.list(); assert.equal(loads, 3);

  clock = 0;
  let calls = 0, finish;
  const slow = createSessionReader({ now: () => clock, ttl: 30000, minInterval: 5000,
    load: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const first = slow.list();
  slow.invalidate();
  finish([]); await first;
  clock = 5000;
  const second = slow.list();
  assert.equal(calls, 2, 'A change during a read is read again after the interval');
  finish([]); await second;
});

test('one history reload runs sqlite3 once after the first read of a database', async () => {
  const home = await makeTemp('cst-columns-');
  try {
    await fsp.writeFile(path.join(home, 'state_5.sqlite'), '');
    const queries = [];
    const run = async (_database, sql) => {
      queries.push(sql.trim().split(/\s+/)[0]);
      if (sql.startsWith('PRAGMA')) return ['id', 'title', 'cwd', 'source', 'archived', 'updated_at'].map(name => ({ name }));
      return [{ id: ID, title: 'Synthetic chat', cwd: '/synthetic', updatedAt: 1, pinned: 0 }];
    };
    assert.equal((await readSessions({ home, run })).length, 1);
    assert.deepEqual(queries, ['PRAGMA', 'SELECT']);
    await readSessions({ home, run });
    assert.deepEqual(queries, ['PRAGMA', 'SELECT', 'SELECT']);
    await assert.rejects(readSessions({ home, run: async () => { throw new Error('locked'); } }));
    await readSessions({ home, run });
    assert.deepEqual(queries.slice(-2), ['PRAGMA', 'SELECT'], 'A failed read forgets the cached columns');
  } finally { await fsp.rm(home, { recursive: true, force: true }); }
});

test('the manual adapter picks the profile whose reviewed files are on disk, whatever the processor name', async () => {
  const helper = await makeTemp('cst-profiles-');
  try {
    const sha = value => createHash('sha256').update(value).digest('hex');
    await fsp.writeFile(path.join(helper, 'compatibility.json'), JSON.stringify([
      { version: '1.0.0', platform: 'darwin-arm64', sourceSha256: sha('arm source'), patchedSourceSha256: sha('arm patched') },
      { version: '1.0.0', platform: 'darwin-x64', sourceSha256: sha('x64 source'), patchedSourceSha256: sha('x64 patched') },
      { version: '2.0.0', platform: 'darwin-arm64', sourceSha256: sha('only arm') },
    ]));
    const script = [
      'import json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'import renderer_adapter',
      'contents = [value.encode() for value in json.loads(sys.argv[5])]',
      'print(renderer_adapter.profile_for(sys.argv[2], sys.argv[3], sys.argv[4] or None, contents)["platform"])',
    ].join('\n');
    const pick = (version, target, ...contents) => spawnSync('python3', ['-B', '-c', script,
      path.join(root, 'scripts'), helper, version, target, JSON.stringify(contents)], { encoding: 'utf8' });
    assert.equal(pick('1.0.0', '', 'arm patched').stdout.trim(), 'darwin-arm64');
    assert.equal(pick('1.0.0', '', 'x64 source').stdout.trim(), 'darwin-x64');
    assert.equal(pick('1.0.0', 'darwin-arm64', 'x64 source').stdout.trim(), 'darwin-arm64', 'An explicit --platform wins');
    const unknown = pick('2.0.0', '', 'unrelated bytes');
    if (`${process.platform}-${process.arch}` === 'darwin-arm64') assert.equal(unknown.stdout.trim(), 'darwin-arm64');
    else {
      assert.notEqual(unknown.status, 0);
      assert.match(unknown.stderr, /--platform darwin-arm64/);
    }
  } finally { await fsp.rm(helper, { recursive: true, force: true }); }
});

test('the Marketplace answer is decoded whatever the letter case of its gzip encoding', () => {
  const script = [
    'import gzip, importlib.util, io, sys',
    "spec = importlib.util.spec_from_file_location('update_package', sys.argv[1])",
    'module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
    'class Response(io.BytesIO):',
    '    def __init__(self, data, encoding):',
    "        super().__init__(data); self.headers = {'Content-Encoding': encoding}",
    "for encoding in ['gzip', 'GZIP', 'x-gzip']:",
    "    assert module.read_metadata(Response(gzip.compress(b'{}'), encoding)) == b'{}', encoding",
    "print('decoded')",
  ].join('\n');
  const output = execFileSync('python3', ['-B', '-c', script, path.join(root, 'scripts/update_package.py')], { encoding: 'utf8' });
  assert.match(output, /decoded/);
});

test('packaging refuses an unknown target before writing anything', () => {
  const result = spawnSync('python3', ['-B', path.join(root, 'scripts/package.py'), 'linux-x64'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /darwin-arm64 or darwin-x64/);
});
