'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeTemp } = require('./temp');

test('an unlisted official layout is prepared without changing bundled profiles; incompatible packages are refused', async t => {
  const root = await makeTemp('forward-package-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = String.raw`
from pathlib import Path
import json,sys,zipfile,hashlib
helper=Path(sys.argv[1]);root=Path(sys.argv[2]);sys.path.insert(0,str(helper/'scripts'))
import update_package as updater
source=b'''class Native {
async resolve(e,r,i){i!=null&&this.registerOnDidDisposeForWebviewPanel(r,i),await this.initializeWebview(r.webview,"panel",r.onDidDispose,()=>{this.onPanelReady(r)})}
async handleMessage(e,r){switch(r.type){case"ready":case"request-app-server-state":break;case"navigate-in-new-editor-tab":{let n=zz9(r.path);}}}
async createNewPanel(){let e=zz9("/extension/panel/new"),r=this;}
hook(){return {startup:{reach:q=>o.handleStartupPhase(q)}}}
async initializeWebview(e){e.html=await ZZ1(this.extensionUri,e,this.webviewMetaTags(e)),s.start()}
watch(){this.timeout=setTimeout(()=>{this.timeout=void 0,this.onTimeout({elapsedMs:0,receivedWebviewMessage:!1,timeoutMs:3e4})},3e4)}
}'''
before=(helper/'compatibility.json').read_bytes()
for case in ['valid','structure','identity','platform','editor','duplicate','traversal','doctype','entity','utf16']:
    file=root/(case+'.vsix')
    package={'publisher':'OpenAI','name':'chatgpt','version':'99.1.2','main':'./out/extension.js',
      'contributes':{'customEditors':[{'viewType':'chatgpt.conversationEditor'}]}}
    if case=='identity':package['publisher']='Fake'
    if case=='editor':package['contributes']={}
    with zipfile.ZipFile(file,'w') as z:
        z.writestr('extension/package.json',json.dumps(package))
        manifest='<PackageManifest><Metadata><Identity Publisher="OpenAI" Id="chatgpt" Version="99.1.2" TargetPlatform="'+('linux-x64' if case=='platform' else 'darwin-x64')+'"/></Metadata></PackageManifest>'
        if case=='doctype':manifest='<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+manifest
        if case=='entity':manifest='<!DOCTYPE foo [<!ENTITY x "123"><!ENTITY y "&x;&x;&x;">]>'+manifest
        if case=='utf16':manifest=('<!DOCTYPE foo [<!ENTITY x "123">]>'+manifest).encode('utf-16-le')
        z.writestr('extension.vsixmanifest',manifest)
        z.writestr('extension/out/extension.js',source.replace(b's.start()',b's.begin()') if case=='structure' else source)
        if case=='duplicate':z.writestr('extension/out/extension.js',source)
        if case=='traversal':z.writestr('../outside','bad')
    if case!='valid':
        try:updater.discover_profile(file,'99.1.2','darwin-x64')
        except ValueError:pass
        else:raise AssertionError(case+' was accepted')
        continue
    profile=updater.discover_profile(file,'99.1.2','darwin-x64')
    assert profile['nativeLayout']=='shared-content-v1'
    assert profile['sourceSha256']==hashlib.sha256(source).hexdigest()
    candidate=updater.prepare(file,root/'prepared',helper,profile)
    with zipfile.ZipFile(candidate['vsix']) as z:
        patched=z.read('extension/out/extension.js')
        assert b'ZZ1(this.extensionUri,e,this.webviewMetaTags(e))' in patched
        assert b'case"request-app-server-state":break;' in patched
        assert b'watchPanelStartup(e,s)' in patched
        assert z.read('extension/out/extension.js.before-session-tabs')==source
assert (helper/'compatibility.json').read_bytes()==before
assert not (root.parent/'outside').exists()
print('Forward package preparation and 9 rejection cases passed')
`;
  const output = execFileSync('python3', ['-c', script, path.resolve(__dirname, '..'), root], { encoding: 'utf8', timeout: 30000 });
  assert.match(output, /Forward package preparation and 9 rejection cases passed/);
});

test('discovery accepts only the current stable release and rejects unsafe redirects before following them', () => {
  const script = String.raw`
import sys,urllib.request
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1])/'scripts'))
import update_package as module
module.latest_stable=lambda target:{'latest':'99.1.2'}
module.download_official=lambda *args,**kwargs:(_ for _ in ()).throw(AssertionError('Unexpected download'))
try:module.discover_latest('darwin-x64','unused','99.1.1')
except ValueError:pass
else:raise AssertionError('Non-current version accepted')
handler=module.OfficialRedirectHandler()
request=urllib.request.Request('https://marketplace.visualstudio.com/package')
for url in ['http://marketplace.visualstudio.com/x','https://example.org/x','https://marketplace.visualstudio.com.evil.test/x','https://evil.test@marketplace.visualstudio.com/x','https://marketplace.visualstudio.com:444/x']:
    try:handler.redirect_request(request,None,302,'Found',{},url)
    except ValueError:pass
    else:raise AssertionError('Unsafe redirect accepted: '+url)
assert handler.redirect_request(request,None,302,'Found',{},'https://openai.gallerycdn.vsassets.io/package').full_url=='https://openai.gallerycdn.vsassets.io/package'
print('Release and redirect boundaries passed')
`;
  assert.match(execFileSync('python3', ['-c', script, path.resolve(__dirname, '..')], { encoding: 'utf8', timeout: 10000 }), /Release and redirect boundaries passed/);
});
