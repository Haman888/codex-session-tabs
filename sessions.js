'use strict';

const { t } = require('./i18n');

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

async function findDatabase(home) {
  let names;
  try {
    names = await fs.readdir(home);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  const databases = names.filter(name => /^state_\d+\.sqlite$/.test(name));
  databases.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  return databases[0] && path.join(home, databases[0]);
}

function createReadOnlyQuery({ execute = execFileAsync, python = 'python3' } = {}) {
  const pythonDatabases = new Set();
  const options = { timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
  const native = (database, sql) => execute('/usr/bin/sqlite3', [
    '-readonly', '-json', '-cmd', '.timeout 3000', database, sql,
  ], options);
  const fallback = (database, sql) => execute(python, [path.join(__dirname, 'scripts/read_history.py'), database, sql], options);
  return async (database, sql) => {
    let result;
    if (pythonDatabases.has(database)) {
      try { result = await fallback(database, sql); }
      catch { pythonDatabases.delete(database); result = await native(database, sql); }
    } else {
      try { result = await native(database, sql); }
      catch (error) {
        if (error.code !== 'ENOENT' && !/unable to open database|permission denied|not authorized/i.test(String(error.stderr || error.message))) throw error;
        result = await fallback(database, sql);
        pythonDatabases.add(database);
      }
    }
    return result.stdout.trim() ? JSON.parse(result.stdout) : [];
  };
}

const query = createReadOnlyQuery();

function isInWorkspace(cwd, folders) {
  if (!cwd || !folders.length) return false;
  return folders.some(folder => {
    const relative = path.relative(path.resolve(folder), path.resolve(cwd));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  });
}

async function readSessionNames(home) {
  let text;
  try { text = await fs.readFile(path.join(home, 'session_index.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  const names = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; } // A concurrent append can leave the final line incomplete.
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    if (typeof record.id !== 'string' || typeof record.thread_name !== 'string' || !record.thread_name.trim()) continue;
    const date = Date.parse(record.updated_at) || 0;
    const previous = names.get(record.id);
    if (!previous || date >= previous.date) names.set(record.id, { title: record.thread_name.trim(), date });
  }
  return new Map([...names].map(([id, value]) => [id, value.title]));
}

// The schema changes only with a Codex update; one sqlite3 run per refresh is enough.
const columnCache = new Map();

async function readSessions({ home = codexHome(), run = query } = {}) {
  const database = await findDatabase(home);
  if (!database) return [];
  const columns = columnCache.get(database)
    || new Set((await run(database, 'PRAGMA table_info(threads)')).map(column => column.name));
  for (const required of ['id', 'title', 'cwd', 'source', 'archived', 'updated_at']) {
    if (!columns.has(required)) { columnCache.delete(database); throw new Error(t('error.historySchema', { column: required })); }
  }
  const name = columns.has('name') ? "COALESCE(NULLIF(name, ''), NULLIF(title, ''), '')" : "COALESCE(NULLIF(title, ''), '')";
  const pinned = columns.has('is_pinned') ? 'COALESCE(is_pinned, 0)' : '0';
  // Only top-level interactive chats: never execute or display subagent sessions.
  // A long first prompt can be a title: cut it in SQL so a big history never exceeds the 8 MB reader buffer.
  const rows = await run(database, `SELECT id, substr(${name}, 1, 300) AS title, cwd,
    updated_at * 1000 AS updatedAt, ${pinned} AS pinned
    FROM threads WHERE archived = 0 AND source IN ('vscode', 'cli', 'appServer')
    ORDER BY pinned DESC, updated_at DESC
    LIMIT 5000`).catch(error => { columnCache.delete(database); throw error; });
  columnCache.set(database, columns);
  // Codex keeps explicit/generated names in this append-only index. SQLite's
  // title can revert to the first prompt during hydration, so it is a fallback.
  const names = await readSessionNames(home);
  return rows.map(row => ({ ...row, title: names.get(row.id) || row.title }))
    .filter(row => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.id));
}

function createSessionReader({ load = readSessions, now = Date.now, ttl = 5000, backoff = 30000, maxBackoff = 300000, minInterval = 5000 } = {}) {
  const states = new Map();
  const stateFor = home => {
    const key = path.resolve(home);
    if (!states.has(key)) states.set(key, { rows: undefined, expires: 0, retryAt: 0, failures: 0 });
    return states.get(key);
  };
  const status = ({ home = codexHome() } = {}) => {
    const state = stateFor(home);
    return { error: state.error?.message, retryAt: state.retryAt, stale: Boolean(state.error && state.rows), hasCache: state.rows !== undefined };
  };
  const reset = ({ home = codexHome() } = {}) => {
    const state = stateFor(home);
    state.retryAt = 0; state.expires = 0; state.failures = 0;
  };
  // The database changed: reload soon, not more often than minInterval, keeping any failure backoff.
  const invalidate = ({ home = codexHome() } = {}) => {
    const state = stateFor(home);
    if (state.flight) state.dirty = true;
    state.expires = Math.min(state.expires, (state.loadedAt ?? 0) + minInterval);
  };
  const list = async ({ home = codexHome(), folders = [], scope = 'all' } = {}) => {
    const state = stateFor(home);
    if (!state.flight && now() >= state.retryAt && (state.rows === undefined || now() >= state.expires)) {
      state.flight = (async () => {
        try {
          state.rows = await load({ home });
          state.error = undefined; state.failures = 0; state.retryAt = 0; state.loadedAt = now();
          state.expires = state.loadedAt + (state.dirty ? minInterval : ttl); state.dirty = false;
        } catch {
          state.failures++;
          state.retryAt = now() + Math.min(maxBackoff, backoff * 2 ** Math.min(state.failures - 1, 10));
          state.error = new Error(t('error.historyUnavailable'));
          Object.defineProperty(state.error, 'message', { get: () => t('error.historyUnavailable') });
          state.error.code = 'CODEX_HISTORY_UNAVAILABLE';
        }
      })().finally(() => { state.flight = undefined; });
    }
    if (state.flight) await state.flight;
    if (state.error && state.rows === undefined) throw state.error;
    return (state.rows || []).filter(row => scope !== 'workspace' || isInWorkspace(row.cwd, folders));
  };
  return { list, status, reset, invalidate };
}

// The file watcher invalidates the cache when the database changes, so idle refreshes reuse it longer.
const reader = createSessionReader({ ttl: 30000 });
module.exports = { codexHome, findDatabase, isInWorkspace, listSessions: reader.list, readSessionNames, readSessions,
  getSessionStatus: reader.status, resetSessions: reader.reset, invalidateSessions: reader.invalidate, createSessionReader, createReadOnlyQuery };
