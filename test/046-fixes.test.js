const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

describe('0.4.6 fixes', () => {
  it('S2: historyRead stays false when first sync fails', async () => {
    const { Titles } = require('../titles.js');
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
    const titles = new Titles(context, loadSessions, () => {}, output);
    titles.applyUI = () => {}; // stub UI to focus on historyRead logic
    await titles.sync();
    assert.equal(titles.historyRead, undefined, 'historyRead should not be set to true after first sync failure');
  });

  it('C3: large history query is capped at 5000 rows and 300 chars per title', async () => {
    // Test that readSessions produces a query with LIMIT 5000 and substr(..., 1, 300)
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const testHome = path.join('/tmp', `cst-test-${Math.random().toString(36).slice(2, 10)}`);
    const dbPath = path.join(testHome, 'state_12345.sqlite');

    let queriesSeen = [];
    const testRun = async (db, sql) => {
      queriesSeen.push(sql);
      if (sql.includes('PRAGMA')) {
        return [
          { name: 'id' }, { name: 'title' }, { name: 'cwd' },
          { name: 'source' }, { name: 'archived' }, { name: 'updated_at' }
        ];
      }
      return [];
    };

    try {
      await fs.mkdir(testHome, { recursive: true });
      await fs.writeFile(dbPath, '');  // state_*.sqlite so findDatabase succeeds
      await fs.writeFile(path.join(testHome, 'session_index.jsonl'), '');
      const { readSessions } = require('../sessions.js');
      await readSessions({ home: testHome, run: testRun });

      const selectQuery = queriesSeen.find(q => q.includes('SELECT') && q.includes('LIMIT'));
      assert.ok(selectQuery, `SELECT query with LIMIT should be present. Queries seen: ${queriesSeen.length}`);
      assert.match(selectQuery, /LIMIT\s+5000/, 'query must include LIMIT 5000');
      assert.match(selectQuery, /substr\(.+,\s*1,\s*300\)/, 'query must cap title at 300 chars');
    } finally {
      await fs.rm(testHome, { recursive: true, force: true });
    }
  });

  it('U1: without saved recovery, update notice shows checkUpdate not restore', async () => {
    // Mock vscode before requiring update-ui
    delete require.cache[require.resolve('../update-ui.js')];
    delete require.cache[require.resolve('../update-core.js')];

    const Module = require('node:module');
    const originalRequire = Module.prototype.require;
    const root = require('node:path').resolve(__dirname, '..');

    let intervals = [], warnings = 0;
    const vscode = {
      StatusBarAlignment: { Right: 2 }, ExtensionMode: { Production: 1 }, ProgressLocation: { Notification: 15 },
      env: { appRoot: '/synthetic/app', remoteName: undefined },
      window: {
        createStatusBarItem: () => ({ show() {}, dispose() {} }),
        showWarningMessage: async (msg, ...actions) => {
          warnings++;
          assert.equal(msg, 'adapter-missing');
          assert.ok(!msg.includes('Restore'), 'message should not offer restore without saved package');
          const buttons = actions.filter(a => typeof a === 'string');
          assert.equal(buttons[0], 'Check and update', 'action should be Check and update');
          return null;
        },
        showInformationMessage: async () => {},
        showErrorMessage: async () => {},
        withProgress: async () => ({ status: 'cancelled' }),
      },
      commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
      extensions: {
        getExtension: () => ({ extensionPath: '/synthetic/extensions/openai.chatgpt-26.1007.21434' }),
        onDidChange: () => ({ dispose() {} }),
      },
    };

    Module.prototype.require = function (id) {
      if (id === 'vscode') return vscode;
      if (id === './update-core' && this.filename && this.filename.endsWith('update-ui.js')) {
        const core = originalRequire.call(this, id);
        return {
          ...core,
          hostPlatform: () => 'darwin-x64',
          profileFor: (profiles, version) => core.profileFor(profiles, version, 'darwin-x64'),
          supportedProfile: profiles => core.supportedProfile(profiles, 'darwin-x64'),
          inspectInstalled: async () => ({ status: 'adapter-missing', version: '26.1007.21434', message: 'adapter-missing' }),
          UpdateManager: class {
            async loadProfiles() {}
            async recovery() { return undefined; }
            async run() { return { status: 'verified' }; }
            on() {}  // stub EventEmitter
          },
        };
      }
      return originalRequire.call(this, id);
    };

    // Stub setInterval to not block test exit
    const realSetInterval = global.setInterval;
    global.setInterval = (...args) => {
      const id = realSetInterval(...args);
      intervals.push(id);
      return id;
    };

    try {
      const { activateUpdates } = require('../update-ui.js');
      const context = {
        extensionPath: root, extensionMode: vscode.ExtensionMode.Production, subscriptions: [],
        globalStorageUri: { fsPath: '/synthetic/storage' },
        globalState: { get: () => undefined, update: async () => {} },
      };
      const output = { lines: [], appendLine(line) { this.lines.push(line); } };
      const api = activateUpdates(context, output, () => false);
      await api.check();
      assert.equal(warnings, 1);
    } finally {
      intervals.forEach(clearInterval);
      global.setInterval = realSetInterval;
      Module.prototype.require = originalRequire;
      delete require.cache[require.resolve('../update-ui.js')];
      delete require.cache[require.resolve('../update-core.js')];
    }
  });
});
