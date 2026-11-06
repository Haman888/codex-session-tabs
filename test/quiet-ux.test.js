'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { setLanguage } = require('../i18n');
const core = require('../update-core');

const root = path.resolve(__dirname, '..');
const disposable = () => ({ dispose() {} });

function updatesHost({ answer } = {}) {
  setLanguage('en');
  const seen = { info: [], warnings: [], errors: [], progress: 0, runs: [], restores: 0 };
  const commands = new Map();
  const vscode = {
    StatusBarAlignment: { Right: 2 }, ProgressLocation: { Notification: 15 },
    ExtensionMode: { Production: 1, Test: 3 },
    env: { appRoot: '/synthetic/app', remoteName: undefined },
    window: {
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      showInformationMessage: async (...args) => { seen.info.push(args); },
      showWarningMessage: async (message, ...rest) => {
        seen.warnings.push({ message, rest });
        const items = rest.filter(item => typeof item === 'string');
        return answer === 'accept' ? items[0] : undefined;
      },
      showErrorMessage: async (...args) => { seen.errors.push(args); },
      withProgress: async () => { seen.progress++; return { status: 'progress' }; },
    },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return disposable(); } },
    extensions: {
      getExtension: () => ({ extensionPath: '/synthetic/extensions/openai.chatgpt-26.1007.21434' }),
      onDidChange: disposable,
    },
  };
  const stub = {
    ...core,
    hostPlatform: () => 'darwin-x64',
    profileFor: (profiles, version) => core.profileFor(profiles, version, 'darwin-x64'),
    supportedProfile: profiles => core.supportedProfile(profiles, 'darwin-x64'),
    inspectInstalled: async () => ({ status: 'ready', version: '26.1007.21434', message: 'ready' }),
    UpdateManager: class {
      async recovery() { return undefined; }
      async run(version) { seen.runs.push(version); return { status: 'verified', version }; }
      async restore() { seen.restores++; return { status: 'cancelled' }; }
    },
  };
  const file = path.join(root, 'update-ui.js');
  const nativeRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, Buffer, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    process: { platform: 'darwin', arch: 'x64', env: {} },
    require: name => name === 'vscode' ? vscode : name === './update-core' ? stub : nativeRequire(name),
  });
  const saved = new Map();
  const context = {
    extensionPath: root, extensionMode: vscode.ExtensionMode.Production, subscriptions: [],
    globalStorageUri: { fsPath: '/synthetic/storage' },
    globalState: { get: (key, fallback) => saved.has(key) ? saved.get(key) : fallback, update: async (key, value) => { saved.set(key, value); } },
  };
  const output = { lines: [], appendLine(line) { this.lines.push(line); } };
  const api = module.exports.activateUpdates(context, output, () => false);
  return { api, seen, commands, output };
}

function extensionHost({ codex = true } = {}) {
  setLanguage('en');
  const errors = [], lines = [], commands = new Map();
  class EventEmitter {
    constructor() { this.listeners = new Set(); }
    event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; };
    fire(value) { for (const fn of [...this.listeners]) fn(value); }
    dispose() { this.listeners.clear(); }
  }
  class TabInputCustom { constructor(uri) { this.uri = uri; this.viewType = 'chatgpt.conversationEditor'; } }
  const group = { tabs: [], activeTab: undefined, viewColumn: 1 };
  const vscode = {
    EventEmitter, TabInputCustom,
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    ExtensionMode: { Production: 1, Test: 3 }, ViewColumn: { Active: -1 },
    Uri: { from: parts => ({ ...parts, toString: () => `${parts.scheme}://${parts.authority}${parts.path}${parts.query ? `?${parts.query}` : ''}` }) },
    env: { language: 'en' },
    extensions: {
      getExtension: () => codex ? { isActive: true, packageJSON: { version: '26.1007.21434',
        contributes: { customEditors: [{ viewType: 'chatgpt.conversationEditor' }] } } } : undefined,
    },
    workspace: {
      workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      onDidChangeWorkspaceFolders: disposable,
    },
    window: {
      state: { focused: true }, onDidChangeWindowState: disposable,
      tabGroups: { all: [group], activeTabGroup: group, onDidChangeTabs: disposable, onDidChangeTabGroups: disposable },
      createOutputChannel: () => ({ appendLine: line => lines.push(line), dispose() {} }),
      registerUriHandler: disposable,
      createTreeView: () => ({ visible: false, onDidChangeVisibility: disposable, dispose() {} }),
      showErrorMessage: async (...args) => { errors.push(args); },
      showInformationMessage: async () => {},
    },
    commands: {
      registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() { commands.delete(name); } }; },
      executeCommand: async (name, ...args) => commands.get(name)?.(...args),
    },
  };
  const saved = new Map();
  const context = { subscriptions: [], extensionMode: vscode.ExtensionMode.Test, globalState: {
    get: (key, fallback) => saved.has(key) ? saved.get(key) : fallback,
    update: async (key, value) => { saved.set(key, value); },
  } };
  const module = { exports: {} };
  const localRequire = name => {
    if (name === 'vscode') return vscode;
    if (name === 'node:fs') return { watch: () => ({ close() {} }) };
    if (name === './sessions') return { codexHome: () => '/synthetic', listSessions: async () => [], getSessionStatus: () => ({}), resetSessions() {} };
    if (name === './badges') return { prepareBadges: async () => ({}) };
    if (name === './update-ui') return { activateUpdates: () => ({ check: async () => ({ status: 'ready' }) }) };
    if (name === './ui-language') return { activateLanguage: () => ({ ready: Promise.resolve() }) };
    return name.startsWith('./') ? require(path.join(root, name)) : require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension.js'), 'utf8'), {
    module, require: localRequire, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  });
  const api = module.exports.activate(context);
  return { api, commands, errors, lines,
    dispose: () => { for (const subscription of [...context.subscriptions].reverse()) subscription.dispose?.(); } };
}

test('a ready adapter starts quietly: no setup reminder and nothing is downloaded', async () => {
  const f = updatesHost();
  const state = await f.api.check();
  assert.equal(state.status, 'ready');
  assert.deepEqual(f.seen.info, [], 'No “Set up protection” reminder on start');
  assert.deepEqual(f.seen.warnings, []);
  assert.deepEqual(f.seen.runs, []);
  assert.equal(f.seen.progress, 0);
});

test('the protection check asks first and does nothing when the dialog is closed', async () => {
  const declined = updatesHost();
  assert.equal((await declined.commands.get('codexSessionTabs.checkUpdate')()).status, 'cancelled');
  assert.equal(declined.seen.warnings.length, 1);
  const [{ message, rest }] = declined.seen.warnings;
  assert.match(message, /26\.1007\.21434/);
  assert.match(message, /400 MB/);
  assert.equal(rest[0].modal, true);
  assert.equal(declined.seen.progress, 0);
  assert.deepEqual(declined.seen.runs, []);

  const accepted = updatesHost({ answer: 'accept' });
  await accepted.commands.get('codexSessionTabs.checkUpdate')();
  assert.equal(accepted.seen.progress, 1, 'Only a confirmed check starts');
  await accepted.commands.get('codexSessionTabs.restoreCodex')();
  assert.equal(accepted.seen.warnings.length, 1, 'Restoring a saved package needs no download confirmation');
  assert.equal(accepted.seen.progress, 2);
});

test('closing a new tab before it loads is not reported as an error', async () => {
  const f = extensionHost();
  try {
    assert.equal(await f.commands.get('codexSessionTabs.new')(), undefined);
    assert.deepEqual({ ...(await f.commands.get('codexSessionTabs.nativeNewPanel')()) }, { handled: true, opened: false });
    assert.deepEqual(f.errors, []);
    assert.equal(f.lines.filter(line => /tab was closed/.test(line)).length, 2, 'The cancellation stays in the output channel');
  } finally { f.dispose(); }
});

test('other new-tab failures still show an error', async () => {
  const f = extensionHost({ codex: false });
  try {
    await f.commands.get('codexSessionTabs.new')();
    assert.equal(f.errors.length, 1);
  } finally { f.dispose(); }
});

test('a new chat waits as long as the profile lets Codex start, never less than 45 s', () => {
  assert.equal(core.newChatWaitMs(undefined), 45000);
  assert.equal(core.newChatWaitMs({}), 45000);
  assert.equal(core.newChatWaitMs({ startupTimeoutMs: 30000 }), 45000);
  const intel = core.profileFor(require('../compatibility.json'), '26.1007.21434', 'darwin-x64');
  assert.equal(core.newChatWaitMs(intel), 105000);
});
