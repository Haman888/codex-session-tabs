'use strict';
require('../i18n').setLanguage('ru');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function runner() {
  const file = path.resolve(__dirname, '../update-ui.js');
  const nativeRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(file, 'utf8'), {
    module, process, setTimeout, clearTimeout, Buffer,
    require: name => name === 'vscode' ? {} : nativeRequire(name),
  });
  return module.exports.runChild;
}

test('a final probe report closes an unresponsive isolated process; a partial report times out', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cst-process-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const runChild = await runner();
  const report = path.join(folder, 'report.json');
  const childCode = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],JSON.stringify({finished:process.argv[2]==='final',pid:process.pid}));setInterval(()=>{},1000);`;
  const completed = async () => JSON.parse(await fs.readFile(report, 'utf8')).finished === true;
  await runChild(process.execPath, ['-e', childCode, report, 'final'], { timeout: 5000, resultReady: completed });
  const { pid } = JSON.parse(await fs.readFile(report, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await fs.rm(report);
  await assert.rejects(runChild(process.execPath, ['-e', childCode, report, 'partial'],
    { timeout: 5000, resultReady: completed }), /превысила допустимое время/);
  const partial = JSON.parse(await fs.readFile(report, 'utf8'));
  assert.throws(() => process.kill(partial.pid, 0), { code: 'ESRCH' });
});

test('a final report cannot override user cancellation or an elapsed deadline', async () => {
  const runChild = await runner();
  const controller = new AbortController();
  await assert.rejects(runChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    signal: controller.signal,
    resultReady: async () => { controller.abort(); return true; },
  }), /отменена/);
  await assert.rejects(runChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    timeout: 50,
    resultReady: async () => true,
  }), /превысила допустимое время/);
});
