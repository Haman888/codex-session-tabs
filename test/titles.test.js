'use strict';
require('../i18n').setLanguage('ru');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Titles, compactTitle } = require('../titles');
const ID = '00000000-0000-0000-0000-000000000001';

test('automatic tab labels are short while explicit manual names are preserved', async () => {
  assert.equal(compactTitle('Вкладки VS Code'), 'Вкладки VS Code');
  const shortened = compactTitle('Очень длинное автоматически сформированное название разговора с большим количеством слов');
  assert.ok(shortened.length <= 36);
  assert.ok(shortened.split(' ').length <= 5);
  assert.ok(shortened.endsWith('…'));
});

function fixture() {
  const saved = new Map();
  const context = { globalState: {
    get: (key, fallback) => saved.has(key) ? saved.get(key) : fallback,
    update: async (key, value) => { saved.set(key, value); },
  } };
  let rows = [];
  let active = false;
  const renames = [];
  const native = key => {
    const state = { title: 'Codex', unread: false };
    return { state, binding: {
      key, getTitle: () => state.title, setTitle: title => { state.title = title; },
      setUnread: unread => { state.unread = unread; },
      rename: async (id, name) => { renames.push({ id, name }); },
    } };
  };
  const make = (options = {}) => new Titles(context, async () => rows, () => {}, { appendLine() {} }, { isActive: () => active, icons: {}, ...options });
  return { saved, native, renames, make, setRows: value => { rows = value; }, setActive: value => { active = value; } };
}

test('distinct draft titles become Codex-generated names and keep identity after restart', async () => {
  const f = fixture();
  const titles = f.make();
  const first = f.native('new?1');
  const second = f.native('new?2');
  await titles.attach(first.binding);
  await titles.attach(second.binding);
  assert.equal(first.state.title, 'Новый диалог 1');
  assert.equal(second.state.title, 'Новый диалог 2');
  await titles.bind('new?1', ID);
  assert.equal(first.state.title, 'Новый диалог 1', 'Keep a distinct draft label until the generated title arrives');
  f.setRows([{ id: ID, title: 'Подготовить план переноса' }]);
  await titles.sync();
  assert.equal(first.state.title, 'Подготовить план переноса');
  assert.deepEqual(f.renames, [], 'Automatic labels do not request another model or rename the conversation');
  first.state.title = 'Codex';
  await titles.sync();
  assert.equal(first.state.title, 'Подготовить план переноса', 'Repairs stale native editor labels');
  await titles.persistence;
  const restored = f.make();
  const restoredPanel = f.native('new?1');
  assert.deepEqual(await restored.attach(restoredPanel.binding), { id: ID });
  assert.equal(restoredPanel.state.title, 'Подготовить план переноса');
});

test('manual draft and saved names persist and override later automatic titles', async () => {
  const f = fixture();
  const titles = f.make();
  const panel = f.native('new?1');
  await titles.attach(panel.binding);
  await titles.rename({ key: 'new?1' }, '  Мой   план  ');
  assert.equal(panel.state.title, 'Мой план');
  f.setRows([{ id: ID, title: 'Автоматическое название' }]);
  await titles.bind('new?1', ID);
  assert.equal(panel.state.title, 'Мой план');
  assert.deepEqual(f.renames, [{ id: ID, name: 'Мой план' }]);
  await titles.rename({ key: 'new?1', id: ID }, 'Новое имя');
  assert.equal(panel.state.title, 'Новое имя');
  const restored = f.make();
  const restoredPanel = f.native('new?1');
  await restored.attach(restoredPanel.binding);
  assert.equal(restoredPanel.state.title, 'Новое имя');
});

test('draft numbering restarts at one and ignores the old counter and closed drafts', async () => {
  const f = fixture();
  f.saved.set('draftCounter', 15);
  const before = f.make();
  const closed = f.native('closed');
  await before.attach(closed.binding);
  assert.equal(closed.state.title, 'Новый диалог 1');
  before.detach('closed');
  const second = f.native('also-closed');
  await before.attach(second.binding);
  assert.equal(second.state.title, 'Новый диалог 2', 'Numbering increases within one activation');
  await before.persistence;

  const after = f.make();
  const fresh = f.native('fresh');
  await after.attach(fresh.binding);
  assert.equal(fresh.state.title, 'Новый диалог 1', 'Closed resources kept for Reopen Closed Tab do not reserve numbers');
});

test('restored background drafts reserve numbers before their interfaces attach', async () => {
  const f = fixture();
  f.saved.set('draftCounter', 15);
  f.saved.set('draftTitles', {
    one: { title: 'Новый диалог 1', custom: false },
    three: { title: 'Новый диалог 3', custom: false },
    closed: { title: 'Новый диалог 2', custom: false },
  });
  const open = [{ key: 'one', title: 'Codex' }, { key: 'three', title: 'Codex' }];
  const titles = f.make({ openTabs: () => open });
  const fresh = f.native('fresh');
  await titles.attach(fresh.binding);
  assert.equal(fresh.state.title, 'Новый диалог 2');
  open.push({ key: 'fresh', title: fresh.state.title });
  const next = f.native('next');
  await titles.attach(next.binding);
  assert.equal(next.state.title, 'Новый диалог 4');
  const restored = f.native('one');
  await titles.attach(restored.binding);
  assert.equal(restored.state.title, 'Новый диалог 1', 'A restored draft keeps its own available name');
});

test('a high restored draft number does not advance the new counter', async () => {
  const f = fixture();
  f.saved.set('draftTitles', { old: { title: 'Новый диалог 15', custom: false } });
  const titles = f.make({ openTabs: () => [{ key: 'old', title: 'Новый диалог 15' }] });
  const fresh = f.native('fresh');
  await titles.attach(fresh.binding);
  assert.equal(fresh.state.title, 'Новый диалог 1');
});

test('reopening a closed draft avoids a reused label while manual names stay unchanged', async () => {
  const f = fixture();
  f.saved.set('draftTitles', {
    closed: { title: 'Новый диалог 1', custom: false },
    manual: { title: 'Мой план', custom: true },
  });
  const titles = f.make();
  const fresh = f.native('fresh');
  await titles.attach(fresh.binding);
  assert.equal(fresh.state.title, 'Новый диалог 1');
  const reopened = f.native('closed');
  await titles.attach(reopened.binding);
  assert.equal(reopened.state.title, 'Новый диалог 2');
  const manual = f.native('manual');
  await titles.attach(manual.binding);
  assert.equal(manual.state.title, 'Мой план');
  await titles.persistence;
  assert.equal(f.saved.get('draftTitles').closed.title, 'Новый диалог 2');
});

test('an open manually named or saved tab also reserves its numbered label', async () => {
  const f = fixture();
  const titles = f.make({ openTabs: () => [{ key: 'saved', id: ID, title: 'Новый диалог 1' }] });
  const manual = f.native('manual');
  await titles.attach(manual.binding);
  await titles.rename({ key: 'manual' }, 'Новый диалог 2');
  const fresh = f.native('fresh');
  await titles.attach(fresh.binding);
  assert.equal(fresh.state.title, 'Новый диалог 3');
  assert.equal(manual.state.title, 'Новый диалог 2');
});

test('background completion gets a badge, reading clears it, duplicates stay cleared', async () => {
  const f = fixture();
  f.setRows([{ id: ID, title: 'План' }]);
  const titles = f.make();
  const panel = f.native('saved');
  await titles.attach({ ...panel.binding, id: ID });
  titles.activity({ id: ID, phase: 'started', turnId: 'turn1' });
  assert.equal(panel.state.unread, false);
  titles.activity({ id: ID, phase: 'completed', turnId: 'turn1' });
  assert.equal(panel.state.unread, true);
  titles.acknowledge(ID);
  assert.equal(panel.state.unread, false);
  titles.activity({ id: ID, phase: 'completed', turnId: 'turn1' });
  assert.equal(panel.state.unread, false);
  f.setActive(true);
  titles.activity({ id: ID, phase: 'started', turnId: 'turn2' });
  titles.activity({ id: ID, phase: 'completed', turnId: 'turn2' });
  assert.equal(panel.state.unread, false, 'The foreground session does not get an unread badge');
  f.setActive(false);
  titles.activity({ id: ID, phase: 'started', turnId: 'turn3' });
  titles.activity({ id: ID, phase: 'completed', turnId: 'turn3' });
  await titles.persistence;
  const restored = f.make();
  assert.equal(restored.isUnread(ID), true, 'Unread state survives a window restart');
});

test('stale turn events cannot finish newer work or re-badge an acknowledged answer', async () => {
  const f = fixture(), titles = f.make();
  const panel = f.native('saved');
  await titles.attach({ ...panel.binding, id: ID });
  titles.activity({ id: ID, phase: 'started', turnId: 'older' });
  titles.activity({ id: ID, phase: 'started', turnId: 'current' });
  titles.activity({ id: ID, phase: 'completed', turnId: 'older' });
  titles.activity({ id: ID, phase: 'completed', turnId: 'unrelated' });
  assert.equal(titles.turns.get(ID).phase, 'started', 'Busy guard still sees the current response');
  assert.equal(panel.state.unread, false);
  titles.activity({ id: ID, phase: 'started' });
  assert.equal(titles.turns.get(ID).turnId, 'current', 'ID-less duplicate start preserves correlation');
  titles.activity({ id: ID, phase: 'completed', turnId: 'current' });
  assert.equal(panel.state.unread, true);
  titles.acknowledge(ID);
  titles.activity({ id: ID, phase: 'started', turnId: 'older' });
  titles.activity({ id: ID, phase: 'completed', turnId: 'older' });
  titles.activity({ id: ID, phase: 'started', turnId: 'current' });
  assert.equal(titles.turns.get(ID).phase, 'completed');
  assert.equal(titles.turns.get(ID).turnId, 'current');
  assert.equal(panel.state.unread, false);
  await titles.persistence;
});

test('legacy ID-less activity and a completion first observed after restart still work', async () => {
  const titles = fixture().make();
  titles.activity({ id: ID, phase: 'started' });
  titles.activity({ id: ID, phase: 'completed' });
  assert.equal(titles.isUnread(ID), true);
  titles.acknowledge(ID);
  titles.activity({ id: ID, phase: 'completed' });
  assert.equal(titles.isUnread(ID), false);
  const restored = fixture().make();
  restored.activity({ id: ID, phase: 'completed', turnId: 'restored' });
  assert.equal(restored.isUnread(ID), true);
  await Promise.all([titles.persistence, restored.persistence]);
});
