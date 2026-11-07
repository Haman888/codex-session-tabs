'use strict';
require('../i18n').setLanguage('ru');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Titles } = require('../titles');

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';
const U = '00000000-0000-0000-0000-00000000000d';

function sharedStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  const context = () => ({ globalState: {
    get: (key, fallback) => values.has(key) ? JSON.parse(values.get(key)) : fallback,
    update: async (key, value) => { values.set(key, JSON.stringify(value)); },
  } });
  return { context, read: key => values.has(key) ? JSON.parse(values.get(key)) : undefined };
}

function window(storage, history = async () => []) {
  const titles = new Titles(storage.context(), history, () => {}, { appendLine() {} }, { icons: {} });
  const panel = (key, id) => {
    const state = { title: 'Codex' };
    return { state, binding: { key, id, getTitle: () => state.title, setTitle: value => { state.title = value; },
      setUnread() {}, rename: async () => {} } };
  };
  return { titles, panel, open: (key, id) => titles.attach(panel(key, id).binding) };
}

test('two windows keep each other\'s tabs, names, removals and read answers', async () => {
  const storage = sharedStorage({ unreadSessions: [U] });
  const first = window(storage), second = window(storage);
  await first.open('tab-a', A);
  await first.titles.persist();
  await second.open('tab-b', B);
  await second.open('draft-b');
  await second.titles.bind('draft-b', C);
  await second.titles.persistence;
  assert.deepEqual(storage.read('tabIdentities'), { 'tab-a': A, 'tab-b': B, 'draft-b': C },
    'The second window does not drop the tab of the first one');
  assert.equal(storage.read('draftTitles')['draft-b'], undefined, 'A draft removed in one window stays removed');
  await first.titles.rename({ key: 'tab-a', id: A }, 'Имя первого окна');
  first.titles.acknowledge(U);
  await first.titles.persistence;
  second.titles.activity({ id: B, phase: 'completed', turnId: 'turn-b' });
  await second.titles.persistence;
  assert.deepEqual(storage.read('customTitles'), { [A]: 'Имя первого окна' });
  assert.deepEqual(storage.read('unreadSessions'), [B], 'An answer read in one window does not come back as unread');
  const restarted = window(storage);
  assert.equal(restarted.titles.idFor('tab-a'), A);
  assert.equal(restarted.titles.idFor('tab-b'), B);
  assert.equal(restarted.titles.idFor('draft-b'), C);
});

test('a window still trims its own old tab links', async () => {
  const links = Object.fromEntries(Array.from({ length: 501 }, (_, n) => [`old-${n}`, A]));
  const storage = sharedStorage({ tabIdentities: links });
  const only = window(storage);
  await only.titles.persist();
  const saved = storage.read('tabIdentities');
  assert.equal(Object.keys(saved).length, 500);
  assert.equal(saved['old-0'], undefined, 'The oldest link is removed first');
});

test('a tab attaches before history is read and gets its name when history arrives', async () => {
  let release;
  const history = new Promise(resolve => { release = resolve; });
  const only = window(sharedStorage(), () => history);
  const tab = only.panel('tab', A), draft = only.panel('draft');
  const waiting = new Promise(resolve => setTimeout(resolve, 500, 'still waiting for history'));
  assert.deepEqual(await Promise.race([only.titles.attach(tab.binding), waiting]), { id: A });
  assert.equal(tab.state.title, 'Codex', 'Until history is read a saved conversation keeps its label, not a generic one');
  await only.titles.attach(draft.binding);
  assert.equal(draft.state.title, 'Новый диалог 1', 'A new chat needs no history for its label');
  release([{ id: A, title: 'План переноса' }]);
  await only.titles.syncing;
  assert.equal(tab.state.title, 'План переноса');
});
