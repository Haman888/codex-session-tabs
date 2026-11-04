'use strict';

const { t, setLanguage } = require('./i18n');
const manifest = require('./package.json');

function activateLanguage(vscode, context, changed) {
  let applied, queue = Promise.resolve();
  const apply = () => {
    queue = queue.catch(() => {}).then(async () => {
      const preference = vscode.workspace.getConfiguration('codexSessionTabs').get('language', 'auto');
      const next = setLanguage(preference, vscode.env.language);
      if (next === applied) return next;
      await vscode.commands.executeCommand('setContext', 'codexSessionTabs.uiLanguage', next);
      applied = next;
      await changed(next);
      return next;
    });
    return queue;
  };
  for (const { command } of manifest.contributes.commands) {
    if (!/\.(en|ru)$/.test(command)) continue;
    context.subscriptions.push(vscode.commands.registerCommand(command,
      (...args) => vscode.commands.executeCommand(command.slice(0, -3), ...args)));
  }
  context.subscriptions.push(vscode.commands.registerCommand('codexSessionTabs.language', async () => {
    const selected = await vscode.window.showQuickPick([
      { label: 'English', value: 'en' },
      { label: 'Русский', value: 'ru' },
      { label: t('language.auto'), description: vscode.env.language, value: 'auto' },
    ], { title: 'Language / Язык', placeHolder: t('language.choose') });
    if (!selected) return;
    await vscode.workspace.getConfiguration('codexSessionTabs').update('language', selected.value, vscode.ConfigurationTarget.Global);
    return apply();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('codexSessionTabs.language')) {
      apply().catch(error => vscode.window.showErrorMessage(error.message));
    }
  }));
  return { apply, ready: apply() };
}

module.exports = { activateLanguage };
