"""Install/restore reviewed native hooks and the renderer preload fix."""
from pathlib import Path
import argparse
import json
import re

from renderer_adapter import digest, inside, profile_for, read_optional, renderer_plan, transact

ROOT = Path(__file__).resolve().parent.parent
LEGACY_BRIDGE = '58e379627717ccb9e20862cc40ab1e7879919e328c9fc9a92a36629562b9bfd1'
TIMEOUT_ANCHOR = 'timeoutMs:3e4})},3e4)}'


def startup_timeout(profile):
    value = (profile or {}).get('startupTimeoutMs')
    if value is None:
        return None
    if type(value) is not int or not 30000 <= value <= 300000:
        raise ValueError('Invalid startup timeout in the reviewed profile.')
    return value


def patch_native(original, profile=None):
    text = original.decode('utf-8')
    timeout = startup_timeout(profile)
    attach_anchor = 'i!=null&&this.registerOnDidDisposeForWebviewPanel(r,i),await this.initializeWebview(r.webview,"panel",r.onDidDispose,()=>{this.onPanelReady(r)})'
    message_anchor = 'async handleMessage(e,r){switch(r.type){case"ready":break;'
    new_match = re.findall(r'async createNewPanel\(\)\{let e=([A-Za-z_$][\w$]*)\("/extension/panel/new"\),', text)
    startup_match = re.findall(r'startup:\{reach:([A-Za-z_$][\w$]*)=>o\.handleStartupPhase\(\1\)\}', text)
    if len(new_match) != 1 or len(startup_match) != 1:
        raise ValueError('Codex editor structure does not match this adapter.')
    route, phase = new_match[0], startup_match[0]
    new_anchor = f'async createNewPanel(){{let e={route}("/extension/panel/new"),'
    navigate_anchor = f'case"navigate-in-new-editor-tab":{{let n={route}(r.path);'
    startup_anchor = f'startup:{{reach:{phase}=>o.handleStartupPhase({phase})}}'
    watchdog_anchor = 'e.html=await this.getWebviewContent(e),s.start()'
    for anchor in [attach_anchor, message_anchor, new_anchor, navigate_anchor, startup_anchor, watchdog_anchor]:
        if text.count(anchor) != 1:
            raise ValueError('Codex editor structure does not match this adapter.')
    if timeout is not None and text.count(TIMEOUT_ANCHOR) != 1:
        raise ValueError('Codex startup watchdog does not match this adapter.')
    patched = text.replace(attach_anchor, 'i!=null&&this.registerOnDidDisposeForWebviewPanel(r,i),await require("./session-tabs-native.cjs").attach(this,r,e.uri,i),await require("./session-tabs-native.cjs").initializePanel(this,r,()=>this.initializeWebview(r.webview,"panel",r.onDidDispose,()=>{this.onPanelReady(r)}))')
    patched = patched.replace(message_anchor, 'async handleMessage(e,r){require("./session-tabs-native.cjs").observe(this,e,r);switch(r.type){case"ready":break;')
    patched = patched.replace(new_anchor, f'async createNewPanel(){{if(await require("./session-tabs-native.cjs").openFreshPanel(this))return;let e=require("./session-tabs-native.cjs").freshPanelUri({route}("/extension/panel/new")),')
    patched = patched.replace(navigate_anchor, f'case"navigate-in-new-editor-tab":{{if(r.path==="/extension/panel/new"&&await require("./session-tabs-native.cjs").openFreshPanel(this,e,r.replaceCurrentEditor))break;let n=require("./session-tabs-native.cjs").freshPanelUri({route}(r.path));')
    patched = patched.replace(startup_anchor, f'startup:{{reach:{phase}=>{{o.handleStartupPhase({phase}),require("./session-tabs-native.cjs").startupPhase(this,e,{phase})}}}}')
    patched = patched.replace(watchdog_anchor, 'e.html=await this.getWebviewContent(e),require("./session-tabs-native.cjs").watchPanelStartup(e,s)')
    if timeout is not None:
        patched = patched.replace(TIMEOUT_ANCHOR, f'timeoutMs:{timeout}}})}},{timeout})}}')
    return patched.encode('utf-8')


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--extension-dir', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--restore', action='store_true')
    mode.add_argument('--check', action='store_true')
    parser.add_argument('--platform')
    args = parser.parse_args()
    extension = args.extension_dir.resolve()
    package = json.loads(inside(extension, 'package.json').read_text())
    if package.get('publisher', '').lower() != 'openai' or package.get('name') != 'chatgpt':
        raise ValueError('Refusing to modify an unrelated extension.')
    source = inside(extension, 'out/extension.js')
    backup = inside(extension, 'out/extension.js.before-session-tabs')
    manifest = inside(extension, 'out/session-tabs-backup.json')
    bridge = inside(extension, 'out/session-tabs-native.cjs')
    current, saved, state_bytes = read_optional(source), read_optional(backup), read_optional(manifest)
    profile = profile_for(ROOT, package.get('version'), args.platform, (saved, current))
    if current is None:
        raise ValueError('The native editor is missing.')
    state = json.loads(state_bytes) if state_bytes is not None else None
    bridge_current = read_optional(bridge)
    bridge_source = (ROOT / 'native-bridge.cjs').read_bytes()
    if state is not None:
        if state.get('version') != package['version']:
            raise ValueError('Backup belongs to another Codex version; refusing to overwrite it.')
        if saved is None or digest(current) != state.get('patchedSha256') or digest(saved) != state.get('originalSha256'):
            raise ValueError('Native editor or its backup changed after adapter installation.')
        approved_bridge = ([state['bridgeSha256']] if state.get('bridgeSha256') else
                           profile.get('legacyBridgeSha256s', [LEGACY_BRIDGE]) + [digest(bridge_source)])
        if bridge_current is not None and digest(bridge_current) not in approved_bridge:
            raise ValueError('Native bridge changed after adapter installation.')
        original = saved
    else:
        if args.restore:
            raise ValueError('No adapter backup is installed.')
        if b'session-tabs-native.cjs' in current:
            raise ValueError('Adapter hooks exist without a verified backup.')
        original = current
        if saved is not None and saved != original:
            raise ValueError('An unrelated native editor backup already exists.')
        if bridge_current is not None and digest(bridge_current) not in [LEGACY_BRIDGE, digest(bridge_source)]:
            raise ValueError('An unrelated native bridge already exists.')

    if profile.get('sourceSha256') and digest(original) != profile['sourceSha256']:
        raise ValueError('Native original checksum does not match the reviewed profile.')
    renderer_changes, renderer_state, renderer_current = renderer_plan(extension, profile, state, args.restore)
    if args.restore:
        changes = {source: original, **renderer_changes, bridge: None, backup: None, manifest: None}
        transact(changes)
        print('Original Codex editor and renderer restored. Reload the VS Code window to activate them.')
        return

    patched = patch_native(original, profile)
    if profile.get('patchedSourceSha256') and digest(patched) != profile['patchedSourceSha256']:
        raise ValueError('Patched editor checksum does not match the reviewed profile.')
    if args.check:
        up_to_date = bool(state and current == patched and bridge_current == bridge_source and renderer_current)
        print(json.dumps({'version': package['version'], 'compatible': True,
                          'alreadyInstalled': state is not None, 'upToDate': up_to_date,
                          'rendererFixInstalled': bool(state and state.get('renderer') and renderer_current)}))
        return

    result = {'version': package['version'], 'originalSha256': digest(original),
              'patchedSha256': digest(patched), 'bridgeSha256': digest(bridge_source),
              'renderer': renderer_state, 'formatVersion': 2}
    changes = {backup: original, **renderer_changes, bridge: bridge_source, source: patched,
               manifest: (json.dumps(result, indent=2) + chr(10)).encode()}
    transact(changes)
    print(f'Installed checked native and renderer adapters for Codex {package["version"]}. Original files backed up. Reload the VS Code window to activate them.')


if __name__ == '__main__':
    try:
        run()
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as error:
        raise SystemExit(str(error))
