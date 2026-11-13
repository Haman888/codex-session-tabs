'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');
const { makeTemp } = require('./temp');
const { hostPlatform, profileFor, supportedProfile } = require('../update-core');

const root = path.resolve(__dirname, '..');
// Same structure as the official 26.1007 build: other minified names for the route helper and the startup phase.
const source = `class Native {
async resolve(){i!=null&&this.registerOnDidDisposeForWebviewPanel(r,i),await this.initializeWebview(r.webview,"panel",r.onDidDispose,()=>{this.onPanelReady(r)})}
async handleMessage(e,r){switch(r.type){case"ready":break;case"navigate-in-new-editor-tab":{let n=rF(r.path);await je.commands.executeCommand("vscode.open",n);break}}}
async createNewPanel(){let e=rF("/extension/panel/new"),r=je.window.activeTextEditor?.viewColumn??je.ViewColumn.Active;await je.commands.executeCommand("vscode.openWith",e,t.customEditorViewType,{viewColumn:r,preserveFocus:!1,preview:!1})}
startup(){return {startup:{reach:a=>o.handleStartupPhase(a)}}}
async initializeWebview(e){e.html=await this.getWebviewContent(e),s.start()}
watch(){this.timeout=setTimeout(()=>{this.timeout=void 0,this.onTimeout({elapsedMs:0,receivedWebviewMessage:!1,timeoutMs:3e4})},3e4)}
}; module.exports = Native;`;

async function fixture(t, profile, content = source, version = '26.1007.21434') {
  const folder = await makeTemp('intel-port-unit-');
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await fs.mkdir(path.join(folder, 'out'));
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ publisher: 'OpenAI', name: 'chatgpt', version }));
  await fs.writeFile(path.join(folder, 'out/extension.js'), content);
  const helper = path.join(folder, 'helper');
  for (const name of ['scripts/native_adapter.py', 'scripts/renderer_adapter.py', 'native-bridge.cjs']) {
    const target = path.join(helper, name); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, name), target);
  }
  await fs.writeFile(path.join(helper, 'compatibility.json'), JSON.stringify([
    { version, platform: 'darwin-x64', startupTimeoutMs: 90000, ...profile },
  ]));
  return folder;
}

const adapter = (folder, ...args) => spawnSync('python3', ['-B', path.join(folder, 'helper/scripts/native_adapter.py'),
  '--platform', 'darwin-x64', '--extension-dir', folder, ...args], { encoding: 'utf8' });
const run = (folder, ...args) => {
  const result = adapter(folder, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test('the November editor layout preserves its shared HTML loader and app-server-state message', async t => {
  const modern = source
    .replaceAll('rF(', 'yL(')
    .replace('case"ready":break;', 'case"ready":case"request-app-server-state":break;')
    .replace('this.getWebviewContent(e)', 'R2(this.extensionUri,e,this.webviewMetaTags(e))');
  const folder = await fixture(t, { nativeLayout: 'shared-content-v1' }, modern, '26.1111.21308');
  run(folder);
  const installed = await fs.readFile(path.join(folder, 'out/extension.js'), 'utf8');
  execFileSync(process.execPath, ['--check', path.join(folder, 'out/extension.js')]);
  const module = { exports: {} }, calls = [], watchdog = {}, webview = {};
  vm.runInNewContext(installed, {
    module, s: watchdog,
    R2: async (uri, view, tags) => { calls.push({ uri, view, tags }); return '<html>native</html>'; },
    require: () => ({
      watchPanelStartup: (view, timer) => { calls.push({ view, timer }); },
      observe: (_owner, view, message) => { calls.push({ view, message }); },
    }),
  });
  const native = new module.exports();
  native.extensionUri = 'native-extension';
  native.webviewMetaTags = () => 'native-tags';
  await native.initializeWebview(webview);
  assert.equal(webview.html, '<html>native</html>');
  assert.deepEqual(calls[0], { uri: 'native-extension', view: webview, tags: 'native-tags' });
  assert.deepEqual(calls[1], { view: webview, timer: watchdog });
  const message = { type: 'request-app-server-state' };
  await native.handleMessage(webview, message);
  assert.deepEqual(calls[2], { view: webview, message });
  assert.equal(JSON.parse(run(folder, '--check')).upToDate, true);
  run(folder, '--restore');
  assert.equal(await fs.readFile(path.join(folder, 'out/extension.js'), 'utf8'), modern);
  const wrong = await fixture(t, {}, modern);
  assert.notEqual(adapter(wrong).status, 0, 'The new structure needs its own reviewed layout');
  assert.equal(await fs.readFile(path.join(wrong, 'out/extension.js'), 'utf8'), modern);
  const unknown = await fixture(t, { nativeLayout: 'unknown' });
  assert.notEqual(adapter(unknown).status, 0, 'Unknown layouts fail closed');
});

test('the Intel 26.1007 profile hooks other minified names, raises the watchdog and needs no renderer change', async t => {
  const folder = await fixture(t);
  assert.equal(JSON.parse(run(folder, '--check')).upToDate, false);
  run(folder);
  const installed = await fs.readFile(path.join(folder, 'out/extension.js'), 'utf8');
  const state = JSON.parse(run(folder, '--check'));
  assert.equal(state.upToDate, true);
  assert.equal(state.rendererFixInstalled, false);
  assert.equal(installed.split('.freshPanelUri(rF(').length - 1, 2);
  assert.equal(installed.split('.startupPhase(this,e,a)').length - 1, 1);
  assert.equal(installed.split('timeoutMs:90000})},90000)}').length - 1, 1);
  assert.equal(installed.includes('3e4'), false);
  execFileSync(process.execPath, ['--check', path.join(folder, 'out/extension.js')]);
  const backup = JSON.parse(await fs.readFile(path.join(folder, 'out/session-tabs-backup.json'), 'utf8'));
  assert.equal(backup.renderer, null);
  run(folder);
  assert.equal(await fs.readFile(path.join(folder, 'out/extension.js'), 'utf8'), installed, 'Reinstalling is idempotent');
  run(folder, '--restore');
  assert.equal(await fs.readFile(path.join(folder, 'out/extension.js'), 'utf8'), source);
  assert.deepEqual(await fs.readdir(path.join(folder, 'out')), ['extension.js']);
});

test('a profile without the processor of this package or with an unsafe timeout changes nothing', async t => {
  for (const profile of [{ platform: 'darwin-arm64' }, { startupTimeoutMs: 5000 }, { startupTimeoutMs: 600000 }, { startupTimeoutMs: '90000' }]) {
    const folder = await fixture(t, profile);
    const result = adapter(folder);
    assert.notEqual(result.status, 0, JSON.stringify(profile));
    assert.equal(await fs.readFile(path.join(folder, 'out/extension.js'), 'utf8'), source);
    assert.deepEqual(await fs.readdir(path.join(folder, 'out')), ['extension.js']);
  }
});

test('hooks that disagree on the route helper are refused instead of patching half of them', async t => {
  const mixed = source.replace('let n=rF(r.path);', 'let n=F1(r.path);');
  const folder = await fixture(t, {}, mixed);
  assert.notEqual(adapter(folder).status, 0);
  assert.equal(await fs.readFile(path.join(folder, 'out/extension.js'), 'utf8'), mixed);
  const noWatchdog = source.replace('timeoutMs:3e4})},3e4)}', 'timeoutMs:4e4})},4e4)}');
  const other = await fixture(t, {}, noWatchdog);
  assert.notEqual(adapter(other).status, 0, 'A requested timeout needs the exact reviewed watchdog');
  assert.equal(await fs.readFile(path.join(other, 'out/extension.js'), 'utf8'), noWatchdog);
});

test('profiles are chosen by processor, and Python and Node name this Mac the same way', () => {
  const profiles = [{ version: '26.1021.22027', platform: 'darwin-arm64' }, { version: '26.1007.21434', platform: 'darwin-x64' }];
  assert.equal(profileFor(profiles, '26.1021.22027', 'darwin-x64'), undefined);
  assert.equal(profileFor(profiles, '26.1007.21434', 'darwin-x64').platform, 'darwin-x64');
  assert.equal(supportedProfile(profiles, 'darwin-x64').version, '26.1007.21434');
  assert.equal(supportedProfile(profiles, 'darwin-arm64').version, '26.1021.22027');
  assert.equal(supportedProfile(profiles, 'linux-x64'), undefined);
  const python = execFileSync('python3', ['-B', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import renderer_adapter; print(renderer_adapter.host_platform())',
    path.join(root, 'scripts')], { encoding: 'utf8' }).trim();
  assert.equal(python, hostPlatform());
});

test('shipped profiles name an official package for their own version and processor', async () => {
  const profiles = JSON.parse(await fs.readFile(path.join(root, 'compatibility.json'), 'utf8'));
  const seen = new Set();
  for (const profile of profiles) {
    const key = `${profile.version}|${profile.platform}`;
    assert.ok(!seen.has(key), key); seen.add(key);
    assert.match(profile.platform, /^darwin-(arm64|x64)$/);
    const url = new URL(profile.url);
    assert.equal(url.hostname, 'marketplace.visualstudio.com');
    assert.equal(url.pathname, `/_apis/public/gallery/publishers/OpenAI/vsextensions/chatgpt/${profile.version}/vspackage`);
    assert.equal(url.searchParams.get('targetPlatform'), profile.platform);
    for (const field of ['vsixSha256', 'sourceSha256', 'patchedSourceSha256']) assert.match(profile[field], /^[a-f0-9]{64}$/, field);
    if (profile.startupTimeoutMs !== undefined) {
      assert.ok(Number.isInteger(profile.startupTimeoutMs) && profile.startupTimeoutMs >= 30000 && profile.startupTimeoutMs <= 300000);
    }
  }
});
