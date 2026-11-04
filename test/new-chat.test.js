'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const vm = require('node:vm');

const { makeTemp } = require('./temp');
const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/native_adapter.py');
const digest = value => createHash('sha256').update(value).digest('hex');
const source = `class Native {
async resolve(){i!=null&&this.registerOnDidDisposeForWebviewPanel(r,i),await this.initializeWebview(r.webview,"panel",r.onDidDispose,()=>{this.onPanelReady(r)})}
async handleMessage(e,r){switch(r.type){case"ready":break;case"navigate-in-new-editor-tab":{let n=F1(r.path);await Be.commands.executeCommand("vscode.open",n);break}}}
async createNewPanel(){let e=F1("/extension/panel/new"),r=Be.window.activeTextEditor?.viewColumn??Be.ViewColumn.Active;await Be.commands.executeCommand("vscode.openWith",e,t.customEditorViewType,{viewColumn:r,preserveFocus:!1,preview:!1})}
startup(){return {startup:{reach:c=>o.handleStartupPhase(c)}}}
async initializeWebview(e){e.html=await this.getWebviewContent(e),s.start()}
}; module.exports = Native;`;
const rendererPath = 'webview/assets/app-initial-13f932cb2f13.js';
const rendererOriginal = 'function preload(t){let r=t.endsWith(`.css`);let e=document.getElementsByTagName(`link`),i=document.querySelector(`meta[property=csp-nonce]`);for(let n=e.length-1;n>=0;n--){let i=e[n];if(i.href===t&&(!r||i.rel===`stylesheet`))return}i={};if(document.head.appendChild(i),r)return new Promise(()=>{});}';
const rendererPatched = rendererOriginal
  .replace('let r=t.endsWith(`.css`);', 'let r=t.endsWith(`.css`);if(!r)return;')
  .replace('let e=document.getElementsByTagName(`link`),i=document.querySelector(`meta[property=csp-nonce]`)', 'let e=new Map;for(let t of document.getElementsByTagName(`link`))e.set(t.href,(e.get(t.href)||0)|(t.rel===`stylesheet`?3:1));let i=document.querySelector(`meta[property=csp-nonce]`)')
  .replace('for(let n=e.length-1;n>=0;n--){let i=e[n];if(i.href===t&&(!r||i.rel===`stylesheet`))return}', 'if((e.get(t)||0)&(r?2:1))return;')
  .replace('document.head.appendChild(i),r)return new Promise', 'document.head.appendChild(i),e.set(t,(e.get(t)||0)|(r?3:1)),r)return new Promise');

async function fixture(t, content = source) {
  const folder = await makeTemp('new-chat-unit-');
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await fs.mkdir(path.join(folder, 'out'));
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ publisher: 'OpenAI', name: 'chatgpt', version: '26.1021.22027' }));
  await fs.writeFile(path.join(folder, 'out/extension.js'), content);
  const helper = path.join(folder, 'helper');
  for (const name of ['scripts/native_adapter.py', 'scripts/renderer_adapter.py', 'native-bridge.cjs']) {
    const target = path.join(helper, name); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, name), target);
  }
  await fs.writeFile(path.join(helper, 'compatibility.json'), JSON.stringify([{
    version: '26.1021.22027', platform: 'darwin-arm64',
    legacyBridgeSha256s: [digest(Buffer.from('// old revision'))],
    renderer: { path: rendererPath, originalSha256: digest(Buffer.from(rendererOriginal)), patchedSha256: digest(Buffer.from(rendererPatched)) },
  }]));
  await fs.mkdir(path.dirname(path.join(folder, rendererPath)), { recursive: true });
  await fs.writeFile(path.join(folder, rendererPath), rendererOriginal);
  return folder;
}

const run = (folder, ...args) => execFileSync('python3', ['-B', path.join(folder, 'helper/scripts/native_adapter.py'), '--extension-dir', folder, ...args], { encoding: 'utf8' });
const refuse = (folder, ...args) => spawnSync('python3', ['-B', path.join(folder, 'helper/scripts/native_adapter.py'), '--extension-dir', folder, ...args], { encoding: 'utf8' });

test('conflicting check and restore flags fail before changing originals or installed backups', async t => {
  for (const installed of [false, true]) {
    const folder = await fixture(t);
    if (installed) run(folder);
    const snapshot = async () => {
      const files = await fs.readdir(folder, { recursive: true });
      const result = {};
      for (const name of files.sort()) {
        const file = path.join(folder, name);
        if ((await fs.stat(file)).isFile()) result[name] = digest(await fs.readFile(file));
      }
      return result;
    };
    const before = await snapshot();
    for (const flags of [['--restore', '--check'], ['--check', '--restore']]) {
      const result = refuse(folder, ...flags);
      assert.equal(result.status, 2);
      assert.deepEqual(await snapshot(), before, 'Rejected modes preserve every fixture/backup byte');
    }
  }
});

test('all native hooks install idempotently, check their revision, and restore exact original bytes', async t => {
  const folder = await fixture(t);
  assert.equal(JSON.parse(run(folder, '--check')).upToDate, false);
  run(folder);
  const installed = await fs.readFile(path.join(folder, 'out/extension.js'));
  assert.equal(JSON.parse(run(folder, '--check')).upToDate, true);
  assert.equal(JSON.parse(run(folder, '--check')).rendererFixInstalled, true);
  assert.equal(await fs.readFile(path.join(folder, rendererPath), 'utf8'), rendererPatched);
  run(folder);
  assert.deepEqual(await fs.readFile(path.join(folder, 'out/extension.js')), installed);
  assert.deepEqual(await fs.readFile(path.join(folder, 'out/extension.js.before-session-tabs')), Buffer.from(source));
  assert.equal(installed.toString().split('.freshPanelUri(').length - 1, 2);
  execFileSync(process.execPath, ['--check', path.join(folder, 'out/extension.js')]);
  run(folder, '--restore');
  assert.deepEqual(await fs.readFile(path.join(folder, 'out/extension.js')), Buffer.from(source));
  assert.equal(await fs.readFile(path.join(folder, rendererPath), 'utf8'), rendererOriginal);
  assert.deepEqual(await fs.readdir(path.join(folder, 'out')), ['extension.js']);
});

test('patched native New Chat actions make distinct drafts and leave saved conversation URIs stable', async t => {
  const folder = await fixture(t); run(folder);
  const bridgeModule = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(folder, 'out/session-tabs-native.cjs'), 'utf8'), {
    module: bridgeModule, exports: bridgeModule.exports,
    require: name => name === 'vscode' ? {} : require(name), setTimeout, clearTimeout,
  });
  const bridge = bridgeModule.exports;
  const uri = (pathname, query = '') => ({ path: pathname, query,
    with(value) { return uri(pathname, value.query); }, toString() { return `openai-codex://route${pathname}${query ? '?' + query : ''}`; } });
  const opened = [];
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(folder, 'out/extension.js'), 'utf8'), {
    module, F1: uri, Be: { window: {}, ViewColumn: { Active: 1 }, commands: {
      executeCommand: async (_command, resource) => { opened.push(resource); },
    } }, t: { customEditorViewType: 'chatgpt.conversationEditor' },
    require: () => ({ ...bridge, observe() {}, async openFreshPanel() { return false; } }),
  });
  const native = new module.exports();
  await native.createNewPanel(); await native.createNewPanel();
  assert.notEqual(opened[0].toString(), opened[1].toString());
  assert.ok(opened.every(value => value.query.startsWith('sessionTab=')));
  await native.handleMessage({}, { type: 'navigate-in-new-editor-tab', path: '/extension/panel/new' });
  assert.notEqual(opened[2].toString(), opened[0].toString());
  const saved = '/local/00000000-0000-0000-0000-000000000001';
  await native.handleMessage({}, { type: 'navigate-in-new-editor-tab', path: saved });
  assert.equal(opened[3].toString(), `openai-codex://route${saved}`);
});

test('native New Chat routes through the helper queue when handled and never redirects saved chats', async t => {
  const folder = await fixture(t); run(folder);
  const calls = [], opened = [];
  const module = { exports: {} };
  const uri = pathname => ({ path: pathname, toString() { return `openai-codex://route${pathname}`; } });
  const bridge = {
    observe() {},
    async openFreshPanel(owner, webview, replaceCurrentEditor) {
      calls.push({ owner, webview, replaceCurrentEditor });
      return true;
    },
    freshPanelUri(value) { return value; },
  };
  vm.runInNewContext(await fs.readFile(path.join(folder, 'out/extension.js'), 'utf8'), {
    module, F1: uri, Be: { window: {}, ViewColumn: { Active: 1 }, commands: {
      executeCommand: async (_command, resource) => opened.push(resource),
    } }, t: { customEditorViewType: 'chatgpt.conversationEditor' }, require: () => bridge,
  });
  const native = new module.exports(), origin = {};
  await native.createNewPanel();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].owner, native);
  assert.equal(opened.length, 0, 'Handled create must not run the native fallback');
  await native.handleMessage(origin, { type: 'navigate-in-new-editor-tab', path: '/extension/panel/new', replaceCurrentEditor: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].webview, origin);
  assert.equal(calls[1].replaceCurrentEditor, true);
  assert.equal(opened.length, 0, 'Handled navigation must not run the native fallback');
  const saved = '/local/00000000-0000-0000-0000-000000000001';
  await native.handleMessage(origin, { type: 'navigate-in-new-editor-tab', path: saved, replaceCurrentEditor: false });
  assert.equal(calls.length, 2, 'Saved conversation navigation bypasses the new-chat queue');
  assert.equal(opened[0].toString(), `openai-codex://route${saved}`);
});

test('legacy two-hook adapter upgrades using its verified original backup', async t => {
  const folder = await fixture(t);
  const original = Buffer.from(source);
  const legacy = Buffer.from(source.replace('async handleMessage(e,r){switch', 'async handleMessage(e,r){require("./session-tabs-native.cjs").observe(this,e,r);switch'));
  await fs.writeFile(path.join(folder, 'out/extension.js'), legacy);
  await fs.writeFile(path.join(folder, 'out/extension.js.before-session-tabs'), original);
  await fs.writeFile(path.join(folder, 'out/session-tabs-backup.json'), JSON.stringify({ version: '26.1021.22027', originalSha256: digest(original), patchedSha256: digest(legacy) }));
  await fs.writeFile(path.join(folder, 'out/session-tabs-native.cjs'), '// old revision');
  assert.equal(JSON.parse(run(folder, '--check')).upToDate, false);
  run(folder);
  assert.equal(JSON.parse(run(folder, '--check')).upToDate, true);
  run(folder, '--restore');
  assert.deepEqual(await fs.readFile(path.join(folder, 'out/extension.js')), original);
});

test('unknown structures, source tampering, and mismatched-version restore cannot overwrite the package', async t => {
  const wrong = await fixture(t, source.replace('async createNewPanel()', 'async changedMethod()'));
  const result = refuse(wrong);
  assert.notEqual(result.status, 0);
  assert.equal(await fs.readFile(path.join(wrong, 'out/extension.js'), 'utf8'), source.replace('async createNewPanel()', 'async changedMethod()'));
  assert.deepEqual(await fs.readdir(path.join(wrong, 'out')), ['extension.js']);
  const folder = await fixture(t); run(folder);
  const patched = await fs.readFile(path.join(folder, 'out/extension.js'));
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ publisher: 'OpenAI', name: 'chatgpt', version: '99.0.0' }));
  assert.notEqual(refuse(folder, '--restore').status, 0);
  assert.deepEqual(await fs.readFile(path.join(folder, 'out/extension.js')), patched);
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ publisher: 'OpenAI', name: 'chatgpt', version: '26.1021.22027' }));
  await fs.appendFile(path.join(folder, 'out/extension.js'), '\n// external change');
  assert.notEqual(refuse(folder, '--restore').status, 0);
  assert.ok((await fs.readFile(path.join(folder, 'out/extension.js'), 'utf8')).endsWith('// external change'));
});

test('renderer tampering or an unrelated backup refuses before native mutations', async t => {
  const folder = await fixture(t);
  await fs.appendFile(path.join(folder, rendererPath), '// external');
  assert.notEqual(refuse(folder).status, 0);
  assert.equal(await fs.readFile(path.join(folder, 'out/extension.js'), 'utf8'), source);
  assert.deepEqual(await fs.readdir(path.join(folder, 'out')), ['extension.js']);
  const other = await fixture(t);
  await fs.writeFile(path.join(other, 'out/session-tabs-renderer-original.js'), 'unrelated');
  assert.notEqual(refuse(other).status, 0);
  assert.equal(await fs.readFile(path.join(other, 'out/extension.js'), 'utf8'), source);
});

test('an unexpected patched checksum refuses before installation and during check', async t => {
  const folder = await fixture(t);
  const policy = path.join(folder, 'helper/compatibility.json');
  const profiles = JSON.parse(await fs.readFile(policy, 'utf8'));
  profiles[0].patchedSourceSha256 = digest(Buffer.from('unapproved patch'));
  await fs.writeFile(policy, JSON.stringify(profiles));
  assert.notEqual(refuse(folder).status, 0);
  assert.notEqual(refuse(folder, '--check').status, 0);
  assert.equal(await fs.readFile(path.join(folder, 'out/extension.js'), 'utf8'), source);
  assert.equal(await fs.readFile(path.join(folder, rendererPath), 'utf8'), rendererOriginal);
  assert.deepEqual(await fs.readdir(path.join(folder, 'out')), ['extension.js']);
});

test('hooks from another adapter layout cannot be overwritten without their verified backup', async t => {
  const existing = source.replace('async handleMessage(e,r){switch',
    'async handleMessage(e,r){require("./previous-session-tabs-native.cjs").observe(this,e,r);switch');
  const folder = await fixture(t, existing);
  await fs.writeFile(path.join(folder, 'out/previous-session-tabs-native.cjs'), 'previous bridge');
  const before = await fs.readdir(path.join(folder, 'out'));
  assert.notEqual(refuse(folder).status, 0);
  assert.notEqual(refuse(folder, '--check').status, 0);
  assert.equal(await fs.readFile(path.join(folder, 'out/extension.js'), 'utf8'), existing);
  assert.equal(await fs.readFile(path.join(folder, rendererPath), 'utf8'), rendererOriginal);
  assert.deepEqual(await fs.readdir(path.join(folder, 'out')), before);
});

test('restore and reapply never clobber externally changed renderer, backup or bridge', async t => {
  for (const target of [rendererPath, 'out/session-tabs-renderer-original.js', 'out/session-tabs-native.cjs']) {
    const folder = await fixture(t); run(folder);
    const nativeBefore = await fs.readFile(path.join(folder, 'out/extension.js'));
    await fs.appendFile(path.join(folder, target), '// external change');
    assert.notEqual(refuse(folder, '--restore').status, 0);
    assert.notEqual(refuse(folder).status, 0);
    assert.deepEqual(await fs.readFile(path.join(folder, 'out/extension.js')), nativeBefore);
    assert.ok((await fs.readFile(path.join(folder, target), 'utf8')).endsWith('// external change'));
  }
});
