'use strict';
require('../i18n').setLanguage('ru');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { UpdateManager, helperHash, inspectInstalled, downloadOfficial } = require('../update-core');

const { makeTemp } = require('./temp');
const sha = value => createHash('sha256').update(value).digest('hex');
const required = ['isolation', 'nativeTabs', 'titles', 'completion', 'acknowledgement', 'nativeNewChat', 'interface', 'language'];

async function fixture(t) {
  const root = await makeTemp('up-unit-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helper = path.join(root, 'helper');
  for (const name of ['package.json', 'extension.js', 'sessions.js', 'titles.js', 'badges.js',
    'i18n.js', 'ui-language.js', 'translations/en.json', 'translations/ru.json', 'package.nls.json', 'package.nls.ru.json',
    'native-bridge.cjs', 'update-core.js', 'update-ui.js', 'compatibility.json',
    'scripts/native_adapter.py', 'scripts/renderer_adapter.py', 'scripts/update_package.py', 'scripts/read_history.py', 'test/update-probe.js']) {
    const file = path.join(helper, name); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture');
  }
  const profile = { version: '1.0.0', platform: `${process.platform}-${process.arch}`, vsixSha256: sha('official bytes') };
  const installs = [];
  let busy = false, consent = true;
  const manager = new UpdateManager({ storage: path.join(root, 'storage'), helper, profiles: [profile],
    download: async (_profile, file) => fs.writeFile(file, 'official bytes'),
    prepare: async (_original, job) => {
      const file = path.join(job, 'patched.vsix'); await fs.writeFile(file, 'tested patched bytes');
      return { vsix: file };
    },
    verifyCandidate: async () => {},
    probe: async (_candidate, _job, evidence) => ({ ...evidence, version: profile.version,
      success: true, checks: Object.fromEntries(required.map(key => [key, true])) }),
    confirmInstall: async () => consent,
    install: async (file, version) => { installs.push({ bytes: await fs.readFile(file, 'utf8'), version }); },
    isBusy: () => busy,
  });
  return { root, helper, profile, manager, installs, setBusy: value => { busy = value; }, setConsent: value => { consent = value; } };
}

test('only complete fresh evidence permits installation, and a verified recovery remains usable', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.run('1.0.0')).status, 'installed');
  assert.equal(f.installs.length, 1);
  assert.equal((await f.manager.recovery()).version, '1.0.0');
  await f.manager.restore();
  assert.equal(f.installs.length, 2);
  assert.ok((await fs.readdir(f.manager.storage)).every(name => !name.startsWith('job-')));
});

test('unknown version and tampered download never reach candidate execution', async t => {
  const f = await fixture(t);
  f.manager.prepare = async () => assert.fail('Unapproved bytes were executed');
  await assert.rejects(f.manager.run('99.0.0'), /нет проверенного адаптера/);
  f.manager.download = async (_profile, file) => fs.writeFile(file, 'tampered');
  await assert.rejects(f.manager.run('1.0.0'), /контрольная сумма/);
  assert.equal(f.installs.length, 0);
});

test('false, missing, stale and wrong-build runtime reports prevent installation', async t => {
  const f = await fixture(t);
  const good = f.manager.probe;
  for (const type of ['false', 'missing', 'no-interface', 'no-language', 'stale', 'helper', 'version']) {
    f.manager.probe = async (...args) => {
      const report = await good(...args);
      if (type === 'false') report.checks.completion = false;
      if (type === 'missing') delete report.checks.nativeNewChat;
      if (type === 'no-interface') report.checks.interface = false;
      if (type === 'no-language') delete report.checks.language;
      if (type === 'stale') report.attempt = 'old';
      if (type === 'helper') report.helper = 'another build';
      if (type === 'version') report.version = 'other version';
      return report;
    };
    await assert.rejects(f.manager.run('1.0.0'), /не подтвердила/);
  }
  assert.equal(f.installs.length, 0);
});

test('changes during runtime verification cancel installation', async t => {
  const f = await fixture(t);
  const good = f.manager.probe;
  f.manager.probe = async (candidate, ...args) => {
    const result = await good(candidate, ...args);
    await fs.writeFile(candidate.vsix, 'changed during test');
    return result;
  };
  await assert.rejects(f.manager.run('1.0.0'), /Файлы изменились/);
  assert.equal(f.installs.length, 0);
});

test('failed candidate or installation preserves an existing recovery', async t => {
  const f = await fixture(t);
  await f.manager.run('1.0.0');
  const before = await fs.readFile(f.manager.receiptPath);
  const good = f.manager.probe;
  f.manager.probe = async () => { throw new Error('runtime failed'); };
  await assert.rejects(f.manager.run('1.0.0'), /runtime failed/);
  assert.deepEqual(await fs.readFile(f.manager.receiptPath), before);
  f.manager.probe = good;
  f.manager.install = async () => { throw new Error('installer failed'); };
  await assert.rejects(f.manager.run('1.0.0'), /Восстановить Codex/);
  assert.deepEqual(await fs.readFile(f.manager.receiptPath), before);
});

test('cancelled consent and busy sessions never install', async t => {
  const f = await fixture(t);
  f.setConsent(false);
  assert.equal((await f.manager.run('1.0.0')).status, 'verified');
  assert.equal(f.installs.length, 0);
  assert.ok(await f.manager.recovery(), 'A proved backup can be saved without an installation');
  f.setConsent(true); f.setBusy(true);
  await assert.rejects(f.manager.run('1.0.0'), /завершения/);
  await assert.rejects(f.manager.restore(), /завершения/);
});

test('abort and concurrent operations are refused without installation', async t => {
  const f = await fixture(t);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.manager.run('1.0.0', abort.signal));
  await f.manager.locked(async () => {
    await assert.rejects(f.manager.run('1.0.0'), /уже выполняется/);
  });
  assert.equal(f.installs.length, 0);
});

test('corrupt recovery or a changed helper build cannot be restored', async t => {
  const f = await fixture(t);
  await f.manager.run('1.0.0');
  const saved = await f.manager.recovery();
  await fs.writeFile(saved.file, 'damaged');
  assert.equal(await f.manager.recovery(), undefined);
  await assert.rejects(f.manager.restore(), /резервной версии нет/);
  await fs.writeFile(saved.file, 'tested patched bytes');
  await fs.writeFile(path.join(f.helper, 'extension.js'), 'new helper');
  assert.equal(await f.manager.recovery(), undefined);
  await fs.writeFile(path.join(f.helper, 'extension.js'), 'fixture');
  assert.ok(await f.manager.recovery());
  await fs.writeFile(path.join(f.helper, 'translations/ru.json'), 'changed dictionary');
  assert.equal(await f.manager.recovery(), undefined, 'Translations are part of the verified companion build');
});

test('health check recognizes missing, unsupported, original, valid and changed adapters', async t => {
  const f = await fixture(t), folder = path.join(f.root, 'vendor');
  await fs.mkdir(path.join(folder, 'out'), { recursive: true });
  const profile = { ...f.profile, sourceSha256: sha('original'), patchedSourceSha256: sha('patched') };
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: 'chatgpt', publisher: 'OpenAI', version: '1.0.0' }));
  assert.equal((await inspectInstalled(undefined, [profile], f.helper)).status, 'missing');
  await fs.writeFile(path.join(folder, 'out/extension.js'), 'original');
  assert.equal((await inspectInstalled(folder, [profile], f.helper)).status, 'adapter-missing');
  await fs.writeFile(path.join(folder, 'out/extension.js'), 'patched');
  await fs.writeFile(path.join(folder, 'out/extension.js.before-session-tabs'), 'original');
  await fs.writeFile(path.join(folder, 'out/session-tabs-native.cjs'), 'fixture');
  assert.equal((await inspectInstalled(folder, [profile], f.helper)).status, 'ready');
  await fs.writeFile(path.join(folder, 'out/session-tabs-native.cjs'), 'wrong bridge');
  assert.equal((await inspectInstalled(folder, [profile], f.helper)).status, 'changed');
  assert.equal((await inspectInstalled(folder, [], f.helper)).status, 'unsupported');
});

test('downloader accepts only an approved official URL and exact bytes', async t => {
  const f = await fixture(t);
  const profile = { ...f.profile, url: 'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/OpenAI/vsextensions/chatgpt/1.0.0/vspackage' };
  const fetcher = async () => new Response('official bytes');
  await downloadOfficial(profile, path.join(f.root, 'download.vsix'), undefined, fetcher);
  await assert.rejects(downloadOfficial({ ...profile, url: 'http://example.com/package' }, path.join(f.root, 'bad.vsix'), undefined, fetcher), /официальный источник/);
  await assert.rejects(downloadOfficial({ ...profile, vsixSha256: 'wrong' }, path.join(f.root, 'bad-hash.vsix'), undefined, fetcher), /Контрольная сумма/);
});
