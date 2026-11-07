'use strict';

const { t, errorText } = require('./i18n');

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
}

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
}

async function helperHash(helper) {
  const hash = createHash('sha256');
  for (const name of ['package.json', 'extension.js', 'sessions.js', 'titles.js', 'badges.js',
    'i18n.js', 'ui-language.js', 'translations/en.json', 'translations/ru.json', 'package.nls.json', 'package.nls.ru.json',
    'native-bridge.cjs', 'update-core.js', 'update-ui.js', 'compatibility.json',
    'scripts/native_adapter.py', 'scripts/renderer_adapter.py', 'scripts/update_package.py', 'scripts/read_history.py', 'test/update-probe.js']) {
    hash.update(name); hash.update(await fs.readFile(path.join(helper, name)));
  }
  return hash.digest('hex');
}

function hostPlatform() {
  return `${process.platform}-${process.arch}`;
}

function profileFor(profiles, version, platform = hostPlatform()) {
  return profiles.find(profile => profile.version === version && profile.platform === platform);
}

function supportedProfile(profiles, platform = hostPlatform()) {
  return profiles.filter(profile => profile.platform === platform).at(-1);
}

// A new chat may take as long as the Codex startup watchdog allows, plus a margin.
function newChatWaitMs(profile) {
  return Math.max(45000, (profile?.startupTimeoutMs ?? 0) + 15000);
}

async function inspectInstalled(folder, profiles, helper) {
  if (!folder) return { status: 'missing', message: t('health.missing') };
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')); }
  catch { return { status: 'unreadable', message: t('health.unreadable') }; }
  const profile = profileFor(profiles, pkg.version);
  if (pkg.publisher?.toLowerCase() !== 'openai' || pkg.name !== 'chatgpt' || !profile) {
    return { status: 'unsupported', version: pkg.version, message: t('health.unsupported', { version: pkg.version }) };
  }
  try {
    const source = await hashFile(path.join(folder, 'out/extension.js'));
    if (source === profile.sourceSha256) return { status: 'adapter-missing', version: pkg.version,
      message: t('health.adapterMissing') };
    const [bridge, expectedBridge, backup] = await Promise.all([
      hashFile(path.join(folder, 'out/session-tabs-native.cjs')),
      hashFile(path.join(helper, 'native-bridge.cjs')),
      hashFile(path.join(folder, 'out/extension.js.before-session-tabs')),
    ]);
    if (source !== profile.patchedSourceSha256 || bridge !== expectedBridge || backup !== profile.sourceSha256) {
      return { status: 'changed', version: pkg.version, message: t('health.changed') };
    }
    if (profile.renderer) {
      const renderer = await hashFile(path.join(folder, profile.renderer.path));
      const originalRenderer = await hashFile(path.join(folder, 'out/session-tabs-renderer-original.js'));
      if (renderer !== profile.renderer.patchedSha256 || originalRenderer !== profile.renderer.originalSha256) {
        return { status: 'changed', version: pkg.version, message: t('health.rendererChanged') };
      }
    }
    return { status: 'ready', version: pkg.version, message: t('health.ready', { version: pkg.version }) };
  } catch { return { status: 'changed', version: pkg.version, message: t('health.damaged') }; }
}

async function downloadOfficial(profile, file, signal, fetcher = fetch) {
  const url = new URL(profile.url);
  if (url.protocol !== 'https:' || url.hostname !== 'marketplace.visualstudio.com'
    || !url.pathname.startsWith('/_apis/public/gallery/publishers/OpenAI/vsextensions/chatgpt/')) {
    throw new Error(t('update.officialOnly'));
  }
  const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180000)]);
  const response = await fetcher(url, { signal: boundedSignal });
  if (!response.ok || !response.body) throw new Error(t('update.downloadFailed', { status: response.status }));
  const hash = createHash('sha256');
  let size = 0;
  const stream = await fs.open(file, 'wx', 0o600);
  try {
    // fetch decodes HTTP gzip; checksum is for the actual VSIX, not transport bytes.
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > 1500 * 1024 * 1024) throw new Error(t('update.tooLarge'));
      hash.update(chunk); await stream.writeFile(chunk);
    }
  } finally { await stream.close(); }
  if (hash.digest('hex') !== profile.vsixSha256) throw new Error(t('update.badChecksum'));
}

class UpdateManager {
  constructor({ storage, helper, profiles, prepare, verifyCandidate, probe, install, download = downloadOfficial, confirmInstall, isBusy = () => false }) {
    if (typeof verifyCandidate !== 'function') throw new Error(t('update.verifierRequired'));
    Object.assign(this, { storage, helper, profiles, prepare, verifyCandidate, probe, install, download, confirmInstall, isBusy });
    this.receiptPath = path.join(storage, 'recovery.json');
  }
  async locked(action) {
    await fs.mkdir(this.storage, { recursive: true, mode: 0o700 });
    const file = path.join(this.storage, 'operation.lock');
    const nonce = randomUUID();
    let handle;
    try { handle = await fs.open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error(t('update.badLock'));
      const previous = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error(t('update.lockUnverified'));
      try { process.kill(previous.pid, 0); throw new Error(t('update.alreadyRunning')); }
      catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
      await fs.unlink(file);
      handle = await fs.open(file, 'wx', 0o600);
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
    await handle.close();
    try { return await action(); }
    finally {
      try {
        if (JSON.parse(await fs.readFile(file, 'utf8')).nonce === nonce) await fs.unlink(file);
      } catch { /* A lock owned by another process must not be removed. */ }
    }
  }
  async recovery({ checkFile = true } = {}) {
    try {
      const receipt = JSON.parse(await fs.readFile(this.receiptPath, 'utf8'));
      if (!/^[a-f0-9]{64}$/.test(receipt.sha256) || !profileFor(this.profiles, receipt.version)
        || receipt.helper !== await helperHash(this.helper)) return undefined;
      const file = path.join(this.storage, `${receipt.sha256}.vsix`);
      if (checkFile ? await hashFile(file) !== receipt.sha256 : !(await fs.stat(file)).isFile()) return undefined;
      return { ...receipt, file };
    } catch { return undefined; }
  }
  async run(version, signal) {
    return this.locked(async () => {
      if (this.isBusy()) throw new Error(t('update.waitForReplies'));
      const profile = profileFor(this.profiles, version);
      if (!profile) throw new Error(t('update.unsupported', { version }));
      const build = await helperHash(this.helper);
      const job = await fs.mkdtemp(path.join(this.storage, 'job-'));
      try {
      const original = path.join(job, 'official.vsix');
      await this.download(profile, original, signal);
      signal?.throwIfAborted();
      // Verify again independently of the downloader and before extraction/execution.
      if (await hashFile(original) !== profile.vsixSha256) throw new Error(t('update.originalChecksum'));
      const candidate = await this.prepare(original, job, profile, signal);
      const candidateHash = await hashFile(candidate.vsix);
      await this.verifyCandidate(candidate, signal);
      const attempt = randomUUID();
      const evidence = await this.probe(candidate, job, { attempt, helper: build }, signal);
      const required = ['isolation', 'nativeTabs', 'titles', 'completion', 'acknowledgement', 'nativeNewChat', 'interface', 'language'];
      if (evidence.attempt !== attempt || evidence.helper !== build || evidence.success !== true
        || evidence.version !== version || !required.every(key => evidence.checks?.[key] === true)) {
        throw new Error(t('update.probeFailed'));
      }
      if (await hashFile(candidate.vsix) !== candidateHash || await helperHash(this.helper) !== build) {
        throw new Error(t('update.filesChanged'));
      }
      await this.verifyCandidate(candidate, signal);
      signal?.throwIfAborted();
      if (this.isBusy()) throw new Error(t('update.sessionStarted'));
      const cached = path.join(this.storage, `${candidateHash}.vsix`);
      try { await fs.copyFile(candidate.vsix, cached, require('node:fs').constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST' || await hashFile(cached) !== candidateHash) throw error; }
      const receipt = { version, sha256: candidateHash, helper: build, verifiedAt: new Date().toISOString() };
      // Save a proved recovery before touching the installed version. Never discard
      // an existing known-good recovery when admitting a newer candidate.
      const previous = await this.recovery();
      if (!previous) await atomicJson(this.receiptPath, receipt);
      if (!await this.confirmInstall(version)) return { status: 'verified', version };
      if (this.isBusy()) throw new Error(t('update.busy'));
      signal?.throwIfAborted();
      if (await hashFile(cached) !== candidateHash) throw new Error(t('update.savedChanged'));
      try { await this.install(cached, version); }
      catch (error) {
        throw new Error(t('update.installFailed', { message: errorText(error) }));
      }
      // Keep the previously proved recovery A when installing B. A clean-profile
      // probe is not proof that B will start with the user's real data after reload.
      if (!previous) await atomicJson(this.receiptPath, receipt);
      return { status: 'installed', version };
      } finally { await fs.rm(job, { recursive: true, force: true }); }
    });
  }
  async restore() {
    return this.locked(async () => {
      if (this.isBusy()) throw new Error(t('update.waitForReplies'));
      const saved = await this.recovery();
      if (!saved) throw new Error(t('update.noRecovery'));
      if (!await this.confirmInstall(saved.version, true)) return { status: 'cancelled' };
      if (this.isBusy() || await hashFile(saved.file) !== saved.sha256) throw new Error(t('update.restorePostponed'));
      await this.install(saved.file, saved.version);
      return { status: 'restored', version: saved.version };
    });
  }
}

module.exports = { hashFile, atomicJson, helperHash, hostPlatform, profileFor, supportedProfile, newChatWaitMs, inspectInstalled, downloadOfficial, UpdateManager };
