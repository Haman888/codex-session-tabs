const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('0.4.9 fixes', () => {
  it('L3: draftTitles is capped at 500 entries', async () => {
    const { Titles } = require('../titles.js');
    const context = {
      globalState: {
        get: (key, fallback) => {
          const data = { tabIdentities: {}, customTitles: {}, draftTitles: {}, unreadSessions: [] };
          return data[key] ?? fallback;
        },
        async update() {}
      },
      subscriptions: []
    };
    const titles = new Titles(context, async () => [], () => {}, { appendLine() {} });
    titles.applyUI = () => {};

    // Add 600 drafts
    for (let i = 0; i < 600; i++) {
      titles.drafts.set(`key-${i}`, { title: `Draft ${i}`, custom: false });
    }

    await titles.persist();

    assert.equal(titles.drafts.size, 500, 'drafts should be capped at 500');
    assert.equal(titles.drafts.has('key-0'), false, 'oldest draft should be removed');
    assert.equal(titles.drafts.has('key-599'), true, 'newest draft should be kept');
  });

  it('L2: retired turns prevent duplicate events from old turns', async () => {
    const { Titles } = require('../titles.js');
    const context = {
      globalState: {
        get: (key, fallback) => {
          const data = { tabIdentities: {}, customTitles: {}, draftTitles: {}, unreadSessions: [] };
          return data[key] ?? fallback;
        },
        async update() {}
      },
      subscriptions: []
    };
    const titles = new Titles(context, async () => [], () => {}, { appendLine() {} });
    titles.applyUI = () => {};
    titles.persist = () => {};

    // Three sequential turns
    titles.activity({ id: 'session-1', phase: 'started', turnId: 'turn-1' });
    titles.activity({ id: 'session-1', phase: 'completed', turnId: 'turn-1' });
    titles.activity({ id: 'session-1', phase: 'started', turnId: 'turn-2' });
    titles.activity({ id: 'session-1', phase: 'completed', turnId: 'turn-2' });
    titles.activity({ id: 'session-1', phase: 'started', turnId: 'turn-3' });
    titles.activity({ id: 'session-1', phase: 'completed', turnId: 'turn-3' });

    const state = titles.turns.get('session-1');
    assert.equal(state.phase, 'completed', 'should be completed');
    assert.equal(state.turnId, 'turn-3', 'should track latest turn');
    assert.ok(state.retired.includes('turn-1'), 'turn-1 should be retired');
    assert.ok(state.retired.includes('turn-2'), 'turn-2 should be retired');

    // Late event from turn-1 should be ignored
    titles.activity({ id: 'session-1', phase: 'completed', turnId: 'turn-1' });

    const afterLate = titles.turns.get('session-1');
    assert.equal(afterLate.turnId, 'turn-3', 'late event should not change current turn');
  });
});
