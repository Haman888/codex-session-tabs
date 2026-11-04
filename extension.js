'use strict';

const { t, errorText, formatDate, setLanguage } = require('./i18n');
const { activateLanguage } = require('./ui-language');

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { codexHome, listSessions, getSessionStatus, resetSessions } = require('./sessions');
const { Titles } = require('./titles');
const { prepareBadges } = require('./badges');
const { activateUpdates } = require('./update-ui');

const VIEW = 'codexSessionTabs.sessions';
const EDITOR = 'chatgpt.conversationEditor';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
let titles;
let panelOpening = Promise.resolve();

async function ensureCodex() {
  const codex = vscode.extensions.getExtension('openai.chatgpt');
  if (!codex) throw new Error(t('error.codexMissing'));
  if (!codex.isActive) await codex.activate();
  // This is the internal editor used by the installed official Codex extension.
  // Refuse to guess if a future version changes its editor contribution.
  const editors = codex.packageJSON.contributes?.customEditors || [];
  if (!editors.some(editor => editor.viewType === EDITOR)) {
    throw new Error(t('error.editorChanged'));
  }
}

async function openUri(uri) {
  await ensureCodex();
  await vscode.commands.executeCommand('vscode.openWith', uri, EDITOR, {
    viewColumn: vscode.ViewColumn.Active, preserveFocus: false, preview: false,
  });
  return uri;
}

async function openSession(session) {
  const id = typeof session === 'string' ? session : session?.id;
  if (!UUID.test(id || '')) throw new Error(t('error.invalidId'));
  const existing = openTabs().find(row => row.id === id);
  if (existing) return revealTab(existing);
  return openUri(vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: `/local/${id}` }));
}

function newSession() {
  const operation = panelOpening.then(async () => {
  // A distinct resource prevents VS Code from reusing the official command's
  // constant /extension/panel/new resource. The route itself remains unchanged.
  const uri = await openUri(vscode.Uri.from({
    scheme: 'openai-codex', authority: 'route', path: '/extension/panel/new',
    query: `sessionTab=${randomUUID()}`,
  }));
  let remaining = 45000, previous = Date.now();
  while (remaining > 0) {
    const binding = titles?.bindings.get(uri.toString());
    if (binding?.isReady?.()) return uri;
    if (binding && !binding.isReady) throw new Error(t('error.adapterOutdated'));
    if (!openTabs().some(row => row.key === uri.toString())) throw new Error(t('error.tabClosed'));
    const now = Date.now();
    if (binding?.isVisible?.() !== false) remaining -= now - previous;
    previous = now;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(t('error.newChatTimeout'));
  });
  panelOpening = operation.catch(() => {});
  return operation;
}

function openTabs() {
  const rows = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputCustom) || tab.input.viewType !== EDITOR) continue;
      const uri = tab.input.uri;
      if (uri.scheme !== 'openai-codex' || uri.authority !== 'route') continue;
      const match = /^\/(?:local|remote)\/([0-9a-f-]+)$/i.exec(uri.path);
      if (!match && uri.path !== '/extension/panel/new') continue;
      const key = uri.toString();
      const id = match?.[1] || titles?.idFor(key);
      rows.push({ key, uri, tab, group, id, title: titles?.titleFor(id, tab.label) || tab.label });
    }
  }
  return rows;
}

async function revealTab(row) {
  const existing = openTabs().find(item => item.key === row.key);
  if (!existing) return row.id ? openSession(row.id) : undefined;
  await ensureCodex();
  await vscode.commands.executeCommand('vscode.openWith', existing.uri, EDITOR, {
    viewColumn: existing.group.viewColumn, preserveFocus: false, preview: false,
  });
  return existing.uri;
}

class SessionsProvider {
  constructor(context, output, kind) {
    this.context = context;
    this.output = output;
    this.kind = kind;
    this.events = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.events.event;
    this.error = undefined;
    this.lastError = undefined;
  }
  get folders() {
    return (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
  }
  get scope() { return this.context.globalState.get('scope', 'all'); }
  refresh() { this.events.fire(undefined); }
  async list() {
    return (await listSessions({ folders: this.folders, scope: this.scope }))
      .map(row => ({ ...row, title: titles?.titleFor(row.id, row.title) || row.title }));
  }
  async getChildren() {
    try {
      // The open section always mirrors actual tabs, regardless of history scope.
      const tabs = openTabs();
      const sessions = (await listSessions({ folders: this.folders, scope: this.kind === 'open' ? 'all' : this.scope }))
        .map(row => ({ ...row, title: titles?.titleFor(row.id, row.title) || row.title }));
      const status = getSessionStatus();
      this.error = status.error && (status.stale ? t('history.stale', { message: status.error }) : status.error);
      if (!this.error) this.lastError = undefined;
      this.updateDescription?.();
      if (this.kind === 'history') {
        const ids = new Set(tabs.map(row => row.id).filter(Boolean));
        return sessions.filter(row => !ids.has(row.id));
      }
      const metadata = new Map(sessions.map(row => [row.id, row]));
      return tabs.map(row => ({ ...metadata.get(row.id), ...row, title: metadata.get(row.id)?.title || row.title }));
    } catch (error) {
      this.error = error.message;
      if (this.lastError !== error.message) this.output.appendLine(error.stack || String(error));
      this.lastError = error.message;
      this.updateDescription?.();
      return this.kind === 'open' ? openTabs() : [];
    }
  }
  getTreeItem(session) {
    const title = session.title.replace(/\s+/g, ' ').trim() || t(session.id ? 'chat.fallback' : 'draft.fallback');
    const item = new vscode.TreeItem(title);
    item.id = session.key || session.id;
    item.contextValue = this.kind === 'open' ? 'openCodexSession' : 'closedCodexSession';
    const unread = titles?.isUnread(session.id);
    item.iconPath = unread ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.orange'))
      : new vscode.ThemeIcon(this.kind === 'history' ? 'history' : 'comment-discussion');
    item.description = path.basename(session.cwd || '') || undefined;
    item.tooltip = [title, unread && t('session.completed'), session.cwd, session.updatedAt && t('session.updated', { date: formatDate(session.updatedAt) })].filter(Boolean).join('\n');
    item.command = { command: 'codexSessionTabs.open', title: t('command.open'), arguments: [session] };
    return item;
  }
  dispose() { this.events.dispose(); }
}

function activate(context) {
  setLanguage(vscode.workspace.getConfiguration('codexSessionTabs').get('language', 'auto'), vscode.env.language);
  const output = vscode.window.createOutputChannel('Codex Session Tabs');
  const provider = new SessionsProvider(context, output, 'open');
  const history = new SessionsProvider(context, output, 'history');
  const tree = vscode.window.createTreeView(VIEW, { treeDataProvider: provider, showCollapseAll: false });
  const historyTree = vscode.window.createTreeView('codexSessionTabs.history', { treeDataProvider: history, showCollapseAll: false });
  provider.updateDescription = () => {
    tree.description = String(openTabs().length);
  };
  history.updateDescription = () => {
    historyTree.description = history.scope === 'workspace' ? t('scope.workspace') : t('scope.all');
    historyTree.message = history.error ? t('history.failed', { message: history.error }) : undefined;
  };
  provider.updateDescription();
  history.updateDescription();
  const render = () => { provider.refresh(); history.refresh(); provider.updateDescription(); };
  const titleOptions = {
    openTabs,
    isActive: id => vscode.window.state.focused && openTabs().some(row => row.id === id && row.tab === vscode.window.tabGroups.activeTabGroup.activeTab),
  };
  titleOptions.iconsReady = prepareBadges(context).then(icons => { titleOptions.icons = icons; }, error => output.appendLine(t('log.iconsFailed', { message: errorText(error) })));
  titles = new Titles(context, () => listSessions(), render, output, titleOptions);
  const updates = activateUpdates(context, output, () => [...titles.turns.values()].some(turn => turn.phase === 'started'));
  const acknowledgeActive = () => {
    if (!vscode.window.state.focused) return;
    const active = openTabs().find(row => row.tab === vscode.window.tabGroups.activeTabGroup.activeTab);
    if (active?.id) titles.acknowledge(active.id);
  };
  const refresh = () => {
    acknowledgeActive();
    render();
    titles.sync().catch(error => output.appendLine(error.message));
  };
  const safe = fn => async (...args) => {
    try { return await fn(...args); }
    catch (error) {
      output.appendLine(error.stack || String(error));
      vscode.window.showErrorMessage(`Codex Session Tabs: ${errorText(error)}`);
      return undefined;
    }
  };
  const show = () => vscode.commands.executeCommand(`${VIEW}.focus`);
  const pickFromHistory = async () => {
    const sessions = await history.getChildren();
    if (history.error && !sessions.length) throw new Error(history.error);
    if (!sessions.length) {
      vscode.window.showInformationMessage(t('history.empty'));
      return;
    }
    const selected = await vscode.window.showQuickPick(sessions.map(row => ({
      label: row.title.replace(/\s+/g, ' ').trim(), description: row.cwd,
      detail: formatDate(row.updatedAt), session: row,
    })), { title: t('history.title'), placeHolder: t('history.search'), matchOnDescription: true });
    if (selected) return openSession(selected.session);
  };
  context.subscriptions.push(output, provider, history, tree, historyTree,
    vscode.commands.registerCommand('codexSessionTabs.open', safe(async session => {
      if (session?.key) return revealTab(session);
      if (session) return openSession(session);
      return pickFromHistory();
    })),
    vscode.commands.registerCommand('codexSessionTabs.new', safe(newSession)),
    vscode.commands.registerCommand('codexSessionTabs.nativeNewPanel', async () => {
      try { await newSession(); return { handled: true, opened: true }; }
      catch (error) {
        output.appendLine(error.message);
        vscode.window.showErrorMessage(errorText(error));
        return { handled: true, opened: false };
      }
    }),
    vscode.commands.registerCommand('codexSessionTabs.rename', safe(async (row, newName) => {
      const rows = openTabs();
      if (row?.scheme) row = rows.find(item => item.uri.toString() === row.toString());
      if (!row?.key) row = rows.find(item => item.tab === vscode.window.tabGroups.activeTabGroup.activeTab);
      if (!row) {
        const selected = await vscode.window.showQuickPick(rows.map(item => ({ label: item.title, row: item })), { title: t('rename.choose') });
        row = selected?.row;
      }
      if (!row) return;
      const name = newName ?? await vscode.window.showInputBox({
        title: t('rename.title'), value: row.title,
        prompt: t('rename.prompt'),
        validateInput: value => !value.trim() ? t('rename.required') : value.trim().length > 120 ? t('rename.tooLong') : undefined,
      });
      if (name === undefined) return;
      return titles.rename(row, name);
    })),
    vscode.commands.registerCommand('codexSessionTabs.show', show),
    vscode.commands.registerCommand('codexSessionTabs.history', safe(pickFromHistory)),
    vscode.commands.registerCommand('codexSessionTabs.close', safe(async row => {
      const existing = openTabs().find(item => item.key === row?.key);
      if (existing) await vscode.window.tabGroups.close(existing.tab);
    })),
    vscode.commands.registerCommand('codexSessionTabs.refresh', () => { resetSessions(); refresh(); }),
    vscode.commands.registerCommand('codexSessionTabs.nativePanel', binding => titles.attach(binding)),
    vscode.commands.registerCommand('codexSessionTabs.nativeBind', ({ key, id }) => titles.bind(key, id)),
    vscode.commands.registerCommand('codexSessionTabs.nativeClosed', key => titles.detach(key)),
    vscode.commands.registerCommand('codexSessionTabs.nativeActivity', event => titles.activity(event)),
    vscode.commands.registerCommand('codexSessionTabs.scope', safe(async () => {
      const selected = await vscode.window.showQuickPick([
        { label: t('scope.all'), scope: 'all', description: t('scope.allDescription') },
        { label: t('scope.workspace'), scope: 'workspace', description: vscode.workspace.name || t('scope.noFolder') },
      ], { title: t('scope.choose'), placeHolder: provider.scope === 'workspace' ? t('scope.workspace') : t('scope.all') });
      if (!selected) return;
      await context.globalState.update('scope', selected.scope);
      history.updateDescription();
      history.refresh();
    })),
    vscode.window.registerUriHandler({ handleUri: safe(async uri => {
      if (uri.path === '/sessions') return show();
      if (uri.path === '/history') return vscode.commands.executeCommand('codexSessionTabs.history.focus');
      if (uri.path === '/new') return newSession();
      const match = /^\/session\/([0-9a-f-]+)$/i.exec(uri.path);
      if (match) return openSession(match[1]);
    }) }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.window.tabGroups.onDidChangeTabs(refresh),
    vscode.window.tabGroups.onDidChangeTabGroups(refresh),
    vscode.window.onDidChangeWindowState(acknowledgeActive),
    tree.onDidChangeVisibility(() => { if (tree.visible) refresh(); }),
    historyTree.onDidChangeVisibility(() => { if (historyTree.visible) history.refresh(); }),
  );
  // Watch database metadata only, never transcript contents. SQLite writes to WAL.
  let debounce;
  try {
    const watcher = fs.watch(codexHome(), (_event, name) => {
      if (!/^state_\d+\.sqlite(?:-wal)?$/.test(String(name || '')) && name !== 'session_index.jsonl') return;
      clearTimeout(debounce);
      debounce = setTimeout(refresh, 750);
    });
    context.subscriptions.push({ dispose: () => { watcher.close(); clearTimeout(debounce); } });
  } catch (error) { output.appendLine(t('log.watcherFailed', { message: errorText(error) })); }
  const timer = setInterval(() => { if (openTabs().length || tree.visible || historyTree.visible) refresh(); }, 2500);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  if (context.extensionMode === vscode.ExtensionMode.Production && !context.globalState.get('introduced', false)) {
    show().then(() => context.globalState.update('introduced', true), error => output.appendLine(error.message));
  }
  if (context.extensionMode === vscode.ExtensionMode.Production && !context.globalState.get('historyRecoveryShown', false)) {
    vscode.commands.executeCommand('codexSessionTabs.history.focus')
      .then(() => context.globalState.update('historyRecoveryShown', true), error => output.appendLine(error.message));
  }
  const language = activateLanguage(vscode, context, async () => {
    tree.title = t('view.open');
    historyTree.title = t('view.history');
    await titles.localizeDrafts();
    history.updateDescription();
    refresh();
    await updates.check();
  });
  language.ready.catch(error => output.appendLine(errorText(error)));
  return { listSessions: () => provider.list(), openSession, newSession, show, view: tree, provider, history, historyView: historyTree, titles, updates, language };
}

module.exports = { activate };
