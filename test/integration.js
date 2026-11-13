'use strict';

const vscode = require('vscode');
const assert = require('node:assert/strict');
const { integrationEnvironment, integrationContext, createOutput } = require('./integration-support');
const { profileFor, newChatWaitMs } = require('../update-core');

async function waitFor(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(message);
}

async function run() {
  // Fail before activation, report writes or editor changes when launched normally.
  const userData = integrationEnvironment(vscode);
  const manifest = require('../package.json');
  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert.ok(extension, 'Development extension is installed');
  const api = await extension.activate();
  integrationContext(vscode, api.provider.context, userData);
  const output = createOutput(userData);
  const report = { started: new Date().toISOString(), checks: [], success: false };
  const save = () => output.write('report.json', JSON.stringify(report, null, 2));
  const check = (name, detail) => { report.checks.push({ name, detail }); save(); };
  const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
    .filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'chatgpt.conversationEditor');
  save();
  try {
    check('extension activated', extension.packageJSON.version);
    const sessions = await api.listSessions();
    assert.ok(sessions.length >= 3, 'At least three saved chats are available');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    check('saved chats loaded', { count: sessions.length });
    await api.show();
    await waitFor(() => api.view.visible, 'The sessions sidebar becomes visible');
    await vscode.commands.executeCommand('codexSessionTabs.history.focus');
    await waitFor(() => api.historyView.visible, 'The full saved history is visible and accessible');
    assert.equal((await api.provider.getChildren()).length, 0);
    assert.equal((await api.history.getChildren()).length, sessions.length);
    check('empty open section and saved chats in history', { open: 0, history: sessions.length });
    const selected = sessions.slice(0, 3);
    const rendererWait = newChatWaitMs(profileFor(require('../compatibility.json'), vscode.extensions.getExtension('openai.chatgpt').packageJSON.version));
    const waitForSavedTab = id => waitFor(() => [...api.titles.bindings.values()]
      .some(binding => binding.id === id && binding.isReady?.() === true), 'Saved chat renderer is ready', rendererWait);
    for (const session of selected) await api.openSession(session);
    await waitForSavedTab(selected[2].id);
    const savedTabs = tabs();
    for (const session of selected) {
      const matches = savedTabs.filter(tab => tab.input.uri.path === `/local/${session.id}`);
      assert.equal(matches.length, 1, 'Each saved chat has exactly one native Codex tab');
      assert.equal(matches[0].isPreview, false, 'Chat tabs are pinned, not replaced as preview editors');
      assert.notEqual(matches[0].label, 'Codex', 'The native editor resolved the saved chat title');
    }
    check('three distinct native saved-chat tabs', { count: savedTabs.length, labels: savedTabs.map(tab => tab.label) });
    assert.ok(selected.every(session => api.titles.bindings.has(savedTabs.find(tab => tab.input.uri.path === `/local/${session.id}`).input.uri.toString())), 'The native adapter attaches actual title controls');
    await api.titles.sync();
    await waitFor(() => selected.every(session => savedTabs.find(tab => tab.input.uri.path === `/local/${session.id}`).label === session.title), 'Saved chat tabs show the full generated titles');
    check('native adapter synchronizes actual tab titles', true);
    assert.ok(savedTabs.every(tab => tab.label.length <= 36), 'Automatic titles stay compact');
    const openRows = await api.provider.getChildren();
    assert.equal(openRows.length, 3);
    assert.deepEqual(new Set(openRows.map(row => row.id)), new Set(selected.map(row => row.id)));
    assert.equal((await api.history.getChildren()).length, sessions.length - 3);
    check('open section mirrors tabs and history excludes them', { open: 3, history: sessions.length - 3 });
    await vscode.commands.executeCommand('codexSessionTabs.close', openRows[2]);
    assert.equal((await api.provider.getChildren()).length, 2);
    const closed = (await api.history.getChildren()).find(row => row.id === openRows[2].id);
    assert.ok(closed, 'Closing a tab puts its saved chat back in history');
    check('closing a tab removes it from open section and returns it to history', true);
    await vscode.commands.executeCommand('codexSessionTabs.open', closed);
    await waitForSavedTab(closed.id);
    assert.equal((await api.provider.getChildren()).length, 3);
    assert.ok(!(await api.history.getChildren()).some(row => row.id === closed.id));
    check('opening from history restores the tab and open-list entry', true);
    await api.openSession(selected[0]);
    await waitForSavedTab(selected[0].id);
    assert.equal(tabs().length, savedTabs.length, 'Reopening an existing session selects its tab');
    check('reopening saved chat reuses its own tab', true);
    const firstNew = await api.newSession();
    const secondNew = await api.newSession();
    assert.notEqual(firstNew.toString(), secondNew.toString());
    assert.equal(tabs().length, savedTabs.length + 2, 'Two new chats create two additional native tabs');
    assert.equal((await api.provider.getChildren()).length, 5);
    check('two new chats have independent native tabs', { totalTabs: tabs().length });
    const draft1 = tabs().find(tab => tab.input.uri.toString() === firstNew.toString());
    const draft2 = tabs().find(tab => tab.input.uri.toString() === secondNew.toString());
    assert.match(draft1.label, /^(?:New chat|Новый диалог) \d+$/);
    assert.match(draft2.label, /^(?:New chat|Новый диалог) \d+$/);
    assert.notEqual(draft1.label, draft2.label);
    check('empty drafts have distinct numbered titles', true);
    const draftRow = (await api.provider.getChildren()).find(row => row.key === firstNew.toString());
    await vscode.commands.executeCommand('codexSessionTabs.rename', draftRow, 'Тест ручного названия');
    await waitFor(() => tabs().find(tab => tab.input.uri.toString() === firstNew.toString())?.label === 'Тест ручного названия', 'Manual name reaches the native tab');
    check('manual rename changes the actual native tab', true);
    // This is a lifecycle event simulation; it does not run a model or alter
    // a real conversation. Test a background saved tab with a different tab active.
    await vscode.commands.executeCommand('codexSessionTabs.nativeActivity', { id: selected[0].id, phase: 'started', turnId: 'integration-turn' });
    await vscode.commands.executeCommand('codexSessionTabs.nativeActivity', { id: selected[0].id, phase: 'completed', turnId: 'integration-turn' });
    assert.equal(api.titles.isUnread(selected[0].id), true);
    const backgroundBinding = api.titles.bindings.get(savedTabs[0].input.uri.toString());
    assert.equal(backgroundBinding.lastUnread, true);
    assert.ok(backgroundBinding.getIcon().light.path.endsWith('ready-light.svg'), 'The actual native tab uses the icon with an orange dot');
    if (process.env.CODEX_TABS_CDP_PORT) {
      const visual = await require('./visual-icons').inspectTabIcons(process.env.CODEX_TABS_CDP_PORT, output);
      check('actual rendered tab icon resources', visual);
      const badgeAssets = visual.assets.filter(asset => /ready-(light|dark)\.svg/.test(asset.url));
      assert.ok(badgeAssets.length > 0 && badgeAssets.every(asset => asset.loaded), 'The renderer can load every ready badge image');
    }
    await api.openSession(selected[0]);
    await waitForSavedTab(selected[0].id);
    await waitFor(() => !api.titles.isUnread(selected[0].id), 'Selecting a completed background tab clears its badge');
    assert.ok(backgroundBinding.getIcon().light.path.endsWith('blossom-black.svg'), 'Reading restores the original Codex icon');
    check('background-completion badge and reading acknowledgement', true);
    await assert.rejects(api.openSession('../not-a-session'), /identifier|идентификатор/);
    check('invalid chat identifiers rejected', true);
    report.success = true;
    report.finished = new Date().toISOString();
    save();
  } catch (error) {
    report.error = error.stack || String(error);
    save();
    throw error;
  } finally {
    console.log('Private integration report: ' + output.directory);
  }
}

module.exports = { run };
