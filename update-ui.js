'use strict';

const { t, errorText } = require('./i18n');

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { UpdateManager, inspectInstalled, helperHash, hostPlatform, profileFor, supportedProfile, newChatWaitMs } = require('./update-core');

function runChild(command, args, { env, signal, timeout = 180000, resultReady } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failure = '', finished = false, reported = false, stopping = false, forced, polling;
    const kill = name => { try { process.kill(-child.pid, name); } catch { child.kill(name); } };
    const stop = () => {
      if (stopping || finished) return;
      stopping = true;
      kill('SIGTERM');
      forced = setTimeout(() => kill('SIGKILL'), 1500);
    };
    const timer = setTimeout(() => { failure = t('update.timeout'); stop(); }, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', part => { if (output.length < 1024 * 1024) output += part; });
    // Keep private subprocess diagnostics local; do not expose raw environment/logs.
    child.stderr.on('data', () => {});
    const complete = error => {
      if (finished) return; finished = true;
      // The disposable process group can include an app-server after the main
      // test window exits. Never leave those children behind after cancellation
      // or after a final report has ended the isolated test.
      // U4 fix: Always clean up process group, even on normal exit
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* ESRCH is fine */ }
        setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ESRCH is fine */ } }, 100);
      }
      clearTimeout(timer); clearTimeout(forced); clearTimeout(polling); signal?.removeEventListener('abort', stop);
      if (signal?.aborted) reject(new Error(t('update.cancelled')));
      else if (failure) reject(new Error(failure));
      else if (error && !reported) reject(error); else resolve(output);
    };
    child.once('error', () => complete(new Error(t('update.launchFailed'))));
    child.once('exit', code => complete(code === 0 ? undefined : new Error(failure || t('update.checkFailed'))));
    const poll = async () => {
      let ready = false;
      try { ready = await resultReady(); } catch { /* The report may not exist yet. */ }
      if (finished || stopping) return;
      if (ready === true) {
        reported = true;
        clearTimeout(timer);
        stop();
      } else polling = setTimeout(poll, 150);
    };
    if (resultReady) polling = setTimeout(poll, 150);
    if (signal?.aborted) stop();
  });
}

async function latestStable(profiles, helper, signal) {
  const result = JSON.parse(await runChild('python3', [path.join(helper, 'scripts/update_package.py'), '--latest',
    '--platform', hostPlatform()], { signal, timeout: 45000 }));
  return { ...result, supported: supportedProfile(profiles)?.version };
}

function activateUpdates(context, output, isBusy) {
  const profiles = require('./compatibility.json');
  const helper = context.extensionPath;
  const storage = path.join(context.globalStorageUri.fsPath, 'updates');
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  let disposed = false, checking, last, notice, pendingReload;
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 30);
  bar.command = 'codexSessionTabs.updateStatus';
  const manager = new UpdateManager({ storage, helper, profiles, isBusy,
    download: async (profile, file, signal) => {
      await runChild('python3', [path.join(helper, 'scripts/update_package.py'),
        '--download-profile', JSON.stringify(profile), '--output', file], { signal, timeout: 600000 });
    },
    prepare: async (original, job, profile, signal) => {
      const policy = path.join(job, 'profile.json');
      await fs.writeFile(policy, JSON.stringify(profile));
      const result = await runChild('python3', [path.join(helper, 'scripts/update_package.py'),
        '--vsix', original, '--destination', path.join(job, 'candidate'),
        '--helper', helper, '--profile', policy], { signal });
      return JSON.parse(result);
    },
    verifyCandidate: async (candidate, signal) => {
      await runChild('python3', [path.join(helper, 'scripts/update_package.py'),
        '--verify-tree', candidate.vendor, '--expected-tree', candidate.treeSha256], { signal });
    },
    probe: async (candidate, _job, evidence, signal) => {
      const parent = testMode && process.env.CODEX_TABS_LAB_PROFILES || os.tmpdir();
      await fs.mkdir(parent, { recursive: true });
      const run = await fs.mkdtemp(path.join(parent, 'cst-'));
      const userData = path.join(run, 'u');
      if (Buffer.byteLength(path.join(userData, '1.14-main.sock')) > 100) throw new Error(t('update.longPath'));
      await fs.mkdir(path.join(userData, 'User'), { recursive: true });
      await fs.mkdir(path.join(run, 'c'));
      await fs.writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({
        'extensions.autoUpdate': 'off', 'extensions.autoCheckUpdates': false,
        'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
        'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
      }));
      const reportFile = path.join(run, 'report.json');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].includes(key)));
      Object.assign(env, { CODEX_HOME: path.join(run, 'c'), CODEX_TABS_PROBE: '1',
        CODEX_TABS_PROBE_REPORT: reportFile, CODEX_TABS_PROBE_VENDOR: candidate.vendor,
        CODEX_TABS_PROBE_USER_DATA: userData, CODEX_TABS_PROBE_HELPER: helper,
        CODEX_TABS_PROBE_EVIDENCE: JSON.stringify(evidence) });
      const macos = path.resolve(vscode.env.appRoot, '../../MacOS');
      const names = await fs.readdir(macos);
      const binary = names.find(name => name === 'Code') || names.find(name => name === 'Electron');
      if (!binary) throw new Error(t('update.binaryMissing'));
      try {
        try { await runChild(path.join(macos, binary), ['--new-window', '--user-data-dir=' + userData,
          '--extensions-dir=' + candidate.extensionsDir, '--extensionDevelopmentPath=' + helper,
          '--extensionTestsPath=' + path.join(helper, 'test/update-probe.js'),
          '--skip-welcome', '--skip-release-notes', '--disable-updates',
          // A background/covered test window must continue loading its renderer.
          // These Chromium scheduling flags apply only to the disposable process.
          '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows'], { env, signal,
          // Two renderer starts at most, each as long as the profile lets Codex start.
          timeout: 20000 + 2 * newChatWaitMs(profileFor(profiles, candidate.version)),
          resultReady: async () => {
            const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
            // This only ends the disposable process. UpdateManager independently
            // requires this attempt's version, build, successful UI checks and
            // unchanged package/tree hashes before saving or installing anything.
            return report.finished === true;
          } }); }
        finally {
          try {
            const evidence = JSON.parse(await fs.readFile(reportFile, 'utf8'));
            await fs.writeFile(path.join(storage, 'last-probe.json'), JSON.stringify(evidence, null, 2));
            if (evidence.error) output.appendLine(t('log.probe', { message: evidence.error }));
          } catch { /* Missing report is a failed probe, never success. */ }
        }
        return JSON.parse(await fs.readFile(reportFile, 'utf8'));
      } finally { await fs.rm(run, { recursive: true, force: true }); }
    },
    install: async (file, version) => {
      const before = vscode.extensions.getExtension('openai.chatgpt')?.extensionPath;
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
      // The running host may still expose the old extension path until reload.
      // Inspect the on-disk installation without altering VS Code's registry.
      const after = vscode.extensions.getExtension('openai.chatgpt')?.extensionPath;
      const roots = [...new Set([after && path.dirname(after), before && path.dirname(before),
        context.globalState.get('codexExtensionsRoot')].filter(value => value && path.isAbsolute(value)))];
      let verified = false;
      for (const parent of roots) {
        try {
          const installed = JSON.parse(await fs.readFile(path.join(parent, 'extensions.json'), 'utf8'));
          const entry = installed.find(item => item.identifier?.id?.toLowerCase() === 'openai.chatgpt'
            && item.version === version && item.metadata?.pinned === true);
          if (!entry?.relativeLocation || entry.relativeLocation.includes('/') || entry.relativeLocation.includes('\\')) continue;
          const health = await inspectInstalled(path.join(parent, entry.relativeLocation), profiles, helper);
          if (health.status === 'ready') { verified = true; break; }
        } catch { /* Check other previously observed official extension roots. */ }
      }
      if (!verified) throw new Error(t('update.installUnverified'));
      pendingReload = version;
    },
    confirmInstall: async (version, restoring) => {
      const action = restoring ? t('action.restore') : t('action.install');
      return await vscode.window.showWarningMessage(
        t(restoring ? 'update.confirmRestore' : 'update.confirmInstall', { version }),
        { modal: true }, action) === action;
    },
  });
  // Development tests still use all production hash/runtime checks; this only
  // avoids downloading the same 400 MB official package for every isolated run.
  if (testMode && process.env.CODEX_TABS_LAB_OFFICIAL) {
    manager.download = async (_profile, file) => fs.copyFile(process.env.CODEX_TABS_LAB_OFFICIAL, file);
  }
  const run = async restoring => {
    const supported = supportedProfile(profiles);
    if (process.platform !== 'darwin' || vscode.env.remoteName || !supported) {
      throw new Error(t('update.macOnly'));
    }
    if (!restoring && !testMode) {
      const action = t('action.startCheck');
      const answer = await vscode.window.showWarningMessage(t('update.confirmCheck', { version: supported.version }),
        { modal: true }, action);
      if (answer !== action) return { status: 'cancelled' };
    }
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: restoring ? t('update.progressRestore') : t('update.progressCheck'), cancellable: !restoring },
    async (_progress, token) => {
      const abort = new AbortController();
      const cancel = token.onCancellationRequested(() => abort.abort());
      try {
        if (!restoring) {
          const release = testMode && process.env.CODEX_TABS_LAB_OFFICIAL
            ? { latest: supported.version } : await latestStable(profiles, helper, abort.signal);
          if (!profileFor(profiles, release.latest)) {
            vscode.window.showInformationMessage(t('update.latestUnsupported', { version: release.latest })).then(undefined, () => {});
          }
        }
        const result = restoring ? await manager.restore() : await manager.run(supported.version, abort.signal);
        await check();
        if (['installed', 'restored'].includes(result.status)) {
          await context.globalState.update('managedCodexVersion', result.version);
          const reloadLabel = t('action.reload');
          vscode.window.showInformationMessage(t('update.installed'), reloadLabel)
            .then(action => { if (action === reloadLabel) return vscode.commands.executeCommand('workbench.action.reloadWindow'); }, () => {});
        }
        return result;
      } finally { cancel.dispose(); }
    });
  };
  const safe = action => async () => {
    try { return await action(); }
    catch (error) { const message = errorText(error); output.appendLine(t('log.update', { message })); vscode.window.showErrorMessage(message); return { status: 'error', message }; }
  };
  async function check() {
    if (checking) return checking;
    checking = (async () => {
      const vendor = vscode.extensions.getExtension('openai.chatgpt');
      if (vendor && context.globalState.get('codexExtensionsRoot') !== path.dirname(vendor.extensionPath)) {
        await context.globalState.update('codexExtensionsRoot', path.dirname(vendor.extensionPath));
      }
      last = pendingReload ? { status: 'reload-required', version: pendingReload,
        message: t('health.reload') }
        : await inspectInstalled(vendor?.extensionPath, profiles, helper);
      if (disposed) return last;
      bar.text = `$(shield) Codex Tabs${last.status === 'ready' ? '' : ' $(warning)'}`;
      bar.tooltip = last.message;
      bar.show();
      if (notice !== last.status && context.extensionMode === vscode.ExtensionMode.Production) {
        notice = last.status;
        if (!['ready', 'reload-required'].includes(last.status)) {
          const saved = await manager.recovery({ checkFile: false });
          vscode.window.showWarningMessage(saved ? t('update.canRestore', { message: last.message }) : last.message,
            saved ? t('action.restoreCodex') : t('action.checkUpdate'))
            .then(action => { if (action) return safe(async () => {
              if (await manager.recovery()) return run(true);
              return run(false);
            })(); }, () => {});
        }
      }
      return last;
    })();
    try { return await checking; } finally { checking = undefined; }
  }
  context.subscriptions.push(bar,
    vscode.commands.registerCommand('codexSessionTabs.checkUpdate', safe(() => run(false))),
    vscode.commands.registerCommand('codexSessionTabs.restoreCodex', safe(() => run(true))),
    vscode.commands.registerCommand('codexSessionTabs.updateStatus', async () => {
      const state = await check();
      if (['ready', 'reload-required'].includes(state.status)) {
        await vscode.window.showInformationMessage(state.message);
        return state;
      }
      const checkLabel = t('action.checkUpdate'), restoreLabel = t('action.restore');
      const recovered = await manager.recovery({ checkFile: false });
      const action = await vscode.window.showInformationMessage(state.message, checkLabel, ...(recovered ? [restoreLabel] : []));
      if (action === checkLabel) return safe(() => run(false))();
      if (action === restoreLabel) return safe(() => run(true))();
      return state;
    }),
    vscode.extensions.onDidChange(() => check().catch(error => output.appendLine(error.message))),
  );
  const timer = setInterval(() => check().catch(error => output.appendLine(error.message)), 60000);
  context.subscriptions.push({ dispose: () => { disposed = true; clearInterval(timer); } });
  check().catch(error => output.appendLine(error.message));
  return { manager, check, get status() { return last; } };
}

module.exports = { activateUpdates, runChild, latestStable };
