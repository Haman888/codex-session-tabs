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

    // Use valid UUIDs
    const sessionId = '12345678-1234-1234-1234-123456789012';
    const turn1 = 'aaaaaaaa-1111-1111-1111-111111111111';
    const turn2 = 'bbbbbbbb-2222-2222-2222-222222222222';
    const turn3 = 'cccccccc-3333-3333-3333-333333333333';

    // Three sequential turns
    titles.activity({ id: sessionId, phase: 'started', turnId: turn1 });
    titles.activity({ id: sessionId, phase: 'completed', turnId: turn1 });
    titles.activity({ id: sessionId, phase: 'started', turnId: turn2 });
    titles.activity({ id: sessionId, phase: 'completed', turnId: turn2 });
    titles.activity({ id: sessionId, phase: 'started', turnId: turn3 });
    titles.activity({ id: sessionId, phase: 'completed', turnId: turn3 });

    const state = titles.turns.get(sessionId);
    assert.equal(state.phase, 'completed', 'should be completed');
    assert.equal(state.turnId, turn3, 'should track latest turn');
    assert.ok(state.retired.includes(turn1), 'turn-1 should be retired');
    assert.ok(state.retired.includes(turn2), 'turn-2 should be retired');

    // Late event from turn-1 should be ignored
    titles.activity({ id: sessionId, phase: 'completed', turnId: turn1 });

    const afterLate = titles.turns.get(sessionId);
    assert.equal(afterLate.turnId, turn3, 'late event should not change current turn');
  });
});
