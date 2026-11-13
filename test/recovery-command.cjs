'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const core = require('../update-core');

async function main() {
  const [binary, receiptFile] = process.argv.slice(2);
  assert.ok(binary && path.isAbsolute(binary) && receiptFile && path.isAbsolute(receiptFile));
  const helper = path.resolve(__dirname, '..');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cst-recovery-'));
  const extensions = path.join(root, 'e'), userData = path.join(root, 'u'), storage = path.join(root, 'storage');
  await fs.mkdir(extensions); await fs.mkdir(userData); await fs.mkdir(path.join(storage, 'updates'), { recursive: true });
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  await fs.copyFile(receiptFile, path.join(storage, 'updates/recovery.json'));
  await fs.link(path.join(path.dirname(receiptFile), receipt.sha256 + '.vsix'), path.join(storage, 'updates', receipt.sha256 + '.vsix'));
  const appRoot = path.resolve(path.dirname(binary), '../Resources/app');
  const commands = new Map(), saved = new Map([['codexExtensionsRoot', extensions]]);
  const disposable = () => ({ dispose() {} });
  const report = { success: false, finished: false, modelTurnsSent: 0, phase: 'activation' };
  const save = () => fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(root);
  let api, context;
  const localModule = { exports: {} };
  const nativeRequire = createRequire(path.join(helper, 'update-ui.js'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].includes(key)));
  const vscode = {
    StatusBarAlignment: { Right: 2 }, ExtensionMode: { Test: 3, Production: 1 }, ProgressLocation: { Notification: 15 },
    env: { appRoot }, Uri: { file: fsPath => ({ fsPath }) },
    window: {
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      showWarningMessage: async (_message, ...items) => items.filter(item => typeof item === 'string').at(-1),
      showInformationMessage: async () => {},
      showErrorMessage: async message => { report.error = message; },
      withProgress: async (_options, action) => action({}, { onCancellationRequested: disposable }),
    },
    extensions: {
      onDidChange: disposable,
      getExtension: () => {
        try {
          const entries = JSON.parse(sync.readFileSync(path.join(extensions, 'extensions.json'), 'utf8'));
          const entry = entries.find(item => item.identifier.id === 'openai.chatgpt');
          return entry && { extensionPath: path.join(extensions, entry.relativeLocation) };
        } catch { return undefined; }
      },
    },
    commands: {
      registerCommand: (name, fn) => { commands.set(name, fn); return disposable(); },
      executeCommand: async (name, uri) => {
        assert.equal(name, 'workbench.extensions.installExtension');
        report.phase = 'cli-install'; await save();
        await localModule.exports.runChild(binary, [path.join(appRoot, 'out/cli.js'),
          '--user-data-dir=' + userData, '--extensions-dir=' + extensions, '--install-extension', uri.fsPath, '--force'],
        { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 600000 });
      },
    },
  };
  vm.runInNewContext(await fs.readFile(path.join(helper, 'update-ui.js'), 'utf8'), {
    module: localModule, process, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name === 'vscode' ? vscode : nativeRequire(name),
  });
  context = { extensionPath: helper, extensionMode: vscode.ExtensionMode.Test, subscriptions: [],
    globalStorageUri: { fsPath: storage },
    globalState: { get: (key, fallback) => saved.get(key) ?? fallback, update: async (key, value) => { saved.set(key, value); } },
  };
  try {
    api = localModule.exports.activateUpdates(context, { appendLine() {} }, () => false);
    await api.check();
    assert.equal((await api.manager.recovery({ allowRevalidation: true })).needsRevalidation, true);
    const probe = api.manager.probe;
    api.manager.probe = async (...args) => {
      report.phase = 'gui'; await save();
      const evidence = await probe(...args);
      report.gui = evidence; await save();
      return evidence;
    };
    report.phase = 'restore-command'; await save();
    const result = await commands.get('codexSessionTabs.restoreCodex')();
    assert.equal(result.status, 'restored', JSON.stringify(result));
    assert.equal(report.gui.success, true);
    const vendor = vscode.extensions.getExtension().extensionPath;
    report.health = await core.inspectInstalled(vendor, api.manager.profiles, helper);
    assert.equal(report.health.status, 'ready');
    const restarted = new core.UpdateManager({ storage: api.manager.storage, helper,
      profiles: [...require('../compatibility.json')], verifyCandidate: api.manager.verifyCandidate });
    await restarted.loadProfiles();
    assert.equal((await restarted.recovery()).needsRevalidation, false);
    report.recoveryAcceptedAfterManagerRestart = true;
    report.helper = await core.helperHash(helper);
    report.version = result.version;
    report.phase = 'complete'; report.success = true;
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally {
    for (const item of context?.subscriptions || []) item.dispose();
    report.finished = true; await save();
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
