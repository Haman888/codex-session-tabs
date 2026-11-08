const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

describe('0.4.7 fixes', () => {
  it('U3: empty or malformed operation.lock is handled gracefully', async () => {
    const { UpdateManager } = require('../update-core.js');
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'cst-047-'));
    await fs.mkdir(storage, { recursive: true });
    const lockFile = path.join(storage, 'operation.lock');

    // Empty lock
    await fs.writeFile(lockFile, '');
    const manager = new UpdateManager({ storage, helper: '/tmp', profiles: [], verifyCandidate: async () => {} });
    const err1 = await manager.locked(async () => 'ok').catch(e => e);
    assert.match(err1.message, /lock.*verified/i, 'empty lock should be reported as unverified');

    // Malformed JSON
    await fs.writeFile(lockFile, '{invalid');
    const err2 = await manager.locked(async () => 'ok').catch(e => e);
    assert.match(err2.message, /lock.*verified/i, 'malformed lock should be reported as unverified');

    // Valid but stale lock (fake pid that doesn't exist)
    await fs.writeFile(lockFile, JSON.stringify({ pid: 999999, nonce: 'x' }));
    const result = await manager.locked(async () => 'ok');
    assert.equal(result, 'ok', 'stale lock should be removed and operation should succeed');

    await fs.rm(storage, { recursive: true, force: true });
  });

  it('C2: custom title matching history is removed to let future renames through', async () => {
    const { Titles } = require('../titles.js');
    const output = { appendLine() {} };
    const context = {
      globalState: {
        get(key, fallback) {
          const data = {
            tabIdentities: {},
            customTitles: { 'session-1': 'Old Custom Name' },
            draftTitles: {},
            unreadSessions: []
          };
          return data[key] ?? fallback;
        },
        async update() {}
      },
      subscriptions: []
    };

    // First sync: history has different name, custom stays
    const loadSessions1 = async () => [{ id: 'session-1', title: 'History Name', updatedAt: Date.now() }];
    const titles1 = new Titles(context, output, loadSessions1);
    await titles1.refresh();
    assert.equal(titles1.custom.get('session-1'), 'Old Custom Name', 'custom title should stay when it differs from history');

    // Second sync: history now matches custom, custom removed
    const loadSessions2 = async () => [{ id: 'session-1', title: 'Old Custom Name', updatedAt: Date.now() }];
    const titles2 = new Titles(context, output, loadSessions2);
    await titles2.refresh();
    assert.equal(titles2.custom.has('session-1'), false, 'custom title matching history should be removed');
  });

  it('C5: unreadSessions is capped at 500 entries', async () => {
    const { Titles } = require('../titles.js');
    const output = { appendLine() {} };
    const saved = new Map();
    const context = {
      globalState: {
        get(key, fallback) {
          if (key === 'unreadSessions') return [];
          return saved.get(key) ?? fallback ?? {};
        },
        async update(key, value) { saved.set(key, value); }
      },
      subscriptions: []
    };

    const loadSessions = async () => {
      const sessions = [];
      for (let i = 0; i < 600; i++) {
        sessions.push({ id: `session-${i}`, title: `Session ${i}`, updatedAt: Date.now() });
      }
      return sessions;
    };

    const titles = new Titles(context, output, loadSessions);
    await titles.refresh();

    // Mark 600 sessions as unread
    for (let i = 0; i < 600; i++) {
      titles.markAsRead(`session-${i}`);
    }

    assert.equal(titles.unread.size, 500, 'unread should be capped at 500');
    assert.equal(titles.unread.has('session-0'), false, 'oldest unread should be dropped');
    assert.equal(titles.unread.has('session-599'), true, 'newest unread should be kept');
  });
});
