'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadUsage(vscode) {
  vscode.StatusBarAlignment ??= { Right: 2 };
  vscode.window.createStatusBarItem ??= () => ({ show() {}, hide() {}, dispose() {} });
  vscode.workspace.onDidChangeConfiguration ??= () => ({ dispose() {} });
  const root = path.resolve(__dirname, '..'), cache = new Map();
  const nativeRequire = createRequire(path.join(root, 'usage.js'));
  const load = name => {
    if (name === 'vscode') return vscode;
    if (!['./usage', './native-bridge.cjs'].includes(name)) return nativeRequire(name);
    if (cache.has(name)) return cache.get(name);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, name === './usage' ? 'usage.js' : name), 'utf8'), {
      module, require: load, setTimeout, clearTimeout,
    });
    cache.set(name, module.exports); return module.exports;
  };
  return load('./usage');
}

module.exports = { loadUsage };
