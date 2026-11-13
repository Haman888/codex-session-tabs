'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('Python downloader preserves pre-existing destinations and removes its rejected downloads', () => {
  const script = `
import hashlib, importlib.util, io, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location('update_package', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Response(io.BytesIO):
    headers = {}
    url = 'https://openai.gallerycdn.vsassets.io/package.vsix'
profile = {'url': 'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/OpenAI/vsextensions/chatgpt/1.0.0/vspackage', 'vsixSha256': hashlib.sha256(b'approved').hexdigest()}
with tempfile.TemporaryDirectory(prefix='cst-download-') as folder:
    output = pathlib.Path(folder) / 'package.vsix'
    module.urllib.request.urlopen = lambda *a, **kw: Response(b'wrong bytes')
    output.write_bytes(b'existing recovery')
    try:
        module.download_official(profile, output)
        raise AssertionError('Existing file accepted')
    except FileExistsError:
        pass
    assert output.exists() and output.read_bytes() == b'existing recovery', 'Pre-existing recovery was deleted'
    output.unlink()
    try:
        module.download_official(profile, output)
        raise AssertionError('Wrong checksum accepted')
    except ValueError:
        pass
    assert not output.exists(), 'Rejected package was left behind'
    module.urllib.request.urlopen = lambda *a, **kw: Response(b'approved')
    module.download_official(profile, output)
    assert output.read_bytes() == b'approved'
`;
  const result = spawnSync('python3', ['-B', '-c', script, path.join(__dirname, '../scripts/update_package.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
