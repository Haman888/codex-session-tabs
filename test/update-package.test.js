'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeTemp } = require('./temp');

test('package preparation rejects traversal, links, duplicates and wrong hashes; preserves native executable bits', async t => {
  const root = await makeTemp('package-unit-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = String.raw`
from pathlib import Path
import hashlib,importlib.util,json,sys,zipfile
root=Path(sys.argv[1]);module_path=Path(sys.argv[2])
spec=importlib.util.spec_from_file_location('update_package',module_path)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
helper=root/'helper';(helper/'scripts').mkdir(parents=True)
(helper/'scripts/native_adapter.py').write_text("from pathlib import Path\nimport sys\np=Path(sys.argv[-1])/'out'\n(p/'extension.js').write_text('patched')\n(p/'extension.js.before-session-tabs').write_text('source')\n(p/'session-tabs-native.cjs').write_text('bridge')\n(p/'session-tabs-backup.json').write_text('{}')\n")
sha=lambda data:hashlib.sha256(data).hexdigest()
for case in ['valid','traversal','symlink','duplicate','alias','wrong-hash']:
    artifact=root/(case+'.vsix')
    with zipfile.ZipFile(artifact,'w') as z:
        z.writestr('extension/package.json',json.dumps({'name':'chatgpt','publisher':'openai','version':'26.1021.22027'}))
        z.writestr('extension/out/extension.js','source')
        native=zipfile.ZipInfo('extension/bin/codex');native.external_attr=0o100755<<16;z.writestr(native,'native fixture')
        if case=='traversal':z.writestr('../outside','bad')
        if case=='symlink':
            link=zipfile.ZipInfo('extension/link');link.external_attr=0o120777<<16;z.writestr(link,'../../outside')
        if case=='duplicate':z.writestr('extension/out/extension.js','source')
        if case=='alias':z.writestr('extension//out/extension.js','source')
    profile={'version':'26.1021.22027','sourceSha256':sha(b'source'),'patchedSourceSha256':sha(b'patched'),'vsixSha256':sha(artifact.read_bytes()) if case!='wrong-hash' else 'bad'}
    target=root/(case+'-prepared')
    if case=='valid':
        result=module.prepare(artifact,target,helper,profile)
        assert (Path(result['vendor'])/'bin/codex').stat().st_mode&0o111
        with zipfile.ZipFile(result['vsix']) as z:
            assert z.read('extension/out/extension.js')==b'patched'
            assert z.read('extension/out/session-tabs-native.cjs')==b'bridge'
    else:
        try:module.prepare(artifact,target,helper,profile)
        except ValueError:pass
        else:raise AssertionError(case+' was accepted')
        assert not target.exists(),case+' changed the destination'
assert not (root.parent/'outside').exists()
print('6 package safety scenarios passed')
`;
  const output = execFileSync('python3', ['-c', script, root, path.resolve(__dirname, '../scripts/update_package.py')], { encoding: 'utf8' });
  assert.match(output, /6 package safety scenarios passed/);
});

test('Marketplace metadata caps both raw and gzip-expanded bytes and accepts valid stable metadata offline', () => {
  const script = String.raw`
import gzip,importlib.util,io,json,sys
spec=importlib.util.spec_from_file_location('update_package',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Response(io.BytesIO):
    def __init__(self,data,encoding='identity'):
        super().__init__(data);self.headers={'Content-Encoding':encoding}
for encoding in ['identity','gzip']:
    encode=gzip.compress if encoding=='gzip' else lambda value:value
    assert module.read_metadata(Response(encode(b'x'*128),encoding),128)==b'x'*128
    for size in [129,4096]:
        try:module.read_metadata(Response(encode(b'x'*size),encoding),128)
        except ValueError:pass
        else:raise AssertionError('Over-limit '+encoding+' accepted')
payload=json.dumps({'results':[{'extensions':[{'publisher':{'publisherName':'OpenAI'},'extensionName':'chatgpt','versions':[
    {'version':'26.1.1','targetPlatform':'darwin-arm64'},
    {'version':'99.0.0','targetPlatform':'darwin-arm64','properties':[{'key':'Microsoft.VisualStudio.Code.PreRelease','value':'true'}]},
    {'version':'98.0.0','targetPlatform':'linux-x64'}]}]}]}).encode()
module.urllib.request.urlopen=lambda request,timeout:Response(gzip.compress(payload),'gzip')
assert module.latest_stable('darwin-arm64')=={'latest':'26.1.1'}
try:module.latest_stable('darwin-x64')
except ValueError:pass
else:raise AssertionError('A package for another processor was accepted')
print('Bounded raw/gzip metadata and offline selection passed')
`;
  const output = execFileSync('python3', ['-c', script, path.resolve(__dirname, '../scripts/update_package.py')], {
    encoding: 'utf8', timeout: 10000,
  });
  assert.match(output, /Bounded raw\/gzip metadata and offline selection passed/);
});
