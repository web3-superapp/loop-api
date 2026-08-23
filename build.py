#!/usr/bin/env python3
"""从 src/ 合并出 app.html（勿手改 app.html / main.html）。

  src/head.html          <meta> 与 <title>
  src/style.css          全部样式，含 <!--FONTS--> 占位（由 fonts.css 注入）
  src/shell-open.html     pitch 侧栏 + phone 壳 + <div class="viewport">
  src/screens/*.html      每屏一个片段，顺序由 screens-order.txt 决定
  src/shell-close.html    固定层：群聊头/输入框/通话条/tabbar/sheets/toast
  src/scripts-order.txt   唯一脚本顺序，合并到一个内联 <script>

顺序文件 screens-order.txt 是唯一的屏序真相；新增屏 = 建片段 + 在该文件里加一行。
"""
import hashlib
import json
import pathlib
import re
import sys

root = pathlib.Path(__file__).parent
src = root / 'src'
resolved_src = src.resolve()
screens_dir = src / 'screens'
resolved_screens_dir = screens_dir.resolve()
EXPECTED_SCREENS = (
    'splash',
    'auth',
    'auth-otp',
    'auth-wallet',
    'wallet-create',
    'wallet-backup',
    'seed-show',
    'seed-verify',
    'wallet-import',
    'home',
    'pay',
    'notifications',
    'search',
    'market',
    'perp-markets',
    'perp-market',
    'perp-order',
    'perp-confirm',
    'perp-positions',
    'perp-orders',
    'perp-position',
    'perp-account',
    'perp-transfer',
    'perp-deposit',
    'perp-funding',
    'perp-risk-notice',
    'token',
    'launchpad',
    'chat',
    'group',
    'wallet',
    'asset',
    'send',
    'send-to',
    'send-confirm',
    'receive',
    'tx-result',
    'swap',
    'dapp',
    'profile',
    'privacy',
    'security',
)
EXPECTED_SCRIPTS = (
    'vendor/qrcode-generator-1.4.4.js',
    'wallet-provider.js',
    'wallet-review.js',
    'wallet-transfer.js',
    'stream-chat-provider.js',
    'platform-provider.js',
    'platform-offline-fixture.js',
    'perp-read-provider.js',
    'perp-offline-fixture.js',
    'perp-account-provider.js',
    'perp-account-offline-fixture.js',
    'app.js',
)
EXPECTED_VENDOR_LOCK = {
    'name': 'qrcode-generator',
    'version': '1.4.4',
    'license': 'MIT',
    'npm_integrity': 'sha512-HM7yY8O2ilqhmULxGMpcHSF1EhJJ9yBj8gvDEuZ6M+KGJ0YY2hKpnXvRD+hZPLrDVck3ExIGhmPtSdcjC+guuw==',
    'source': 'https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-1.4.4.tgz',
    'file': 'vendor/qrcode-generator-1.4.4.js',
    'sha256': '18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780',
    'license_file': 'vendor/qrcode-generator.LICENSE.txt',
    'license_sha256': '3a850fa5f08101db6f40676c2786e10bd2cd5fff7b12ffdf1e0c434d4e49d90c',
}


def read(rel):
    p = src / rel
    if not p.exists():
        sys.exit(f'missing source: {p.relative_to(root)}')
    return p.read_text().rstrip('\n')


screen_manifest_path = src / 'screens-order.txt'
if not screen_manifest_path.is_file():
    sys.exit('missing source: src/screens-order.txt')
order = screen_manifest_path.read_text().splitlines()
if any(not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', name) for name in order):
    sys.exit('screens-order.txt entries must be non-empty normalized safe basenames')
if len(order) != len(set(order)):
    sys.exit('screens-order.txt contains duplicate entries')
if order != list(EXPECTED_SCREENS):
    sys.exit('screens-order.txt must contain the exact pinned 42-screen order')

screen_paths = {}
for name in order:
    candidate = screens_dir / f'{name}.html'
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(resolved_screens_dir)
    except (FileNotFoundError, RuntimeError, ValueError):
        sys.exit(f'screen source escapes src/screens or is missing: {name}.html')
    if not resolved.is_file():
        sys.exit(f'screen source is not a regular file: {name}.html')
    screen_paths[name] = resolved

scripts_order = read('scripts-order.txt').split('\n')


def confined_source_file(relative, label, *, require_js=False):
    if not isinstance(relative, str) or not relative or '\\' in relative:
        sys.exit(f'{label} must be a normalized relative POSIX path: {relative!r}')
    parts = relative.split('/')
    if any(part in {'', '.', '..'} for part in parts):
        sys.exit(f'{label} must be a normalized relative POSIX path: {relative!r}')
    pure = pathlib.PurePosixPath(relative)
    if pure.is_absolute() or pure.as_posix() != relative:
        sys.exit(f'{label} must be a normalized relative POSIX path: {relative!r}')
    if require_js and pure.suffix != '.js':
        sys.exit(f'{label} must name a .js file: {relative}')
    candidate = src.joinpath(*pure.parts)
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(resolved_src)
    except (FileNotFoundError, RuntimeError, ValueError):
        sys.exit(f'{label} escapes src or is missing: {relative}')
    if not resolved.is_file():
        sys.exit(f'{label} is not a file: {relative}')
    return resolved


if scripts_order != list(EXPECTED_SCRIPTS):
    sys.exit('scripts-order.txt must contain the exact pinned twelve-script order')
script_paths = {
    name: confined_source_file(name, 'script manifest entry', require_js=True)
    for name in scripts_order
}


def ignored_source_js(path):
    relative = path.relative_to(src)
    return path.name.startswith('._') or (
        len(relative.parts) > 1 and relative.parts[0] == 'test-fixtures')


source_js = {
    path.relative_to(src).as_posix()
    for path in src.rglob('*.js')
    if not ignored_source_js(path)
}
if source_js != set(scripts_order):
    missing = sorted(set(scripts_order) - source_js)
    orphan = sorted(source_js - set(scripts_order))
    sys.exit('script manifest/source inventory mismatch: '
             f'missing={missing}, orphan={orphan}')

lock_path = src / 'vendor/vendor-lock.json'


def strict_json_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f'duplicate key: {key}')
        value[key] = item
    return value


try:
    vendor_lock = json.loads(lock_path.read_text(), object_pairs_hook=strict_json_object)
except FileNotFoundError:
    sys.exit('missing source: src/vendor/vendor-lock.json')
except (json.JSONDecodeError, ValueError) as error:
    sys.exit(f'invalid vendor lock JSON: {error}')
if vendor_lock != EXPECTED_VENDOR_LOCK:
    sys.exit('vendor lock must match the exact pinned schema and values')


def verify_locked_file(file_key, digest_key):
    rel = vendor_lock.get(file_key)
    expected = vendor_lock.get(digest_key)
    path = confined_source_file(rel, f'vendor lock {file_key}')
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        sys.exit(f'vendor checksum mismatch for {rel}: {actual}')


verify_locked_file('file', 'sha256')
verify_locked_file('license_file', 'license_sha256')

# macOS writes AppleDouble sidecars (._name) on non-HFS volumes such as this exFAT disk;
# they are not screens.
on_disk = {p.stem for p in screens_dir.glob('*.html')
           if not p.name.startswith('._')}
orphan = sorted(on_disk - set(order))
if orphan:
    print(f'warning: screens not in order file (skipped): {", ".join(orphan)}')

screens = '\n'.join(
    f'      <!-- ============ {n.upper()} ============ -->\n'
    + screen_paths[n].read_text().rstrip('\n')
    for n in order
)

scripts = '\n\n'.join(
    f'/* ============ SCRIPT: {name} ============ */\n'
    + script_paths[name].read_text().rstrip('\n')
    for name in scripts_order
)

style = read('style.css') + '\n' + read('stream-ui.css')
fonts = (root / 'fonts.css').read_text()
if style.count('<!--FONTS-->') != 1:
    sys.exit('style.css must contain exactly one <!--FONTS--> placeholder')
style = style.replace('<!--FONTS-->', fonts)

html = '\n'.join([
    read('head.html'),
    '<style>',
    style,
    '</style>',
    '',
    read('shell-open.html'),
    '',
    screens,
    '',
    read('shell-close.html'),
    '',
    '<script>',
    scripts,
    '</script>',
])

out = root / 'app.html'
out.write_text(html + '\n')
print(f'app.html built: {out.stat().st_size:,} bytes · {len(order)} screens')
