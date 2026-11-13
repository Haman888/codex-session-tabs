'use strict';
const vscode = require('vscode');
const assert = require('node:assert/strict');
const { integrationEnvironment, integrationContext, createOutput } = require('./integration-support');
const { UpdateManager, profileFor } = require('../update-core');
const { latestStable } = require('../update-ui');

async function run() {
  const userData = integrationEnvironment(vscode);
  const pkg = require('../package.json');
  const extension = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
  const api = await extension.activate();
  integrationContext(vscode, api.provider.context, userData);
  assert.equal(vscode.extensions.getExtension('openai.chatgpt'), undefined);
  assert.deepEqual(await api.listSessions(), []);
  const output = createOutput(userData);
  const report = { started: new Date().toISOString(), success: false, finished: false };
  const save = () => output.write('report.json', JSON.stringify(report, null, 2));
  save();
  try {
    const bundled = require('../compatibility.json');
    const release = await latestStable(bundled, extension.extensionPath);
    assert.equal(profileFor(bundled, release.latest), undefined, 'Run a disposable helper copy with the latest profile removed');
    report.version = release.latest;
    report.phase = 'download-and-probe'; save();
    const manager = api.updates.manager;
    manager.confirmInstall = async () => false;
    const probe = manager.probe;
    manager.probe = async (...args) => {
      const evidence = await probe(...args);
      report.gui = evidence; save();
      return evidence;
    };
    const result = await vscode.commands.executeCommand('codexSessionTabs.checkUpdate');
    assert.equal(result.status, 'verified', JSON.stringify(result));
    assert.equal(result.version, release.latest);
    assert.equal(report.gui.success, true);
    const restarted = new UpdateManager({ storage: manager.storage, helper: extension.extensionPath,
      profiles: [...bundled], verifyCandidate: manager.verifyCandidate });
    await restarted.loadProfiles();
    assert.equal(profileFor(restarted.profiles, release.latest).discovery, 'structure-v1');
    assert.equal((await restarted.recovery()).version, release.latest);
    report.learnedAfterRestart = true;
    report.recoveryVerified = true;
    report.success = true;
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally { report.finished = true; report.ended = new Date().toISOString(); save(); }
}

module.exports = { run };
