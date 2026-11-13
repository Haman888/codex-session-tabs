'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setLanguage } = require('../i18n');
function host() {
  setLanguage('en');
  const clock = { value: 1000000 }, state = { enabled: true, requests: 0, fail: false, picks: [] };
  const bar = { show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  const commands = new Map();
  const vscode = { StatusBarAlignment: { Right: 2 },
    window: { state: { focused: true }, createStatusBarItem: () => bar,
      showQuickPick: async rows => { state.picks.push(rows); } },
    workspace: { getConfiguration: () => ({ get: () => state.enabled }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } } };
  const cache = new Map();
  const load = name => {
    if (name === 'vscode') return vscode;
    if (!['./usage', './native-bridge.cjs'].includes(name)) return name.startsWith('./') ? require(path.join(__dirname, '..', name)) : require(name);
    if (cache.has(name)) return cache.get(name);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', name === './usage' ? 'usage.js' : name), 'utf8'), {
      module, require: load, setTimeout, clearTimeout, Date, Map, Number, Object, Intl,
    });
    cache.set(name, module.exports); return module.exports;
  };
  const binding = { isReady: () => true, readRateLimits: async () => {
    state.requests++;
    if (state.pending) return state.pending;
    if (state.fail) throw new Error('private upstream error');
    return { buckets: [{ id: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000 },
      secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 900000 } }] };
  } };
  const context = { subscriptions: [] };
  const api = load('./usage').activateUsage(context, () => [binding], () => clock.value);
  return { api, bar, clock, state, commands, bridge: load('./native-bridge.cjs'),
    dispose: () => context.subscriptions.forEach(item => item.dispose()) };
}

test('weekly account allowance shows remaining percentage and details show both used and remaining', async () => {
  const f = host();
  try {
    assert.match(f.bar.text, /week: —/);
    await f.api.refresh();
    assert.match(f.bar.text, /week: 60% left/);
    assert.match(f.bar.tooltip, /Used 40% · Remaining 60%/);
    assert.match(f.bar.tooltip, /Reset:/);
    assert.match(f.bar.tooltip, /Used 25% · Remaining 75%/);
    await f.api.refresh(); assert.equal(f.state.requests, 1);
    setLanguage('ru'); f.api.render();
    assert.match(f.bar.text, /нед: осталось 60%/);
    await f.commands.get('codexSessionTabs.usage')();
    assert.ok(f.state.picks[0].some(row => /Использовано 40%/.test(row.description)));
  } finally { f.dispose(); }
});

test('expired and failed snapshots stay explicitly outdated instead of resetting allowance', async () => {
  const f = host();
  try {
    await f.api.refresh();
    f.clock.value += 300001; f.state.fail = true; await f.api.refresh();
    assert.match(f.bar.text, /week: —/);
    assert.match(f.bar.tooltip, /outdated/);
    await f.api.refresh(); assert.equal(f.state.requests, 2);
    f.api.rates({ buckets: [{ id: 'codex', secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1301 } }] });
    assert.match(f.bar.text, /0% left/);
    f.clock.value = 1301000; f.api.render();
    assert.match(f.bar.text, /week: —/);
    assert.doesNotMatch(f.bar.text, /100% left/);
    f.state.enabled = false; await f.api.refresh(); assert.equal(f.bar.visible, false);
  } finally { f.dispose(); }
});

test('sparse notifications preserve other windows, and a short limit is never mistaken for the week', async () => {
  const f = host();
  try {
    await f.api.refresh();
    f.api.rates({ buckets: [{ id: 'codex', primary: { usedPercent: 30, windowDurationMins: 300 } }] }, true);
    assert.match(f.bar.text, /60% left/);
    assert.match(f.bar.tooltip, /Used 30%/);
    f.api.rates({ buckets: [{ id: 'codex', secondary: { usedPercent: 45 } }] }, true);
    assert.match(f.bar.text, /55% left/);
    f.api.rates({ buckets: [{ id: 'other', secondary: { usedPercent: 80, windowDurationMins: 10080 } }] }, true);
    assert.match(f.bar.text, /55% left/);
    f.api.rates({ buckets: [{ id: 'codex', secondary: { usedPercent: 60 } }] });
    assert.match(f.bar.text, /week: —/);
    f.api.rates({ buckets: [{ id: 'codex', primary: { usedPercent: 70, windowDurationMins: 10080 } }] });
    assert.match(f.bar.text, /30% left/);
  } finally { f.dispose(); }
});

test('account changes clear cached data and discard old in-flight requests', async () => {
  const f = host();
  try {
    await f.api.refresh(); f.clock.value += 300001;
    let resolve;
    f.state.pending = new Promise(done => { resolve = done; });
    const request = f.api.refresh(); f.api.reset();
    assert.doesNotMatch(f.bar.tooltip, /40%|60%/);
    resolve({ buckets: [{ id: 'codex', secondary: { usedPercent: 99, windowDurationMins: 10080 } }] });
    await request;
    assert.match(f.bar.text, /week: —/);
    assert.doesNotMatch(f.bar.tooltip, /99%/);
  } finally { f.dispose(); }
});

test('rate reads accept only numeric usage metadata, strip account identity and reject invalid percentages', () => {
  const f = host();
  try {
    const rates = f.bridge.sanitizeRateLimits({ accountId: 'private', rateLimits: { limitId: 'codex', primary: { usedPercent: 25, secret: 'private' } },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 25 } }, other: { secondary: { usedPercent: 60 } } } });
    assert.equal(rates.buckets.length, 2);
    assert.doesNotMatch(JSON.stringify(rates), /private|accountId|secret/);
    for (const usedPercent of [-1, 101, NaN, Infinity, '25', {}]) {
      assert.equal(f.bridge.sanitizeRateLimits({ rateLimits: { primary: { usedPercent } } }).buckets.length, 0);
    }
    assert.equal(f.bridge.sanitizeRateLimits(null).buckets.length, 0);
  } finally { f.dispose(); }
});
