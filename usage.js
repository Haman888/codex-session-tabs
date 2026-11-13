'use strict';

const vscode = require('vscode');
const { t, formatDate } = require('./i18n');
const { sanitizeRateLimits } = require('./native-bridge.cjs');

function activateUsage(context, bindings, now = Date.now) {
  const bar = vscode.window.createStatusBarItem('codexSessionTabs.usage', vscode.StatusBarAlignment.Right, 29);
  bar.command = 'codexSessionTabs.usage';
  const buckets = new Map();
  let retryAt = 0, lastAttempt = -Infinity, fetchedAt, flight, generation = 0, revision = 0, disposed = false;
  const enabled = () => vscode.workspace.getConfiguration('codexSessionTabs').get('showUsage', true);
  const duration = (window, key) => window.windowDurationMins === 10080 ? t('usage.week')
    : window.windowDurationMins && window.windowDurationMins % 60 === 0 ? t('usage.hours', { value: window.windowDurationMins / 60 })
    : window.windowDurationMins ? t('usage.minutes', { value: window.windowDurationMins }) : t(`usage.${key}`);
  const outdated = window => window.failed || now() - window.observedAt > 600000
    || (window.resetsAt !== undefined && now() >= window.resetsAt * 1000);
  function rows() {
    const result = [];
    const add = (label, description, detail) => result.push({ label, description, ...(detail ? { detail } : {}) });
    if (!buckets.size) add(t('usage.limits'), '—', t('usage.unavailable'));
    for (const bucket of buckets.values()) {
      for (const key of ['primary', 'secondary']) {
        const window = bucket[key];
        if (!window) continue;
        const detail = [outdated(window) ? t('usage.outdated') : t('usage.used'),
          window.resetsAt !== undefined ? t('usage.resetAt', { date: formatDate(window.resetsAt * 1000) }) : undefined].filter(Boolean).join(' · ');
        add(`${bucket.id} · ${duration(window, key)}`, t('usage.breakdown', { used: window.usedPercent, remaining: 100 - window.usedPercent }), detail);
      }
    }
    if (fetchedAt !== undefined) add(t('usage.updated'), formatDate(fetchedAt));
    return result;
  }
  function render() {
    if (disposed) return;
    if (!enabled()) { bar.hide(); return; }
    const parts = ['$(pulse) Codex'];
    const bucket = buckets.get('codex') || (buckets.size === 1 ? [...buckets.values()][0] : undefined);
    const weekly = bucket && [bucket.primary, bucket.secondary].find(window => window?.windowDurationMins === 10080);
    if (bucket && bucket.id !== 'codex') parts.push(bucket.id);
    parts.push(weekly && !outdated(weekly) ? t('usage.weekRemaining', { value: 100 - weekly.usedPercent }) : t('usage.unknownWeek'));
    bar.name = t('usage.title');
    bar.text = parts.join(' · ');
    bar.tooltip = rows().map(row => `${row.label}${row.description ? `: ${row.description}` : ''}${row.detail ? `\n${row.detail}` : ''}`).join('\n');
    bar.accessibilityInformation = { label: bar.tooltip };
    bar.show();
  }
  function rates(value, partial = false, requestRevision = revision) {
    const safe = sanitizeRateLimits({ rateLimitsByLimitId: Object.fromEntries(
      (Array.isArray(value?.buckets) ? value.buckets : []).slice(0, 32).filter(bucket => bucket && typeof bucket.id === 'string').map(bucket => [bucket.id, bucket])) });
    const previous = new Map(buckets);
    revision++;
    if (!partial) buckets.clear();
    for (const bucket of safe.buckets) {
      for (const key of ['primary', 'secondary']) {
        if (!bucket[key]) continue;
        const before = previous.get(bucket.id)?.[key];
        const incoming = bucket[key];
        const next = { ...(partial ? before : {}), versions: { ...(partial ? before?.versions : {}) },
          observedAt: now(), revision, failed: false };
        for (const field of ['usedPercent', 'windowDurationMins', 'resetsAt']) {
          if (!partial && before?.versions[field] > requestRevision) {
            next[field] = before[field]; next.versions[field] = before.versions[field];
            if (field === 'usedPercent') next.observedAt = before.observedAt;
          } else if (incoming[field] !== undefined) {
            next[field] = incoming[field]; next.versions[field] = revision;
          }
        }
        bucket[key] = next;
      }
      buckets.set(bucket.id, { ...(partial ? previous.get(bucket.id) : {}), ...bucket });
    }
    if (!partial) {
      for (const [id, bucket] of previous) {
        for (const key of ['primary', 'secondary']) {
          if (bucket[key]?.revision > requestRevision && !buckets.get(id)?.[key]) {
            buckets.set(id, { ...buckets.get(id), id, [key]: bucket[key] });
          }
        }
      }
      fetchedAt = now();
    }
    render();
  }
  function reset() {
    generation++; revision++; buckets.clear(); fetchedAt = undefined;
    retryAt = 0; lastAttempt = -Infinity; flight = undefined; render();
  }
  async function refresh(force = false) {
    render();
    if (disposed || !enabled() || (!force && vscode.window.state.focused === false)) return;
    if (flight) return flight;
    if (now() < retryAt) return;
    const binding = [...bindings()].find(item => item.isReady?.() && typeof item.readRateLimits === 'function');
    if (!binding) return;
    lastAttempt = now();
    retryAt = now() + 300000;
    const epoch = generation, sequence = revision;
    const operation = (async () => {
      try {
        const result = await binding.readRateLimits();
        if (!disposed && generation === epoch) rates(result, false, sequence);
      } catch {
        if (!disposed && generation === epoch) {
          for (const bucket of buckets.values()) for (const key of ['primary', 'secondary']) {
            if (bucket[key]?.revision <= sequence) bucket[key].failed = true;
          }
          render();
        }
      }
    })();
    flight = operation;
    try { await operation; } finally { if (flight === operation) flight = undefined; }
  }
  async function show() {
    await refresh(true);
    const selected = await vscode.window.showQuickPick([...rows(), { label: `$(refresh) ${t('usage.refresh')}`, refresh: true }],
      { title: t('usage.title'), placeHolder: t('usage.used'), matchOnDescription: true, matchOnDetail: true });
    if (selected?.refresh) {
      retryAt = Math.min(retryAt, lastAttempt + 15000);
      await refresh(true);
      return show();
    }
  }
  context.subscriptions.push(bar,
    vscode.commands.registerCommand('codexSessionTabs.usage', show),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('codexSessionTabs.showUsage')) void refresh(); }),
    { dispose() { disposed = true; generation++; buckets.clear(); } });
  render();
  return { refresh, render, rates, reset, bar };
}

module.exports = { activateUsage };
