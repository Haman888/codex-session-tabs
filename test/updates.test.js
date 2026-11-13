'use strict';
require('../i18n').setLanguage('ru');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { UpdateManager, helperHash, inspectInstalled, downloadOfficial } = require('../update-core');

const { makeTemp } = require('./temp');
const sha = value => createHash('sha256').update(value).digest('hex');
const required = ['isolation', 'nativeTabs', 'titles', 'completion', 'acknowledgement', 'nativeNewChat', 'interface', 'language', 'usage'];

test('two stale-lock reclaimers never remove the new owner lock', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await fs.mkdir(f.manager.storage);
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  assert.throws(() => process.kill(dead, 0), { code: 'ESRCH' });
  await fs.writeFile(path.join(f.manager.storage, 'operation.lock'), JSON.stringify({ pid: dead, nonce: 'stale' }));
  const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const paused = defer(), resume = defer(), entered = defer(), release = defer();
  const rename = fs.rename;
  let first = true, active = 0, maxActive = 0;
  fs.rename = async (...args) => {
    if (first) { first = false; paused.resolve(); await resume.promise; }
    return rename(...args);
  };
  let a, b;
  try {
    a = f.manager.locked(async () => { active++; maxActive = Math.max(active, maxActive); active--; });
    await paused.promise;
    b = f.manager.locked(async () => { active++; maxActive = Math.max(active, maxActive); entered.resolve(); await release.promise; active--; })
      .then(() => 'entered', () => 'refused');
    await Promise.race([b, entered.promise]);
    resume.resolve();
    await a;
    release.resolve();
    await b;
    assert.equal(maxActive, 1, 'A stale-lock reclaimer must not evict another live owner');
    assert.equal(await f.manager.locked(async () => 'reusable'), 'reusable');
  } finally {
    fs.rename = rename; resume.resolve(); release.resolve();
    await Promise.allSettled([a, b].filter(Boolean));
  }
});

async function fixture(t) {
  const root = await makeTemp('up-unit-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helper = path.join(root, 'helper');
  for (const name of ['package.json', 'extension.js', 'sessions.js', 'titles.js', 'badges.js',
    'i18n.js', 'ui-language.js', 'translations/en.json', 'translations/ru.json', 'package.nls.json', 'package.nls.ru.json',
    'native-bridge.cjs', 'usage.js', 'update-core.js', 'update-ui.js', 'compatibility.json',
    'scripts/native_adapter.py', 'scripts/renderer_adapter.py', 'scripts/update_package.py', 'scripts/read_history.py', 'test/update-probe.js']) {
    const file = path.join(helper, name); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, name === 'package.json' ? JSON.stringify({ version: '0.8.1', main: 'extension.js' }) : 'fixture');
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
    prepareRecovery: async (saved, job) => {
      const file = path.join(job, 'recovery.vsix');
      await fs.copyFile(saved.file, file);
      return { vsix: file };
    },
    probe: async (_candidate, _job, evidence) => ({ ...evidence, version: profile.version,
      success: true, finished: true, checks: Object.fromEntries(required.map(key => [key, true])) }),
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

test('a discovered version is admitted only after its GUI proof and survives a restart', async t => {
  const f = await fixture(t);
  await f.manager.run('1.0.0');
  const recovery = await fs.readFile(f.manager.receiptPath);
  const future = { version: '99.1.2', platform: `${process.platform}-${process.arch}`,
    discovery: 'structure-v1', nativeLayout: 'shared-content-v1', startupTimeoutMs: 90000,
    sourceSha256: sha('source'), patchedSourceSha256: sha('patched'), vsixSha256: sha('future official'),
    url: `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/OpenAI/vsextensions/chatgpt/99.1.2/vspackage?targetPlatform=${process.platform}-${process.arch}` };
  f.manager.discover = async (version, file) => {
    assert.equal(version, '99.1.2');
    await fs.writeFile(file, 'future official');
    return future;
  };
  f.manager.probe = async (_candidate, _job, evidence) => ({ ...evidence,
    version: '99.1.2', success: true, finished: true, checks: Object.fromEntries(required.map(key => [key, true])) });
  const good = f.manager.probe;
  f.manager.probe = async (...args) => ({ ...await good(...args), success: false });
  await assert.rejects(f.manager.run('99.1.2'), /не подтвердила/);
  assert.equal(f.manager.profiles.some(p => p.version === '99.1.2'), false);
  assert.equal(f.installs.length, 1);
  f.manager.probe = good;
  assert.equal((await f.manager.run('99.1.2')).status, 'installed');
  assert.equal(f.installs.at(-1).version, '99.1.2');
  assert.deepEqual(await fs.readFile(f.manager.receiptPath), recovery);
  const restarted = new UpdateManager({ storage: f.manager.storage, helper: f.helper,
    profiles: [f.profile], verifyCandidate: async () => {} });
  await restarted.loadProfiles();
  assert.equal(restarted.profiles.find(p => p.version === '99.1.2').sourceSha256, sha('source'));
  const proofBytes = await fs.readFile(restarted.profilesPath);
  const changed = JSON.parse(proofBytes);
  changed[0].profile.sourceSha256 = sha('another source');
  await fs.writeFile(restarted.profilesPath, JSON.stringify(changed));
  await restarted.loadProfiles();
  assert.equal(restarted.profiles.length, 1, 'Changing a saved profile invalidates its GUI proof');
  await fs.writeFile(restarted.profilesPath, proofBytes);
  await fs.writeFile(path.join(f.helper, 'native-bridge.cjs'), 'changed build');
  const upgraded = new UpdateManager({ storage: f.manager.storage, helper: f.helper,
    profiles: [f.profile], verifyCandidate: async () => {} });
  await upgraded.loadProfiles();
  assert.equal(upgraded.profiles.length, 1, 'Proof from another helper build must not be trusted');
  const cached = await fs.readFile(f.manager.receiptPath, 'utf8');
  const previous = JSON.parse(cached);
  await fs.writeFile(f.manager.receiptPath, JSON.stringify({ ...previous, version: future.version }));
  f.manager.bundledProfiles = [f.profile];
  await f.manager.loadProfiles();
  assert.equal((await f.manager.restore()).status, 'restored');
  assert.equal(f.manager.profiles.find(p => p.version === future.version).discovery, 'structure-v1');
  assert.equal((await f.manager.recovery()).version, future.version);
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

test('a quick recovery check finds a saved package without reading all of it; restoring reads it all', async t => {
  const f = await fixture(t);
  await f.manager.run('1.0.0');
  const saved = await f.manager.recovery();
  await fs.writeFile(saved.file, 'damaged');
  assert.equal(await f.manager.recovery(), undefined);
  assert.equal((await f.manager.recovery({ checkFile: false })).version, '1.0.0');
  await assert.rejects(f.manager.restore(), /резервной версии нет/);
  await fs.rm(saved.file);
  assert.equal(await f.manager.recovery({ checkFile: false }), undefined);
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

test('version and installation metadata changes preserve recovery; command changes require a new proof', async t => {
  const f = await fixture(t);
  await f.manager.run('1.0.0');
  await fs.writeFile(path.join(f.helper, 'package.json'), JSON.stringify({ main: 'extension.js', version: '0.9.0',
    __metadata: { installedTimestamp: 123 } }));
  assert.ok(await f.manager.recovery());
  await fs.writeFile(path.join(f.helper, 'package.json'), JSON.stringify({ version: '0.9.0', main: 'other.js' }));
  assert.equal(await f.manager.recovery(), undefined);
});

test('restore revalidates an older helper recovery before installing and survives a manager restart', async t => {
  const f = await fixture(t);
  await f.manager.run('1.0.0');
  await fs.writeFile(path.join(f.helper, 'extension.js'), 'new runtime');
  const old = await fs.readFile(f.manager.receiptPath);
  let checked = false;
  const probe = f.manager.probe;
  f.manager.probe = async (...args) => {
    assert.equal(f.installs.length, 1);
    assert.deepEqual(await fs.readFile(f.manager.receiptPath), old);
    checked = true;
    return probe(...args);
  };
  assert.equal((await f.manager.restore()).status, 'restored');
  assert.equal(checked, true);
  assert.equal(f.installs.length, 2);
  const restarted = new UpdateManager({ storage: f.manager.storage, helper: f.helper,
    profiles: [f.profile], verifyCandidate: async () => {} });
  assert.ok(await restarted.recovery());
});

test('failed revalidation preserves the old receipt and package without installing', async t => {
  const f = await fixture(t);
  await f.manager.run('1.0.0');
  const saved = await f.manager.recovery();
  const receipt = await fs.readFile(f.manager.receiptPath);
  await fs.writeFile(path.join(f.helper, 'extension.js'), 'new runtime');
  f.manager.probe = async () => { throw Error('new runtime refused'); };
  await assert.rejects(f.manager.restore(), /new runtime refused/);
  assert.deepEqual(await fs.readFile(f.manager.receiptPath), receipt);
  assert.equal(await fs.readFile(saved.file, 'utf8'), 'tested patched bytes');
  assert.equal(f.installs.length, 1);
  assert.ok((await fs.readdir(f.manager.storage)).every(name => !name.startsWith('job-')));
});

test('revalidation rejects stale proof, changed staged bytes and a helper changed during the probe', async t => {
  for (const failure of ['proof', 'package', 'helper']) {
    const f = await fixture(t);
    await f.manager.run('1.0.0');
    const before = await fs.readFile(f.manager.receiptPath);
    await fs.writeFile(path.join(f.helper, 'extension.js'), 'new runtime');
    const probe = f.manager.probe;
    f.manager.probe = async (candidate, ...args) => {
      const evidence = await probe(candidate, ...args);
      if (failure === 'proof') evidence.attempt = 'previous';
      if (failure === 'package') await fs.writeFile(candidate.vsix, 'changed');
      if (failure === 'helper') await fs.writeFile(path.join(f.helper, 'usage.js'), 'changed');
      return evidence;
    };
    await assert.rejects(f.manager.restore(), /не подтвердила|Файлы изменились/);
    assert.deepEqual(await fs.readFile(f.manager.receiptPath), before);
    assert.equal(f.installs.length, 1);
  }
});

test('installing a newer version revalidates and preserves the previous recovery after a helper upgrade', async t => {
  const f = await fixture(t);
  await f.manager.run('1.0.0');
  await fs.writeFile(path.join(f.helper, 'extension.js'), 'new runtime');
  const next = { ...f.profile, version: '2.0.0' };
  f.manager.profiles.push(next); f.manager.bundledProfiles.push(next);
  const prepare = f.manager.prepare;
  f.manager.prepare = async (...args) => {
    const result = await prepare(...args);
    await fs.writeFile(result.vsix, 'new version bytes');
    return result;
  };
  f.manager.probe = async (candidate, _job, evidence) => ({ ...evidence, version: candidate.profile.version,
    finished: true, success: true, checks: Object.fromEntries(required.map(key => [key, true])) });
  await f.manager.run('2.0.0');
  const saved = await f.manager.recovery();
  assert.equal(saved.version, '1.0.0');
  assert.equal(await fs.readFile(saved.file, 'utf8'), 'tested patched bytes');
});

test('an incompatible old recovery is retained while a separately verified newer Codex can be installed', async t => {
  const f = await fixture(t);
  await f.manager.run('1.0.0');
  const before = await fs.readFile(f.manager.receiptPath);
  const old = await f.manager.recovery();
  await fs.writeFile(path.join(f.helper, 'native-bridge.cjs'), 'new bridge');
  const next = { ...f.profile, version: '2.0.0' };
  f.manager.profiles.push(next); f.manager.bundledProfiles.push(next);
  f.manager.prepareRecovery = async () => { throw Error('old adapter is incompatible'); };
  f.manager.prepare = async (_original, job) => {
    const vsix = path.join(job, 'new.vsix'); await fs.writeFile(vsix, 'new compatible package');
    return { vsix };
  };
  f.manager.probe = async (candidate, _job, evidence) => ({ ...evidence, version: candidate.profile.version,
    finished: true, success: true, checks: Object.fromEntries(required.map(key => [key, true])) });
  const result = await f.manager.run('2.0.0');
  assert.equal(result.status, 'installed');
  assert.equal(result.retainedRecoveryVersion, '1.0.0');
  assert.equal((await f.manager.recovery()).version, '2.0.0');
  assert.deepEqual(await fs.readFile(path.join(f.manager.storage, 'retained-recovery.json')), before);
  assert.equal(await fs.readFile(old.file, 'utf8'), 'tested patched bytes');
  await f.manager.run('2.0.0');
  assert.equal(await fs.readFile(old.file, 'utf8'), 'tested patched bytes');
});

test('restore refuses helper changes made while the installation confirmation is open', async t => {
  const f = await fixture(t);
  await f.manager.run('1.0.0');
  f.manager.confirmInstall = async () => {
    await fs.writeFile(path.join(f.helper, 'native-bridge.cjs'), 'changed bridge');
    return true;
  };
  await assert.rejects(f.manager.restore(), /состояние изменилось/);
  assert.equal(f.installs.length, 1);
});

test('update refuses helper changes made while the installation confirmation is open', async t => {
  const f = await fixture(t);
  f.manager.confirmInstall = async () => {
    await fs.writeFile(path.join(f.helper, 'native-bridge.cjs'), 'changed bridge');
    return true;
  };
  await assert.rejects(f.manager.run('1.0.0'), /Файлы изменились/);
  assert.equal(f.installs.length, 0);
});

test('recovery rejects linked receipts and linked packages even when their contents match', async t => {
  const f = await fixture(t);
  await f.manager.run('1.0.0');
  const saved = await f.manager.recovery();
  const original = f.manager.receiptPath + '.original';
  await fs.rename(f.manager.receiptPath, original);
  await fs.symlink(original, f.manager.receiptPath);
  assert.equal(await f.manager.recovery(), undefined);
  await fs.unlink(f.manager.receiptPath); await fs.rename(original, f.manager.receiptPath);
  await fs.rename(saved.file, saved.file + '.original');
  await fs.symlink(saved.file + '.original', saved.file);
  assert.equal(await f.manager.recovery({ checkFile: false, allowRevalidation: true }), undefined);
});

test('lock diagnostics distinguish a live update, a dead reclaimer and unverifiable state without deleting locks', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.manager.lockStatus(), []);
  await fs.mkdir(f.manager.storage);
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  assert.throws(() => process.kill(dead, 0), { code: 'ESRCH' });
  const operation = path.join(f.manager.storage, 'operation.lock');
  const reclaim = operation + '.reclaim';
  await fs.writeFile(operation, JSON.stringify({ pid: process.pid, nonce: 'live' }));
  await fs.writeFile(reclaim, JSON.stringify({ pid: dead, nonce: 'old' }));
  assert.deepEqual(await f.manager.lockStatus(), [
    { name: 'operation.lock', state: 'active' }, { name: 'operation.lock.reclaim', state: 'stale' },
  ]);
  await fs.writeFile(operation, '');
  const before = await fs.readFile(reclaim);
  assert.equal((await f.manager.lockStatus())[0].state, 'unknown');
  assert.deepEqual(await fs.readFile(reclaim), before);
  await fs.unlink(operation); await fs.symlink(reclaim, operation);
  assert.equal((await f.manager.lockStatus())[0].state, 'unknown');
});

test('cancelling recovery leaves the previous receipt and never installs', async t => {
  const f = await fixture(t);
  await f.manager.run('1.0.0');
  const before = await fs.readFile(f.manager.receiptPath);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.manager.restore(abort.signal), { name: 'AbortError' });
  assert.equal(f.installs.length, 1);
  assert.deepEqual(await fs.readFile(f.manager.receiptPath), before);
});
