'use strict';

const { t, errorText, draftNumber } = require('./i18n');

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function cleanTitle(value) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120); }

function compactTitle(value) {
  const title = cleanTitle(value);
  if (title.length <= 36 && title.split(' ').length <= 5) return title;
  const words = title.split(' ');
  let result = '';
  for (const word of words.slice(0, 5)) {
    const next = result ? `${result} ${word}` : word;
    if (next.length > 35) break;
    result = next;
  }
  return `${result || title.slice(0, 35)}…`;
}

function snapshot(map) { return new Map([...map].map(([key, value]) => [key, JSON.stringify(value)])); }
function asMap(set) { return new Map([...set].map(id => [id, true])); }

function sameIcon(actual, expected) {
  if (actual === expected) return true;
  return Boolean(actual?.light && actual?.dark && expected?.light && expected?.dark
    && actual.light.toString() === expected.light.toString()
    && actual.dark.toString() === expected.dark.toString());
}

// A transient active tab during restoration is not proof that its reply was read.
// The caller supplies only fully mounted, visible tabs in the focused window.
function createReadTracker(current, acknowledge, { delay = 1000, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let pending;
  let disposed = false;
  const same = (a, b) => a.id === b.id && a.key === b.key && a.binding === b.binding && a.turn === b.turn;
  const stop = () => {
    if (pending) cancel(pending.timer);
    pending = undefined;
  };
  const update = () => {
    if (disposed) return;
    const candidate = current();
    if (!candidate?.id) { stop(); return; }
    if (pending && same(pending.candidate, candidate)) return;
    stop();
    const waiting = { candidate };
    pending = waiting;
    waiting.timer = schedule(() => {
      if (pending !== waiting || disposed) return;
      pending = undefined;
      const latest = current();
      if (latest && same(candidate, latest)) acknowledge(latest.id);
      else update();
    }, delay);
  };
  return { update, dispose() { disposed = true; stop(); } };
}

class Titles {
  constructor(context, loadSessions, changed, output, options = {}) {
    this.context = context;
    this.loadSessions = loadSessions;
    this.changed = changed;
    this.output = output;
    this.bindings = new Map();
    this.identities = new Map(Object.entries(context.globalState.get('tabIdentities', {})));
    this.custom = new Map(Object.entries(context.globalState.get('customTitles', {})));
    this.drafts = new Map(Object.entries(context.globalState.get('draftTitles', {})));
    this.metadata = new Map();
    // Number drafts within this window activation, never across restarts.
    this.counter = 0;
    this.options = options;
    this.unread = new Set(context.globalState.get('unreadSessions', []));
    this.saved = { tabIdentities: snapshot(this.identities), customTitles: snapshot(this.custom),
      draftTitles: snapshot(this.drafts), unreadSessions: snapshot(asMap(this.unread)) };
    this.turns = new Map();
    this.persistence = Promise.resolve();
    this.localizeDrafts();
  }
  idFor(key) { return this.bindings.get(key)?.id || this.identities.get(key); }
  titleFor(id, fallback) { return this.custom.get(id) || compactTitle(this.metadata.get(id)?.title || fallback); }
  fullTitleFor(id, fallback) { return this.custom.get(id) || cleanTitle(this.metadata.get(id)?.title || fallback); }
  draftFor(key) {
    let draft = this.drafts.get(key);
    if (draft?.custom) return draft.title;
    const occupied = new Set();
    // VS Code already knows the restored tabs even when their hidden native
    // editors have not attached. Closed resources in draftTitles reserve nothing.
    for (const row of [...this.bindings.values(), ...(this.options.openTabs?.() || [])]) {
      if (row.key === key) continue;
      for (const title of [row.title, row.getTitle?.(), row.lastTitle, row.placeholder, this.drafts.get(row.key)?.title]) {
        if (title) occupied.add(title);
      }
    }
    if (!draft || occupied.has(draft.title)) {
      let title;
      const occupiedNumbers = new Set([...occupied].map(draftNumber).filter(Number.isSafeInteger));
      do { title = t('draft.numbered', { number: ++this.counter }); }
      while (occupied.has(title) || occupiedNumbers.has(this.counter));
      draft = { title, custom: false };
      this.drafts.set(key, draft);
      this.persist();
    }
    return draft.title;
  }
  localizeDrafts() {
    let changed = false;
    for (const draft of this.drafts.values()) {
      const number = !draft.custom && draftNumber(draft.title);
      if (!number) continue;
      const title = t('draft.numbered', { number });
      if (draft.title !== title) { draft.title = title; changed = true; }
    }
    const activeKeys = new Set([...this.bindings.keys(), ...(this.options.openTabs?.() || []).map(row => row.key)]);
    for (const key of activeKeys) {
      if (this.drafts.has(key) && !this.drafts.get(key).custom) this.draftFor(key);
    }
    if (changed) this.persist();
    this.applyUI();
    return this.persistence;
  }
  persist() {
    this.persistence = this.persistence.then(async () => {
      // Preserve recently closed resources too, for VS Code's Reopen Closed Tab.
      while (this.identities.size > 500) this.identities.delete(this.identities.keys().next().value);
      while (this.drafts.size > 500) this.drafts.delete(this.drafts.keys().next().value);
      for (const [name, local] of [['tabIdentities', this.identities], ['customTitles', this.custom],
        ['draftTitles', this.drafts], ['unreadSessions', asMap(this.unread)]]) await this.save(name, local);
    }).catch(error => this.output.appendLine(t('log.saveTitles', { message: errorText(error) })));
    return this.persistence;
  }
  async save(name, local) {
    const stored = this.context.globalState.get(name);
    const result = name === 'unreadSessions'
      ? Object.fromEntries((Array.isArray(stored) ? stored : []).map(id => [id, true]))
      : { ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}) };
    const before = this.saved[name], now = snapshot(local);
    for (const [key, value] of now) if (before.get(key) !== value) result[key] = JSON.parse(value);
    for (const key of before.keys()) if (!now.has(key)) delete result[key];
    await this.context.globalState.update(name, name === 'unreadSessions' ? Object.keys(result) : result);
    this.saved[name] = now;
  }
  async attach(binding) {
    if (this.options.iconsReady) await this.options.iconsReady;
    const id = UUID.test(binding.id || '') ? binding.id : this.identities.get(binding.key);
    this.bindings.set(binding.key, { ...binding, id });
    if (id) this.identities.set(binding.key, id);
    else this.draftFor(binding.key);
    this.applyUI();
    this.sync().catch(error => this.output.appendLine(errorText(error)));
    return { id };
  }
  isUnread(id) { return this.unread.has(id); }
  isRunning(id) { return this.turns.get(id)?.phase === 'started'; }
  activity({ id, phase, turnId }) {
    if (!UUID.test(id || '')) return;
    const previous = this.turns.get(id);
    const retired = previous?.retired || [];
    if (turnId && retired.includes(turnId)) return;
    const nextState = () => {
      // An ID-less duplicate must not erase the known active turn identity.
      const current = turnId || (previous?.phase === 'started' ? previous.turnId : undefined);
      const older = previous?.turnId && current && previous.turnId !== current
        ? [...retired, previous.turnId].slice(-32) : retired;
      return { phase, turnId: current, retired: older };
    };
    if (phase === 'started') {
      if (turnId && previous?.phase === 'completed' && previous.turnId === turnId) return;
      this.turns.set(id, nextState());
      this.changed();
      return;
    }
    if (phase !== 'completed') return;
    if (previous?.phase === 'started' && previous.turnId && turnId && previous.turnId !== turnId) return;
    if (previous?.phase === 'completed' && (!turnId || previous.turnId === turnId)) return;
    this.turns.set(id, nextState());
    if (this.options.isActive?.(id)) this.unread.delete(id);
    else this.unread.add(id);
    // Cap unread sessions at 500 to prevent unbounded growth
    if (this.unread.size > 500) {
      const oldest = [...this.unread].slice(0, this.unread.size - 500);
      for (const id of oldest) this.unread.delete(id);
    }
    this.persist();
    this.applyUI();
    this.changed();
  }
  acknowledge(id) {
    if (!this.unread.delete(id)) return;
    this.persist();
    this.applyUI();
    this.changed();
  }
  detach(key) { this.bindings.delete(key); this.changed(); }
  async bind(key, id) {
    if (!UUID.test(id || '')) throw new Error(t('error.invalidId'));
    const binding = this.bindings.get(key);
    if (!binding) return;
    binding.id = id;
    this.identities.set(key, id);
    const draft = this.drafts.get(key);
    binding.placeholder = draft?.title || binding.lastTitle || t('draft.fallback');
    if (draft?.custom) {
      this.custom.set(id, draft.title);
      try { await binding.rename(id, draft.title); }
      catch (error) { this.output.appendLine(t('log.renameLocal', { message: errorText(error) })); }
    }
    this.drafts.delete(key);
    await this.persist();
    await this.sync();
  }
  async rename(row, name) {
    name = cleanTitle(typeof name === 'string' ? name : '');
    if (!name) throw new Error(t('error.nameEmpty'));
    const binding = this.bindings.get(row.key);
    const id = row.id || binding?.id || this.identities.get(row.key);
    if (!binding) throw new Error(t('error.adapterInactive'));
    if (id) {
      // Use Codex's own API: never edit its SQLite database directly.
      await binding.rename(id, name);
      this.custom.set(id, name);
    } else this.drafts.set(row.key, { title: name, custom: true });
    await this.persist();
    await this.sync();
    return name;
  }
  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.performSync();
    try { await this.syncing; }
    finally { this.syncing = undefined; }
  }
  async performSync() {
    try {
      this.metadata = new Map((await this.loadSessions()).map(row => [row.id, row]));
      this.lastSyncError = undefined;
      this.historyRead = true;
      // Remove custom titles that now match history to let future renames through
      for (const [id, custom] of this.custom) {
        if (this.metadata.get(id)?.title === custom) this.custom.delete(id);
      }
    } catch (error) {
      if (this.lastSyncError !== error.message) this.output.appendLine(t('log.titleRefresh', { message: errorText(error) }));
      this.lastSyncError = error.message;
    }
    this.applyUI();
  }
  applyUI() {
    let changed = false;
    for (const binding of this.bindings.values()) {
      const unread = this.unread.has(binding.id);
      const repaint = unread && binding.getIcon && !sameIcon(binding.getIcon(), this.options.icons);
      if (binding.setUnread && (binding.lastUnread !== unread || repaint) && (!unread || this.options.icons)) {
        binding.lastUnread = unread;
        binding.setUnread(unread, this.options.icons);
        changed = true;
      }
      // Until history is read once, a saved conversation keeps its label instead of a generic one.
      if (binding.id && !this.historyRead && !this.custom.has(binding.id)) continue;
      const fallback = this.drafts.get(binding.key)?.title || binding.placeholder || t(binding.id ? 'chat.fallback' : 'draft.fallback');
      const title = cleanTitle(binding.id ? this.titleFor(binding.id, fallback) : fallback);
      if (!title || (binding.getTitle ? binding.getTitle() === title : binding.lastTitle === title)) continue;
      binding.lastTitle = title;
      try { binding.setTitle(title); changed = true; }
      catch (error) { this.output.appendLine(t('log.tabClosed', { message: errorText(error) })); }
    }
    if (changed) this.changed();
  }
}

module.exports = { Titles, cleanTitle, compactTitle, createReadTracker };
