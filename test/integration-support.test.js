'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { makeTemp } = require('./temp');
const support = require('./integration-support');

async function profile(t) {
  const root = await makeTemp('cst-integration-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'User/globalStorage'), { recursive: true });
  return fs.realpathSync(root);
}
const vscode = { ExtensionMode: { Test: 3 }, workspace: {} };

test('developer reports are distinct private runs and never follow an existing output link', async t => {
  const root = await profile(t), first = support.createOutput(root), second = support.createOutput(root);
  assert.notEqual(first.directory, second.directory);
  assert.equal(fs.statSync(first.directory).mode & 0o777, 0o700);
  const sentinel = path.join(root, 'sentinel');
  fs.writeFileSync(sentinel, 'unchanged');
  fs.symlinkSync(sentinel, path.join(first.directory, 'report.json'));
  first.write('report.json', '{"synthetic":true}');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  assert.equal(fs.lstatSync(path.join(first.directory, 'report.json')).isSymbolicLink(), false);
  assert.equal(fs.statSync(path.join(first.directory, 'report.json')).mode & 0o777, 0o600);
  first.write('report.json', '{"updated":true}');
  assert.equal(fs.readFileSync(path.join(first.directory, 'report.json'), 'utf8'), '{"updated":true}');
  first.write('tab-icons.png', Buffer.from('synthetic image'));
  assert.equal(fs.statSync(path.join(first.directory, 'tab-icons.png')).mode & 0o777, 0o600);
  assert.throws(() => first.write('../sentinel', 'bad'), /Unexpected/);
  assert.deepEqual(fs.readdirSync(first.directory).sort(), ['report.json', 'tab-icons.png']);
});

test('developer guards require a private temporary profile and verify actual extension mode and storage', async t => {
  const root = await profile(t);
  assert.throws(() => support.integrationEnvironment(vscode, ''), /separate private/);
  assert.equal(support.integrationEnvironment(vscode, root), root);
  assert.throws(() => support.integrationEnvironment({ workspace: { workspaceFolders: [{}] } }, root), /empty workspace/);
  fs.chmodSync(root, 0o755);
  assert.throws(() => support.integrationEnvironment(vscode, root), /private directory/);
  fs.chmodSync(root, 0o700);
  const alias = path.join(root, 'alias'); fs.symlinkSync(root, alias);
  assert.throws(() => support.integrationEnvironment(vscode, alias), /private directory/);
  const context = { extensionMode: 3, globalStorageUri: { fsPath: path.join(root, 'User/globalStorage/helper') } };
  support.integrationContext(vscode, context, root);
  assert.throws(() => support.integrationContext(vscode, { ...context, extensionMode: 1 }, root), /working VS Code/);
  const other = await profile(t);
  assert.throws(() => support.integrationContext(vscode, context, other), /working VS Code/);
});

test('integration entry refuses an ordinary launch before activation, output writes or editor commands', async t => {
  const root = await profile(t);
  let activations = 0, commands = 0;
  const mock = { ...vscode, extensions: { getExtension() { activations++; } }, commands: { executeCommand() { commands++; } } };
  const filename = path.join(__dirname, 'integration.js');
  const localRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, console, process: { env: {} },
    require: name => name === 'vscode' ? mock : name === './integration-support'
      ? { ...support, integrationEnvironment: vs => support.integrationEnvironment(vs, '') } : localRequire(name),
  });
  await assert.rejects(module.exports.run(), /separate private/);
  assert.equal(activations, 0); assert.equal(commands, 0);
  assert.deepEqual(fs.readdirSync(root), ['User']);
});

test('visual helper refuses missing private output before any debugger connection', async () => {
  await assert.rejects(require('./visual-icons').inspectTabIcons(0), /Private integration output/);
});

test('integration entry rejects mismatched real profiles before report creation or editor changes', async t => {
  const root = await profile(t), other = await profile(t);
  const filename = path.join(__dirname, 'integration.js'), localRequire = createRequire(filename);
  for (const [mode, actual] of [[1, root], [3, other]]) {
    let commands = 0;
    const context = { extensionMode: mode, globalStorageUri: { fsPath: path.join(actual, 'User/globalStorage/helper') } };
    const mock = { ...vscode,
      extensions: { getExtension: () => ({ activate: async () => ({ provider: { context } }) }) },
      commands: { executeCommand() { commands++; } },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, console, process: { env: {} },
      require: name => name === 'vscode' ? mock : name === './integration-support'
        ? { ...support, integrationEnvironment: vs => support.integrationEnvironment(vs, root) } : localRequire(name),
    });
    await assert.rejects(module.exports.run(), /working VS Code/);
    assert.equal(commands, 0);
    assert.deepEqual(fs.readdirSync(root), ['User']);
  }
});
