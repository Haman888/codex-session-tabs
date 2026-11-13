'use strict';

// Loaded by explicit, reversible hooks in the installed Codex editor.
// Pass only panel identity and title controls, never prompts or credentials.
const vscode = require('vscode');
const { randomUUID } = require('node:crypto');
const entries = new WeakMap();
const controllers = new WeakMap();
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function bridgeError(key, fallback) {
  return Object.assign(new Error(fallback), { sessionTabsKey: key });
}

const natural = value => Number.isSafeInteger(value) && value >= 0;
function sanitizeRateLimits(value) {
  const buckets = new Map();
  const add = (id, input) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(id)) return;
    const bucket = { id };
    for (const key of ['primary', 'secondary']) {
      const window = input?.[key];
      if (!natural(window?.usedPercent) || window.usedPercent > 100) continue;
      bucket[key] = { usedPercent: window.usedPercent };
      if (natural(window.windowDurationMins) && window.windowDurationMins > 0) bucket[key].windowDurationMins = window.windowDurationMins;
      if (natural(window.resetsAt) && window.resetsAt <= 8640000000000) bucket[key].resetsAt = window.resetsAt;
    }
    if (bucket.primary || bucket.secondary) buckets.set(id, bucket);
  };
  if (value?.rateLimits) add(value.rateLimits.limitId || 'codex', value.rateLimits);
  for (const [id, input] of Object.entries(value?.rateLimitsByLimitId || {}).slice(0, 32)) add(id, input);
  return { buckets: [...buckets.values()] };
}

function freshPanelUri(uri) {
  // A native New Chat action must never reuse the resource of an older draft.
  // Restoring an already open resource still uses its original URI unchanged.
  return uri.path === '/extension/panel/new'
    ? uri.with({ query: `sessionTab=${randomUUID()}` }) : uri;
}

async function openFreshPanel(owner, webview, replaceCurrentEditor = false) {
  let result;
  try { result = await vscode.commands.executeCommand('codexSessionTabs.nativeNewPanel'); }
  catch { return false; } // Companion removed: retain the native fallback.
  if (!result?.handled) return false;
  if (result.opened && replaceCurrentEditor && webview) {
    const previous = owner.findPanelByWebview(webview);
    if (previous && owner.isPanelAlive(previous)) previous.dispose();
  }
  return true;
}

function controller(owner) {
  let value = controllers.get(owner);
  if (value) return value;
  const connection = owner.codexMcpConnection;
  const provider = `SessionTabsTitles-${randomUUID()}`;
  const pending = new Map();
  const subscription = connection.registerProvider(provider, {
    onNotification(notification) {
      const method = notification.method;
      const params = notification.params || {};
      const send = (name, data) => vscode.commands.executeCommand(name, data).then(undefined, () => {});
      if (method === 'account/rateLimits/updated') {
        send('codexSessionTabs.nativeRateLimits', sanitizeRateLimits(params));
        return;
      }
      if (method === 'account/updated') {
        send('codexSessionTabs.nativeUsageReset');
        return;
      }
      const phase = ['turn/started', 'codex/event/task_started'].includes(method) ? 'started'
        : ['turn/completed', 'codex/event/task_complete'].includes(method) ? 'completed' : undefined;
      if (!phase) return;
      const id = params.threadId || params.conversationId;
      if (!UUID.test(id || '')) return;
      vscode.commands.executeCommand('codexSessionTabs.nativeActivity', {
        id, phase, turnId: params.turn?.id || params.turnId || params.id,
      }).then(undefined, () => {});
    },
    onResult(response) {
      const waiting = pending.get(String(response.id));
      if (!waiting) return;
      pending.delete(String(response.id));
      clearTimeout(waiting.timer);
      if (response.error) waiting.reject(response.error.message ? new Error(response.error.message)
        : bridgeError(waiting.errorKey, 'Codex request failed.'));
      else waiting.resolve(response.result);
    },
  });
  owner.subscriptions.push(subscription, { dispose() {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(bridgeError('error.editorStopped', 'The Codex editor has stopped.'));
    }
    pending.clear();
  } });
  const request = (method, params, errorKey, timeoutKey) => new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(bridgeError(timeoutKey, 'Codex did not respond.'));
        }, 15000);
        pending.set(requestId, { resolve, reject, timer, errorKey });
        try { connection.sendRequest(provider, requestId, method, params); }
        catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error); }
      });
  value = {
    rename(id, name) {
      if (!UUID.test(id)) return Promise.reject(bridgeError('error.invalidId', 'Invalid conversation identifier.'));
      return request('thread/name/set', { threadId: id, name }, 'error.renameFailed', 'error.renameTimeout');
    },
    async readRateLimits() {
      return sanitizeRateLimits(await request('account/rateLimits/read', {}, 'usage.unavailable', 'usage.unavailable'));
    },
  };
  controllers.set(owner, value);
  return value;
}

async function attach(owner, panel, uri, initialId) {
  const key = uri.toString();
  const entry = { key, id: initialId, panel, disposed: false, rendererReady: false, subscriptions: [] };
  const webview = panel.webview;
  const originalIcon = panel.iconPath;
  controller(owner);
  entries.set(webview, entry);
  panel.onDidDispose(() => {
    entry.disposed = true;
    for (const subscription of entry.subscriptions) subscription.dispose();
    entries.delete(webview);
    vscode.commands.executeCommand('codexSessionTabs.nativeClosed', key).then(undefined, () => {});
  });
  try {
    const restored = await vscode.commands.executeCommand('codexSessionTabs.nativePanel', {
      key, id: initialId,
      setTitle(title) { if (!entry.disposed) panel.title = title; },
      getTitle() { return entry.disposed ? '' : panel.title; },
      getIcon() { return entry.disposed ? undefined : panel.iconPath; },
      isReady() { return !entry.disposed && entry.rendererReady && owner.editorPanels.get(panel)?.ready === true; },
      isVisible() { return !entry.disposed && panel.visible !== false && vscode.window.state?.focused !== false; },
      setUnread(unread, icons) { if (!entry.disposed) panel.iconPath = unread ? icons : originalIcon; },
      rename(id, name) { return controller(owner).rename(id, name); },
      readRateLimits() { return controller(owner).readRateLimits(); },
    });
    if (restored?.id && UUID.test(restored.id)) {
      entry.id = restored.id;
      // New-panel resources keep their own stable URI. Restore their actual
      // conversation before initializing the webview instead of a blank composer.
      if (!initialId) {
        const state = owner.editorPanels.get(panel);
        if (state) state.initialRoute = `/local/${restored.id}`;
      }
    }
  } catch {
    // Removing the companion extension leaves the original Codex editor usable.
  }
}

function startupPhase(_owner, webview, phase) {
  const entry = entries.get(webview);
  if (entry && phase === 'renderer_ready') entry.rendererReady = true;
}

function initializePanel(owner, panel, initialize) {
  const entry = entries.get(panel.webview);
  if (!entry || panel.visible !== false) return initialize();
  // VS Code restores inactive editors without mounting their renderer. Finish
  // resolving the editor now, but create its HTML only when it is revealed.
  let started = false;
  const listener = panel.onDidChangeViewState(() => {
    if (started || entry.disposed || !panel.visible) return;
    started = true;
    listener.dispose();
    Promise.resolve().then(initialize).catch(error => {
      owner.logger?.error('Deferred Codex panel initialization failed', { safe: {}, sensitive: { error } });
    });
  });
  entry.subscriptions.push(listener);
}

function watchPanelStartup(webview, watchdog) {
  const entry = entries.get(webview);
  if (!entry) return watchdog.start();
  const update = () => {
    if (entry.disposed) return;
    if (entry.panel.visible !== false && vscode.window.state?.focused !== false) watchdog.start();
    else if (watchdog.timeout != null) {
      clearTimeout(watchdog.timeout);
      watchdog.timeout = undefined;
    }
  };
  entry.subscriptions.push(entry.panel.onDidChangeViewState(update), { dispose: () => watchdog.dispose() });
  if (vscode.window.onDidChangeWindowState) entry.subscriptions.push(vscode.window.onDidChangeWindowState(update));
  update();
}

function observe(_owner, webview, message) {
  if (message.type !== 'mcp-request') return;
  const request = message.request;
  // A user turn identifies its own panel unambiguously. History reads and
  // background prewarming must never relabel an unrelated conversation.
  if (!['turn/start', 'turn/steer', 'turn/addUserMessage'].includes(request?.method)) return;
  const id = request.params?.threadId;
  const entry = entries.get(webview);
  if (!entry || !UUID.test(id || '') || entry.id === id) return;
  entry.id = id;
  vscode.commands.executeCommand('codexSessionTabs.nativeBind', { key: entry.key, id }).then(undefined, () => {});
}

module.exports = { attach, observe, freshPanelUri, openFreshPanel, startupPhase, initializePanel, watchPanelStartup, sanitizeRateLimits };
