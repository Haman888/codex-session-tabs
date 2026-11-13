'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ID = '00000000-0000-0000-0000-000000000001';

test('restored hidden panels initialize once on reveal and their startup watchdog runs only while visible', async () => {
  let binding, disposed = [], changes = [], windowChanges = [];
  const module = { exports: {} };
  const vscode = { window: { state: { focused: true }, onDidChangeWindowState(fn) {
    windowChanges.push(fn); return { dispose() { windowChanges = windowChanges.filter(item => item !== fn); } };
  } }, commands: { executeCommand: async (command, value) => {
    if (command === 'codexSessionTabs.nativePanel') binding = value;
  } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../native-bridge.cjs'), 'utf8'), {
    module, require: name => name === 'vscode' ? vscode : require(name), setTimeout, clearTimeout,
  });
  const bridge = module.exports;
  const panel = { webview: {}, visible: false,
    onDidDispose(fn) { disposed.push(fn); return { dispose() {} }; },
    onDidChangeViewState(fn) { changes.push(fn); return { dispose() { changes = changes.filter(item => item !== fn); } }; },
  };
  const owner = { subscriptions: [], editorPanels: new Map([[panel, { ready: true }]]),
    codexMcpConnection: { registerProvider() { return { dispose() {} }; } } };
  await bridge.attach(owner, panel, { toString: () => 'restored-draft' });
  let initialized = 0;
  await bridge.initializePanel(owner, panel, async () => { initialized++; });
  assert.equal(initialized, 0);
  panel.visible = true; for (const fn of [...changes]) fn();
  await Promise.resolve();
  assert.equal(initialized, 1);
  for (const fn of [...changes]) fn(); await Promise.resolve();
  assert.equal(initialized, 1);
  assert.equal(binding.isReady(), false, 'A transport-ready message is not a mounted renderer');
  let starts = 0, timeoutFired = false;
  const watchdog = { disposed: false, timeout: undefined,
    start() { if (!this.disposed && this.timeout == null) { starts++; this.timeout = setTimeout(() => { timeoutFired = true; }, 40); } },
    dispose() { this.disposed = true; clearTimeout(this.timeout); this.timeout = undefined; },
  };
  bridge.watchPanelStartup(panel.webview, watchdog);
  assert.equal(starts, 1);
  panel.visible = false; for (const fn of [...changes]) fn();
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(timeoutFired, false);
  panel.visible = true; for (const fn of [...changes]) fn();
  assert.equal(starts, 2);
  vscode.window.state.focused = false; for (const fn of [...windowChanges]) fn();
  assert.equal(watchdog.timeout, undefined);
  assert.equal(binding.isVisible(), false);
  vscode.window.state.focused = true; for (const fn of [...windowChanges]) fn();
  assert.equal(starts, 3);
  assert.equal(binding.isVisible(), true);
  bridge.startupPhase(owner, panel.webview, 'renderer_ready');
  watchdog.dispose();
  assert.equal(binding.isReady(), true);
  for (const fn of disposed) fn();
  assert.equal(binding.isReady(), false);
  assert.equal(changes.length, 0);
  assert.equal(windowChanges.length, 0);
});

test('native new-chat actions create fresh resources while saved-chat resources remain stable', () => {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../native-bridge.cjs'), 'utf8');
  vm.runInNewContext(source, { module, exports: module.exports,
    require: name => name === 'vscode' ? {} : require(name), setTimeout, clearTimeout });
  const uri = { path: '/extension/panel/new', with: value => ({ ...value }) };
  const first = module.exports.freshPanelUri(uri), second = module.exports.freshPanelUri(uri);
  assert.notEqual(first.query, second.query);
  assert.match(first.query, /^sessionTab=/);
  const saved = { path: `/local/${ID}` };
  assert.equal(module.exports.freshPanelUri(saved), saved);
});

test('native creation uses the companion queue, preserves old tabs on failure, and falls back after uninstall', async () => {
  const module = { exports: {} };
  let response = { handled: true, opened: true }, disposed = 0, fail = false;
  const vscode = { window: {}, commands: { executeCommand: async command => {
    assert.equal(command, 'codexSessionTabs.nativeNewPanel');
    if (fail) throw new Error('command removed');
    return response;
  } } };
  const source = fs.readFileSync(path.join(__dirname, '../native-bridge.cjs'), 'utf8');
  vm.runInNewContext(source, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name), setTimeout, clearTimeout });
  const previous = { dispose() { disposed++; } };
  const owner = { findPanelByWebview: () => previous, isPanelAlive: () => true };
  assert.equal(await module.exports.openFreshPanel(owner, {}, true), true);
  assert.equal(disposed, 1);
  response = { handled: true, opened: false };
  assert.equal(await module.exports.openFreshPanel(owner, {}, true), true);
  assert.equal(disposed, 1, 'A failed new UI must not close the old conversation');
  fail = true;
  assert.equal(await module.exports.openFreshPanel(owner, {}, true), false);
});

test('native bridge restores exact identity, ignores prefetch, forwards first turn and completion, renames through Codex API', async () => {
  const calls = [];
  let listener;
  let sent;
  const vscode = { window: {}, commands: { executeCommand: async (command, data) => {
    calls.push({ command, data });
    if (command === 'codexSessionTabs.nativePanel') return { id: ID };
  } } };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../native-bridge.cjs'), 'utf8');
  vm.runInNewContext(source, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name), setTimeout, clearTimeout });
  const bridge = module.exports;
  const webview = {};
  const panel = { webview, title: 'Codex', iconPath: 'normal', onDidDispose() {} };
  const state = { initialRoute: '/extension/panel/new' };
  const owner = { subscriptions: [], editorPanels: new Map([[panel, state]]), codexMcpConnection: {
    registerProvider(_name, value) { listener = value; return { dispose() {} }; },
    sendRequest(provider, id, method, params) { sent = { provider, id, method, params }; listener.onResult({ id, result: {} }); },
  } };
  await bridge.attach(owner, panel, { toString: () => 'new?1' });
  assert.equal(state.initialRoute, `/local/${ID}`);
  const binding = calls.find(call => call.command === 'codexSessionTabs.nativePanel').data;
  assert.equal(binding.isReady(), false);
  state.ready = true;
  assert.equal(binding.isReady(), false);
  bridge.startupPhase(owner, panel.webview, 'renderer_ready');
  assert.equal(binding.isReady(), true);
  binding.setTitle('План');
  assert.equal(panel.title, 'План');
  binding.setUnread(true, 'orange');
  assert.equal(panel.iconPath, 'orange');
  binding.setUnread(false);
  assert.equal(panel.iconPath, 'normal');
  bridge.observe(owner, webview, { type: 'mcp-request', request: { method: 'thread/read', params: { threadId: '00000000-0000-0000-0000-000000000002' } } });
  assert.equal(calls.filter(call => call.command === 'codexSessionTabs.nativeBind').length, 0);
  bridge.observe(owner, webview, { type: 'mcp-request', request: { method: 'turn/start', params: { threadId: '00000000-0000-0000-0000-000000000002', input: 'Private content must not be forwarded' } } });
  const bind = calls.find(call => call.command === 'codexSessionTabs.nativeBind');
  assert.equal(bind.data.id, '00000000-0000-0000-0000-000000000002');
  assert.deepEqual(Object.keys(bind.data).sort(), ['id', 'key']);
  listener.onNotification({ method: 'turn/completed', params: { threadId: ID, turn: { id: 't1' } } });
  const completion = calls.find(call => call.command === 'codexSessionTabs.nativeActivity');
  assert.equal(completion.data.phase, 'completed');
  assert.equal(completion.data.turnId, 't1');
  await binding.rename(ID, 'Ручное название');
  assert.equal(sent.method, 'thread/name/set');
  assert.equal(sent.params.threadId, ID);
  assert.equal(sent.params.name, 'Ручное название');
  listener.onNotification({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 25 } } } });
  assert.equal(calls.find(call => call.command === 'codexSessionTabs.nativeRateLimits').data.buckets[0].primary.usedPercent, 25);
  owner.codexMcpConnection.sendRequest = (_provider, id, method, params) => {
    assert.equal(method, 'account/rateLimits/read');
    assert.equal(Object.keys(params).length, 0);
    listener.onResult({ id, result: { accountId: 'private-account', rateLimits: { primary: { usedPercent: 30 } } } });
  };
  const rates = await binding.readRateLimits();
  assert.equal(rates.buckets[0].primary.usedPercent, 30);
  assert.doesNotMatch(JSON.stringify(rates), /private-account|accountId/);
  listener.onNotification({ method: 'account/updated', params: { accountId: 'private-account' } });
  assert.equal(calls.filter(call => call.command === 'codexSessionTabs.nativeUsageReset').length, 1);
  owner.codexMcpConnection.sendRequest = (_provider, id) => listener.onResult({ id, error: {} });
  const { setLanguage, errorText } = require('../i18n');
  await assert.rejects(binding.rename(ID, 'Manual name'), error => {
    setLanguage('ru');
    assert.equal(errorText(error), 'Codex не сохранил название.');
    setLanguage('en');
    assert.equal(errorText(error), 'Codex did not save the name.');
    return true;
  });
});
