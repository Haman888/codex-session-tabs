'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { listSessions, findDatabase } = require('../sessions');

test('reads real SQLite metadata read-only, respects names, pins and workspace boundaries', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tabs-unit-'));
  try {
    const database = path.join(home, 'state_5.sqlite');
    execFileSync('/usr/bin/sqlite3', [database, `
      CREATE TABLE threads (id TEXT, title TEXT, name TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER, is_pinned INTEGER);
      INSERT INTO threads VALUES
      ('00000000-0000-0000-0000-000000000001', 'Old title', 'Renamed chat', '/project', 'vscode', 0, 100, 1),
      ('00000000-0000-0000-0000-000000000002', 'Child project', NULL, '/project/child', 'cli', 0, 200, 0),
      ('00000000-0000-0000-0000-000000000003', 'Similar prefix', '', '/project-other', 'vscode', 0, 300, 0),
      ('00000000-0000-0000-0000-000000000004', 'Archived', '', '/project', 'vscode', 1, 400, 0),
      ('00000000-0000-0000-0000-000000000005', 'Subagent', '', '/project', '{"subagent":"review"}', 0, 500, 0),
      ('00000000-0000-0000-0000-000000000006', 'Exec', '', '/project', 'exec', 0, 600, 0);
    `]);
    const before = await fs.readFile(database);
    const rows = await listSessions({ home });
    assert.deepEqual(rows.map(row => row.title), ['Renamed chat', 'Similar prefix', 'Child project']);
    assert.equal(rows[0].updatedAt, 100000);
    assert.deepEqual((await listSessions({ home, folders: ['/project'], scope: 'workspace' })).map(row => row.title), ['Renamed chat', 'Child project']);
    assert.deepEqual(await fs.readFile(database), before, 'Session database is unchanged');
    await fs.writeFile(path.join(home, 'state_4.sqlite'), 'older schema');
    assert.equal(await findDatabase(home), database);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('supports older metadata schema and a missing Codex home', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tabs-unit-'));
  try {
    assert.deepEqual(await listSessions({ home: path.join(home, 'missing') }), []);
    execFileSync('/usr/bin/sqlite3', [path.join(home, 'state_3.sqlite'), `
      CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER);
      INSERT INTO threads VALUES ('00000000-0000-0000-0000-000000000001', 'Existing chat', '/project', 'vscode', 0, 1);
    `]);
    assert.equal((await listSessions({ home }))[0].title, 'Existing chat');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('keeps valid history names despite null, primitive, malformed and partial index records', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tabs-unit-'));
  const id = '00000000-0000-0000-0000-000000000001';
  try {
    execFileSync('/usr/bin/sqlite3', [path.join(home, 'state_5.sqlite'), `
      CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER);
      INSERT INTO threads VALUES ('${id}', 'A long first message that is not the conversation name', '/project', 'vscode', 0, 1);
    `]);
    await fs.writeFile(path.join(home, 'session_index.jsonl'), [
      JSON.stringify({ id, thread_name: 'Original name', updated_at: '2026-10-30T10:00:00Z' }),
      'null', '42', '"text"', '[]', '{}', '{invalid json}',
      JSON.stringify({ id, thread_name: 'Вкладки VS Code', updated_at: '2026-11-01T19:23:00Z' }),
      JSON.stringify({ id, thread_name: 'Older record appended later', updated_at: '2026-10-29T10:00:00Z' }),
      '{"incomplete":',
    ].join('\n'));
    assert.equal((await listSessions({ home }))[0].title, 'Вкладки VS Code');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
