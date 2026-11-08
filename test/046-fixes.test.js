const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

describe('0.4.6 fixes', () => {
  it('S2: historyRead stays false when first sync fails', async () => {
    const Titles = require('../titles.js');
    const output = { appendLine() {} };
    const context = {
      globalState: {
        get(key, fallback) {
          const data = { tabIdentities: {}, customTitles: {}, draftTitles: {}, unreadSessions: [] };
          return data[key] ?? fallback;
        },
        async update() {}
      },
      subscriptions: []
    };
    const loadSessions = async () => { throw new Error('Database locked'); };
    const titles = new Titles(context, output, loadSessions);
    await titles.refresh();
    assert.equal(titles.historyRead, false, 'historyRead should stay false after first sync failure');
  });

  it('C3: large history query is capped at 5000 rows and 300 chars per title', async () => {
    const { readSessions } = require('../sessions.js');
    const run = async (db, sql) => {
      assert.match(sql, /LIMIT\s+5000/, 'query must include LIMIT 5000');
      assert.match(sql, /substr\([^,]+,\s*1,\s*300\)/, 'query must cap title at 300 chars');
      return [];
    };
    await readSessions({ run });
  });

  it('U1: without saved recovery, update notice shows checkUpdate not restore', async () => {
    const vscode = {
      ExtensionMode: { Production: 1 },
      window: {
        showWarningMessage: async (msg, ...actions) => {
          assert.match(msg, /outdated|newer|available/i, 'message should mention update available');
          assert.ok(!msg.includes('Restore'), 'message should not offer restore without saved package');
          assert.equal(actions[0], 'Check and update', 'action should be Check and update');
          return null;
        }
      },
      commands: { registerCommand() {} },
      Uri: { file: p => ({ fsPath: p }) }
    };
    const context = {
      extensionMode: vscode.ExtensionMode.Production,
      subscriptions: [],
      globalState: { get: () => undefined, update: async () => {} },
      storageUri: vscode.Uri.file('/tmp/test-storage')
    };
    const output = { appendLine() {} };
    const isBusy = () => false;

    // Stub translations
    const origRequire = require('../ui-language.js');
    const t = key => {
      const map = {
        'update.canRestore': 'Codex is outdated: {message}',
        'action.restoreCodex': 'Restore Codex',
        'action.checkUpdate': 'Check and update'
      };
      return map[key] || key;
    };
    require.cache[require.resolve('../ui-language.js')] = { exports: { t } };

    const { activateUpdates } = require('../update-ui.js');
    const manager = {
      async recovery({ checkFile }) {
        if (checkFile === false) return null;
        return null;
      }
    };

    // Trigger the notice by simulating manager state change
    const emitter = new EventEmitter();
    manager.on = emitter.on.bind(emitter);
    activateUpdates(context, output, isBusy);

    // Simulate update available without saved recovery
    emitter.emit('change', { status: 'outdated', message: 'Newer version available' });

    require.cache[require.resolve('../ui-language.js')] = origRequire;
  });
});
