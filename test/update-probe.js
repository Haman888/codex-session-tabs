'use strict';

const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newChatWaitMs, profileFor } = require('../update-core');

async function until(predicate, description, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(description);
}

async function run() {
  const file = process.env.CODEX_TABS_PROBE_REPORT;
  const evidence = JSON.parse(process.env.CODEX_TABS_PROBE_EVIDENCE);
  const started = Date.now();
  const report = { ...evidence, success: false, finished: false, phase: 'isolation', checks: {} };
  const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2));
  save();
  try {
    const manifest = require('../package.json');
    const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
    const vendor = vscode.extensions.getExtension('openai.chatgpt');
    assert.equal(fs.realpathSync(extension.extensionPath), fs.realpathSync(process.env.CODEX_TABS_PROBE_HELPER));
    assert.equal(fs.realpathSync(vendor.extensionPath), fs.realpathSync(process.env.CODEX_TABS_PROBE_VENDOR));
    assert.equal(vscode.workspace.workspaceFolders, undefined);
    const api = await extension.activate();
    const rendererWait = newChatWaitMs(profileFor(api.updates.manager.profiles, vendor.packageJSON.version));
    assert.ok(api.provider.context.globalStorageUri.fsPath.startsWith(process.env.CODEX_TABS_PROBE_USER_DATA + path.sep));
    assert.deepEqual(await api.listSessions(), []);
    assert.equal((await api.updates.check()).status, 'ready');
    report.version = vendor.packageJSON.version;
    report.checks.isolation = true;
    report.phase = 'native-new-chat'; save();
    const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'chatgpt.conversationEditor');
    const fixed = 'openai-codex://route/extension/panel/new';
    const oldId = '00000000-0000-0000-0000-000000000001';
    api.titles.identities.set(fixed, oldId);
    await api.titles.persist();
    await vscode.commands.executeCommand('chatgpt.newCodexPanel');
    await until(() => tabs().length === 1, 'First native New Chat creates a tab');
    const first = tabs()[0].input.uri;
    await vscode.commands.executeCommand('chatgpt.newCodexPanel');
    await until(() => tabs().length === 2 && api.titles.bindings.size === 2,
      'Second native New Chat creates another tab after the first renderer is ready', rendererWait);
    const second = tabs().find(tab => tab.input.uri.toString() !== first.toString()).input.uri;
    assert.ok(first.query.includes('sessionTab='));
    assert.notEqual(first.toString(), second.toString());
    assert.equal(api.titles.idFor(first.toString()), undefined);
    assert.equal(api.titles.idFor(second.toString()), undefined);
    report.checks.nativeNewChat = true;
    report.phase = 'interface'; save();
    await until(() => [...api.titles.bindings.values()].every(binding => binding.isReady?.() === true),
      'The actual Codex chat interface must finish its renderer handshake', rendererWait);
    report.checks.interface = true;
    report.phase = 'language'; save();
    const languageConfig = vscode.workspace.getConfiguration('codexSessionTabs');
    const originalLanguage = languageConfig.get('language', 'auto');
    try {
      for (const [language, openTitle, historyTitle, draftPattern] of [
        ['en', 'Open sessions', 'History', /^New chat \d+$/],
        ['ru', 'Открытые сессии', 'История', /^Новый диалог \d+$/],
      ]) {
        await languageConfig.update('language', language, vscode.ConfigurationTarget.Global);
        await api.language.apply();
        assert.equal(api.view.title, openTitle);
        assert.equal(api.historyView.title, historyTitle);
        await until(() => tabs().every(tab => draftPattern.test(tab.label)), 'Native draft labels follow the chosen language');
      }
      report.checks.language = true;
    } finally {
      await languageConfig.update('language', originalLanguage, vscode.ConfigurationTarget.Global);
      await api.language.apply();
    }
    report.phase = 'titles-and-indicators'; save();
    assert.ok(tabs().every(tab => !tab.isPreview));
    report.checks.nativeTabs = true;
    const firstTab = () => tabs().find(tab => tab.input.uri.toString() === first.toString());
    const secondTab = () => tabs().find(tab => tab.input.uri.toString() === second.toString());
    assert.notEqual(firstTab().label, secondTab().label);
    const row = (await api.provider.getChildren()).find(item => item.key === second.toString());
    await vscode.commands.executeCommand('codexSessionTabs.rename', row, 'Проверка обновления');
    await until(() => secondTab().label === 'Проверка обновления', 'Native title is updated');
    report.checks.titles = true;
    await vscode.commands.executeCommand('codexSessionTabs.nativeBind', { key: first.toString(), id: oldId });
    await vscode.commands.executeCommand('codexSessionTabs.nativeActivity', { id: oldId, phase: 'started', turnId: 'synthetic-probe' });
    await vscode.commands.executeCommand('codexSessionTabs.nativeActivity', { id: oldId, phase: 'completed', turnId: 'synthetic-probe' });
    const binding = api.titles.bindings.get(first.toString());
    assert.equal(api.titles.isUnread(oldId), true);
    assert.equal(binding.getIcon().light.scheme, 'file');
    assert.ok(fs.readFileSync(binding.getIcon().light.fsPath, 'utf8').includes('<circle'));
    report.checks.completion = true;
    const firstRow = (await api.provider.getChildren()).find(item => item.key === first.toString());
    await vscode.commands.executeCommand('codexSessionTabs.open', firstRow);
    if (vscode.window.state.focused) {
      await until(() => !api.titles.isUnread(oldId), 'Selecting the focused tab acknowledges the answer');
      report.acknowledgementMode = 'focused-tab-selection';
    } else {
      // A check running behind the user's working window must not mark an
      // unseen answer as read or steal OS focus merely to pass its test.
      report.acknowledgementMode = 'explicit-acknowledgement-in-background-test';
      api.titles.acknowledge(oldId);
      assert.equal(api.titles.isUnread(oldId), false);
    }
    assert.ok(binding.getIcon().light.path.endsWith('blossom-black.svg'));
    report.checks.acknowledgement = true;
    report.success = true;
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally { report.finished = true; report.elapsedMs = Date.now() - started; save(); }
}

module.exports = { run };
