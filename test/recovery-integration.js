'use strict';

const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { integrationEnvironment, integrationContext, createOutput } = require('./integration-support');

async function until(predicate, message) {
  const deadline = Date.now() + 105000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(message);
}

async function run() {
  const userData = integrationEnvironment(vscode);
  const pkg = require('../package.json');
  const extension = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
  const api = await extension.activate();
  integrationContext(vscode, api.provider.context, userData);
  const output = createOutput(userData);
  const report = { phase: process.env.CODEX_TABS_RECOVERY_PHASE, success: false, finished: false, modelTurnsSent: 0 };
  const save = () => output.write('report.json', JSON.stringify(report, null, 2));
  const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
    .filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'chatgpt.conversationEditor');
  const snapshot = () => tabs().map(tab => ({ uri: tab.input.uri.toString(), title: tab.label })).sort((a, b) => a.uri.localeCompare(b.uri));
  save();
  try {
    assert.equal((await api.updates.check()).status, 'ready');
    assert.deepEqual(await api.listSessions(), []);
    const manager = api.updates.manager;
    if (report.phase === 'restore') {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      report.step = 'open-tabs'; save();
      await vscode.commands.executeCommand('codexSessionTabs.new');
      await vscode.commands.executeCommand('codexSessionTabs.new');
      await until(() => tabs().length === 2 && api.titles.bindings.size === 2
        && [...api.titles.bindings.values()].every(binding => binding.isReady()), 'Two ready tabs before recovery');
      const row = (await api.provider.getChildren())[0];
      await vscode.commands.executeCommand('codexSessionTabs.rename', row, 'Проверка сохранения вкладки');
      await until(() => tabs().some(tab => tab.label === 'Проверка сохранения вкладки'), 'Custom tab title');
      const before = snapshot();
      await api.provider.context.globalState.update('recoveryProbeTabs', before);
      assert.equal(await manager.recovery(), undefined, 'Seeded receipt is from the previous helper');
      assert.equal((await manager.recovery({ allowRevalidation: true })).needsRevalidation, true);
      manager.confirmInstall = async () => true;
      const probe = manager.probe;
      manager.probe = async (...args) => {
        report.step = 'isolated-interface'; save();
        const result = await probe(...args);
        report.gui = result; save();
        return result;
      };
      report.step = 'restore-command'; save();
      const result = await vscode.commands.executeCommand('codexSessionTabs.restoreCodex');
      assert.equal(result.status, 'restored', JSON.stringify(result));
      assert.equal(report.gui.success, true);
      assert.equal((await manager.recovery()).needsRevalidation, false);
      assert.deepEqual(snapshot(), before);
      report.tabsPreservedDuringRestore = true;
      report.version = result.version;
      await vscode.workspace.getConfiguration('window').update('restoreWindows', 'all', vscode.ConfigurationTarget.Global);
      await api.titles.persist();
    } else {
      assert.equal(report.phase, 'restart');
      const expected = api.provider.context.globalState.get('recoveryProbeTabs');
      assert.equal(expected.length, 2);
      await until(() => tabs().length === 2 && api.titles.bindings.size === 2
        && [...api.titles.bindings.values()].every(binding => binding.isReady()), 'Saved tabs reopen after restart');
      await until(() => JSON.stringify(snapshot()) === JSON.stringify(expected), 'Tab identifiers and custom titles survive restart');
      report.tabsRestoredAfterRestart = true;
      report.recoveryAcceptedAfterRestart = (await manager.recovery()).needsRevalidation === false;
      assert.equal(report.recoveryAcceptedAfterRestart, true);
    }
    report.success = true;
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally { report.finished = true; save(); }
}

module.exports = { run };
