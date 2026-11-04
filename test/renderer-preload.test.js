'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const vm = require('node:vm');

// Exercise browser-visible behavior without a local Codex install or history.
const before = `function(load,deps){let e=document.getElementsByTagName(\`link\`),i=document.querySelector(\`meta[property=csp-nonce]\`);return Promise.all(deps.map(t=>{let r=t.endsWith(\`.css\`);for(let n=e.length-1;n>=0;n--){let i=e[n];if(i.href===t&&(!r||i.rel===\`stylesheet\`))return}let i=document.createElement('link');i.href=t;i.rel=r?'stylesheet':'modulepreload';if(document.head.appendChild(i),r)return new Promise((resolve,reject)=>{i.addEventListener('load',resolve);i.addEventListener('error',()=>reject(Error('CSS failed')))});})).then(load);}`;
const replacements = JSON.parse(execFileSync('python3', ['-c',
  'import json,sys;sys.path.insert(0,sys.argv[1]);from renderer_adapter import REPLACEMENTS;print(json.dumps(REPLACEMENTS))',
  path.resolve(__dirname, '../scripts')], { encoding: 'utf8' }));
let after = before;
for (const [old, replacement] of replacements) after = after.replace(old, replacement);

async function exercise(deps, { existing = [], failCss = false, failImport = false } = {}) {
  const links = existing.map(link => ({ ...link })), added = [];
  let imports = 0;
  const preload = vm.runInNewContext('(' + after + ')', { Map, Promise, document: {
    getElementsByTagName: () => links,
    querySelector: () => null,
    createElement: () => ({ addEventListener(type, callback) {
      if (type === (failCss ? 'error' : 'load')) queueMicrotask(callback);
    } }),
    head: { appendChild(link) { links.push(link); added.push({ href: link.href, rel: link.rel }); } },
  } });
  let error, result;
  try { result = await preload(async () => { imports++; if (failImport) throw Error('Import failed'); return 'loaded'; }, deps); }
  catch (failure) { error = failure.message; }
  return { added, imports, result, error };
}

test('cold preload keeps CSS and real imports without thousands of eager script hints', async () => {
  const deps = Array.from({ length: 3045 }, (_, i) => `module-${i}.js`)
    .concat(Array.from({ length: 158 }, (_, i) => `style-${i}.css`));
  const result = await exercise(deps);
  assert.equal(result.added.length, 158);
  assert.ok(result.added.every(link => link.rel === 'stylesheet'));
  assert.equal(result.imports, 1);
  assert.equal(result.result, 'loaded');
});

test('CSS deduplication and stylesheet/import failures keep their browser behavior', async () => {
  const result = await exercise(['a.css', 'a.css', 'b.css', 'c.js'], {
    existing: [{ href: 'a.css', rel: 'stylesheet' }, { href: 'b.css', rel: 'modulepreload' }],
  });
  assert.deepEqual(result.added, [{ href: 'b.css', rel: 'stylesheet' }]);
  assert.equal(result.imports, 1);
  const css = await exercise(['bad.css'], { failCss: true });
  assert.equal(css.error, 'CSS failed');
  assert.equal(css.imports, 0);
  const imported = await exercise(['module.js'], { failImport: true });
  assert.equal(imported.error, 'Import failed');
  assert.equal(imported.imports, 1);
});
