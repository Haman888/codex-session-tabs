"""Exact, reversible renderer fix for reviewed Codex packages only."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import platform
import re
import stat
import sys
import uuid


BACKUP = 'out/session-tabs-renderer-original.js'
REPLACEMENTS = [
    # modulepreload hints are optional; native ESM imports still fetch required
    # modules. Thousands of eager hints compete across cold webviews. Preserve
    # CSS preload promises/errors and the actual import instead.
    ('let r=t.endsWith(`.css`);', 'let r=t.endsWith(`.css`);if(!r)return;'),
    ('let e=document.getElementsByTagName(`link`),i=document.querySelector(`meta[property=csp-nonce]`)',
     'let e=new Map;for(let t of document.getElementsByTagName(`link`))e.set(t.href,(e.get(t.href)||0)|(t.rel===`stylesheet`?3:1));let i=document.querySelector(`meta[property=csp-nonce]`)'),
    ('for(let n=e.length-1;n>=0;n--){let i=e[n];if(i.href===t&&(!r||i.rel===`stylesheet`))return}',
     'if((e.get(t)||0)&(r?2:1))return;'),
    ('document.head.appendChild(i),r)return new Promise',
     'document.head.appendChild(i),e.set(t,(e.get(t)||0)|(r?3:1)),r)return new Promise'),
]


def digest(value):
    return hashlib.sha256(value).hexdigest()


def inside(root, relative):
    raw = str(relative)
    part = PurePosixPath(raw)
    if part.is_absolute() or '..' in part.parts or '\\' in raw or ':' in raw:
        raise ValueError('Adapter path escaped the extension directory.')
    target = Path(root) / part
    if not target.resolve().is_relative_to(Path(root).resolve()) or target.is_symlink():
        raise ValueError('Adapter paths must not follow external links.')
    return target


def read_optional(file):
    file = Path(file)
    if file.is_symlink():
        raise ValueError('Refusing a symlink in adapter files.')
    try:
        if not stat.S_ISREG(file.stat().st_mode):
            raise ValueError('Adapter target is not a regular file.')
        return file.read_bytes()
    except FileNotFoundError:
        return None


def host_platform():
    machine = platform.machine().lower()
    arch = {'aarch64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}.get(machine, machine)
    return f'{sys.platform}-{arch}'


def profile_for(helper, version, target=None, contents=()):
    """Pick the profile by version, then by the platform given or by the editor bytes on disk."""
    profiles = json.loads((Path(helper) / 'compatibility.json').read_text())
    candidates = [p for p in profiles if p.get('version') == version]
    if target:
        candidates = [p for p in candidates if p.get('platform') == target]
    else:
        # Python may run under Rosetta: reviewed bytes on disk decide before the processor name.
        digests = {digest(value) for value in contents if value is not None}
        known = [p for p in candidates if digests & {p.get('sourceSha256'), p.get('patchedSourceSha256')}]
        host = [p for p in (known or candidates) if p.get('platform') == host_platform()]
        candidates = host or known
    if not candidates:
        raise ValueError(f'Unsupported Codex version {version} on {target or host_platform()}; no files changed. '
                         'Use --platform darwin-arm64 or darwin-x64 for a package built for another processor.')
    profile = candidates[0]
    if 'renderer' in profile and not isinstance(profile['renderer'], dict):
        raise ValueError('Invalid reviewed renderer profile.')
    return profile


def patched_renderer(original, spec):
    if digest(original) != spec['originalSha256']:
        raise ValueError('Renderer original checksum does not match the reviewed profile.')
    text = original.decode('utf-8')
    for old, _ in REPLACEMENTS:
        if text.count(old) != 1:
            raise ValueError('Renderer preload structure does not match this adapter.')
    for old, new in REPLACEMENTS:
        text = text.replace(old, new)
    result = text.encode('utf-8')
    if digest(result) != spec['patchedSha256']:
        raise ValueError('Patched renderer checksum does not match the reviewed profile.')
    return result


def renderer_plan(extension, profile, installed_state, restore=False):
    spec = profile.get('renderer')
    if spec is None:
        if installed_state and installed_state.get('renderer') is not None:
            raise ValueError('Installed renderer backup belongs to another profile.')
        return {}, None, True
    if (not str(spec.get('path', '')).startswith('webview/assets/')
            or not str(spec.get('path', '')).endswith('.js')
            or not all(re.fullmatch(r'[a-f0-9]{64}', str(spec.get(k, '')))
                       for k in ['originalSha256', 'patchedSha256'])):
        raise ValueError('Invalid reviewed renderer profile.')
    asset = inside(extension, spec['path'])
    backup = inside(extension, BACKUP)
    tracked = installed_state.get('renderer') if installed_state else None
    if restore and tracked is None:
        return {}, None, True
    current, saved = read_optional(asset), read_optional(backup)
    if current is None:
        raise ValueError('The reviewed renderer asset is missing.')
    if tracked is not None:
        if (tracked.get('path') != spec['path'] or tracked.get('backupPath') != BACKUP
                or tracked.get('originalSha256') != spec['originalSha256']):
            raise ValueError('Installed renderer backup belongs to another profile.')
        if (saved is None or digest(saved) != spec['originalSha256']
                or digest(current) != tracked.get('patchedSha256')):
            raise ValueError('Renderer or its backup changed after adapter installation.')
        original = saved
    else:
        if digest(current) != spec['originalSha256']:
            raise ValueError('Untracked renderer changes exist; refusing to overwrite them.')
        if saved is not None and saved != current:
            raise ValueError('An unrelated renderer backup already exists.')
        original = current
    if restore:
        return {asset: original, backup: None}, None, True
    patched = patched_renderer(original, spec)
    state = {'path': spec['path'], 'backupPath': BACKUP,
             'originalSha256': spec['originalSha256'], 'patchedSha256': spec['patchedSha256'],
             'revision': 'css-preload-native-imports-v2'}
    return {backup: original, asset: patched}, state, current == patched and saved == original


def _atomic_write(file, value, mode=0o644):
    temporary = file.with_name(file.name + '.session-tabs-' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('xb') as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(mode)
        os.replace(temporary, file)
    finally:
        temporary.unlink(missing_ok=True)


def transact(changes):
    """Write preflighted bytes and roll back only writes still owned by us."""
    before = {file: read_optional(file) for file in changes}
    modes = {file: (stat.S_IMODE(file.stat().st_mode) & 0o777 if before[file] is not None else 0o644)
             for file in changes}
    written = {}
    try:
        for file, value in changes.items():
            if read_optional(file) != before[file]:
                raise ValueError('Adapter target changed during installation.')
            if value == before[file]:
                continue
            if value is None:
                file.unlink()
            else:
                _atomic_write(file, value, modes[file])
            written[file] = value
    except BaseException:
        for file, value in reversed(list(written.items())):
            if read_optional(file) != value:
                continue
            if before[file] is None:
                file.unlink(missing_ok=True)
            else:
                _atomic_write(file, before[file], modes[file])
        raise
