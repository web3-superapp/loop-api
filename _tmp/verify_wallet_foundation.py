#!/usr/bin/env python3
"""Focused verifier for deterministic wallet foundation and provider facade."""
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import atexit

from playwright.sync_api import sync_playwright
from platform_policy_test_app import production_policy_test_app


ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
APP = ROOT / 'app.html'
EXPECTED_SCREENS = [
    'splash', 'auth', 'auth-otp', 'auth-wallet', 'wallet-create',
    'wallet-backup', 'seed-show', 'seed-verify', 'wallet-import',
    'home', 'pay', 'notifications', 'search', 'market',
    'perp-markets', 'perp-market', 'perp-order', 'perp-confirm',
    'perp-positions', 'perp-orders', 'perp-position',
    'perp-account', 'perp-transfer', 'perp-deposit', 'perp-funding',
    'perp-risk-notice',
    'token', 'launchpad', 'chat', 'group',
    'wallet', 'asset', 'send', 'send-to', 'send-confirm', 'receive',
    'tx-result', 'swap', 'dapp', 'profile', 'privacy', 'security',
]
EXPECTED_SCRIPTS = [
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
]
EXPECTED_LOCK = {
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
fails = []


def check(condition, message):
    print(('  ok   ' if condition else '  FAIL ') + message)
    if not condition:
        fails.append(message)


def lines(path):
    if not path.exists():
        return []
    return [line.strip() for line in path.read_text().splitlines() if line.strip()]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def normalized_confined_file(relative, *, require_js=False):
    if not isinstance(relative, str) or not relative or '\\' in relative:
        return None
    parts = relative.split('/')
    pure = pathlib.PurePosixPath(relative)
    if (any(part in {'', '.', '..'} for part in parts) or pure.is_absolute()
            or pure.as_posix() != relative or (require_js and pure.suffix != '.js')):
        return None
    try:
        resolved = SRC.joinpath(*pure.parts).resolve(strict=True)
        resolved.relative_to(SRC.resolve())
    except (FileNotFoundError, RuntimeError, ValueError):
        return None
    return resolved if resolved.is_file() else None


def normalized_screen_file(source, name):
    if not isinstance(name, str) or not re.fullmatch(
            r'[a-z0-9]+(?:-[a-z0-9]+)*', name):
        return None
    directory = source / 'screens'
    try:
        resolved = (directory / f'{name}.html').resolve(strict=True)
        resolved.relative_to(directory.resolve(strict=True))
    except (FileNotFoundError, RuntimeError, ValueError):
        return None
    return resolved if resolved.is_file() else None


def source_owned_js():
    owned = []
    for path in SRC.rglob('*.js'):
        rel = path.relative_to(SRC)
        if path.name.startswith('._') or (
                len(rel.parts) > 1 and rel.parts[0] == 'test-fixtures'):
            continue
        owned.append(rel.as_posix())
    return sorted(owned)


def write_manifest(case_root, entries, trailing_newline=True):
    text = '\n'.join(entries) + ('\n' if trailing_newline else '')
    (case_root / 'src/scripts-order.txt').write_text(text)


def write_screen_manifest(case_root, entries, trailing_newline=True):
    text = '\n'.join(entries) + ('\n' if trailing_newline else '')
    (case_root / 'src/screens-order.txt').write_text(text)


def mutate_lock(case_root, mutation):
    path = case_root / 'src/vendor/vendor-lock.json'
    value = json.loads(path.read_text())
    mutation(value, case_root)
    path.write_text(json.dumps(value, indent=2) + '\n')


def strict_json_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f'duplicate key: {key}')
        value[key] = item
    return value


def run_build_case(label, mutation, expect_rejected=True):
    with tempfile.TemporaryDirectory(prefix='loop-wallet-foundation-') as temp:
        case_root = pathlib.Path(temp)
        shutil.copy2(ROOT / 'build.py', case_root / 'build.py')
        shutil.copy2(ROOT / 'fonts.css', case_root / 'fonts.css')
        shutil.copytree(SRC, case_root / 'src', symlinks=True)
        mutation(case_root)
        result = subprocess.run(
            [sys.executable, 'build.py'], cwd=case_root,
            text=True, capture_output=True, check=False)
        rejected = result.returncode != 0
        expected = rejected if expect_rejected else not rejected
        detail = (result.stderr or result.stdout).strip().splitlines()
        check(expected, f'builder {"rejects" if expect_rejected else "allows"} {label}'
              + (f' ({detail[-1]})' if detail else ''))


def expected_app_bytes(project_root):
    source = project_root / 'src'

    def read_source(relative):
        return (source / relative).read_text().rstrip('\n')

    screen_names = [line.strip() for line in read_source('screens-order.txt').split('\n')
                    if line.strip()]
    script_names = [line.strip() for line in read_source('scripts-order.txt').split('\n')
                    if line.strip()]
    screens = '\n'.join(
        f'      <!-- ============ {name.upper()} ============ -->\n'
        + read_source(f'screens/{name}.html')
        for name in screen_names)
    scripts = '\n\n'.join(
        f'/* ============ SCRIPT: {name} ============ */\n' + read_source(name)
        for name in script_names)
    style = (read_source('style.css') + '\n' + read_source('stream-ui.css')).replace(
        '<!--FONTS-->', (project_root / 'fonts.css').read_text())
    html = '\n'.join([
        read_source('head.html'), '<style>', style, '</style>', '',
        read_source('shell-open.html'), '', screens, '',
        read_source('shell-close.html'), '', '<script>', scripts, '</script>',
    ])
    return (html + '\n').encode()


print('== Adversarial build contract ==')
run_build_case('a duplicate screen entry', lambda case: write_screen_manifest(
    case, [*lines(case / 'src/screens-order.txt'), 'home']))


def traversal_screen(case):
    outside = case / 'outside.html'
    outside.write_text('<section class="scr" id="scr-outside"></section>\n')
    names = lines(case / 'src/screens-order.txt')
    names[names.index('home')] = '../../outside'
    write_screen_manifest(case, names)


run_build_case('a dotdot screen traversal to external HTML', traversal_screen)
run_build_case('an absolute-form screen name', lambda case: write_screen_manifest(
    case, [('/home' if name == 'home' else name)
           for name in lines(case / 'src/screens-order.txt')]))


def nested_screen(case):
    nested = case / 'src/screens/nested'
    nested.mkdir()
    shutil.copy2(case / 'src/screens/home.html', nested / 'home.html')
    write_screen_manifest(case, [('nested/home' if name == 'home' else name)
                                 for name in lines(case / 'src/screens-order.txt')])


run_build_case('a nested/slash screen name', nested_screen)
run_build_case('a dot-segment screen name', lambda case: write_screen_manifest(
    case, [('./home' if name == 'home' else name)
           for name in lines(case / 'src/screens-order.txt')]))


def backslash_screen(case):
    shutil.copy2(case / 'src/screens/home.html', case / 'src/screens/home\\screen.html')
    write_screen_manifest(case, [('home\\screen' if name == 'home' else name)
                                 for name in lines(case / 'src/screens-order.txt')])


run_build_case('a backslash screen name', backslash_screen)
run_build_case('an empty screen manifest entry', lambda case:
               (case / 'src/screens-order.txt').write_text(
                   '\n'.join(lines(case / 'src/screens-order.txt')[:2]) + '\n\n'
                   + '\n'.join(lines(case / 'src/screens-order.txt')[2:]) + '\n'))
run_build_case('a trailing blank screen manifest entry', lambda case:
               (case / 'src/screens-order.txt').write_text(
                   '\n'.join(lines(case / 'src/screens-order.txt')) + '\n\n'))
run_build_case('a whitespace-nonnormalized screen entry', lambda case:
               write_screen_manifest(case, [
                   (' home ' if name == 'home' else name)
                   for name in lines(case / 'src/screens-order.txt')]))


def underscore_screen(case):
    shutil.copy2(case / 'src/screens/home.html', case / 'src/screens/home_alt.html')
    write_screen_manifest(case, [('home_alt' if name == 'home' else name)
                                 for name in lines(case / 'src/screens-order.txt')])


run_build_case('a nonconforming underscore screen basename', underscore_screen)


def screen_symlink_escape(case):
    outside = case / 'outside-screen.html'
    target = case / 'src/screens/home.html'
    shutil.copy2(target, outside)
    target.unlink()
    target.symlink_to(outside)


run_build_case('a valid-name screen symlink escape', screen_symlink_escape)
run_build_case('an absolute script path', lambda case: write_manifest(case, [
    str((case / 'src/vendor/qrcode-generator-1.4.4.js').resolve()),
    *EXPECTED_SCRIPTS[1:],
]))
run_build_case('a dotdot script path', lambda case: write_manifest(case, [
    'vendor/../app.js', *EXPECTED_SCRIPTS[:-1],
]))


def script_symlink_escape(case):
    outside = case / 'outside.js'
    outside.write_text("globalThis.outside=true;\n")
    target = case / 'src/wallet-provider.js'
    target.unlink()
    target.symlink_to(outside)


run_build_case('a script symlink escape', script_symlink_escape)
run_build_case('a non-JavaScript manifest entry',
               lambda case: write_manifest(case, [*EXPECTED_SCRIPTS, 'style.css']))
run_build_case('a reordered script manifest',
               lambda case: write_manifest(case, list(reversed(EXPECTED_SCRIPTS))))
run_build_case('an empty script manifest entry',
               lambda case: (case / 'src/scripts-order.txt').write_text(
                   '\n'.join(EXPECTED_SCRIPTS[:2]) + '\n\n'
                   + '\n'.join(EXPECTED_SCRIPTS[2:]) + '\n'))


def extra_script(case):
    (case / 'src/extra.js').write_text("'use strict';\n")
    write_manifest(case, [*EXPECTED_SCRIPTS, 'extra.js'])


run_build_case('an extra source-owned script even when listed', extra_script)


def orphan_script(directory):
    def mutation(case):
        target = case / 'src' / directory / 'orphan.js'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("'use strict';\n")
    return mutation


run_build_case('an orphan under src/tests/', orphan_script('tests'))
run_build_case('an orphan under src/fixtures/', orphan_script('fixtures'))
run_build_case('an orphan under nested src/lib/test-fixtures/',
               orphan_script('lib/test-fixtures'))
run_build_case('a top-level src/test-fixtures/ fixture',
               orphan_script('test-fixtures'), expect_rejected=False)
run_build_case('an AppleDouble JavaScript sidecar',
               lambda case: (case / 'src/._orphan.js').write_text("ignored\n"),
               expect_rejected=False)

run_build_case('an extra vendor-lock key',
               lambda case: mutate_lock(case, lambda lock, _root:
                                        lock.__setitem__('extra', True)))
for lock_key in EXPECTED_LOCK:
    run_build_case(f'a missing vendor-lock key {lock_key}',
                   lambda case, key=lock_key: mutate_lock(
                       case, lambda lock, _root, selected=key: lock.pop(selected)))

for lock_key in ('name', 'version', 'license', 'npm_integrity', 'source'):
    run_build_case(f'a changed vendor-lock value {lock_key}',
                   lambda case, key=lock_key: mutate_lock(
                       case, lambda lock, _root, selected=key:
                       lock.__setitem__(selected, 'changed')))

for lock_key in ('sha256', 'license_sha256'):
    run_build_case(f'a changed vendor-lock digest {lock_key}',
                   lambda case, key=lock_key: mutate_lock(
                       case, lambda lock, _root, selected=key:
                       lock.__setitem__(selected, '0' * 64)))


def absolute_lock_path(lock_key, expected_path):
    return lambda case: mutate_lock(
        case, lambda lock, root: lock.__setitem__(
            lock_key, str((root / 'src' / expected_path).resolve())))


run_build_case('an absolute locked vendor path',
               absolute_lock_path('file', EXPECTED_LOCK['file']))
run_build_case('an absolute locked license path',
               absolute_lock_path('license_file', EXPECTED_LOCK['license_file']))
run_build_case('a non-normalized locked vendor path',
               lambda case: mutate_lock(case, lambda lock, _root:
                                        lock.__setitem__(
                                            'file', 'vendor/../vendor/qrcode-generator-1.4.4.js')))


def lock_symlink_escape(case):
    outside = case / 'outside-license.txt'
    target = case / 'src/vendor/qrcode-generator.LICENSE.txt'
    shutil.copy2(target, outside)
    target.unlink()
    target.symlink_to(outside)


run_build_case('a locked-file symlink escape', lock_symlink_escape)

with tempfile.TemporaryDirectory(prefix='loop-wallet-stale-') as temp:
    stale_root = pathlib.Path(temp)
    shutil.copy2(ROOT / 'fonts.css', stale_root / 'fonts.css')
    shutil.copytree(SRC, stale_root / 'src')
    expected_stale = expected_app_bytes(stale_root)
    (stale_root / 'app.html').write_bytes(expected_stale + b'<!-- stale -->\n')
    check((stale_root / 'app.html').read_bytes() != expected_app_bytes(stale_root),
          'complete byte comparison detects altered/stale app.html')


print('== Source/build inventory ==')
manifest_path = SRC / 'scripts-order.txt'
manifest = manifest_path.read_text().splitlines() if manifest_path.exists() else []
check(manifest == EXPECTED_SCRIPTS,
      f'exact script manifest order: {manifest}')
check(len(manifest) == len(set(manifest)), 'script manifest has no duplicates')
missing_scripts = [name for name in manifest
                   if normalized_confined_file(name, require_js=True) is None]
check(not missing_scripts, f'manifest scripts exist: missing {missing_scripts}')
owned = source_owned_js()
check(set(manifest) == set(owned) == set(EXPECTED_SCRIPTS),
      f'exact manifest/source-owned JS contract: {owned}')

lock_path = SRC / 'vendor/vendor-lock.json'
try:
    lock = json.loads(lock_path.read_text(), object_pairs_hook=strict_json_object)
except (OSError, json.JSONDecodeError, ValueError):
    lock = None
check(lock == EXPECTED_LOCK, f'exact locked vendor metadata: {lock!r}')
vendor_path = normalized_confined_file(EXPECTED_LOCK['file'])
license_path = normalized_confined_file(EXPECTED_LOCK['license_file'])
check(vendor_path is not None and license_path is not None,
      'locked vendor paths are normalized, confined regular files')
check(digest(vendor_path) == EXPECTED_LOCK['sha256'],
      f'vendor SHA-256: {digest(vendor_path)}')
check(digest(license_path) == EXPECTED_LOCK['license_sha256'],
      f'license SHA-256: {digest(license_path)}')

screen_manifest_path = SRC / 'screens-order.txt'
screen_order = (screen_manifest_path.read_text().splitlines()
                if screen_manifest_path.exists() else [])
check(screen_order == EXPECTED_SCREENS,
      f'exact normalized 42-screen order: {screen_order}')
check(len(screen_order) == len(set(screen_order)),
      'screen manifest has no duplicate entries')
resolved_screen_paths = {
    name: normalized_screen_file(SRC, name) for name in screen_order
}
check(all(resolved_screen_paths.values()),
      'every screen is a confined resolved regular file')
check(screen_order.count('asset') == 1, 'asset occurs exactly once in screen order')
check(screen_order.count('receive') == 1, 'receive occurs exactly once in screen order')
wallet_index = screen_order.index('wallet') if screen_order.count('wallet') == 1 else -1
check(wallet_index >= 0 and screen_order[wallet_index:wallet_index + 7] ==
      ['wallet', 'asset', 'send', 'send-to', 'send-confirm', 'receive',
       'tx-result'],
      'wallet transfer shells and receive/result follow the exact pinned order')
check(len(screen_order) == 42 and len(set(screen_order)) == 42,
      f'42 unique ordered screen fragments: {len(screen_order)} total')

screen_ids = []
for name in screen_order:
    path = resolved_screen_paths.get(name)
    if path is None:
        continue
    fragment = path.read_text()
    sections = re.findall(r'<section\b[^>]*\bclass="[^"]*\bscr\b[^"]*"[^>]*\bid="([^"]+)"',
                          fragment)
    check(len(sections) == 1, f'{name}.html contains exactly one .scr section')
    screen_ids.extend(sections)
check(len(screen_ids) == 42 and len(set(screen_ids)) == 42,
      f'42 unique screen IDs: {len(screen_ids)} total')

for name, heading, live_id in (
        ('asset', 'Asset detail', 'asset-content'),
        ('receive', 'Receive', 'receive-content')):
    path = SRC / 'screens' / f'{name}.html'
    text = path.read_text() if path.exists() else ''
    check(bool(re.search(r'<h1\b[^>]*>' + re.escape(heading) + r'</h1>', text)),
          f'{name} has unique h1 {heading!r}')
    check(bool(re.search(r'<button\b[^>]*\bclass="[^"]*\bback\b[^"]*"', text)),
          f'{name} has a back button')
    check(bool(re.search(rf'\bid="{live_id}"[^>]*\baria-live="polite"', text)),
          f'{name} has polite aria-live #{live_id}')

app_source = (SRC / 'app.js').read_text()
for name in ('asset', 'receive'):
    route = (rf'\b{name}:\s*\{{\s*screen:\s*\'scr-{name}\',\s*'
             rf'stack:\s*\[\s*\'scr-wallet\',\s*\'scr-{name}\'\s*\]')
    check(bool(re.search(route, app_source)), f'{name} route uses Wallet→{name} stack')

shell_source = (SRC / 'shell-close.html').read_text()
swap_source = (SRC / 'screens/swap.html').read_text()
dapp_source = (SRC / 'screens/dapp.html').read_text()
profile_source = (SRC / 'screens/profile.html').read_text()
wallet_source = (SRC / 'screens/wallet.html').read_text()
wallet_review_source = (SRC / 'wallet-review.js').read_text()
wallet_provider_source = (SRC / 'wallet-provider.js').read_text()
style_source = (SRC / 'style.css').read_text()
check(bool(re.search(
    r'<section\b[^>]*\bid="review-dialog"[^>]*\brole="dialog"[^>]*'
    r'\baria-modal="true"[^>]*\baria-labelledby="review-title"[^>]*'
    r'\baria-describedby="review-summary"', shell_source)),
    'F11 has one labelled modal dialog surface')
for review_id in ('review-kind', 'review-title', 'review-summary', 'review-fields',
                  'review-preview-ack', 'review-preview-copy', 'review-status',
                  'review-cancel', 'review-continue', 'review-refresh',
                  'review-provider-banner'):
    check(shell_source.count(f'id="{review_id}"') == 1,
          f'F11 contains one #{review_id}')
check('onclick="closeSheets()"' not in re.search(
    r'<div class="sheet-veil"[^>]*>', shell_source).group(0),
    'shared veil no longer owns an inline legacy close')
check('>Review 1,000 limit</button>' in shell_source and
      '>Review unlimited request</button>' in shell_source and
      'No token approval has occurred. Your choice will be reviewed before any wallet request.'
      in shell_source,
      'F16 uses exact review controls and persistent no-approval copy')
check(shell_source.count('onclick="chooseApprovalReview(this)"') == 2 and
      'review-approve-external' in app_source and
      'review-approve-unlimited-external' in app_source and
      'Approval limited to 1,000' not in shell_source and
      'Unlimited approval signed' not in shell_source,
      'F16 selects wallet-class-bound immutable approval fixture IDs and has no success claim')
check('Swap.zone' in dapp_source and 'swap.zone' in dapp_source and
      'Uniswap' not in dapp_source and 'app.uniswap.org' not in dapp_source and
      'Swap.zone' in shell_source and 'app.uniswap.org' not in shell_source,
      'F16 visible identity is exactly aligned to the canonical Swap.zone request')
check('Review Uniswap approval' not in wallet_source and
      'Review Aave approval' not in wallet_source and
      not re.search(r'>\s*(?:Uniswap|Aave)\s*<', wallet_source),
      'Every named Wallet DApp entry matches the canonical request it opens')
check('id="profile-approvals-review"' in profile_source and
      'profile-approvals-review" data-requires-signing' not in profile_source and
      'Approval management is planned for F17. No approval has changed.' in profile_source and
      'revoked' not in profile_source.lower(),
      'Profile approval control is an explicit non-executing F17 plan, never fake revoke')
check(shell_source.count('id="review-dialog"') == 1 and
      swap_source.count('id="completed-provider-fixture"') == 1 and
      '>Show completed provider fixture</button>' in swap_source and
      'onclick="showCompletedProviderFixture' not in swap_source and
      'id="success"' not in shell_source and 'afterSwap()' not in shell_source,
      'Swap and both approvals share F11; only one completed-provider control remains')
check('afterSwap' not in app_source and
      not re.search(r'function doSwap\([^)]*\)\{[^}]*setTimeout', app_source, re.S) and
      "openWalletReview('review-swap-fresh'" in app_source and
      "'Simulated provider succeeded'" in app_source and
      'wallet-provider-succeeded' not in app_source and
      'function showCompletedProviderFixture' not in app_source,
      'Swap opens canonical review and completed scenario has no query/global bypass')
check(bool(re.search(r'<input\b[^>]*\bid="pay-amt"[^>]*\bvalue="500"[^>]*\breadonly\b',
                     swap_source)) and
      'id="pay-token"' in swap_source and 'id="receive-token"' in swap_source and
      'review-swap-refresh-late' in wallet_review_source,
      'Swap input is immutable/identified and late refresh uses a new immutable envelope')
check(bool(re.search(r'<input\b[^>]*\bid="pay-amt"[^>]*\baria-label="You pay"',
                     swap_source)) and
      bool(re.search(r'<input\b[^>]*\bid="receive-amt"[^>]*'
                     r'\baria-label="You receive estimated"', swap_source)),
      'Both readonly Swap amount inputs have exact programmable accessible names')
check(bool(re.search(r'id="completed-provider-fixture"[^>]*\btype="button"[^>]*'
                     r'\baria-label="Show completed provider fixture"[^>]*'
                     r'\bdata-provider-fixture="completed"', swap_source)),
      'Completed-provider control declares the exact captured semantic attributes')
check('PROVIDER_REVIEW_ALIASES' not in wallet_review_source and
      'providerFixtureId' not in wallet_review_source and
      'review-swap-refresh-late' in wallet_provider_source and
      'review-approve-unlimited-external' in wallet_provider_source,
      'Provider preview/handoff has exact same-ID fixtures with no semantic aliases')
check(not re.search(r'\b(?:const|let|var)\s+walletRuntime\s*=|'
                    r'\bfunction\s+walletDemoConfiguration\s*\(', app_source) and
      'const walletAuthority=(()=>{' in app_source and
      'const providerFactory=' in app_source and
      'const queryGetDescriptor=' in app_source and
      bool(re.search(r"capturedReflectApply\(\s*queryGet,\s*"
                     r"new QueryParameters\(location\.search\),\s*\['demo'\]\)",
                     app_source)),
      'Wallet provider authority/cache/configuration are closure-private')
check('.review-dialog' in style_source and '.review-actions' in style_source and
      '.review-field' in style_source and '.review-dialog:focus' in style_source,
      'F11 has shared dialog, field, action, and focus styling')
check(bool(re.search(r'\.review-dialog:focus-visible\s*\{[^}]*outline:\s*'
                     r'(?!none)[^;}]+', style_source, re.S)),
      'F11 has a visible replacement focus indicator')
check(bool(re.search(r'\.review-(?:cancel|continue|refresh)[^{]*\{[^}]*min-height:\s*'
                     r'(?:4[4-9]|[5-9][0-9])px',
                     style_source, re.S)),
      'F11 action targets are at least 44px')
check('@media (prefers-reduced-motion: reduce)' in style_source and
      '.review-dialog' in style_source,
      'F11 participates in reduced-motion styling')
route_body = re.search(
    r'function route\(\{silent=false\}=\{\}\)\{(?P<body>.*?)\n\}\nfunction expectedHash',
    app_source, re.S)
check(bool(route_body) and
      route_body.group('body').find('consumeReviewForNavigation()') >= 0 and
      route_body.group('body').find('consumeReviewForNavigation()') <
      route_body.group('body').find('strictHashRoute()'),
      'route consumes F11 before parsing a new hash')

print('\n== Generated bundle ==')
built_bytes = APP.read_bytes() if APP.exists() else b''
expected_bytes = expected_app_bytes(ROOT)
check(built_bytes == expected_bytes,
      f'app.html exactly matches generated source bytes ({len(expected_bytes):,} bytes)')
built = built_bytes.decode() if built_bytes else ''
banners = [f'/* ============ SCRIPT: {name} ============ */' for name in EXPECTED_SCRIPTS]
check(all(built.count(banner) == 1 for banner in banners),
      'each generated script banner occurs once')
positions = [built.find(banner) for banner in banners]
check(all(position >= 0 for position in positions) and positions == sorted(positions),
      f'generated script banners follow manifest order: {positions}')

provider_source = (SRC / 'wallet-provider.js').read_text()
provider_banned = re.findall(
    r'parseFloat|toFixed|Number\(|fetch\(|XMLHttpRequest|WebSocket|EventSource|'
    r'localStorage|sessionStorage|setTimeout|setInterval|requestAnimationFrame',
    provider_source)
provider_secret_terms = re.findall(
    r'(?i)private[_ -]?key|seed phrase|secret phrase|mnemonic', provider_source)
check(not provider_banned,
      f'provider source has no floating/network/storage/timer primitives: {provider_banned}')
check(not provider_secret_terms,
      f'provider source contains no secret material vocabulary: {provider_secret_terms}')

APP = production_policy_test_app(ROOT)

print('\n== Immutable simulated Privy adapter and normalized DTOs ==')
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)

    isolated = browser.new_page()
    isolated_errors = []
    isolated.on('console', lambda message:
                isolated_errors.append(message.text) if message.type == 'error' else None)
    isolated.on('pageerror', lambda error:
                isolated_errors.append(f'pageerror: {error}'))
    isolated.goto('about:blank')
    global_key_script = """() => Reflect.ownKeys(globalThis).map(key =>
      typeof key === 'symbol' ? `symbol:${String(key)}` : `string:${key}`)"""
    globals_before = isolated.evaluate(global_key_script)
    isolated.add_script_tag(content=provider_source)
    globals_after = isolated.evaluate(global_key_script)
    new_globals = [key for key in globals_after if key not in globals_before]
    check(new_globals == ['string:LoopWalletProvider'],
          f'isolated source injection adds only LoopWalletProvider: {new_globals}')
    isolated_results = isolated.evaluate(r"""() => {
      const out = {};
      const P = globalThis.LoopWalletProvider;
      const deeplyFrozen = value => {
        if (!value || typeof value !== 'object') return true;
        return Object.isFrozen(value) && Reflect.ownKeys(value).every(key =>
          deeplyFrozen(value[key]));
      };
      const rejects = callback => {
        try { callback(); return false; } catch (_error) { return true; }
      };
      const failureCode = (value, code) => value && value.ok === false &&
        value.error && value.error.code === code && deeplyFrozen(value);
      const malformedBalance = value => failureCode(
        P.normalizeBalanceResponse(value), 'MALFORMED_PROVIDER_RESPONSE');
      const malformedTransactions = value => failureCode(
        P.normalizeTransactionPage(value), 'MALFORMED_PROVIDER_RESPONSE');
      const validBalance = () => ({
        chain: 'base', asset: 'eth', raw_value: '1', raw_value_decimals: 18,
        display_values: {eth: '0.000000000000000001'}
      });
      const validTransaction = () => ({
        privy_transaction_id: 'tx-1', transaction_hash: null,
        status: 'confirmed', created_at: 1746920539240, details: null
      });
      const nullRecord = fields => Object.assign(Object.create(null), fields);

      let factoryGetterCalls = 0;
      const accessorFactory = {scenario: 'normal'};
      Object.defineProperty(accessorFactory, 'walletClass', {
        enumerable: true, get(){ factoryGetterCalls += 1; return 'privy_embedded'; }
      });
      const hiddenExtraFactory = {
        walletClass: 'privy_embedded', scenario: 'normal'
      };
      Object.defineProperty(hiddenExtraFactory, 'extra', {value: true});
      const symbolFactory = {walletClass: 'privy_embedded', scenario: 'normal'};
      symbolFactory[Symbol('extra')] = true;
      const customFactory = Object.assign(Object.create({inherited: true}), {
        walletClass: 'privy_embedded', scenario: 'normal'
      });
      const inheritedFactory = Object.assign(Object.create({
        walletClass: 'privy_embedded'
      }), {scenario: 'normal'});
      const nullFactory = nullRecord({
        walletClass: 'privy_embedded', scenario: 'normal'
      });
      const nullAdapter = P.createSimulatedAdapter(nullFactory);
      nullFactory.walletClass = 'watch_only';
      nullFactory.scenario = 'watch_only';
      out.loopObjectShape = rejects(() => P.createSimulatedAdapter(accessorFactory)) &&
        factoryGetterCalls === 0 &&
        rejects(() => P.createSimulatedAdapter(hiddenExtraFactory)) &&
        rejects(() => P.createSimulatedAdapter(symbolFactory)) &&
        rejects(() => P.createSimulatedAdapter(customFactory)) &&
        rejects(() => P.createSimulatedAdapter(inheritedFactory)) &&
        nullAdapter.getWalletSnapshot().value.wallet_class === 'privy_embedded';

      let argumentGetterCalls = 0;
      const accessorAction = {};
      Object.defineProperty(accessorAction, 'action_id', {
        enumerable: true, get(){ argumentGetterCalls += 1; return 'action-pending'; }
      });
      const hiddenArgument = {action_id: 'action-pending'};
      Object.defineProperty(hiddenArgument, 'extra', {value: true});
      const symbolArgument = {action_id: 'action-pending'};
      symbolArgument[Symbol('extra')] = true;
      const customArgument = Object.assign(Object.create({inherited: true}), {
        action_id: 'action-pending'
      });
      const nullArgument = nullRecord({action_id: 'action-pending'});
      out.loopArgumentShape = rejects(() => nullAdapter.getWalletActionSnapshot(
          accessorAction)) && argumentGetterCalls === 0 &&
        rejects(() => nullAdapter.getWalletActionSnapshot(hiddenArgument)) &&
        rejects(() => nullAdapter.getWalletActionSnapshot(symbolArgument)) &&
        rejects(() => nullAdapter.getWalletActionSnapshot(customArgument)) &&
        nullAdapter.getWalletActionSnapshot(nullArgument).ok;

      let rawGetterCalls = 0;
      const accessorTop = {};
      Object.defineProperty(accessorTop, 'balances', {
        enumerable: true, get(){ rawGetterCalls += 1; return []; }
      });
      const inheritedTop = Object.create({balances: [validBalance()]});
      const customTop = Object.assign(Object.create({inherited: true}), {
        balances: [validBalance()]
      });
      const symbolTop = {balances: [validBalance()]};
      symbolTop[Symbol('future')] = true;
      let displayGetterCalls = 0;
      const accessorDisplay = {eth: '0.000000000000000001'};
      Object.defineProperty(accessorDisplay, 'usd', {
        enumerable: true, get(){ displayGetterCalls += 1; return '99.00'; }
      });
      const accessorDisplayRaw = {balances: [{
        ...validBalance(), display_values: accessorDisplay
      }]};
      const inheritedDisplay = Object.create({usd: '99.00'});
      inheritedDisplay.eth = '0.000000000000000001';
      const inheritedDisplayRaw = {balances: [{
        ...validBalance(), display_values: inheritedDisplay
      }]};
      out.rawBalanceShape = malformedBalance(accessorTop) && rawGetterCalls === 0 &&
        malformedBalance(inheritedTop) && malformedBalance(customTop) &&
        malformedBalance(symbolTop) && malformedBalance(accessorDisplayRaw) &&
        displayGetterCalls === 0 && malformedBalance(inheritedDisplayRaw);

      let transactionGetterCalls = 0;
      const accessorTransaction = {...validTransaction()};
      Object.defineProperty(accessorTransaction, 'status', {
        enumerable: true, get(){ transactionGetterCalls += 1; return 'confirmed'; }
      });
      const inheritedTransaction = Object.assign(Object.create({
        privy_transaction_id: 'inherited-id'
      }), {transaction_hash: null, status: 'confirmed',
        created_at: 1746920539240, details: null});
      const customTxTop = Object.assign(Object.create({inherited: true}), {
        transactions: [validTransaction()], next_cursor: null
      });
      const symbolTransaction = validTransaction();
      symbolTransaction[Symbol('future')] = true;
      out.rawTransactionShape = malformedTransactions({
          transactions: [accessorTransaction], next_cursor: null
        }) && transactionGetterCalls === 0 &&
        malformedTransactions({transactions: [inheritedTransaction], next_cursor: null}) &&
        malformedTransactions(customTxTop) &&
        malformedTransactions({transactions: [symbolTransaction], next_cursor: null}) &&
        malformedTransactions(Object.assign(Object.create({next_cursor: null}), {
          transactions: [validTransaction()]
        }));

      const previousUsd = Object.getOwnPropertyDescriptor(Object.prototype, 'usd');
      let pollutionSafe = false;
      try {
        Object.defineProperty(Object.prototype, 'usd', {
          configurable: true, enumerable: true, value: '999999.99'
        });
        const polluted = P.normalizeBalanceResponse({balances: [validBalance()]});
        pollutionSafe = polluted.ok && polluted.value.items[0].fiat_value === null &&
          polluted.value.loop_total.value === null;
      } finally {
        delete Object.prototype.usd;
        if (previousUsd) Object.defineProperty(Object.prototype, 'usd', previousUsd);
      }
      out.prototypePollution = pollutionSafe;

      const decimal100 = '0.' + '1'.repeat(98);
      out.fixedInputBounds =
        P.formatBaseUnits('9'.repeat(100), 0, 'ETH').length > 0 &&
        P.addDecimalStrings([decimal100]) === decimal100 &&
        P.addDecimalStrings(Array(128).fill('1')) === '128' &&
        rejects(() => P.formatBaseUnits('9'.repeat(101), 0, 'ETH')) &&
        rejects(() => P.addDecimalStrings(['9'.repeat(101)])) &&
        rejects(() => P.addDecimalStrings(['0.' + '1'.repeat(99)])) &&
        rejects(() => P.addDecimalStrings(Array(129).fill('1')));

      let decimalGetterCalls = 0;
      const accessorDecimals = new Array(1);
      Object.defineProperty(accessorDecimals, '0', {
        enumerable: true, get(){ decimalGetterCalls += 1; return '1'; }
      });
      const symbolDecimals = ['1'];
      symbolDecimals[Symbol('extra')] = true;
      const hiddenExtraDecimals = ['1'];
      Object.defineProperty(hiddenExtraDecimals, 'extra', {value: true});
      const enumerableExtraDecimals = ['1'];
      enumerableExtraDecimals.extra = true;
      let callerMethodCalls = 0;
      const overriddenMethods = ['1', '2'];
      Object.defineProperty(overriddenMethods, 'some', {
        value(predicate){
          callerMethodCalls += 1;
          return Array.prototype.some.call(this, predicate);
        }
      });
      Object.defineProperty(overriddenMethods, 'reduce', {
        value(callback, initial){
          callerMethodCalls += 1;
          return Array.prototype.reduce.call(this, callback, initial);
        }
      });
      const nullPrototypeDecimals = ['1'];
      Object.setPrototypeOf(nullPrototypeDecimals, null);
      const customPrototypeDecimals = ['1'];
      Object.setPrototypeOf(customPrototypeDecimals, Object.create(Array.prototype));
      out.decimalArrayShape = P.addDecimalStrings(['2.56', '0.44']) === '3.00' &&
        rejects(() => P.addDecimalStrings(new Array(1))) &&
        rejects(() => P.addDecimalStrings(['1', , '2'])) &&
        rejects(() => P.addDecimalStrings(accessorDecimals)) &&
        decimalGetterCalls === 0 &&
        rejects(() => P.addDecimalStrings(symbolDecimals)) &&
        rejects(() => P.addDecimalStrings(hiddenExtraDecimals)) &&
        rejects(() => P.addDecimalStrings(enumerableExtraDecimals)) &&
        rejects(() => P.addDecimalStrings(overriddenMethods)) &&
        callerMethodCalls === 0 &&
        rejects(() => P.addDecimalStrings(nullPrototypeDecimals)) &&
        rejects(() => P.addDecimalStrings(customPrototypeDecimals));

      const raw101 = {...validBalance(), raw_value: '9'.repeat(101)};
      const display101 = {...validBalance(), display_values: {
        eth: '0.' + '1'.repeat(99)
      }};
      const hugeUnknown = 'x'.repeat(200000);
      const ignoredHuge = P.normalizeBalanceResponse({
        balances: [{...validBalance(), future_blob: hugeUnknown}],
        future_blob: hugeUnknown
      });
      out.balanceInputBounds = malformedBalance({balances: [raw101]}) &&
        malformedBalance({balances: [display101]}) &&
        malformedBalance({balances: Array.from({length: 129}, validBalance)}) &&
        ignoredHuge.ok && !JSON.stringify(ignoredHuge).includes('future_blob');

      const id257 = {...validTransaction(), privy_transaction_id: 'i'.repeat(257)};
      const status129 = {...validTransaction(), status: 's'.repeat(129)};
      const hash257 = {...validTransaction(), privy_transaction_id: '',
        transaction_hash: 'h'.repeat(257)};
      const idControl = {...validTransaction(), privy_transaction_id: 'bad\nid'};
      const counterparty257 = {...validTransaction(), details: {
        type: 'transfer_sent', chain: 'base', asset: 'eth', sender: '0xsender',
        recipient: 'r'.repeat(257), raw_value: '1', raw_value_decimals: 18
      }};
      const txPage = transaction => ({transactions: [transaction], next_cursor: null});
      out.transactionInputBounds = malformedTransactions(txPage(id257)) &&
        malformedTransactions(txPage(status129)) &&
        malformedTransactions(txPage(hash257)) &&
        malformedTransactions(txPage(idControl)) &&
        malformedTransactions(txPage(counterparty257)) &&
        malformedTransactions({transactions: [validTransaction()],
          next_cursor: 'c'.repeat(257)}) &&
        malformedTransactions({transactions: Array.from({length: 257},
          validTransaction), next_cursor: null}) &&
        malformedTransactions(txPage({...validTransaction(), created_at: 1.5})) &&
        malformedTransactions(txPage({...validTransaction(), created_at: Infinity})) &&
        malformedTransactions(txPage({...validTransaction(),
          created_at: 8640000000000001})) &&
        P.normalizeTransactionPage(txPage({...validTransaction(),
          created_at: 8640000000000000})).ok;

      const distinctGraph = (left, right) => {
        if (!left || typeof left !== 'object') return true;
        if (left === right || !right || typeof right !== 'object') return false;
        return Reflect.ownKeys(left).every(key => distinctGraph(left[key], right[key]));
      };
      const freshPair = callback => {
        const first = callback();
        const second = callback();
        return deeplyFrozen(first) && deeplyFrozen(second) &&
          distinctGraph(first, second);
      };
      const embedded = P.createSimulatedAdapter({
        walletClass: 'privy_embedded', scenario: 'normal'
      });
      const external = P.createSimulatedAdapter({
        walletClass: 'connected_external', scenario: 'external_gap'
      });
      const watched = P.createSimulatedAdapter({
        walletClass: 'watch_only', scenario: 'watch_only'
      });
      out.freshAdapterResults =
        freshPair(() => embedded.getWalletSnapshot()) &&
        freshPair(() => embedded.getBalanceSnapshot({})) &&
        freshPair(() => embedded.getTransactionHistorySnapshot({
          asset_id: 'ETH', chain_id: 'base'
        })) &&
        freshPair(() => embedded.getWalletActionSnapshot({action_id: 'action-pending'})) &&
        freshPair(() => embedded.getWalletActionSnapshot({action_id: 'unknown'})) &&
        freshPair(() => embedded.getReceiveTarget({asset_id: 'ETH', chain_id: 'base'})) &&
        freshPair(() => embedded.getReviewPreview({review_id: 'review-transfer'})) &&
        freshPair(() => embedded.getReviewPreview({review_id: 'unknown'})) &&
        freshPair(() => embedded.handoffReview({review_id: 'review-pending'})) &&
        freshPair(() => embedded.handoffReview({review_id: 'review-approve'})) &&
        freshPair(() => external.getBalanceSnapshot({})) &&
        freshPair(() => external.getTransactionHistorySnapshot({
          asset_id: 'ETH', chain_id: 'base'
        })) &&
        freshPair(() => external.getWalletActionSnapshot({action_id: 'action-pending'})) &&
        freshPair(() => external.getReceiveTarget({asset_id: 'SOL', chain_id: 'solana'})) &&
        freshPair(() => external.getReviewPreview({review_id: 'review-swap'})) &&
        freshPair(() => watched.handoffReview({review_id: 'review-transfer'}));
      return out;
    }""")
    for name, passed in isolated_results.items():
        check(passed, f'isolated provider: {name}')
    check(not isolated_errors,
          f'isolated provider has no console/page errors: {isolated_errors}')
    isolated.close()

    page = browser.new_page()
    provider_errors = []
    page.on('console', lambda message:
            provider_errors.append(message.text) if message.type == 'error' else None)
    page.on('pageerror', lambda error: provider_errors.append(f'pageerror: {error}'))
    page.goto(APP.as_uri())
    page.wait_for_load_state('networkidle')
    results = page.evaluate(r"""() => {
      const out = {};
      const P = globalThis.LoopWalletProvider;
      const exact = (value, keys) => value &&
        JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
      const deeplyFrozen = value => {
        if (!value || typeof value !== 'object') return true;
        return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
      };
      const rejects = callback => {
        try { callback(); return false; } catch (_error) { return true; }
      };
      const accepts = callback => !rejects(callback);
      const failureCode = (value, code) => value && value.ok === false &&
        value.error && value.error.code === code && deeplyFrozen(value) &&
        exact(value.error, ['code', 'retryable', 'safe_message']);

      out.facade = Object.isFrozen(P) && exact(P, [
        'createSimulatedAdapter', 'normalizeBalanceResponse',
        'normalizeTransactionPage', 'formatBaseUnits', 'addDecimalStrings'
      ]) && Object.values(P).every(value => typeof value === 'function');

      out.fixedPoint = P.formatBaseUnits('1', 18, 'ETH') ===
          '0.000000000000000001 ETH' &&
        P.formatBaseUnits('1000000', 6, 'USDC') === '1 USDC' &&
        P.formatBaseUnits('1200000', 6, 'USDC') === '1.2 USDC' &&
        P.formatBaseUnits('0', 0, 'SOL') === '0 SOL' &&
        P.addDecimalStrings(['2.56', '0.44', '10']) === '13.00' &&
        P.addDecimalStrings(['0', '999999999999999999999.9', '0.10']) ===
          '1000000000000000000000.00';
      out.fixedPointRejects = [
        () => P.formatBaseUnits('-1', 18, 'ETH'),
        () => P.formatBaseUnits('01', 18, 'ETH'),
        () => P.formatBaseUnits('1', 37, 'ETH'),
        () => P.formatBaseUnits('1', 2.5, 'ETH'),
        () => P.formatBaseUnits('1', 18, 'NOT_A_TOKEN'),
        () => P.addDecimalStrings([]),
        () => P.addDecimalStrings(['-1']),
        () => P.addDecimalStrings(['1e3']),
        () => P.addDecimalStrings([' 1']),
        () => P.addDecimalStrings(['01']),
        () => P.addDecimalStrings(['1.'])
      ].every(rejects);

      const officialBalance = P.normalizeBalanceResponse({
        balances: [{
          chain: 'base', asset: 'eth', raw_value: '1000000000000000000',
          raw_value_decimals: 18,
          display_values: {eth: '1', usd: '2560.00', eur: 'ignored'},
          ignored_future_field: 'safe-to-ignore'
        }],
        ignored_top_level: true
      });
      out.balanceOfficial = officialBalance.ok && deeplyFrozen(officialBalance) &&
        exact(officialBalance, ['ok', 'value', 'meta']) &&
        exact(officialBalance.meta,
          ['source', 'fetched_at_ms', 'stale', 'partial']) &&
        officialBalance.meta.source === 'privy_balance' &&
        officialBalance.value.status === 'ready' &&
        exact(officialBalance.value,
          ['status', 'items', 'loop_total', 'chain_errors']) &&
        exact(officialBalance.value.items[0], [
          'asset_id', 'chain_id', 'raw_value', 'decimals', 'amount_display',
          'fiat_currency', 'fiat_value', 'value_provenance'
        ]) && officialBalance.value.items[0].asset_id === 'ETH' &&
        officialBalance.value.items[0].amount_display === '1 ETH' &&
        officialBalance.value.items[0].fiat_value === '2560.00' &&
        officialBalance.value.loop_total.value === '2560.00' &&
        officialBalance.value.loop_total.label ===
          'LOOP total derived from Privy balances' &&
        !JSON.stringify(officialBalance).includes('safe-to-ignore') &&
        !JSON.stringify(officialBalance).includes('ignored');

      const glyph = P.normalizeBalanceResponse({balances: [
        {chain: 'base', asset: 'eth', raw_value: '1000000000000000000',
          raw_value_decimals: 18, display_values: {eth: '1', usd: '2560.00'}},
        {chain: 'base', asset: 'glyph', raw_value: '125000000',
          raw_value_decimals: 6, display_values: {glyph: '125.000000'}}
      ]});
      out.balanceGlyph = glyph.ok && glyph.value.status === 'ready' &&
        glyph.value.items[1].amount_display === '125.000000 GLYPH' &&
        glyph.value.items[1].fiat_currency === 'USD' &&
        glyph.value.items[1].fiat_value === null &&
        glyph.value.items[1].value_provenance === 'unavailable' &&
        glyph.value.loop_total.value === '2560.00' &&
        glyph.value.loop_total.excluded_asset_count === 1;

      const derived = P.normalizeBalanceResponse({balances: [{
        chain: 'base', asset: 'usdc', raw_value: '1000000',
        raw_value_decimals: 6, display_values: {usd: '1.00'}
      }]});
      const noFiat = P.normalizeBalanceResponse({balances: [{
        chain: 'solana', asset: 'sol', raw_value: '1',
        raw_value_decimals: 9, display_values: {sol: '0.000000001'}
      }]});
      out.balanceDerivation = derived.ok &&
        derived.value.items[0].amount_display === '1 USDC' &&
        noFiat.ok && noFiat.value.loop_total.value === null &&
        noFiat.value.loop_total.excluded_asset_count === 1;

      const partialBalance = P.normalizeBalanceResponse({balances: [
        {chain: 'base', asset: 'eth', raw_value: '1', raw_value_decimals: 18,
          display_values: {eth: '0.000000000000000001'}},
        {chain: 'solana', asset: 'sol', raw_value: '-2', raw_value_decimals: 9,
          display_values: {sol: '2'}}
      ]});
      const rawUnknownStatus = P.normalizeBalanceResponse({
        status: 'stale', ignored_provider_status: 'loading', balances: [{
          chain: 'base', asset: 'eth', raw_value: '1', raw_value_decimals: 18,
          display_values: {eth: '0.000000000000000001', usd: '0.01'}
        }]
      });
      out.balanceStates = rawUnknownStatus.ok &&
        rawUnknownStatus.value.status === 'ready' &&
        rawUnknownStatus.meta.stale === false &&
        rawUnknownStatus.meta.fetched_at_ms === 0 &&
        P.normalizeBalanceResponse({balances: []}).value.status === 'empty' &&
        partialBalance.ok && partialBalance.value.status === 'partial' &&
        partialBalance.meta.partial === true &&
        partialBalance.value.items.length === 1 &&
        partialBalance.value.chain_errors.length === 1 &&
        partialBalance.value.chain_errors[0].chain_id === 'solana';
      out.balanceMalformed = [
        null, {}, {balances: 'bad'},
        {balances: [{chain: 'base', asset: 'eth', raw_value: '-1',
          raw_value_decimals: 18, display_values: {eth: '1'}}]},
        {balances: [{chain: 'base', asset: 'eth', raw_value: '1',
          raw_value_decimals: 40, display_values: {eth: '1'}}]}
      ].every(value => failureCode(P.normalizeBalanceResponse(value),
        'MALFORMED_PROVIDER_RESPONSE'));

      const txPage = P.normalizeTransactionPage({
        transactions: [
          {privy_transaction_id: 'privy-1', transaction_hash: '0xhash-ignored-id',
            status: 'provider custom pending', created_at: 1746920539240,
            details: {type: 'transfer_sent', chain: 'base', asset: 'eth',
              sender: '0xsender', recipient: '0xrecipient', raw_value: '1',
              raw_value_decimals: 18, display_values: {eth: '0.000000000000000001'}},
            ignored_future_field: 'safe-to-ignore'},
          {privy_transaction_id: '', transaction_hash: '0xhash-2',
            status: 'confirmed', created_at: 1746920539241,
            details: {type: 'transfer_received', chain: 'base', asset: 'usdc',
              sender: '0xsender-2', recipient: '0xrecipient-2', raw_value: '1000000',
              raw_value_decimals: 6, display_values: {usdc: '1'}}},
          {privy_transaction_id: 'privy-1', transaction_hash: '0xduplicate',
            status: 'duplicate', created_at: 1},
          {privy_transaction_id: 'other-1', transaction_hash: null,
            status: 'future provider status', created_at: 1746920539242,
            details: {type: 'contract_call'}},
          {privy_transaction_id: '', transaction_hash: '', status: 'pending',
            created_at: 1746920539243}
        ],
        next_cursor: 'opaque:cursor/%2F==', ignored_page_field: true
      });
      out.transactions = txPage.ok && deeplyFrozen(txPage) &&
        txPage.meta.source === 'privy_transactions' && txPage.meta.partial === true &&
        txPage.value.status === 'partial' && txPage.value.items.length === 3 &&
        exact(txPage.value.items[0], [
          'id', 'direction', 'provider_status', 'details_present', 'chain_id',
          'asset_id', 'raw_value', 'decimals', 'amount_display', 'counterparty',
          'transaction_hash', 'created_at_ms'
        ]) &&
        txPage.value.items[0].id === 'privy-1' &&
        txPage.value.items[0].details_present === true &&
        txPage.value.items[0].direction === 'outgoing' &&
        txPage.value.items[0].provider_status === 'provider custom pending' &&
        txPage.value.items[0].counterparty === '0xrecipient' &&
        txPage.value.items[1].id === '0xhash-2' &&
        txPage.value.items[1].direction === 'incoming' &&
        txPage.value.items[1].counterparty === '0xsender-2' &&
        txPage.value.items[2].direction === 'other' &&
        txPage.value.items[2].details_present === true &&
        txPage.value.items[2].transaction_hash === null &&
        txPage.value.items[2].counterparty === null &&
        txPage.value.items[2].raw_value === null &&
        txPage.value.items[2].decimals === null &&
        txPage.value.items[2].amount_display === null &&
        txPage.value.next_cursor === 'opaque:cursor/%2F==' &&
        txPage.value.record_errors.length === 1 &&
        txPage.value.record_errors[0].index === 4 &&
        txPage.value.record_errors[0].code === 'MISSING_TRANSACTION_ID' &&
        !JSON.stringify(txPage).includes('safe-to-ignore');
      const noDetails = P.normalizeTransactionPage({transactions:[{
        privy_transaction_id:'no-details',transaction_hash:null,
        status:'confirmed',created_at:1746920539244,details:null
      }],next_cursor:null});
      out.transactionDetailPresence = noDetails.ok && deeplyFrozen(noDetails) &&
        noDetails.value.items[0].details_present === false &&
        txPage.value.items[2].details_present === true;
      out.transactionStates = P.normalizeTransactionPage({transactions: [], next_cursor: null})
          .value.status === 'empty' && [
        null, {}, {transactions: 'bad', next_cursor: null},
        {transactions: [], next_cursor: 4},
        {transactions: [{privy_transaction_id: 'x', status: 4}], next_cursor: null}
      ].every(value => failureCode(P.normalizeTransactionPage(value),
        'MALFORMED_PROVIDER_RESPONSE'));

      out.factoryRejects = [
        () => P.createSimulatedAdapter(),
        () => P.createSimulatedAdapter({walletClass: 'privy_embedded'}),
        () => P.createSimulatedAdapter({scenario: 'normal'}),
        () => P.createSimulatedAdapter({walletClass: 'bad', scenario: 'normal'}),
        () => P.createSimulatedAdapter({walletClass: 'privy_embedded', scenario: 'bad'}),
        () => P.createSimulatedAdapter({walletClass: 'privy_embedded',
          scenario: 'normal', extra: true})
      ].every(rejects);
      const walletClasses = ['privy_embedded', 'connected_external', 'watch_only'];
      const scenarios = ['normal', 'empty', 'loading', 'partial',
        'provider_succeeded_demo', 'external_gap', 'watch_only'];
      const allowedPairs = new Set([
        'privy_embedded:normal', 'privy_embedded:empty',
        'privy_embedded:loading', 'privy_embedded:partial',
        'privy_embedded:provider_succeeded_demo',
        'connected_external:external_gap', 'watch_only:watch_only'
      ]);
      out.factoryCompatibility = walletClasses.every(walletClass =>
        scenarios.every(scenario => {
          const accepted = accepts(() => P.createSimulatedAdapter({walletClass, scenario}));
          return accepted === allowedPairs.has(`${walletClass}:${scenario}`);
        }));

      const adapter = P.createSimulatedAdapter({
        walletClass: 'privy_embedded', scenario: 'normal'
      });
      out.adapterFacade = Object.isFrozen(adapter) && exact(adapter, [
        'getWalletSnapshot', 'getBalanceSnapshot',
        'getTransactionHistorySnapshot', 'getWalletActionSnapshot',
        'getReceiveTarget', 'getReviewPreview', 'handoffReview'
      ]) && Object.values(adapter).every(value => typeof value === 'function');
      out.argumentRejects = [
        () => adapter.getWalletSnapshot({}),
        () => adapter.getBalanceSnapshot(),
        () => adapter.getBalanceSnapshot(undefined),
        () => adapter.getBalanceSnapshot(null),
        () => adapter.getBalanceSnapshot({bad: true}),
        () => adapter.getBalanceSnapshot({asset_id: 'BAD'}),
        () => adapter.getBalanceSnapshot({chain_id: 'BAD'}),
        () => adapter.getTransactionHistorySnapshot({asset_id: 'ETH'}),
        () => adapter.getTransactionHistorySnapshot({asset_id: 'ETH',
          chain_id: 'base', cursor: ''}),
        () => adapter.getTransactionHistorySnapshot({asset_id: 'ETH',
          chain_id: 'base', extra: true}),
        () => adapter.getWalletActionSnapshot({}),
        () => adapter.getWalletActionSnapshot({action_id: 'action-1', extra: true}),
        () => adapter.getReceiveTarget({asset_id: 'ETH'}),
        () => adapter.getReceiveTarget({asset_id: 'ETH', chain_id: 'solana'}),
        () => adapter.getReviewPreview({}),
        () => adapter.getReviewPreview({review_id: 'review-1', extra: true}),
        () => adapter.handoffReview({}),
        () => adapter.handoffReview({review_id: 'review-1', extra: true})
      ].every(rejects);

      const walletA = adapter.getWalletSnapshot();
      const walletB = adapter.getWalletSnapshot();
      const balanceA = adapter.getBalanceSnapshot({});
      const history = adapter.getTransactionHistorySnapshot({
        asset_id: 'ETH', chain_id: 'base', cursor: 'opaque-next'
      });
      const action = adapter.getWalletActionSnapshot({action_id: 'action-pending'});
      const receive = adapter.getReceiveTarget({asset_id: 'ETH', chain_id: 'base'});
      out.embeddedAdapter = walletA.ok && deeplyFrozen(walletA) &&
        walletA !== walletB && walletA.value !== walletB.value &&
        walletA.value.wallet_class === 'privy_embedded' &&
        walletA.value.wallet_ref === 'fixture-wallet-1' &&
        JSON.stringify(walletA.value.capabilities) === JSON.stringify({
          balances: 'supported', history: 'supported', receive: 'supported',
          transfer: 'supported', swap: 'supported', approve: 'spike_required'
        }) && balanceA.ok && deeplyFrozen(balanceA) && history.ok && action.ok &&
        action.meta.source === 'privy_wallet_action' &&
        history.meta.source === 'privy_transactions' &&
        !('next_cursor' in action.value) && !('action_id' in history.value) &&
        receive.ok && receive.value.address.startsWith('0x');

      const actionRejected = adapter.getWalletActionSnapshot({action_id: 'action-rejected'});
      const actionFailed = adapter.getWalletActionSnapshot({action_id: 'action-failed'});
      const normalSucceeded = adapter.getWalletActionSnapshot({action_id: 'action-succeeded'});
      out.exactFixtureIds = actionRejected.ok && actionRejected.value.status === 'rejected' &&
        actionFailed.ok && actionFailed.value.status === 'failed' &&
        failureCode(normalSucceeded, 'ACTION_FAILED') &&
        ['anything-succeeded', 'prefix-action-failed-suffix', 'action-pending-extra']
          .every(action_id => failureCode(
            adapter.getWalletActionSnapshot({action_id}), 'ACTION_FAILED')) &&
        ['anything-succeeded', 'review-notreallyswap', 'prefix-review-failed-suffix']
          .every(review_id => failureCode(
            adapter.getReviewPreview({review_id}), 'ACTION_FAILED') &&
            failureCode(adapter.handoffReview({review_id}), 'ACTION_FAILED'));

      const empty = P.createSimulatedAdapter({walletClass: 'privy_embedded', scenario: 'empty'});
      const loading = P.createSimulatedAdapter({walletClass: 'privy_embedded', scenario: 'loading'});
      const partial = P.createSimulatedAdapter({walletClass: 'privy_embedded', scenario: 'partial'});
      const completed = P.createSimulatedAdapter({
        walletClass: 'privy_embedded', scenario: 'provider_succeeded_demo'
      });
      out.scenarios = empty.getBalanceSnapshot({}).value.status === 'empty' &&
        loading.getBalanceSnapshot({}).value.status === 'loading' &&
        partial.getBalanceSnapshot({}).value.status === 'partial' &&
        completed.getBalanceSnapshot({}).value.items.some(item =>
          item.asset_id === 'GLYPH' && item.fiat_value === null &&
          item.value_provenance === 'unavailable') &&
        completed.getWalletActionSnapshot({action_id: 'action-succeeded'}).ok &&
        completed.getWalletActionSnapshot({action_id: 'action-succeeded'})
          .value.status === 'succeeded';
      const stale = adapter.getBalanceSnapshot({asset_id: 'ETH', chain_id: 'arbitrum'});
      const freshAgain = adapter.getBalanceSnapshot({});
      out.trustedStaleFixture = stale.ok && stale.value.status === 'ready' &&
        stale.value.items.length === 1 && stale.value.items[0].asset_id === 'ETH' &&
        stale.meta.stale === true && stale.meta.fetched_at_ms > 0 &&
        freshAgain.ok && freshAgain.meta.stale === false &&
        freshAgain.meta.fetched_at_ms === 0;

      const external = P.createSimulatedAdapter({
        walletClass: 'connected_external', scenario: 'external_gap'
      });
      const watched = P.createSimulatedAdapter({
        walletClass: 'watch_only', scenario: 'watch_only'
      });
      const externalWallet = external.getWalletSnapshot();
      const watchWallet = watched.getWalletSnapshot();
      out.walletClasses = externalWallet.ok &&
        externalWallet.value.wallet_ref === null &&
        externalWallet.value.capabilities.balances === 'provider_gap' &&
        externalWallet.value.capabilities.history === 'provider_gap' &&
        externalWallet.value.capabilities.receive === 'supported' &&
        failureCode(external.getBalanceSnapshot({}), 'PROVIDER_GAP') &&
        failureCode(external.getTransactionHistorySnapshot({
          asset_id: 'ETH', chain_id: 'base'
        }), 'PROVIDER_GAP') && external.getReceiveTarget({
          asset_id: 'ETH', chain_id: 'base'
        }).ok && watchWallet.ok &&
        watchWallet.value.capabilities.transfer === 'unsupported' &&
        watchWallet.value.capabilities.swap === 'unsupported' &&
        watchWallet.value.capabilities.approve === 'unsupported' &&
        failureCode(watched.getBalanceSnapshot({}), 'PROVIDER_GAP') &&
        failureCode(watched.getReviewPreview({review_id: 'review-transfer'}),
          'UNSUPPORTED_WALLET') &&
        failureCode(watched.handoffReview({review_id: 'review-transfer'}),
          'UNSUPPORTED_WALLET') && watched.getReceiveTarget({
          asset_id: 'ETH', chain_id: 'base'
        }).ok;

      const receiveCases = [
        [adapter, {asset_id: 'ETH', chain_id: 'base'}],
        [adapter, {asset_id: 'SOL', chain_id: 'solana'}],
        [external, {asset_id: 'ETH', chain_id: 'base'}],
        [watched, {asset_id: 'ETH', chain_id: 'base'}]
      ];
      out.receiveIdentityInvariant = receiveCases.every(([selectedAdapter, request]) => {
        const selectedWallet = selectedAdapter.getWalletSnapshot();
        const target = selectedAdapter.getReceiveTarget(request);
        return selectedWallet.ok && target.ok && selectedWallet.value.addresses.some(
          declared => declared.address === target.value.address);
      }) && failureCode(external.getReceiveTarget({
        asset_id: 'SOL', chain_id: 'solana'
      }), 'PROVIDER_GAP') && failureCode(watched.getReceiveTarget({
        asset_id: 'SOL', chain_id: 'solana'
      }), 'PROVIDER_GAP');

      const before = JSON.stringify(adapter.getBalanceSnapshot({}));
      const pending = adapter.handoffReview({review_id: 'review-pending'});
      const afterPending = JSON.stringify(adapter.getBalanceSnapshot({}));
      const rejected = adapter.handoffReview({review_id: 'review-rejected'});
      const afterRejected = JSON.stringify(adapter.getBalanceSnapshot({}));
      const failed = adapter.handoffReview({review_id: 'review-failed'});
      const approvePreview = adapter.getReviewPreview({review_id: 'review-approve'});
      const approveHandoff = adapter.handoffReview({review_id: 'review-approve'});
      const transferPreview = adapter.getReviewPreview({review_id: 'review-transfer'});
      const swapPreview = adapter.getReviewPreview({review_id: 'review-swap'});
      const perpPreview = adapter.getReviewPreview({review_id: 'review-perp'});
      const policyHandoff = adapter.handoffReview({review_id: 'review-policy'});
      const afterFailed = JSON.stringify(adapter.getBalanceSnapshot({}));
      out.handoffIsolation = pending.ok && pending.value.status === 'handoff_pending' &&
        failureCode(rejected, 'USER_REJECTED') &&
        failureCode(failed, 'ACTION_FAILED') &&
        before === afterPending && before === afterRejected && before === afterFailed &&
        deeplyFrozen(pending) && deeplyFrozen(rejected) && deeplyFrozen(failed) &&
        approvePreview.ok && approvePreview.value.status === 'unavailable' &&
        failureCode(approveHandoff, 'PROVIDER_GAP') &&
        transferPreview.ok && transferPreview.value.kind === 'transfer' &&
        swapPreview.ok && swapPreview.value.kind === 'swap' &&
        perpPreview.ok && perpPreview.value.status === 'blocked' &&
        failureCode(policyHandoff, 'POLICY_REJECTED');
      const externalTransferPreview = external.getReviewPreview({
        review_id:'review-transfer-external'});
      const externalApprovalPreview = external.getReviewPreview({
        review_id:'review-approve-external'});
      const externalUnlimitedPreview = external.getReviewPreview({
        review_id:'review-approve-unlimited-external'});
      const externalTransferHandoff = external.handoffReview({
        review_id:'review-transfer-external'});
      const externalApprovalHandoff = external.handoffReview({
        review_id:'review-approve-external'});
      const externalUnlimitedHandoff = external.handoffReview({
        review_id:'review-approve-unlimited-external'});
      const externalSwapGap = external.getReviewPreview({review_id:'review-swap-external'});
      const externalSwapHandoffGap = external.handoffReview({
        review_id:'review-swap-external'});
      out.externalReviewNamespace = externalTransferPreview.ok &&
        externalTransferPreview.value.kind === 'transfer' &&
        externalApprovalPreview.ok && externalApprovalPreview.value.kind === 'approve' &&
        externalApprovalPreview.value.review_id === 'review-approve-external' &&
        externalApprovalPreview.value.preview?.allowance_kind === 'limited' &&
        externalApprovalPreview.value.preview?.limit_base_units === '1000000000' &&
        externalUnlimitedPreview.ok && externalUnlimitedPreview.value.kind === 'approve' &&
        externalUnlimitedPreview.value.review_id === 'review-approve-unlimited-external' &&
        externalUnlimitedPreview.value.preview?.allowance_kind === 'unlimited' &&
        externalUnlimitedPreview.value.preview?.limit_base_units === null &&
        externalTransferHandoff.ok && externalTransferHandoff.value.action_id === null &&
        externalTransferHandoff.value.status === 'provider_confirmation_pending' &&
        externalApprovalHandoff.ok && deeplyFrozen(externalApprovalHandoff) &&
        externalUnlimitedHandoff.ok && deeplyFrozen(externalUnlimitedHandoff) &&
        externalSwapGap.ok && externalSwapGap.value.status === 'provider_gap' &&
        externalSwapGap.value.preview === null &&
        failureCode(externalSwapHandoffGap,'PROVIDER_GAP') &&
        ['review-transfer-external','review-approve-external',
          'review-approve-unlimited-external','review-swap-external']
          .every(review_id => failureCode(adapter.getReviewPreview({review_id}),
            'PROVIDER_GAP')) &&
        failureCode(watched.getReviewPreview({review_id:'review-transfer-external'}),
          'UNSUPPORTED_WALLET');
      const exactQuotePreview = (status='available',output='216450000000',
        quoteId='privy-quote-1',routeId='privy-route-1',received=100000,
        providerExpiry=140000) => ({response:{status,
          quote_id:quoteId,route_id:routeId,chain_id:'ethereum',
          input_token_address:'0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          output_token_address:'0x0000000000000000000000000000000000000a11',
          input_amount_base_units:'500000000',output_amount_base_units:output,
          minimum_output_amount_base_units:output==='216500000000'?
            '215417500000':'215367750000',fee_amount_base_units:'500000',
          fee_asset_id:'USDC',provider_expiry_ms:providerExpiry},received_at_ms:received,
          freshness_deadline_ms:Math.min(providerExpiry,received+30000)});
      const exactApprovalPreview=(allowance_kind,limit_base_units,calldata)=>({
        chain_id:'ethereum',
        token_address:'0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        spender_address:'0x2222222222222222222222222222222222222222',
        dapp_origin:'https://swap.zone',allowance_kind,limit_base_units,
        calldata,value:'0'});
      const exactPreviewValue=(review_id,kind,status,preview,wallet_class='privy_embedded')=>
        ({review_id,wallet_class,kind,status,preview});
      const refreshWindows=[130000,160000,190000,220000,250000,280000,310000,
        340000,370000,400000,430000,460000,490000];
      const refreshId=received=>received===130000?'review-swap-refresh-late':
        'review-swap-refresh-'+String(received/1000);
      const providerPreviewCases=[
        [adapter,'review-transfer',exactPreviewValue('review-transfer','transfer',
          'unavailable',null)],
        [adapter,'review-approve-limited',exactPreviewValue('review-approve-limited',
          'approve','unavailable',null)],
        [adapter,'review-swap-fresh',exactPreviewValue('review-swap-fresh','swap',
          'available',exactQuotePreview())],
        [adapter,'review-swap-stale',exactPreviewValue('review-swap-stale','swap',
          'stale',exactQuotePreview('stale'))],
        [adapter,'review-swap-unavailable',exactPreviewValue('review-swap-unavailable',
          'swap','unavailable',exactQuotePreview('unavailable'))],
        [adapter,'review-swap-no-liquidity',exactPreviewValue(
          'review-swap-no-liquidity','swap','no_liquidity',
          exactQuotePreview('no_liquidity'))],
        [adapter,'review-swap-refresh',exactPreviewValue('review-swap-refresh','swap',
          'available',exactQuotePreview('available','216500000000','privy-quote-2',
            'privy-route-2'))],
        ...refreshWindows.map(received=>[adapter,refreshId(received),exactPreviewValue(
          refreshId(received),'swap','available',exactQuotePreview(
            'available','216500000000','privy-quote-r'+String(received/1000),
            'privy-route-r'+String(received/1000),received,500000))]),
        [adapter,'review-perp',exactPreviewValue('review-perp','perp_order',
          'blocked',null)],
        [external,'review-transfer-external',exactPreviewValue(
          'review-transfer-external','transfer','unavailable',null,
          'connected_external')],
        [external,'review-approve-external',exactPreviewValue(
          'review-approve-external','approve','unavailable',exactApprovalPreview(
            'limited','1000000000',
            '0x095ea7b30000000000000000000000002222222222222222222222222222222222222222'+
            '000000000000000000000000000000000000000000000000000000003b9aca00'),
          'connected_external')],
        [external,'review-approve-unlimited-external',exactPreviewValue(
          'review-approve-unlimited-external','approve','unavailable',exactApprovalPreview(
            'unlimited',null,
            '0x095ea7b30000000000000000000000002222222222222222222222222222222222222222'+
            'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
          'connected_external')],
        [external,'review-swap-external',exactPreviewValue('review-swap-external','swap',
          'provider_gap',null,'connected_external')],
        [external,'review-perp-external',exactPreviewValue('review-perp-external',
          'perp_order','blocked',null,'connected_external')]
      ];
      out.authoritativeReviewPreviewDto=providerPreviewCases.every(
        ([selectedAdapter,review_id,expected])=>{
          const first=selectedAdapter.getReviewPreview({review_id});
          const second=selectedAdapter.getReviewPreview({review_id});
          return first.ok&&deeplyFrozen(first)&&first!==second&&first.value!==second.value&&
            exact(first,['ok','value','meta'])&&exact(first.value,
              ['review_id','wallet_class','kind','status','preview'])&&
            exact(first.meta,['source','fetched_at_ms','stale','partial'])&&
            first.meta.source===(expected.wallet_class==='connected_external'?
              'external_wallet':'prototype_fixture')&&first.meta.fetched_at_ms===0&&
            first.meta.stale===false&&first.meta.partial===false&&
            JSON.stringify(first.value)===JSON.stringify(expected);
        });
      out.noInternals = typeof globalThis.WalletScenarioStore === 'undefined' &&
        typeof globalThis.walletScenarios === 'undefined' &&
        typeof globalThis.scenarioMap === 'undefined' &&
        !Object.keys(globalThis).some(key => /wallet.*(fixture|scenario|session)/i.test(key));
      return out;
    }""")
    for name, passed in results.items():
        check(passed, f'provider module: {name}')
    check(not provider_errors, f'provider module has no console/page errors: {provider_errors}')
    browser.close()

print('\n== Canonical wallet review decoder and one-time envelopes ==')
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    review_page = browser.new_page()
    review_errors = []
    review_page.on('console', lambda message:
                   review_errors.append(message.text) if message.type == 'error' else None)
    review_page.on('pageerror', lambda error:
                   review_errors.append(f'pageerror: {error}'))
    review_page.goto(APP.as_uri())
    review_results = review_page.evaluate(r"""async () => {
      const out = {};
      const R = globalThis.LoopWalletReview;
      const P = globalThis.LoopWalletProvider;
      const exact = (value, keys) => value &&
        JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
      const deeplyFrozen = value => {
        if (!value || typeof value !== 'object') return true;
        return Object.isFrozen(value) && Reflect.ownKeys(value).every(key =>
          deeplyFrozen(value[key]));
      };
      const rejects = callback => {
        try { callback(); return false; } catch (_error) { return true; }
      };
      const tryDecode = source => {
        try { return R.decodeReviewSource(source); } catch (_error) { return null; }
      };
      const clone = value => JSON.parse(JSON.stringify(value));
      const canonical = value => {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
        return '{' + Object.keys(value).sort().map(key =>
          JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
      };
      const sha256 = async value => {
        const bytes = new TextEncoder().encode(canonical(value));
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return 'sha256:' + [...new Uint8Array(digest)]
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
      };
      const sign = async body => {
        const source = clone(body);
        source.execution.execution_digest = await sha256(source.execution.payload);
        source.source_digest = await sha256({
          kind: source.kind,
          execution: source.execution,
          context: source.context,
          expires_at_ms: source.expires_at_ms
        });
        return source;
      };
      const ETH = {asset_id:'ETH', address:'native:ethereum', decimals:18, symbol:'ETH'};
      const USDC = {asset_id:'USDC', address:'0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        decimals:6, symbol:'USDC'};
      const GLYPH = {asset_id:'GLYPH', address:'0x0000000000000000000000000000000000000a11',
        decimals:6, symbol:'GLYPH'};
      const SPENDER = '0x2222222222222222222222222222222222222222';
      const DESTINATION = '0x71C700000000000000000000000000000000F0A2';
      const EXTERNAL_ADDRESS = '0xE87A4C2D1F9B6A3058C7E4D2B1A093F6C5E8D721';
      const ENDPOINT = '/v1/wallets/fixture-wallet-1/actions';
      const commonContext = (provenance, tokens, dapp=null, quote=null, labels={
        spender:null, provider:'Privy', environment:'prototype'
      }) => ({wallet_class:'privy_embedded',wallet_identity:{kind:'privy_wallet',
        wallet_id:'fixture-wallet-1'},provenance,token_metadata:tokens,dapp,quote,labels});
      const transferBody = amount => ({kind:'transfer', execution:{
        provider_path:'privy_wallet_action', wallet_id:'fixture-wallet-1',
        payload:{request_id:'review-transfer', endpoint:ENDPOINT, method:'transfer',
          chain_id:'ethereum', token_address:'native:ethereum', destination:DESTINATION,
          amount, source:{amount:'999.123400'}, amount_type:'exact_input', fee_display:null},
        execution_digest:''}, context:commonContext('privy_transfer_request',[ETH]),
        source_digest:'', expires_at_ms:500000});
      const limitedCalldata = '0x095ea7b30000000000000000000000002222222222222222222222222222222222222222' +
        '000000000000000000000000000000000000000000000000000000003b9aca00';
      const unlimitedCalldata = '0x095ea7b30000000000000000000000002222222222222222222222222222222222222222' +
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
      const approvalBody = (requestId, approval, calldata) => ({kind:'approve', execution:{
        provider_path:'privy_flutter_rpc', wallet_id:'fixture-wallet-1', payload:{
          request_id:requestId, endpoint:'eth_sendTransaction', method:'approve',
          chain_id:'ethereum', token_address:USDC.address, spender:SPENDER,
          calldata, value:'0', approval}, execution_digest:''},
        context:commonContext('dapp_request',[USDC],
          {origin:'https://swap.zone', allowlisted_label:'Swap.zone'}, null,
          {spender:'Swap.zone', provider:'Privy Flutter', environment:'prototype'}),
        source_digest:'', expires_at_ms:500000});
      const quoteResponse = (status='available', providerExpiry=140000) => ({status,
        quote_id:'privy-quote-1', route_id:'privy-route-1', chain_id:'ethereum',
        input_token_address:USDC.address, output_token_address:GLYPH.address,
        input_amount_base_units:'500000000', output_amount_base_units:'216450000000',
        minimum_output_amount_base_units:'215367750000', fee_amount_base_units:'500000',
        fee_asset_id:'USDC', provider_expiry_ms:providerExpiry});
      const missingQuoteResponse = status => ({status, chain_id:'ethereum',
        input_token_address:USDC.address, output_token_address:GLYPH.address,
        input_amount_base_units:'500000000', provider_expiry_ms:140000});
      const swapBody = (requestId='review-swap-fresh', response=quoteResponse()) => ({
        kind:'swap', execution:{provider_path:'privy_wallet_action',
          wallet_id:'fixture-wallet-1', payload:{request_id:requestId, endpoint:ENDPOINT,
            method:'swap', chain_id:'ethereum', input_token_address:USDC.address,
            output_token_address:GLYPH.address, input_amount_base_units:'500000000',
            quote_id:'privy-quote-1', route_id:'privy-route-1'}, execution_digest:''},
        context:commonContext('privy_swap_quote',[USDC,GLYPH],null,
          {response, received_at_ms:100000, freshness_deadline_ms:
            Math.min(response.provider_expiry_ms === null ? 130000 : response.provider_expiry_ms,
              130000)}), source_digest:'', expires_at_ms:500000});
      const perpBody = () => ({kind:'perp_order', execution:{
        provider_path:'hyperliquid', wallet_id:'fixture-wallet-1', payload:{
          request_id:'review-perp', endpoint:'hyperliquid:testnet', method:'order',
          chain_id:'hyperliquid-testnet', market:'ETH', side:'buy', order_type:'market',
          size:'0.01', leverage:'3', reduce_only:false, environment:'testnet'},
        execution_digest:''}, context:commonContext('hyperliquid_order_fixture',[ETH],null,
          null,{spender:null,provider:'Hyperliquid',environment:'testnet'}),
        source_digest:'', expires_at_ms:500000});

      out.facade = Object.isFrozen(R) && exact(R, ['decodeReviewSource','createController']) &&
        Object.values(R).every(value => typeof value === 'function');
      if (!out.facade) return out;

      const transfer = await sign(transferBody('0.01'));
      const transferOriginal = clone(transfer);
      const transferModel = R.decodeReviewSource(transfer);
      out.transfer = deeplyFrozen(transferModel) && transferModel.version === 1 &&
        transferModel.kind === 'transfer' && transferModel.id === 'review-transfer' &&
        transferModel.summary ===
          'You are preparing to ask Privy to send 0.01 ETH on Ethereum to 0x71C7…F0A2.' &&
        transferModel.fields.amount_decimal === '0.01' &&
        transferModel.fields.amount_base_units === '10000000000000000' &&
        transferModel.fields.source_amount === '999.123400' &&
        transferModel.fields.destination === DESTINATION &&
        transferModel.fields.amount_type === 'exact_input' &&
        transferModel.fields.field_provenance.amount === 'digest_bound_provider' &&
        transferModel.fields.field_provenance.fee === 'unavailable' &&
        JSON.stringify(transfer) === JSON.stringify(transferOriginal);
      const exactOutput = await sign({...transferBody('1.2300'), execution:{
        ...transferBody('1.2300').execution, payload:{...transferBody('1.2300').execution.payload,
          amount_type:'exact_output'}}});
      const outputModel = R.decodeReviewSource(exactOutput);
      out.transferOutput = outputModel.fields.amount_decimal === '1.2300' &&
        outputModel.fields.amount_base_units === '1230000000000000000' &&
        outputModel.fields.amount_type === 'exact_output' &&
        outputModel.fields.amount_semantics === 'received';
      const invalidAmounts = ['0','0.0','-1','+1',' 1','1 ','1e3','01','00.1','1.',
        '0.1234567890123456789','9'.repeat(101)];
      out.transferRejects = (await Promise.all(invalidAmounts.map(async amount => {
        const source = await sign(transferBody(amount));
        return rejects(() => R.decodeReviewSource(source));
      }))).every(Boolean);

      const limited = await sign(approvalBody('review-approve-limited',
        {type:'limited', limit_base_units:'1000000000'}, limitedCalldata));
      const unlimited = await sign(approvalBody('review-approve-unlimited',
        {type:'unlimited'}, unlimitedCalldata));
      const mismatch = await sign(approvalBody('review-approve-mismatch',
        {type:'limited', limit_base_units:'1000000000'}, unlimitedCalldata));
      const limitedModel = R.decodeReviewSource(limited);
      const unlimitedModel = R.decodeReviewSource(unlimited);
      out.approvals = limitedModel.summary ===
          'You are reviewing a request for Swap.zone to spend up to 1,000 USDC on Ethereum.' &&
        unlimitedModel.summary ===
          'You are reviewing a request for Swap.zone to spend unlimited USDC on Ethereum.' &&
        limitedModel.fields.allowance_kind === 'limited' &&
        limitedModel.fields.limit_base_units === '1000000000' &&
        unlimitedModel.fields.allowance_kind === 'unlimited' &&
        limitedModel.fields.spender_address === SPENDER &&
        limitedModel.fields.dapp_origin === 'https://swap.zone' &&
        rejects(() => R.decodeReviewSource(mismatch));

      const freshSwap = await sign(swapBody());
      const swapModel = R.decodeReviewSource(freshSwap);
      out.swap = swapModel.summary ===
          'You are preparing to ask Privy to swap 500 USDC for approximately 216,450 GLYPH on Ethereum (minimum 215,367.75 GLYPH).' &&
        swapModel.fields.input_amount_base_units === '500000000' &&
        swapModel.fields.input_amount_display === '500 USDC' &&
        swapModel.fields.output_amount_display === '216450 GLYPH' &&
        swapModel.fields.minimum_output_display === '215367.75 GLYPH' &&
        swapModel.fields.fee_display === '0.5 USDC' &&
        swapModel.fields.received_at_ms === 100000 &&
        swapModel.fields.freshness_deadline_ms === 130000 &&
        swapModel.fields.chain_id === 'ethereum' &&
        ['input','estimated_output','minimum_output','fees','received_at','deadline','chain']
          .every(field => swapModel.fields.field_provenance[field] ===
            'digest_bound_provider');
      const earlier = await sign(swapBody('review-swap-earlier',
        quoteResponse('available',120000)));
      out.swapDeadline = R.decodeReviewSource(earlier).fields.freshness_deadline_ms === 120000;
      const unavailable = await sign(swapBody('review-swap-unavailable',
        quoteResponse('unavailable',140000)));
      const staleQuote = await sign(swapBody('review-swap-stale',
        quoteResponse('stale',140000)));
      const noLiquidity = await sign(swapBody('review-swap-no-liquidity',
        quoteResponse('no_liquidity',140000)));
      const mismatchQuoteBody = swapBody('review-swap-mismatch');
      mismatchQuoteBody.context.quote.response.input_amount_base_units = '499999999';
      mismatchQuoteBody.context.quote.freshness_deadline_ms = 130000;
      const mismatchedQuote = await sign(mismatchQuoteBody);
      out.swapBlocked = ['unavailable','no_liquidity'].includes(
          R.decodeReviewSource(unavailable).provider_preview) &&
        R.decodeReviewSource(staleQuote).provider_preview === 'stale' &&
        R.decodeReviewSource(noLiquidity).provider_preview === 'no_liquidity' &&
        R.decodeReviewSource(mismatchedQuote).provider_preview === 'mismatch' &&
        [unavailable,noLiquidity,mismatchedQuote].every(source => {
          const model = R.decodeReviewSource(source);
          return model.handoff_eligible === false && model.refreshable === true;
        });
      const identityMismatchBodies = [
        body => { body.context.quote.response.input_amount_base_units = '499999999'; },
        body => { body.context.quote.response.quote_id = 'different-quote'; },
        body => { body.context.quote.response.route_id = 'different-route'; },
        body => { body.context.quote.response.chain_id = 'base'; },
        body => { body.context.quote.response.input_token_address = GLYPH.address; },
        body => { body.context.quote.response.output_token_address = USDC.address; }
      ];
      const identityMismatchSources = await Promise.all(identityMismatchBodies.map(
        async (mutate,index) => {const body=swapBody('review-swap-identity-'+index);
          mutate(body);return sign(body);}));
      out.mismatchRouteClosed = identityMismatchSources.every(source => {
        const model=tryDecode(source);return model && model.provider_preview === 'mismatch' &&
          model.handoff_eligible === false && model.fields.route_available === false &&
          model.fields.quote_id === null && model.fields.route_id === null &&
          model.fields.output_amount_base_units === null &&
          model.fields.minimum_output_amount_base_units === null &&
          model.fields.fee_amount_base_units === null &&
          model.fields.field_provenance.route === 'unavailable' &&
          model.fields.field_provenance.estimated_output === 'unavailable';
      });
      const unavailableModel = R.decodeReviewSource(unavailable);
      out.swapUnavailableProvenance =
        unavailableModel.fields.input_token_address === USDC.address &&
        unavailableModel.fields.output_token_address === GLYPH.address &&
        unavailableModel.fields.output_amount_display === null &&
        unavailableModel.fields.minimum_output_display === null &&
        unavailableModel.fields.fee_display === null &&
        unavailableModel.fields.field_provenance.estimated_output === 'unavailable' &&
        unavailableModel.fields.field_provenance.minimum_output === 'unavailable' &&
        unavailableModel.fields.field_provenance.fees === 'unavailable';
      const genuinelyUnavailable = await sign(swapBody('review-swap-unavailable-missing',
        missingQuoteResponse('unavailable')));
      const genuinelyNoLiquidity = await sign(swapBody('review-swap-no-liquidity-missing',
        missingQuoteResponse('no_liquidity')));
      out.genuinelyUnavailableQuotes = [genuinelyUnavailable,genuinelyNoLiquidity]
        .every(source => {
          const model = tryDecode(source);
          return model && ['unavailable','no_liquidity'].includes(model.provider_preview) &&
            model.handoff_eligible === false && model.refreshable === true &&
            model.fields.output_amount_base_units === null &&
            model.fields.output_amount_display === null &&
            model.fields.minimum_output_amount_base_units === null &&
            model.fields.minimum_output_display === null &&
            model.fields.fee_amount_base_units === null && model.fields.fee_display === null &&
            model.fields.quote_id === null && model.fields.route_id === null &&
            model.fields.field_provenance.estimated_output === 'unavailable' &&
            model.fields.field_provenance.minimum_output === 'unavailable' &&
            model.fields.field_provenance.fees === 'unavailable' &&
            model.fields.field_provenance.route === 'unavailable' && deeplyFrozen(model);
        });

      const perp = R.decodeReviewSource(await sign(perpBody()));
      out.perp = perp.summary ===
          'You are reviewing a Hyperliquid testnet market order to buy 0.01 ETH with 3× leverage.' &&
        perp.provider_capability === 'pending_spike' && perp.handoff_eligible === false &&
        perp.primary_action === null && perp.blocking_error.code ===
          'PERP_EXECUTION_PENDING' && perp.blocking_error.safe_message ===
          'Privy + Hyperliquid execution requires the production capability spike.' &&
        deeplyFrozen(perp);

      const externalTransferBody = transferBody('0.01');
      externalTransferBody.execution.provider_path = 'external_wallet';
      externalTransferBody.execution.wallet_id = null;
      externalTransferBody.execution.payload.request_id = 'review-transfer-external';
      externalTransferBody.execution.payload.endpoint = 'external_wallet:request';
      externalTransferBody.context.wallet_class = 'connected_external';
      externalTransferBody.context.wallet_identity = {kind:'external_connector',
        chain_type:'ethereum',address:EXTERNAL_ADDRESS};
      externalTransferBody.context.provenance = 'prototype_fixture';
      externalTransferBody.context.labels.provider = 'External wallet';
      const externalTransferSource = await sign(externalTransferBody);
      const externalTransfer = tryDecode(externalTransferSource);
      const externalApprovalBody = approvalBody('review-approve-external',
        {type:'limited',limit_base_units:'1000000000'},limitedCalldata);
      externalApprovalBody.execution.provider_path = 'external_wallet';
      externalApprovalBody.execution.wallet_id = null;
      externalApprovalBody.execution.payload.endpoint = 'external_wallet:request';
      externalApprovalBody.context.wallet_class = 'connected_external';
      externalApprovalBody.context.wallet_identity = {kind:'external_connector',
        chain_type:'ethereum',address:EXTERNAL_ADDRESS};
      externalApprovalBody.context.labels.provider = 'External wallet';
      const externalApproval = tryDecode(await sign(externalApprovalBody));
      const externalSwapBody = swapBody('review-swap-external');
      externalSwapBody.execution.provider_path = 'provider_gap';
      externalSwapBody.execution.wallet_id = null;
      externalSwapBody.execution.payload.endpoint = 'external_wallet:swap';
      externalSwapBody.context.wallet_class = 'connected_external';
      externalSwapBody.context.wallet_identity = {kind:'external_connector',
        chain_type:'ethereum',address:EXTERNAL_ADDRESS};
      externalSwapBody.context.provenance = 'prototype_fixture';
      externalSwapBody.context.labels.provider = 'External wallet';
      const externalSwap = tryDecode(await sign(externalSwapBody));
      const externalPerpBody = perpBody();
      externalPerpBody.execution.wallet_id = null;
      externalPerpBody.execution.payload.request_id = 'review-perp-external';
      externalPerpBody.context.wallet_class = 'connected_external';
      externalPerpBody.context.wallet_identity = {kind:'external_connector',
        chain_type:'ethereum',address:EXTERNAL_ADDRESS};
      const externalPerp = tryDecode(await sign(externalPerpBody));
      out.walletClassMatrix =
        Boolean(externalTransfer && externalApproval && externalSwap && externalPerp) &&
        externalTransfer.wallet_class === 'connected_external' &&
        externalTransfer.wallet_ref === null && externalTransfer.handoff_eligible &&
        externalTransfer.primary_action === 'Continue to external wallet' &&
        externalTransfer.summary.includes('external wallet') &&
        externalApproval.handoff_eligible &&
        externalApproval.primary_action === 'Continue to external wallet' &&
        externalSwap.handoff_eligible === false && externalSwap.primary_action === null &&
        externalSwap.blocking_error.code === 'PROVIDER_GAP' &&
        externalSwap.blocking_error.safe_message ===
          'Swap is not available for this external wallet.' &&
        externalSwap.refreshable === false &&
        externalSwap.summary === 'Swap is not available for this external wallet.' &&
        externalSwap.fields.quote_id === null && externalSwap.fields.route_id === null &&
        externalSwap.fields.route_available === false &&
        externalSwap.fields.field_provenance.route === 'unavailable' &&
        externalPerp.handoff_eligible === false &&
        externalPerp.blocking_error.code === 'PERP_EXECUTION_PENDING';
      const embeddedApproval = limitedModel;
      out.embeddedApprovalSpike = embeddedApproval.handoff_eligible === false &&
        embeddedApproval.primary_action === null &&
        embeddedApproval.blocking_error.code === 'PROVIDER_GAP' &&
        embeddedApproval.blocking_error.safe_message ===
          'Approval handoff requires the production Privy method spike.';
      const wrongExternalPath = clone(externalTransferSource);
      wrongExternalPath.execution.provider_path = 'privy_wallet_action';
      const resignedWrongExternalPath = await sign(wrongExternalPath);
      out.providerPathBinding = rejects(() =>
        R.decodeReviewSource(resignedWrongExternalPath));
      const externalIdentityDigestTamper=clone(externalTransferSource);
      externalIdentityDigestTamper.context.wallet_identity.address=
        '0xB00000000000000000000000000000000000000B';
      const externalIdentitySemanticTamper=await sign(externalIdentityDigestTamper);
      out.externalIdentityBinding =
        Boolean(externalTransfer) &&
        rejects(()=>R.decodeReviewSource(externalIdentityDigestTamper)) &&
        rejects(()=>R.decodeReviewSource(externalIdentitySemanticTamper)) &&
        deeplyFrozen(externalTransfer) &&
        !Object.prototype.hasOwnProperty.call(externalTransfer,'wallet_identity') &&
        externalTransfer.fields.wallet_address===EXTERNAL_ADDRESS &&
        externalTransfer.fields.field_provenance.wallet==='digest_bound_provider';

      const digestTamper = clone(transfer);
      digestTamper.source_digest = 'sha256:' + '0'.repeat(64);
      const executionTamper = clone(transfer);
      executionTamper.execution.execution_digest = 'sha256:' + '0'.repeat(64);
      const extraSource = clone(transfer); extraSource.extra = true;
      const extraContext = clone(transfer); extraContext.context.extra = true;
      const extraRequest = clone(transfer); extraRequest.execution.payload.extra = true;
      out.digestAndShapeRejects = [digestTamper, executionTamper, extraSource,
        extraContext, extraRequest].every(source => rejects(() => R.decodeReviewSource(source)));

      const semanticMutations = [
        source => { source.execution.wallet_id = 'fixture-wallet-2'; },
        source => { source.context.wallet_identity.wallet_id = 'fixture-wallet-2'; },
        source => { source.execution.payload.endpoint = '/v1/evil'; },
        source => { source.execution.payload.chain_id = 'base'; },
        source => { source.execution.payload.token_address = USDC.address; },
        source => { source.execution.payload.destination = SPENDER; },
        source => { source.execution.payload.amount = '0.02'; },
        source => { source.execution.payload.source.amount = 'changed'; },
        source => { source.context.provenance = 'prototype_fixture'; },
        source => { source.context.token_metadata[0].symbol = 'WETH'; },
        source => { source.context.labels.provider = 'Not Privy'; },
        source => { source.expires_at_ms = 500001; }
      ];
      out.semanticTamperRejects = (await Promise.all(semanticMutations.map(async mutate => {
        const source = clone(transfer); mutate(source);
        return rejects(() => R.decodeReviewSource(source));
      }))).every(Boolean);
      const approveMutations = [
        source => { source.execution.payload.spender = DESTINATION; },
        source => { source.execution.payload.calldata = limitedCalldata.slice(0,-1)+'1'; },
        source => { source.execution.payload.value = '1'; },
        source => { source.context.dapp.origin = 'https://evil.example'; },
        source => { source.context.dapp.allowlisted_label = 'Evil'; },
        source => { source.context.labels.spender = 'Evil'; }
      ];
      out.approvalTamperRejects = (await Promise.all(approveMutations.map(async mutate => {
        const source = clone(limited); mutate(source);
        const resigned = await sign(source);
        return rejects(() => R.decodeReviewSource(resigned));
      }))).every(Boolean);

      const adapter = P.createSimulatedAdapter({walletClass:'privy_embedded',scenario:'normal'});
      const live = {user_id:'fixture-user-1', wallet_id:'fixture-wallet-1',
        wallet_class:'privy_embedded', endpoint:ENDPOINT};
      const origin = {stack:['scr-wallet','scr-asset']};
      const liveFor = (review_id,base=live) => ({...base,endpoint:
        review_id.startsWith('review-approve')?'eth_sendTransaction':
        review_id.startsWith('review-perp')?'hyperliquid:testnet':
        review_id==='review-swap-external'?'external_wallet:swap':
        review_id.endsWith('-external')?'external_wallet:request':ENDPOINT});
      const open = (controller,review_id,now_ms=100001) => controller.open({review_id,
        origin, live_context:liveFor(review_id), trigger_ref:'fixture-trigger', now_ms});
      const controller = R.createController({adapter});
      out.controllerFacade = Object.isFrozen(controller) && exact(controller,
        ['open','validate','forward','refresh','restore','acknowledge',
          'beginHandoff','handoff','consume']) &&
        Object.values(controller).every(value => typeof value === 'function');
      const openedTransfer = open(controller,'review-transfer');
      out.controllerOpen = openedTransfer.ok && deeplyFrozen(openedTransfer) &&
        openedTransfer.value.state === 'preview_unavailable' &&
        openedTransfer.value.acknowledged === false &&
        openedTransfer.value.handoff_eligible === false &&
        !JSON.stringify(openedTransfer).includes('source_digest') &&
        !JSON.stringify(openedTransfer).includes('execution_digest') &&
        !JSON.stringify(openedTransfer).includes('CanonicalReviewSource');
      const externalAdapter = P.createSimulatedAdapter({walletClass:'connected_external',
        scenario:'external_gap'});
      const externalLive = {user_id:'fixture-user-1',wallet_id:null,
        wallet_class:'connected_external',endpoint:'external_wallet:request'};
      const externalController = R.createController({adapter:externalAdapter});
      const adapterMethodNames=['getWalletSnapshot','getBalanceSnapshot',
        'getTransactionHistorySnapshot','getWalletActionSnapshot','getReceiveTarget',
        'getReviewPreview','handoffReview'];
      const freezeTest=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){
        Object.values(value).forEach(freezeTest);Object.freeze(value);}return value;};
      const adapterWith=(base,overrides={})=>Object.freeze(Object.fromEntries(
        adapterMethodNames.map(name=>[name,Object.prototype.hasOwnProperty.call(overrides,name)?
          overrides[name]:base[name]])));
      let adapterGetterCalls=0;
      const accessorAdapter={};
      adapterMethodNames.forEach(name=>{
        if(name==='getWalletSnapshot')Object.defineProperty(accessorAdapter,name,
          {enumerable:true,get(){adapterGetterCalls+=1;return adapter[name];}});
        else Object.defineProperty(accessorAdapter,name,{enumerable:true,value:adapter[name]});
      });
      Object.freeze(accessorAdapter);
      const unfrozenAdapter=Object.fromEntries(adapterMethodNames.map(name=>
        [name,adapter[name]]));
      const extraAdapter=Object.freeze({...unfrozenAdapter,extra:true});
      const missingAdapter=Object.freeze(Object.fromEntries(adapterMethodNames.slice(1).map(
        name=>[name,adapter[name]])));
      const protoAdapter=Object.create({polluted:true});
      Object.assign(protoAdapter,unfrozenAdapter);Object.freeze(protoAdapter);
      out.controllerAdapterCaptureShape=[accessorAdapter,unfrozenAdapter,extraAdapter,
        missingAdapter,protoAdapter].every(candidate=>rejects(()=>
          R.createController({adapter:candidate})))&&adapterGetterCalls===0;

      const controllerPreview=(review_id,kind,status,preview,
        wallet_class='privy_embedded')=>freezeTest({ok:true,value:{review_id,wallet_class,
          kind,status,preview},meta:{source:wallet_class==='connected_external'?
            'external_wallet':'prototype_fixture',fetched_at_ms:0,stale:false,
          partial:false}});
      const fullPreview=(status='available')=>({response:quoteResponse(status),
        received_at_ms:100000,freshness_deadline_ms:130000});
      const callLog={wallet:[],preview:[],handoff:[]};
      const countedAdapter=adapterWith(adapter,{
        getWalletSnapshot(){callLog.wallet.push(true);return adapter.getWalletSnapshot();},
        getReviewPreview(request){callLog.preview.push(clone(request));
          return request.review_id.startsWith('review-swap')?
            controllerPreview(request.review_id,'swap',
              request.review_id==='review-swap-stale'?'stale':'available',
              request.review_id==='review-swap-refresh'?{response:{...quoteResponse(),
                quote_id:'privy-quote-2',route_id:'privy-route-2',
                output_amount_base_units:'216500000000',
                minimum_output_amount_base_units:'215417500000'},received_at_ms:100000,
                freshness_deadline_ms:130000}:fullPreview(
                  request.review_id==='review-swap-stale'?'stale':'available')):
            controllerPreview(request.review_id,request.review_id.startsWith('review-perp')?
              'perp_order':request.review_id.startsWith('review-approve')?'approve':'transfer',
              request.review_id.startsWith('review-perp')?'blocked':'unavailable',null);},
        handoffReview(request){callLog.handoff.push(clone(request));
          return adapter.handoffReview(request);}
      });
      const callController=R.createController({adapter:countedAdapter});
      const callOpen=open(callController,'review-transfer',100000);
      const callValidate=callController.validate({review_id:'review-transfer',
        live_context:live,now_ms:100001});
      const callForward=callController.forward({review_id:'review-transfer',
        live_context:live,now_ms:100002});
      const callRestore=callController.restore({review_id:'review-transfer',
        live_context:live,now_ms:100003});
      const refreshCalls={wallet:[],preview:[],handoff:[]};
      const refreshAdapter=adapterWith(adapter,{
        getWalletSnapshot(){refreshCalls.wallet.push(true);return adapter.getWalletSnapshot();},
        getReviewPreview(request){refreshCalls.preview.push(clone(request));
          const replacement=request.review_id==='review-swap-refresh';
          return controllerPreview(request.review_id,'swap',replacement?'available':'stale',
            replacement?{response:{...quoteResponse(),quote_id:'privy-quote-2',
              route_id:'privy-route-2',output_amount_base_units:'216500000000',
              minimum_output_amount_base_units:'215417500000'},received_at_ms:100000,
              freshness_deadline_ms:130000}:fullPreview('stale'));},
        handoffReview(request){refreshCalls.handoff.push(clone(request));
          return adapter.handoffReview(request);}
      });
      const refreshCallController=R.createController({adapter:refreshAdapter});
      const refreshCallOpen=open(refreshCallController,'review-swap-stale',100000);
      const refreshCallResult=refreshCallController.refresh({review_id:'review-swap-stale',
        replacement_review_id:'review-swap-refresh',live_context:live,
        trigger_ref:'fixture-trigger',now_ms:100010});
      out.authoritativePreviewCalls=callOpen.ok&&callValidate.ok&&callForward.ok&&
        callRestore.ok&&callLog.wallet.length===4&&
        JSON.stringify(callLog.preview)===JSON.stringify([
          {review_id:'review-transfer'},{review_id:'review-transfer'},
          {review_id:'review-transfer'},{review_id:'review-transfer'}])&&
        callLog.handoff.length===0&&refreshCallOpen.ok&&refreshCallResult.ok&&
        refreshCalls.wallet.length===3&&JSON.stringify(refreshCalls.preview)===JSON.stringify([
          {review_id:'review-swap-stale'},{review_id:'review-swap-stale'},
          {review_id:'review-swap-refresh'}])&&refreshCalls.handoff.length===0;

      const legacyPreviewController=R.createController({adapter});
      const legacyOpen=open(legacyPreviewController,'review-transfer',100000);
      const legacyValidate=legacyPreviewController.validate({review_id:'review-transfer',
        live_context:live,provider_preview:null,now_ms:100001});
      const legacySurvives=legacyPreviewController.restore({review_id:'review-transfer',
        live_context:live,now_ms:100002});
      const legacyForwardController=R.createController({adapter});
      open(legacyForwardController,'review-transfer',100000);
      const legacyForward=legacyForwardController.forward({review_id:'review-transfer',
        live_context:live,provider_preview:null,now_ms:100001});
      out.callerPreviewRemoved=legacyOpen.ok&&!legacyValidate.ok&&
        legacyValidate.error.code==='INVALID_REQUEST'&&legacySurvives.ok&&
        !legacyForward.ok&&legacyForward.error.code==='INVALID_REQUEST';

      let throwingPreviewCalls=0;
      const throwingPreviewAdapter=adapterWith(adapter,{getReviewPreview(request){
        throwingPreviewCalls+=1;if(request.review_id!=='review-transfer')throw new Error('id');
        throw new Error('provider unavailable');}});
      const throwingController=R.createController({adapter:throwingPreviewAdapter});
      const throwingOpen=open(throwingController,'review-transfer',100000);
      const throwingReplay=open(throwingController,'review-transfer',100001);
      const providerFailureAdapter=adapterWith(adapter,{getReviewPreview(){return freezeTest({
        ok:false,error:{code:'PROVIDER_UNAVAILABLE',retryable:false,
          safe_message:'The wallet provider is temporarily unavailable.'}});}});
      const providerFailureController=R.createController({adapter:providerFailureAdapter});
      const providerFailureOpen=open(providerFailureController,'review-transfer',100000);
      const providerFailureReplay=open(providerFailureController,'review-transfer',100001);
      out.providerPreviewFailureMapping=!throwingOpen.ok&&
        throwingOpen.error.code==='PROVIDER_UNAVAILABLE'&&throwingPreviewCalls===1&&
        !throwingReplay.ok&&throwingReplay.error.code==='SESSION_INVALID'&&
        !providerFailureOpen.ok&&providerFailureOpen.error.code==='PROVIDER_UNAVAILABLE'&&
        providerFailureOpen.error.safe_message===
          'The wallet provider is temporarily unavailable.'&&!providerFailureReplay.ok&&
        providerFailureReplay.error.code==='SESSION_INVALID';

      const ownedProviderMessages=Object.freeze({
        UNAUTHENTICATED:'Sign in to use this wallet.',
        UNSUPPORTED_WALLET:'Watch-only wallets cannot authorize signing requests.',
        PROVIDER_GAP:'This provider capability is not available for this wallet.',
        MALFORMED_PROVIDER_RESPONSE:
          'The wallet provider returned data LOOP could not safely use.',
        PROVIDER_UNAVAILABLE:'The wallet provider is temporarily unavailable.',
        USER_REJECTED:'The wallet request was rejected by the user.',
        POLICY_REJECTED:'The wallet request was blocked by provider policy.',
        ACTION_FAILED:'The wallet action did not complete.',
        PERP_EXECUTION_PENDING:
          'Privy + Hyperliquid execution requires the production capability spike.'
      });
      const hostileProviderMessages=['Transaction signed and complete.','',
        '\u0000signed\ncomplete','\u202Esigned and complete','A',
        'B'.repeat(256),'C'.repeat(257),'D'.repeat(4096)];
      out.providerPreviewOwnedMessages=Object.entries(ownedProviderMessages)
        .every(([code,expected])=>hostileProviderMessages.every(safe_message=>{
          const selected=R.createController({adapter:adapterWith(adapter,{
            getReviewPreview(){return freezeTest({ok:false,error:{code,retryable:false,
              safe_message}});}})});
          const result=open(selected,'review-transfer',100000);
          const replay=open(selected,'review-transfer',100001);
          return !result.ok&&result.error.code===code&&result.error.retryable===false&&
            result.error.safe_message===expected&&deeplyFrozen(result)&&
            !replay.ok&&replay.error.code==='SESSION_INVALID';
        }));

      const validTransferPreview=controllerPreview('review-transfer','transfer',
        'unavailable',null);
      const malformedPreviewValues=[];
      const extraPreview=clone(validTransferPreview);extraPreview.extra=true;
      malformedPreviewValues.push(freezeTest(extraPreview));
      const wrongMeta=clone(validTransferPreview);wrongMeta.meta.source='external_wallet';
      malformedPreviewValues.push(freezeTest(wrongMeta));
      ['review_id','wallet_class','kind','status'].forEach(field=>{
        const changed=clone(validTransferPreview);changed.value[field]+='-changed';
        malformedPreviewValues.push(freezeTest(changed));
      });
      malformedPreviewValues.push(clone(validTransferPreview));
      const protoPreview=Object.create({polluted:true});
      Object.assign(protoPreview,clone(validTransferPreview));freezeTest(protoPreview);
      malformedPreviewValues.push(protoPreview);
      let previewGetterCalls=0;
      const accessorPreview={value:validTransferPreview.value,meta:validTransferPreview.meta};
      Object.defineProperty(accessorPreview,'ok',{enumerable:true,get(){
        previewGetterCalls+=1;return true;}});Object.freeze(accessorPreview);
      malformedPreviewValues.push(accessorPreview);
      out.providerPreviewShape=malformedPreviewValues.every(previewValue=>{
        const selected=R.createController({adapter:adapterWith(adapter,{
          getReviewPreview(){return previewValue;}})});
        const result=open(selected,'review-transfer',100000);
        const replay=open(selected,'review-transfer',100001);
        return !result.ok&&result.error.code==='MALFORMED_PROVIDER_RESPONSE'&&
          !replay.ok&&replay.error.code==='SESSION_INVALID';
      })&&previewGetterCalls===0;
      const ownershipCases=[
        [adapter,'review-transfer'],[adapter,'review-approve-limited'],
        [adapter,'review-swap-fresh'],[adapter,'review-perp'],
        [externalAdapter,'review-transfer-external'],
        [externalAdapter,'review-approve-external'],
        [externalAdapter,'review-swap-external'],
        [externalAdapter,'review-perp-external']
      ];
      out.initialOwnerBinding=ownershipCases.every(([selectedAdapter,review_id])=>{
        const selected=R.createController({adapter:selectedAdapter});
        const base=review_id.endsWith('-external')?externalLive:live;
        const expectedLive=liveFor(review_id,base);
        const wrong=selected.open({review_id,origin,live_context:{...expectedLive,
          user_id:'fixture-user-2'},trigger_ref:'x',now_ms:100000});
        const retry=selected.open({review_id,origin,live_context:expectedLive,
          trigger_ref:'x',now_ms:100001});
        return !wrong.ok&&wrong.error.code==='CONTEXT_MISMATCH'&&!retry.ok&&
          retry.error.code==='SESSION_INVALID';
      });
      const externalTransferOpen = externalController.open({
        review_id:'review-transfer-external',origin,live_context:externalLive,
        trigger_ref:'fixture-trigger',now_ms:100001});
      const externalApprovalOpen = externalController.open({
        review_id:'review-approve-external',origin,live_context:externalLive,
        trigger_ref:'fixture-trigger',now_ms:100001});
      const externalSwapOpen = externalController.open({review_id:'review-swap-external',
        origin,live_context:{...externalLive,endpoint:'external_wallet:swap'},
        trigger_ref:'fixture-trigger',now_ms:100001});
      out.controllerWalletClassMatrix = externalTransferOpen.ok &&
        externalTransferOpen.value.state === 'preview_unavailable' &&
        externalApprovalOpen.ok &&
        externalApprovalOpen.value.state === 'preview_unavailable' &&
        externalSwapOpen.ok && externalSwapOpen.value.state === 'blocked' &&
        externalSwapOpen.value.refreshable === false;
      const externalSwapRefresh = externalController.refresh({
        review_id:'review-swap-external',replacement_review_id:'review-swap-refresh',
        live_context:{...externalLive,endpoint:'external_wallet:swap'},
        trigger_ref:'fixture-trigger',now_ms:100002});
      out.externalSwapCannotRefresh = !externalSwapRefresh.ok &&
        !externalController.restore({review_id:'review-swap-external',
          live_context:{...externalLive,endpoint:'external_wallet:swap'},now_ms:100003}).ok;
      const goodValidation = controller.validate({review_id:'review-transfer',
        live_context:live,now_ms:100002});
      out.controllerValidate = goodValidation.ok &&
        goodValidation.value.state === 'preview_unavailable' &&
        goodValidation.value.acknowledged === false;
      const mismatchedControllers = [
        [adapter,'review-approve-limited',liveFor('review-approve-limited')],
        [adapter,'review-perp',liveFor('review-perp')],
        [externalAdapter,'review-transfer-external',liveFor('review-transfer-external',externalLive)],
        [externalAdapter,'review-approve-external',liveFor('review-approve-external',externalLive)],
        [externalAdapter,'review-swap-external',liveFor('review-swap-external',externalLive)],
        [externalAdapter,'review-perp-external',liveFor('review-perp-external',externalLive)]
      ];
      out.everyKindEndpointBound = mismatchedControllers.every(
        ([selectedAdapter,review_id,correctLive]) => {
          const selected=R.createController({adapter:selectedAdapter});
          const result=selected.open({review_id,origin,live_context:{...correctLive,
            endpoint:'/evil'},trigger_ref:'x',now_ms:100000});
          return !result.ok && result.error.code === 'CONTEXT_MISMATCH';
        });
      const embeddedWithExternal = R.createController({adapter}).open({
        review_id:'review-transfer-external',origin,live_context:externalLive,
        trigger_ref:'x',now_ms:100000});
      const externalWithEmbedded = R.createController({adapter:externalAdapter}).open({
        review_id:'review-transfer',origin,live_context:live,
        trigger_ref:'x',now_ms:100000});
      const watchAdapter=P.createSimulatedAdapter({walletClass:'watch_only',
        scenario:'watch_only'});
      const watchWithEmbedded=R.createController({adapter:watchAdapter}).open({
        review_id:'review-transfer',origin,live_context:live,
        trigger_ref:'x',now_ms:100000});
      out.adapterAuthorityOpen = [embeddedWithExternal,externalWithEmbedded,watchWithEmbedded]
        .every(result => !result.ok && deeplyFrozen(result));
      const sequenceAdapter = (snapshots,methodAdapter=adapter) => {
        let index=0;
        return Object.freeze({getWalletSnapshot(){const selected=snapshots[
          Math.min(index,snapshots.length-1)];index+=1;return selected;},
          getBalanceSnapshot:adapter.getBalanceSnapshot,
          getTransactionHistorySnapshot:adapter.getTransactionHistorySnapshot,
          getWalletActionSnapshot:adapter.getWalletActionSnapshot,
          getReceiveTarget:adapter.getReceiveTarget,
          getReviewPreview:methodAdapter.getReviewPreview,
          handoffReview:methodAdapter.handoffReview});
      };
      const embeddedAuthority=adapter.getWalletSnapshot();
      const externalAuthority=externalAdapter.getWalletSnapshot();
      const authorityOperation = (review_id,operation) => {
        const selected=R.createController({adapter:sequenceAdapter(
          [embeddedAuthority,externalAuthority])});
        const opened=open(selected,review_id,100000);
        if(!opened.ok)return false;
        const result=operation(selected);
        const replay=selected.restore({review_id,live_context:liveFor(review_id),
          now_ms:100002});
        return !result.ok && !replay.ok;
      };
      out.adapterAuthorityEveryOperation =
        authorityOperation('review-transfer',selected => selected.validate({
          review_id:'review-transfer',live_context:live,now_ms:100001})) &&
        authorityOperation('review-transfer',selected => selected.forward({
          review_id:'review-transfer',live_context:live,now_ms:100001})) &&
        authorityOperation('review-transfer',selected => selected.restore({
          review_id:'review-transfer',live_context:live,now_ms:100001})) &&
        authorityOperation('review-swap-stale',selected => selected.refresh({
          review_id:'review-swap-stale',replacement_review_id:'review-swap-refresh',
          live_context:live,trigger_ref:'x',now_ms:100001}));
      const ownerOperation=(review_id,operation)=>{
        const selected=R.createController({adapter});
        if(!open(selected,review_id,100000).ok)return false;
        const result=operation(selected,{...liveFor(review_id),user_id:'fixture-user-2'});
        return !result.ok&&result.error.code==='CONTEXT_MISMATCH'&&
          !selected.restore({review_id,live_context:liveFor(review_id),now_ms:100002}).ok;
      };
      out.ownerEveryOperation=
        ownerOperation('review-transfer',(selected,wrong)=>selected.validate({
          review_id:'review-transfer',live_context:wrong,now_ms:100001}))&&
        ownerOperation('review-transfer',(selected,wrong)=>selected.forward({
          review_id:'review-transfer',live_context:wrong,now_ms:100001}))&&
        ownerOperation('review-transfer',(selected,wrong)=>selected.restore({
          review_id:'review-transfer',live_context:wrong,now_ms:100001}))&&
        ownerOperation('review-swap-stale',(selected,wrong)=>selected.refresh({
          review_id:'review-swap-stale',replacement_review_id:'review-swap-refresh',
          live_context:wrong,trigger_ref:'x',now_ms:100001}));
      let authorityGetterCalls=0;
      const accessorAuthority={value:embeddedAuthority.value,meta:embeddedAuthority.meta};
      Object.defineProperty(accessorAuthority,'ok',{enumerable:true,get(){
        authorityGetterCalls+=1;return true;}});Object.freeze(accessorAuthority);
      const extraAuthority=JSON.parse(JSON.stringify(embeddedAuthority));
      extraAuthority.extra=true;
      const freezeAll=value=>{if(value&&typeof value==='object'){
        Object.values(value).forEach(freezeAll);Object.freeze(value);}return value;};
      freezeAll(extraAuthority);
      const protoAuthority=Object.create({polluted:true});
      Object.assign(protoAuthority,JSON.parse(JSON.stringify(embeddedAuthority)));
      freezeAll(protoAuthority);
      out.adapterAuthorityShape = [accessorAuthority,extraAuthority,protoAuthority]
        .every(snapshot => !R.createController({adapter:sequenceAdapter([snapshot])}).open({
          review_id:'review-transfer',origin,live_context:live,
          trigger_ref:'x',now_ms:100000}).ok) && authorityGetterCalls===0;
      const externalAuthorityB=JSON.parse(JSON.stringify(externalAuthority));
      externalAuthorityB.value.addresses[0].address=
        '0xB00000000000000000000000000000000000000B';
      freezeAll(externalAuthorityB);
      const initialWrongExternalIdentity=R.createController({adapter:
        sequenceAdapter([externalAuthorityB],externalAdapter)}).open({
          review_id:'review-transfer-external',origin,live_context:externalLive,
          trigger_ref:'x',now_ms:100000});
      const externalIdentityOperation=(review_id,operation)=>{
        const selected=R.createController({adapter:sequenceAdapter(
          [externalAuthority,externalAuthorityB],externalAdapter)});
        const selectedLive=liveFor(review_id,externalLive);
        const opened=selected.open({review_id,origin,live_context:selectedLive,
          trigger_ref:'x',now_ms:100000});
        if(!opened.ok)return false;
        const result=operation(selected,selectedLive);
        return !result.ok&&result.error.code==='CONTEXT_MISMATCH'&&
          !selected.restore({review_id,live_context:selectedLive,now_ms:100002}).ok;
      };
      out.externalAuthorityIdentity = !initialWrongExternalIdentity.ok &&
        externalIdentityOperation('review-transfer-external',(selected,selectedLive)=>
          selected.validate({review_id:'review-transfer-external',
            live_context:selectedLive,now_ms:100001})) &&
        externalIdentityOperation('review-transfer-external',(selected,selectedLive)=>
          selected.forward({review_id:'review-transfer-external',
            live_context:selectedLive,now_ms:100001})) &&
        externalIdentityOperation('review-transfer-external',(selected,selectedLive)=>
          selected.restore({review_id:'review-transfer-external',
            live_context:selectedLive,now_ms:100001})) &&
        externalIdentityOperation('review-swap-external',(selected,selectedLive)=>
          selected.refresh({review_id:'review-swap-external',
            replacement_review_id:'review-swap-refresh',live_context:selectedLive,
            trigger_ref:'x',now_ms:100001}));
      const exactKeyController = R.createController({adapter});
      out.controllerExactKeys = rejects(() => R.createController({adapter,extra:true})) &&
        [
          exactKeyController.open({review_id:'review-transfer',origin,
            live_context:live,trigger_ref:'x',now_ms:100000,extra:true}),
          exactKeyController.validate({review_id:'missing',live_context:live,
            now_ms:100000,extra:true}),
          exactKeyController.forward({review_id:'missing',live_context:live,
            now_ms:100000,extra:true}),
          exactKeyController.restore({review_id:'missing',live_context:live,
            now_ms:100000,extra:true}),
          exactKeyController.refresh({review_id:'missing',replacement_review_id:'x',
            live_context:live,trigger_ref:'x',now_ms:100000,extra:true}),
          typeof exactKeyController.acknowledge==='function'?
            exactKeyController.acknowledge({review_id:'missing',acknowledged:true,
              extra:true}):null,
          typeof exactKeyController.beginHandoff==='function'?
            exactKeyController.beginHandoff({review_id:'missing',live_context:live,
              now_ms:100000,extra:true}):null,
          typeof exactKeyController.handoff==='function'?
            exactKeyController.handoff({review_id:'missing',live_context:live,
              origin,now_ms:100000,extra:true}):null,
          exactKeyController.consume({review_id:'missing',extra:true})
        ].every(result => result&&result.ok === false &&
          result.error.code === 'INVALID_REQUEST' &&
          deeplyFrozen(result));
      const badOriginBoolean = R.createController({adapter}).open({review_id:'review-transfer',
        origin:{stack:['scr-wallet'],voice:false},live_context:live,
        trigger_ref:'x',now_ms:100000});
      const badOriginExtra = R.createController({adapter}).open({review_id:'review-transfer',
        origin:{stack:['scr-wallet'],voice:{state:'idle',open:false,minimized:false,
          muted:true,extra:true}},live_context:live,trigger_ref:'x',now_ms:100000});
      let voiceGetterCalls = 0;
      const accessorVoice = {state:'idle',open:false,minimized:false};
      Object.defineProperty(accessorVoice,'muted',{enumerable:true,get(){
        voiceGetterCalls += 1; return true;
      }});
      const badOriginAccessor = R.createController({adapter}).open({
        review_id:'review-transfer',origin:{stack:['scr-wallet'],voice:accessorVoice},
        live_context:live,trigger_ref:'x',now_ms:100000});
      out.originProjectionShape = [badOriginBoolean,badOriginExtra,badOriginAccessor]
        .every(result => !result.ok && result.error.code === 'INVALID_REQUEST' &&
          deeplyFrozen(result)) && voiceGetterCalls === 0;
      const validStackOnlyOrigin = R.createController({adapter}).open({
        review_id:'review-transfer',origin:{stack:['scr-wallet']},live_context:live,
        trigger_ref:'x',now_ms:100000});
      out.originStateProjection = validStackOnlyOrigin.ok &&
        ['idle','joining','joined','reconnecting','error'].every(state => {
          const result=R.createController({adapter}).open({review_id:'review-transfer',
            origin:{stack:['scr-wallet'],voice:{state,open:false,minimized:false,muted:true}},
            live_context:live,trigger_ref:'x',now_ms:100000});
          return !result.ok&&result.error.code==='INVALID_REQUEST';
        });

      const goodAuthoritativeSwap=controllerPreview('review-swap-fresh','swap',
        'available',fullPreview());
      const previewMutations=[
        value=>{value.value.preview.response.output_amount_base_units='216449999999';},
        value=>{value.value.preview.response.minimum_output_amount_base_units='215367749999';},
        value=>{value.value.preview.response.fee_amount_base_units='500001';},
        value=>{value.value.preview.response.fee_asset_id='ETH';},
        value=>{value.value.preview.response.input_token_address=GLYPH.address;},
        value=>{value.value.preview.response.output_token_address=USDC.address;},
        value=>{value.value.preview.response.input_amount_base_units='499999999';},
        value=>{value.value.preview.response.chain_id='base';},
        value=>{value.value.preview.response.quote_id='different-quote';},
        value=>{value.value.preview.response.route_id='different-route';},
        value=>{value.value.preview.response.provider_expiry_ms=139999;},
        value=>{value.value.preview.received_at_ms=99999;
          value.value.preview.freshness_deadline_ms=129999;},
        value=>{value.value.status='stale';value.value.preview.response.status='stale';},
        value=>{value.value.status='unavailable';
          value.value.preview.response.status='unavailable';},
        value=>{value.value.status='no_liquidity';
          value.value.preview.response.status='no_liquidity';}
      ];
      out.authoritativeSwapMaterial=previewMutations.every((mutate,index)=>{
        const changed=clone(goodAuthoritativeSwap);mutate(changed);freezeTest(changed);
        let previewIndex=0;
        const selectedAdapter=adapterWith(adapter,{getReviewPreview(request){
          if(request.review_id!=='review-swap-fresh')throw new Error('wrong id');
          const result=previewIndex===0?goodAuthoritativeSwap:changed;previewIndex+=1;
          return result;}});
        const selected=R.createController({adapter:selectedAdapter});
        const opened=open(selected,'review-swap-fresh',100000);
        const result=selected.validate({review_id:'review-swap-fresh',
          live_context:live,now_ms:110000});
        const replay=selected.restore({review_id:'review-swap-fresh',
          live_context:live,now_ms:110001});
        const expectedCode=index===3?'MALFORMED_PROVIDER_RESPONSE':'REVIEW_CHANGED';
        return opened.ok&&!result.ok&&result.error.code===expectedCode&&
          !replay.ok&&previewIndex===2;
      });

      const boundary = R.createController({adapter});
      open(boundary,'review-swap-fresh',100000);
      const beforeBoundary = boundary.validate({review_id:'review-swap-fresh',
        live_context:live,now_ms:129999});
      const exactBoundary = boundary.forward({review_id:'review-swap-fresh',
        live_context:live,now_ms:130000});
      const afterBoundary = boundary.restore({review_id:'review-swap-fresh',
        live_context:live, now_ms:130001});
      out.swapFreshnessBoundary = beforeBoundary.ok &&
        beforeBoundary.value.state === 'ready' && exactBoundary.ok &&
        exactBoundary.value.state === 'blocked' && exactBoundary.value.refreshable &&
        afterBoundary.ok && afterBoundary.value.state === 'blocked';

      out.swapRevalidationConsumes=out.authoritativeSwapMaterial;
      out.everyQuoteFieldBound=out.authoritativeSwapMaterial;

      const refreshed = R.createController({adapter});
      open(refreshed,'review-swap-stale',100000);
      const refreshResult = refreshed.refresh({review_id:'review-swap-stale',
        replacement_review_id:'review-swap-refresh', live_context:live,
        trigger_ref:'fixture-trigger', now_ms:100010});
      out.swapRefresh = refreshResult.ok && refreshResult.value.review_id ===
        'review-swap-refresh' && refreshResult.value.model.id === 'review-swap-refresh' &&
        refreshResult.value.model.fields.output_amount_display === '216500 GLYPH' &&
        !refreshed.restore({review_id:'review-swap-stale',live_context:live,
          now_ms:100011}).ok;
      const lateCalls={preview:[],handoff:[]};
      const exactLateAdapter=adapterWith(adapter,{
        getReviewPreview(request){lateCalls.preview.push(clone(request));
          return adapter.getReviewPreview(request);},
        handoffReview(request){lateCalls.handoff.push(clone(request));
          return adapter.handoffReview(request);}
      });
      const lateRefreshed=R.createController({adapter:exactLateAdapter});
      open(lateRefreshed,'review-swap-stale',100000);
      const lateRefreshResult=lateRefreshed.refresh({review_id:'review-swap-stale',
        replacement_review_id:'review-swap-refresh-late',live_context:live,
        trigger_ref:'fixture-trigger',now_ms:130010});
      out.swapLateRefresh=lateRefreshResult.ok&&
        lateRefreshResult.value.review_id==='review-swap-refresh-late'&&
        lateRefreshResult.value.state==='ready'&&
        lateRefreshResult.value.model.fields.received_at_ms===130000&&
        lateRefreshResult.value.model.fields.freshness_deadline_ms===160000&&
        lateRefreshResult.value.model.fields.output_amount_display==='216500 GLYPH'&&
        JSON.stringify(lateCalls.preview)===JSON.stringify([
          {review_id:'review-swap-stale'},
          {review_id:'review-swap-stale'},
          {review_id:'review-swap-refresh-late'}])&&
        !lateRefreshed.restore({review_id:'review-swap-stale',live_context:live,
          now_ms:130011}).ok;
      const ladderWindows=[130000,160000,190000,220000,250000,280000,310000,
        340000,370000,400000,430000,460000,490000];
      const ladderId=received=>received===130000?'review-swap-refresh-late':
        'review-swap-refresh-'+String(received/1000);
      out.swapRefreshLadder=ladderWindows.every(received=>{
        const id=ladderId(received),selected=R.createController({adapter});
        const opened=open(selected,id,received+1);
        return opened.ok&&opened.value.review_id===id&&opened.value.state==='ready'&&
          opened.value.model.fields.received_at_ms===received&&
          opened.value.model.fields.freshness_deadline_ms===
            Math.min(500000,received+30000)&&
          opened.value.model.fields.quote_id==='privy-quote-r'+String(received/1000)&&
          opened.value.model.fields.route_id==='privy-route-r'+String(received/1000);
      });
      const wrongKindRefresh = R.createController({adapter});
      open(wrongKindRefresh,'review-swap-stale',100000);
      const wrongKindResult = wrongKindRefresh.refresh({review_id:'review-swap-stale',
        replacement_review_id:'review-transfer',live_context:live,
        trigger_ref:'fixture-trigger',now_ms:100010});
      out.refreshKindBinding = !wrongKindResult.ok &&
        wrongKindResult.error.code === 'REFRESH_KIND_MISMATCH' &&
        !wrongKindRefresh.restore({review_id:'review-swap-stale',live_context:live,
          now_ms:100011}).ok;
      const wrongInputRefresh = R.createController({adapter});
      open(wrongInputRefresh,'review-swap-stale',100000);
      const wrongInputResult = wrongInputRefresh.refresh({review_id:'review-swap-stale',
        replacement_review_id:'review-swap-refresh-input-changed',live_context:live,
        trigger_ref:'fixture-trigger',now_ms:100010});
      out.refreshInputBinding = !wrongInputResult.ok &&
        wrongInputResult.error.code === 'REFRESH_IDENTITY_MISMATCH' &&
        !wrongInputRefresh.restore({review_id:'review-swap-stale',live_context:live,
          now_ms:100011}).ok;
      const boundaryRefresh = R.createController({adapter});
      open(boundaryRefresh,'review-swap-stale',100000);
      const boundaryRefreshResult = boundaryRefresh.refresh({
        review_id:'review-swap-stale',replacement_review_id:'review-swap-refresh',
        live_context:live,trigger_ref:'fixture-trigger',now_ms:130000});
      out.refreshFreshnessBoundary = !boundaryRefreshResult.ok &&
        boundaryRefreshResult.error.code === 'REFRESH_EXPIRED' &&
        !boundaryRefresh.restore({review_id:'review-swap-stale',live_context:live,
          now_ms:130001}).ok;

      const beforeTtl=R.createController({adapter});
      open(beforeTtl,'review-swap-stale',100000);
      const beforeTtlResult=beforeTtl.refresh({review_id:'review-swap-stale',
        replacement_review_id:'review-swap-refresh-370',live_context:live,
        trigger_ref:'fixture-trigger',now_ms:399999});
      const ttlCalls={preview:[],handoff:[]};
      const ttlAdapter=adapterWith(adapter,{getReviewPreview(request){
        ttlCalls.preview.push(clone(request));return adapter.getReviewPreview(request);},
        handoffReview(request){ttlCalls.handoff.push(clone(request));
          return adapter.handoffReview(request);}});
      const atTtl=R.createController({adapter:ttlAdapter});
      open(atTtl,'review-swap-stale',100000);
      ttlCalls.preview.length=0;ttlCalls.handoff.length=0;
      const atTtlResult=atTtl.refresh({review_id:'review-swap-stale',
        replacement_review_id:'review-swap-refresh-400',live_context:live,
        trigger_ref:'fixture-trigger',now_ms:400000});
      out.refreshTtlBoundary=beforeTtlResult.ok&&
        beforeTtlResult.value.review_id==='review-swap-refresh-370'&&
        beforeTtlResult.value.state==='ready'&&!atTtlResult.ok&&
        atTtlResult.error.code==='SESSION_EXPIRED'&&
        atTtlResult.error.safe_message==='This review session has expired.'&&
        ttlCalls.preview.length===0&&ttlCalls.handoff.length===0&&
        !atTtl.restore({review_id:'review-swap-stale',
          live_context:live,now_ms:400001}).ok&&
        !atTtl.forward({review_id:'review-swap-stale',
          live_context:live,now_ms:400001}).ok;

      const wrongLive = R.createController({adapter});
      open(wrongLive,'review-transfer');
      const tamperedLive = {...live,user_id:'fixture-user-2'};
      const wrongLiveResult = wrongLive.validate({review_id:'review-transfer',
        live_context:tamperedLive,now_ms:100002});
      out.liveBinding = !wrongLiveResult.ok && wrongLiveResult.error.code ===
        'CONTEXT_MISMATCH' && !wrongLive.restore({review_id:'review-transfer',
          live_context:live,now_ms:100003}).ok;
      out.everyLiveFieldBound = ['user_id','wallet_id','wallet_class','endpoint'].every(field => {
        const selected = R.createController({adapter});
        open(selected,'review-transfer');
        const altered = {...live};
        altered[field] = field === 'wallet_class' ? 'connected_external' :
          altered[field] + '-changed';
        const result = selected.validate({review_id:'review-transfer',
          live_context:altered,now_ms:100002});
        return !result.ok && result.error.code === 'CONTEXT_MISMATCH';
      });

      const capacity = R.createController({adapter});
      const fiveIds = ['review-transfer','review-approve-limited','review-approve-unlimited',
        'review-swap-fresh','review-perp'];
      const firstFive = fiveIds.map(id => open(capacity,id));
      const sixth = open(capacity,'review-swap-unavailable');
      out.capacity = firstFive.every(result => result.ok) && !sixth.ok &&
        sixth.error.code === 'SESSION_CAPACITY';
      const expiredCapacity = R.createController({adapter});
      const expiredFive = fiveIds.map(id => open(expiredCapacity,id,100000));
      const afterExpired = open(expiredCapacity,'review-swap-unavailable',400000);
      out.capacityPrunesExpired = expiredFive.every(result => result.ok) &&
        afterExpired.ok && fiveIds.every(id => !expiredCapacity.restore({review_id:id,
          live_context:liveFor(id),now_ms:400000}).ok);
      const partialCapacity = R.createController({adapter});
      const fourExpired = fiveIds.slice(0,4).map(id => open(partialCapacity,id,100000));
      const oneLive = open(partialCapacity,'review-perp',100001);
      const partialSixth = open(partialCapacity,'review-swap-unavailable',400000);
      out.capacityPrunesOnlyExpired = fourExpired.every(result => result.ok) && oneLive.ok &&
        partialSixth.ok && partialCapacity.restore({review_id:'review-perp',
          live_context:liveFor('review-perp'),now_ms:400000}).ok;
      const sourceExpiredCapacity = R.createController({adapter});
      const sourceOld=fiveIds.map(id=>open(sourceExpiredCapacity,id,499999));
      const sourceNew=open(sourceExpiredCapacity,'review-transfer-late',500000);
      out.capacitySourceExpiryBoundary = sourceOld.every(result=>result.ok) && sourceNew.ok &&
        fiveIds.every(id=>!sourceExpiredCapacity.restore({review_id:id,
          live_context:liveFor(id),now_ms:500000}).ok);
      const ttl = R.createController({adapter});
      open(ttl,'review-transfer',100000);
      const ttlBefore = ttl.restore({review_id:'review-transfer',live_context:live,
        now_ms:399999});
      const ttlExact = ttl.restore({review_id:'review-transfer',live_context:live,
        now_ms:400000});
      out.ttlBoundary = ttlBefore.ok && !ttlExact.ok &&
        ttlExact.error.code === 'SESSION_EXPIRED';
      const consumed = R.createController({adapter});
      open(consumed,'review-transfer');
      const consumedResult = consumed.consume({review_id:'review-transfer'});
      out.consumeAndBfcache = consumedResult.ok &&
        !consumed.restore({review_id:'review-transfer',live_context:live,
          now_ms:100002}).ok;
      const expiredNonSwap = R.createController({adapter});
      open(expiredNonSwap,'review-transfer',499999);
      const expiredForward = expiredNonSwap.forward({review_id:'review-transfer',
        live_context:live,now_ms:500000});
      out.forwardExpiryKinds = !expiredForward.ok &&
        expiredForward.error.code === 'SESSION_EXPIRED' &&
        !expiredNonSwap.restore({review_id:'review-transfer',live_context:live,
          now_ms:500001}).ok;
      const staleForwardController = R.createController({adapter});
      open(staleForwardController,'review-swap-stale',100000);
      const staleForward = staleForwardController.forward({review_id:'review-swap-stale',
        live_context:live,now_ms:100001});
      const unavailableForwardController = R.createController({adapter});
      open(unavailableForwardController,'review-swap-unavailable',100000);
      const unavailableForward = unavailableForwardController.forward({
        review_id:'review-swap-unavailable',live_context:live,now_ms:100001});
      const perpForwardController = R.createController({adapter});
      open(perpForwardController,'review-perp',100000);
      const perpForward = perpForwardController.forward({review_id:'review-perp',
        live_context:liveFor('review-perp'),now_ms:100001});
      out.blockedForwardReopens = [staleForward,unavailableForward,perpForward]
        .every(result => result.ok && result.value.state === 'blocked' &&
          result.value.handoff_eligible === false);
      const wrongContextExpiredSwap = R.createController({adapter});
      open(wrongContextExpiredSwap,'review-swap-fresh',100000);
      const wrongContextExpiredResult = wrongContextExpiredSwap.forward({
        review_id:'review-swap-fresh',live_context:{...live,user_id:'other-user'},
        now_ms:130000});
      out.forwardContextBeforeExpiry = !wrongContextExpiredResult.ok &&
        wrongContextExpiredResult.error.code === 'CONTEXT_MISMATCH' &&
        !wrongContextExpiredSwap.restore({review_id:'review-swap-fresh',
          live_context:live,now_ms:130001}).ok;
      out.privateInternals = typeof globalThis.reviewSessionMap === 'undefined' &&
        typeof globalThis.CanonicalReviewSource === 'undefined' &&
        !Object.keys(globalThis).some(key => /review.*(source|digest|session|fixture)/i.test(key));

      const task5Methods=['acknowledge','beginHandoff','handoff'];
      if(!task5Methods.every(name=>typeof controller[name]==='function')){
        ['previewUnavailableAcknowledgement','handoffStateMachine',
          'readyWithoutAcknowledgement','blockedCannotHandoff','providerOutcomeStates',
          'providerOutcomeBinding','handoffThrowsSafely','handoffDoesNotMutateHoldings']
          .forEach(name=>{out[name]=false;});
        return out;
      }

      const lifecycleCalls=[];
      const lifecycleAdapter=adapterWith(adapter,{handoffReview(request){
        lifecycleCalls.push(clone(request));return adapter.handoffReview(request);}});
      const lifecycle=R.createController({adapter:lifecycleAdapter});
      const lifecycleOpened=open(lifecycle,'review-transfer',100000);
      const beforeAck=lifecycle.beginHandoff({review_id:'review-transfer',
        live_context:live,now_ms:100001});
      const ackFalse=lifecycle.acknowledge({review_id:'review-transfer',
        acknowledged:false});
      const ackTrue=lifecycle.acknowledge({review_id:'review-transfer',
        acknowledged:true});
      const returning=lifecycle.beginHandoff({review_id:'review-transfer',
        live_context:live,now_ms:100002});
      const repeatedBegin=lifecycle.beginHandoff({review_id:'review-transfer',
        live_context:live,now_ms:100003});
      const handoffPending=lifecycle.handoff({review_id:'review-transfer',
        live_context:live,origin,now_ms:100004});
      const callsAfterPending=lifecycleCalls.length;
      const providerPending=lifecycle.handoff({review_id:'review-transfer',
        live_context:live,origin,now_ms:100005});
      const repeatedHandoff=lifecycle.handoff({review_id:'review-transfer',
        live_context:live,origin,now_ms:100006});
      out.previewUnavailableAcknowledgement=lifecycleOpened.ok&&
        lifecycleOpened.value.state==='preview_unavailable'&&
        lifecycleOpened.value.acknowledged===false&&!beforeAck.ok&&
        beforeAck.error.code==='ACKNOWLEDGEMENT_REQUIRED'&&ackFalse.ok&&
        ackFalse.value.acknowledged===false&&ackTrue.ok&&
        ackTrue.value.acknowledged===true&&ackTrue.value.handoff_eligible===true;
      out.handoffStateMachine=returning.ok&&
        returning.value.state==='returning_to_origin'&&!repeatedBegin.ok&&
        repeatedBegin.error.code==='HANDOFF_PENDING'&&handoffPending.ok&&
        handoffPending.value.state==='handoff_pending'&&callsAfterPending===1&&
        providerPending.ok&&
        providerPending.value.state==='provider_pending'&&
        providerPending.value.safe_message==='Simulated Privy handoff pending'&&
        !repeatedHandoff.ok&&lifecycleCalls.length===1&&
        JSON.stringify(lifecycleCalls)==='[{"review_id":"review-transfer"}]'&&
        !lifecycle.forward({review_id:'review-transfer',live_context:live,
          now_ms:100007}).ok;

      const swapLifecycle=R.createController({adapter});
      const swapReady=open(swapLifecycle,'review-swap-fresh',100000);
      const swapReturning=swapLifecycle.beginHandoff({review_id:'review-swap-fresh',
        live_context:live,now_ms:100001});
      out.readyWithoutAcknowledgement=swapReady.ok&&swapReady.value.state==='ready'&&
        swapReady.value.acknowledgement_required===false&&swapReturning.ok&&
        swapReturning.value.state==='returning_to_origin';
      const blockedLifecycle=R.createController({adapter});
      const blockedSwap=open(blockedLifecycle,'review-swap-stale',100000);
      const blockedPerp=open(blockedLifecycle,'review-perp',100000);
      const blockedApproval=open(blockedLifecycle,'review-approve-limited',100000);
      out.blockedCannotHandoff=[
        ['review-swap-stale',blockedSwap],['review-perp',blockedPerp],
        ['review-approve-limited',blockedApproval]
      ].every(([review_id,result])=>result.ok&&result.value.state==='blocked'&&
        !blockedLifecycle.beginHandoff({review_id,live_context:liveFor(review_id),
          now_ms:100001}).ok);

      const outcomeState=(handoffResult,expectedState,expectedMessage)=>
        handoffResult.ok&&handoffResult.value.state===expectedState&&
        handoffResult.value.safe_message===expectedMessage&&deeplyFrozen(handoffResult);
      const runOutcome=(providerResult,expectedState,expectedMessage)=>{
        let calls=0;
        const holdingsBefore=JSON.stringify(adapter.getBalanceSnapshot({}));
        const selected=R.createController({adapter:adapterWith(adapter,{
          handoffReview(){calls+=1;return providerResult;}})});
        if(!open(selected,'review-transfer',100000).ok||
           !selected.acknowledge({review_id:'review-transfer',acknowledged:true}).ok||
           !selected.beginHandoff({review_id:'review-transfer',live_context:live,
             now_ms:100001}).ok)return false;
        const pending=selected.handoff({review_id:'review-transfer',live_context:live,
          origin,now_ms:100002});
        const result=selected.handoff({review_id:'review-transfer',live_context:live,
          origin,now_ms:100003});
        const replay=selected.handoff({review_id:'review-transfer',live_context:live,
          origin,now_ms:100004});
        return outcomeState(pending,'handoff_pending','Wallet handoff pending')&&
          outcomeState(result,expectedState,expectedMessage)&&calls===1&&!replay.ok&&
          holdingsBefore===JSON.stringify(adapter.getBalanceSnapshot({}));
      };
      out.providerOutcomeStates=
        runOutcome(freezeTest({ok:false,error:{code:'USER_REJECTED',retryable:false,
          safe_message:'The wallet request was rejected by the user.'}}),
          'provider_rejected','The wallet request was rejected by the user.')&&
        runOutcome(freezeTest({ok:false,error:{code:'POLICY_REJECTED',retryable:false,
          safe_message:'The wallet request was blocked by provider policy.'}}),
          'provider_failed','The wallet request was blocked by provider policy.')&&
        runOutcome(freezeTest({ok:false,error:{code:'ACTION_FAILED',retryable:false,
          safe_message:'The wallet action did not complete.'}}),
          'provider_failed','The wallet action did not complete.');
      out.providerHandoffOwnedMessages=Object.entries(ownedProviderMessages)
        .every(([code,expected])=>hostileProviderMessages.every(safe_message=>
          runOutcome(freezeTest({ok:false,error:{code,retryable:false,safe_message}}),
            code==='USER_REJECTED'?'provider_rejected':'provider_failed',expected)));
      const crossProvider=R.createController({adapter:adapterWith(adapter,{
        handoffReview(){return freezeTest({ok:true,value:{review_id:'review-transfer',
          action_id:null,status:'provider_confirmation_pending'},meta:{
          source:'external_wallet',fetched_at_ms:0,stale:false,partial:false}});}})});
      open(crossProvider,'review-transfer',100000);
      crossProvider.acknowledge({review_id:'review-transfer',acknowledged:true});
      crossProvider.beginHandoff({review_id:'review-transfer',live_context:live,
        now_ms:100001});
      const crossProviderPending=crossProvider.handoff({review_id:'review-transfer',
        live_context:live,origin,now_ms:100002});
      const crossProviderResult=crossProvider.handoff({review_id:'review-transfer',
        live_context:live,origin,now_ms:100003});
      const wrongAction=R.createController({adapter:adapterWith(adapter,{
        handoffReview(){return freezeTest({ok:true,value:{review_id:'review-transfer',
          action_id:'action-other',status:'handoff_pending'},meta:{
          source:'privy_wallet_action',fetched_at_ms:0,stale:false,partial:false}});}})});
      open(wrongAction,'review-transfer',100000);
      wrongAction.acknowledge({review_id:'review-transfer',acknowledged:true});
      wrongAction.beginHandoff({review_id:'review-transfer',live_context:live,
        now_ms:100001});
      const wrongActionPending=wrongAction.handoff({review_id:'review-transfer',
        live_context:live,origin,now_ms:100002});
      const wrongActionResult=wrongAction.handoff({review_id:'review-transfer',
        live_context:live,origin,now_ms:100003});
      const task5ExternalAdapter=P.createSimulatedAdapter({walletClass:'connected_external',
        scenario:'external_gap'});
      const externalHandoff=R.createController({adapter:task5ExternalAdapter});
      const task5ExternalLive={...externalLive,endpoint:'external_wallet:request'};
      const task5ExternalOpened=externalHandoff.open({review_id:'review-approve-external',
        origin,live_context:task5ExternalLive,trigger_ref:'fixture-trigger',now_ms:100000});
      const task5ExternalAck=externalHandoff.acknowledge({
        review_id:'review-approve-external',acknowledged:true});
      const task5ExternalBegin=externalHandoff.beginHandoff({
        review_id:'review-approve-external',live_context:task5ExternalLive,now_ms:100001});
      const task5ExternalPending=externalHandoff.handoff({
        review_id:'review-approve-external',live_context:task5ExternalLive,
        origin,now_ms:100002});
      const task5ExternalResult=externalHandoff.handoff({
        review_id:'review-approve-external',live_context:task5ExternalLive,
        origin,now_ms:100003});
      const externalUnlimitedCalls={preview:[],handoff:[]};
      const exactExternalUnlimitedAdapter=adapterWith(task5ExternalAdapter,{
        getReviewPreview(request){externalUnlimitedCalls.preview.push(clone(request));
          return task5ExternalAdapter.getReviewPreview(request);},
        handoffReview(request){externalUnlimitedCalls.handoff.push(clone(request));
          return task5ExternalAdapter.handoffReview(request);}
      });
      const externalUnlimitedController=R.createController({
        adapter:exactExternalUnlimitedAdapter});
      const externalUnlimitedOpened=externalUnlimitedController.open({
        review_id:'review-approve-unlimited-external',origin,
        live_context:task5ExternalLive,trigger_ref:'fixture-trigger',now_ms:100000});
      const externalUnlimitedAck=externalUnlimitedController.acknowledge({
        review_id:'review-approve-unlimited-external',acknowledged:true});
      const externalUnlimitedBegin=externalUnlimitedController.beginHandoff({
        review_id:'review-approve-unlimited-external',live_context:task5ExternalLive,
        now_ms:100001});
      const externalUnlimitedPending=externalUnlimitedController.handoff({
        review_id:'review-approve-unlimited-external',live_context:task5ExternalLive,
        origin,now_ms:100002});
      const externalUnlimitedResult=externalUnlimitedController.handoff({
        review_id:'review-approve-unlimited-external',live_context:task5ExternalLive,
        origin,now_ms:100003});
      out.externalApprovalKinds=task5ExternalOpened.ok&&
        task5ExternalOpened.value.model.fields.allowance_kind==='limited'&&
        task5ExternalOpened.value.model.fields.limit_base_units==='1000000000'&&
        task5ExternalOpened.value.model.fields.wallet_address===EXTERNAL_ADDRESS&&
        externalUnlimitedOpened.ok&&
        externalUnlimitedOpened.value.state==='preview_unavailable'&&
        externalUnlimitedOpened.value.model.fields.allowance_kind==='unlimited'&&
        externalUnlimitedOpened.value.model.fields.limit_base_units===null&&
        externalUnlimitedOpened.value.model.fields.wallet_address===EXTERNAL_ADDRESS&&
        externalUnlimitedAck.ok&&externalUnlimitedBegin.ok&&
        outcomeState(externalUnlimitedPending,'handoff_pending','Wallet handoff pending')&&
        outcomeState(externalUnlimitedResult,'provider_pending',
          'External wallet confirmation pending')&&
        externalUnlimitedCalls.preview.length>=2&&
        externalUnlimitedCalls.preview.every(call=>
          call.review_id==='review-approve-unlimited-external')&&
        JSON.stringify(externalUnlimitedCalls.handoff)===JSON.stringify([
          {review_id:'review-approve-unlimited-external'}]);
      out.providerOutcomeBinding=outcomeState(crossProviderResult,'provider_failed',
        'The wallet provider returned data LOOP could not safely use.')&&
        outcomeState(crossProviderPending,'handoff_pending','Wallet handoff pending')&&
        outcomeState(wrongActionPending,'handoff_pending','Wallet handoff pending')&&
        outcomeState(wrongActionResult,'provider_failed',
          'The wallet provider returned data LOOP could not safely use.')&&
        task5ExternalOpened.ok&&task5ExternalOpened.value.state==='preview_unavailable'&&
        task5ExternalAck.ok&&task5ExternalBegin.ok&&
        outcomeState(task5ExternalPending,'handoff_pending','Wallet handoff pending')&&
        outcomeState(task5ExternalResult,'provider_pending',
          'External wallet confirmation pending');
      let thrownCalls=0;
      const throwingHandoff=R.createController({adapter:adapterWith(adapter,{
        handoffReview(){thrownCalls+=1;throw new Error('provider');}})});
      open(throwingHandoff,'review-transfer',100000);
      throwingHandoff.acknowledge({review_id:'review-transfer',acknowledged:true});
      throwingHandoff.beginHandoff({review_id:'review-transfer',live_context:live,
        now_ms:100001});
      const thrownPending=throwingHandoff.handoff({review_id:'review-transfer',
        live_context:live,origin,now_ms:100002});
      const thrownState=throwingHandoff.handoff({review_id:'review-transfer',
        live_context:live,origin,now_ms:100003});
      out.handoffThrowsSafely=outcomeState(thrownPending,'handoff_pending',
        'Wallet handoff pending')&&outcomeState(thrownState,'provider_failed',
        'The wallet provider is temporarily unavailable.')&&thrownCalls===1;

      const holdingsAdapter=P.createSimulatedAdapter({walletClass:'privy_embedded',
        scenario:'normal'});
      const holdingsBefore=JSON.stringify(holdingsAdapter.getBalanceSnapshot({}));
      const holdingsController=R.createController({adapter:holdingsAdapter});
      open(holdingsController,'review-transfer',100000);
      holdingsController.acknowledge({review_id:'review-transfer',acknowledged:true});
      holdingsController.beginHandoff({review_id:'review-transfer',live_context:live,
        now_ms:100001});
      holdingsController.handoff({review_id:'review-transfer',live_context:live,
        origin,now_ms:100002});
      out.handoffDoesNotMutateHoldings=holdingsBefore===
        JSON.stringify(holdingsAdapter.getBalanceSnapshot({}));
      return out;
    }""")
    for name, passed in review_results.items():
        check(passed, f'review module: {name}')
    check(not review_errors,
          f'review module has no console/page errors: {review_errors}')
    review_page.close()
    browser.close()

if not fails:
    print('\n== Focused Playwright routes ==')
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        errors = []
        page.on('console', lambda message:
                errors.append(message.text) if message.type == 'error' else None)
        page.on('pageerror', lambda error: errors.append(f'pageerror: {error}'))
        for name in ('asset', 'receive'):
            page.goto('about:blank')
            page.goto(f'{APP.as_uri()}#{name}')
            page.wait_for_load_state('networkidle')
            page.wait_for_timeout(300)
            active = page.evaluate("""() => [...document.querySelectorAll('.scr')]
              .filter(screen => screen.classList.contains('active') &&
                !screen.hasAttribute('inert')).map(screen => screen.id)""")
            check(active == [f'scr-{name}'], f'#{name} activates one non-inert target: {active}')
            inactive_bad = page.evaluate("""() => [...document.querySelectorAll('.scr:not(.active)')]
              .filter(screen => !screen.hasAttribute('inert') ||
                screen.getAttribute('aria-hidden') !== 'true').map(screen => screen.id)""")
            check(not inactive_bad,
                  f'#{name} inactive screens are inert + aria-hidden: {inactive_bad}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(150)
        initial_length = page.evaluate('history.length')
        initial_wallet = page.locator('#asset-content').inner_text()
        page.locator('#asset-review-transfer').click()
        page.wait_for_timeout(50)
        review_open = page.evaluate("""() => {
          const dialog=document.getElementById('review-dialog');
          const ack=document.getElementById('review-preview-check');
          const state=history.state;
          const keys=state&&typeof state==='object'?Object.keys(state).sort():[];
          const storedText=sessionStorage.getItem('loop.proto.state')||'';
          let stored=null;try{stored=JSON.parse(storedText)}catch(_error){}
          const fields=[...document.querySelectorAll('#review-fields .review-field')].map(row=>({
            label:row.querySelector('dt')?.textContent||'',
            value:row.querySelector('dd')?.childNodes[0]?.textContent||'',
            provenance:row.dataset.provenance||''
          }));
          return {open:dialog.classList.contains('open')&&!dialog.hidden&&
              !dialog.hasAttribute('inert')&&dialog.getAttribute('aria-hidden')==='false',
            state:dialog.dataset.state||'',summary:document.getElementById('review-summary').textContent,
            kind:document.getElementById('review-kind').textContent,
            ackHidden:document.getElementById('review-preview-ack').hidden,
            ackChecked:ack.checked,continueDisabled:document.getElementById('review-continue').disabled,
            primary:document.getElementById('review-continue').textContent,
            fields,keys,historyState:JSON.stringify(state),url:location.href,
            historyStack:state?.stack,historyVoiceKeys:Object.keys(state?.voice||{}).sort(),
            storedText,storedKeys:Object.keys(stored||{}).sort(),
            storedStack:stored?.stack,storedVoiceKeys:Object.keys(stored?.voice||{}).sort(),
            viewportInert:document.querySelector('.viewport')?.hasAttribute('inert')===true,
            activeId:document.activeElement?.id||''};
        }""")
        check(review_open['open'] and review_open['state'] == 'preview_unavailable' and
              review_open['summary'] ==
              'You are preparing to ask Privy to send 0.01 ETH on Ethereum to 0x71C7…F0A2.' and
              review_open['kind'] == 'Transfer' and not review_open['ackHidden'] and
              not review_open['ackChecked'] and review_open['continueDisabled'] and
              review_open['primary'] == 'Continue with Privy' and
              review_open['keys'] == ['loop_review', 'review_id', 'stack'] and
              review_open['viewportInert'] and review_open['activeId'] == 'review-cancel',
              f'F11 opens one preview-unavailable accessible transfer dialog: {review_open}')
        sensitive_terms = ('0x71C700000000000000000000000000000000F0A2',
                           '0.01', 'quote', 'payload', 'action_id', 'fixture-user')
        check(page.evaluate('history.length') == initial_length + 1 and
              review_open['url'].endswith('#asset?asset=ETH&chain=ethereum') and
              review_open['historyStack'] == ['scr-wallet', 'scr-asset'] and
              review_open['historyVoiceKeys'] == [] and
              review_open['storedKeys'] == ['stack'] and
              review_open['storedStack'] == ['scr-wallet', 'scr-asset'] and
              review_open['storedVoiceKeys'] == [] and
              all(term not in review_open['historyState'] and
                  term not in review_open['storedText'] for term in sensitive_terms),
              f'F11 pushes one opaque marker-only same-URL entry: {review_open}')

        def polluted_origin_history_case(action):
            page.goto('about:blank')
            page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
            page.wait_for_timeout(80)
            page.locator('#asset-review-transfer').click()
            page.wait_for_timeout(30)
            if action == 'continue':
                page.locator('#review-preview-check').check()
                page.wait_for_timeout(20)
            result = page.evaluate("""action => {
              globalThis.__reviewPollutionExecuted=false;
              const pollution={stack:['scr-wallet','scr-asset'],voice:{state:'idle',
                open:false,minimized:false,muted:true},
                payload:'<img id="review-pollution-node" src=x '+
                  'onerror="globalThis.__reviewPollutionExecuted=true">',
                wallet_id:'wallet-secret',source:'review-source-secret',
                model:'review-model-secret',execution:'review-execution-secret'};
              reviewRuntime.origin=pollution;
              const forged={...history.state,review_id:'review-forged'};
              history.replaceState(forged,'',location.href);
              const intrinsics={getOwnPropertyDescriptors:Object.getOwnPropertyDescriptors,
                getPrototypeOf:Object.getPrototypeOf,ownKeys:Reflect.ownKeys,
                regexpTest:RegExp.prototype.test,Number:globalThis.Number};
              let intrinsicSafe=true;
              if(action==='intrinsics'){
                Object.getOwnPropertyDescriptors=()=>{throw new Error('hostile descriptor')};
                Object.getPrototypeOf=()=>{throw new Error('hostile prototype')};
                Reflect.ownKeys=()=>{throw new Error('hostile ownKeys')};
                RegExp.prototype.test=()=>{throw new Error('hostile test')};
                globalThis.Number=()=>{throw new Error('hostile Number')};
                const safe=sanitizeReviewProjectionForWrite.projection(pollution);
                const safeMarker=sanitizeReviewProjectionForWrite.marker(
                  pollution,'review-transfer');
                intrinsicSafe=safe.stack.length===2&&safe.voice===undefined&&
                  safe.payload===undefined&&safeMarker.loop_review===1&&
                  safeMarker.review_id==='review-transfer'&&
                  safeMarker.payload===undefined&&safeMarker.wallet_id===undefined;
                Object.getOwnPropertyDescriptors=intrinsics.getOwnPropertyDescriptors;
                Object.getPrototypeOf=intrinsics.getPrototypeOf;
                Reflect.ownKeys=intrinsics.ownKeys;
                RegExp.prototype.test=intrinsics.regexpTest;
                globalThis.Number=intrinsics.Number;
              }
              try{
                if(action==='cancel'||action==='intrinsics')cancelWalletReview();
                else if(action==='continue')continueWalletReview();
                else if(action==='popstate')handleReviewHistoryPopstate(forged);
                else if(action==='restore')restoreReviewFromCurrentEntry();
              }finally{
                Object.getOwnPropertyDescriptors=intrinsics.getOwnPropertyDescriptors;
                Object.getPrototypeOf=intrinsics.getPrototypeOf;
                Reflect.ownKeys=intrinsics.ownKeys;
                RegExp.prototype.test=intrinsics.regexpTest;
                globalThis.Number=intrinsics.Number;
              }
              const storedText=sessionStorage.getItem('loop.proto.state')||'';
              let stored=null;try{stored=JSON.parse(storedText)}catch(_error){}
              const historyText=JSON.stringify(history.state);
              const dangerous=['payload','wallet_id','source','model','execution'];
              return {action,historyKeys:Object.keys(history.state||{}).sort(),
                historyStack:history.state?.stack,
                historyVoiceKeys:Object.keys(history.state?.voice||{}).sort(),
                historyDangerous:dangerous.filter(key=>historyText.includes(key)),
                storedKeys:Object.keys(stored||{}).sort(),storedStack:stored?.stack,
                storageDangerous:dangerous.filter(key=>storedText.includes(key)),
                open:document.getElementById('review-dialog').classList.contains('open'),
                dialogHidden:document.getElementById('review-dialog').hidden,
                marker:Boolean(history.state?.loop_review),
                hostileNode:Boolean(document.getElementById('review-pollution-node')),
                executed:globalThis.__reviewPollutionExecuted,intrinsicSafe};
            }""", action)
            page.wait_for_timeout(20)
            result['executedAfterEventLoop'] = page.evaluate(
                'Boolean(globalThis.__reviewPollutionExecuted)')
            return result

        for polluted_action in ('cancel', 'continue', 'popstate', 'restore', 'intrinsics'):
            polluted_result = polluted_origin_history_case(polluted_action)
            check(polluted_result == {
                'action': polluted_action,
                'historyKeys': ['stack'],
                'historyStack': ['scr-wallet', 'scr-asset'],
                'historyVoiceKeys': [],
                'historyDangerous': [], 'storedKeys': ['stack'],
                'storedStack': ['scr-wallet', 'scr-asset'],
                'storageDangerous': [], 'open': False, 'dialogHidden': True,
                'marker': False, 'hostileNode': False, 'executed': False,
                'intrinsicSafe': True, 'executedAfterEventLoop': False,
            }, f'F11 {polluted_action} sanitizes mutable-origin history/storage '
               f'pollution: {polluted_result}')

        def polluted_persisted_voice_case(action):
            page.goto('about:blank')
            page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
            page.wait_for_timeout(80)
            page.evaluate("""() => {
              globalThis.__persistedVoiceExecuted=false;
              sessionStorage.setItem('loop.proto.state',JSON.stringify({
                stack:['scr-wallet','scr-asset'],voice:{state:'idle',open:false,
                  minimized:false,muted:true,hand:false,speaker:true,listeners:214,
                  speakers:8,joinedAt:0,weak:false,
                  payload_label:'<img id="persisted-voice-node" src=x '+
                    'onerror="globalThis.__persistedVoiceExecuted=true">',
                  wallet_label:'wallet-secret',source_label:'source-secret',
                  model_label:'model-secret'}}));
            }""")
            page.reload()
            page.wait_for_timeout(100)
            if action != 'reload':
                page.locator('#asset-review-transfer').click()
                page.wait_for_timeout(30)
            if action == 'cancel':
                page.locator('#review-cancel').click()
                page.wait_for_timeout(80)
            elif action == 'continue':
                page.locator('#review-preview-check').check()
                page.locator('#review-continue').click()
                page.wait_for_timeout(100)
            elif action == 'back_forward':
                page.go_back(); page.wait_for_timeout(80)
                page.go_forward(); page.wait_for_timeout(80)
            elif action == 'bfcache':
                page.evaluate("""() => {
                  dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
                  dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
                }""")
                page.wait_for_timeout(30)
            result = page.evaluate("""() => {
              const text=sessionStorage.getItem('loop.proto.state')||'';
              let stored=null;try{stored=JSON.parse(text)}catch(_error){}
              const dialog=document.getElementById('review-dialog');
              return {topKeys:Object.keys(stored||{}).sort(),
                voiceKeys:Object.keys(stored?.voice||{}).sort(),
                stack:stored?.stack,dangerous:['payload_label','wallet_label',
                  'source_label','model_label'].filter(key=>text.includes(key)),
                hostileNode:Boolean(document.getElementById('persisted-voice-node')),
                executed:Boolean(globalThis.__persistedVoiceExecuted),
                open:dialog.classList.contains('open'),
                marker:Boolean(history.state?.loop_review),
                historyKeys:Object.keys(history.state||{}).sort()};
            }""")
            page.wait_for_timeout(20)
            result['executedAfterEventLoop'] = page.evaluate(
                'Boolean(globalThis.__persistedVoiceExecuted)')
            return result

        for persisted_action in ('reload', 'cancel', 'continue', 'back_forward',
                                 'bfcache'):
            persisted_result = polluted_persisted_voice_case(persisted_action)
            expected_open = persisted_action in ('back_forward', 'bfcache')
            expected_marker = expected_open
            check(persisted_result['topKeys'] == ['stack'] and
                  persisted_result['voiceKeys'] == [] and
                  persisted_result['stack'] == ['scr-wallet', 'scr-asset'] and
                  not persisted_result['dangerous'] and
                  not persisted_result['hostileNode'] and
                  not persisted_result['executed'] and
                  not persisted_result['executedAfterEventLoop'] and
                  persisted_result['open'] == expected_open and
                  persisted_result['marker'] == expected_marker and
                  set(persisted_result['historyKeys']).issubset(
                      {'stack', 'loop_review', 'review_id'}),
                  f'persisted RTC/presence-shaped voice is dropped after {persisted_action}: '
                  f'{persisted_result}')

        # Restore the clean review used by the remaining shared F11 interaction checks.
        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        initial_length = page.evaluate('history.length')
        page.locator('#asset-review-transfer').click()
        page.wait_for_timeout(30)

        fields = {item['label']: item for item in review_open['fields']}
        check(fields.get('Destination', {}).get('value') ==
              '0x71C700000000000000000000000000000000F0A2' and
              fields.get('Amount', {}).get('value') == '0.01 ETH sent' and
              fields.get('Fee', {}).get('value') == 'Unavailable' and
              all(item['provenance'] in ('digest_bound_provider', 'unavailable')
                  for item in review_open['fields']),
              f'F11 renders full critical transfer values with field provenance: {fields}')
        background_open = page.evaluate("""() => {
          const pitch=document.querySelector('.pitch');
          const mobile=document.querySelector('.to-plan-mobile');
          const demo=pitch.querySelector('button.demo');
          demo.focus();
          const result={pitchInert:pitch.hasAttribute('inert'),
            pitchAria:pitch.getAttribute('aria-hidden'),
            mobileInert:mobile.hasAttribute('inert'),
            mobileAria:mobile.getAttribute('aria-hidden'),
            escapedFocus:document.activeElement===demo};
          document.getElementById('review-cancel').focus();
          return result;
        }""")
        check(background_open == {'pitchInert': True, 'pitchAria': 'true',
                                  'mobileInert': True, 'mobileAria': 'true',
                                  'escapedFocus': False},
              f'F11 makes every outside-phone interaction background inert: '
              f'{background_open}')

        if review_open['open']:
            before_veil = page.evaluate('JSON.stringify(history.state)')
            page.locator('#veil').click(position={'x': 4, 'y': 4})
            page.wait_for_timeout(30)
            veil_state = page.evaluate("""() => ({
              open:document.getElementById('review-dialog').classList.contains('open'),
              state:JSON.stringify(history.state),active:
                document.getElementById('review-dialog').contains(document.activeElement),
              legacy:[...document.querySelectorAll('.sheet.open')].map(node=>node.id)
            })""")
            check(veil_state['open'] and veil_state['state'] == before_veil and
                  veil_state['active'] and not veil_state['legacy'],
                  f'F11-owned veil is a no-op and restores internal focus: {veil_state}')
            page.locator('#review-preview-check').check()
            page.wait_for_timeout(20)
            ack_state = page.evaluate("""() => ({checked:
              document.getElementById('review-preview-check').checked,disabled:
              document.getElementById('review-continue').disabled,state:
              document.getElementById('review-dialog').dataset.state})""")
            check(ack_state == {'checked': True, 'disabled': False,
                                'state': 'preview_unavailable'},
                  f'preview-unavailable Continue gates on explicit acknowledgement: {ack_state}')
            page.go_back(); page.wait_for_timeout(80)
            back_state = page.evaluate("""() => ({open:
              document.getElementById('review-dialog').classList.contains('open'),
              marker:Boolean(history.state?.loop_review),focus:document.activeElement?.id||'',
              length:history.length})""")
            page.go_forward(); page.wait_for_timeout(80)
            forward_state = page.evaluate("""() => ({open:
              document.getElementById('review-dialog').classList.contains('open'),
              id:history.state?.review_id||'',checked:
              document.getElementById('review-preview-check').checked,
              length:history.length})""")
            bfcache_state = page.evaluate("""() => {
              dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
              dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
              return {open:document.getElementById('review-dialog').classList.contains('open'),
                id:history.state?.review_id||'',marker:Boolean(history.state?.loop_review)};
            }""")
            check(not back_state['open'] and not back_state['marker'] and
                  back_state['focus'] == 'asset-review-transfer' and
                  forward_state['open'] and forward_state['id'] == 'review-transfer' and
                  forward_state['checked'] and back_state['length'] == initial_length + 1 ==
                  forward_state['length'] and bfcache_state ==
                  {'open': True, 'id': 'review-transfer', 'marker': True},
                  f'Browser Back retains and Forward reopens the same live pair: '
                  f'{back_state} / {forward_state} / {bfcache_state}')
            page.locator('#review-cancel').focus()
            page.keyboard.press('Shift+Tab')
            trapped = page.evaluate("document.activeElement?.id")
            check(trapped == 'review-preview-check',
                  f'F11 focus trap wraps inside the dialog: {trapped}')
            page.keyboard.press('Escape'); page.wait_for_timeout(80)
            escape_state = page.evaluate("""() => ({open:
              document.getElementById('review-dialog').classList.contains('open'),
              marker:Boolean(history.state?.loop_review),focus:document.activeElement?.id||'',
              length:history.length,pitchInert:
              document.querySelector('.pitch').hasAttribute('inert'),pitchAria:
              document.querySelector('.pitch').getAttribute('aria-hidden'),mobileInert:
              document.querySelector('.to-plan-mobile').hasAttribute('inert'),mobileAria:
              document.querySelector('.to-plan-mobile').getAttribute('aria-hidden')})""")
            page.go_forward(); page.wait_for_timeout(80)
            stale_forward = page.evaluate("""() => ({open:
              document.getElementById('review-dialog').classList.contains('open'),
              marker:Boolean(history.state?.loop_review),keys:Object.keys(history.state||{}).sort(),
              length:history.length})""")
            check(not escape_state['open'] and not escape_state['marker'] and
                  escape_state['focus'] == 'asset-review-transfer' and
                  not escape_state['pitchInert'] and escape_state['pitchAria'] is None and
                  not escape_state['mobileInert'] and escape_state['mobileAria'] is None and
                  not stale_forward['open'] and not stale_forward['marker'] and
                  stale_forward['keys'] == ['stack'] and
                  escape_state['length'] == stale_forward['length'] == initial_length + 1,
                  f'Escape consumes, goes Back, and stale Forward sanitizes in place: '
                  f'{escape_state} / {stale_forward}')
        else:
            check(False, 'F11 history/veil/ack/focus lifecycle is reachable')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(100)
        page.locator('#asset-review-transfer').click(); page.wait_for_timeout(30)
        cancel_dedupe = page.evaluate("""() => {
          let backCalls=0;
          Object.defineProperty(history,'back',{value:()=>{backCalls+=1},configurable:true});
          const dialog=document.getElementById('review-dialog');
          const cancel=document.getElementById('review-cancel');
          cancel.click();cancel.click();
          dialog.dispatchEvent(new KeyboardEvent('keydown',
            {key:'Escape',bubbles:true,repeat:false}));
          dialog.dispatchEvent(new KeyboardEvent('keydown',
            {key:'Escape',bubbles:true,repeat:true}));
          return {backCalls,open:dialog.classList.contains('open'),state:dialog.dataset.state,
            cancelDisabled:cancel.disabled,
            continueDisabled:document.getElementById('review-continue').disabled,
            marker:Boolean(history.state?.loop_review),banner:
            document.getElementById('review-provider-banner').textContent,
            bannerHidden:document.getElementById('review-provider-banner').hidden};
        }""")
        check(cancel_dedupe['backCalls'] == 1 and cancel_dedupe['open'] and
              cancel_dedupe['state'] == 'cancelling_to_origin' and
              cancel_dedupe['cancelDisabled'] and cancel_dedupe['continueDisabled'] and
              cancel_dedupe['marker'] and cancel_dedupe['bannerHidden'] and
              not cancel_dedupe['banner'],
              f'Cancel double-click and Escape key-repeat issue exactly one Back: '
              f'{cancel_dedupe}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(100)
        before_continue_length = page.evaluate('history.length')
        before_continue_wallet = page.locator('#asset-content').inner_text()
        page.locator('#asset-review-transfer').click(); page.wait_for_timeout(30)
        if page.locator('#review-dialog.open').count():
            page.locator('#review-preview-check').check()
            page.evaluate("""() => {
              const banner=document.getElementById('review-provider-banner');
              globalThis.__task5ProviderStates=[];
              new MutationObserver(()=>{
                const state=banner.dataset.state||'';
                if(state&&globalThis.__task5ProviderStates.at(-1)!==state){
                  globalThis.__task5ProviderStates.push(state);
                }
              }).observe(banner,{attributes:true,attributeFilter:['data-state']});
              const button=document.getElementById('review-continue');
              button.click();button.click();button.dispatchEvent(new KeyboardEvent('keydown',
                {key:'Enter',bubbles:true,repeat:true}));}""")
            page.wait_for_timeout(120)
        continue_state = page.evaluate("""() => ({open:
          document.getElementById('review-dialog').classList.contains('open'),inert:
          document.getElementById('review-dialog').hasAttribute('inert'),
          marker:Boolean(history.state?.loop_review),focus:document.activeElement?.id||'',
          banner:document.getElementById('review-provider-banner').textContent,
          bannerHidden:document.getElementById('review-provider-banner').hidden,
          providerStates:globalThis.__task5ProviderStates||[],
          length:history.length,stored:sessionStorage.getItem('loop.proto.state')||'',
          allStorage:[...Array(localStorage.length).keys()].map(i=>localStorage.getItem(
            localStorage.key(i))).concat([...Array(sessionStorage.length).keys()].map(
              i=>sessionStorage.getItem(sessionStorage.key(i)))).join('|')})""")
        after_continue_wallet = page.locator('#asset-content').inner_text()
        page.go_forward(); page.wait_for_timeout(80)
        continue_forward = page.evaluate("""() => ({open:
          document.getElementById('review-dialog').classList.contains('open'),
          marker:Boolean(history.state?.loop_review),keys:Object.keys(history.state||{}).sort()})""")
        check(not continue_state['open'] and continue_state['inert'] and
              not continue_state['marker'] and continue_state['focus'] ==
              'asset-review-transfer' and not continue_state['bannerHidden'] and
              continue_state['banner'] == 'Simulated Privy handoff pending' and
              continue_state['providerStates'] == ['handoff_pending', 'provider_pending'] and
              continue_state['length'] == before_continue_length + 1 and
              not continue_forward['open'] and not continue_forward['marker'] and
              continue_forward['keys'] == ['stack'] and
              before_continue_wallet == after_continue_wallet,
              f'Continue closes before one microtask handoff and cannot replay: '
              f'{continue_state} / {continue_forward}')
        check(all(term not in continue_state['allStorage'] for term in sensitive_terms) and
              '"stack"' in continue_state['stored'] and '"voice"' not in continue_state['stored'] and
              'review' not in continue_state['stored'],
              f'review payload/session is absent from storage: {continue_state}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(100)
        forged = page.evaluate("""() => {
          history.replaceState({stack:['scr-evil'],voice:{state:'joined',open:'yes'},
            loop_review:1,review_id:'review-transfer',accountEntryId:'forged'},'',location.href);
          dispatchEvent(new PopStateEvent('popstate',{state:history.state}));
          return new Promise(resolve=>setTimeout(()=>resolve({state:history.state,
            open:document.getElementById('review-dialog').classList.contains('open'),
            active:[...document.querySelectorAll('.scr.active:not([inert])')].map(node=>node.id),
            stored:sessionStorage.getItem('loop.proto.state')||''}),20));
        }""")
        check(not forged['open'] and sorted(forged['state'].keys()) == ['stack'] and
              forged['active'] == ['scr-asset'] and 'review' not in forged['stored'],
              f'forged review marker and malformed projection sanitize closed: {forged}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        page.locator('#asset-review-transfer').click(); page.wait_for_timeout(30)
        page.go_back(); page.wait_for_timeout(80)
        cross_live_open = page.evaluate("""() => openWalletReview('review-swap-fresh',
          document.getElementById('asset-review-transfer'))""")
        page.wait_for_timeout(30)
        cross_live_marker = page.evaluate("""() => {
          const forged={...history.state,review_id:'review-transfer'};
          history.replaceState(forged,'',location.href);
          dispatchEvent(new PopStateEvent('popstate',{state:forged}));
          return new Promise(resolve=>setTimeout(()=>resolve({open:
            document.getElementById('review-dialog').classList.contains('open'),state:
            document.getElementById('review-dialog').dataset.state,kind:
            document.getElementById('review-kind').textContent,marker:
            Boolean(history.state?.loop_review),keys:Object.keys(history.state||{}).sort(),
            banner:document.getElementById('review-provider-banner').textContent,
            bannerHidden:document.getElementById('review-provider-banner').hidden,
            proofGlobal:typeof globalThis.reviewMarkerProof,storage:
            [...Array(localStorage.length).keys()].map(i=>localStorage.getItem(
              localStorage.key(i))).concat([...Array(sessionStorage.length).keys()].map(
                i=>sessionStorage.getItem(sessionStorage.key(i)))).join('|')}),20));
        }""")
        check(cross_live_open and not cross_live_marker['open'] and
              not cross_live_marker['marker'] and
              cross_live_marker['keys'] == ['stack'] and
              cross_live_marker['bannerHidden'] and not cross_live_marker['banner'],
              f'one live review ID cannot reuse another live marker entry proof: '
              f'{cross_live_marker}')
        check(cross_live_marker['proofGlobal'] == 'undefined' and
              'reviewMarkerProof' not in cross_live_marker['storage'],
              f'marker binding proof remains absent from global/storage surfaces: '
              f'{cross_live_marker}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        page.locator('#asset-review-transfer').click(); page.wait_for_timeout(30)
        forward_projection_tamper = page.evaluate("""() => {
          const forged={...history.state,stack:['scr-wallet']};
          history.replaceState(forged,'',location.href);
          dispatchEvent(new PopStateEvent('popstate',{state:forged}));
          return new Promise(resolve=>setTimeout(()=>resolve({open:
            document.getElementById('review-dialog').classList.contains('open'),marker:
            Boolean(history.state?.loop_review),keys:Object.keys(history.state||{}).sort(),
            stack:history.state?.stack,active:
            [...document.querySelectorAll('.scr.active:not([inert])')].map(node=>node.id),
            hash:location.hash,banner:
            document.getElementById('review-provider-banner').textContent,
            bannerHidden:document.getElementById('review-provider-banner').hidden}),20));
        }""")
        check(not forward_projection_tamper['open'] and
              not forward_projection_tamper['marker'] and
              forward_projection_tamper['keys'] == ['stack'] and
              forward_projection_tamper['stack'] == ['scr-wallet', 'scr-asset'] and
              forward_projection_tamper['active'] == ['scr-asset'] and
              forward_projection_tamper['hash'].startswith('#asset?') and
              forward_projection_tamper['bannerHidden'] and
              not forward_projection_tamper['banner'],
              f'Forward candidate projection tamper restores proof origin closed: '
              f'{forward_projection_tamper}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        page.locator('#asset-review-transfer').click(); page.wait_for_timeout(30)
        restore_projection_tamper = page.evaluate("""() => {
          const forged={...history.state,stack:['scr-wallet']};
          history.replaceState(forged,'',location.href);
          dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
          dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
          return new Promise(resolve=>setTimeout(()=>resolve({open:
            document.getElementById('review-dialog').classList.contains('open'),marker:
            Boolean(history.state?.loop_review),keys:Object.keys(history.state||{}).sort(),
            stack:history.state?.stack,active:
            [...document.querySelectorAll('.scr.active:not([inert])')].map(node=>node.id),
            hash:location.hash,banner:
            document.getElementById('review-provider-banner').textContent,
            bannerHidden:document.getElementById('review-provider-banner').hidden}),20));
        }""")
        check(not restore_projection_tamper['open'] and
              not restore_projection_tamper['marker'] and
              restore_projection_tamper['keys'] == ['stack'] and
              restore_projection_tamper['stack'] == ['scr-wallet', 'scr-asset'] and
              restore_projection_tamper['active'] == ['scr-asset'] and
              restore_projection_tamper['hash'].startswith('#asset?') and
              restore_projection_tamper['bannerHidden'] and
              not restore_projection_tamper['banner'],
              f'BFCache restore candidate projection tamper restores proof origin closed: '
              f'{restore_projection_tamper}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        page.locator('#asset-review-transfer').click(); page.wait_for_timeout(30)
        nonpersist_review = page.evaluate("""() => {
          dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false}));
          dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
          return new Promise(resolve=>setTimeout(()=>resolve({open:
            document.getElementById('review-dialog').classList.contains('open'),marker:
            Boolean(history.state?.loop_review),keys:Object.keys(history.state||{}).sort(),
            banner:document.getElementById('review-provider-banner').textContent}),20));
        }""")
        check(not nonpersist_review['open'] and not nonpersist_review['marker'] and
              nonpersist_review['keys'] == ['stack'] and
              not nonpersist_review['banner'],
              f'non-persisted pagehide clears the marker binding proof: '
              f'{nonpersist_review}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        page.locator('#asset-review-transfer').click(); page.wait_for_timeout(30)
        page.evaluate("location.hash='#wallet'"); page.wait_for_timeout(100)
        route_change = page.evaluate("""() => ({open:
          document.getElementById('review-dialog').classList.contains('open'),
          hash:location.hash,marker:Boolean(history.state?.loop_review),
          active:[...document.querySelectorAll('.scr.active:not([inert])')].map(node=>node.id)})""")
        check(not route_change['open'] and route_change['hash'] == '#wallet' and
              not route_change['marker'] and route_change['active'] == ['scr-wallet'],
              f'route/hash change consumes F11 before navigation: {route_change}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        decode_open = page.evaluate("""() => openWalletReview('review-unknown',
          document.getElementById('asset-review-transfer'))""")
        page.wait_for_timeout(20)
        unknown_policy = page.evaluate("""() => ({open:
          document.getElementById('review-dialog').classList.contains('open'),inert:
          document.getElementById('review-dialog').hasAttribute('inert'),marker:
          Boolean(history.state?.loop_review),state:
          document.getElementById('review-provider-banner').dataset.state})""")
        missing_open = page.evaluate("""() => openWalletReview('review-missing',
          document.getElementById('asset-review-transfer'))""")
        page.wait_for_timeout(20)
        missing_policy = page.evaluate("""() => ({open:
          document.getElementById('review-dialog').classList.contains('open'),inert:
          document.getElementById('review-dialog').hasAttribute('inert'),marker:
          Boolean(history.state?.loop_review),state:
          document.getElementById('review-provider-banner').dataset.state})""")
        check(not decode_open and not missing_open and not unknown_policy['open'] and
              unknown_policy['inert'] and not unknown_policy['marker'] and
              unknown_policy['state'] == 'provider_blocked' and
              not missing_policy['open'] and missing_policy['inert'] and
              not missing_policy['marker'] and missing_policy['state'] == 'provider_blocked',
              f'unknown F11 operations fail closed before decode/marker/handoff: '
              f'{unknown_policy} / {missing_policy}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        page.locator('#asset-review-transfer').click(); page.wait_for_timeout(30)
        page.locator('#review-preview-check').check()
        returning_escape = page.evaluate("""() => {
          let backCalls=0;
          Object.defineProperty(history,'back',{value:()=>{backCalls+=1},configurable:true});
          document.getElementById('review-continue').click();
          document.getElementById('review-dialog').dispatchEvent(new KeyboardEvent('keydown',
            {key:'Escape',bubbles:true}));
          return {backCalls,open:document.getElementById('review-dialog').classList.contains('open'),
            state:document.getElementById('review-dialog').dataset.state,
            marker:Boolean(history.state?.loop_review),banner:
              document.getElementById('review-provider-banner').textContent};
        }""")
        check(returning_escape['backCalls'] == 1 and returning_escape['open'] and
              returning_escape['state'] == 'returning_to_origin' and
              returning_escape['marker'] and not returning_escape['banner'],
              f'post-CAS Escape is swallowed without a second Back: {returning_escape}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        page.locator('#asset-review-transfer').click(); page.wait_for_timeout(30)
        page.locator('#review-preview-check').check()
        page.evaluate("""() => history.replaceState({stack:['scr-wallet','scr-asset']},
          '',location.href)""")
        page.locator('#review-continue').click(); page.wait_for_timeout(80)
        tampered_continue = page.evaluate("""() => ({open:
          document.getElementById('review-dialog').classList.contains('open'),marker:
          Boolean(history.state?.loop_review),banner:
          document.getElementById('review-provider-banner').textContent,
          bannerHidden:document.getElementById('review-provider-banner').hidden})""")
        check(not tampered_continue['open'] and not tampered_continue['marker'] and
              tampered_continue['bannerHidden'] and not tampered_continue['banner'],
              f'tampered current marker fails closed before Continue handoff: '
              f'{tampered_continue}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        page.locator('#asset-review-transfer').click(); page.wait_for_timeout(30)
        page.locator('#review-preview-check').check()
        synthetic_return = page.evaluate("""() => {
          Object.defineProperty(history,'back',{value:()=>{},configurable:true});
          document.getElementById('review-continue').click();
          const hostile={stack:['scr-wallet'],
            voice:{state:'joined',open:true,minimized:true,muted:false}};
          history.replaceState(hostile,'','#wallet');
          dispatchEvent(new PopStateEvent('popstate',{state:hostile}));
          return new Promise(resolve=>setTimeout(()=>resolve({open:
            document.getElementById('review-dialog').classList.contains('open'),marker:
            Boolean(history.state?.loop_review),banner:
            document.getElementById('review-provider-banner').textContent,
            bannerHidden:document.getElementById('review-provider-banner').hidden,
            hash:location.hash,state:history.state,
            active:[...document.querySelectorAll('.scr.active:not([inert])')]
              .map(node=>node.id),voiceCard:
              document.getElementById('voiceRoomCard').style.display,
            stored:JSON.parse(sessionStorage.getItem('loop.proto.state')||'{}')}),20));
        }""")
        expected_origin = {'stack': ['scr-wallet', 'scr-asset']}
        check(not synthetic_return['open'] and not synthetic_return['marker'] and
              synthetic_return['bannerHidden'] and not synthetic_return['banner'] and
              synthetic_return['hash'] == '#asset?asset=ETH&chain=ethereum' and
              synthetic_return['state'] == expected_origin and
              synthetic_return['active'] == ['scr-asset'] and
              synthetic_return['voiceCard'] == 'none' and
              synthetic_return['stored'] == expected_origin,
              f'synthetic origin popstate cannot authorize handoff: {synthetic_return}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        older_origin_key = page.evaluate("""() => {
          history.pushState({stack:['scr-wallet','scr-asset']},'',location.href);
          return navigation.currentEntry.key;
        }""")
        page.locator('#asset-review-transfer').click(); page.wait_for_timeout(30)
        page.locator('#review-preview-check').check()
        page.evaluate("""originKey => {
          const nativeGo=history.go.bind(history);
          Object.defineProperty(history,'back',{configurable:true,value:()=>{
            Object.defineProperty(globalThis,'navigation',{configurable:true,
              value:{currentEntry:{key:originKey}}});
            nativeGo(-2);
          }});
          document.getElementById('review-continue').click();
        }""", older_origin_key)
        page.wait_for_timeout(160)
        wrong_entry = page.evaluate("""() => ({open:
          document.getElementById('review-dialog').classList.contains('open'),marker:
          Boolean(history.state?.loop_review),banner:
          document.getElementById('review-provider-banner').textContent,
          bannerHidden:document.getElementById('review-provider-banner').hidden,
          keys:Object.keys(history.state||{}).sort(),active:
          [...document.querySelectorAll('.scr.active:not([inert])')].map(node=>node.id)})""")
        check(not wrong_entry['open'] and not wrong_entry['marker'] and
              wrong_entry['bannerHidden'] and not wrong_entry['banner'] and
              wrong_entry['keys'] == ['stack'] and
              wrong_entry['active'] == ['scr-asset'],
              f'trusted same-projection wrong entry with replaced Navigation cannot handoff: '
              f'{wrong_entry}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        page.evaluate("""() => Object.defineProperty(globalThis,'navigation',{
          configurable:true,value:undefined})""")
        page.locator('#asset-review-transfer').click(); page.wait_for_timeout(30)
        page.locator('#review-preview-check').check()
        page.locator('#review-continue').click(); page.wait_for_timeout(100)
        missing_navigation = page.evaluate("""() => ({open:
          document.getElementById('review-dialog').classList.contains('open'),marker:
          Boolean(history.state?.loop_review),banner:
          document.getElementById('review-provider-banner').textContent,
          bannerHidden:document.getElementById('review-provider-banner').hidden,
          keys:Object.keys(history.state||{}).sort()})""")
        check(not missing_navigation['open'] and not missing_navigation['marker'] and
              missing_navigation['bannerHidden'] and not missing_navigation['banner'] and
              missing_navigation['keys'] == ['stack'],
              f'successful marker push without a trusted origin key fails closed: '
              f'{missing_navigation}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        page.evaluate("""() => Object.defineProperty(history,'pushState',{
          configurable:true,value:()=>{throw new DOMException('blocked','SecurityError')}})""")
        page.locator('#asset-review-transfer').click(); page.wait_for_timeout(30)
        page.locator('#review-preview-check').check()
        page.locator('#review-continue').click(); page.wait_for_timeout(80)
        push_failed_fallback = page.evaluate("""() => ({open:
          document.getElementById('review-dialog').classList.contains('open'),marker:
          Boolean(history.state?.loop_review),banner:
          document.getElementById('review-provider-banner').textContent,
          bannerHidden:document.getElementById('review-provider-banner').hidden})""")
        check(not push_failed_fallback['open'] and not push_failed_fallback['marker'] and
              not push_failed_fallback['bannerHidden'] and
              push_failed_fallback['banner'] == 'Simulated Privy handoff pending',
              f'true pushState failure alone uses the sanitized no-prior fallback: '
              f'{push_failed_fallback}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        refresh_opened = page.evaluate("""() => openWalletReview('review-swap-stale',
          document.getElementById('asset-review-transfer'))""")
        page.wait_for_timeout(30)
        refresh_before = page.evaluate("""() => ({state:
          document.getElementById('review-dialog').dataset.state,refreshHidden:
          document.getElementById('review-refresh').hidden,continueHidden:
          document.getElementById('review-continue').hidden,status:
          document.getElementById('review-status').textContent})""")
        if refresh_opened:
            page.locator('#review-refresh').click()
            page.wait_for_timeout(30)
        refresh_after = page.evaluate("""() => ({state:
          document.getElementById('review-dialog').dataset.state,refreshHidden:
          document.getElementById('review-refresh').hidden,continueHidden:
          document.getElementById('review-continue').hidden,continueDisabled:
          document.getElementById('review-continue').disabled,status:
          document.getElementById('review-status').textContent,reviewId:
          history.state?.review_id||''})""")
        check(refresh_opened and refresh_before == {'state': 'blocked',
              'refreshHidden': False, 'continueHidden': True,
              'status': 'The reviewed quote is not available. Refresh quote to continue.'} and
              refresh_after == {'state': 'ready', 'refreshHidden': True,
              'continueHidden': False, 'continueDisabled': False, 'status': '',
              'reviewId': 'review-swap-refresh'},
              f'Refresh quote has a directed blocked-to-ready DOM transition: '
              f'{refresh_before} / {refresh_after}')

        def provider_error_dom(code: str, hostile_message: str,
                               wallet_class='privy_embedded',
                               review_id='review-transfer'):
            page.goto('about:blank')
            demo = '?demo=wallet-external-gap' if wallet_class == 'connected_external' else ''
            page.goto(f'{APP.as_uri()}{demo}#asset?asset=ETH&chain=ethereum')
            page.wait_for_timeout(80)
            opened = page.evaluate("""({code,safeMessage,walletClass,reviewId}) => {
              const base=LoopWalletProvider.createSimulatedAdapter({
                walletClass,scenario:walletClass==='connected_external'?
                  'external_gap':'normal'});
              const names=['getWalletSnapshot','getBalanceSnapshot',
                'getTransactionHistorySnapshot','getWalletActionSnapshot',
                'getReceiveTarget','getReviewPreview','handoffReview'];
              const hostile=Object.freeze(Object.fromEntries(names.map(name=>[name,
                name==='handoffReview'?()=>Object.freeze({ok:false,error:Object.freeze({
                  code,retryable:false,safe_message:safeMessage})}):base[name]])));
              const controller=LoopWalletReview.createController({adapter:hostile});
              const origin={stack:['scr-wallet','scr-asset']};
              const live={user_id:'fixture-user-1',
                wallet_id:walletClass==='privy_embedded'?'fixture-wallet-1':null,
                wallet_class:walletClass,
                endpoint:reviewId.endsWith('-external')?
                  'external_wallet:request':'/v1/wallets/fixture-wallet-1/actions'};
              const opened=controller.open({review_id:reviewId,origin,
                live_context:live,trigger_ref:'asset-review-transfer',now_ms:100001});
              if(!opened.ok)return false;
              const acknowledged=controller.acknowledge({review_id:reviewId,
                acknowledged:true});
              const begun=controller.beginHandoff({review_id:reviewId,
                live_context:live,now_ms:100002});
              if(!acknowledged.ok||!begun.ok)return false;
              const request={review_id:reviewId,live_context:live,origin,
                now_ms:100003};
              const pending=controller.handoff(request);
              if(!pending.ok||pending.value.state!=='handoff_pending')return false;
              showReviewProviderState(controller.handoff(request));
              return true;
            }""", {'code': code, 'safeMessage': hostile_message,
                     'walletClass': wallet_class, 'reviewId': review_id})
            page.wait_for_timeout(30)
            return opened, page.evaluate("""() => ({open:
              document.getElementById('review-dialog').classList.contains('open'),state:
              document.getElementById('review-provider-banner').dataset.state,text:
              document.getElementById('review-provider-banner').textContent,hidden:
              document.getElementById('review-provider-banner').hidden,marker:
              Boolean(history.state?.loop_review)})""")

        rejected_opened, rejected_dom = provider_error_dom(
            'USER_REJECTED', 'Transaction signed and complete.')
        check(rejected_opened and rejected_dom == {'open': False,
              'state': 'provider_rejected',
              'text': 'The wallet request was rejected by the user.',
              'hidden': False, 'marker': False},
              f'provider_rejected DOM uses fixed LOOP-owned safe copy: {rejected_dom}')
        failed_opened, failed_dom = provider_error_dom(
            'POLICY_REJECTED', '\u202eTransaction submitted and complete.\n')
        check(failed_opened and failed_dom == {'open': False,
              'state': 'provider_failed',
              'text': 'The wallet request was blocked by provider policy.',
              'hidden': False, 'marker': False},
              f'provider_failed DOM uses fixed LOOP-owned safe copy: {failed_dom}')

        safe_error_matrix = (
            ('MALFORMED_PROVIDER_RESPONSE',
             'The wallet provider returned data LOOP could not safely use.',
             'privy_embedded', 'review-transfer', 'provider_failed'),
            ('PROVIDER_UNAVAILABLE',
             'The wallet provider is temporarily unavailable.',
             'privy_embedded', 'review-transfer', 'provider_failed'),
            ('ACTION_FAILED', 'The wallet action did not complete.',
             'privy_embedded', 'review-transfer', 'provider_failed'),
            ('USER_REJECTED', 'The wallet request was rejected by the user.',
             'connected_external', 'review-transfer-external', 'provider_rejected'),
            ('ACTION_FAILED', 'The wallet action did not complete.',
             'connected_external', 'review-transfer-external', 'provider_failed'),
            ('PROVIDER_UNAVAILABLE', 'The wallet provider is temporarily unavailable.',
             'connected_external', 'review-transfer-external', 'provider_failed'),
        )
        for code, safe_copy, wallet_class, review_id, state in safe_error_matrix:
            opened, rendered = provider_error_dom(
                code, 'Hostile connector success claim: signed and confirmed.',
                wallet_class, review_id)
            check(opened and rendered == {
                'open': False, 'state': state, 'text': safe_copy,
                'hidden': False, 'marker': False,
            }, f'F11 reachable {wallet_class} {code} uses fixed safe UI: {rendered}')

        safe_error_copy = {
            'UNAUTHENTICATED': 'Sign in to use this wallet.',
            'UNSUPPORTED_WALLET':
                'Watch-only wallets cannot authorize signing requests.',
            'PROVIDER_GAP':
                'This provider capability is not available for this wallet.',
            'MALFORMED_PROVIDER_RESPONSE':
                'The wallet provider returned data LOOP could not safely use.',
            'PROVIDER_UNAVAILABLE':
                'The wallet provider is temporarily unavailable.',
            'ACTION_FAILED': 'The wallet action did not complete.',
            'USER_REJECTED': 'The wallet request was rejected by the user.',
            'POLICY_REJECTED':
                'The wallet request was blocked by provider policy.',
            'SESSION_EXPIRED': 'This review has expired.',
        }
        applicability_columns = (
            'embedded_preview', 'embedded_handoff',
            'external_preview', 'external_handoff',
        )
        safe_error_applicability = {
            code: {
                column: ('app:controller_session_expiry' if
                         code == 'SESSION_EXPIRED' else
                         'app:adapter_error_safe_map')
                for column in applicability_columns
            }
            for code in safe_error_copy
        }
        applicable_cells = sum(
            cell.startswith('app:')
            for row in safe_error_applicability.values()
            for cell in row.values()
        )
        check(len(safe_error_applicability) == 9 and applicable_cells == 36 and
              all(tuple(row) == applicability_columns
                  for row in safe_error_applicability.values()),
              f'F11 9-code applicability table has 9 rows / 36 applicable cells: '
              f'{safe_error_applicability}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        matrix_results = page.evaluate("""({copies,table}) => {
          const deepFreeze=value=>{
            if(value&&typeof value==='object'&&!Object.isFrozen(value)){
              Object.values(value).forEach(deepFreeze);Object.freeze(value);
            }
            return value;
          };
          const methods=['getWalletSnapshot','getBalanceSnapshot',
            'getTransactionHistorySnapshot','getWalletActionSnapshot',
            'getReceiveTarget','getReviewPreview','handoffReview'];
          const hostile='<img id="f11-safe-error-hostile" src=x '+
            'onerror="globalThis.__f11SafeErrorExecuted=true">Signed and confirmed';
          const failure=code=>deepFreeze({ok:false,error:{code,retryable:false,
            safe_message:hostile}});
          const origin={stack:['scr-wallet','scr-asset']};
          const output=[];
          for(const [code,row] of Object.entries(table)){
            for(const [column,applicability] of Object.entries(row)){
              if(!applicability.startsWith('app:')){
                output.push({code,column,applicability,skipped:true});continue;
              }
              const external=column.startsWith('external_');
              const preview=column.endsWith('_preview');
              const walletClass=external?'connected_external':'privy_embedded';
              const reviewId=external?'review-transfer-external':'review-transfer';
              const base=LoopWalletProvider.createSimulatedAdapter({
                walletClass,scenario:external?'external_gap':'normal'});
              const adapter=Object.freeze(Object.fromEntries(methods.map(name=>[
                name,
                code!=='SESSION_EXPIRED'&&
                  ((preview&&name==='getReviewPreview')||
                   (!preview&&name==='handoffReview'))?
                  ()=>failure(code):base[name]
              ])));
              const controller=LoopWalletReview.createController({adapter});
              const live={user_id:'fixture-user-1',
                wallet_id:external?null:'fixture-wallet-1',wallet_class:walletClass,
                endpoint:external?'external_wallet:request':
                  '/v1/wallets/fixture-wallet-1/actions'};
              globalThis.__f11SafeErrorExecuted=false;
              document.getElementById('f11-safe-error-hostile')?.remove();
              document.getElementById('review-provider-banner').hidden=true;
              let result;
              if(preview){
                result=controller.open({review_id:reviewId,origin,live_context:live,
                  trigger_ref:'asset-review-transfer',
                  now_ms:code==='SESSION_EXPIRED'?500000:100001});
                renderReviewResult(result);
                const dialog=document.getElementById('review-dialog');
                const summary=document.getElementById('review-summary');
                output.push({code,column,applicability,resultCode:result.error?.code,
                  state:dialog.dataset.state,text:summary.textContent,
                  expected:copies[code],continueHidden:
                    document.getElementById('review-continue').hidden,
                  refreshHidden:document.getElementById('review-refresh').hidden,
                  marker:Boolean(history.state?.loop_review),dialogHidden:dialog.hidden,
                  hostileChildren:summary.childElementCount,
                  hostileNode:Boolean(document.getElementById('f11-safe-error-hostile')),
                  executed:globalThis.__f11SafeErrorExecuted});
                closeReviewSurface(false);
              }else{
                const opened=controller.open({review_id:reviewId,origin,
                  live_context:live,trigger_ref:'asset-review-transfer',now_ms:100001});
                renderReviewResult(opened);
                const acknowledged=controller.acknowledge({review_id:reviewId,
                  acknowledged:true});
                const begun=controller.beginHandoff({review_id:reviewId,
                  live_context:live,now_ms:100002});
                closeReviewSurface(false);
                const request={review_id:reviewId,live_context:live,origin,
                  now_ms:code==='SESSION_EXPIRED'?400001:100003};
                const pending=controller.handoff(request);
                result=code==='SESSION_EXPIRED'?pending:
                  (pending.ok&&pending.value.state==='handoff_pending'?
                    controller.handoff(request):pending);
                showReviewProviderState(result);
                const dialog=document.getElementById('review-dialog');
                const banner=document.getElementById('review-provider-banner');
                output.push({code,column,applicability,opened:opened.ok,
                  acknowledged:acknowledged.ok,begun:begun.ok,
                  resultCode:result.error?.code,state:banner.dataset.state,
                  text:banner.textContent,expected:copies[code],
                  continueHidden:document.getElementById('review-continue').hidden,
                  refreshHidden:document.getElementById('review-refresh').hidden,
                  marker:Boolean(history.state?.loop_review),dialogHidden:dialog.hidden,
                  dialogState:dialog.dataset.state,
                  hostileChildren:banner.childElementCount,
                  hostileNode:Boolean(document.getElementById('f11-safe-error-hostile')),
                  executed:globalThis.__f11SafeErrorExecuted});
              }
            }
          }
          return output;
        }""", {'copies': safe_error_copy, 'table': safe_error_applicability})
        page.wait_for_timeout(30)
        matrix_execution = page.evaluate(
            """() => Boolean(globalThis.__f11SafeErrorExecuted)""")
        for item in matrix_results:
            is_preview = item['column'].endswith('_preview')
            expected_state = ('decode_failed' if is_preview else
                              ('provider_rejected' if
                               item['code'] == 'USER_REJECTED' else
                               'provider_failed'))
            common_safe = (not item.get('skipped') and
                           (item.get('resultCode') == item['code'] if
                            (is_preview or item['code'] == 'SESSION_EXPIRED')
                            else item.get('resultCode') is None) and
                           item.get('state') == expected_state and
                           item.get('text') == item.get('expected') and
                           item.get('refreshHidden') is True and
                           item.get('marker') is False and
                           item.get('hostileChildren') == 0 and
                           item.get('hostileNode') is False and
                           item.get('executed') is False)
            surface_safe = ((item.get('continueHidden') is True and
                             item.get('dialogHidden') is False) if is_preview else
                            (item.get('opened') is True and
                             item.get('acknowledged') is True and
                             item.get('begun') is True and
                             item.get('dialogHidden') is True and
                             item.get('dialogState') == 'closed'))
            check(common_safe and surface_safe and not matrix_execution,
                  f"F11 {item['code']} {item['column']} exact safe DOM: {item}")

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        layered = page.evaluate("""() => {
          openSheet('sheet-risk');
          return openWalletReview('review-transfer',
            document.getElementById('asset-review-transfer'));
        }""")
        page.wait_for_timeout(30)
        if layered:
            page.locator('#review-cancel').click(); page.wait_for_timeout(80)
        veil_handoff = page.evaluate("""() => ({review:
          document.getElementById('review-dialog').classList.contains('open'),
          sheet:document.getElementById('sheet-risk').classList.contains('open'),
          sheetInert:document.getElementById('sheet-risk').hasAttribute('inert'),
          veil:document.getElementById('veil').classList.contains('open')})""")
        check(layered and not veil_handoff['review'] and veil_handoff['sheet'] and
              not veil_handoff['sheetInert'] and veil_handoff['veil'],
              f'F11 returns shared veil ownership to an underlying legacy sheet: '
              f'{veil_handoff}')

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}?demo=wallet-external-gap#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        external_open = page.evaluate("""() => openWalletReview('review-approve-external',
          document.getElementById('asset-review-transfer'))""")
        page.wait_for_timeout(30)
        external_approval = page.evaluate("""() => ({open:
          document.getElementById('review-dialog').classList.contains('open'),state:
          document.getElementById('review-dialog').dataset.state,primary:
          document.getElementById('review-continue').textContent,disabled:
          document.getElementById('review-continue').disabled,ackHidden:
          document.getElementById('review-preview-ack').hidden,fields:
          Object.fromEntries([...document.querySelectorAll('#review-fields .review-field')]
            .map(row=>[row.querySelector('dt')?.textContent||'',
              {value:row.querySelector('dd')?.childNodes[0]?.textContent||'',
                provenance:row.dataset.provenance||''}]))})""")
        check(external_open and external_approval['open'] and
              external_approval['state'] == 'preview_unavailable' and
              external_approval['disabled'] and not external_approval['ackHidden'] and
              external_approval['primary'] == 'Continue to external wallet' and
              external_approval['fields'].get('Wallet') == {
                  'value': '0xE87A4C2D1F9B6A3058C7E4D2B1A093F6C5E8D721',
                  'provenance': 'digest_bound_provider'} and
              external_approval['fields'].get('Allowance', {}).get('value') == '1,000 USDC',
              f'external approval uses its bound endpoint and exact public fields: '
              f'{external_approval}')

        # Perp fixture freshness is deliberately tied to the current monotonic
        # clock.  Use a fresh page for this focused flow so the preceding F11
        # matrix cannot consume the read-only snapshot's bounded lifetime.
        perp_page = browser.new_page()
        # This D1-D7/F11 projection test models an account for which the
        # authoritative provider already confirms the current D12 notice.
        # The production/default adapter remains PENDING and the bundled
        # account fixture remains acknowledgement_required=true.
        perp_page.add_init_script("""(()=>{
          let realProvider=null;
          Object.defineProperty(globalThis,'LoopHyperliquidAccount',{configurable:false,
            set(value){realProvider=value},get(){
              if(!realProvider)return undefined;
              return Object.freeze({
                createOfflineReadOnlyAdapter:realProvider.createOfflineReadOnlyAdapter,
                createPendingProductionAdapter:realProvider.createPendingProductionAdapter,
                captureAdapter(adapter){
                  const captured=realProvider.captureAdapter(adapter);
                  if(!captured)return null;
                  return Object.freeze({...captured,getRiskNotice(request){
                    const honest=captured.getRiskNotice(request);
                    if(honest?.ok!==true)return honest;
                    return Object.freeze({...honest,value:Object.freeze({...honest.value,
                      acknowledgement_required:false})});
                  }});
                }
              });
            }});
        })()""")
        perp_page.goto(f'{APP.as_uri()}#perp-confirm')
        perp_page.wait_for_timeout(80)
        direct_perp = perp_page.evaluate("""() => ({opened:openPerpSharedReview(
          document.getElementById('perp-shared-review')),facts:
          [...document.querySelectorAll('.scr.active [data-perp-provider-fact]')]
            .filter(node=>!node.hidden&&node.textContent.trim()).length,
          disabled:document.getElementById('perp-shared-review').disabled})""")
        check(direct_perp == {'opened': False, 'facts': 0, 'disabled': True},
              f'Perp F11 direct/deep-link attempt has no typed intent and fails closed: '
              f'{direct_perp}')

        perp_page.goto(f'{APP.as_uri()}#perp-order')
        perp_page.wait_for_timeout(80)
        perp_page.fill('#perp-order-size', '1.25')
        perp_page.locator('#perp-leverage').evaluate("""node => {
          node.value='20';node.dispatchEvent(new Event('input',{bubbles:true}))
        }""")
        perp_page.locator('#perp-review-order').click()
        perp_open = perp_page.evaluate("""() => openPerpSharedReview(
          document.getElementById('perp-shared-review'))""")
        perp_page.wait_for_timeout(30)
        perp_review = perp_page.evaluate("""() => ({state:
          document.getElementById('review-dialog').dataset.state,fields:
          Object.fromEntries([...document.querySelectorAll('#review-fields .review-field')]
            .map(row=>[row.querySelector('dt')?.textContent||'',
              {value:row.querySelector('dd')?.childNodes[0]?.textContent||'',
                provenance:row.dataset.provenance||''}])),continueHidden:
          document.getElementById('review-continue').hidden,status:
          document.getElementById('review-status').textContent})""")
        check(perp_open and perp_review['state'] == 'blocked' and
              perp_review['continueHidden'] and perp_review['status'] ==
              'Privy + Hyperliquid execution requires the production capability spike.' and
              perp_review['fields'].get('Side') == {
                  'value': 'Buy', 'provenance': 'digest_bound_provider'} and
              perp_review['fields'].get('Order type') == {
                  'value': 'Market', 'provenance': 'digest_bound_provider'} and
              perp_review['fields'].get('Reduce only') == {
                  'value': 'No', 'provenance': 'digest_bound_provider'} and
              perp_review['fields'].get('Size') == {
                  'value': '1.25', 'provenance': 'digest_bound_provider'} and
              perp_review['fields'].get('Leverage') == {
                  'value': '20×', 'provenance': 'digest_bound_provider'},
              f'Perp F11 renders exact typed-intent/provenance fields: '
              f'{perp_review}')
        perp_page.close()

        page.goto('about:blank')
        page.goto(f'{APP.as_uri()}?demo=wallet-external-gap#asset?asset=ETH&chain=ethereum')
        page.wait_for_timeout(80)
        external_perp_open = page.evaluate("""() => openWalletReview(
          'review-perp-external',document.getElementById('asset-review-transfer'))""")
        page.wait_for_timeout(30)
        external_perp_review = page.evaluate("""() => ({state:
          document.getElementById('review-dialog').dataset.state,continueHidden:
          document.getElementById('review-continue').hidden,refreshHidden:
          document.getElementById('review-refresh').hidden,status:
          document.getElementById('review-status').textContent,summary:
          document.getElementById('review-summary').textContent})""")
        check(external_perp_open and external_perp_review == {
            'state': 'blocked', 'continueHidden': True, 'refreshHidden': True,
            'status':
                'Privy + Hyperliquid execution requires the production capability spike.',
            'summary':
                'You are reviewing a Hyperliquid testnet market order to buy 0.01 ETH with 3× leverage.',
        }, f'external Perp remains blocked with no Continue/Refresh: '
           f'{external_perp_review}')

        mobile = browser.new_page(viewport={'width': 375, 'height': 667})
        mobile_errors = []
        mobile.on('pageerror', lambda error: mobile_errors.append(str(error)))
        mobile.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        mobile.wait_for_timeout(80); mobile.locator('#asset-review-transfer').click()
        mobile.wait_for_timeout(30)
        mobile_layout = mobile.evaluate("""() => {
          const dialog=document.getElementById('review-dialog').getBoundingClientRect();
          const actions=[...document.querySelectorAll('#review-dialog .review-actions button')]
            .filter(button=>!button.hidden).map(button=>button.getBoundingClientRect());
          return {horizontal:document.documentElement.scrollWidth>
              document.documentElement.clientWidth,within:dialog.top>=0&&dialog.bottom<=innerHeight,
            targets:actions.every(rect=>rect.height>=44&&rect.top>=0&&rect.bottom<=innerHeight),
            overflow:document.getElementById('review-fields').scrollHeight>=
              document.getElementById('review-fields').clientHeight,
            rect:{top:dialog.top,bottom:dialog.bottom,height:dialog.height},
            viewport:{width:innerWidth,height:innerHeight},
            computed:{maxHeight:getComputedStyle(document.getElementById('review-dialog')).maxHeight,
              boxSizing:getComputedStyle(document.getElementById('review-dialog')).boxSizing,
              transform:getComputedStyle(document.getElementById('phone')).transform},
            phone:(()=>{const node=document.getElementById('phone');
              const rect=node.getBoundingClientRect();const style=getComputedStyle(node);
              return {top:rect.top,bottom:rect.bottom,height:rect.height,scrollTop:node.scrollTop,
                scrollHeight:node.scrollHeight,overflow:style.overflow}})(),
            stage:(()=>{const rect=document.querySelector('.stage').getBoundingClientRect();
              return {top:rect.top,bottom:rect.bottom,height:rect.height}})(),
            scrolling:{x:scrollX,y:scrollY,docHeight:document.documentElement.scrollHeight,
              bodyHeight:document.body.scrollHeight}};
        }""")
        check(not mobile_layout['horizontal'] and mobile_layout['within'] and
              mobile_layout['targets'] and mobile_layout['overflow'] and not mobile_errors,
              f'375×667 F11 keeps fields scrollable and 44px actions visible: {mobile_layout}')
        mobile.close()

        desktop = browser.new_page(viewport={'width': 1440, 'height': 900})
        desktop_errors = []
        desktop.on('console', lambda message:
                   desktop_errors.append(message.text) if message.type == 'error' else None)
        desktop.on('pageerror', lambda error: desktop_errors.append(str(error)))
        desktop.goto(f'{APP.as_uri()}#asset?asset=ETH&chain=ethereum')
        desktop.wait_for_timeout(80); desktop.locator('#asset-review-transfer').click()
        desktop.wait_for_timeout(30)
        desktop_layout = desktop.evaluate("""() => {
          const dialog=document.getElementById('review-dialog');
          const fields=document.getElementById('review-fields');
          const phone=document.getElementById('phone');
          const dialogRect=dialog.getBoundingClientRect();
          const phoneRect=phone.getBoundingClientRect();
          const actions=[...dialog.querySelectorAll('.review-actions button')]
            .filter(button=>!button.hidden).map(button=>{
              const rect=button.getBoundingClientRect();
              return {id:button.id,width:rect.width,height:rect.height,
                top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right};
            });
          return {
            documentHorizontal:document.documentElement.scrollWidth>
              document.documentElement.clientWidth,
            dialogHorizontal:dialog.scrollWidth>dialog.clientWidth,
            contained:dialogRect.left>=phoneRect.left&&dialogRect.right<=phoneRect.right&&
              dialogRect.top>=phoneRect.top&&dialogRect.bottom<=phoneRect.bottom,
            actions,actionsReachable:actions.every(rect=>rect.height>=44&&rect.width>=44&&
              rect.top>=dialogRect.top&&rect.bottom<=dialogRect.bottom&&
              rect.left>=dialogRect.left&&rect.right<=dialogRect.right),
            fieldsOverflow:getComputedStyle(fields).overflowY,
            fieldsReachable:fields.getBoundingClientRect().top>=dialogRect.top&&
              fields.getBoundingClientRect().bottom<=dialogRect.bottom,
          };
        }""")
        check(not desktop_layout['documentHorizontal'] and
              not desktop_layout['dialogHorizontal'] and desktop_layout['contained'] and
              desktop_layout['actionsReachable'] and
              desktop_layout['fieldsOverflow'] in ('auto', 'scroll') and
              desktop_layout['fieldsReachable'] and not desktop_errors,
              f'1440×900 F11 dialog/actions stay contained, reachable, scrollable and '
              f'44px: {desktop_layout}')
        desktop.close()
        check(not errors, f'no console/page errors: {errors[:4]}')
        browser.close()

print('\n== Task 3 strict routes and rendered Wallet flows ==')
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)

    def task3_page(url, viewport=None, clipboard='success'):
        context = browser.new_context(
            viewport=viewport or {'width': 1280, 'height': 800})
        page = context.new_page()
        page_errors = []
        page.on('console', lambda message:
                page_errors.append(message.text) if message.type == 'error' else None)
        page.on('pageerror', lambda error:
                page_errors.append(f'pageerror: {error}'))
        if clipboard:
            page.add_init_script("""(() => {
              const mode = %s;
              const clipboard = mode === 'success' ? {
                writeText(value){ globalThis.__copiedAddress = value; return Promise.resolve(); }
              } : mode === 'reject' ? {
                writeText(){ return Promise.reject(new Error('denied')); }
              } : undefined;
              Object.defineProperty(navigator, 'clipboard', {
                configurable: true, value: clipboard
              });
            })()""" % json.dumps(clipboard))
        page.goto(url)
        page.wait_for_load_state('domcontentloaded')
        page.wait_for_timeout(100)
        return context, page, page_errors

    route_cases = [
        ('asset defaults', '#asset', '#asset?asset=ETH&chain=ethereum'),
        ('asset valid pair', '#asset?asset=ETH&chain=ethereum',
         '#asset?asset=ETH&chain=ethereum'),
        ('mixed case', '#asset?chain=SoLaNa&asset=sol',
         '#asset?asset=SOL&chain=solana'),
        ('unknown key stripped', '#asset?x=kept-out&chain=base&asset=usdc',
         '#asset?asset=USDC&chain=base'),
        ('unknown recognized value defaults', '#asset?asset=BTC&chain=base',
         '#asset?asset=ETH&chain=ethereum'),
        ('incompatible pair defaults', '#asset?asset=SOL&chain=base',
         '#asset?asset=ETH&chain=ethereum'),
        ('duplicate known rejects all', '#asset?asset=SOL&asset=ETH&chain=solana',
         '#asset?asset=ETH&chain=ethereum'),
        ('duplicate unknown rejects all', '#asset?asset=SOL&chain=solana&x=1&x=2',
         '#asset?asset=ETH&chain=ethereum'),
        ('bare percent rejects all', '#asset?asset=SOL&chain=solana&x=%',
         '#asset?asset=ETH&chain=ethereum'),
        ('short percent rejects all', '#asset?asset=SOL&chain=solana&x=%0',
         '#asset?asset=ETH&chain=ethereum'),
        ('invalid UTF-8 rejects all', '#asset?asset=SOL&chain=solana&x=%C3%28',
         '#asset?asset=ETH&chain=ethereum'),
        ('encoded C0 rejects all', '#asset?asset=SOL&chain=solana&x=%01',
         '#asset?asset=ETH&chain=ethereum'),
        ('encoded DEL rejects all', '#asset?asset=SOL&chain=solana&x=%7F',
         '#asset?asset=ETH&chain=ethereum'),
    ]
    for label, supplied, expected in route_cases:
        context, page, page_errors = task3_page(APP.as_uri() + supplied)
        check(page.evaluate('location.hash') == expected,
              f'{label} canonicalizes to {expected}')
        check(not page_errors, f'{label} has no console/page errors: {page_errors}')
        context.close()

    context, page, _errors = task3_page(
        APP.as_uri() + '#asset?asset=SOL&chain=solana')
    raw_controls = page.evaluate("""() => [1, 127].map(code =>
      strictHashRoute('asset?asset=SOL&chain=solana&x=' +
        String.fromCharCode(code)).params.asset)""")
    check(raw_controls == ['ETH', 'ETH'],
          f'literal C0/DEL reject the entire parameter set: {raw_controls}')
    context.close()

    def padded_hash(size, value_length=1):
        prefix = '#asset?asset=SOL&chain=solana&x=a&'
        suffix = '=b'
        key = 'y' * (size + 1 - len(prefix) - len(suffix))
        result = prefix + key + suffix
        assert len(result) - 1 == size
        return result

    for size, expected_asset in ((256, 'SOL'), (257, 'ETH')):
        context, page, _errors = task3_page(APP.as_uri() + padded_hash(size))
        check(page.evaluate("new URLSearchParams(location.hash.split('?')[1]).get('asset')") ==
              expected_asset, f'raw hash length {size} is '
              f'{"accepted" if size == 256 else "rejected"}')
        context.close()
    for decoded_length, expected_asset in ((32, 'SOL'), (33, 'ETH')):
        supplied = ('#asset?asset=SOL&chain=solana&x=' + 'q' * decoded_length)
        context, page, _errors = task3_page(APP.as_uri() + supplied)
        check(page.evaluate("new URLSearchParams(location.hash.split('?')[1]).get('asset')") ==
              expected_asset, f'decoded value length {decoded_length} is '
              f'{"accepted" if decoded_length == 32 else "rejected"}')
        context.close()

    context = browser.new_context()
    context.add_init_script("""(() => {
      globalThis.__routeHistoryCalls = {push: 0, replace: 0};
      const push = History.prototype.pushState;
      const replace = History.prototype.replaceState;
      History.prototype.pushState = function(){
        globalThis.__routeHistoryCalls.push += 1;
        return push.apply(this, arguments);
      };
      History.prototype.replaceState = function(){
        globalThis.__routeHistoryCalls.replace += 1;
        return replace.apply(this, arguments);
      };
    })()""")
    page = context.new_page()
    page.goto(APP.as_uri() + '#asset?chain=SoLaNa&asset=sol&junk=1')
    page.wait_for_timeout(100)
    route_history = page.evaluate('globalThis.__routeHistoryCalls')
    check(route_history['push'] == 0 and route_history['replace'] >= 1,
          f'route sanitization replaces without pushing: {route_history}')
    check(page.evaluate('history.state.stack') == ['scr-wallet', 'scr-asset'],
          'direct Asset link establishes Wallet ancestry')
    context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#receive')
    check(page.evaluate('location.hash') == '#receive?asset=ETH&chain=ethereum',
          'Receive defaults to the exact canonical URL')
    check(page.evaluate('history.state.stack') == ['scr-wallet', 'scr-receive'],
          'direct Receive link establishes Wallet ancestry')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '#asset?asset=SOL&chain=solana')
    hostile_asset_state = page.evaluate("""() => {
      const before=history.length;
      const hostile={
        stack:['scr-chat','scr-asset'],
        voice:{state:'forged',open:'yes',minimized:false,muted:false,extra:true},
        asset:'SOL',chain:'solana',cursor:'opaque-leak',unknown:'remove-me'
      };
      history.replaceState(hostile,'',location.href);
      dispatchEvent(new PopStateEvent('popstate',{state:hostile}));
      return {before,after:history.length,hash:location.hash,state:history.state,
        active:[...document.querySelectorAll('.scr.active')].map(node=>node.id)};
    }""")
    check(hostile_asset_state == {
        'before': hostile_asset_state['before'],
        'after': hostile_asset_state['before'],
        'hash': '#asset?asset=SOL&chain=solana',
        'state': {'stack': ['scr-wallet', 'scr-asset']},
        'active': ['scr-asset'],
    }, f'hostile Asset popstate sanitizes projection/ancestry without growth: '
       f'{hostile_asset_state}')
    hostile_receive_state = page.evaluate("""() => {
      const before=history.length;
      const hostile={stack:['scr-wallet','scr-asset'],
        voice:{state:'joined',open:true,minimized:false,muted:false},
        asset:'GLYPH',cursor:'do-not-copy'};
      history.replaceState(hostile,'','#receive?asset=ETH&chain=base');
      dispatchEvent(new PopStateEvent('popstate',{state:hostile}));
      return {before,after:history.length,hash:location.hash,state:history.state,
        active:[...document.querySelectorAll('.scr.active')].map(node=>node.id)};
    }""")
    check(hostile_receive_state == {
        'before': hostile_receive_state['before'],
        'after': hostile_receive_state['before'],
        'hash': '#receive?asset=ETH&chain=base',
        'state': {'stack': ['scr-wallet', 'scr-receive']},
        'active': ['scr-receive'],
    }, f'outer state with unexpected keys rejects voice and ancestry together: '
       f'{hostile_receive_state}')
    check(not page_errors,
          f'hostile popstate sanitization has no console/page errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '#receive?asset=ETH&chain=base')
    hostile_descriptor_cases = page.evaluate("""() => {
      const baseVoice=()=>({state:'joined',open:true,minimized:false,muted:false});
      const baseStack=()=>['scr-wallet','scr-asset','scr-receive'];
      const results=[];
      const cases=[
        ['outer-accessor',counter=>{
          const value={voice:baseVoice()};
          Object.defineProperty(value,'stack',{enumerable:true,get(){counter.count+=1;return baseStack()}});
          return value;
        }],
        ['outer-symbol',()=>Object.assign({stack:baseStack(),voice:baseVoice()},{[Symbol('x')]:1})],
        ['outer-extra',()=>({stack:baseStack(),voice:baseVoice(),cursor:'opaque'})],
        ['outer-exotic',()=>Object.assign(Object.create(null),{stack:baseStack(),voice:baseVoice()})],
        ['stack-accessor',counter=>{
          const value=baseStack();
          Object.defineProperty(value,'1',{enumerable:true,get(){counter.count+=1;return 'scr-asset'}});
          return {stack:value,voice:baseVoice()};
        }],
        ['stack-symbol',()=>{const value=baseStack();value[Symbol('x')]=1;
          return {stack:value,voice:baseVoice()}}],
        ['stack-extra',()=>{const value=baseStack();value.extra=true;
          return {stack:value,voice:baseVoice()}}],
        ['stack-sparse',()=>{const value=[];value[0]='scr-wallet';value[2]='scr-receive';
          return {stack:value,voice:baseVoice()}}],
        ['stack-exotic',()=>{const value=baseStack();Object.setPrototypeOf(value,null);
          return {stack:value,voice:baseVoice()}}],
        ['voice-accessor',counter=>{
          const value={open:true,minimized:false,muted:false};
          Object.defineProperty(value,'state',{enumerable:true,get(){counter.count+=1;return 'joined'}});
          return {stack:baseStack(),voice:value};
        }],
        ['voice-symbol',()=>{const value=baseVoice();value[Symbol('x')]=1;
          return {stack:baseStack(),voice:value}}],
        ['voice-extra',()=>({stack:baseStack(),voice:{...baseVoice(),extra:true}})],
        ['voice-exotic',()=>({stack:baseStack(),voice:Object.assign(
          Object.create(null),baseVoice())})],
      ];
      for(const [label,make] of cases){
        const counter={count:0};
        const candidate=make(counter);
        dispatchEvent(new PopStateEvent('popstate',{state:candidate}));
        results.push({label,getters:counter.count,state:structuredClone(history.state)});
      }
      return results;
    }""")
    descriptor_failures = [result for result in hostile_descriptor_cases
                           if result['getters'] != 0 or result['state'] != {
                               'stack': ['scr-wallet', 'scr-receive']}]
    check(not descriptor_failures,
          'hostile outer/stack/voice descriptors fail closed without invoking getters: '
          f'{descriptor_failures}')
    check(not page_errors,
          f'hostile descriptor rejection has no page/console errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#wallet')
    wallet_semantics = page.evaluate("""() => ({
      walletClass: document.querySelector('#scr-wallet [data-wallet-class]')?.textContent,
      address: document.querySelector('#wallet-content [data-wallet-address]')?.textContent,
      providerState: document.querySelector('#wallet-content [data-provider-state]')?.textContent,
      totalLabel: document.querySelector('#wallet-content [data-total-provenance]')?.textContent,
      assetButtons: [...document.querySelectorAll('#wallet-assets button[data-asset]')]
        .map(button => [button.dataset.asset, button.getAttribute('aria-label')]),
      actions: [...document.querySelectorAll('#wallet-actions button')]
        .map(button => [button.textContent.trim(), button.disabled]),
      bridgeCopy: document.getElementById('wallet-bridge-note')?.textContent,
    })""")
    check(wallet_semantics['walletClass'] == 'Privy embedded',
          f'F1 renders wallet class: {wallet_semantics["walletClass"]}')
    check(wallet_semantics['address'] == '0x7E57D0041C5B5e9B6F3A9E64A2C8D1F0B4C6A821',
          'F1 exposes the exact provider address')
    check(wallet_semantics['providerState'] == 'Provider data ready',
          f'F1 renders provider state: {wallet_semantics["providerState"]}')
    check(wallet_semantics['totalLabel'] == 'LOOP total derived from Privy balances',
          'F1 renders exact total provenance')
    check(len(wallet_semantics['assetButtons']) >= 3 and
          all(pair[1] for pair in wallet_semantics['assetButtons']),
          f'F1 assets are accessible buttons: {wallet_semantics["assetButtons"]}')
    check(wallet_semantics['actions'] == [
        ['Send', False], ['Receive', False], ['Swap', False], ['Bridge', True]],
        f'F1 actions are capability-scoped: {wallet_semantics["actions"]}')
    check(wallet_semantics['bridgeCopy'] ==
          'Bridge provider integration is planned for the next slice.',
          'F1 Bridge uses exact disabled-scope copy')
    page.click('#wallet-send')
    check(page.evaluate('location.hash') == '#asset?asset=ETH&chain=base',
          'F1 Send routes only to selected/default F2')
    page.click('#asset-receive')
    check(page.evaluate('location.hash') == '#receive?asset=ETH&chain=base',
          'F2 Receive routes to F6 with the selected compatible pair')
    check(page.evaluate('history.state.stack') ==
          ['scr-wallet', 'scr-asset', 'scr-receive'],
          'in-app F6 preserves exact Asset origin stack')
    page.click('#scr-receive .back')
    check(page.evaluate('location.hash') == '#asset?asset=ETH&chain=base' and
          page.evaluate('history.state.stack') == ['scr-wallet', 'scr-asset'],
          'visible Back restores exact Asset origin')
    page.click('#asset-receive')
    page.go_back()
    page.wait_for_timeout(100)
    check(page.evaluate('location.hash') == '#asset?asset=ETH&chain=base' and
          page.locator('#scr-asset').get_attribute('class').split().count('active') == 1,
          'browser Back restores the exact Asset origin')
    page.go_forward()
    page.wait_for_timeout(100)
    check(page.evaluate("""() => ({
      hash:location.hash,
      stack:history.state?.stack,
      active:[...document.querySelectorAll('.scr.active')].map(node=>node.id)
    })""") == {
        'hash': '#receive?asset=ETH&chain=base',
        'stack': ['scr-wallet', 'scr-asset', 'scr-receive'],
        'active': ['scr-receive'],
    }, 'browser Forward restores the exact issued three-level Receive ancestry')
    check(not page_errors, f'F1/F2/F6 navigation has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '#asset?asset=ETH&chain=base')
    page.focus('#asset-receive')
    page.keyboard.press('Enter')
    keyboard_issued = page.evaluate('history.state.stack')
    page.go_back()
    page.wait_for_timeout(100)
    page.go_forward()
    page.wait_for_timeout(100)
    keyboard_forward = page.evaluate('history.state.stack')
    check(keyboard_issued == ['scr-wallet', 'scr-asset', 'scr-receive'] and
          keyboard_forward == ['scr-wallet', 'scr-asset', 'scr-receive'],
          'trusted keyboard activation issues provenance and survives Back/Forward')
    check(not page_errors,
          f'trusted keyboard Receive navigation has no errors: {page_errors}')
    context.close()

    for lifecycle, persisted, expected_stack in (
            ('non-persisted pagehide', False, ['scr-wallet', 'scr-receive']),
            ('BFCache pagehide', True,
             ['scr-wallet', 'scr-asset', 'scr-receive'])):
        context, page, page_errors = task3_page(
            APP.as_uri() + '#asset?asset=ETH&chain=base')
        page.click('#asset-receive')
        lifecycle_state = page.evaluate("""persisted => {
          const issued=structuredClone(history.state);
          dispatchEvent(new PageTransitionEvent('pagehide',{persisted}));
          if(persisted) dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
          dispatchEvent(new PopStateEvent('popstate',{state:issued}));
          return history.state.stack;
        }""", persisted)
        check(lifecycle_state == expected_stack,
              f'{lifecycle} has the required proof lifecycle: {lifecycle_state}')
        check(not page_errors,
              f'{lifecycle} proof lifecycle has no errors: {page_errors}')
        context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '#asset?asset=ETH&chain=base')
    page.click('#asset-receive')
    page.reload()
    page.wait_for_load_state('domcontentloaded')
    reloaded_proof = page.evaluate("""() => {
      const replay=structuredClone(history.state);
      dispatchEvent(new PopStateEvent('popstate',{state:replay}));
      return history.state.stack;
    }""")
    check(reloaded_proof == ['scr-wallet', 'scr-receive'],
          f'reload discards unknown Receive proof: {reloaded_proof}')
    check(not page_errors,
          f'reloaded Receive proof rejection has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '#receive?asset=ETH&chain=base')
    forged_receive = page.evaluate("""() => {
      const before=history.length;
      const forged={stack:['scr-wallet','scr-asset','scr-receive'],
        voice:{state:'idle',open:false,minimized:false,muted:true}};
      history.replaceState(forged,'',location.href);
      dispatchEvent(new PopStateEvent('popstate',{state:forged}));
      return {before,after:history.length,state:history.state,
        active:[...document.querySelectorAll('.scr.active')].map(node=>node.id)};
    }""")
    check(forged_receive == {
        'before': forged_receive['before'],
        'after': forged_receive['before'],
        'state': {'stack': ['scr-wallet', 'scr-receive']},
        'active': ['scr-receive'],
    }, f'unissued three-level Receive ancestry fails closed without history growth: '
       f'{forged_receive}')
    check(not page_errors,
          f'unissued Receive proof rejection has no errors: {page_errors}')
    context.close()

    proof_mint_attempts = [
        ('direct proof mutator', """() => {
          const forged={stack:['scr-wallet','scr-asset','scr-receive'],
            voice:{state:'idle',open:false,minimized:false,muted:true}};
          const exposed=typeof walletNavigationProof;
          if(exposed!=='undefined') walletNavigationProof.remember(forged.stack);
          history.replaceState(forged,'','#receive?asset=ETH&chain=base');
          dispatchEvent(new PopStateEvent('popstate',{state:forged}));
          return {exposed,state:history.state};
        }"""),
        ('generic navigate', """() => {
          navigate(['scr-wallet','scr-asset','scr-receive']);
          const forged=structuredClone(history.state);
          dispatchEvent(new PopStateEvent('popstate',{state:forged}));
          return {exposed:typeof walletNavigationProof,state:history.state};
        }"""),
        ('generic routeWalletPair', """() => {
          routeWalletPair('receive','ETH','base');
          const forged=structuredClone(history.state);
          dispatchEvent(new PopStateEvent('popstate',{state:forged}));
          return {exposed:typeof walletNavigationProof,state:history.state};
        }"""),
        ('programmatic click', """() => {
          document.getElementById('asset-receive').click();
          const forged=structuredClone(history.state);
          dispatchEvent(new PopStateEvent('popstate',{state:forged}));
          return {exposed:typeof walletNavigationProof,state:history.state};
        }"""),
        ('synthetic dispatchEvent', """() => {
          document.getElementById('asset-receive').dispatchEvent(
            new MouseEvent('click',{bubbles:true,cancelable:true}));
          const forged=structuredClone(history.state);
          dispatchEvent(new PopStateEvent('popstate',{state:forged}));
          return {exposed:typeof walletNavigationProof,state:history.state};
        }"""),
    ]
    for label, attempt in proof_mint_attempts:
        context, page, page_errors = task3_page(
            APP.as_uri() + '#asset?asset=ETH&chain=base')
        result = page.evaluate(attempt)
        check(result == {
            'exposed': 'undefined',
            'state': {'stack': ['scr-wallet', 'scr-receive']},
        }, f'{label} cannot expose or mint Receive provenance: {result}')
        check(not page_errors, f'{label} proof rejection has no errors: {page_errors}')
        context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#wallet')
    page.click('#wallet-send')
    page.click('#asset-receive')
    replayed_receive = page.evaluate("""() => {
      const issuedState=structuredClone(history.state);
      const issuedKey=navigation.currentEntry.key;
      history.pushState(issuedState,'',location.href);
      const replayKey=navigation.currentEntry.key;
      const before=history.length;
      dispatchEvent(new PopStateEvent('popstate',{state:issuedState}));
      return {issuedKey,replayKey,before,after:history.length,state:history.state,
        active:[...document.querySelectorAll('.scr.active')].map(node=>node.id)};
    }""")
    check(replayed_receive['issuedKey'] != replayed_receive['replayKey'] and
          replayed_receive['after'] == replayed_receive['before'] and
          replayed_receive['state'] == {'stack': ['scr-wallet', 'scr-receive']} and
          replayed_receive['active'] == ['scr-receive'],
          f'issued-looking state replayed on a different Navigation key fails closed: '
          f'{replayed_receive}')
    check(not page_errors,
          f'cross-entry Receive proof rejection has no errors: {page_errors}')
    context.close()

    context = browser.new_context()
    context.add_init_script("""Object.defineProperty(globalThis,'navigation',{
      configurable:true,value:undefined
    })""")
    page = context.new_page()
    missing_navigation_errors = []
    page.on('console', lambda message:
            missing_navigation_errors.append(message.text)
            if message.type == 'error' else None)
    page.on('pageerror', lambda error:
            missing_navigation_errors.append(f'pageerror: {error}'))
    page.goto(APP.as_uri() + '#receive?asset=ETH&chain=base')
    page.wait_for_load_state('domcontentloaded')
    page.wait_for_timeout(100)
    missing_navigation = page.evaluate("""() => {
      const forged={stack:['scr-wallet','scr-asset','scr-receive'],
        voice:{state:'idle',open:false,minimized:false,muted:true}};
      history.replaceState(forged,'',location.href);
      dispatchEvent(new PopStateEvent('popstate',{state:forged}));
      return {navigation:typeof globalThis.navigation,state:history.state,
        active:[...document.querySelectorAll('.scr.active')].map(node=>node.id)};
    }""")
    check(missing_navigation == {
        'navigation': 'undefined',
        'state': {'stack': ['scr-wallet', 'scr-receive']},
        'active': ['scr-receive'],
    }, f'missing Navigation API fails closed to direct Receive ancestry: '
       f'{missing_navigation}')
    check(not missing_navigation_errors,
          f'missing Navigation API proof rejection has no errors: '
          f'{missing_navigation_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '#asset?asset=ETH&chain=base')
    live_navigation_replay = page.evaluate("""() => {
      const nativeNavigation=globalThis.navigation;
      document.documentElement.__testNativeNavigation=nativeNavigation;
      const fixedKey='attacker-fixed-navigation-key';
      Object.defineProperty(globalThis,'navigation',{
        configurable:true,value:{currentEntry:{key:fixedKey}}
      });
      return {fixedKey};
    }""")
    page.click('#asset-receive')
    live_navigation_replay.update(page.evaluate("""() => {
      const issued=structuredClone(history.state);
      history.pushState(issued,'',location.href);
      const before=history.length;
      dispatchEvent(new PopStateEvent('popstate',{state:issued}));
      const state=structuredClone(history.state);
      Object.defineProperty(globalThis,'navigation',{
        configurable:true,value:document.documentElement.__testNativeNavigation
      });
      delete document.documentElement.__testNativeNavigation;
      return {before,after:history.length,state};
    }"""))
    check(live_navigation_replay == {
        'fixedKey': 'attacker-fixed-navigation-key',
        'before': live_navigation_replay['before'],
        'after': live_navigation_replay['before'],
        'state': {'stack': ['scr-wallet', 'scr-receive']},
    }, 'replaced live Navigation identity cannot authorize cross-entry replay: '
       f'{live_navigation_replay}')
    check(not page_errors,
          f'live Navigation replacement rejection has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '#asset?asset=ETH&chain=base')
    valid_shadow = 'attacker-reused-bounded-navigation-key'
    page.evaluate("""shadow => {
      document.getElementById('asset-receive').addEventListener('click',()=>{
        Object.defineProperty(navigation.currentEntry,'key',{
          configurable:true,value:shadow
        });
      },{once:true});
    }""", valid_shadow)
    page.click('#asset-receive')
    cross_entry_shadow = page.evaluate("""shadow => {
      const issuedEntry=navigation.currentEntry;
      const nativeKeyGetter=Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(issuedEntry),'key').get;
      const issuedNativeKey=nativeKeyGetter.call(issuedEntry);
      const issued=structuredClone(history.state);
      history.pushState(issued,'',location.href);
      const replayEntry=navigation.currentEntry;
      const replayNativeKey=nativeKeyGetter.call(replayEntry);
      Object.defineProperty(replayEntry,'key',{
        configurable:true,value:shadow
      });
      const before=history.length;
      dispatchEvent(new PopStateEvent('popstate',{state:issued}));
      return {issuedNativeKey,replayNativeKey,shadow,
        issuedOwn:Object.prototype.hasOwnProperty.call(issuedEntry,'key'),
        replayOwn:Object.prototype.hasOwnProperty.call(replayEntry,'key'),
        before,after:history.length,state:structuredClone(history.state)};
    }""", valid_shadow)
    check(cross_entry_shadow['issuedNativeKey'] !=
          cross_entry_shadow['replayNativeKey'] and
          cross_entry_shadow['issuedOwn'] and cross_entry_shadow['replayOwn'] and
          cross_entry_shadow['shadow'] == valid_shadow and
          cross_entry_shadow['after'] == cross_entry_shadow['before'] and
          cross_entry_shadow['state'] == {'stack': ['scr-wallet', 'scr-receive']},
          'valid bounded own key shadow replayed across native entries fails closed: '
          f'{cross_entry_shadow}')
    check(not page_errors,
          f'valid own key shadow rejection has no errors: {page_errors}')
    context.close()

    navigation_accessor_cases = [
        ('navigation getter throws', """() => {
          document.documentElement.__testNativeNavigation=globalThis.navigation;
          Object.defineProperty(globalThis,'navigation',{configurable:true,
            get(){throw new Error('hostile navigation getter')}});
        }"""),
        ('currentEntry getter throws', """() => {
          document.documentElement.__testNativeNavigation=globalThis.navigation;
          Object.defineProperty(globalThis,'navigation',{configurable:true,
            value:Object.defineProperty({},'currentEntry',{
              get(){throw new Error('hostile currentEntry getter')}})});
        }"""),
        ('key getter throws', """() => {
          document.documentElement.__testNativeNavigation=globalThis.navigation;
          const currentEntry=Object.defineProperty({},'key',{
            get(){throw new Error('hostile key getter')}});
          Object.defineProperty(globalThis,'navigation',{configurable:true,
            value:{currentEntry}});
        }"""),
    ]
    for label, install in navigation_accessor_cases:
        context, page, page_errors = task3_page(
            APP.as_uri() + '#asset?asset=ETH&chain=base')
        page.evaluate(install)
        page.click('#asset-receive')
        accessor_result = page.evaluate("""() => {
          const issued=structuredClone(history.state);
          Object.defineProperty(globalThis,'navigation',{
            configurable:true,value:document.documentElement.__testNativeNavigation
          });
          delete document.documentElement.__testNativeNavigation;
          dispatchEvent(new PopStateEvent('popstate',{state:issued}));
          return structuredClone(history.state);
        }""")
        check(accessor_result == {'stack': ['scr-wallet', 'scr-receive']},
              f'{label} fails closed without issuing proof: {accessor_result}')
        check(not page_errors, f'{label} causes no pageerror: {page_errors}')
        context.close()

    for label, hostile_key in (
            ('empty', ''), ('number', 7), ('object', {'fixed': True}),
            ('overlong', 'k' * 257)):
        context, page, page_errors = task3_page(
            APP.as_uri() + '#asset?asset=ETH&chain=base')
        page.evaluate("""key => {
          document.getElementById('asset-receive').addEventListener('click',()=>{
            Object.defineProperty(navigation.currentEntry,'key',{
              configurable:true,value:key
            });
          },{once:true});
        }""", hostile_key)
        page.click('#asset-receive')
        malformed_key_result = page.evaluate("""() => {
          const issued=structuredClone(history.state);
          dispatchEvent(new PopStateEvent('popstate',{state:issued}));
          return structuredClone(history.state);
        }""")
        check(malformed_key_result == {'stack': ['scr-wallet', 'scr-receive']},
              f'{label} Navigation key fails closed: {malformed_key_result}')
        check(not page_errors,
              f'{label} Navigation key rejection has no errors: {page_errors}')
        context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '#asset?asset=ETH&chain=base')
    issued_keys = []
    for index in range(34):
        page.click('#asset-receive')
        issued_keys.append(page.evaluate('navigation.currentEntry.key'))
        if index < 33:
            page.click('#scr-receive .back')
    bounded_proofs = page.evaluate("""async issuedKeys => {
      const newestState=structuredClone(history.state);
      dispatchEvent(new PopStateEvent('popstate',{state:newestState}));
      const newest={key:navigation.currentEntry.key,stack:history.state.stack.slice()};
      await navigation.traverseTo(issuedKeys[0]).finished;
      await new Promise(resolve=>setTimeout(resolve,0));
      const replay={stack:['scr-wallet','scr-asset','scr-receive']};
      history.replaceState(replay,'','#receive?asset=ETH&chain=base');
      dispatchEvent(new PopStateEvent('popstate',{state:replay}));
      const oldest={key:navigation.currentEntry.key,stack:history.state.stack.slice()};
      const historyKeys=Object.keys(newestState).sort();
      const globalLeaks=Reflect.ownKeys(globalThis).filter(key=>typeof key==='string'&&
        /(?:wallet.*(?:proof|store|token|internal)|(?:proof|store|token|internal).*wallet)/i.test(key));
      const storageEntries=storage=>Array.from({length:storage.length},(_,index)=>{
        const key=storage.key(index); return [key,storage.getItem(key)];
      });
      const sessionEntries=storageEntries(sessionStorage);
      const localEntries=storageEntries(localStorage);
      const serializedSurfaces=JSON.stringify({newestState,sessionEntries,localEntries});
      return {issuedCount:issuedKeys.length,newest,oldest,
        newestWasLastIssued:newest.key===issuedKeys.at(-1),
        oldestWasFirstIssued:oldest.key===issuedKeys[0],historyKeys,globalLeaks,
        facadeGlobal:typeof globalThis.walletNavigationProof,
        surfaceLeaks:/walletNavigationProof|entryKey|proof|issued|token|internals/i
          .test(serializedSurfaces),sessionEntries,localEntries};
    }""", issued_keys)
    check(bounded_proofs['issuedCount'] == 34 and
          bounded_proofs['newestWasLastIssued'] and
          bounded_proofs['newest']['stack'] ==
              ['scr-wallet', 'scr-asset', 'scr-receive'] and
          bounded_proofs['oldestWasFirstIssued'] and
          bounded_proofs['oldest']['stack'] == ['scr-wallet', 'scr-receive'],
          f'bounded proof store accepts newest and rejects oldest after 34 issues: '
          f'{bounded_proofs}')
    check(bounded_proofs['historyKeys'] == ['stack'] and
          bounded_proofs['globalLeaks'] == [] and
          bounded_proofs['facadeGlobal'] == 'undefined' and
          not bounded_proofs['surfaceLeaks'],
          'proof/store/token internals are absent from globals, history, and storage '
          f'surfaces: {bounded_proofs}')
    check(not page_errors,
          f'bounded/isolation Receive proof checks have no errors: {page_errors}')
    context.close()

    context, page, _errors = task3_page(
        APP.as_uri() + '?demo=wallet-stale#wallet')
    stale_before = page.evaluate("""() => ({
      visible: document.getElementById('wallet-assets')?.textContent,
      timestamp: document.getElementById('wallet-stale-time')?.textContent,
      walletClass: document.getElementById('wallet-content')?.dataset.walletClass,
      provider: document.getElementById('wallet-content')?.dataset.provider,
    })""")
    page.click('#wallet-retry')
    stale_after = page.evaluate("""() => ({
      walletClass: document.getElementById('wallet-content')?.dataset.walletClass,
      provider: document.getElementById('wallet-content')?.dataset.provider,
    })""")
    check(bool(stale_before['visible']) and bool(stale_before['timestamp']),
          f'F1 stale values remain visible with timestamp: {stale_before}')
    check(stale_after == {key: stale_before[key] for key in ('walletClass', 'provider')},
          f'F1 Retry retains wallet class/provider: {stale_after}')
    context.close()

    retry_layout_matrix = {}
    for label, viewport in (
            ('mobile_375x667', {'width': 375, 'height': 667}),
            ('desktop_1440x900', {'width': 1440, 'height': 900})):
        context, page, page_errors = task3_page(
            APP.as_uri() + '?demo=wallet-stale#wallet', viewport=viewport)
        retry_layout_matrix[label] = page.evaluate("""() => {
          const button=document.getElementById('wallet-retry');button.focus();
          const rect=button.getBoundingClientRect();
          const screen=document.getElementById('scr-wallet').getBoundingClientRect();
          return {width:rect.width,height:rect.height,focused:document.activeElement===button,
            focusVisible:button.matches(':focus-visible'),
            horizontal:document.documentElement.scrollWidth>
              document.documentElement.clientWidth,
            reachable:rect.top>=screen.top&&rect.bottom<=screen.bottom&&
              rect.left>=screen.left&&rect.right<=screen.right};
        }""")
        retry_layout_matrix[label]['errors'] = page_errors
        context.close()
    check(all(item['width'] >= 44 and item['height'] >= 44 and item['focused'] and
              item['focusVisible'] and not item['horizontal'] and item['reachable'] and
              not item['errors'] for item in retry_layout_matrix.values()),
          f'wallet-stale Retry is 44px, focus-visible, reachable, and overflow-safe '
          f'at mobile/desktop: {retry_layout_matrix}')

    state_expectations = {
        'wallet-loading': 'Loading provider balances',
        'wallet-empty': 'No supported assets reported by Privy',
        'wallet-partial': 'Some provider data is unavailable',
        'wallet-external-gap': 'Balance provider not available for this wallet.',
        'wallet-watch-only': 'Watch-only — no signing actions are available',
    }
    for demo, copy in state_expectations.items():
        context, page, _errors = task3_page(APP.as_uri() + f'?demo={demo}#wallet')
        check(copy in page.locator('#wallet-content').inner_text(),
              f'F1 {demo} renders honest state copy')
        context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '?demo=wallet-watch-only#wallet')
    watch_capabilities = page.evaluate("""() => ({
      signing:[...document.querySelectorAll('#scr-wallet [data-requires-signing]')]
        .map(control=>({id:control.id,disabled:control.disabled,
          aria:control.getAttribute('aria-disabled'),
          described:control.getAttribute('aria-describedby')})),
      receive:{disabled:document.getElementById('wallet-receive').disabled,
        aria:document.getElementById('wallet-receive').getAttribute('aria-disabled')},
      explanation:{hidden:document.getElementById('watch-only-explanation').hidden,
        text:document.getElementById('watch-only-explanation').textContent.trim()}
    })""")
    check(len(watch_capabilities['signing']) == 4 and all(
          control['disabled'] and control['aria'] == 'true' and
          control['described'] == 'watch-only-explanation'
          for control in watch_capabilities['signing']) and
          watch_capabilities['receive'] == {'disabled': False, 'aria': None} and
          watch_capabilities['explanation'] == {
              'hidden': False,
              'text': 'Watch-only wallets cannot sign transactions.'},
          f'watch-only adapter disables/explains every F1 signing origin but Receive: '
          f'{watch_capabilities}')
    check(not page_errors,
          f'watch-only capability gating has no console/page errors: {page_errors}')
    context.close()

    for route_name, control_id in (('dapp', 'dapp-approve'),
                                   ('swap', 'swap-submit')):
        context, page, page_errors = task3_page(
            APP.as_uri() + f'?demo=wallet-watch-only#{route_name}')
        if route_name == 'dapp':
            page.wait_for_timeout(950)
        state = page.evaluate("""controlId => {
          const control=document.getElementById(controlId);
          control.click();
          return {disabled:control.disabled,
            aria:control.getAttribute('aria-disabled'),
            described:control.getAttribute('aria-describedby'),
            explanation:document.getElementById('watch-only-explanation').textContent.trim(),
            explanationHidden:document.getElementById('watch-only-explanation').hidden,
            approvalOpen:document.getElementById('sheet-approve').classList.contains('open'),
            swapOpen:document.getElementById('review-dialog').classList.contains('open')};
        }""", control_id)
        page.wait_for_timeout(1600 if route_name == 'swap' else 50)
        state['swapOpenAfterDelay'] = page.locator('#review-dialog').evaluate(
            "node => node.classList.contains('open')")
        check(state == {
            'disabled': True, 'aria': 'true',
            'described': 'watch-only-explanation',
            'explanation': 'Watch-only wallets cannot sign transactions.',
            'explanationHidden': False, 'approvalOpen': False,
            'swapOpen': False, 'swapOpenAfterDelay': False,
        }, f'direct watch-only #{route_name} disables and blocks signing: {state}')
        check(not page_errors,
              f'direct watch-only #{route_name} has no errors: {page_errors}')
        context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '?demo=wallet-external-gap#wallet')
    external_wallet_capabilities = page.evaluate("""() => ({
      controls:Object.fromEntries(['wallet-send','wallet-swap','wallet-bridge',
        'wallet-dapps'].map(id=>{
          const node=document.getElementById(id);
          return [id,{disabled:node.disabled,aria:node.getAttribute('aria-disabled')}];
        })),
      receive:document.getElementById('wallet-receive').disabled
    })""")
    check(external_wallet_capabilities == {
        'controls': {
            'wallet-send': {'disabled': False, 'aria': None},
            'wallet-swap': {'disabled': True, 'aria': 'true'},
            'wallet-bridge': {'disabled': True, 'aria': 'true'},
            'wallet-dapps': {'disabled': False, 'aria': None},
        },
        'receive': False,
    }, f'external wallet keeps transfer/approve/receive while gating swap: '
       f'{external_wallet_capabilities}')
    check(not page_errors,
          f'external Wallet capability rendering has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '?demo=wallet-external-gap#swap')
    external_swap = page.evaluate("""() => {
      const control=document.getElementById('swap-submit');
      control.click();
      return {disabled:control.disabled,aria:control.getAttribute('aria-disabled'),
        described:control.getAttribute('aria-describedby'),
        explanation:document.getElementById('watch-only-explanation').textContent.trim(),
        explanationHidden:document.getElementById('watch-only-explanation').hidden};
    }""")
    page.wait_for_timeout(1600)
    external_swap['swapOpen'] = page.locator('#review-dialog').evaluate(
        "node => node.classList.contains('open')")
    check(external_swap == {
        'disabled': True, 'aria': 'true',
        'described': 'watch-only-explanation',
        'explanation': 'Swap is not available for this external wallet.',
        'explanationHidden': False, 'swapOpen': False,
    }, f'direct external-provider-gap Swap is disabled and explained: {external_swap}')
    check(not page_errors,
          f'direct external-provider-gap Swap has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '?demo=wallet-external-gap#dapp')
    page.wait_for_timeout(950)
    check(not page.locator('#dapp-approve').is_disabled() and
          page.locator('#sheet-approve').evaluate("node => node.classList.contains('open')"),
          'external wallet retains normalized approve capability on direct DApp route')
    check(not page_errors,
          f'direct external DApp capability rendering has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '?demo=wallet-watch-only#swap')
    page.reload()
    page.wait_for_load_state('domcontentloaded')
    check(page.locator('#swap-submit').is_disabled(),
          'watch-only signing capability is revalidated after reload')
    page.evaluate("""base => {
      const next={stack:['scr-wallet','scr-dapp'],
        voice:{state:'idle',open:false,minimized:false,muted:true}};
      history.pushState(next,'',base+'?demo=wallet-external-gap#dapp');
      dispatchEvent(new PopStateEvent('popstate',{state:next}));
    }""", APP.as_uri())
    check(not page.locator('#dapp-approve').is_disabled(),
          'browser entry change revalidates external approve capability')
    page.go_back()
    page.wait_for_timeout(100)
    back_capability = page.locator('#swap-submit').is_disabled()
    page.go_forward()
    page.wait_for_timeout(100)
    forward_capability = not page.locator('#dapp-approve').is_disabled()
    check(back_capability and forward_capability,
          'browser Back/Forward revalidates current wallet capabilities')
    check(not page_errors,
          f'reload/Back/Forward capability checks have no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#wallet')
    stale_adapter_result = page.evaluate("""base => {
      const next={stack:['scr-wallet','scr-swap'],
        voice:{state:'idle',open:false,minimized:false,muted:true}};
      history.replaceState(next,'',base+'?demo=wallet-watch-only#swap');
      dispatchEvent(new PopStateEvent('popstate',{state:next}));
      return {disabled:document.getElementById('swap-submit').disabled,
        walletClass:ensureWalletAdapter().walletResult?.value?.wallet_class};
    }""", APP.as_uri())
    check(stale_adapter_result['disabled'] is True,
          f'query/demo change authorizes independently of stale display adapter: '
          f'{stale_adapter_result}')
    invalid_snapshot = page.evaluate("""() => {
      globalThis.walletRuntime={walletResult:null};
      navigate(['scr-wallet','scr-swap'],{replace:true});
      const control=document.getElementById('swap-submit');
      return {disabled:control.disabled,aria:control.getAttribute('aria-disabled')};
    }""")
    check(invalid_snapshot == {'disabled': True, 'aria': 'true'},
          f'missing mutable display snapshot cannot fail open watch authorization: '
          f'{invalid_snapshot}')
    check(not page_errors,
          f'stale/invalid adapter capability checks have no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '?demo=wallet-watch-only#swap')
    forged_runtime = page.evaluate("""() => {
      globalThis.walletRuntime={walletResult:{ok:true,value:{
        wallet_class:'privy_embedded',wallet_ref:'forged-wallet',addresses:[],
        capabilities:{balances:'supported',history:'supported',receive:'supported',
          transfer:'supported',swap:'supported',approve:'supported'}
      },meta:{source:'forged',fetched_at_ms:0,stale:false,partial:false}}};
      navigate(['scr-wallet','scr-swap'],{replace:true});
      const control=document.getElementById('swap-submit');
      doSwap(control);
      return {disabled:control.disabled,aria:control.getAttribute('aria-disabled'),
        lexical:[typeof walletAuthorizationAdapter,
          typeof walletAuthorizationSnapshot,typeof trustedLoopWalletProvider]};
    }""")
    page.wait_for_timeout(1600)
    forged_runtime['review'] = page.locator('#review-dialog').evaluate(
        "node => node.classList.contains('open')")
    check(forged_runtime == {
        'disabled': True, 'aria': 'true',
        'lexical': ['undefined', 'undefined', 'undefined'], 'review': False,
    }, f'plausible forged walletRuntime snapshot cannot authorize watch-only Swap: '
       f'{forged_runtime}')
    check(not page_errors,
          f'forged walletRuntime authorization check has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '?demo=wallet-watch-only#dapp')
    accessor_snapshot = page.evaluate("""() => {
      let getterCalls=0;
      const result={value:{wallet_class:'privy_embedded',capabilities:{
        transfer:'supported',swap:'supported',approve:'supported'}}};
      Object.defineProperty(result,'ok',{enumerable:true,
        get(){getterCalls+=1;return true}});
      globalThis.walletRuntime={walletResult:result};
      navigate(['scr-wallet','scr-dapp'],{replace:true});
      openApproveSheet();
      const control=document.getElementById('dapp-approve');
      return {getterCalls,disabled:control.disabled,
        aria:control.getAttribute('aria-disabled'),
        approvalOpen:document.getElementById('sheet-approve').classList.contains('open')};
    }""")
    check(accessor_snapshot == {
        'getterCalls': 0, 'disabled': True, 'aria': 'true',
        'approvalOpen': False,
    }, f'accessor-bearing walletRuntime result is never read for authorization: '
       f'{accessor_snapshot}')
    check(not page_errors,
          f'accessor-bearing authorization input has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#wallet')
    replaced_facade = page.evaluate("""base => {
      document.documentElement.__testTrustedProvider=globalThis.LoopWalletProvider;
      const forgedResult={ok:true,value:{wallet_class:'privy_embedded',
        capabilities:{transfer:'supported',swap:'supported',approve:'supported'}}};
      globalThis.LoopWalletProvider={createSimulatedAdapter(){return {
        getWalletSnapshot(){return forgedResult},getBalanceSnapshot(){return forgedResult},
        getTransactionHistorySnapshot(){return forgedResult},
        getReceiveTarget(){return forgedResult}
      }}};
      const next={stack:['scr-wallet','scr-swap'],
        voice:{state:'idle',open:false,minimized:false,muted:true}};
      history.replaceState(next,'',base+'?demo=wallet-watch-only#swap');
      dispatchEvent(new PopStateEvent('popstate',{state:next}));
      const control=document.getElementById('swap-submit');
      doSwap(control);
      const result={disabled:control.disabled,
        aria:control.getAttribute('aria-disabled')};
      globalThis.LoopWalletProvider=document.documentElement.__testTrustedProvider;
      delete document.documentElement.__testTrustedProvider;
      return result;
    }""", APP.as_uri())
    page.wait_for_timeout(1600)
    replaced_facade['review'] = page.locator('#review-dialog').evaluate(
        "node => node.classList.contains('open')")
    check(replaced_facade == {'disabled': True, 'aria': 'true', 'review': False},
          f'replaced live provider facade cannot authorize watch-only Swap: '
          f'{replaced_facade}')
    check(not page_errors,
          f'replaced provider facade authorization has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#swap')
    stale_private_authority = page.evaluate("""base => {
      const stale=ensureWalletAdapter();
      const next={stack:['scr-wallet','scr-swap'],
        voice:{state:'idle',open:false,minimized:false,muted:true}};
      history.replaceState(next,'',base+'?demo=wallet-watch-only#swap');
      globalThis.walletRuntime={key:'watch_only:watch_only:false',
        adapter:stale.adapter,walletResult:stale.walletResult};
      dispatchEvent(new PopStateEvent('popstate',{state:next}));
      const control=document.getElementById('swap-submit');
      doSwap(control);
      return {disabled:control.disabled,aria:control.getAttribute('aria-disabled')};
    }""", APP.as_uri())
    page.wait_for_timeout(1600)
    stale_private_authority['review'] = page.locator('#review-dialog').evaluate(
        "node => node.classList.contains('open')")
    check(stale_private_authority == {
        'disabled': True, 'aria': 'true', 'review': False,
    }, f'stale cached display adapter cannot authorize watch-only Swap: '
       f'{stale_private_authority}')
    check(not page_errors,
          f'stale private authorization check has no errors: {page_errors}')
    context.close()

    for demo in ('normal', 'wallet-external-gap'):
        context, page, page_errors = task3_page(
            APP.as_uri() + ('#swap' if demo == 'normal' else f'?demo={demo}#swap'))
        confused_deputy = page.evaluate("""() => {
          const nativeSetTimeout=globalThis.setTimeout;
          let timerCalls=0;
          globalThis.setTimeout=()=>{timerCalls+=1;return 1};
          const send=document.getElementById('wallet-send');
          const alternate=document.getElementById('wallet-swap');
          const approve=document.getElementById('dapp-approve');
          const before=[send.textContent,alternate.textContent,approve.textContent];
          const fake={id:'swap-submit',textContent:'Fake',style:{}};
          let threw=false;
          for(const candidate of [send,alternate,approve,fake,null]){
            try{doSwap(candidate)}catch(error){threw=true}
          }
          const after=[send.textContent,alternate.textContent,approve.textContent];
          globalThis.setTimeout=nativeSetTimeout;
          return {timerCalls,threw,before,after,fakeText:fake.textContent,
            review:document.getElementById('review-dialog').classList.contains('open')};
        }""")
        check(confused_deputy == {
            'timerCalls': 0, 'threw': False,
            'before': confused_deputy['before'],
            'after': confused_deputy['before'],
            'fakeText': 'Fake', 'review': False,
        }, f'doSwap rejects alternate/fake/null deputies under {demo}: '
           f'{confused_deputy}')
        check(not page_errors,
              f'doSwap deputy rejection under {demo} has no errors: {page_errors}')
        context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#swap')
    page.click('#swap-submit')
    check(page.locator('#swap-submit').inner_text() == 'Review swap',
          'actual Swap button retains its review-only label')
    check(page.locator('#review-dialog').evaluate(
          "node => node.classList.contains('open') && node.dataset.state === 'ready'") and
          page.evaluate("history.state?.review_id") == 'review-swap-fresh',
          'actual supported embedded Swap opens the canonical F11 review')
    check(not page_errors,
          f'legitimate embedded Swap action has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#swap')
    page.click('#completed-provider-fixture'); page.wait_for_timeout(60)
    page.click('[data-asset="GLYPH"]'); page.wait_for_timeout(60)
    asset_text = page.locator('#asset-content').inner_text()
    check('125 GLYPH' in asset_text and 'Value unavailable' in asset_text and
          'Provider quantity from Privy balance data' in asset_text,
          f'F2 renders quantity, unavailable fiat, and provenance: {asset_text[:180]!r}')
    check('Per-chain holdings' in asset_text and 'Base' in asset_text,
          'F2 renders per-chain normalized holdings')
    check(page.locator('#asset-review-transfer').inner_text() == 'Review simulated transfer' and
          not page.locator('#asset-review-transfer').is_disabled(),
          'F2 exposes the exact embedded-only review label')
    check(page.locator('#asset-load-more').count() == 1 and
          'opaque-fixture-cursor' not in page.evaluate('location.href') and
          'opaque-fixture-cursor' not in page.evaluate('JSON.stringify(history.state)'),
          'F2 keeps the opaque history cursor out of URL/history')
    page.click('#asset-load-more')
    check(page.locator('#asset-history [data-transaction-id="fixture-tx-1"]').count() == 1,
          'F2 de-duplicates paginated history without reordering')
    forbidden_asset_copy = ['chart', 'P&L', 'price oracle', 'explorer', 'send form',
                            'Bridge', 'live provider']
    check(not any(term.lower() in page.locator('#asset-content').inner_text().lower()
                  for term in forbidden_asset_copy),
          'F2 has no chart/P&L/invented explorer/send/Bridge/live-provider claims')
    context.close()

    context, page, _errors = task3_page(
        APP.as_uri() + '?demo=wallet-watch-only#asset?asset=ETH&chain=base')
    check(page.locator('#asset-review-transfer').is_disabled() and
          'Watch-only wallets cannot authorize signing requests.' in
          page.locator('#asset-content').inner_text(),
          'F2 disables executable review for watch-only wallet')
    context.close()

    context, page, _errors = task3_page(APP.as_uri() + '#asset?asset=ETH&chain=base')
    rich_history = page.evaluate("""() => {
      const normalized = LoopWalletProvider.normalizeTransactionPage({
        transactions: [
          {privy_transaction_id:'in-1',transaction_hash:'0xin',status:'confirmed',
           created_at:1,details:{type:'transfer_received',chain:'base',asset:'eth',
           sender:'0xsender',recipient:'0xrecipient',raw_value:'1',raw_value_decimals:18}},
          {privy_transaction_id:'out-1',transaction_hash:'0xout',status:'confirmed',
           created_at:2,details:{type:'transfer_sent',chain:'base',asset:'eth',
           sender:'0xsender',recipient:'0xrecipient',raw_value:'2',raw_value_decimals:18}},
          {privy_transaction_id:'pending-transfer',transaction_hash:null,status:'pending',
           created_at:3,details:{type:'transfer_sent',chain:'base',asset:'eth',
           sender:'0xsender',recipient:'0xrecipient',raw_value:'3',raw_value_decimals:18}},
          {privy_transaction_id:'no-details',transaction_hash:null,status:'confirmed',
           created_at:4,details:null},
          {privy_transaction_id:'other-1',transaction_hash:null,status:'confirmed',
           created_at:5,details:{type:'contract_call',chain:'base'}}
        ], next_cursor:null
      });
      renderAssetSnapshots(null, normalized, false);
      return [...document.querySelectorAll('#asset-history [data-transaction-id]')]
        .map(row=>[row.dataset.transactionId,
          row.querySelector('.transaction-direction').textContent]);
    }""")
    check(rich_history == [
        ['in-1', 'Incoming'],
        ['out-1', 'Outgoing'],
        ['pending-transfer', 'Transaction details pending'],
        ['no-details', 'Transaction details pending'],
        ['other-1', 'Wallet activity'],
    ], f'F2 independently distinguishes transfer/pending/no-detail/unknown activity: '
       f'{rich_history!r}')
    partial_history = page.evaluate("""() => {
      const normalized = LoopWalletProvider.normalizeTransactionPage({
        transactions:[{privy_transaction_id:'',transaction_hash:'',status:'pending',
          created_at:5,details:null}],next_cursor:null});
      renderAssetSnapshots(null, normalized, false);
      return document.getElementById('asset-history-status').innerText;
    }""")
    check('Some transaction records were omitted because the provider supplied no ID.' in
          partial_history, 'F2 renders missing-ID partial history honestly')
    context.close()

    exact_address = '0x7E57D0041C5B5e9B6F3A9E64A2C8D1F0B4C6A821'
    exact_warning = ('Only send ETH on Ethereum to this address. Using another asset or '
                     'network may result in permanent loss.')
    context, page, page_errors = task3_page(
        APP.as_uri() + '#receive?asset=ETH&chain=ethereum')
    receive = page.evaluate("""() => ({
      assets: [...document.querySelectorAll('#receive-asset option')].map(o => o.value),
      chains: [...document.querySelectorAll('#receive-chain option')].map(o => o.value),
      address: document.getElementById('receive-address')?.value,
      payload: document.querySelector('#receive-qr svg')?.dataset.qrPayload,
      alternative: document.querySelector('#receive-qr svg')?.getAttribute('aria-label'),
      warning: document.getElementById('receive-warning')?.textContent,
    })""")
    check(receive['assets'] == ['ETH', 'SOL', 'USDC', 'GLYPH'] and
          receive['chains'] == ['ethereum', 'base', 'arbitrum'],
          f'F6 exposes compatible selector options: {receive}')
    check(receive['address'] == exact_address and receive['payload'] == exact_address,
          'F6 QR payload exactly equals the provider address')
    check(receive['alternative'] and exact_address in receive['alternative'] and
          'Ethereum' in receive['alternative'],
          'F6 QR accessible alternative contains full address and network')
    check(receive['warning'] == exact_warning,
          f'F6 renders exact ETH/Ethereum warning: {receive["warning"]!r}')
    page.click('#receive-copy')
    page.wait_for_timeout(50)
    check(page.evaluate('globalThis.__copiedAddress') == exact_address,
          'F6 copies only the exact provider address')
    check(not page_errors, f'F6 local QR/copy has no errors: {page_errors}')
    context.close()

    context, page, _errors = task3_page(
        APP.as_uri() + '#receive?asset=ETH&chain=ethereum', clipboard='reject')
    page.click('#receive-copy')
    page.wait_for_timeout(50)
    check(page.locator('#receive-copy-status').inner_text() ==
          'Copy unavailable — select the address manually.' and
          page.evaluate('document.activeElement === document.getElementById("receive-address")') and
          page.evaluate('document.getElementById("receive-address").selectionStart === 0 && '
                        'document.getElementById("receive-address").selectionEnd === '
                        'document.getElementById("receive-address").value.length'),
          'F6 clipboard rejection selects/focuses address with exact fallback copy')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '#wallet', viewport={'width': 375, 'height': 667})
    mobile = page.evaluate("""() => {
      const screen = document.getElementById('scr-wallet');
      const controls = [...screen.querySelectorAll('#wallet-actions button,#wallet-assets button')];
      const within = controls.every(control => {
        const rect = control.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth;
      });
      controls.at(-1)?.scrollIntoView({block:'center'});
      return {documentOverflow:document.documentElement.scrollWidth > innerWidth,
        screenOverflow:screen.scrollWidth > screen.clientWidth,
        within, reachable:controls.at(-1)?.getBoundingClientRect().top < innerHeight};
    }""")
    check(mobile == {'documentOverflow': False, 'screenOverflow': False,
                     'within': True, 'reachable': True},
          f'375×667 has no horizontal overflow and primary controls are reachable: {mobile}')
    check(not page_errors, f'mobile Wallet has no errors: {page_errors}')
    context.close()

    print('\n== Task 6 F16 and Swap use the single F11 flow ==')
    context, page, page_errors = task3_page(APP.as_uri() + '#dapp')
    page.wait_for_timeout(1000)
    f16_copy = page.evaluate("""() => ({
      sheet:document.getElementById('sheet-approve').classList.contains('open'),
      url:document.querySelector('#scr-dapp .url-bar')?.textContent.trim()||'',
      frame:document.querySelector('#scr-dapp .df-head')?.textContent.trim()||'',
      sheetCopy:document.querySelector('#sheet-approve .sh-sub')?.textContent.trim()||'',
      limited:document.getElementById('approval-limit').textContent,
      unlimited:document.getElementById('approval-unlimited').textContent,
      persistent:document.getElementById('approval-review-notice')?.textContent||'',
      dialog:document.querySelectorAll('#review-dialog').length
    })""")
    check(f16_copy == {
        'sheet': True, 'url': '🔒 https://swap.zone ⟳',
        'frame': 'S Swap.zone connected',
        'sheetCopy': ('Swap.zone is requesting permission to spend your USDC. LOOP decoded '
                      'the immutable request before any wallet handoff.'),
        'limited': 'Review 1,000 limit',
        'unlimited': 'Review unlimited request',
        'persistent': ('No token approval has occurred. Your choice will be reviewed before '
                       'any wallet request.'), 'dialog': 1,
    }, f'F16 exposes exact review-only controls and persistent copy: {f16_copy}')
    page.evaluate("document.getElementById('review-dialog').dataset.task6Node='shared-f11'")
    page.click('#approval-limit')
    limited_review = page.evaluate("""() => {
      const fields=Object.fromEntries([...document.querySelectorAll(
        '#review-fields .review-field')].map(row=>[
          row.querySelector('dt')?.textContent||'',row.querySelector('dd')?.childNodes[0]?.textContent||''
        ]));
      return {open:document.getElementById('review-dialog').classList.contains('open'),
        shared:document.getElementById('review-dialog').dataset.task6Node,
        sheet:document.getElementById('sheet-approve').classList.contains('open'),
        reviewId:history.state?.review_id||'',kind:document.getElementById('review-kind').textContent,
        summary:document.getElementById('review-summary').textContent,
        allowance:fields.Allowance||'',origin:fields.Origin||'',spender:fields.Spender||'',
        marker:history.state?.loop_review===1,
        successClaims:/approved|signed|broadcast|submitted/i.test(
          document.getElementById('review-dialog').innerText)};
    }""")
    check(limited_review == {
        'open': True, 'shared': 'shared-f11', 'sheet': False,
        'reviewId': 'review-approve-limited', 'kind': 'Approval',
        'summary': ('You are reviewing a request for Swap.zone to spend up to 1,000 USDC '
                    'on Ethereum.'),
        'allowance': '1,000 USDC', 'origin': 'https://swap.zone',
        'spender': 'Swap.zone · 0x2222222222222222222222222222222222222222',
        'marker': True, 'successClaims': False,
    }, f'limited approval selects immutable canonical fixture into shared F11: {limited_review}')
    page.click('#review-cancel'); page.wait_for_timeout(80)
    page.evaluate('openApproveSheet()')
    page.click('#approval-unlimited')
    unlimited_review = page.evaluate("""() => {
      const fields=Object.fromEntries([...document.querySelectorAll(
        '#review-fields .review-field')].map(row=>[
          row.querySelector('dt')?.textContent||'',row.querySelector('dd')?.childNodes[0]?.textContent||''
        ]));
      return {open:document.getElementById('review-dialog').classList.contains('open'),
        shared:document.getElementById('review-dialog').dataset.task6Node,
        reviewId:history.state?.review_id||'',summary:
          document.getElementById('review-summary').textContent,allowance:fields.Allowance||''};
    }""")
    check(unlimited_review == {
        'open': True, 'shared': 'shared-f11', 'reviewId': 'review-approve-unlimited',
        'summary': ('You are reviewing a request for Swap.zone to spend unlimited USDC '
                    'on Ethereum.'), 'allowance': 'Unlimited',
    }, f'unlimited approval stays semantically bound in the same F11 node: {unlimited_review}')
    page.click('#review-cancel'); page.wait_for_timeout(80)
    mismatch = page.evaluate("""() => {
      const trigger=document.getElementById('approval-limit');
      const opened=openWalletReview('review-approve-mismatch',trigger);
      return {opened,state:document.getElementById('review-dialog').dataset.state,
        marker:Boolean(history.state?.loop_review),continueHidden:
          document.getElementById('review-continue').hidden};
    }""")
    check(mismatch == {'opened': False, 'state': 'decode_failed', 'marker': False,
                       'continueHidden': True},
          f'limited-display/unlimited-request mismatch fails closed: {mismatch}')
    page.click('#review-cancel')
    check(not page_errors, f'F16 unified review has no errors: {page_errors}')
    context.close()

    for control_id, expected_id, expected_allowance in (
            ('approval-limit', 'review-approve-external', '1,000 USDC'),
            ('approval-unlimited', 'review-approve-unlimited-external', 'Unlimited')):
        context, page, page_errors = task3_page(
            APP.as_uri() + '?demo=wallet-external-gap#dapp')
        page.wait_for_timeout(1000)
        page.click(f'#{control_id}')
        external_approval = page.evaluate("""() => {
          const fields=Object.fromEntries([...document.querySelectorAll(
            '#review-fields .review-field')].map(row=>[
              row.querySelector('dt')?.textContent||'',
              row.querySelector('dd')?.childNodes[0]?.textContent||''
            ]));
          return {open:document.getElementById('review-dialog').classList.contains('open'),
            state:document.getElementById('review-dialog').dataset.state,
            reviewId:history.state?.review_id||'',wallet:fields.Wallet||'',
            origin:fields.Origin||'',spender:fields.Spender||'',
            allowance:fields.Allowance||'',continueHidden:
              document.getElementById('review-continue').hidden};
        }""")
        check(external_approval == {
            'open': True, 'state': 'preview_unavailable', 'reviewId': expected_id,
            'wallet': '0xE87A4C2D1F9B6A3058C7E4D2B1A093F6C5E8D721',
            'origin': 'https://swap.zone',
            'spender': 'Swap.zone · 0x2222222222222222222222222222222222222222',
            'allowance': expected_allowance, 'continueHidden': False,
        }, f'external {control_id} opens authoritative non-decode-failed F11: '
           f'{external_approval}')
        check(not page_errors,
              f'external {control_id} F16 review has no errors: {page_errors}')
        context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#swap')
    balances_before = page.evaluate(
        "JSON.stringify(ensureWalletAdapter().adapter.getBalanceSnapshot({}))")
    page.evaluate("document.getElementById('review-dialog').dataset.task6Node='shared-f11'")
    page.click('#swap-submit')
    swap_review = page.evaluate("""() => {
      const fields=Object.fromEntries([...document.querySelectorAll(
        '#review-fields .review-field')].map(row=>[
          row.querySelector('dt')?.textContent||'',row.querySelector('dd')?.childNodes[0]?.textContent||''
        ]));
      return {open:document.getElementById('review-dialog').classList.contains('open'),
        shared:document.getElementById('review-dialog').dataset.task6Node,
        state:document.getElementById('review-dialog').dataset.state,
        reviewId:history.state?.review_id||'',summary:
          document.getElementById('review-summary').textContent,
        spend:fields.Spend||'',estimated:fields['Estimated output']||'',
        minimum:fields['Minimum output']||'',fee:fields.Fee||'',
        successNode:Boolean(document.getElementById('success'))};
    }""")
    check(swap_review == {
        'open': True, 'shared': 'shared-f11', 'state': 'ready',
        'reviewId': 'review-swap-fresh',
        'summary': ('You are preparing to ask Privy to swap 500 USDC for approximately '
                    '216,450 GLYPH on Ethereum (minimum 215,367.75 GLYPH).'),
        'spend': '500 USDC', 'estimated': '216450 GLYPH',
        'minimum': '215367.75 GLYPH', 'fee': '0.5 USDC', 'successNode': False,
    }, f'fresh simulated Privy quote opens exact shared F11 swap review: {swap_review}')
    page.click('#review-cancel'); page.wait_for_timeout(80)
    cancel_invariant = page.evaluate("""before => ({
      same:before===JSON.stringify(ensureWalletAdapter().adapter.getBalanceSnapshot({})),
      banner:document.getElementById('review-provider-banner').textContent,
      marker:Boolean(history.state?.loop_review),open:
        document.getElementById('review-dialog').classList.contains('open')
    })""", balances_before)
    check(cancel_invariant == {'same': True, 'banner': '', 'marker': False, 'open': False},
          f'Swap cancel leaves holdings and provider state unchanged: {cancel_invariant}')
    check(not page_errors, f'Swap cancel path has no errors: {page_errors}')
    context.close()

    for tamper in ('amount', 'readonly', 'pay-token', 'receive-token'):
        context, page, page_errors = task3_page(APP.as_uri() + '#swap')
        tampered_swap = page.evaluate("""tamper => {
          const before=JSON.stringify(ensureWalletAdapter().adapter.getBalanceSnapshot({}));
          const input=document.getElementById('pay-amt');
          if(tamper==='amount')input.value='600';
          if(tamper==='readonly')input.removeAttribute('readonly');
          if(tamper==='pay-token'){
            const token=document.getElementById('pay-token'); if(token)token.textContent='DAI ▾';
          }
          if(tamper==='receive-token'){
            const token=document.getElementById('receive-token'); if(token)token.textContent='ETH ▾';
          }
          doSwap(document.getElementById('swap-submit'));
          return {same:before===JSON.stringify(
              ensureWalletAdapter().adapter.getBalanceSnapshot({})),
            open:document.getElementById('review-dialog').classList.contains('open'),
            marker:Boolean(history.state?.loop_review),
            banner:document.getElementById('review-provider-banner').textContent,
            note:document.getElementById('swap-review-note').textContent};
        }""", tamper)
        check(tampered_swap == {
            'same': True, 'open': False, 'marker': False, 'banner': '',
            'note': 'The fixed simulated Privy quote no longer matches this Swap screen.',
        }, f'Swap {tamper} DOM tamper fails closed before F11/handoff: {tampered_swap}')
        check(not page_errors, f'Swap {tamper} tamper has no errors: {page_errors}')
        context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#swap')
    balances_before = page.evaluate(
        "JSON.stringify(ensureWalletAdapter().adapter.getBalanceSnapshot({}))")
    page.click('#swap-submit')
    page.click('#review-continue'); page.wait_for_timeout(120)
    pending = page.evaluate("""before => ({
      same:before===JSON.stringify(ensureWalletAdapter().adapter.getBalanceSnapshot({})),
      open:document.getElementById('review-dialog').classList.contains('open'),
      marker:Boolean(history.state?.loop_review),
      state:document.getElementById('review-provider-banner').dataset.state||'',
      banner:document.getElementById('review-provider-banner').textContent,
      hidden:document.getElementById('review-provider-banner').hidden,
      successNode:Boolean(document.getElementById('success')),
      glyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||''
    })""", balances_before)
    check(pending == {
        'same': True, 'open': False, 'marker': False, 'state': 'provider_pending',
        'banner': 'Simulated Privy handoff pending', 'hidden': False,
        'successNode': False, 'glyph': '',
    }, f'Swap Continue returns to origin then stops at provider pending: {pending}')
    page.go_forward(); page.wait_for_timeout(80)
    replay = page.evaluate("""before => ({
      same:before===JSON.stringify(ensureWalletAdapter().adapter.getBalanceSnapshot({})),
      open:document.getElementById('review-dialog').classList.contains('open'),
      marker:Boolean(history.state?.loop_review),
      banner:document.getElementById('review-provider-banner').textContent
    })""", balances_before)
    check(replay == {'same': True, 'open': False, 'marker': False,
                     'banner': 'Simulated Privy handoff pending'},
          f'consumed Swap replay cannot mutate holdings or reopen review: {replay}')
    check(not page_errors, f'Swap pending/replay paths have no errors: {page_errors}')
    context.close()

    for fixture_id in ('review-swap-stale', 'review-swap-unavailable',
                       'review-swap-no-liquidity'):
        context, page, page_errors = task3_page(APP.as_uri() + '#swap')
        blocked = page.evaluate("""fixtureId => {
          const before=JSON.stringify(ensureWalletAdapter().adapter.getBalanceSnapshot({}));
          openWalletReview(fixtureId,document.getElementById('swap-submit'));
          return {state:document.getElementById('review-dialog').dataset.state,
            refreshHidden:document.getElementById('review-refresh').hidden,
            continueHidden:document.getElementById('review-continue').hidden,
            same:before===JSON.stringify(ensureWalletAdapter().adapter.getBalanceSnapshot({}))};
        }""", fixture_id)
        check(blocked['state'] == 'blocked' and not blocked['refreshHidden'] and
              blocked['continueHidden'] and blocked['same'],
              f'{fixture_id} is blocked/Refresh and leaves holdings unchanged: {blocked}')
        page.click('#review-cancel'); page.wait_for_timeout(60)
        check(not page_errors, f'{fixture_id} blocked review has no errors: {page_errors}')
        context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#swap')
    page.clock.install()
    page.click('#swap-submit')
    page.clock.fast_forward(41050)
    expired_ui = page.evaluate("""() => ({
      now:reviewNow(),state:document.getElementById('review-dialog').dataset.state,
      id:reviewRuntime.openId,refreshHidden:document.getElementById('review-refresh').hidden,
      continueHidden:document.getElementById('review-continue').hidden})""")
    if not expired_ui['refreshHidden']:
        page.click('#review-refresh')
    late_refresh = page.evaluate("""() => {
      const fields=Object.fromEntries([...document.querySelectorAll(
        '#review-fields .review-field')].map(row=>[
          row.querySelector('dt')?.textContent||'',
          row.querySelector('dd')?.childNodes[0]?.textContent||''
        ]));
      return {state:document.getElementById('review-dialog').dataset.state,
        id:reviewRuntime.openId,historyId:history.state?.review_id||'',
        estimated:fields['Estimated output']||'',deadline:fields['Quote deadline']||'',
        oldReplay:reviewRuntime.controller.restore({review_id:'review-swap-fresh',
          live_context:currentReviewLive('review-swap-fresh'),now_ms:reviewNow()}).ok};
    }""")
    check(expired_ui['now'] >= 130000 and expired_ui['state'] == 'blocked' and
          expired_ui['id'] == 'review-swap-fresh' and
          not expired_ui['refreshHidden'] and expired_ui['continueHidden'] and
          late_refresh == {'state': 'ready', 'id': 'review-swap-refresh-late',
            'historyId': 'review-swap-refresh-late', 'estimated': '216500 GLYPH',
            'deadline': '160000', 'oldReplay': False},
          f'actual UI expiry crosses 141000 then exact late immutable Refresh is ready: '
          f'{expired_ui} -> {late_refresh}')
    page.clock.fast_forward(max(0, 160050 - expired_ui['now']))
    second_expiry = page.evaluate("""() => ({now:reviewNow(),
      state:document.getElementById('review-dialog').dataset.state,
      id:reviewRuntime.openId,refreshHidden:document.getElementById('review-refresh').hidden})""")
    if not second_expiry['refreshHidden']:
        page.click('#review-refresh')
    second_refresh = page.evaluate("""() => {
      const fields=Object.fromEntries([...document.querySelectorAll(
        '#review-fields .review-field')].map(row=>[
          row.querySelector('dt')?.textContent||'',
          row.querySelector('dd')?.childNodes[0]?.textContent||''
        ]));
      return {state:document.getElementById('review-dialog').dataset.state,
        id:reviewRuntime.openId,deadline:fields['Quote deadline']||''};
    }""")
    check(second_expiry['now'] >= 160000 and second_expiry['state'] == 'blocked' and
          second_expiry['id'] == 'review-swap-refresh-late' and
          not second_expiry['refreshHidden'] and
          second_refresh == {'state': 'ready', 'id': 'review-swap-refresh-160',
                             'deadline': '190000'},
          f'expired replacement advances to the next exact immutable window: '
          f'{second_expiry} -> {second_refresh}')
    check(not page_errors, f'late Refresh ladder UI has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#swap')
    page.clock.install()
    before_ttl_open = page.evaluate("""() => {
      openWalletReview('review-swap-stale',document.getElementById('swap-submit'));
      return reviewNow();
    }""")
    page.clock.fast_forward(299999)
    before_ttl = page.evaluate("""() => {
      const now=reviewNow(),expected=nextSwapRefreshReviewId(now);
      refreshWalletReview();
      return {now,expected,result:{
        state:document.getElementById('review-dialog').dataset.state,
        id:reviewRuntime.openId,historyId:history.state?.review_id||''}};
    }""")
    check(before_ttl['now'] < before_ttl_open + 300000 and
          bool(before_ttl['expected']) and before_ttl['result'] == {
            'state': 'ready', 'id': before_ttl['expected'],
            'historyId': before_ttl['expected']},
          f'one millisecond before five-minute TTL can select only its exact fresh ID: '
          f'{before_ttl_open} -> {before_ttl}')
    check(not page_errors, f'pre-TTL Refresh UI has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#swap')
    page.clock.install()
    ttl_open = page.evaluate("""() => {
      openWalletReview('review-swap-stale',document.getElementById('swap-submit'));
      return {created:reviewNow(),id:reviewRuntime.openId,
        state:document.getElementById('review-dialog').dataset.state};
    }""")
    page.clock.fast_forward(300010)
    page.click('#review-refresh')
    ttl_blocked = page.evaluate("""() => ({now:reviewNow(),
      state:document.getElementById('review-dialog').dataset.state,
      id:reviewRuntime.openId,historyId:history.state?.review_id||'',
      status:document.getElementById('review-status').textContent,
      refreshHidden:document.getElementById('review-refresh').hidden,
      continueHidden:document.getElementById('review-continue').hidden})""")
    check(ttl_open['id'] == 'review-swap-stale' and ttl_open['state'] == 'blocked' and
          ttl_blocked['now'] >= ttl_open['created'] + 300000 and
          {key: value for key, value in ttl_blocked.items() if key != 'now'} == {
            'state': 'blocked', 'id': 'review-swap-stale',
            'historyId': 'review-swap-stale',
            'status': 'This review session has expired.',
            'refreshHidden': True, 'continueHidden': True},
          f'expired five-minute review session cannot be revived by the ladder: '
          f'{ttl_open} -> {ttl_blocked}')
    check(not page_errors, f'refresh TTL boundary UI has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#swap')
    page.clock.install()
    page.clock.fast_forward(399000)
    final_window = page.evaluate("""() => {
      openWalletReview('review-swap-stale',document.getElementById('swap-submit'));
      return {now:reviewNow(),state:document.getElementById('review-dialog').dataset.state};
    }""")
    page.clock.fast_forward(2000)
    page.click('#review-refresh')
    no_window = page.evaluate("""() => ({now:reviewNow(),
      state:document.getElementById('review-dialog').dataset.state,
      id:reviewRuntime.openId,status:document.getElementById('review-status').textContent,
      continueHidden:document.getElementById('review-continue').hidden,
      marker:Boolean(history.state?.loop_review)})""")
    check(final_window['now'] < 500000 and final_window['state'] == 'blocked' and
          no_window['now'] >= 500000 and
          {key: value for key, value in no_window.items() if key != 'now'} == {
            'state': 'blocked', 'id': 'review-swap-stale',
            'status': 'No fresh immutable quote is available for this review session.',
            'continueHidden': True, 'marker': True},
          f'final refresh boundary stays honestly blocked when the allowlist is exhausted: '
          f'{final_window} -> {no_window}')
    check(not page_errors, f'final Refresh boundary has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#swap')
    route_invariant = page.evaluate("""() => {
      const before=JSON.stringify(ensureWalletAdapter().adapter.getBalanceSnapshot({}));
      document.getElementById('swap-submit').click();
      goTab('wallet');
      return {same:before===JSON.stringify(
          ensureWalletAdapter().adapter.getBalanceSnapshot({})),
        open:document.getElementById('review-dialog').classList.contains('open'),
        marker:Boolean(history.state?.loop_review),hash:location.hash,
        glyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||''};
    }""")
    check(route_invariant == {'same': True, 'open': False, 'marker': False,
                              'hash': '#wallet', 'glyph': ''},
          f'route change consumes Swap review without mutating holdings: {route_invariant}')
    check(not page_errors, f'Swap route-change invariant has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '?demo=wallet-provider-succeeded#wallet')
    query_bypass = page.evaluate("""() => ({
      glyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||'',
      walletClass:ensureWalletAdapter().walletResult?.value?.wallet_class||'',
      scenario:ensureWalletAdapter().scenario,
      history:JSON.stringify(history.state),storage:JSON.stringify({...localStorage,...sessionStorage})
    })""")
    page.reload(); page.wait_for_load_state('domcontentloaded')
    query_bypass['reloadGlyph'] = page.evaluate(
        "document.querySelector('[data-asset=\"GLYPH\"]')?.textContent||''")
    check(query_bypass['glyph'] == '' and query_bypass['reloadGlyph'] == '' and
          query_bypass['walletClass'] == 'privy_embedded' and
          query_bypass['scenario'] == 'normal' and
          'provider_succeeded_demo' not in query_bypass['history'] and
          'provider_succeeded_demo' not in query_bypass['storage'],
          f'completed provider query cannot select or persist a scenario: {query_bypass}')
    check(not page_errors, f'completed query bypass has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#wallet')
    cache_injection = page.evaluate("""() => {
      const forged=LoopWalletProvider.createSimulatedAdapter({
        walletClass:'privy_embedded',scenario:'provider_succeeded_demo'});
      let lexicalInjected=false;
      try{
        walletRuntime.key='privy_embedded:normal:false';
        walletRuntime.adapter=forged;
        walletRuntime.walletResult=forged.getWalletSnapshot();
        walletRuntime.balanceResult=null;
        lexicalInjected=true;
      }catch(_error){}
      globalThis.walletRuntime={key:'privy_embedded:normal:false',adapter:forged,
        walletResult:forged.getWalletSnapshot()};
      renderWalletScreen();
      return {lexicalInjected,glyph:
        document.querySelector('[data-asset="GLYPH"]')?.textContent||'',
        banner:document.getElementById('review-provider-banner').textContent,
        facadeFrozen:typeof walletAuthority==='object'&&Object.isFrozen(walletAuthority),
        facadeKeys:typeof walletAuthority==='object'?Reflect.ownKeys(walletAuthority):[]};
    }""")
    check(cache_injection == {
        'lexicalInjected': False, 'glyph': '', 'banner': '',
        'facadeFrozen': True,
        'facadeKeys': ['snapshot', 'signingDecision'],
    }, f'global/lexical provider cache substitution cannot reveal completed holdings: '
       f'{cache_injection}')
    check(not page_errors, f'provider cache substitution has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '?demo=wallet-watch-only#swap')
    configuration_replaced = page.evaluate("""() => {
      let replaced=false;
      try{walletDemoConfiguration=()=>({walletClass:'privy_embedded',
        scenario:'normal',stale:false});replaced=true}catch(_error){}
      return {replaced,disabled:document.getElementById(
        'completed-provider-fixture').disabled};
    }""")
    page.click('#completed-provider-fixture'); page.wait_for_timeout(80)
    configuration_attack = page.evaluate("""() => ({
      active:[...document.querySelectorAll('.scr.active')].map(node=>node.id),
      banner:document.getElementById('review-provider-banner').textContent,
      state:document.getElementById('review-provider-banner').dataset.state,
      glyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||''})""")
    check(configuration_replaced == {'replaced': True, 'disabled': False} and
          configuration_attack == {
            'active': ['scr-swap'],
            'banner': 'Completed provider fixture is unavailable for watch-only wallets.',
            'state': 'provider_blocked', 'glyph': ''},
          f'rebound global configuration cannot change private watch-only authority: '
          f'{configuration_replaced} -> {configuration_attack}')
    check(not page_errors,
          f'configuration substitution has no errors: {page_errors}')
    context.close()

    query_attacks = {
        'constructor': "globalThis.URLSearchParams=function(){return {get(){return ''}}}",
        'method': "URLSearchParams.prototype.get=function(){return ''}",
        'getter': "Object.defineProperty(URLSearchParams.prototype,'get',{configurable:true,get(){document.documentElement.dataset.queryGetterCalls=String(Number(document.documentElement.dataset.queryGetterCalls||0)+1);return function(){return ''}}})",
        'get own call': "const method=Object.getOwnPropertyDescriptor(URLSearchParams.prototype,'get').value;Object.defineProperty(method,'call',{configurable:true,value:function(){return ''}})",
        'Function call/apply': "Function.prototype.call=function(){return ''};Function.prototype.apply=function(){return ''}",
        'Reflect.apply': "Reflect.apply=function(){return ''}",
    }
    for attack_name, source in query_attacks.items():
        context, page, page_errors = task3_page(
            APP.as_uri() + '?demo=wallet-watch-only#swap')
        query_replaced = page.evaluate("""source => {
          Function(source)();
          return {disabled:document.getElementById(
            'completed-provider-fixture').disabled};
        }""", source)
        page.click('#completed-provider-fixture'); page.wait_for_timeout(80)
        query_attack = page.evaluate("""() => ({
          active:[...document.querySelectorAll('.scr.active')].map(node=>node.id),
          banner:document.getElementById('review-provider-banner').textContent,
          state:document.getElementById('review-provider-banner').dataset.state,
          glyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||'',
          getterCalls:Number(document.documentElement.dataset.queryGetterCalls||0)})""")
        check(query_replaced == {'disabled': False} and
              query_attack == {
                'active': ['scr-swap'],
                'banner': 'Completed provider fixture is unavailable for watch-only wallets.',
                'state': 'provider_blocked', 'glyph': '', 'getterCalls': 0},
              f'replaced URLSearchParams {attack_name} cannot change private watch-only '
              f'authority: {query_replaced} -> {query_attack}')
        check(not page_errors,
              f'URLSearchParams {attack_name} substitution has no errors: {page_errors}')
        context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#swap')
    onboarding_replaced = page.evaluate("""() => {
      setOnboardingFlag('watchOnly',true);
      let replaced=false;
      try{onboardingFlag=()=>false;replaced=true}catch(_error){}
      return {replaced,disabled:document.getElementById(
        'completed-provider-fixture').disabled};
    }""")
    page.click('#completed-provider-fixture'); page.wait_for_timeout(80)
    onboarding_attack = page.evaluate("""() => ({
      active:[...document.querySelectorAll('.scr.active')].map(node=>node.id),
      banner:document.getElementById('review-provider-banner').textContent,
      state:document.getElementById('review-provider-banner').dataset.state,
      glyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||''})""")
    check(onboarding_replaced == {'replaced': True, 'disabled': False} and
          onboarding_attack == {
            'active': ['scr-swap'],
            'banner': 'Completed provider fixture is unavailable for watch-only wallets.',
            'state': 'provider_blocked', 'glyph': ''},
          f'rebound onboardingFlag cannot change captured watch-only authority: '
          f'{onboarding_replaced} -> {onboarding_attack}')
    check(not page_errors,
          f'onboardingFlag substitution has no errors: {page_errors}')
    context.close()

    completed_mutations = {
        'label': "control.textContent='Changed completed fixture'",
        'reparent': "document.getElementById('phone').append(control)",
        'clone': "control.replaceWith(control.cloneNode(true))",
        'id': "control.id='completed-provider-fixture-mutated'",
        'class': "control.className='btn btn-primary'",
        'type': "control.type='submit'",
        'aria': "control.setAttribute('aria-label','Changed fixture')",
        'data': "control.setAttribute('data-provider-fixture','changed')",
        'signing': "control.setAttribute('data-requires-signing','')",
    }
    for mutation, source in completed_mutations.items():
        context, page, page_errors = task3_page(APP.as_uri() + '#swap')
        selector = page.evaluate("""source => {
          const control=document.getElementById('completed-provider-fixture');
          Function('control',source)(control);
          const live=document.getElementById('completed-provider-fixture')||
            document.getElementById('completed-provider-fixture-mutated');
          return '#'+live.id;
        }""", source)
        page.click(selector, force=True); page.wait_for_timeout(80)
        mutation_result = page.evaluate("""() => ({
          active:[...document.querySelectorAll('.scr.active')].map(node=>node.id),
          succeeded:document.getElementById('review-provider-banner').textContent===
            'Simulated provider succeeded',
          glyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||'',
          scenario:ensureWalletAdapter().scenario})""")
        check(mutation_result == {'active': ['scr-swap'], 'succeeded': False,
                                  'glyph': '', 'scenario': 'normal'},
              f'completed fixture rejects trusted {mutation} semantic mutation: '
              f'{mutation_result}')
        check(not page_errors,
              f'completed {mutation} mutation has no errors: {page_errors}')
        context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#swap')
    synthetic_completed = page.evaluate("""() => {
      const control=document.getElementById('completed-provider-fixture');
      const before=JSON.stringify(ensureWalletAdapter().adapter.getBalanceSnapshot({}));
      const href=location.href,state=JSON.stringify(history.state),
        storage=JSON.stringify({...localStorage,...sessionStorage});
      let threw=false;
      try{if(typeof showCompletedProviderFixture==='function')showCompletedProviderFixture(control)}
      catch(_error){threw=true}
      control.click();
      control.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      return {threw,globalType:typeof showCompletedProviderFixture,
        same:before===JSON.stringify(ensureWalletAdapter().adapter.getBalanceSnapshot({})),
        hrefSame:href===location.href,stateSame:state===JSON.stringify(history.state),
        storageSame:storage===JSON.stringify({...localStorage,...sessionStorage}),
        open:document.getElementById('review-dialog').classList.contains('open'),
        banner:document.getElementById('review-provider-banner').textContent,
        glyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||''};
    }""")
    check(synthetic_completed == {
        'threw': False, 'globalType': 'undefined', 'same': True, 'hrefSame': True,
        'stateSame': True, 'storageSame': True, 'open': False, 'banner': '', 'glyph': '',
    }, f'completed fixture rejects direct/global/programmatic/synthetic selection: '
       f'{synthetic_completed}')
    check(not page_errors, f'completed synthetic rejection has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(APP.as_uri() + '#swap')
    before_completed = page.evaluate("""() => ({
      glyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||'',
      total:ensureWalletAdapter().adapter.getBalanceSnapshot({}).value.loop_total.value,
      href:location.href,storage:JSON.stringify({...localStorage,...sessionStorage})
    })""")
    page.click('#completed-provider-fixture'); page.wait_for_timeout(100)
    completed = page.evaluate("""() => ({
      label:document.getElementById('completed-provider-fixture').textContent,
      event:document.getElementById('review-provider-banner').textContent,
      state:document.getElementById('review-provider-banner').dataset.state,
      demo:new URLSearchParams(location.search).get('demo')||'',
      historyScenario:/provider_succeeded_demo|wallet-provider-succeeded/.test(
        JSON.stringify(history.state)),
      storageScenario:/provider_succeeded_demo|wallet-provider-succeeded/.test(
        JSON.stringify({...localStorage,...sessionStorage})),
      active:[...document.querySelectorAll('.scr.active')].map(node=>node.id),
      glyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||'',
      total:document.getElementById('wallet-total-value').textContent,
      disclosure:document.getElementById('wallet-total-disclosure').textContent
    })""")
    check(before_completed['glyph'] == '' and
          completed == {
            'label': 'Show completed provider fixture',
            'event': 'Simulated provider succeeded', 'state': 'provider_succeeded',
            'demo': '', 'historyScenario': False, 'storageScenario': False,
            'active': ['scr-wallet'],
            'glyph': 'GGlyphBase125 GLYPHValue unavailable',
            'total': before_completed['total'] + ' USD',
            'disclosure': 'Excludes 1 asset without a provider USD value',
          }, f'only labelled completed-provider fixture reveals non-fiat GLYPH: '
             f'{before_completed} -> {completed}')
    page.reload(); page.wait_for_load_state('domcontentloaded')
    reload_completed = page.evaluate("""() => ({
      scenario:ensureWalletAdapter().scenario,
      glyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||'',
      banner:document.getElementById('review-provider-banner').textContent})""")
    check(reload_completed == {'scenario': 'normal', 'glyph': '', 'banner': ''},
          f'completed fixture capability is closure-ephemeral across reload: {reload_completed}')
    check(not page_errors, f'completed provider fixture has no errors: {page_errors}')
    context.close()

    print('\n== Task 7 safety and runtime sink coverage ==')
    context, page, page_errors = task3_page(APP.as_uri() + '#wallet')
    hostile_toast = '<img id="task7-toast-injection" src=x onerror="globalThis.__task7ToastExecuted=true">'
    toast_result = page.evaluate("""hostile => {
      globalThis.__task7ToastExecuted=false;
      toast(hostile);
      const node=document.getElementById('toast');
      return {
        text:node.textContent,
        childElements:node.children.length,
        injected:Boolean(document.getElementById('task7-toast-injection')),
        executed:globalThis.__task7ToastExecuted,
      };
    }""", hostile_toast)
    page.wait_for_timeout(40)
    toast_result['executedAfterEventLoop'] = page.evaluate(
        'globalThis.__task7ToastExecuted')
    check(toast_result == {
        'text': hostile_toast, 'childElements': 0, 'injected': False,
        'executed': False, 'executedAfterEventLoop': False,
    }, f'hostile toast remains literal text with no executable DOM: {toast_result}')
    check(not page_errors, f'hostile toast has no page/console errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '#receive?asset=ETH&chain=ethereum')
    qr_replacement = page.evaluate("""() => {
      globalThis.__task7QrExecuted=false;
      globalThis.qrcode=()=>({
        addData(){},make(){},
        createSvgTag(){return '<svg xmlns="http://www.w3.org/2000/svg" '
          +'onload="globalThis.__task7QrExecuted=true"><script>'
          +'globalThis.__task7QrExecuted=true</'+'script></svg>'}
      });
      routeWalletPair('receive','ETH','base',{replace:true});
      const host=document.getElementById('receive-qr');
      const visual=host.querySelector('svg');
      return {executed:globalThis.__task7QrExecuted,
        scripts:host.querySelectorAll('script').length,
        eventAttributes:[...host.querySelectorAll('*')].flatMap(node=>
          [...node.attributes].filter(attr=>attr.name.startsWith('on')).map(attr=>attr.name)),
        payload:visual?.dataset.qrPayload||'',
        address:document.getElementById('receive-address').value,
        childCount:host.children.length};
    }""")
    page.wait_for_timeout(40)
    qr_replacement['executedAfterEventLoop'] = page.evaluate(
        'globalThis.__task7QrExecuted')
    check(qr_replacement == {
        'executed': False, 'scripts': 0, 'eventAttributes': [],
        'payload': '0x7E57D0041C5B5e9B6F3A9E64A2C8D1F0B4C6A821',
        'address': '0x7E57D0041C5B5e9B6F3A9E64A2C8D1F0B4C6A821',
        'childCount': 1, 'executedAfterEventLoop': False,
    }, f'hostile global QR replacement cannot alter/execute pinned local QR: '
       f'{qr_replacement}')
    check(not page_errors,
          f'hostile global QR replacement has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '#receive?asset=ETH&chain=base')
    qr_factory_failures = page.evaluate("""() => {
      const address=document.getElementById('receive-address').value;
      const alternative=`Receive address ${address} on Base`;
      return {
        missingCapture:capturePinnedQrFactory(undefined)===null,
        invalidCapture:capturePinnedQrFactory(()=>({addData(){},make(){}}))===null,
        missingRender:createPinnedReceiveQrSvg(null,address,alternative)===null,
        invalidRender:createPinnedReceiveQrSvg(
          ()=>({addData(){},make(){},createSvgTag(){return '<svg><script/></svg>'}}),
          address,alternative)===null,
        address,
        warning:document.getElementById('receive-warning').textContent,
      };
    }""")
    check(qr_factory_failures == {
        'missingCapture': True, 'invalidCapture': True,
        'missingRender': True, 'invalidRender': True,
        'address': '0x7E57D0041C5B5e9B6F3A9E64A2C8D1F0B4C6A821',
        'warning': ('Only send ETH on Base to this address. Using another asset or '
                    'network may result in permanent loss.'),
    }, f'missing/invalid QR factory fails closed while provider address remains exact: '
       f'{qr_factory_failures}')
    check(not page_errors,
          f'missing/invalid QR factory helpers have no errors: {page_errors}')
    context.close()

    print('\n== Task 7 F1 complete rendered-state matrix ==')
    f1_expectations = {
        'normal': ('privy_embedded', 'privy_flutter', '2920.50 USD', '', 3),
        'wallet-loading': ('privy_embedded', 'privy_flutter',
                           'Value unavailable', 'Loading provider balances', 0),
        'wallet-empty': ('privy_embedded', 'privy_flutter',
                         'Value unavailable', 'No supported assets reported by Privy', 0),
        'wallet-partial': ('privy_embedded', 'privy_flutter',
                           '2920.50 USD', 'Some provider data is unavailable', 3),
        'wallet-stale': ('privy_embedded', 'privy_flutter',
                         '1280.00 USD', 'Provider values are stale', 1),
        'wallet-external-gap': ('connected_external', 'external_wallet',
                                'Value unavailable',
                                'Balance provider not available for this wallet.', 0),
        'wallet-watch-only': ('watch_only', 'prototype_fixture',
                              'Value unavailable',
                              'Watch-only — no signing actions are available', 0),
    }
    for demo, expected in f1_expectations.items():
        query = '' if demo == 'normal' else f'?demo={demo}'
        context, page, page_errors = task3_page(APP.as_uri() + query + '#wallet')
        rendered = page.evaluate("""() => ({
          walletClass:document.getElementById('wallet-content').dataset.walletClass,
          provider:document.getElementById('wallet-content').dataset.provider,
          total:document.getElementById('wallet-total-value').textContent,
          state:document.querySelector('.wallet-state-copy')?.textContent||'',
          assets:document.querySelectorAll('#wallet-assets [data-asset]').length,
          falseZero:/^0(?:\\.0+)?(?: USD)?$/.test(
            document.getElementById('wallet-total-value').textContent.trim()),
          disclosure:document.getElementById('wallet-total-disclosure').textContent,
        })""")
        expected_rendered = {
            'walletClass': expected[0], 'provider': expected[1],
            'total': expected[2], 'state': expected[3], 'assets': expected[4],
            'falseZero': False,
            'disclosure': ('Provider balance total unavailable'
                           if demo in ('wallet-external-gap', 'wallet-watch-only') else ''),
        }
        check(rendered == expected_rendered,
              f'F1 exact {demo} class/provider/value/state matrix: {rendered}')
        check(not page_errors, f'F1 {demo} matrix has no errors: {page_errors}')
        context.close()

    print('\n== Task 7 F2 history/error/pagination matrix ==')
    context, page, page_errors = task3_page(
        APP.as_uri() + '#asset?asset=ETH&chain=base')
    f2_matrix = page.evaluate("""() => {
      const normalize=LoopWalletProvider.normalizeTransactionPage;
      const make=(id,status,details,hash=null)=>({privy_transaction_id:id,
        transaction_hash:hash,status,created_at:10,details});
      const detail=(type,extra={})=>({type,chain:'base',asset:'eth',
        sender:'0xsender',recipient:'0xrecipient',raw_value:'1000000000000000000',
        raw_value_decimals:18,...extra});
      const valid=normalize({transactions:[
        make('incoming-confirmed','confirmed',detail('transfer_received')),
        make('outgoing-submitted','submitted',detail('transfer_sent')),
        make('other-failed','failed',detail('contract_call')),
        make('nullable-details','confirmed',null),
      ],next_cursor:'opaque:cursor/+/=safe'});
      renderAssetSnapshots(null,valid,false);
      const rows=[...document.querySelectorAll('#asset-history [data-transaction-id]')]
        .map(row=>({id:row.dataset.transactionId,
          direction:row.querySelector('.transaction-direction').textContent,
          status:row.querySelector('.transaction-status').textContent}));
      const cursorSurface=location.href+JSON.stringify(history.state)+
        JSON.stringify({...localStorage,...sessionStorage});
      const malformed=normalize({transactions:[make('bad','confirmed',{
        type:'transfer_sent',chain:'base',asset:'eth',sender:'x',recipient:'y',
        raw_value:'1.5',raw_value_decimals:18})],next_cursor:null});
      renderAssetSnapshots(null,malformed,false);
      const malformedCopy=document.getElementById('asset-history-status').textContent;
      const empty=normalize({transactions:[],next_cursor:null});
      renderAssetSnapshots(null,empty,false);
      return {rows,cursorHidden:!cursorSurface.includes('opaque:cursor/+/=safe'),
        malformed:{ok:malformed.ok,copy:malformedCopy},
        empty:{status:empty.value.status,
          copy:document.getElementById('asset-history-status').textContent},
        reviewDisabled:document.getElementById('asset-review-transfer').disabled};
    }""")
    check(f2_matrix == {
        'rows': [
            {'id': 'incoming-confirmed', 'direction': 'Incoming', 'status': 'confirmed'},
            {'id': 'outgoing-submitted', 'direction': 'Outgoing', 'status': 'submitted'},
            {'id': 'other-failed', 'direction': 'Wallet activity', 'status': 'failed'},
            {'id': 'nullable-details', 'direction': 'Transaction details pending',
             'status': 'confirmed'},
        ],
        'cursorHidden': True,
        'malformed': {'ok': False,
                      'copy': 'The wallet provider returned data LOOP could not safely use.'},
        'empty': {'status': 'empty',
                  'copy': 'No transaction history reported by the provider.'},
        'reviewDisabled': False,
    }, f'F2 all directions/statuses/nullable/malformed/opaque/empty matrix: {f2_matrix}')
    check(not page_errors, f'F2 complete matrix has no errors: {page_errors}')
    context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '?demo=wallet-loading#asset?asset=ETH&chain=base')
    f2_loading = page.evaluate("""() => ({
      summary:[...document.querySelectorAll('#asset-summary .asset-summary-card > *')]
        .map(node=>node.textContent).join('\\n'),
      holdings:document.getElementById('asset-holdings').innerText,
      historyStatus:document.getElementById('asset-history-status').textContent,
      rows:document.querySelectorAll('#asset-history [data-transaction-id]').length,
      pagination:document.getElementById('asset-pagination').children.length,
      reviewDisabled:document.getElementById('asset-review-transfer').disabled,
      actionNote:document.getElementById('asset-action-note').textContent,
      providerFixture:document.getElementById('asset-content').textContent.includes(
        'fixture-tx-1'),
      providerClaim:document.getElementById('asset-history-status').textContent===
        'Provider transaction history',
      falseBalanceClaims:[
        'Provider quantity unavailable','No quantity reported for the selected network',
        'No supported holdings reported for this asset'
      ].filter(copy=>document.getElementById('asset-content').textContent.includes(copy)),
      falseZero:/^0(?:\\.0+)?(?: USD)?$/m.test(
        document.getElementById('asset-summary').innerText),
      balanceStatus:ensureWalletAdapter().adapter.getBalanceSnapshot({
        asset_id:'ETH',chain_id:'base'}).value?.status||'',
      providerStatus:ensureWalletAdapter().adapter.getTransactionHistorySnapshot({
        asset_id:'ETH',chain_id:'base'}).value?.status||'',
    })""")
    check(f2_loading == {
        'summary': ('ETH\nLoading provider quantity…\nLoading provider value…\n'
                    'Waiting for Privy balance data.'),
        'holdings': 'Loading supported holdings from the provider…',
        'historyStatus': 'Loading provider transaction history…',
        'rows': 0, 'pagination': 0, 'reviewDisabled': True,
        'actionNote': 'Provider data is still loading. Transfer review is unavailable.',
        'providerFixture': False, 'providerClaim': False,
        'falseBalanceClaims': [], 'falseZero': False,
        'balanceStatus': 'loading', 'providerStatus': 'loading',
    }, f'F2 real loading scenario is honest and non-executable: {f2_loading}')
    check(not page_errors, f'F2 real loading scenario has no errors: {page_errors}')
    context.close()

    for demo, expected_copy in (
        ('wallet-external-gap',
             'Transaction history is not available for this wallet.'),
            ('wallet-watch-only', 'Watch-only wallets cannot authorize signing requests.')):
        context, page, page_errors = task3_page(
            APP.as_uri() + f'?demo={demo}#asset?asset=ETH&chain=base')
        content = page.locator('#asset-content').inner_text()
        check(expected_copy in content and page.locator(
            '#asset-review-transfer').is_disabled(),
            f'F2 {demo} provider gap/disabled review exact copy')
        check(not page_errors, f'F2 {demo} has no errors: {page_errors}')
        context.close()

    print('\n== Task 7 F6 compatible pair and clipboard matrix ==')
    receive_pairs = (
        ('ETH', 'ethereum'), ('ETH', 'base'), ('ETH', 'arbitrum'),
        ('USDC', 'ethereum'), ('USDC', 'base'), ('USDC', 'arbitrum'),
        ('SOL', 'solana'), ('GLYPH', 'base'),
    )
    chain_labels = {'ethereum': 'Ethereum', 'base': 'Base',
                    'arbitrum': 'Arbitrum', 'solana': 'Solana'}
    for asset, chain in receive_pairs:
        context, page, page_errors = task3_page(
            APP.as_uri() + f'#receive?asset={asset}&chain={chain}')
        pair = page.evaluate("""() => ({
          asset:document.getElementById('receive-asset').value,
          chain:document.getElementById('receive-chain').value,
          address:document.getElementById('receive-address').value,
          payload:document.querySelector('#receive-qr svg').dataset.qrPayload,
          alternative:document.querySelector('#receive-qr svg').getAttribute('aria-label'),
          warning:document.getElementById('receive-warning').textContent,
          wrap:getComputedStyle(document.getElementById('receive-address')).overflowWrap,
        })""")
        expected_warning = (f'Only send {asset} on {chain_labels[chain]} to this address. '
                            'Using another asset or network may result in permanent loss.')
        check(pair['asset'] == asset and pair['chain'] == chain and
              pair['address'] == pair['payload'] and
              pair['address'] in pair['alternative'] and
              chain_labels[chain] in pair['alternative'] and
              pair['warning'] == expected_warning and pair['wrap'] == 'anywhere',
              f'F6 exact compatible {asset}/{chain} address/QR/warning/wrap: {pair}')
        check(not page_errors, f'F6 {asset}/{chain} has no errors: {page_errors}')
        context.close()

    context, page, page_errors = task3_page(
        APP.as_uri() + '#receive?asset=SOL&chain=solana', clipboard='unavailable')
    page.click('#receive-copy'); page.wait_for_timeout(20)
    unavailable = page.evaluate("""() => ({
      copy:document.getElementById('receive-copy-status').textContent,
      focused:document.activeElement===document.getElementById('receive-address'),
      selected:document.getElementById('receive-address').selectionStart===0&&
        document.getElementById('receive-address').selectionEnd===
        document.getElementById('receive-address').value.length,
    })""")
    check(unavailable == {'copy': 'Copy unavailable — select the address manually.',
                          'focused': True, 'selected': True},
          f'F6 unavailable clipboard exact manual fallback: {unavailable}')
    check(not page_errors, f'F6 unavailable clipboard has no errors: {page_errors}')
    context.close()

    for demo in ('wallet-watch-only', 'wallet-external-gap'):
        context, page, page_errors = task3_page(
            APP.as_uri() + f'?demo={demo}#receive?asset=ETH&chain=base')
        state = page.evaluate("""() => ({
          address:document.getElementById('receive-address').value,
          qr:document.querySelector('#receive-qr svg')?.dataset.qrPayload||'',
          copyDisabled:document.getElementById('receive-copy').disabled,
          warning:document.getElementById('receive-warning').textContent,
        })""")
        check(bool(state['address']) and state['qr'] == state['address'] and
              not state['copyDisabled'] and state['warning'].startswith('Only send ETH on Base'),
              f'F6 {demo} EVM receive remains exact and available: {state}')
        check(not page_errors, f'F6 {demo} receive has no errors: {page_errors}')
        context.close()

    print('\n== Task 7 wallet layout/accessibility matrix ==')
    for viewport in ({'width': 375, 'height': 667},
                     {'width': 1440, 'height': 900}):
        for route in ('wallet', 'asset?asset=ETH&chain=base',
                      'receive?asset=SOL&chain=solana'):
            context, page, page_errors = task3_page(
                APP.as_uri() + '#' + route, viewport=viewport)
            layout = page.evaluate("""() => {
              const screen=document.querySelector('.scr.active:not([inert])');
              const controls=[...screen.querySelectorAll(
                'button:not([hidden]),select:not([hidden]),textarea:not([hidden])')]
                .filter(node=>getComputedStyle(node).display!=='none');
              const undersized=controls.map(node=>{const r=node.getBoundingClientRect();
                return {id:node.id||node.className,width:r.width,height:r.height}})
                .filter(item=>item.width<44||item.height<44);
              const focused=controls.find(node=>!node.disabled);
              focused?.focus();
              return {documentOverflow:document.documentElement.scrollWidth>innerWidth,
                screenOverflow:screen.scrollWidth>screen.clientWidth,
                undersized,focusOutline:focused?getComputedStyle(focused).outlineStyle:'none',
                inactiveBad:[...document.querySelectorAll('.scr:not(.active)')]
                  .filter(node=>!node.hasAttribute('inert')||
                    node.getAttribute('aria-hidden')!=='true').map(node=>node.id)};
            }""")
            check(not layout['documentOverflow'] and not layout['screenOverflow'] and
                  not layout['undersized'] and layout['focusOutline'] != 'none' and
                  not layout['inactiveBad'],
                  f'{viewport["width"]}×{viewport["height"]} #{route} '
                  f'overflow/44px/focus/inert matrix: {layout}')
            check(not page_errors,
                  f'layout {viewport} #{route} has no errors: {page_errors}')
            context.close()

    reduced_context = browser.new_context(
        viewport={'width': 375, 'height': 667}, reduced_motion='reduce')
    reduced_page = reduced_context.new_page()
    reduced_errors = []
    reduced_page.on('console', lambda message:
                    reduced_errors.append(message.text)
                    if message.type == 'error' else None)
    reduced_page.on('pageerror', lambda error:
                    reduced_errors.append(f'pageerror: {error}'))
    reduced_page.goto(APP.as_uri() + '#asset?asset=ETH&chain=base')
    reduced_page.wait_for_load_state('domcontentloaded')
    reduced_page.click('#asset-review-transfer')
    reduced_motion = reduced_page.evaluate("""() => {
      const nodes=[document.getElementById('scr-asset'),
        document.getElementById('asset-review-transfer'),
        document.getElementById('review-dialog')];
      return nodes.map(node=>({id:node.id,
        animation:getComputedStyle(node).animationDuration,
        transition:getComputedStyle(node).transitionDuration,
        scrollBehavior:getComputedStyle(node).scrollBehavior}));
    }""")
    zero_times = {'0s', '0ms'}
    check(all(all(part.strip() in zero_times
                  for value in (item['animation'], item['transition'])
                  for part in value.split(',')) and item['scrollBehavior'] == 'auto'
              for item in reduced_motion),
          f'375×667 reduced-motion disables wallet/F11 motion: {reduced_motion}')
    check(not reduced_errors,
          f'wallet/F11 reduced-motion has no errors: {reduced_errors}')
    reduced_context.close()
    browser.close()

task3_source = '\n'.join((SRC / relative).read_text() for relative in (
    'app.js', 'wallet-transfer.js', 'screens/wallet.html', 'screens/asset.html',
    'screens/send.html', 'screens/send-to.html', 'screens/send-confirm.html',
    'screens/receive.html', 'screens/tx-result.html'))
check('navigator.clipboard.read' not in task3_source,
      'Task 3 source never reads the clipboard')
check('navigator.clipboard.writeText' in task3_source,
      'Task 3 source uses navigator.clipboard.writeText')
check(not re.search(r'https?://[^\s\'\"]*(?:qr|chart|price|explorer)', task3_source, re.I),
      'Task 3 source has no remote QR/chart/price/explorer service')
style_source = (SRC / 'style.css').read_text()
check(':focus-visible' in style_source and
      '@media (prefers-reduced-motion: reduce)' in style_source,
      'Task 3 CSS includes focus-visible and reduced-motion support')

app_source = (SRC / 'app.js').read_text()
toast_source_match = re.search(
    r'function toast\(msg\)\{(?P<body>.*?)\n\}', app_source, re.S)
toast_source = toast_source_match.group('body') if toast_source_match else ''
check(bool(toast_source_match) and '.innerHTML' not in toast_source and
      '.textContent' in toast_source,
      'Task 7 touched toast sink uses textContent and never innerHTML')

print('\n== Task 7 scoped source/security summary ==')
provider_source = (SRC / 'wallet-provider.js').read_text()
review_source = (SRC / 'wallet-review.js').read_text()
transfer_source = (SRC / 'wallet-transfer.js').read_text()
scanner_adversarial = ('const endpoint="https://wallet.example/v1"; '
                       'fetch(endpoint);')
scanner_comment_only = ('// fetch("https://comment.example")\n'
                        '/* sessionStorage.setItem("x","y") */ const value=1;')
scanner_template = ('const message=`https://wallet.example/${fetch(endpoint)}`;')
scanner_dynamic_script = 'const node=document.createElement("script");'


def javascript_lexical_surfaces(source):
    """Return executable-code and literal-string surfaces without JS comments.

    The small lexer preserves line positions, handles quoted/template strings and
    scans `${...}` template expressions as executable code. It intentionally does
    not attempt semantic parsing; security patterns operate only on these surfaces.
    """
    code = [' '] * len(source)
    strings = []

    def scan_quoted(index, quote):
        index += 1
        literal = []
        while index < len(source):
            char = source[index]
            if char == '\\' and index + 1 < len(source):
                literal.extend((char, source[index + 1]))
                index += 2
                continue
            if char == quote:
                strings.append(''.join(literal))
                return index + 1
            literal.append(char)
            index += 1
        strings.append(''.join(literal))
        return index

    def scan_template(index):
        index += 1
        literal = []
        while index < len(source):
            char = source[index]
            if char == '\\' and index + 1 < len(source):
                literal.extend((char, source[index + 1]))
                index += 2
                continue
            if char == '`':
                strings.append(''.join(literal))
                return index + 1
            if char == '$' and index + 1 < len(source) and source[index + 1] == '{':
                strings.append(''.join(literal))
                literal = []
                code[index] = '$'
                code[index + 1] = '{'
                index = scan_code(index + 2, True)
                continue
            literal.append(char)
            index += 1
        strings.append(''.join(literal))
        return index

    def scan_code(index, stop_at_template_brace=False):
        brace_depth = 0
        while index < len(source):
            char = source[index]
            following = source[index + 1] if index + 1 < len(source) else ''
            if char == '/' and following == '/':
                index += 2
                while index < len(source) and source[index] not in '\r\n':
                    index += 1
                continue
            if char == '/' and following == '*':
                index += 2
                while index < len(source):
                    if source[index] in '\r\n':
                        code[index] = source[index]
                    if source[index:index + 2] == '*/':
                        index += 2
                        break
                    index += 1
                continue
            if char in ("'", '"'):
                index = scan_quoted(index, char)
                continue
            if char == '`':
                index = scan_template(index)
                continue
            if stop_at_template_brace and char == '}':
                if brace_depth == 0:
                    code[index] = char
                    return index + 1
                brace_depth -= 1
            elif stop_at_template_brace and char == '{':
                brace_depth += 1
            code[index] = char
            index += 1
        return index

    scan_code(0)
    return ''.join(code), strings


def javascript_comment_stripped_source(source):
    """Remove JS comments while retaining quoted/template text and expressions."""
    output = [' '] * len(source)

    def scan_quoted(index, quote):
        output[index] = source[index]
        index += 1
        while index < len(source):
            output[index] = source[index]
            if source[index] == '\\' and index + 1 < len(source):
                output[index + 1] = source[index + 1]
                index += 2
                continue
            if source[index] == quote:
                return index + 1
            index += 1
        return index

    def scan_template(index):
        output[index] = source[index]
        index += 1
        while index < len(source):
            char = source[index]
            output[index] = char
            if char == '\\' and index + 1 < len(source):
                output[index + 1] = source[index + 1]
                index += 2
                continue
            if char == '`':
                return index + 1
            if char == '$' and index + 1 < len(source) and source[index + 1] == '{':
                output[index + 1] = '{'
                index = scan_code(index + 2, True)
                continue
            index += 1
        return index

    def scan_code(index, stop_at_template_brace=False):
        brace_depth = 0
        while index < len(source):
            char = source[index]
            following = source[index + 1] if index + 1 < len(source) else ''
            if char == '/' and following == '/':
                index += 2
                while index < len(source) and source[index] not in '\r\n':
                    index += 1
                continue
            if char == '/' and following == '*':
                index += 2
                while index < len(source):
                    if source[index] in '\r\n':
                        output[index] = source[index]
                    if source[index:index + 2] == '*/':
                        index += 2
                        break
                    index += 1
                continue
            if char in ("'", '"'):
                index = scan_quoted(index, char)
                continue
            if char == '`':
                index = scan_template(index)
                continue
            if stop_at_template_brace and char == '}':
                output[index] = char
                if brace_depth == 0:
                    return index + 1
                brace_depth -= 1
            elif stop_at_template_brace and char == '{':
                brace_depth += 1
            output[index] = char
            index += 1
        return index

    scan_code(0)
    return ''.join(output)


def javascript_call_model_surface(source):
    """Normalize computed/optional members and simple const/let aliases."""
    normalized = javascript_comment_stripped_source(source)
    concat = re.compile(
        r'(?P<q1>[\'\"])(?P<a>[^\'\"\\]*)(?P=q1)\s*\+\s*'
        r'(?P<q2>[\'\"])(?P<b>[^\'\"\\]*)(?P=q2)')
    while True:
        folded, count = concat.subn(
            lambda match: json.dumps(match.group('a') + match.group('b')),
            normalized)
        normalized = folded
        if count == 0:
            break
    computed = re.compile(
        r'(?P<base>\b[A-Za-z_$][\w$]*\b)'
        r'\s*(?:\?\.)?\[\s*(?P<quote>[\'\"])(?P<name>[A-Za-z_$][\w$]*)'
        r'(?P=quote)\s*\]')
    while True:
        folded, count = computed.subn(
            lambda match: match.group('base') + '.' + match.group('name'),
            normalized)
        normalized = folded
        if count == 0:
            break
    normalized = re.sub(r'\?\.\s*(?=\()', '', normalized)
    normalized = re.sub(r'\b([A-Za-z_$][\w$]*)\s*\?\.', r'\1.', normalized)

    # Resolve only simple lexical aliases whose RHS is a known global/member or an
    # already-resolved alias.  The scanner intentionally does not execute source.
    roots = {'globalThis', 'window', 'self', 'history', 'document', 'Number',
             'navigator', 'sessionStorage', 'localStorage', 'indexedDB'}
    aliases = {}
    declaration = re.compile(
        r'\b(?:const|let)\s+(?P<alias>[A-Za-z_$][\w$]*)\s*=\s*'
        r'(?P<value>[A-Za-z_$][\w$]*(?:[ \t]*\.[ \t]*'
        r'[A-Za-z_$][\w$]*)*)(?=[ \t]*(?:;|\r?\n|$))')
    for _pass in range(8):
        code, _strings = javascript_lexical_surfaces(normalized)
        changed = False
        for match in declaration.finditer(code):
            alias = match.group('alias')
            value = re.sub(r'\s+', '', normalized[match.start('value'):
                                                  match.end('value')])
            base, separator, suffix = value.partition('.')
            if base in aliases:
                value = aliases[base] + (separator + suffix if separator else '')
                base = value.partition('.')[0]
            if base not in roots or aliases.get(alias) == value:
                continue
            aliases[alias] = value
            changed = True
        if not changed:
            break
    # An alias binding is provenance for its eventual use, not a second API
    # access.  Mask its RHS before materializing each indirect call/member use.
    code, _strings = javascript_lexical_surfaces(normalized)
    binding_ranges = []
    for match in declaration.finditer(code):
        if match.group('alias') in aliases:
            binding_ranges.append((match.start('value'), match.end('value')))
    if binding_ranges:
        characters = list(normalized)
        for start, end in binding_ranges:
            characters[start:end] = ' ' * (end - start)
        normalized = ''.join(characters)
    for alias in sorted(aliases, key=len, reverse=True):
        target = aliases[alias]
        normalized = re.sub(
            r'\b' + re.escape(alias) + r'\b(?=\s*(?:\.|\())',
            target, normalized)
    return normalized


AST_SCANNER = ROOT / '_tmp/js_ast_call_model.js'
ACORN_VENDOR = ROOT / '_tmp/vendor/acorn-8.15.0/acorn.js'
ACORN_LICENSE = ROOT / '_tmp/vendor/acorn-8.15.0/LICENSE'
AST_SCANNER_SHA256 = \
    '2854f7865b63218249ac622e70339a8a2450c253400db30c53c50a032c9c0624'
ACORN_SHA256 = 'fdb08546776ec6228b03e8d02b40d4ab3255bae5f401adba7ff5dad927ac5c9c'
ACORN_LICENSE_SHA256 = \
    '76a876cf886ff9be2a8b5e2e86514fed06223c8c9f0c1e9ee9606e93841e00b7'
_ast_scanner_process = None
_ast_scanner_cache = {}


def close_ast_scanner():
    global _ast_scanner_process
    if _ast_scanner_process is not None:
        _ast_scanner_process.terminate()
        try:
            _ast_scanner_process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            _ast_scanner_process.kill()
        _ast_scanner_process = None


atexit.register(close_ast_scanner)


def require_ast_scanner_integrity(scanner=AST_SCANNER, vendor=ACORN_VENDOR,
                                  license_file=ACORN_LICENSE):
    """Hard-fail before Node can require any unverified test dependency."""
    expected = (
        ('bridge', pathlib.Path(scanner), AST_SCANNER_SHA256),
        ('Acorn', pathlib.Path(vendor), ACORN_SHA256),
        ('Acorn license', pathlib.Path(license_file), ACORN_LICENSE_SHA256),
    )
    failures = [label for label, path, expected_hash in expected
                if not path.is_file() or digest(path) != expected_hash]
    if failures:
        raise RuntimeError('AST scanner integrity failure before launch: ' +
                           ', '.join(failures))


def launch_verified_ast_scanner(scanner=AST_SCANNER, vendor=ACORN_VENDOR,
                                license_file=ACORN_LICENSE,
                                popen_factory=subprocess.Popen):
    require_ast_scanner_integrity(scanner, vendor, license_file)
    return popen_factory(
        ['node', str(scanner)], cwd=ROOT, text=True,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, bufsize=1)


def ast_integrity_rejection_probe(mutation):
    launches = []
    with tempfile.TemporaryDirectory(prefix='loop-ast-integrity-') as temp:
        case = pathlib.Path(temp)
        scanner = case / 'js_ast_call_model.js'
        vendor = case / 'acorn.js'
        license_file = case / 'LICENSE'
        shutil.copy2(AST_SCANNER, scanner)
        shutil.copy2(ACORN_VENDOR, vendor)
        shutil.copy2(ACORN_LICENSE, license_file)
        mutation(scanner, vendor, license_file)

        def forbidden_launch(*args, **kwargs):
            launches.append((args, kwargs))
            raise AssertionError('unverified Node subprocess launched')

        error = ''
        try:
            launch_verified_ast_scanner(scanner, vendor, license_file,
                                        forbidden_launch)
        except RuntimeError as exc:
            error = str(exc)
        return {'launches': len(launches), 'error': error}


ast_integrity_evidence = {
    'tampered_vendor': ast_integrity_rejection_probe(
        lambda scanner, vendor, license_file:
        vendor.write_bytes(vendor.read_bytes() + b'\n// tampered\n')),
    'missing_vendor': ast_integrity_rejection_probe(
        lambda scanner, vendor, license_file: vendor.unlink()),
    'tampered_license': ast_integrity_rejection_probe(
        lambda scanner, vendor, license_file:
        license_file.write_bytes(license_file.read_bytes() + b'\ntampered\n')),
    'tampered_bridge': ast_integrity_rejection_probe(
        lambda scanner, vendor, license_file:
        scanner.write_bytes(scanner.read_bytes() + b'\n// tampered\n')),
}
check(all(item['launches'] == 0 and
          item['error'].startswith('AST scanner integrity failure before launch:')
          for item in ast_integrity_evidence.values()),
      'Task 7 AST supply-chain gate hard-fails tampered/missing parser, license, '
      f'or bridge before any subprocess executes: {ast_integrity_evidence}')


def javascript_ast_model(source):
    """Parse JS with the byte-pinned test-only Acorn semantic call model."""
    global _ast_scanner_process
    cached = _ast_scanner_cache.get(source)
    if cached is not None:
        return json.loads(cached)
    if _ast_scanner_process is None:
        _ast_scanner_process = launch_verified_ast_scanner()
    request = json.dumps({'source': source}, separators=(',', ':')) + '\n'
    _ast_scanner_process.stdin.write(request)
    _ast_scanner_process.stdin.flush()
    response_line = _ast_scanner_process.stdout.readline()
    if not response_line:
        error = _ast_scanner_process.stderr.read().strip()
        raise RuntimeError(f'AST scanner stopped without output: {error}')
    response = json.loads(response_line)
    if not response.get('ok'):
        raise RuntimeError(f'AST scanner rejected JavaScript: {response.get("error")}')
    serialized = json.dumps(response, separators=(',', ':'), sort_keys=True)
    _ast_scanner_cache[source] = serialized
    return json.loads(serialized)


ast_cache_probe_source = "globalThis['fe'+'tch']('/cache-isolation')"
ast_cache_first = javascript_ast_model(ast_cache_probe_source)
ast_cache_first['calls'].append({'callee': 'hostile.cache.pollution'})
ast_cache_second = javascript_ast_model(ast_cache_probe_source)
check(ast_cache_first is not ast_cache_second and
      [site['callee'] for site in ast_cache_second['calls']] ==
          ['globalThis.fetch'],
      'Task 7 AST cache returns a fresh immutable-by-ownership result per caller: '
      f'{ast_cache_second["calls"]}')


def javascript_member_accesses(source, bases):
    """Return semantic member accesses, including indirect aliased calls."""
    accesses = []
    for site in javascript_ast_model(source)['accesses']:
        if site.get('local'):
            continue
        parts = site['callee'].split('.')
        matching = [(index, part) for index, part in enumerate(parts[:-1])
                    if part in bases]
        if not matching:
            continue
        index, base = matching[-1]
        member = parts[index + 1]
        accesses.append({
            'base': base, 'member': member,
            'callee': base + '.' + member,
            'called': site['called'], 'arguments': site['arguments'],
            'line': site['line'], 'indirect': bool(site.get('indirect')),
            'kind': site.get('kind', 'access'),
        })
    return accesses


def javascript_call_sites(source, callees):
    """Return semantic call sites, following static lexical provenance."""
    sites = []
    for site in javascript_ast_model(source)['calls']:
        if site['callee'].split('.')[-1] in callees:
            sites.append({'callee': site['callee'],
                          'arguments': site['arguments'],
                          'indirect': bool(site.get('indirect')),
                          'kind': site.get('kind', 'call')})
    return sites


def javascript_risk_findings(source):
    normalized = javascript_call_model_surface(source)
    code, strings = javascript_lexical_surfaces(normalized)
    literal_surface = '\n'.join(strings)
    combined_surface = code + '\n' + literal_surface
    model = javascript_ast_model(source)
    calls = model['calls']
    accesses = model['accesses']
    references = model.get('references', [])

    def references_named(names, *, derived_only=False):
        folded = {name.lower() for name in names}
        return [reference['name'] for reference in references
                if not reference.get('local') and
                reference['name'].lower() in folded and
                (not derived_only or reference.get('derived'))]

    def calls_named(names):
        folded = {name.lower() for name in names}
        return [site['callee'] for site in calls
                if not site.get('local') and
                site['callee'].split('.')[-1].lower() in folded]

    storage_findings = []
    for site in accesses:
        if site.get('local'):
            continue
        for part in site['callee'].split('.'):
            if part.lower() in {'localstorage', 'sessionstorage', 'indexeddb'}:
                storage_findings.append(part)
                break
    findings = {
        'network APIs': references_named(
            {'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon'}),
        'browser storage': references_named(
            {'localStorage', 'sessionStorage', 'indexedDB'}),
        'secret/key material': re.findall(
            r'\b(?:private[_ -]?key|seed[_ -]?phrase|mnemonic)\b',
            combined_surface, re.I),
        'dynamic eval/Function': references_named({'eval', 'Function'}),
        'custom ABI/QR encoder': references_named({
            'encodeABI', 'decodeABI', 'encodeQr', 'encodeQrCode',
            'encodeQrPayload', 'buildQrMatrix', 'generateQrCode',
            'generateQrMatrix'}),
        'floating money formatting': references_named({'parseFloat', 'toFixed'}),
    }
    findings['dynamic script construction'] = [site['callee'] for site in calls
        if not site.get('local') and
        site['callee'].split('.')[-1] == 'createElement' and
        (not site['static_arguments'] or site['static_arguments'][0] is None or
         site['static_arguments'][0].strip().lower() == 'script')]
    findings['dynamic script construction'].extend(
        references_named({'createElement'}, derived_only=True))
    return code, strings, findings


def javascript_named_function(source, name):
    """Extract one named JS function using the same comment/string-aware surface."""
    code, _strings = javascript_lexical_surfaces(source)
    match = re.search(r'\bfunction\s+' + re.escape(name) +
                      r'\s*\([^)]*\)\s*\{', code)
    if not match:
        return ''
    open_brace = match.end() - 1
    depth = 1
    index = open_brace + 1
    while index < len(code) and depth:
        if code[index] == '{':
            depth += 1
        elif code[index] == '}':
            depth -= 1
        index += 1
    return source[match.start():index] if depth == 0 else ''


def javascript_exact_section(source, start_marker, end_marker):
    """Extract one uniquely delimited wallet-owned section."""
    if source.count(start_marker) != 1 or source.count(end_marker) != 1:
        return ''
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[start:end] if end > start else ''


def wallet_source_manifest(source):
    """Exact wallet slice including setup, sanitizers, consumers, and UI."""
    route_functions = (
        'walletPairCompatible', 'canonicalWalletHash', 'strictHashRoute',
        'currentVoiceProjection', 'validatedVoiceProjection',
    )
    route_source = '\n'.join(
        javascript_named_function(source, name) for name in route_functions)
    history_functions = (
        'exactStack', 'snapshotOwnDataRecord', 'snapshotWalletStack',
        'snapshotWalletHistoryState',
    )
    history_source = '\n'.join(
        javascript_named_function(source, name) for name in history_functions)
    signing_entrypoint_source = '\n'.join(
        javascript_named_function(source, name) for name in (
            'openSwap', 'openDapp', 'openApproveSheet',
            'chooseApprovalReview', 'doSwap'))
    voice_marker = javascript_exact_section(
        source, 'const NAVIGATION_VOICE_STATES=', 'function currentVoiceProjection')
    return {
        'wallet_constants_qr_capture': javascript_exact_section(
            source, 'const WALLET_ROUTE_DEFAULT=', 'let walletRouteParams'),
        'wallet_storage_projection': javascript_exact_section(
            source, 'const navigationStorageProjection=(()=>{',
            'function activeScr'),
        'wallet_route_parser': route_source + '\n' + voice_marker,
        'wallet_history_consumers': history_source + '\n' + javascript_exact_section(
            source, 'const walletPopstateStack=(()=>{',
            '/* hash is a projection of state, never a second source of truth */'),
        'wallet_navigation_consumers': '\n'.join(
            javascript_named_function(source, name)
            for name in ('syncHash', 'persist', 'navigate', 'goTab', 'push', 'back')),
        'wallet_popstate_coordinator': javascript_exact_section(
            source, "window.addEventListener('popstate',e=>{",
            '/* ---------- Wallet foundation: normalized provider views ---------- */'),
        'wallet_authority': javascript_exact_section(
            source, '/* ---------- Wallet foundation: normalized provider views ---------- */',
            '/* ---------- F11: one LOOP review surface over the captured provider adapter ---------- */'),
        'wallet_f11': javascript_exact_section(
            source, '/* ---------- F11: one LOOP review surface over the captured provider adapter ---------- */',
            'function walletElement'),
        'wallet_f1_f2_f6': javascript_exact_section(
            source, 'function walletElement',
            '/* ---------- market list + sparklines ---------- */'),
        'wallet_signing_entrypoints': signing_entrypoint_source,
        'wallet_signing_bindings': javascript_exact_section(
            source,
            "document.getElementById('veil').addEventListener('click',handleReviewVeil);",
            'if(!restore()) route();'),
        'wallet_route_restore_consumers': javascript_exact_section(
            source, '/* ---------- routing: hash → state (deep links from the plan page) ---------- */',
            'buildMarket(); fit();'),
    }


wallet_manifest = wallet_source_manifest(app_source)
wallet_app_source = '\n'.join(wallet_manifest.values())


ast_bridge_source = AST_SCANNER.read_text() if AST_SCANNER.exists() else ''
ast_probe = javascript_ast_model(
    "const f=globalThis['fe'+'tch'];(f)?.('/probe')")
check(AST_SCANNER.is_file() and ACORN_VENDOR.is_file() and
      ACORN_LICENSE.is_file() and digest(AST_SCANNER) == AST_SCANNER_SHA256 and
      digest(ACORN_VENDOR) == ACORN_SHA256 and
      digest(ACORN_LICENSE) == ACORN_LICENSE_SHA256 and
      ast_probe.get('version') == '8.15.0' and
      "require('./vendor/acorn-8.15.0/acorn.js')" in ast_bridge_source and
      'node_modules' not in ast_bridge_source and
      ast_probe['calls'][0]['callee'] == 'globalThis.fetch',
      'Task 7 uses byte-pinned test-only Acorn 8.15.0/MIT with no npm, npx, '
      'network, or product runtime dependency')
scanner_adversarial_code, scanner_adversarial_strings = \
    javascript_lexical_surfaces(scanner_adversarial)
scanner_comment_code, scanner_comment_strings = \
    javascript_lexical_surfaces(scanner_comment_only)
scanner_template_code, scanner_template_strings = \
    javascript_lexical_surfaces(scanner_template)
scanner_dynamic_code, scanner_dynamic_strings = \
    javascript_lexical_surfaces(scanner_dynamic_script)
check('fetch(endpoint)' in scanner_adversarial_code and
      any('https://wallet.example/v1' in value
          for value in scanner_adversarial_strings),
      'Task 7 scanner self-test preserves executable fetch after https:// string')
check('fetch(' not in scanner_comment_code and
      'sessionStorage' not in scanner_comment_code and not scanner_comment_strings,
      'Task 7 scanner self-test removes true line/block comments without false positives')
check('fetch(endpoint)' in scanner_template_code and
      any('https://wallet.example/' in value for value in scanner_template_strings),
      'Task 7 scanner self-test scans template expressions without treating URL // as comment')
check('createElement(' in scanner_dynamic_code and
      any(value == 'script' for value in scanner_dynamic_strings),
      'Task 7 scanner self-test preserves dynamic script call and literal tokens')

app_scanner_adversarial = {
    'network APIs': "globalThis?.['fe'+'tch']('https://wallet.example/v1');",
    'browser storage': "globalThis['session'+'Storage']['set'+'Item']('x','y');",
    'secret/key material': "const warning='pri'+'vate key';",
    'dynamic eval/Function': "globalThis['Func'+'tion']('return 1')();",
    'custom ABI/QR encoder': "globalThis['encode'+'ABI'](input);",
    'floating money formatting': "Number['parse'+'Float']('1');",
    'dynamic script construction':
        "document['create'+'Element']('scr'+'ipt');",
}
app_scanner_self_test = {
    label: javascript_risk_findings(source)[2][label]
    for label, source in app_scanner_adversarial.items()
}
check(all(app_scanner_self_test.values()),
      f'Task 7 app-slice scanner catches every risk class: '
      f'{app_scanner_self_test}')
app_scanner_indirect_adversarial = {
    'network APIs':
        "const walletNetworkAlias=globalThis?.['fe'+'tch'];walletNetworkAlias('/x');",
    'browser storage':
        "const walletStorageAlias=globalThis['session'+'Storage'];"
        "walletStorageAlias['set'+'Item']('x','y');",
    'secret/key material': "const walletSecretAlias='pri'+'vate key';",
    'dynamic eval/Function':
        "const walletFunctionAlias=globalThis['Func'+'tion'];"
        "walletFunctionAlias('return 1')();",
    'custom ABI/QR encoder':
        "const walletAbiAlias=globalThis['encode'+'ABI'];walletAbiAlias(input);",
    'floating money formatting':
        "const walletFloatAlias=Number['parse'+'Float'];walletFloatAlias('1');",
    'dynamic script construction':
        "const walletCreateAlias=document['create'+'Element'];"
        "walletCreateAlias('scr'+'ipt');",
}
app_scanner_indirect_self_test = {
    label: javascript_risk_findings(source)[2][label]
    for label, source in app_scanner_indirect_adversarial.items()
}
check(all(app_scanner_indirect_self_test.values()),
      'Task 7 app-slice scanner follows simple const/let aliases into calls: '
      f'{app_scanner_indirect_self_test}')
app_scanner_semicolonless_adversarial = {
    'network APIs':
        "const walletNetworkAsi=globalThis?.['fe'+'tch']\nwalletNetworkAsi('/x')",
    'browser storage':
        "const walletStorageAsi=globalThis['session'+'Storage']\n"
        "const walletSetAsi=walletStorageAsi['set'+'Item']\n"
        "walletSetAsi('x','y')",
    'secret/key material': "const walletSecretAsi='pri'+'vate key'\nvoid 0",
    'dynamic eval/Function':
        "const walletFunctionAsi=globalThis['Func'+'tion']\n"
        "walletFunctionAsi('return 1')()",
    'custom ABI/QR encoder':
        "const walletAbiAsi=globalThis['encode'+'ABI']\nwalletAbiAsi(input)",
    'floating money formatting':
        "const walletFloatAsi=Number['parse'+'Float']\nwalletFloatAsi('1')",
    'dynamic script construction':
        "const walletCreateAsi=document['create'+'Element']\n"
        "walletCreateAsi('scr'+'ipt')",
}
app_scanner_optional_invocation_adversarial = {
    'network APIs':
        "const walletNetworkOptional=globalThis['fe'+'tch'];"
        "walletNetworkOptional?.('/x');",
    'browser storage':
        "const walletStorageOptional=globalThis['session'+'Storage'];"
        "const walletSetOptional=walletStorageOptional['set'+'Item'];"
        "walletSetOptional?.('x','y');",
    'secret/key material':
        "const walletSecretOptional='pri'+'vate key';walletSecretOptional?.();",
    'dynamic eval/Function':
        "const walletFunctionOptional=globalThis['Func'+'tion'];"
        "walletFunctionOptional?.('return 1');",
    'custom ABI/QR encoder':
        "const walletAbiOptional=globalThis['encode'+'ABI'];"
        "walletAbiOptional?.(input);",
    'floating money formatting':
        "const walletFloatOptional=Number['parse'+'Float'];"
        "walletFloatOptional?.('1');",
    'dynamic script construction':
        "const walletCreateOptional=document['create'+'Element'];"
        "walletCreateOptional?.('scr'+'ipt');",
}
app_scanner_parenthesized_adversarial = {
    'network APIs':
        "const walletNetworkParen=globalThis['fe'+'tch'];"
        "(walletNetworkParen)('/x');",
    'browser storage':
        "const walletStorageParen=globalThis['session'+'Storage'];"
        "const walletSetParen=walletStorageParen['set'+'Item'];"
        "(walletSetParen)('x','y');",
    'secret/key material':
        "const walletSecretParen='pri'+'vate key';(walletSecretParen)();",
    'dynamic eval/Function':
        "const walletFunctionParen=globalThis['Func'+'tion'];"
        "(walletFunctionParen)('return 1');",
    'custom ABI/QR encoder':
        "const walletAbiParen=globalThis['encode'+'ABI'];(walletAbiParen)(input);",
    'floating money formatting':
        "const walletFloatParen=Number['parse'+'Float'];(walletFloatParen)('1');",
    'dynamic script construction':
        "const walletCreateParen=document['create'+'Element'];"
        "(walletCreateParen)('scr'+'ipt');",
}
app_scanner_optional_parenthesized_adversarial = {
    'network APIs':
        "const walletNetworkOptParen=globalThis['fe'+'tch'];"
        "(walletNetworkOptParen)?.('/x');",
    'browser storage':
        "const walletStorageOptParen=globalThis['session'+'Storage'];"
        "const walletSetOptParen=walletStorageOptParen['set'+'Item'];"
        "(walletSetOptParen)?.('x','y');",
    'secret/key material':
        "const walletSecretOptParen='pri'+'vate key';"
        "(walletSecretOptParen)?.();",
    'dynamic eval/Function':
        "const walletFunctionOptParen=globalThis['Func'+'tion'];"
        "(walletFunctionOptParen)?.('return 1');",
    'custom ABI/QR encoder':
        "const walletAbiOptParen=globalThis['encode'+'ABI'];"
        "(walletAbiOptParen)?.(input);",
    'floating money formatting':
        "const walletFloatOptParen=Number['parse'+'Float'];"
        "(walletFloatOptParen)?.('1');",
    'dynamic script construction':
        "const walletCreateOptParen=document['create'+'Element'];"
        "(walletCreateOptParen)?.('scr'+'ipt');",
}
app_scanner_semicolonless_self_test = {
    label: javascript_risk_findings(source)[2][label]
    for label, source in app_scanner_semicolonless_adversarial.items()
}
app_scanner_optional_invocation_self_test = {
    label: javascript_risk_findings(source)[2][label]
    for label, source in app_scanner_optional_invocation_adversarial.items()
}
app_scanner_parenthesized_self_test = {
    label: javascript_risk_findings(source)[2][label]
    for label, source in app_scanner_parenthesized_adversarial.items()
}
app_scanner_optional_parenthesized_self_test = {
    label: javascript_risk_findings(source)[2][label]
    for label, source in app_scanner_optional_parenthesized_adversarial.items()
}
check(all(app_scanner_semicolonless_self_test.values()),
      'Task 7 scanner follows ASI/semicolonless aliases into calls: '
      f'{app_scanner_semicolonless_self_test}')
check(all(app_scanner_optional_invocation_self_test.values()),
      'Task 7 scanner follows aliases through optional invocation: '
      f'{app_scanner_optional_invocation_self_test}')
check(all(app_scanner_parenthesized_self_test.values()),
      'Task 7 scanner follows aliases through parenthesized calls: '
      f'{app_scanner_parenthesized_self_test}')
check(all(app_scanner_optional_parenthesized_self_test.values()),
      'Task 7 scanner follows aliases through optional parenthesized calls: '
      f'{app_scanner_optional_parenthesized_self_test}')
ast_form_targets = {
    'network APIs': ("globalThis['fe'+'tch']", "'/x'", ''),
    'browser storage':
        ("globalThis['session'+'Storage']['set'+'Item']", "'x','y'", ''),
    'secret/key material':
        ("globalThis['fe'+'tch']", "'/x'", "const secretLabel='pri'+'vate key';"),
    'dynamic eval/Function': ("globalThis['Func'+'tion']", "'return 1'", ''),
    'custom ABI/QR encoder': ("globalThis['encode'+'ABI']", 'input', ''),
    'floating money formatting': ("Number['parse'+'Float']", "'1'", ''),
    'dynamic script construction':
        ("document['create'+'Element']", "'scr'+'ipt'", ''),
}
ast_form_adversarial = {}
for risk_name, (target, arguments, prefix) in ast_form_targets.items():
    ast_form_adversarial[risk_name] = {
        'var': f"{prefix}var astAlias={target};astAlias({arguments});",
        'parenthesized_rhs':
            f"{prefix}const astAlias=({target});astAlias({arguments});",
        'comma_declaration':
            f"{prefix}const astSentinel=1,astAlias={target};astAlias({arguments});",
        'block_end_asi':
            f"{prefix}if(true){{var astAlias={target}\n}}\nastAlias({arguments});",
        'function_call':
            f"{prefix}const astAlias={target};astAlias.call(null,{arguments});",
    }
ast_form_evidence = {
    risk_name: {form_name: bool(javascript_risk_findings(source)[2][risk_name])
                for form_name, source in forms.items()}
    for risk_name, forms in ast_form_adversarial.items()
}
check(all(all(forms.values()) for forms in ast_form_evidence.values()),
      'Task 7 AST gate covers var/parenthesized RHS/comma/block-end ASI/.call: '
      f'{ast_form_evidence}')
constructor_targets = {
    'WebSocket': ('network APIs', 'WebSocket', "'/socket'"),
    'XMLHttpRequest': ('network APIs', 'XMLHttpRequest', ''),
    'EventSource': ('network APIs', 'EventSource', "'/events'"),
    'Function': ('dynamic eval/Function', 'Function', "'return 1'"),
}
constructor_evidence = {}
for constructor_name, (risk_name, member_name, arguments) in \
        constructor_targets.items():
    split_at = max(1, len(member_name) // 2)
    left, right = member_name[:split_at], member_name[split_at:]
    target = f"globalThis['{left}'+'{right}']"
    forms = {
        'direct': f'new {constructor_name}({arguments});',
        'computed': f'new ({target})({arguments});',
        'alias': f'const ConstructorAlias={target};new ConstructorAlias({arguments});',
        'optional_member':
            f"new (globalThis?.['{left}'+'{right}'])({arguments});",
        'sequence':
            f'const ConstructorAlias={target};new (0,ConstructorAlias)({arguments});',
    }
    constructor_evidence[constructor_name] = {
        form_name: bool(javascript_risk_findings(source)[2][risk_name])
        for form_name, source in forms.items()
    }
check(all(all(forms.values()) for forms in constructor_evidence.values()),
      'Task 7 AST gate treats direct/computed/alias/optional-member/sequence '
      f'constructors as executable sites: {constructor_evidence}')

scope_sequence_adversarial = {
    'network APIs':
        "const scopedAlias=globalThis['fe'+'tch'];"
        "function decoy(){const scopedAlias=noop;}"
        "{const scopedAlias=noop;void scopedAlias;}(0,scopedAlias)('/x');",
    'browser storage':
        "const scopedAlias=globalThis['session'+'Storage']['set'+'Item'];"
        "function decoy(){const scopedAlias=noop;}"
        "{const scopedAlias=noop;void scopedAlias;}(0,scopedAlias)('x','y');",
    'secret/key material':
        "const scopedSecret='pri'+'vate key';"
        "function decoy(){const scopedSecret='label';}void scopedSecret;",
    'dynamic eval/Function':
        "const scopedAlias=globalThis['Func'+'tion'];"
        "function decoy(){const scopedAlias=noop;}"
        "{const scopedAlias=noop;void scopedAlias;}(0,scopedAlias)('return 1');",
    'custom ABI/QR encoder':
        "const scopedAlias=globalThis['encode'+'ABI'];"
        "function decoy(){const scopedAlias=noop;}"
        "{const scopedAlias=noop;void scopedAlias;}(0,scopedAlias)(input);",
    'floating money formatting':
        "const scopedAlias=Number['parse'+'Float'];"
        "function decoy(){const scopedAlias=noop;}"
        "{const scopedAlias=noop;void scopedAlias;}(0,scopedAlias)('1');",
    'dynamic script construction':
        "const scopedAlias=document['create'+'Element'];"
        "function decoy(){const scopedAlias=noop;}"
        "{const scopedAlias=noop;void scopedAlias;}(0,scopedAlias)('scr'+'ipt');",
}
scope_optional_sequence_adversarial = {
    label: source.replace('(0,scopedAlias)(', '(0,scopedAlias)?.(', 1)
    for label, source in scope_sequence_adversarial.items()
}
scope_sequence_evidence = {
    label: bool(javascript_risk_findings(source)[2][label])
    for label, source in scope_sequence_adversarial.items()
}
scope_optional_sequence_evidence = {
    label: bool(javascript_risk_findings(source)[2][label])
    for label, source in scope_optional_sequence_adversarial.items()
}
scope_shadow_only_findings = javascript_risk_findings(
    "function decoy(fetch){const shadowed=fetch;(0,shadowed)('/x');}")[2]
check(all(scope_sequence_evidence.values()) and
      all(scope_optional_sequence_evidence.values()) and
      not scope_shadow_only_findings['network APIs'],
      'Task 7 AST gate resolves SequenceExpression through the correct lexical '
      'binding while inner function/block shadows do not overwrite it: '
      f'{scope_sequence_evidence} / {scope_optional_sequence_evidence} / '
      f'{scope_shadow_only_findings["network APIs"]}')
extended_network_forms = {
    'object_pattern':
        "const {fetch:networkAlias}=globalThis;networkAlias('/x');",
    'object_shorthand':
        "const {fetch}=globalThis;fetch('/x');",
    'array_pattern':
        "const [networkAlias]=[globalThis.fetch];networkAlias('/x');",
    'assignment':
        "let networkAlias;networkAlias=globalThis.fetch;networkAlias('/x');",
    'program_this': "this.fetch('/x');",
    'apply':
        "const networkAlias=globalThis.fetch;networkAlias.apply(globalThis,['/x']);",
    'bind':
        "const networkAlias=globalThis.fetch.bind(globalThis);networkAlias('/x');",
    'reflect_apply':
        "const networkAlias=globalThis.fetch;Reflect.apply(networkAlias,globalThis,['/x']);",
    'switch_scope':
        "const networkAlias=globalThis.fetch;switch(1){case 0:{const "
        "networkAlias=noop;void networkAlias;break;}}networkAlias('/x');",
    'static_block_scope':
        "const networkAlias=globalThis.fetch;class Decoy{static{const "
        "networkAlias=noop;void networkAlias;}}networkAlias('/x');",
}
extended_network_evidence = {
    name: bool(javascript_risk_findings(source)[2]['network APIs'])
    for name, source in extended_network_forms.items()
}
const_key_risk_sources = {
    'network APIs':
        "const method='fetch';globalThis[method]('/const-key');",
    'browser storage':
        "const method='setItem';sessionStorage[method]('const-key','x');",
    'secret/key material':
        "const method='privateKey';void walletRecord[method];",
    'dynamic eval/Function':
        "const method='Function';globalThis[method]('return 1')();",
    'custom ABI/QR encoder':
        "const method='encodeABI';globalThis[method](input);",
    'floating money formatting':
        "const method='parseFloat';Number[method]('1');",
    'dynamic script construction':
        "const method='createElement';document[method]('script');",
}
const_key_risk_evidence = {
    label: javascript_risk_findings(source)[2][label]
    for label, source in const_key_risk_sources.items()
}
const_prefix_network = javascript_risk_findings(
    "const prefix='fet';globalThis[prefix+'ch']('/const-prefix');")[2]
const_computed_destructure_network = javascript_risk_findings(
    "const method='fetch';const {[method]:networkAlias}=globalThis;"
    "networkAlias('/computed-pattern');")[2]
static_const_key_forms = {
    'literal': "const method='fetch';globalThis[method]('/literal');",
    'template': "const method=`fetch`;globalThis[method]('/template');",
    'binary': "const method='fet'+'ch';globalThis[method]('/binary');",
    'parenthesized': "const method=('fetch');globalThis[method]('/paren');",
    'pure_sequence': "const method=(0,'fetch');globalThis[method]('/sequence');",
    'const_chain':
        "const prefix='fet';const method=prefix+'ch';"
        "globalThis[method]('/chain');",
}
static_const_key_evidence = {
    name: bool(javascript_risk_findings(source)[2]['network APIs'])
    for name, source in static_const_key_forms.items()
}
mutable_or_unknown_key_forms = {
    'let': "let method='fetch';globalThis[method]('/let');",
    'var': "var method='fetch';globalThis[method]('/var');",
    'assignment':
        "let method;method='fetch';globalThis[method]('/assignment');",
    'reassigned_const':
        "const method='fetch';method='noop';globalThis[method]('/reassigned');",
    'uncertain_const':
        "const method=condition?'fetch':'noop';globalThis[method]('/uncertain');",
}
mutable_or_unknown_key_evidence = {
    name: {
        'risk': bool(javascript_risk_findings(source)[2]['network APIs']),
        'derived': javascript_ast_model(source).get('derived_sites', []),
    }
    for name, source in mutable_or_unknown_key_forms.items()
}
unknown_sensitive_computed_network = javascript_ast_model(
    "let method=condition?'fetch':'noop';globalThis[method]('/unknown-key');")
ordinary_const_key_findings = javascript_risk_findings(
    "const method='format';helpers[method](value);")[2]
ordinary_local_sensitive_name_findings = javascript_risk_findings(
    "function safe(helpers){const {fetch:f}=helpers;f('/local');}")[2]
window_self_computed_evidence = {
    'window_const': javascript_risk_findings(
        "const method='fetch';window[method]('/window-const');")[2]['network APIs'],
    'self_const': javascript_risk_findings(
        "const method='fetch';self[method]('/self-const');")[2]['network APIs'],
    'window_unknown': javascript_risk_findings(
        "let method=condition?'fetch':'noop';window[method]('/window-unknown');")[2]
        ['network APIs'],
    'self_unknown': javascript_risk_findings(
        "let method=condition?'fetch':'noop';self[method]('/self-unknown');")[2]
        ['network APIs'],
}
window_self_unknown_derived = {
    receiver: javascript_ast_model(
        f"let method=condition?'fetch':'noop';{receiver}[method]('/x');")
        .get('derived_sites', [])
    for receiver in ('window', 'self')
}
global_alias_chain_receivers = (
    'globalThis.window', 'globalThis.self', 'window.window',
    'window.self', 'self.window', 'self.self',
)
global_alias_chain_evidence = {
    receiver: {
        'direct': javascript_risk_findings(
            f"let method=condition?'fetch':'noop';"
            f"{receiver}[method]('/global-alias-chain');")[2]['network APIs'],
        'directDerived': javascript_ast_model(
            f"let method=condition?'fetch':'noop';"
            f"{receiver}[method]('/global-alias-chain');")
            .get('derived_sites', []),
        'alias': javascript_risk_findings(
            f"const browserGlobal={receiver};"
            "let method=condition?'fetch':'noop';"
            "browserGlobal[method]('/global-alias-chain');")[2]['network APIs'],
        'aliasDerived': javascript_ast_model(
            f"const browserGlobal={receiver};"
            "let method=condition?'fetch':'noop';"
            "browserGlobal[method]('/global-alias-chain');")
            .get('derived_sites', []),
    }
    for receiver in global_alias_chain_receivers
}
ordinary_window_property_evidence = {
    'findings': javascript_risk_findings(
        "const ordinary={window:{}};"
        "let method=condition?'fetch':'noop';"
        "ordinary.window[method]('/local-window-property');")[2],
    'derived': javascript_ast_model(
        "const ordinary={window:{}};"
        "let method=condition?'fetch':'noop';"
        "ordinary.window[method]('/local-window-property');")
        .get('derived_sites', []),
}
create_element_argument_evidence = {
    'unknown': javascript_risk_findings(
        "let tag=condition?'script':'div';document.createElement(tag);")[2]
        ['dynamic script construction'],
    'const_script': javascript_risk_findings(
        "const tag='script';document.createElement(tag);")[2]
        ['dynamic script construction'],
    'const_div': javascript_risk_findings(
        "const tag='div';document.createElement(tag);")[2]
        ['dynamic script construction'],
    'local_unknown': javascript_risk_findings(
        "function safe(document,tag){document.createElement(tag);}")[2]
        ['dynamic script construction'],
}
local_sensitive_derived_source = (
    "function safe(history,sessionStorage,globalThis){"
    "let method=condition?'replaceState':'noop';"
    "history[method]({},'',location.href);sessionStorage[method]('x','y');"
    "globalThis[method]('x');}"
)
local_sensitive_derived_model = javascript_ast_model(local_sensitive_derived_source)
check(all(const_key_risk_evidence.values()) and
      bool(const_prefix_network['network APIs']) and
      bool(const_computed_destructure_network['network APIs']) and
      all(static_const_key_evidence.values()) and
      all(item['risk'] and item['derived']
          for item in mutable_or_unknown_key_evidence.values()) and
      any(site.get('path', '').startswith('globalThis.')
          for site in unknown_sensitive_computed_network.get('derived_sites', [])) and
      not any(ordinary_const_key_findings.values()) and
      not any(ordinary_local_sensitive_name_findings.values()) and
      all(window_self_computed_evidence.values()) and
      all(window_self_unknown_derived.values()) and
      all(item['direct'] and item['directDerived'] and
          item['alias'] and item['aliasDerived']
          for item in global_alias_chain_evidence.values()) and
      not any(ordinary_window_property_evidence['findings'].values()) and
      not ordinary_window_property_evidence['derived'] and
      bool(create_element_argument_evidence['unknown']) and
      bool(create_element_argument_evidence['const_script']) and
      not create_element_argument_evidence['const_div'] and
      not create_element_argument_evidence['local_unknown'] and
      bool(local_sensitive_derived_model.get('derived_sites')) and
      all(site.get('local') is True
          for site in local_sensitive_derived_model['derived_sites']),
      'Task 7 AST gate propagates immutable lexical const keys/prefixes/computed '
      'patterns, fails closed on unknown sensitive receiver keys, and preserves '
      f'local provenance: {const_key_risk_evidence} / '
      f'{const_prefix_network["network APIs"]} / '
      f'{const_computed_destructure_network["network APIs"]} / '
      f'{static_const_key_evidence} / {mutable_or_unknown_key_evidence} / '
      f'{unknown_sensitive_computed_network.get("derived_sites", [])} / '
      f'{ordinary_const_key_findings} / {ordinary_local_sensitive_name_findings} / '
      f'{window_self_computed_evidence} / {window_self_unknown_derived} / '
      f'{global_alias_chain_evidence} / {ordinary_window_property_evidence} / '
      f'{create_element_argument_evidence} / '
      f'{local_sensitive_derived_model.get("derived_sites", [])}')
unknown_network_derivation = javascript_risk_findings(
    "const networkAlias=condition?globalThis.fetch:noop;networkAlias('/x');")[2]
ordinary_local_destructure = javascript_risk_findings(
    "const {format:localFormat}=helpers;localFormat(value);")[2]
check(all(extended_network_evidence.values()) and
      bool(unknown_network_derivation['network APIs']) and
      not any(ordinary_local_destructure.values()),
      'Task 7 canonical AST policy catches destructure/assignment/this/apply/bind/'
      'Reflect.apply/switch/static-block and unknown network derivations without '
      f'flagging ordinary local destructuring: {extended_network_evidence} / '
      f'{unknown_network_derivation["network APIs"]} / {ordinary_local_destructure}')
app_template_findings = javascript_risk_findings(
    'const message=`https://wallet.example/${fetch(endpoint)}`;')[2]
app_comment_findings = javascript_risk_findings(
    '// fetch("https://comment.example")\n'
    '/* Function("return 1") */ const value=1;')[2]
check(bool(app_template_findings['network APIs']) and
      not any(app_comment_findings.values()),
      'Task 7 app-slice scanner handles template expressions and true comments')

expected_wallet_manifest = {
    'wallet_constants_qr_capture', 'wallet_storage_projection',
    'wallet_route_parser', 'wallet_history_consumers',
    'wallet_navigation_consumers', 'wallet_popstate_coordinator',
    'wallet_authority', 'wallet_f11', 'wallet_f1_f2_f6',
    'wallet_signing_entrypoints', 'wallet_signing_bindings',
    'wallet_route_restore_consumers',
}
check(set(wallet_manifest) == expected_wallet_manifest and
      all(wallet_manifest.values()) and
      'capturePinnedQrFactory' in wallet_manifest['wallet_constants_qr_capture'] and
      'PINNED_QR_FACTORY' in wallet_manifest['wallet_constants_qr_capture'] and
      'navigationStorageProjection' in wallet_manifest['wallet_storage_projection'] and
      'strictHashRoute' in wallet_manifest['wallet_route_parser'] and
      'snapshotWalletHistoryState' in wallet_manifest['wallet_history_consumers'] and
      'walletPopstateStack' in wallet_manifest['wallet_history_consumers'] and
      'navigationStorageProjection.serialize' in
          wallet_manifest['wallet_navigation_consumers'] and
      'function syncHash' in wallet_manifest['wallet_navigation_consumers'] and
      'function goTab' in wallet_manifest['wallet_navigation_consumers'] and
      'function push' in wallet_manifest['wallet_navigation_consumers'] and
      'function back' in wallet_manifest['wallet_navigation_consumers'] and
      'finishReviewOriginPopstate' in wallet_manifest['wallet_popstate_coordinator'] and
      'walletAuthority' in wallet_manifest['wallet_authority'] and
      'sanitizeReviewProjectionForWrite' in wallet_manifest['wallet_f11'] and
      'renderReceiveScreen' in wallet_manifest['wallet_f1_f2_f6'] and
      'function chooseApprovalReview' in
          wallet_manifest.get('wallet_signing_entrypoints', '') and
      'function doSwap' in wallet_manifest.get('wallet_signing_entrypoints', '') and
      "document.getElementById('review-continue').addEventListener" in
          wallet_manifest.get('wallet_signing_bindings', '') and
      "'[data-requires-signing],[data-provider-mutation]'" in
          wallet_manifest.get('wallet_signing_bindings', '') and
      'navigationStorageProjection.restore' in
          wallet_manifest['wallet_route_restore_consumers'],
      f'Task 7 exact named-section manifest covers all wallet boundaries: '
      f'{sorted(name for name, value in wallet_manifest.items() if value)}')


def wallet_slice_security_contract(source):
    """Top-level gate for every wallet/signing manifest boundary."""
    manifest = wallet_source_manifest(source)
    required = expected_wallet_manifest
    scoped = '\n'.join(manifest.get(name, '') for name in sorted(required))
    _code, _strings, risks = javascript_risk_findings(scoped)
    forbidden = {
        label: values for label, values in risks.items()
        if label != 'browser storage' and values
    }
    storage_ok = risks['browser storage'] == ['sessionStorage', 'sessionStorage']
    inner_html = re.findall(r'[^\n;]*\.innerHTML\s*=[^\n;]*', scoped)
    raw_state_calls = [site for site in javascript_ast_model(scoped)['calls']
        if site['callee'].split('.')[-1] in
           {'pushState', 'replaceState', 'setItem'} and
        re.search(r'\b(?:payload|wallet|source|model|execution)(?:_label|_id|_ref)?\s*:',
                  site.get('arguments') or '', re.I)]
    passed = (set(manifest) == required and all(manifest.values()) and
              not forbidden and storage_ok and not inner_html and
              not raw_state_calls)
    return passed, {
        'sections': sorted(manifest), 'forbidden': forbidden,
        'storage': risks['browser storage'], 'innerHTML': inner_html,
        'rawState': raw_state_calls,
    }


wallet_security_ok, wallet_security_evidence = wallet_slice_security_contract(
    app_source)
signing_boundary_mutations = {}
for boundary, anchor in {
        'entrypoint': 'function doSwap(btn){',
        'bindings': "document.getElementById('veil').addEventListener('click',handleReviewVeil);",
}.items():
    for threat, hostile in {
            'fetch': "fetch('/wallet-signing-hostile');",
            'storage': "localStorage.setItem('wallet-signing','hostile');",
            'raw_payload':
                "history.replaceState({payload_label:'P'},'',location.href);",
            'innerHTML':
                "document.getElementById('toast').innerHTML='<img src=x>';",
            'window_unknown':
                "let hostileMethod=condition?'fetch':'noop';"
                "window[hostileMethod]('/wallet-signing-hostile');",
            'self_unknown':
                "let hostileMethod=condition?'fetch':'noop';"
                "self[hostileMethod]('/wallet-signing-hostile');",
            'unknown_script':
                "let hostileTag=condition?'script':'div';"
                "document.createElement(hostileTag);",
    }.items():
        mutated = app_source.replace(anchor, anchor + '\n' + hostile, 1)
        passed, evidence = wallet_slice_security_contract(mutated)
        signing_boundary_mutations[f'{boundary}_{threat}'] = {
            'passed': passed, **evidence,
        }
for threat, hostile in {
        'global_alias_chain_direct':
            "let hostileMethod=condition?'fetch':'noop';"
            "globalThis.window[hostileMethod]('/wallet-signing-hostile');",
        'global_alias_chain_alias':
            "const hostileGlobal=window.self;"
            "let hostileMethod=condition?'fetch':'noop';"
            "hostileGlobal[hostileMethod]('/wallet-signing-hostile');",
}.items():
    anchor = 'function doSwap(btn){'
    mutated = app_source.replace(anchor, anchor + '\n' + hostile, 1)
    passed, evidence = wallet_slice_security_contract(mutated)
    signing_boundary_mutations[f'entrypoint_{threat}'] = {
        'passed': passed, **evidence,
    }
check(wallet_security_ok and
      not any(item['passed'] for item in signing_boundary_mutations.values()),
      'Task 7 top-level wallet gate covers F16/Swap/review/signing bindings and '
      'rejects fetch/storage/raw-payload/innerHTML mutations at each boundary: '
      f'{wallet_security_evidence} / {signing_boundary_mutations}')
sync_hash_network_adversarial = app_source.replace(
    'function syncHash(replace,{accountPushed=false}={}){',
    "function syncHash(replace,{accountPushed=false}={}){\nfetch('/wallet-sync');", 1)
sync_hash_manifest = wallet_source_manifest(sync_hash_network_adversarial)
check(bool(javascript_risk_findings(
    sync_hash_manifest['wallet_navigation_consumers'])[2]['network APIs']),
      'Task 7 syncHash is inside the manifest and a dormant fetch mutation fails the gate')
manifest_injection_anchors = {
    'wallet_constants_qr_capture': 'function capturePinnedQrFactory(factory){',
    'wallet_storage_projection': 'const navigationStorageProjection=(()=>{',
    'wallet_route_parser': 'function strictHashRoute(rawInput){',
    'wallet_history_consumers': 'function snapshotWalletHistoryState(candidate){',
    'wallet_navigation_consumers': 'function persist(){',
    'wallet_popstate_coordinator': "window.addEventListener('popstate',e=>{",
    'wallet_authority': 'const walletAuthority=(()=>{',
    'wallet_f11': 'const sanitizeReviewProjectionForWrite=(()=>{',
    'wallet_f1_f2_f6': 'function walletElement(tag,className,textValue){',
    'wallet_signing_entrypoints': 'function doSwap(btn){',
    'wallet_signing_bindings':
        "document.getElementById('veil').addEventListener('click',handleReviewVeil);",
    'wallet_route_restore_consumers': 'function route({silent=false}={}){',
}
manifest_risk_matrix = {}
manifest_indirect_risk_matrix = {}
manifest_semicolonless_risk_matrix = {}
manifest_optional_invocation_risk_matrix = {}
manifest_parenthesized_risk_matrix = {}
manifest_optional_parenthesized_risk_matrix = {}
for section_name, anchor in manifest_injection_anchors.items():
    section_hits = {}
    indirect_section_hits = {}
    semicolonless_section_hits = {}
    optional_invocation_section_hits = {}
    parenthesized_section_hits = {}
    optional_parenthesized_section_hits = {}
    for risk_name, hostile_source in app_scanner_adversarial.items():
        injected = app_source.replace(anchor, anchor + '\n' + hostile_source, 1)
        injected_manifest = wallet_source_manifest(injected)
        section_hits[risk_name] = bool(javascript_risk_findings(
            injected_manifest[section_name])[2][risk_name])
        indirect_injected = app_source.replace(
            anchor, anchor + '\n' + app_scanner_indirect_adversarial[risk_name], 1)
        indirect_manifest = wallet_source_manifest(indirect_injected)
        indirect_section_hits[risk_name] = bool(javascript_risk_findings(
            indirect_manifest[section_name])[2][risk_name])
        semicolonless_injected = app_source.replace(
            anchor, anchor + '\n' +
            app_scanner_semicolonless_adversarial[risk_name], 1)
        semicolonless_manifest = wallet_source_manifest(semicolonless_injected)
        semicolonless_section_hits[risk_name] = bool(javascript_risk_findings(
            semicolonless_manifest[section_name])[2][risk_name])
        optional_injected = app_source.replace(
            anchor, anchor + '\n' +
            app_scanner_optional_invocation_adversarial[risk_name], 1)
        optional_manifest = wallet_source_manifest(optional_injected)
        optional_invocation_section_hits[risk_name] = bool(javascript_risk_findings(
            optional_manifest[section_name])[2][risk_name])
        parenthesized_injected = app_source.replace(
            anchor, anchor + '\n' + app_scanner_parenthesized_adversarial[risk_name], 1)
        parenthesized_manifest = wallet_source_manifest(parenthesized_injected)
        parenthesized_section_hits[risk_name] = bool(javascript_risk_findings(
            parenthesized_manifest[section_name])[2][risk_name])
        optional_parenthesized_injected = app_source.replace(
            anchor, anchor + '\n' +
            app_scanner_optional_parenthesized_adversarial[risk_name], 1)
        optional_parenthesized_manifest = wallet_source_manifest(
            optional_parenthesized_injected)
        optional_parenthesized_section_hits[risk_name] = bool(
            javascript_risk_findings(
                optional_parenthesized_manifest[section_name])[2][risk_name])
    manifest_risk_matrix[section_name] = section_hits
    manifest_indirect_risk_matrix[section_name] = indirect_section_hits
    manifest_semicolonless_risk_matrix[section_name] = semicolonless_section_hits
    manifest_optional_invocation_risk_matrix[section_name] = \
        optional_invocation_section_hits
    manifest_parenthesized_risk_matrix[section_name] = parenthesized_section_hits
    manifest_optional_parenthesized_risk_matrix[section_name] = \
        optional_parenthesized_section_hits
check(all(all(hits.values()) for hits in manifest_risk_matrix.values()),
      'Task 7 every manifest section catches every computed/optional risk class: '
      f'{manifest_risk_matrix}')
check(all(all(hits.values()) for hits in manifest_indirect_risk_matrix.values()),
      'Task 7 every manifest section catches every alias/indirect risk class: '
      f'{manifest_indirect_risk_matrix}')
check(all(all(hits.values()) for hits in
          manifest_semicolonless_risk_matrix.values()),
      'Task 7 every manifest section catches every ASI/semicolonless risk class: '
      f'{manifest_semicolonless_risk_matrix}')
check(all(all(hits.values()) for hits in
          manifest_optional_invocation_risk_matrix.values()),
      'Task 7 every manifest section catches every optional-invocation risk class: '
      f'{manifest_optional_invocation_risk_matrix}')
check(all(all(hits.values()) for hits in
          manifest_parenthesized_risk_matrix.values()),
      'Task 7 every manifest section catches every parenthesized-call risk class: '
      f'{manifest_parenthesized_risk_matrix}')
check(all(all(hits.values()) for hits in
          manifest_optional_parenthesized_risk_matrix.values()),
      'Task 7 every manifest section catches every optional-parenthesized risk class: '
      f'{manifest_optional_parenthesized_risk_matrix}')

APPROVED_ONBOARDING_FIXTURE_SHA256 = \
    '84cb91001213be08fd7fd0797fd3067dcbe71b50b784dfe5bbb900ef8d9dc90f'


def source_without_approved_onboarding_fixture(source):
    """Remove exactly one byte-pinned approved fixture block from scan input."""
    fixture = javascript_exact_section(
        source, 'const DEMO_PHRASE =', 'const DEMO_IMPORT_WORDS =')
    if not (fixture and source.count('const DEMO_PHRASE =') == 1 and
            source.count('const DEMO_PRIVATE_KEY =') == 1 and
            hashlib.sha256(fixture.encode()).hexdigest() ==
            APPROVED_ONBOARDING_FIXTURE_SHA256):
        return ''
    start = source.index('const DEMO_PHRASE =')
    return source[:start] + source[start + len(fixture):]


def javascript_secret_declarations(source):
    """Find secret-bearing declarations; UI labels are not credential material."""
    normalized = javascript_call_model_surface(source)
    code, strings = javascript_lexical_surfaces(normalized)
    declaration_names = re.findall(
        r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*'
        r'(?:private[_$]?key|seed[_$]?phrase|mnemonic)[A-Za-z0-9_$]*)\b',
        code, re.I)
    credential_literals = [value for value in strings if
                           re.fullmatch(r'0x[0-9a-fA-F]{64}', value.strip())]
    return declaration_names + credential_literals


onboarding_scan_source = source_without_approved_onboarding_fixture(app_source)
before_onboarding_adversarial = app_source.replace(
    'const DEMO_PHRASE =',
    "const BEFORE_PRIVATE_KEY='not-approved';\nconst DEMO_PHRASE =", 1)
after_onboarding_adversarial = app_source.replace(
    "const DEMO_IMPORT_WORDS = new Set([...DEMO_PHRASE,'pixel']);",
    "const DEMO_IMPORT_WORDS = new Set([...DEMO_PHRASE,'pixel']);\n"
    "const AFTER_SEED_PHRASE='not-approved';", 1)
changed_onboarding_fixture = app_source.replace(
    "['orbit','velvet'", "['changed','velvet'", 1)
onboarding_secret_evidence = {
    'clean': javascript_secret_declarations(onboarding_scan_source),
    'before': javascript_secret_declarations(
        source_without_approved_onboarding_fixture(before_onboarding_adversarial)),
    'after': javascript_secret_declarations(
        source_without_approved_onboarding_fixture(after_onboarding_adversarial)),
    'changed_removed': bool(source_without_approved_onboarding_fixture(
        changed_onboarding_fixture)),
}
check(bool(onboarding_scan_source) and
      not onboarding_secret_evidence['clean'] and
      onboarding_secret_evidence['before'] == ['BEFORE_PRIVATE_KEY'] and
      onboarding_secret_evidence['after'] == ['AFTER_SEED_PHRASE'] and
      not onboarding_secret_evidence['changed_removed'] and
      not source_without_approved_onboarding_fixture(changed_onboarding_fixture) and
      'DEMO_PHRASE' not in wallet_app_source and
      'DEMO_PRIVATE_KEY' not in wallet_app_source,
      'Task 7 full-app scan removes only the exact pinned onboarding fixture and '
      f'rejects secret declarations immediately before/after it: '
      f'{onboarding_secret_evidence}')

module_source = provider_source + '\n' + review_source + '\n' + transfer_source
executable_modules, module_strings, module_risks = \
    javascript_risk_findings(module_source)
allowed_public_origins = {'https://swap.zone'}
remote_url_literals = [value for value in module_strings
                       if re.search(r'https?://', value, re.I)]
unexpected_remote_urls = [value for value in remote_url_literals
                          if value not in allowed_public_origins]
check(any('https://wallet.example/v1' in value
          for value in scanner_adversarial_strings) and
      all(value not in allowed_public_origins
          for value in scanner_adversarial_strings),
      'Task 7 scanner self-test rejects unapproved remote URL literals')
for label in ('network APIs', 'browser storage', 'secret/key material',
              'dynamic eval/Function', 'dynamic script construction',
              'custom ABI/QR encoder', 'floating money formatting'):
    check(not module_risks[label],
          f'Task 7 provider/review call-model source has no {label}: '
          f'{module_risks[label]}')
check(not unexpected_remote_urls,
      'Task 7 provider/review string literals use only the approved public DApp origin: '
      f'{unexpected_remote_urls}')
wallet_app_code, wallet_app_strings, wallet_app_risks = \
    javascript_risk_findings(wallet_app_source)
for label in ('network APIs', 'secret/key material',
              'dynamic eval/Function', 'dynamic script construction',
              'custom ABI/QR encoder', 'floating money formatting'):
    check(not wallet_app_risks[label],
          f'Task 7 touched wallet app source has no {label}: '
          f'{wallet_app_risks[label]}')


def sensitive_derived_sites(source, domains):
    """Return non-local derived sites rooted in a sensitive consumer domain."""
    prefixes = {
        'history': ('history.', 'globalThis.history.'),
        'storage': (
            'sessionStorage.', 'localStorage.', 'indexedDB.',
            'globalThis.sessionStorage.', 'globalThis.localStorage.',
            'globalThis.indexedDB.', 'globalThis.[computed]',
        ),
        'navigate': ('navigate', 'globalThis.navigate', 'globalThis.[computed]'),
    }
    accepted = tuple(prefix for domain in domains for prefix in prefixes[domain])
    return [site for site in javascript_ast_model(source).get('derived_sites', [])
            if not site.get('local') and
            any(site.get('path', '').startswith(prefix) for prefix in accepted)]


local_sensitive_consumer_evidence = sensitive_derived_sites(
    local_sensitive_derived_source, {'history', 'storage', 'navigate'})
check(not local_sensitive_consumer_evidence,
      'Task 7 consumer contracts ignore derived sites rooted in local shadow '
      f'parameters: {local_sensitive_consumer_evidence}')

persist_source = javascript_named_function(wallet_app_source, 'persist')
restore_source = javascript_named_function(wallet_app_source, 'restore')


def storage_contract(persist, restore):
    combined = persist + '\n' + restore
    persist_accesses = javascript_member_accesses(
        persist, {'sessionStorage', 'localStorage', 'indexedDB'})
    restore_accesses = javascript_member_accesses(
        restore, {'sessionStorage', 'localStorage', 'indexedDB'})
    persist_sites = [site for site in persist_accesses if site['called']]
    restore_sites = [site for site in restore_accesses if site['called']]
    derived = sensitive_derived_sites(combined, {'storage'})
    indirect = [site for site in persist_accesses + restore_accesses
                if site.get('indirect')]
    passed = (
        len(persist_sites) == 1 and
        persist_sites[0]['callee'] == 'sessionStorage.setItem' and
        re.sub(r'\s+', '', persist_sites[0]['arguments']) ==
            'SS_KEY,navigationStorageProjection.serialize(stack)' and
        len(restore_sites) == 1 and
        restore_sites[0]['callee'] == 'sessionStorage.getItem' and
        re.sub(r'\s+', '', restore_sites[0]['arguments']) == 'SS_KEY' and
        not derived and not indirect
    )
    return passed, {
        'persist': persist_sites, 'restore': restore_sites,
        'derived': derived, 'indirect': indirect,
    }


storage_ok, storage_evidence = storage_contract(persist_source, restore_source)
check(wallet_app_risks['browser storage'] == ['sessionStorage', 'sessionStorage'] and
      storage_ok and
      'navigationStorageProjection.restore(s)' in restore_source and
      'navigationStorageProjection.serialize(stack)' in persist_source and
      'JSON.stringify({stack, voice})' not in persist_source and
      'voice' not in persist_source and
      'Object.assign(voice' not in restore_source,
      'Task 7 storage allowlist is exact sanitizer serialize/restore dataflow: '
      f'{storage_evidence}')
storage_alias_mutation = persist_source.replace(
    'function persist(){',
    "function persist(){const hostileStorage=globalThis['session'+'Storage'];"
    "hostileStorage['set'+'Item']('payload','P');", 1)
storage_alias_accesses = javascript_member_accesses(
    storage_alias_mutation, {'sessionStorage', 'localStorage', 'indexedDB'})
check(len(storage_alias_accesses) == 2 and
      [site['member'] for site in storage_alias_accesses] == ['setItem', 'setItem'],
      'Task 7 storage allowlist model rejects an indirect alias write: '
      f'{storage_alias_accesses}')
storage_semicolonless_mutation = persist_source.replace(
    'function persist(){',
    "function persist(){const hostileSetStorage="
    "globalThis['session'+'Storage']['set'+'Item']\n"
    "hostileSetStorage('payload','P')\n", 1)
storage_optional_mutation = persist_source.replace(
    'function persist(){',
    "function persist(){const hostileSetStorage="
    "globalThis['session'+'Storage']['set'+'Item'];"
    "hostileSetStorage?.('payload','P');", 1)
storage_semicolonless_sites = [site for site in javascript_member_accesses(
    storage_semicolonless_mutation,
    {'sessionStorage', 'localStorage', 'indexedDB'}) if site['called']]
storage_optional_sites = [site for site in javascript_member_accesses(
    storage_optional_mutation,
    {'sessionStorage', 'localStorage', 'indexedDB'}) if site['called']]
check(len(storage_semicolonless_sites) == 2 and
      len(storage_optional_sites) == 2,
      'Task 7 storage gate rejects ASI and optional-invocation alias writes: '
      f'{storage_semicolonless_sites} / {storage_optional_sites}')
storage_parenthesized_mutation = persist_source.replace(
    'function persist(){',
    "function persist(){const hostileSetStorage="
    "globalThis['session'+'Storage']['set'+'Item'];"
    "(hostileSetStorage)('payload','P');", 1)
storage_optional_parenthesized_mutation = persist_source.replace(
    'function persist(){',
    "function persist(){const hostileSetStorage="
    "globalThis['session'+'Storage']['set'+'Item'];"
    "(hostileSetStorage)?.('payload','P');", 1)
storage_parenthesized_sites = [site for site in javascript_member_accesses(
    storage_parenthesized_mutation,
    {'sessionStorage', 'localStorage', 'indexedDB'}) if site['called']]
storage_optional_parenthesized_sites = [site for site in javascript_member_accesses(
    storage_optional_parenthesized_mutation,
    {'sessionStorage', 'localStorage', 'indexedDB'}) if site['called']]
check(len(storage_parenthesized_sites) == 2 and
      len(storage_optional_parenthesized_sites) == 2,
      'Task 7 storage gate rejects parenthesized alias writes: '
      f'{storage_parenthesized_sites} / {storage_optional_parenthesized_sites}')
storage_scoped_sequence_mutation = persist_source.replace(
    'function persist(){',
    "function persist(){const hostileSetStorage="
    "globalThis.sessionStorage.setItem;"
    "function decoy(){const hostileSetStorage=noop;}"
    "(0,hostileSetStorage)('payload','P');", 1)
storage_scoped_sequence_sites = [site for site in javascript_member_accesses(
    storage_scoped_sequence_mutation,
    {'sessionStorage', 'localStorage', 'indexedDB'}) if site['called']]
storage_optional_scoped_sequence_mutation = storage_scoped_sequence_mutation.replace(
    "(0,hostileSetStorage)('payload'", "(0,hostileSetStorage)?.('payload'", 1)
storage_optional_scoped_sequence_sites = [site for site in javascript_member_accesses(
    storage_optional_scoped_sequence_mutation,
    {'sessionStorage', 'localStorage', 'indexedDB'}) if site['called']]
check(len(storage_scoped_sequence_sites) == 2 and
      len(storage_optional_scoped_sequence_sites) == 2,
      'Task 7 storage gate follows scope-safe sequence/optional-sequence writes: '
      f'{storage_scoped_sequence_sites} / '
      f'{storage_optional_scoped_sequence_sites}')

history_function_names = (
    'openWalletReview', 'cancelWalletReview', 'continueWalletReview',
    'refreshWalletReview', 'handleReviewHistoryPopstate',
    'finishReviewOriginPopstate', 'restoreReviewFromCurrentEntry',
)
F11_EXPECTED_HISTORY_ACCESS_MEMBERS = {
    'openWalletReview': ['pushState', 'state'],
    'cancelWalletReview': ['state', 'back', 'replaceState'],
    'continueWalletReview':
        ['state', 'state', 'replaceState', 'state', 'back', 'replaceState'],
    'refreshWalletReview': ['replaceState'],
    'handleReviewHistoryPopstate': ['replaceState', 'replaceState', 'replaceState'],
    'finishReviewOriginPopstate': ['state', 'replaceState', 'state', 'replaceState'],
    'restoreReviewFromCurrentEntry': ['state', 'state', 'replaceState'],
}
F11_EXPECTED_HISTORY_WRITES = [
    ('openWalletReview', 'pushState',
     "sanitizeReviewProjectionForWrite.marker(origin,reviewId),'',location.href"),
    ('cancelWalletReview', 'replaceState', "origin,'','#'+expectedHash()"),
    ('continueWalletReview', 'replaceState', "origin,'','#'+expectedHash()"),
    ('continueWalletReview', 'replaceState', "origin,'','#'+expectedHash()"),
    ('refreshWalletReview', 'replaceState',
     "sanitizeReviewProjectionForWrite.marker(refreshedOrigin,reviewRuntime.openId),'',location.href"),
    ('handleReviewHistoryPopstate', 'replaceState',
     "projection,'','#'+expectedHash()"),
    ('handleReviewHistoryPopstate', 'replaceState',
     "safeOrigin,'','#'+expectedHash()"),
    ('handleReviewHistoryPopstate', 'replaceState',
     "safeOrigin,'','#'+expectedHash()"),
    ('finishReviewOriginPopstate', 'replaceState',
     "expected,'','#'+expectedHash()"),
    ('finishReviewOriginPopstate', 'replaceState',
     "expected,'','#'+expectedHash()"),
    ('restoreReviewFromCurrentEntry', 'replaceState',
     "safeOrigin,'','#'+expectedHash()"),
]


def f11_history_contract(source):
    owners = {name: javascript_named_function(source, name)
              for name in history_function_names}
    accesses = {name: javascript_member_accesses(owner_source, {'history'})
                for name, owner_source in owners.items()}
    access_members = {name: [item['member'] for item in owner_accesses]
                      for name, owner_accesses in accesses.items()}
    calls = [(name, item) for name in history_function_names
             for item in accesses[name] if item['called']]
    writes = [(name, item['member'], re.sub(r'\s+', '', item['arguments'] or ''))
              for name, item in calls
              if item['member'] in {'pushState', 'replaceState'}]
    owner_compact = {name: re.sub(r'\s+', '', value)
                     for name, value in owners.items()}
    sanitizer_dataflow = (
        'constorigin=sanitizeReviewProjectionForWrite.projection(' in
            owner_compact['cancelWalletReview'] and
        owner_compact['continueWalletReview'].count(
            'constorigin=sanitizeReviewProjectionForWrite.projection(') == 2 and
        'constprojection=sanitizeReviewProjectionForWrite.projection(' in
            owner_compact['handleReviewHistoryPopstate'] and
        owner_compact['handleReviewHistoryPopstate'].count(
            'constsafeOrigin=sanitizeReviewProjectionForWrite.projection(') == 2 and
        owner_compact['finishReviewOriginPopstate'].count(
            'constexpected=sanitizeReviewProjectionForWrite.projection(') == 2 and
        'constsafeOrigin=sanitizeReviewProjectionForWrite.projection(' in
            owner_compact['restoreReviewFromCurrentEntry'])
    dangerous = [write for write in writes if re.search(
        r'\b(?:source|model|execution|payload|wallet(?:_ref|_id|_class|_address)?)\s*:',
        write[2], re.I)]
    derived = [(name, site) for name, owner_source in owners.items()
               for site in javascript_ast_model(owner_source).get(
                   'derived_sites', [])
               if site['path'].startswith('history.') or
                  site['path'].startswith('globalThis.history.')]
    indirect = [(name, item['callee'], item['kind'])
                for name, owner_accesses in accesses.items()
                for item in owner_accesses if item.get('indirect')]
    passed = (all(owners.values()) and
              access_members == F11_EXPECTED_HISTORY_ACCESS_MEMBERS and
              len([item for owner in accesses.values() for item in owner]) == 22 and
              len(calls) == 13 and len(writes) == 11 and
              writes == F11_EXPECTED_HISTORY_WRITES and sanitizer_dataflow and
              not dangerous and not derived and not indirect and
              not any(re.search(r'\breviewRuntime\.origin\b', value)
                      for value in owners.values()))
    return passed, {'accesses': access_members, 'calls': len(calls),
                    'writes': writes, 'sanitized': sanitizer_dataflow,
                    'dangerous': dangerous, 'derived': derived,
                    'indirect': indirect}


f11_history_ok, f11_history_evidence = f11_history_contract(app_source)
check(f11_history_ok,
      'Task 7 F11 unified member/call model proves exact 22 accesses, 13 calls, '
      f'11 sanitizer-owned writes: {f11_history_evidence}')
extra_history_write_source = app_source.replace(
    'function openWalletReview(reviewId,trigger=document.activeElement){',
    "function openWalletReview(reviewId,trigger=document.activeElement){\n"
    "history['replace'+'State']({payload_label:'P'},'',location.href);", 1)
extra_history_ok, extra_history_evidence = f11_history_contract(
    extra_history_write_source)
check(not extra_history_ok and extra_history_evidence['calls'] == 14 and
      len(extra_history_evidence['writes']) == 12,
      'Task 7 computed extra hostile history write is rejected by the same model: '
      f'{extra_history_evidence}')
semicolonless_history_write_source = app_source.replace(
    'function openWalletReview(reviewId,trigger=document.activeElement){',
    "function openWalletReview(reviewId,trigger=document.activeElement){\n"
    "const hostileReplace=history['replace'+'State']\n"
    "hostileReplace({payload_label:'P'},'',location.href)\n", 1)
optional_history_write_source = app_source.replace(
    'function openWalletReview(reviewId,trigger=document.activeElement){',
    "function openWalletReview(reviewId,trigger=document.activeElement){\n"
    "const hostileReplace=history['replace'+'State'];"
    "hostileReplace?.({payload_label:'P'},'',location.href);", 1)
semicolonless_history_ok, semicolonless_history_evidence = f11_history_contract(
    semicolonless_history_write_source)
optional_history_ok, optional_history_evidence = f11_history_contract(
    optional_history_write_source)
check(not semicolonless_history_ok and not optional_history_ok and
      semicolonless_history_evidence['calls'] == 14 and
      optional_history_evidence['calls'] == 14 and
      len(semicolonless_history_evidence['writes']) == 12 and
      len(optional_history_evidence['writes']) == 12 and
      sum(len(value) for value in semicolonless_history_evidence['accesses'].values())
          == 23 and
      sum(len(value) for value in optional_history_evidence['accesses'].values())
          == 23,
      'Task 7 F11 gate rejects ASI and optional alias writes as exact 23/14/12: '
      f'{semicolonless_history_evidence} / {optional_history_evidence}')
parenthesized_history_write_source = app_source.replace(
    'function openWalletReview(reviewId,trigger=document.activeElement){',
    "function openWalletReview(reviewId,trigger=document.activeElement){\n"
    "const hostileReplace=history['replace'+'State'];"
    "(hostileReplace)({payload_label:'P'},'',location.href);", 1)
optional_parenthesized_history_write_source = app_source.replace(
    'function openWalletReview(reviewId,trigger=document.activeElement){',
    "function openWalletReview(reviewId,trigger=document.activeElement){\n"
    "const hostileReplace=history['replace'+'State'];"
    "(hostileReplace)?.({payload_label:'P'},'',location.href);", 1)
parenthesized_history_ok, parenthesized_history_evidence = f11_history_contract(
    parenthesized_history_write_source)
optional_parenthesized_history_ok, optional_parenthesized_history_evidence = \
    f11_history_contract(optional_parenthesized_history_write_source)
check(not parenthesized_history_ok and not optional_parenthesized_history_ok and
      parenthesized_history_evidence['calls'] == 14 and
      optional_parenthesized_history_evidence['calls'] == 14 and
      len(parenthesized_history_evidence['writes']) == 12 and
      len(optional_parenthesized_history_evidence['writes']) == 12 and
      sum(len(value) for value in parenthesized_history_evidence['accesses'].values())
          == 23 and
      sum(len(value) for value in
          optional_parenthesized_history_evidence['accesses'].values()) == 23,
      'Task 7 F11 gate rejects parenthesized and optional-parenthesized alias '
      f'writes as exact 23/14/12: {parenthesized_history_evidence} / '
      f'{optional_parenthesized_history_evidence}')
scoped_sequence_history_write_source = app_source.replace(
    'function openWalletReview(reviewId,trigger=document.activeElement){',
    "function openWalletReview(reviewId,trigger=document.activeElement){\n"
    "const hostileReplace=history.replaceState;"
    "function decoy(){const hostileReplace=noop;}"
    "{const hostileReplace=noop;void hostileReplace;}"
    "(0,hostileReplace)({payload_label:'P'},'',location.href);", 1)
optional_scoped_sequence_history_write_source = \
    scoped_sequence_history_write_source.replace(
        "(0,hostileReplace)({payload_label:'P'}",
        "(0,hostileReplace)?.({payload_label:'P'}", 1)
scoped_sequence_history_ok, scoped_sequence_history_evidence = \
    f11_history_contract(scoped_sequence_history_write_source)
optional_scoped_sequence_history_ok, optional_scoped_sequence_history_evidence = \
    f11_history_contract(optional_scoped_sequence_history_write_source)
check(not scoped_sequence_history_ok and not optional_scoped_sequence_history_ok and
      scoped_sequence_history_evidence['calls'] == 14 and
      optional_scoped_sequence_history_evidence['calls'] == 14 and
      len(scoped_sequence_history_evidence['writes']) == 12 and
      len(optional_scoped_sequence_history_evidence['writes']) == 12 and
      sum(len(value) for value in
          scoped_sequence_history_evidence['accesses'].values()) == 23 and
      sum(len(value) for value in
          optional_scoped_sequence_history_evidence['accesses'].values()) == 23,
      'Task 7 F11 gate rejects scope-safe sequence/optional-sequence writes as '
      f'exact 23/14/12: {scoped_sequence_history_evidence} / '
      f'{optional_scoped_sequence_history_evidence}')
extended_history_injections = {
    'object_pattern_call':
        "const {replaceState:hostileReplace}=history;"
        "hostileReplace.call(history,{payload_label:'P'},'',location.href);",
    'array_pattern_apply':
        "const [hostileReplace]=[history.replaceState];"
        "hostileReplace.apply(history,[{payload_label:'P'},'',location.href]);",
    'assignment':
        "let hostileReplace;hostileReplace=history.replaceState;"
        "hostileReplace({payload_label:'P'},'',location.href);",
    'bind':
        "const hostileReplace=history.replaceState.bind(history);"
        "hostileReplace({payload_label:'P'},'',location.href);",
    'reflect_apply':
        "const hostileReplace=history.replaceState;"
        "Reflect.apply(hostileReplace,history,[{payload_label:'P'},'',location.href]);",
    'switch_scope':
        "const hostileReplace=history.replaceState;"
        "switch(1){case 0:{const hostileReplace=noop;void hostileReplace;break;}}"
        "hostileReplace({payload_label:'P'},'',location.href);",
    'unknown_derivation':
        "const hostileReplace=condition?history.replaceState:noop;"
        "hostileReplace({payload_label:'P'},'',location.href);",
}
extended_history_evidence = {}
for form_name, injection in extended_history_injections.items():
    mutated = app_source.replace(
        'function openWalletReview(reviewId,trigger=document.activeElement){',
        'function openWalletReview(reviewId,trigger=document.activeElement){\n' +
        injection, 1)
    passed, evidence = f11_history_contract(mutated)
    extended_history_evidence[form_name] = {
        'passed': passed,
        'accesses': sum(len(value) for value in evidence['accesses'].values()),
        'calls': evidence['calls'],
        'writes': len(evidence['writes']),
        'derived': evidence.get('derived', []),
    }
check(not any(item['passed'] for item in extended_history_evidence.values()) and
      extended_history_evidence['object_pattern_call']['accesses'] == 23 and
      extended_history_evidence['object_pattern_call']['calls'] == 14 and
      extended_history_evidence['object_pattern_call']['writes'] == 12 and
      all(item['accesses'] >= 23 or item['derived']
          for item in extended_history_evidence.values()),
      'Task 7 F11 canonical-only contract rejects destructure/assignment/apply/'
      'bind/Reflect.apply/switch/unknown derivations, with object-pattern call '
      f'exactly 23/14/12: {extended_history_evidence}')
const_key_history_write_source = app_source.replace(
    'function openWalletReview(reviewId,trigger=document.activeElement){',
    "function openWalletReview(reviewId,trigger=document.activeElement){\n"
    "const method='replaceState';"
    "history[method]({payload_label:'P'},'',location.href);", 1)
const_prefix_history_write_source = app_source.replace(
    'function openWalletReview(reviewId,trigger=document.activeElement){',
    "function openWalletReview(reviewId,trigger=document.activeElement){\n"
    "const prefix='replace';"
    "history[prefix+'State']({payload_label:'P'},'',location.href);", 1)
unknown_key_history_write_source = app_source.replace(
    'function openWalletReview(reviewId,trigger=document.activeElement){',
    "function openWalletReview(reviewId,trigger=document.activeElement){\n"
    "let method=condition?'replaceState':'noop';"
    "history[method]({payload_label:'P'},'',location.href);", 1)
const_key_history_evidence = {}
for form_name, mutated in {
        'const_key': const_key_history_write_source,
        'const_prefix': const_prefix_history_write_source,
        'unknown_key': unknown_key_history_write_source,
}.items():
    passed, evidence = f11_history_contract(mutated)
    const_key_history_evidence[form_name] = {
        'passed': passed,
        'accesses': sum(len(value) for value in evidence['accesses'].values()),
        'calls': evidence['calls'],
        'writes': len(evidence['writes']),
        'derived': evidence.get('derived', []),
    }
check(not any(item['passed'] for item in const_key_history_evidence.values()) and
      const_key_history_evidence['const_key']['accesses'] == 23 and
      const_key_history_evidence['const_key']['calls'] == 14 and
      const_key_history_evidence['const_key']['writes'] == 12 and
      const_key_history_evidence['const_prefix']['accesses'] == 23 and
      const_key_history_evidence['const_prefix']['calls'] == 14 and
      const_key_history_evidence['const_prefix']['writes'] == 12 and
      bool(const_key_history_evidence['unknown_key']['derived']),
      'Task 7 F11 contract resolves immutable const computed keys/prefixes and '
      'fails closed for unknown keys on history: '
      f'{const_key_history_evidence}')

def history_contract(source, expected_members, expected_call_arguments):
    """Canonical history inventory with indirect/derived fail-closed semantics."""
    accesses = javascript_member_accesses(source, {'history'})
    calls = [site for site in accesses if site['called']]
    derived = sensitive_derived_sites(source, {'history'})
    indirect = [site for site in accesses if site.get('indirect')]
    passed = (
        [site['member'] for site in accesses] == expected_members and
        [re.sub(r'\s+', '', site['arguments'] or '') for site in calls] ==
            expected_call_arguments and
        not derived and
        not indirect
    )
    return passed, {
        'accesses': len(accesses), 'calls': len(calls),
        'members': [site['member'] for site in accesses],
        'derived': derived, 'indirect': indirect,
    }


popstate_source = wallet_manifest['wallet_popstate_coordinator']
POPSTATE_HISTORY_MEMBERS = ['replaceState', 'replaceState']
POPSTATE_HISTORY_ARGUMENTS = [
    "projection,'','#'+walletProjection.canonical",
    "safeProjectedState,'','#'+projected.canonical",
]
popstate_history_ok, popstate_history_evidence = history_contract(
    popstate_source, POPSTATE_HISTORY_MEMBERS, POPSTATE_HISTORY_ARGUMENTS)
check(popstate_history_ok and
      'snapshotWalletHistoryState(e.state)' in popstate_source and
      'const safeProjectedState=snapshotWalletHistoryState(e.state);' in
          re.sub(r'\s+', ' ', popstate_source),
      'Task 7 wallet popstate history writes receive only exact sanitizer projections: '
      f'{popstate_history_evidence}')
popstate_semicolonless_mutation = popstate_source.replace(
    "window.addEventListener('popstate',e=>{",
    "window.addEventListener('popstate',e=>{\n"
    "const hostileReplace=history['replace'+'State']\n"
    "hostileReplace({payload_label:'P'},'',location.href)\n", 1)
popstate_optional_mutation = popstate_source.replace(
    "window.addEventListener('popstate',e=>{",
    "window.addEventListener('popstate',e=>{\n"
    "const hostileReplace=history['replace'+'State'];"
    "hostileReplace?.({payload_label:'P'},'',location.href);", 1)
popstate_semicolonless_sites = [site for site in javascript_member_accesses(
    popstate_semicolonless_mutation, {'history'}) if site['called']]
popstate_optional_sites = [site for site in javascript_member_accesses(
    popstate_optional_mutation, {'history'}) if site['called']]
check(len(popstate_semicolonless_sites) == 3 and
      len(popstate_optional_sites) == 3,
      'Task 7 popstate gate rejects ASI and optional alias history writes: '
      f'{popstate_semicolonless_sites} / {popstate_optional_sites}')
popstate_parenthesized_mutation = popstate_source.replace(
    "window.addEventListener('popstate',e=>{",
    "window.addEventListener('popstate',e=>{\n"
    "const hostileReplace=history['replace'+'State'];"
    "(hostileReplace)({payload_label:'P'},'',location.href);", 1)
popstate_optional_parenthesized_mutation = popstate_source.replace(
    "window.addEventListener('popstate',e=>{",
    "window.addEventListener('popstate',e=>{\n"
    "const hostileReplace=history['replace'+'State'];"
    "(hostileReplace)?.({payload_label:'P'},'',location.href);", 1)
popstate_parenthesized_sites = [site for site in javascript_member_accesses(
    popstate_parenthesized_mutation, {'history'}) if site['called']]
popstate_optional_parenthesized_sites = [site for site in javascript_member_accesses(
    popstate_optional_parenthesized_mutation, {'history'}) if site['called']]
check(len(popstate_parenthesized_sites) == 3 and
      len(popstate_optional_parenthesized_sites) == 3,
      'Task 7 popstate gate rejects parenthesized alias history writes: '
      f'{popstate_parenthesized_sites} / {popstate_optional_parenthesized_sites}')
popstate_scoped_sequence_mutation = popstate_source.replace(
    "window.addEventListener('popstate',e=>{",
    "window.addEventListener('popstate',e=>{\n"
    "const hostileReplace=history.replaceState;"
    "function decoy(){const hostileReplace=noop;}"
    "(0,hostileReplace)({payload_label:'P'},'',location.href);", 1)
popstate_scoped_sequence_sites = [site for site in javascript_member_accesses(
    popstate_scoped_sequence_mutation, {'history'}) if site['called']]
popstate_optional_scoped_sequence_mutation = \
    popstate_scoped_sequence_mutation.replace(
        "(0,hostileReplace)({payload_label:",
        "(0,hostileReplace)?.({payload_label:", 1)
popstate_optional_scoped_sequence_sites = [site for site in
    javascript_member_accesses(popstate_optional_scoped_sequence_mutation,
                               {'history'}) if site['called']]
check(len(popstate_scoped_sequence_sites) == 3 and
      len(popstate_optional_scoped_sequence_sites) == 3,
      'Task 7 popstate gate follows scope-safe sequence/optional-sequence writes: '
      f'{popstate_scoped_sequence_sites} / '
      f'{popstate_optional_scoped_sequence_sites}')

navigation_history_source = '\n'.join(
    javascript_named_function(wallet_app_source, name)
    for name in ('syncHash', 'back'))
NAVIGATION_HISTORY_MEMBERS = [
    'state', 'state', 'state', 'state', 'pushState', 'replaceState',
    'replaceState', 'pushState', 'back', 'back',
]
NAVIGATION_HISTORY_ARGUMENTS = [
    "st,'',url", "st,'',url", "st,'',url", "st,'',url", '', '',
]
navigation_history_ok, navigation_history_evidence = history_contract(
    navigation_history_source, NAVIGATION_HISTORY_MEMBERS,
    NAVIGATION_HISTORY_ARGUMENTS)
check(navigation_history_ok and
      'constst={stack:stack.slice()};' in
          re.sub(r'\s+', '', navigation_history_source),
      'Task 7 shared wallet navigation history consumers are fully enumerated: '
      f'{navigation_history_evidence}')


def wallet_manifest_joined(source):
    return '\n'.join(wallet_source_manifest(source).values())


def shared_history_scope(source):
    manifest = wallet_source_manifest(source)
    return '\n'.join(javascript_named_function(
        manifest['wallet_navigation_consumers'], name)
        for name in ('syncHash', 'back'))


unknown_pattern_injection = (
    "let hostileMethod=condition?'replaceState':'noop';"
    "const {[hostileMethod]:hostileReplace}=history;"
    "hostileReplace({payload_label:'P'},'',location.href);"
)
unknown_member_injection = (
    "let hostileMethod=condition?'replaceState':'noop';"
    "history[hostileMethod]({payload_label:'P'},'',location.href);"
)
unknown_pattern_parenthesized_injection = unknown_pattern_injection.replace(
    "hostileReplace({payload_label:",
    "(hostileReplace)({payload_label:", 1)
unknown_pattern_optional_injection = unknown_pattern_injection.replace(
    "hostileReplace({payload_label:",
    "(hostileReplace)?.({payload_label:", 1)
popstate_unknown_pattern_app = app_source.replace(
    "window.addEventListener('popstate',e=>{",
    "window.addEventListener('popstate',e=>{" + unknown_pattern_injection, 1)
popstate_unknown_member_app = app_source.replace(
    "window.addEventListener('popstate',e=>{",
    "window.addEventListener('popstate',e=>{" + unknown_member_injection, 1)
shared_unknown_pattern_app = app_source.replace(
    'function syncHash(replace,{accountPushed=false}={}){',
    'function syncHash(replace,{accountPushed=false}={}){' +
    unknown_pattern_injection, 1)
shared_unknown_member_app = app_source.replace(
    'function syncHash(replace,{accountPushed=false}={}){',
    'function syncHash(replace,{accountPushed=false}={}){' +
    unknown_member_injection, 1)
popstate_unknown_pattern_parenthesized_app = app_source.replace(
    "window.addEventListener('popstate',e=>{",
    "window.addEventListener('popstate',e=>{" +
    unknown_pattern_parenthesized_injection, 1)
popstate_unknown_pattern_optional_app = app_source.replace(
    "window.addEventListener('popstate',e=>{",
    "window.addEventListener('popstate',e=>{" +
    unknown_pattern_optional_injection, 1)
shared_unknown_pattern_parenthesized_app = app_source.replace(
    'function syncHash(replace,{accountPushed=false}={}){',
    'function syncHash(replace,{accountPushed=false}={}){' +
    unknown_pattern_parenthesized_injection, 1)
shared_unknown_pattern_optional_app = app_source.replace(
    'function syncHash(replace,{accountPushed=false}={}){',
    'function syncHash(replace,{accountPushed=false}={}){' +
    unknown_pattern_optional_injection, 1)

popstate_unknown_contracts = {}
for form_name, mutated_app in {
        'computed_pattern': popstate_unknown_pattern_app,
        'computed_pattern_parenthesized':
            popstate_unknown_pattern_parenthesized_app,
        'computed_pattern_optional': popstate_unknown_pattern_optional_app,
        'member_call': popstate_unknown_member_app,
}.items():
    mutated_scope = wallet_source_manifest(
        mutated_app)['wallet_popstate_coordinator']
    passed, evidence = history_contract(
        mutated_scope, POPSTATE_HISTORY_MEMBERS, POPSTATE_HISTORY_ARGUMENTS)
    popstate_unknown_contracts[form_name] = {
        'passed': passed, **evidence,
    }
shared_unknown_contracts = {}
for form_name, mutated_app in {
        'computed_pattern': shared_unknown_pattern_app,
        'computed_pattern_parenthesized':
            shared_unknown_pattern_parenthesized_app,
        'computed_pattern_optional': shared_unknown_pattern_optional_app,
        'member_call': shared_unknown_member_app,
}.items():
    passed, evidence = history_contract(
        shared_history_scope(mutated_app), NAVIGATION_HISTORY_MEMBERS,
        NAVIGATION_HISTORY_ARGUMENTS)
    shared_unknown_contracts[form_name] = {'passed': passed, **evidence}

baseline_full_history = javascript_member_accesses(
    wallet_app_source, {'history'})
pattern_full_history = javascript_member_accesses(
    wallet_manifest_joined(popstate_unknown_pattern_app), {'history'})
local_history_app = app_source.replace(
    "window.addEventListener('popstate',e=>{",
    "window.addEventListener('popstate',e=>{"
    "function localProbe(helpers){let method=condition?'format':'noop';"
    "const {[method]:localCall}=helpers;localCall('x');}", 1)
local_history_scope = wallet_source_manifest(
    local_history_app)['wallet_popstate_coordinator']
local_history_ok, local_history_evidence = history_contract(
    local_history_scope, POPSTATE_HISTORY_MEMBERS, POPSTATE_HISTORY_ARGUMENTS)
check(not any(item['passed'] for item in popstate_unknown_contracts.values()) and
      not any(item['passed'] for item in shared_unknown_contracts.values()) and
      len(pattern_full_history) == len(baseline_full_history) and
      len([site for site in pattern_full_history if site['called']]) ==
          len([site for site in baseline_full_history if site['called']]) and
      bool(popstate_unknown_contracts['computed_pattern']['derived']) and
      bool(shared_unknown_contracts['computed_pattern']['derived']) and
      local_history_ok and not local_history_evidence['derived'],
      'Task 7 popstate/shared history contracts consume derived-sensitive sites '
      'even when unknown computed destructuring preserves the full-app access/'
      f'call baseline, while local helpers remain allowed: '
      f'{popstate_unknown_contracts} / {shared_unknown_contracts} / '
      f'{len(baseline_full_history)}/'
      f'{len([site for site in baseline_full_history if site["called"]])} / '
      f'{local_history_evidence}')
navigation_semicolonless_mutation = navigation_history_source.replace(
    'function syncHash(replace,{accountPushed=false}={}){',
    "function syncHash(replace,{accountPushed=false}={}){\n"
    "const hostileReplace=history['replace'+'State']\n"
    "hostileReplace({payload_label:'P'},'',location.href)\n", 1)
navigation_optional_mutation = navigation_history_source.replace(
    'function syncHash(replace,{accountPushed=false}={}){',
    "function syncHash(replace,{accountPushed=false}={}){\n"
    "const hostileReplace=history['replace'+'State'];"
    "hostileReplace?.({payload_label:'P'},'',location.href);", 1)
navigation_semicolonless_sites = [site for site in javascript_member_accesses(
    navigation_semicolonless_mutation, {'history'}) if site['called']]
navigation_optional_sites = [site for site in javascript_member_accesses(
    navigation_optional_mutation, {'history'}) if site['called']]
check(len(navigation_semicolonless_sites) == 7 and
      len(navigation_optional_sites) == 7,
      'Task 7 shared navigation gate rejects ASI and optional alias history writes: '
      f'{navigation_semicolonless_sites} / {navigation_optional_sites}')
navigation_parenthesized_mutation = navigation_history_source.replace(
    'function syncHash(replace,{accountPushed=false}={}){',
    "function syncHash(replace,{accountPushed=false}={}){\n"
    "const hostileReplace=history['replace'+'State'];"
    "(hostileReplace)({payload_label:'P'},'',location.href);", 1)
navigation_optional_parenthesized_mutation = navigation_history_source.replace(
    'function syncHash(replace,{accountPushed=false}={}){',
    "function syncHash(replace,{accountPushed=false}={}){\n"
    "const hostileReplace=history['replace'+'State'];"
    "(hostileReplace)?.({payload_label:'P'},'',location.href);", 1)
navigation_parenthesized_sites = [site for site in javascript_member_accesses(
    navigation_parenthesized_mutation, {'history'}) if site['called']]
navigation_optional_parenthesized_sites = [site for site in
    javascript_member_accesses(navigation_optional_parenthesized_mutation,
                               {'history'}) if site['called']]
check(len(navigation_parenthesized_sites) == 7 and
      len(navigation_optional_parenthesized_sites) == 7,
      'Task 7 shared navigation gate rejects parenthesized alias history writes: '
      f'{navigation_parenthesized_sites} / '
      f'{navigation_optional_parenthesized_sites}')
navigation_scoped_sequence_mutation = navigation_history_source.replace(
    'function syncHash(replace,{accountPushed=false}={}){',
    "function syncHash(replace,{accountPushed=false}={}){\n"
    "const hostileReplace=history.replaceState;"
    "{const hostileReplace=noop;void hostileReplace;}"
    "(0,hostileReplace)({payload_label:'P'},'',location.href);", 1)
navigation_scoped_sequence_sites = [site for site in javascript_member_accesses(
    navigation_scoped_sequence_mutation, {'history'}) if site['called']]
navigation_optional_scoped_sequence_mutation = \
    navigation_scoped_sequence_mutation.replace(
        "(0,hostileReplace)({payload_label:",
        "(0,hostileReplace)?.({payload_label:", 1)
navigation_optional_scoped_sequence_sites = [site for site in
    javascript_member_accesses(navigation_optional_scoped_sequence_mutation,
                               {'history'}) if site['called']]
check(len(navigation_scoped_sequence_sites) == 7 and
      len(navigation_optional_scoped_sequence_sites) == 7,
      'Task 7 shared navigation gate follows scope-safe sequence/optional-sequence '
      f'writes: {navigation_scoped_sequence_sites} / '
      f'{navigation_optional_scoped_sequence_sites}')
router_source = javascript_named_function(wallet_app_source, 'routeWalletPair')
router_navigate_sites = javascript_call_sites(router_source, {'navigate'})
authority_navigate_sites = javascript_call_sites(
    wallet_manifest['wallet_authority'], {'navigate'})


def navigate_contract(source, expected_arguments):
    sites = javascript_call_sites(source, {'navigate'})
    derived = sensitive_derived_sites(source, {'navigate'})
    indirect = [site for site in sites if site.get('indirect')]
    passed = (
        [site['callee'] for site in sites] == ['navigate'] * len(expected_arguments) and
        [re.sub(r'\s+', '', site['arguments'] or '') for site in sites] ==
            expected_arguments and
        not derived and not indirect
    )
    return passed, {'sites': sites, 'derived': derived, 'indirect': indirect}


router_contract_ok, router_contract_evidence = navigate_contract(
    router_source, ['stack.slice(),{replace:true,keepScroll:true}', 'next'])
authority_contract_ok, authority_contract_evidence = navigate_contract(
    wallet_manifest['wallet_authority'], ["['scr-wallet'],{replace:true}"])
coordinator_router_sites = javascript_call_sites(
    wallet_manifest['wallet_popstate_coordinator'], {'navigate', 'route'})
routing_consumer_sites = javascript_call_sites(
    wallet_manifest['wallet_route_restore_consumers'], {'navigate', 'route'})
wallet_pair_sites = javascript_call_sites(
    wallet_manifest['wallet_f1_f2_f6'], {'routeWalletPair'})
normalized_router_arguments = [re.sub(r'\s+', '', site['arguments'])
                               for site in router_navigate_sites]
check(router_contract_ok and authority_contract_ok and
      normalized_router_arguments ==
          ['stack.slice(),{replace:true,keepScroll:true}', 'next'] and
      'walletPairCompatible(asset,chain)' in router_source and
      'ROUTES[target]?.screen' in router_source and
      [re.sub(r'\s+', '', site['arguments']) for site in authority_navigate_sites] ==
          ["['scr-wallet'],{replace:true}"] and
      'consumeReviewForNavigation();navigate' in
          re.sub(r'\s+', '', wallet_manifest['wallet_authority']) and
      [site['callee'] for site in coordinator_router_sites] == ['navigate', 'route'] and
      re.sub(r'\s+', '', coordinator_router_sites[0]['arguments']) ==
          'nextStack,{replace:true}' and
      'guardAccountStack(e.state.stack.slice())' in popstate_source and
      [site['callee'] for site in routing_consumer_sites] ==
          ['navigate', 'route', 'navigate'] and
      'navigationStorageProjection.restore(s)' in
          wallet_manifest['wallet_route_restore_consumers'] and
      all(re.sub(r'\s+', '', site['arguments']).startswith(("'asset',", "'receive',"))
          for site in wallet_pair_sites) and
      all(not site['callee'].startswith('globalThis.') for site in
          router_navigate_sites + authority_navigate_sites +
          coordinator_router_sites + routing_consumer_sites + wallet_pair_sites),
      'Task 7 router/authority call sites have explicit route, proof, or sanitizer '
      f'semantics: {router_navigate_sites} / {authority_navigate_sites} / '
      f'{coordinator_router_sites} / {routing_consumer_sites} / {wallet_pair_sites} / '
      f'{router_contract_evidence} / {authority_contract_evidence}')
router_alias_mutation = router_source.replace(
    'function routeWalletPair(target,asset,chain,{replace=false}={}){',
    "function routeWalletPair(target,asset,chain,{replace=false}={}){"
    "const hostileNavigate=globalThis?.['navigate'];"
    "hostileNavigate(['scr-wallet']);", 1)
authority_alias_mutation = wallet_manifest['wallet_authority'].replace(
    'const walletAuthority=(()=>{',
    "const walletAuthority=(()=>{const hostileNavigate=globalThis['navigate'];"
    "hostileNavigate(['scr-wallet']);", 1)
router_alias_sites = javascript_call_sites(router_alias_mutation, {'navigate'})
authority_alias_sites = javascript_call_sites(
    authority_alias_mutation, {'navigate'})
check(any(site['callee'] == 'globalThis.navigate' for site in router_alias_sites) and
      any(site['callee'] == 'globalThis.navigate' for site in authority_alias_sites),
      'Task 7 router/authority allowlist model rejects indirect global navigate aliases: '
      f'{router_alias_sites} / {authority_alias_sites}')
router_semicolonless_mutation = router_source.replace(
    'function routeWalletPair(target,asset,chain,{replace=false}={}){',
    "function routeWalletPair(target,asset,chain,{replace=false}={}){\n"
    "const hostileNavigate=globalThis?.['navigate']\n"
    "hostileNavigate(['scr-wallet'])\n", 1)
router_optional_mutation = router_source.replace(
    'function routeWalletPair(target,asset,chain,{replace=false}={}){',
    "function routeWalletPair(target,asset,chain,{replace=false}={}){\n"
    "const hostileNavigate=globalThis['navigate'];"
    "hostileNavigate?.(['scr-wallet']);", 1)
authority_semicolonless_mutation = wallet_manifest['wallet_authority'].replace(
    'const walletAuthority=(()=>{',
    "const walletAuthority=(()=>{\n"
    "const hostileNavigate=globalThis['navigate']\n"
    "hostileNavigate(['scr-wallet'])\n", 1)
authority_optional_mutation = wallet_manifest['wallet_authority'].replace(
    'const walletAuthority=(()=>{',
    "const walletAuthority=(()=>{\n"
    "const hostileNavigate=globalThis['navigate'];"
    "hostileNavigate?.(['scr-wallet']);", 1)
router_semicolonless_sites = javascript_call_sites(
    router_semicolonless_mutation, {'navigate'})
router_optional_sites = javascript_call_sites(router_optional_mutation, {'navigate'})
authority_semicolonless_sites = javascript_call_sites(
    authority_semicolonless_mutation, {'navigate'})
authority_optional_sites = javascript_call_sites(
    authority_optional_mutation, {'navigate'})
check(any(site['callee'] == 'globalThis.navigate'
          for site in router_semicolonless_sites) and
      any(site['callee'] == 'globalThis.navigate'
          for site in router_optional_sites) and
      any(site['callee'] == 'globalThis.navigate'
          for site in authority_semicolonless_sites) and
      any(site['callee'] == 'globalThis.navigate'
          for site in authority_optional_sites),
      'Task 7 router/authority gates reject ASI and optional global navigate aliases: '
      f'{router_semicolonless_sites} / {router_optional_sites} / '
      f'{authority_semicolonless_sites} / {authority_optional_sites}')
router_parenthesized_mutation = router_source.replace(
    'function routeWalletPair(target,asset,chain,{replace=false}={}){',
    "function routeWalletPair(target,asset,chain,{replace=false}={}){\n"
    "const hostileNavigate=globalThis['navigate'];"
    "(hostileNavigate)(['scr-wallet']);", 1)
router_optional_parenthesized_mutation = router_source.replace(
    'function routeWalletPair(target,asset,chain,{replace=false}={}){',
    "function routeWalletPair(target,asset,chain,{replace=false}={}){\n"
    "const hostileNavigate=globalThis['navigate'];"
    "(hostileNavigate)?.(['scr-wallet']);", 1)
authority_parenthesized_mutation = wallet_manifest['wallet_authority'].replace(
    'const walletAuthority=(()=>{',
    "const walletAuthority=(()=>{\n"
    "const hostileNavigate=globalThis['navigate'];"
    "(hostileNavigate)(['scr-wallet']);", 1)
authority_optional_parenthesized_mutation = \
    wallet_manifest['wallet_authority'].replace(
        'const walletAuthority=(()=>{',
        "const walletAuthority=(()=>{\n"
        "const hostileNavigate=globalThis['navigate'];"
        "(hostileNavigate)?.(['scr-wallet']);", 1)
router_parenthesized_sites = javascript_call_sites(
    router_parenthesized_mutation, {'navigate'})
router_optional_parenthesized_sites = javascript_call_sites(
    router_optional_parenthesized_mutation, {'navigate'})
authority_parenthesized_sites = javascript_call_sites(
    authority_parenthesized_mutation, {'navigate'})
authority_optional_parenthesized_sites = javascript_call_sites(
    authority_optional_parenthesized_mutation, {'navigate'})
check(any(site['callee'] == 'globalThis.navigate'
          for site in router_parenthesized_sites) and
      any(site['callee'] == 'globalThis.navigate'
          for site in router_optional_parenthesized_sites) and
      any(site['callee'] == 'globalThis.navigate'
          for site in authority_parenthesized_sites) and
      any(site['callee'] == 'globalThis.navigate'
          for site in authority_optional_parenthesized_sites),
      'Task 7 router/authority gates reject parenthesized global navigate aliases: '
      f'{router_parenthesized_sites} / {router_optional_parenthesized_sites} / '
      f'{authority_parenthesized_sites} / '
      f'{authority_optional_parenthesized_sites}')
router_scoped_sequence_mutation = router_source.replace(
    'function routeWalletPair(target,asset,chain,{replace=false}={}){',
    "function routeWalletPair(target,asset,chain,{replace=false}={}){\n"
    "const hostileNavigate=globalThis.navigate;"
    "function decoy(){const hostileNavigate=noop;}"
    "(0,hostileNavigate)(['scr-wallet']);", 1)
authority_scoped_sequence_mutation = wallet_manifest['wallet_authority'].replace(
    'const walletAuthority=(()=>{',
    "const walletAuthority=(()=>{\n"
    "const hostileNavigate=globalThis.navigate;"
    "{const hostileNavigate=noop;void hostileNavigate;}"
    "(0,hostileNavigate)(['scr-wallet']);", 1)
router_scoped_sequence_sites = javascript_call_sites(
    router_scoped_sequence_mutation, {'navigate'})
authority_scoped_sequence_sites = javascript_call_sites(
    authority_scoped_sequence_mutation, {'navigate'})
router_optional_scoped_sequence_sites = javascript_call_sites(
    router_scoped_sequence_mutation.replace(
        "(0,hostileNavigate)(['scr-wallet'])",
        "(0,hostileNavigate)?.(['scr-wallet'])", 1), {'navigate'})
authority_optional_scoped_sequence_sites = javascript_call_sites(
    authority_scoped_sequence_mutation.replace(
        "(0,hostileNavigate)(['scr-wallet'])",
        "(0,hostileNavigate)?.(['scr-wallet'])", 1), {'navigate'})
check(any(site['callee'] == 'globalThis.navigate'
          for site in router_scoped_sequence_sites) and
      any(site['callee'] == 'globalThis.navigate'
          for site in authority_scoped_sequence_sites) and
      any(site['callee'] == 'globalThis.navigate'
          for site in router_optional_scoped_sequence_sites) and
      any(site['callee'] == 'globalThis.navigate'
          for site in authority_optional_scoped_sequence_sites),
      'Task 7 router/authority gates follow scope-safe sequence/optional-sequence '
      f'navigate aliases: {router_scoped_sequence_sites} / '
      f'{authority_scoped_sequence_sites} / '
      f'{router_optional_scoped_sequence_sites} / '
      f'{authority_optional_scoped_sequence_sites}')
storage_destructure_mutation = persist_source.replace(
    'function persist(){',
    "function persist(){const {setItem:hostileSet}=sessionStorage;"
    "hostileSet.call(sessionStorage,'payload','P');", 1)
popstate_destructure_mutation = popstate_source.replace(
    "window.addEventListener('popstate',e=>{",
    "window.addEventListener('popstate',e=>{const [hostileReplace]="
    "[history.replaceState];hostileReplace.apply(history,"
    "[{payload_label:'P'},'',location.href]);", 1)
navigation_assignment_mutation = navigation_history_source.replace(
    'function syncHash(replace,{accountPushed=false}={}){',
    "function syncHash(replace,{accountPushed=false}={}){let hostileReplace;"
    "hostileReplace=history.replaceState;"
    "hostileReplace({payload_label:'P'},'',location.href);", 1)
router_bind_mutation = router_source.replace(
    'function routeWalletPair(target,asset,chain,{replace=false}={}){',
    "function routeWalletPair(target,asset,chain,{replace=false}={}){"
    "const hostileNavigate=globalThis.navigate.bind(globalThis);"
    "hostileNavigate(['scr-wallet']);", 1)
authority_reflect_mutation = wallet_manifest['wallet_authority'].replace(
    'const walletAuthority=(()=>{',
    "const walletAuthority=(()=>{const hostileNavigate=globalThis.navigate;"
    "Reflect.apply(hostileNavigate,globalThis,[['scr-wallet']]);", 1)
extended_allowlist_evidence = {
    'storage': javascript_member_accesses(
        storage_destructure_mutation,
        {'sessionStorage', 'localStorage', 'indexedDB'}),
    'popstate': javascript_member_accesses(
        popstate_destructure_mutation, {'history'}),
    'shared_history': javascript_member_accesses(
        navigation_assignment_mutation, {'history'}),
    'router': javascript_call_sites(router_bind_mutation, {'navigate'}),
    'authority': javascript_call_sites(authority_reflect_mutation, {'navigate'}),
}
check(len([site for site in extended_allowlist_evidence['storage']
           if site['called']]) >= 2 and
      len([site for site in extended_allowlist_evidence['popstate']
           if site['called']]) >= 3 and
      len([site for site in extended_allowlist_evidence['shared_history']
           if site['called']]) >= 7 and
      len(extended_allowlist_evidence['router']) >= 3 and
      len(extended_allowlist_evidence['authority']) >= 2 and
      all(any(site.get('indirect') for site in sites)
          for sites in extended_allowlist_evidence.values()),
      'Task 7 canonical-only storage/popstate/shared/router/authority allowlists '
      f'reject destructure/assignment/bind/apply derivations: '
      f'{extended_allowlist_evidence}')

storage_const_key_mutation = persist_source.replace(
    'function persist(){',
    "function persist(){const method='setItem';"
    "sessionStorage[method]('payload','P');", 1)
popstate_const_key_mutation = popstate_source.replace(
    "window.addEventListener('popstate',e=>{",
    "window.addEventListener('popstate',e=>{const method='replaceState';"
    "history[method]({payload_label:'P'},'',location.href);", 1)
navigation_const_key_mutation = navigation_history_source.replace(
    'function syncHash(replace,{accountPushed=false}={}){',
    "function syncHash(replace,{accountPushed=false}={}){"
    "const method='replaceState';"
    "history[method]({payload_label:'P'},'',location.href);", 1)
router_const_key_mutation = router_source.replace(
    'function routeWalletPair(target,asset,chain,{replace=false}={}){',
    "function routeWalletPair(target,asset,chain,{replace=false}={}){"
    "const method='navigate';globalThis[method](['scr-wallet']);", 1)
authority_const_key_mutation = wallet_manifest['wallet_authority'].replace(
    'const walletAuthority=(()=>{',
    "const walletAuthority=(()=>{const method='navigate';"
    "globalThis[method](['scr-wallet']);", 1)
const_key_allowlist_evidence = {
    'storage': javascript_member_accesses(
        storage_const_key_mutation,
        {'sessionStorage', 'localStorage', 'indexedDB'}),
    'popstate': javascript_member_accesses(
        popstate_const_key_mutation, {'history'}),
    'shared_history': javascript_member_accesses(
        navigation_const_key_mutation, {'history'}),
    'router': javascript_call_sites(router_const_key_mutation, {'navigate'}),
    'authority': javascript_call_sites(authority_const_key_mutation, {'navigate'}),
}
check(len([site for site in const_key_allowlist_evidence['storage']
           if site['called']]) == 2 and
      len([site for site in const_key_allowlist_evidence['popstate']
           if site['called']]) == 3 and
      len([site for site in const_key_allowlist_evidence['shared_history']
           if site['called']]) == 7 and
      len(const_key_allowlist_evidence['router']) == 3 and
      len(const_key_allowlist_evidence['authority']) == 2 and
      all(any(site.get('indirect') for site in sites)
          for sites in const_key_allowlist_evidence.values()),
      'Task 7 const computed-key mutations add a rejected indirect site to '
      'storage/popstate/shared/router/authority consumers: '
      f'{const_key_allowlist_evidence}')

storage_unknown_key_mutation = persist_source.replace(
    'function persist(){',
    "function persist(){let method=condition?'setItem':'noop';"
    "sessionStorage[method]('payload','P');", 1)
popstate_unknown_key_mutation = popstate_source.replace(
    "window.addEventListener('popstate',e=>{",
    "window.addEventListener('popstate',e=>{"
    "let method=condition?'replaceState':'noop';"
    "history[method]({payload_label:'P'},'',location.href);", 1)
navigation_unknown_key_mutation = navigation_history_source.replace(
    'function syncHash(replace,{accountPushed=false}={}){',
    "function syncHash(replace,{accountPushed=false}={}){"
    "let method=condition?'replaceState':'noop';"
    "history[method]({payload_label:'P'},'',location.href);", 1)
router_unknown_key_mutation = router_source.replace(
    'function routeWalletPair(target,asset,chain,{replace=false}={}){',
    "function routeWalletPair(target,asset,chain,{replace=false}={}){"
    "let method=condition?'navigate':'noop';"
    "globalThis[method](['scr-wallet']);", 1)
authority_unknown_key_mutation = wallet_manifest['wallet_authority'].replace(
    'const walletAuthority=(()=>{',
    "const walletAuthority=(()=>{let method=condition?'navigate':'noop';"
    "globalThis[method](['scr-wallet']);", 1)
unknown_key_allowlist_evidence = {
    name: javascript_ast_model(source).get('derived_sites', [])
    for name, source in {
        'storage': storage_unknown_key_mutation,
        'popstate': popstate_unknown_key_mutation,
        'shared_history': navigation_unknown_key_mutation,
        'router': router_unknown_key_mutation,
        'authority': authority_unknown_key_mutation,
    }.items()
}
storage_unknown_pattern_mutation = persist_source.replace(
    'function persist(){',
    "function persist(){let method=condition?'setItem':'noop';"
    "const {[method]:hostileStore}=sessionStorage;"
    "hostileStore('payload','P');", 1)
router_unknown_pattern_mutation = router_source.replace(
    'function routeWalletPair(target,asset,chain,{replace=false}={}){',
    "function routeWalletPair(target,asset,chain,{replace=false}={}){"
    "let method=condition?'navigate':'noop';"
    "const {[method]:hostileNavigate}=globalThis;"
    "hostileNavigate(['scr-wallet']);", 1)
authority_unknown_pattern_mutation = wallet_manifest['wallet_authority'].replace(
    'const walletAuthority=(()=>{',
    "const walletAuthority=(()=>{let method=condition?'navigate':'noop';"
    "const {[method]:hostileNavigate}=globalThis;"
    "hostileNavigate(['scr-wallet']);", 1)

storage_unknown_pattern_ok, storage_unknown_pattern_evidence = storage_contract(
    storage_unknown_pattern_mutation, restore_source)
storage_unknown_member_ok, storage_unknown_member_evidence = storage_contract(
    storage_unknown_key_mutation, restore_source)
router_unknown_pattern_ok, router_unknown_pattern_evidence = navigate_contract(
    router_unknown_pattern_mutation,
    ['stack.slice(),{replace:true,keepScroll:true}', 'next'])
router_unknown_member_ok, router_unknown_member_evidence = navigate_contract(
    router_unknown_key_mutation,
    ['stack.slice(),{replace:true,keepScroll:true}', 'next'])
authority_unknown_pattern_ok, authority_unknown_pattern_evidence = \
    navigate_contract(authority_unknown_pattern_mutation,
                      ["['scr-wallet'],{replace:true}"])
authority_unknown_member_ok, authority_unknown_member_evidence = \
    navigate_contract(authority_unknown_key_mutation,
                      ["['scr-wallet'],{replace:true}"])
unknown_consumer_contracts = {
    'storage_pattern': (storage_unknown_pattern_ok,
                        storage_unknown_pattern_evidence),
    'storage_member': (storage_unknown_member_ok,
                       storage_unknown_member_evidence),
    'router_pattern': (router_unknown_pattern_ok,
                       router_unknown_pattern_evidence),
    'router_member': (router_unknown_member_ok,
                      router_unknown_member_evidence),
    'authority_pattern': (authority_unknown_pattern_ok,
                          authority_unknown_pattern_evidence),
    'authority_member': (authority_unknown_member_ok,
                         authority_unknown_member_evidence),
}

storage_local_mutation = persist_source.replace(
    'function persist(){',
    "function persist(){function localProbe(helpers){"
    "let method=condition?'format':'noop';"
    "const {[method]:localCall}=helpers;localCall('x');}", 1)
router_local_mutation = router_source.replace(
    'function routeWalletPair(target,asset,chain,{replace=false}={}){',
    "function routeWalletPair(target,asset,chain,{replace=false}={}){"
    "function localProbe(helpers){let method=condition?'format':'noop';"
    "const {[method]:localCall}=helpers;localCall('x');}", 1)
authority_local_mutation = wallet_manifest['wallet_authority'].replace(
    'const walletAuthority=(()=>{',
    "const walletAuthority=(()=>{function localProbe(helpers){"
    "let method=condition?'format':'noop';"
    "const {[method]:localCall}=helpers;localCall('x');}", 1)
storage_local_ok, storage_local_evidence = storage_contract(
    storage_local_mutation, restore_source)
router_local_ok, router_local_evidence = navigate_contract(
    router_local_mutation,
    ['stack.slice(),{replace:true,keepScroll:true}', 'next'])
authority_local_ok, authority_local_evidence = navigate_contract(
    authority_local_mutation, ["['scr-wallet'],{replace:true}"])
check(all(not passed and evidence['derived']
          for passed, evidence in unknown_consumer_contracts.values()) and
      storage_local_ok and router_local_ok and authority_local_ok and
      all(unknown_key_allowlist_evidence.values()),
      'Task 7 storage/router/authority contracts directly reject unknown '
      'computed destructuring/member sites while ordinary local derivations '
      f'remain allowed: {unknown_consumer_contracts} / '
      f'{storage_local_evidence} / {router_local_evidence} / '
      f'{authority_local_evidence}')

wallet_inner_html = re.findall(r'[^\n;]*\.innerHTML\s*=[^\n;]*', wallet_app_source)
check(not wallet_inner_html,
      f'Task 7 wallet slice has no innerHTML assignment: {wallet_inner_html}')
check("createPinnedReceiveQrSvg(PINNED_QR_FACTORY,address,alternative)" in
      wallet_app_source and
      not re.search(r'https?://[^\s\'\"]*(?:qr|chart|price|explorer)',
                    wallet_app_source, re.I),
      'Task 7 QR uses private pinned local dependency output with no remote service')
check(not re.search(r'\b(?:parseFloat|toFixed)\s*\(', wallet_app_source),
      'Task 7 wallet/review money paths avoid floating-point parsing/formatting')
check(all(review_id in review_source for review_id in (
    'review-transfer', 'review-approve-limited', 'review-approve-unlimited',
    'review-swap-fresh', 'review-perp', 'review-transfer-external',
    'review-approve-external', 'review-approve-unlimited-external',
    'review-swap-external', 'review-perp-external')),
      'Task 7 F11 source inventory covers transfer/limited/unlimited/swap/Perp '
      'for embedded/external authorities')
check(all(copy in review_source for copy in (
    'The wallet request was rejected by the user.',
    'The wallet request was blocked by provider policy.',
    'The wallet provider returned data LOOP could not safely use.',
    'The wallet provider is temporarily unavailable.',
    'This review session has expired.')),
      'Task 7 F11 safe-error inventory is fixed LOOP-owned copy')

# Owner-approved onboarding demo material is deliberately outside the wallet/review
# executable scan. The account verifier owns the exact deterministic phrase/private-key
# fixtures and their leak tests; this allowlist must not expand into wallet modules.
account_verifier_source = (ROOT / '_tmp' / 'verify_account.py').read_text()
check("TASK7_PHRASE = 'orbit velvet cactus harbor lunar maple echo raven silver tunnel pixel anchor'"
      in account_verifier_source and
      "TASK7_PRIVATE_KEY = '0x' + '1' * 64" in account_verifier_source and
      not re.search(r'\b(?:private[_ -]?key|seed[_ -]?phrase|mnemonic)\b',
                    executable_modules, re.I),
      'Task 7 security scan explicitly allowlists only existing account demo fixtures')

print('\n== Task 8 wallet documentation contract ==')
task8_readme = (ROOT / 'README.md').read_text()
task8_inventory = (ROOT / '文档' / '页面清单.md').read_text()
task8_schedule = (ROOT / '文档' / '开发进度安排.md').read_text()
task8_findings = (ROOT / 'findings.md').read_text()
task8_docs = '\n'.join((task8_readme, task8_inventory,
                         task8_schedule, task8_findings))
check('42 个 routed screen fragments' in task8_readme and
      '42-screen' in task8_findings,
      'Current docs report the generated 42-screen platform + Perp milestone')
check('_tmp/verify_wallet_foundation.py' in task8_readme and
      'src/scripts-order.txt' in task8_readme and
      'src/vendor/vendor-lock.json' in task8_readme,
      'Task 8 docs expose focused verification and exact script/vendor provenance')
check('SimulatedPrivyWalletAdapter' in task8_readme and
      '零网络请求' in task8_readme and '不执行签名' in task8_readme,
      'Task 8 docs preserve the offline Privy no-network/no-signing boundary')
check('Privy Wallet Actions' in task8_readme and 'BFF' in task8_readme and
      '生产接入' in task8_readme,
      'Task 8 docs describe the production Privy/BFF integration path')
check(not any(claim in '\n'.join((task8_readme, task8_findings)) for claim in (
          'Privy 自带确认 UI',
          'Privy also provides its own confirmation wallet UI',
          'LOOP must keep Privy confirmation enabled',
          'Privy native confirmation')) and
      all(claim in task8_readme for claim in (
          '客户端生成用户授权签名',
          'BFF 持有 app secret 并转发请求',
          '只有对应 Privy 官方路径实际提供认证或 MFA 时',
          '外部钱包保留它自己的最终确认',
          'F11 不替代这些 provider controls',
          '当前 Flutter/BFF 路径尚未接入')),
      'Task 8 docs do not invent Privy native confirmation and precisely '
      'separate embedded authorization, conditional MFA, and external confirmation')
check(all(term in task8_docs for term in (
    'A 档 47 屏', '全量 103 屏', 'Stream', 'Hyperliquid',
    '待实现', '全项目未完成')),
      'Task 8 docs keep authoritative scope and remaining A–I provider work pending')
check('C. Market 现货行情（9 屏' in task8_inventory and
      'C. Market 现货行情（11 屏' not in task8_inventory and
      'A 12, B 9, C 9, D 12, E 13, F 20, G 4, H 16, I 8' in
          task8_findings and
      not any(re.search(r'(?<!\d)(?:48|105)\s*屏', line)
              for text in ((ROOT / '文档' / name).read_text()
                           for name in (
                               '页面清单.md', '账号清单-对齐开发方.md',
                               '账号注册清单.md', '开发进度安排.md', '测试用例.md'))
              for line in text.splitlines()
              if not re.search(
                  r'(?:\bv\d+\.\d+\b|(?:48|105|113)\s*屏\s*→|'
                  r'初版（A 档 48 屏)', line, re.I)),
      'Task 8 all generated source docs use exact 103-screen module/current counts')
check(all(value in task8_findings for value in (
          'Task 8 pre-review deterministic evidence',
          '724e66cd544bd648bbc7b93d630d24178a8405318b051c75c67c51302ab2fb25',
          '22d4db7a2cd4e4288b5b8f0a8ec7a7d772bd6ffc68f62f7632c6e52713448ff8',
          'pre-review evidence, not a final checkpoint',
          'Task 8 post-remediation deterministic evidence',
          'd75037928a869336525f64717b537a864f04bc1017672d94f7534c8602b06d17',
          'post-remediation evidence, not a final checkpoint',
          'Task 8 quality-remediation deterministic evidence',
          '01ad6c2308eef401a90f1ee3e9d0f34c287600d42ca308b9ec308d9c7b1e7257',
          'quality-remediation evidence, not a final checkpoint',
          'Task 8 vendored-Marked remediation deterministic evidence',
          'd9122461ce1eee45de42252b5c0b96b84b6f994735eccd85fc54607b8b505a18',
          'vendored-Marked remediation evidence, not a final checkpoint',
          'Task 8 remains pending independent review',
          'global goal remains incomplete')),
      'Task 8 docs distinguish pre-review and every remediation deterministic '
      'hash without a final claim')

print('\n' + ('ALL PASS' if not fails else f'{len(fails)} FAILURES'))
for failure in fails:
    print(' -', failure)
sys.exit(1 if fails else 0)
