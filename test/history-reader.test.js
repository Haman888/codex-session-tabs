'use strict';
require('../i18n').setLanguage('ru');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { createSessionReader, createReadOnlyQuery } = require('../sessions');
const { Titles } = require('../titles');
const { makeTemp, externalTempParent } = require('./temp');

test('simultaneous history views share one read and apply folder filters to the cached metadata', async () => {
  let calls = 0, finish;
  const rows = [{ id: 'a', cwd: '/project' }, { id: 'b', cwd: '/other' }];
  const reader = createSessionReader({ load: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const all = reader.list();
  const project = reader.list({ scope: 'workspace', folders: ['/project'] });
  assert.equal(calls, 1);
  finish(rows);
  assert.deepEqual(await all, rows);
  assert.deepEqual(await project, [rows[0]]);
  await reader.list(); assert.equal(calls, 1);
});

test('repeated failed refreshes do not reopen the database until backoff or explicit retry', async () => {
  let clock = 0, calls = 0;
  const reader = createSessionReader({ now: () => clock, load: async () => { calls++; throw Error('private raw diagnostic'); } });
  for (let i = 0; i < 100; i++) await assert.rejects(reader.list(), /История Codex временно недоступна/);
  assert.equal(calls, 1);
  assert.equal(reader.status().retryAt, 30000);
  assert.ok(!reader.status().error.includes('private raw diagnostic'));
  clock = 30000; await assert.rejects(reader.list());
  assert.equal(calls, 2); assert.equal(reader.status().retryAt, 90000);
  reader.reset(); await assert.rejects(reader.list());
  assert.equal(calls, 3);
});

test('an outage retains the last successful history; manual retry clears stale state on recovery', async () => {
  let clock = 0, fail = false;
  const rows = [{ id: 'a', cwd: '/project', title: 'Existing conversation' }];
  const reader = createSessionReader({ now: () => clock, load: async () => { if (fail) throw Error('offline'); return [...rows]; } });
  await reader.list();
  fail = true; clock = 5000;
  assert.deepEqual(await reader.list(), rows);
  assert.equal(reader.status().stale, true);
  fail = false; rows.push({ id: 'b', cwd: '/project' });
  reader.reset();
  assert.equal((await reader.list()).length, 2);
  assert.equal(reader.status().error, undefined);
  assert.equal(reader.status().stale, false);
});

test('title refresh logs one error per outage and retains existing metadata', async () => {
  const messages = [];
  let fail = true;
  const titles = new Titles({ globalState: { get: (_key, fallback) => fallback } },
    async () => { if (fail) throw Error('same failure'); return [{ id: 'a', title: 'Existing' }]; },
    () => {}, { appendLine: message => messages.push(message) });
  for (let i = 0; i < 20; i++) await titles.sync();
  assert.equal(messages.length, 1);
  fail = false; await titles.sync();
  fail = true; await titles.sync();
  assert.equal(messages.length, 2);
  assert.equal(titles.metadata.get('a').title, 'Existing');
});

test('Python fallback reads an actual tiny database without writes and is reused after native access failure', async t => {
  const folder = await makeTemp('cst-history-');
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const database = path.join(folder, 'state_5.sqlite');
  execFileSync('/usr/bin/sqlite3', [database, 'CREATE TABLE threads(id TEXT);']);
  const before = await fs.readFile(database);
  let native = 0, python = 0;
  const query = createReadOnlyQuery({ execute: async (command, args, options) => {
    if (command === '/usr/bin/sqlite3') { native++; throw Object.assign(Error('cannot open'), { stderr: 'unable to open database file (14)' }); }
    python++; return execute(command, args, options);
  } });
  assert.equal((await query(database, 'PRAGMA table_info(threads)'))[0].name, 'id');
  assert.equal((await query(database, 'SELECT count(*) AS count FROM threads'))[0].count, 0);
  assert.equal(native, 1); assert.equal(python, 2);
  await assert.rejects(execute('python3', [path.resolve(__dirname, '../scripts/read_history.py'), database, "INSERT INTO threads VALUES ('must-not-write')"]));
  assert.deepEqual(await fs.readFile(database), before);
});

test('a busy database does not cause a second reader attempt; test temp paths inside the project are refused', async () => {
  const calls = [];
  const query = createReadOnlyQuery({ execute: async command => { calls.push(command); throw Error('database is locked'); } });
  await assert.rejects(query('/fixture/state.sqlite', 'SELECT 1'), /locked/);
  assert.deepEqual(calls, ['/usr/bin/sqlite3']);
  assert.throws(() => externalTempParent({ project: '/project', temporary: '/project/_tmp' }), /outside the project/);
  assert.equal(externalTempParent({ project: '/project', temporary: '/private/tmp' }), '/private/tmp');
});
