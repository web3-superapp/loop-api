#!/usr/bin/env python3
"""验证 docs.html：五份文档都能渲染、切换正常、表格与中文完整。"""
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGE = ROOT / 'docs.html'
URL = PAGE.as_uri()
fails = []


def check(c, m):
    print(('  ok   ' if c else '  FAIL ') + m)
    if not c:
        fails.append(m)


def read(relative):
    return (ROOT / relative).read_text()


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def strict_json_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f'duplicate key: {key}')
        value[key] = item
    return value


def prepare_docs_build_case(case_root):
    shutil.copy2(ROOT / 'build_docs.py', case_root / 'build_docs.py')
    shutil.copy2(ROOT / 'index.html', case_root / 'index.html')
    shutil.copytree(ROOT / '文档', case_root / '文档')
    shutil.copytree(ROOT / 'docs_vendor', case_root / 'docs_vendor')


def run_docs_build_case(case_root):
    result = subprocess.run(
        [sys.executable, 'build_docs.py'], cwd=case_root,
        text=True, capture_output=True, check=False)
    check(result.returncode == 0,
          f'隔离 build_docs 成功：{(result.stderr or result.stdout).strip()}')
    output = case_root / 'docs.html'
    return output.read_bytes() if output.exists() else b''


def current_claim_lines(text):
    """Exclude explicitly historical migration/changelog rows from current claims."""
    return '\n'.join(
        line for line in text.splitlines()
        if not re.search(r'(?:变更记录|\bv\d+\.\d+\b|\d+\s*(?:屏|屏幕)\s*→)', line, re.I)
    )


print('== Task 8 文档事实契约 ==')
readme = read('README.md')
inventory = read('文档/页面清单.md')
schedule = read('文档/开发进度安排.md')
findings_doc = read('findings.md')
build_docs_source = read('build_docs.py')
docs_vendor_lock_path = ROOT / 'docs_vendor' / 'vendor-lock.json'
expected_docs_vendor = {
    'name': 'marked',
    'version': '18.0.10',
    'license': 'MIT',
    'npm_integrity':
        'sha512-FJeH4bRpYoXiggcgriCGItKCSv3xkngJc4QCZ/rkQCogU3VYaLxYJoZl8Nw/'
        'b4+x7iij/pd+09mZ6A1dXzpL0A==',
    'source': 'https://registry.npmjs.org/marked/-/marked-18.0.10.tgz',
    'file': 'docs_vendor/marked-18.0.10.umd.js',
    'sha256': 'eaccee2fb9fb3b2c09e873a5504da82507850d9e677bd720122ac49e2a03982a',
    'license_file': 'docs_vendor/marked.LICENSE.md',
    'license_sha256':
        '8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c',
}
try:
    docs_vendor_lock = json.loads(
        docs_vendor_lock_path.read_text(), object_pairs_hook=strict_json_object)
except (OSError, ValueError):
    docs_vendor_lock = None
marked_vendor_path = ROOT / expected_docs_vendor['file']
marked_license_path = ROOT / expected_docs_vendor['license_file']
check(docs_vendor_lock == expected_docs_vendor,
      f'docs Marked vendor lock 精确固定官方 npm 18.0.10：{docs_vendor_lock}')
check(marked_vendor_path.is_file() and
      sha256(marked_vendor_path) == expected_docs_vendor['sha256'],
      'docs Marked UMD 字节与 lock SHA-256 一致')
check(marked_license_path.is_file() and
      sha256(marked_license_path) == expected_docs_vendor['license_sha256'],
      'docs Marked MIT LICENSE 字节与 lock SHA-256 一致')
page_source = PAGE.read_text()
marked_script = re.search(
    r'<script id="marked-vendor">(.*?)</script>', page_source, re.S)
expected_marked_payload = re.sub(
    r'</script(?=[\t\n\f\r />])', r'<\\/script',
    marked_vendor_path.read_text() if marked_vendor_path.is_file() else '',
    flags=re.I)
check('cdn.jsdelivr.net/npm/marked' not in build_docs_source and
      'cdn.jsdelivr.net/npm/marked' not in page_source and
      marked_script and marked_script.group(1) == expected_marked_payload,
      'docs.html 使用本地固定 Marked 字节，不依赖 CDN')
generated_doc_names = re.findall(
    r"^\s*\('([^']+\.md)',", build_docs_source, re.M)
generated_source_docs = {
    name: read(f'文档/{name}') for name in generated_doc_names
}
manifest = [line.strip() for line in read('src/screens-order.txt').splitlines()
            if line.strip()]
expected_screen_manifest = [
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
current_docs = current_claim_lines('\n'.join((
    readme, inventory, schedule, findings_doc)))

with tempfile.TemporaryDirectory(prefix='loop-docs-sync-') as temp:
    sync_root = pathlib.Path(temp)
    prepare_docs_build_case(sync_root)
    expected_docs_bytes = run_docs_build_case(sync_root)
check(PAGE.read_bytes() == expected_docs_bytes,
      f'docs.html 与当前 Markdown/build_docs.py 字节同步'
      f'（{len(PAGE.read_bytes())}/{len(expected_docs_bytes)} bytes）')
with tempfile.TemporaryDirectory(prefix='loop-docs-source-mutation-') as temp:
    mutation_root = pathlib.Path(temp)
    prepare_docs_build_case(mutation_root)
    mutation_path = mutation_root / '文档' / '页面清单.md'
    mutation_path.write_text(
        mutation_path.read_text() + '\nQUALITY_REVIEW_SOURCE_SENTINEL\n')
    source_mutation_bytes = run_docs_build_case(mutation_root)
check(source_mutation_bytes != PAGE.read_bytes() and
      expected_docs_bytes + b'\nQUALITY_REVIEW_GENERATED_TAMPER\n' !=
          expected_docs_bytes,
      '源 Markdown 未重建与生成物篡改均可被 byte-sync 门禁检出')

vendor_gate_results = {}
for case_name, relative in (
        ('bundle', expected_docs_vendor['file']),
        ('license', expected_docs_vendor['license_file']),
        ('lock', 'docs_vendor/vendor-lock.json')):
    with tempfile.TemporaryDirectory(prefix=f'loop-docs-{case_name}-tamper-') as temp:
        tamper_root = pathlib.Path(temp)
        prepare_docs_build_case(tamper_root)
        tamper_path = tamper_root / relative
        tamper_path.write_bytes(tamper_path.read_bytes() + b'\nTAMPER\n')
        result = subprocess.run(
            [sys.executable, 'build_docs.py'], cwd=tamper_root,
            text=True, capture_output=True, check=False)
        vendor_gate_results[case_name] = {
            'exit': result.returncode,
            'output': (result.stderr or result.stdout).strip(),
            'generated': (tamper_root / 'docs.html').exists(),
        }
check(all(result['exit'] != 0 and not result['generated']
          for result in vendor_gate_results.values()),
      f'Marked bundle/license/lock 篡改在生成前 fail closed：'
      f'{vendor_gate_results}')

lock_boundary_results = {}
with tempfile.TemporaryDirectory(prefix='loop-docs-duplicate-lock-') as temp:
    duplicate_root = pathlib.Path(temp)
    prepare_docs_build_case(duplicate_root)
    duplicate_lock = duplicate_root / 'docs_vendor' / 'vendor-lock.json'
    duplicate_lock.write_text(duplicate_lock.read_text().replace(
        '{', '{\n  "name": "attacker-visible-alternate",', 1))
    result = subprocess.run(
        [sys.executable, 'build_docs.py'], cwd=duplicate_root,
        text=True, capture_output=True, check=False)
    lock_boundary_results['duplicate_key'] = {
        'exit': result.returncode,
        'generated': (duplicate_root / 'docs.html').exists(),
        'output': (result.stderr or result.stdout).strip(),
    }
with tempfile.TemporaryDirectory(prefix='loop-docs-external-lock-case-') as temp, \
        tempfile.TemporaryDirectory(prefix='loop-docs-external-lock-target-') as outside:
    external_root = pathlib.Path(temp)
    prepare_docs_build_case(external_root)
    external_lock = pathlib.Path(outside) / 'vendor-lock.json'
    lock_path = external_root / 'docs_vendor' / 'vendor-lock.json'
    shutil.copy2(lock_path, external_lock)
    lock_path.unlink()
    lock_path.symlink_to(external_lock)
    result = subprocess.run(
        [sys.executable, 'build_docs.py'], cwd=external_root,
        text=True, capture_output=True, check=False)
    lock_boundary_results['external_symlink'] = {
        'exit': result.returncode,
        'generated': (external_root / 'docs.html').exists(),
        'output': (result.stderr or result.stdout).strip(),
    }
with tempfile.TemporaryDirectory(prefix='loop-docs-internal-lock-case-') as temp:
    internal_root = pathlib.Path(temp)
    prepare_docs_build_case(internal_root)
    lock_path = internal_root / 'docs_vendor' / 'vendor-lock.json'
    internal_lock = lock_path.with_name('internal-lock-copy.json')
    shutil.copy2(lock_path, internal_lock)
    lock_path.unlink()
    lock_path.symlink_to(internal_lock.name)
    result = subprocess.run(
        [sys.executable, 'build_docs.py'], cwd=internal_root,
        text=True, capture_output=True, check=False)
    lock_boundary_results['internal_symlink'] = {
        'exit': result.returncode,
        'generated': (internal_root / 'docs.html').exists(),
        'output': (result.stderr or result.stdout).strip(),
    }
check(all(result['exit'] != 0 and not result['generated']
          for result in lock_boundary_results.values()),
      f'Marked lock 拒绝 duplicate key 与 internal/external symlink，'
      f'且不生成 docs.html：{lock_boundary_results}')

schema_results = {}
for case_name, mutate in (
        ('non_object', lambda _value: []),
        ('extra_key', lambda value: {**value, 'unexpected': True}),
        ('missing_key', lambda value: {
            key: item for key, item in value.items() if key != 'license'})):
    with tempfile.TemporaryDirectory(prefix=f'loop-docs-lock-{case_name}-') as temp:
        schema_root = pathlib.Path(temp)
        prepare_docs_build_case(schema_root)
        lock_path = schema_root / 'docs_vendor' / 'vendor-lock.json'
        lock_value = json.loads(
            lock_path.read_text(), object_pairs_hook=strict_json_object)
        lock_path.write_text(json.dumps(mutate(lock_value), indent=2) + '\n')
        result = subprocess.run(
            [sys.executable, 'build_docs.py'], cwd=schema_root,
            text=True, capture_output=True, check=False)
        schema_results[case_name] = {
            'exit': result.returncode,
            'generated': (schema_root / 'docs.html').exists(),
        }
check(all(result['exit'] != 0 and not result['generated']
          for result in schema_results.values()),
      f'Marked lock 拒绝 non-object/额外/缺失 schema：{schema_results}')

locked_file_symlink_results = {}
for file_label, relative in (
        ('bundle', expected_docs_vendor['file']),
        ('license', expected_docs_vendor['license_file'])):
    with tempfile.TemporaryDirectory(
            prefix=f'loop-docs-{file_label}-internal-link-') as temp:
        link_root = pathlib.Path(temp)
        prepare_docs_build_case(link_root)
        locked_path = link_root / relative
        internal_copy = locked_path.with_name(locked_path.name + '.copy')
        shutil.copy2(locked_path, internal_copy)
        locked_path.unlink()
        locked_path.symlink_to(internal_copy.name)
        result = subprocess.run(
            [sys.executable, 'build_docs.py'], cwd=link_root,
            text=True, capture_output=True, check=False)
        locked_file_symlink_results[f'{file_label}_internal'] = {
            'exit': result.returncode,
            'generated': (link_root / 'docs.html').exists(),
        }
    with tempfile.TemporaryDirectory(
            prefix=f'loop-docs-{file_label}-external-link-') as temp, \
            tempfile.TemporaryDirectory(
                prefix=f'loop-docs-{file_label}-external-target-') as outside:
        link_root = pathlib.Path(temp)
        prepare_docs_build_case(link_root)
        locked_path = link_root / relative
        external_copy = pathlib.Path(outside) / locked_path.name
        shutil.copy2(locked_path, external_copy)
        locked_path.unlink()
        locked_path.symlink_to(external_copy)
        result = subprocess.run(
            [sys.executable, 'build_docs.py'], cwd=link_root,
            text=True, capture_output=True, check=False)
        locked_file_symlink_results[f'{file_label}_external'] = {
            'exit': result.returncode,
            'generated': (link_root / 'docs.html').exists(),
        }
check(all(result['exit'] != 0 and not result['generated']
          for result in locked_file_symlink_results.values()),
      f'Marked bundle/license 拒绝 internal/external symlink：'
      f'{locked_file_symlink_results}')

check(manifest == expected_screen_manifest and len(set(manifest)) == 42,
      f'生成屏 manifest 是精确 42 个唯一有序项（{len(manifest)}）')
check('42 个 routed screen fragments' in readme and
      '42-screen routed manifest' in findings_doc,
      'README/findings 当前生成口径是 42 屏')
for name, source in (
        ('README', readme), ('页面清单', inventory), ('开发进度安排', schedule)):
    check(all(term in source for term in (
        'Stream E1–E4 final semantic composition',
        '37 screens / 10 scripts',
        '42 screens / 12 scripts',
        'Stream Chat/Video',
        'disconnected/unavailable/count 0',
        'RTC/presence',
        'Token Card → Buy → Swap → F11 → Privy',
        'Hyperliquid D1–D7')),
        f'{name} 记录最终 Stream/Perp 组合边界且不回退 30/8')
check(all(term in current_docs for term in (
    'F3–F5', 'F12', '待实现')),
      '新增 transfer/result 路由仅为结构壳，F3–F5/F12 仍显式待实现')
check(all(term in inventory for term in (
    '`#send` = `wallet → send`',
    '`#send-to` = `wallet → send → send-to`',
    '`#send-confirm` = `wallet → send → send-to → send-confirm`',
    '`#tx-result` = `wallet → tx-result`',
    'F5 进入 F11 时仍保留完整',
    'F12 是独立结果入口')) and '扁平两级表' not in current_claim_lines(inventory),
      '页面清单精确记录当前 canonical transfer/result stacks 与 F11 来源')
check('A 档 47 屏' in current_docs and '全量 103 屏' in current_docs and
      not re.search(r'当前[^\n]*(?:A 档 48 屏|全量 105 屏)', current_docs),
      '当前权威范围为 A 档 47 / 全量 103')
check('48 → 47' in inventory and '105 → 103' in inventory,
      '历史变更记录保留 48→47 / 105→103')
check('105 小时审核预算' in schedule,
      '105 小时仅作审核时间单位保留')
check('_tmp/verify_wallet_foundation.py' in readme and
      'src/screens-order.txt' in readme and 'src/scripts-order.txt' in readme and
      'src/vendor/vendor-lock.json' in readme and
      'docs_vendor/vendor-lock.json' in readme and 'marked@18.0.10' in readme,
      '文档指向 focused verifier 与 manifest/vendor 来源')
check('SimulatedPrivyWalletAdapter' in readme and
      '零网络请求' in readme and '不执行签名' in readme,
      '文档明确 offline Privy 模拟、no-network/no-signing 里程碑')
check('Privy Wallet Actions' in readme and 'BFF' in readme and
      '生产接入' in readme,
      '文档记录生产 Privy/BFF 集成边界')
forbidden_confirmation_claims = (
    'Privy 自带确认 UI',
    'Privy also provides its own confirmation wallet UI',
    'LOOP must keep Privy confirmation enabled',
    'Privy native confirmation',
)
check(not any(claim in '\n'.join((readme, findings_doc))
              for claim in forbidden_confirmation_claims),
      '文档不虚构 Privy native/always-on confirmation UI')
check(all(claim in readme for claim in (
    '客户端生成用户授权签名',
    'BFF 持有 app secret 并转发请求',
    '只有对应 Privy 官方路径实际提供认证或 MFA 时',
    '外部钱包保留它自己的最终确认',
    'F11 不替代这些 provider controls',
    '当前 Flutter/BFF 路径尚未接入',
)), '生产 embedded/external/provider-control 口径精确')
check(all(term in current_docs for term in (
    'Stream', 'Hyperliquid', '待实现', '全项目未完成')),
      '剩余 A–I 与 Stream/Hyperliquid 显式 pending/in progress')

expected_modules = {
    'A': (8, 4, 0, 12, 0), 'B': (4, 4, 1, 9, 2),
    'C': (4, 5, 0, 9, 2), 'D': (7, 5, 0, 12, 0),
    'E': (6, 5, 2, 13, 3), 'F': (9, 9, 2, 20, 4),
    'G': (1, 0, 3, 4, 1), 'H': (4, 10, 2, 16, 1),
    'I': (4, 4, 0, 8, 1),
}
summary_rows = {}
for match in re.finditer(
        r'^\| ([A-I]) [^|]+ \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|$',
        inventory, re.M):
    summary_rows[match.group(1)] = tuple(map(int, match.groups()[1:]))
heading_totals = {
    match.group(1): int(match.group(2))
    for match in re.finditer(r'^## ([A-I])\. .+?（(\d+) 屏', inventory, re.M)
}
check(summary_rows == expected_modules and
      sum(row[0] for row in summary_rows.values()) == 47 and
      sum(row[1] for row in summary_rows.values()) == 46 and
      sum(row[2] for row in summary_rows.values()) == 10 and
      sum(row[3] for row in summary_rows.values()) == 103 and
      sum(row[4] for row in summary_rows.values()) == 14,
      f'模块分解精确汇总为 47/46/10/103/14：{summary_rows}')
check(heading_totals == {key: value[3]
                         for key, value in expected_modules.items()},
      f'各模块正文标题与汇总小计一致：{heading_totals}')
check('A 12, B 9, C 9, D 12, E 13, F 20, G 4, H 16, I 8' in
      findings_doc,
      'findings 模块分解相加为权威全量 103')


def historical_scope_line(line):
    return bool(re.search(
        r'(?:\bv\d+\.\d+\b|(?:48|105|113)\s*屏\s*→|'
        r'初版（A 档 48 屏)', line, re.I))


nonhistorical_generated_lines = '\n'.join(
    line
    for text in generated_source_docs.values()
    for line in text.splitlines()
    if not historical_scope_line(line)
)
stale_current_counts = re.findall(
    r'[^\n]*(?<!\d)(?:48|105)\s*屏[^\n]*', nonhistorical_generated_lines)
check(not stale_current_counts,
      f'所有 generated source docs 无非历史 48/105 屏口径：{stale_current_counts}')
scope_sources = {
    'README.md': readme,
    'findings.md': findings_doc,
    **{f'文档/{name}': text
       for name, text in generated_source_docs.items()},
}
stale_scope_claims = [
    (name, number, line)
    for name, text in scope_sources.items()
    for number, line in enumerate(text.splitlines(), 1)
    if not historical_scope_line(line) and
       re.search(r'(?<!\d)(?:48|105)\s*屏', line)
]
check(not stale_scope_claims,
      f'README/findings/全部 generated source docs 拒绝非历史旧口径：'
      f'{stale_scope_claims}')
check('48 屏 → **47 屏**' in inventory and
      '105 屏 → **103 屏**' in inventory and
      '105 小时审核预算' in schedule,
      '历史迁移与 105 小时预算仍在精确 allowlist')

app_pre_review_hash = \
    '724e66cd544bd648bbc7b93d630d24178a8405318b051c75c67c51302ab2fb25'
docs_pre_review_hash = \
    '22d4db7a2cd4e4288b5b8f0a8ec7a7d772bd6ffc68f62f7632c6e52713448ff8'
docs_post_remediation_hash = \
    'd75037928a869336525f64717b537a864f04bc1017672d94f7534c8602b06d17'
docs_quality_remediation_hash = \
    '01ad6c2308eef401a90f1ee3e9d0f34c287600d42ca308b9ec308d9c7b1e7257'
docs_vendored_marked_hash = \
    'd9122461ce1eee45de42252b5c0b96b84b6f994735eccd85fc54607b8b505a18'
task1_app_hash = \
    '6d8c32500967849c30e168cfe4b3921192755a914c838f7660b5b6b2f65ed55b'
task1_docs_hash = \
    '885ea8761cb11068ab4e0a486394d4d1cb68e1f711ef50d7dd200f5c7d6a1bb9'
task1_quality_remediation_app_hash = \
    '906e362ee659e95b4169302879959c87a100231a41fbe7e03dad2393b150366f'
task1_post_spec_fix_app_hash = \
    '9553b2b354189b61c99be967d57ec0822e5d9d85277333ed3268ffd589fde153'
stream_v5_integrated_app_hash = \
    'fc4041d2dfe986c34eedb0ac3f8fac2b2bfb73cf008b0e50c5dd60a63b169225'
task1_current_docs_hash = \
    'b33545479c1943a97aa4543c3261e25d675764bdfb3fbb53af16131de66ee61b'
platform_current_app_hash = \
    '72fd05c78c92e3a25a846bb051f9880d695c5524a6e1802a76fa284c2ef15685'
platform_current_docs_hash = \
    '3d1b82f6f5492f709d3f60ecef3cb824cfac7dafdd19b5668a2d12465d3e1278'
hyper_ui_v2_current_app_hash = \
    '14b57bc4b2cac17519610a59037644f0e181e61cef3a2bfee3eade495ecc2d20'
hyper_ui_v2_current_docs_hash = \
    '15bb130fe2f0da6bf9960eaa423fd647f9353dfd4073fd673ae150eb7b77c4ce'
hyper_ui_v3_current_app_hash = \
    '2502772768ed9eea6bf2c868cd5140a57deba1d9235540fb2d7c698a5e3035dd'
hyper_ui_v3_current_docs_hash = \
    '79ef411256a22c457afd56bd330eaabd5ab240878d7adaa79f7d2537dbc8299c'
hyper_ui_v4_current_app_hash = \
    'd082412728b8a5810ed9bb70c199e1f77bad3e41e706c54323a2dc375c4e5cdc'
hyper_ui_v4_current_docs_hash = \
    'ce566b596dad1945769440a911545bf2e935989d67d6acf81096ea969319e23b'
hyper_ui_v5_current_app_hash = \
    'c177387b397ee386ed2582427c2ad64e3e74027fb36b7a6963fd10a159a9abfa'
hyper_ui_v5_current_docs_hash = \
    'ad93bbe1bd6d8fb6d99e2d4df2fc4015a2a795a0ce7c94b8ce5b1a62a2187b4f'
stream_final_current_app_hash = \
    'e00bff543b5c5e4dce0b0dcaf5751499b5660f81fee32b9ce5d7f5b29cefaade'
stream_final_current_docs_hash = \
    '2a02ecb0bd4977608d9d3214fd03dbaaf87eb86bfa0f897599bd268d0f50b20b'
hyper_account_final_app_hash = \
    '087531b07fa2eea0b3755a8ea0143eabc7c9a620f0177ebf3f64f2cced8f4cd3'
hyper_account_final_docs_hash = \
    '1947b1674216ed66aa640f32563846f348231f805cc0a096e3e3b8ddc8859092'
hashes_in_findings = re.findall(r'\b[a-f0-9]{64}\b', findings_doc)
actual_app_hash = sha256(ROOT / 'app.html')
actual_docs_hash = sha256(PAGE)
check(actual_app_hash == hyper_account_final_app_hash and
      actual_docs_hash == hyper_account_final_docs_hash and
      task1_quality_remediation_app_hash != task1_post_spec_fix_app_hash and
      app_pre_review_hash in findings_doc and
      docs_pre_review_hash in findings_doc and
      docs_post_remediation_hash in findings_doc and
      docs_quality_remediation_hash in findings_doc and
      docs_vendored_marked_hash in findings_doc and
      task1_app_hash in findings_doc and
      task1_docs_hash in findings_doc and
      task1_quality_remediation_app_hash in findings_doc and
      task1_post_spec_fix_app_hash in findings_doc and
      stream_v5_integrated_app_hash in findings_doc and
      task1_current_docs_hash in findings_doc and
      platform_current_app_hash in findings_doc and
      platform_current_docs_hash in findings_doc and
      hyper_ui_v2_current_app_hash in findings_doc and
      hyper_ui_v2_current_docs_hash in findings_doc and
      hyper_ui_v3_current_app_hash in findings_doc and
      hyper_ui_v3_current_docs_hash in findings_doc and
      hyper_ui_v4_current_app_hash in findings_doc and
      hyper_ui_v4_current_docs_hash in findings_doc and
      hyper_ui_v5_current_app_hash in findings_doc and
      hyper_ui_v5_current_docs_hash in findings_doc and
      stream_final_current_app_hash in findings_doc and
      stream_final_current_docs_hash in findings_doc and
      hyper_account_final_app_hash in findings_doc and
      hyper_account_final_docs_hash in findings_doc and
      set(hashes_in_findings) >= {
          app_pre_review_hash, docs_pre_review_hash, docs_post_remediation_hash,
          docs_quality_remediation_hash, docs_vendored_marked_hash,
          task1_app_hash, task1_docs_hash,
          task1_quality_remediation_app_hash, task1_post_spec_fix_app_hash,
          stream_v5_integrated_app_hash, task1_current_docs_hash,
          platform_current_app_hash,
          platform_current_docs_hash,
          hyper_ui_v2_current_app_hash,
          hyper_ui_v2_current_docs_hash,
          hyper_ui_v3_current_app_hash,
          hyper_ui_v3_current_docs_hash,
          hyper_ui_v4_current_app_hash,
          hyper_ui_v4_current_docs_hash,
          hyper_ui_v5_current_app_hash,
          hyper_ui_v5_current_docs_hash,
          stream_final_current_app_hash,
          stream_final_current_docs_hash,
          hyper_account_final_app_hash,
          hyper_account_final_docs_hash} and
      all(term in findings_doc for term in (
          'Task 8 pre-review deterministic evidence',
          'pre-review evidence, not a final checkpoint',
          'Task 8 post-remediation deterministic evidence',
          'post-remediation evidence, not a final checkpoint',
          'Task 8 quality-remediation deterministic evidence',
          'quality-remediation evidence, not a final checkpoint',
          'Task 8 vendored-Marked remediation deterministic evidence',
          'vendored-Marked remediation evidence, not a final checkpoint',
          'Task 8 remains pending independent review',
          'Task 1 route-shell checkpoint deterministic evidence',
          'route-shell checkpoint, not F3–F5/F12 implementation',
          'Task 1 route-shell quality remediation deterministic evidence',
          'quality remediation, not F3–F5/F12 implementation',
          'Task 1 route-shell post-spec-fix deterministic evidence',
          'post-spec-fix checkpoint, not F3–F5/F12 implementation',
          'Stream v5 build integration deterministic evidence',
          'production seam checkpoint, not a connected Stream provider',
          'App-wide platform/UI candidate deterministic evidence',
          'Stream E1–E4 platform-rebased v4 checkpoint',
          'Stream Chat/Video as the sole communication authority',
          'offline audio only as disconnected/unavailable with count 0',
          'Home static live/host/listener claims',
          'not credentialed production provider delivery',
          'Hyperliquid Core Perp UI v2 candidate deterministic evidence',
          'not credentialed production order execution',
          'Hyperliquid Core Perp UI v3 remediation evidence',
          'v2 candidate above was rejected by independent audit',
          'Hyperliquid Core Perp UI v4 deep-DTO remediation evidence',
          'v3 candidate above was rejected by independent audit',
          'Hyperliquid Core Perp UI v5 mutation-decision remediation evidence',
          'v4 candidate above was rejected by independent audit',
          'Stream E1–E4 final semantic composition evidence',
          'final Stream semantic composition on the audited Hyperliquid v5 main line',
          'exact production manifest remains 37 screens / 10 scripts',
          'Hyperliquid D8–D12 post-Stream final candidate evidence',
          'exact combined manifest is 42 screens / 12 scripts',
          'global goal remains incomplete')),
      f'历史 checkpoint SHA-256 已区分，当前 D8–D12 post-Stream app/docs hash '
      f'与对应记录一致：{actual_app_hash}/{actual_docs_hash}')

body_rows = [
    (match.group(1), match.group(2))
    for match in re.finditer(
        r'^\| ([A-I]\d+) \|.*?\| ([ABC]) \|', inventory, re.M)
]
body_priority_counts = {
    module: tuple(
        sum(1 for code, priority in body_rows
            if code.startswith(module) and priority == tier)
        for tier in 'ABC')
    for module in 'ABCDEFGHI'
}
expected_body_priorities = {
    module: values[:3] for module, values in expected_modules.items()
}
check(len(body_rows) == 103 and len({code for code, _ in body_rows}) == 103 and
      body_priority_counts == expected_body_priorities,
      f'正文 103 个唯一条目的档位与汇总一致：'
      f'{len(body_rows)}/{body_priority_counts}')
scope_table = dict(re.findall(
    r'^\| \*\*([ABC])\*\* \|[^|]+\| ([^|]+) \|$', inventory, re.M))
check('只画 A 档' in inventory and scope_table == {
          'A': '✅ 必画',
          'B': '❌ 本次只列清单',
          'C': '❌ 本次只列清单',
      }, f'HTML 范围声明与 A/B/C 表格一致：{scope_table}')
check('### 4.7 F Wallet（A 档 9 屏；签名授权见第二章）' in
      generated_source_docs['测试用例.md'],
      '测试用例 F Wallet 与权威汇总 A 档 9 / 总计 20 一致')
check('原 E6「高风险合约拦截条」是 E5 的高风险状态变体' in inventory and
      'E5 的高风险状态（原 E6 拦截条）' in inventory and
      '原 E6 为 E5 高风险状态' in schedule and
      not any(term in '\n'.join((inventory, schedule)) for term in (
          'E6（拦截条）和 E7', '、E6 高风险拦截条')),
      'E6 统一为 E5 高风险状态，不再声明独立组件')


with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1440, 'height': 960})
    errs = []
    browser_requests = []
    pg.on('request', lambda request: browser_requests.append(request.url))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(f'pageerror: {e}'))

    pg.goto(URL)
    pg.wait_for_load_state('networkidle')
    pg.wait_for_timeout(600)

    print('== 骨架 ==')
    check(not any(url.startswith(('http://', 'https://'))
                  for url in browser_requests) and
          pg.evaluate("() => typeof marked?.setOptions === 'function' && "
                      "typeof marked?.parse === 'function'"),
          '正常渲染运行内嵌的真实固定 Marked bundle（零网络）')
    check(pg.locator('#docNav a').count() == 5, '侧栏 5 个文档入口')
    check(not errs, f'无 JS 错误: {errs[:3]}')

    print('\n== 逐份渲染 ==')
    EXPECT = [
        (0, '页面清单', ['103', 'A 档', 'Perp', '语音房']),
        (1, '账号清单（对齐开发）', ['D-U-N-S', 'builder code', 'Stream', 'Privy']),
        (2, '账号清单（完整背景）', ['腾讯云', 'MoonPay', 'Alchemy', 'GoPlus']),
        (3, '开发进度安排', ['Go/No-Go', '105', '审核', '第 1 周']),
        (4, '测试用例', ['TC-D01', '复算', 'P0', '强平价']),
    ]
    for i, label, needles in EXPECT:
        pg.locator(f'#docNav a[data-i="{i}"]').click()
        pg.wait_for_timeout(400)
        txt = pg.evaluate("() => document.getElementById('content').innerText")
        h2 = pg.locator('#content h2').count()
        tables = pg.locator('#content .table-wrap table').count()
        missing = [n for n in needles if n not in txt]
        check(len(txt) > 2000 and not missing,
              f'[{label}] 长度 {len(txt)}, h2 {h2}, 表格 {tables}, 缺失 {missing}')
        check(tables > 0, f'[{label}] 表格已包 .table-wrap（可横向滚动）')
        check(pg.locator('#toc a').count() > 0, f'[{label}] 生成了本篇目录')

    print('\n== 无 Marked API 时的降级 ==')
    pg2 = b.new_page()
    pg2.goto(URL)
    pg2.evaluate("() => { globalThis.marked = undefined; }")
    pg2.locator('#docNav a[data-i="1"]').click()
    pg2.wait_for_timeout(200)
    raw = pg2.locator('#content > pre').text_content()
    check(pg2.locator('#content > pre').count() == 1 and '# 账号清单' in raw,
          f'Marked API 不可用仍显示 textContent 原文（{len(raw)} 字符）')
    pg2.close()

    print('\n== Marked API/parse 安全降级 ==')
    for label, mutation in (
            ('API 不兼容',
             "() => { globalThis.marked = {setOptions() {}}; }"),
            ('parse 异常',
             "() => { globalThis.marked = {setOptions() {}, parse() { "
             "throw new Error('fixture parse failure'); }}; }"),
            ('parse 返回非字符串',
             "() => { globalThis.marked = {setOptions() {}, parse() { "
             "return {html: '<p>not trusted</p>'}; }}; }"),
            ('parse 返回 Promise',
             "() => { globalThis.marked = {setOptions() {}, parse() { "
             "return Promise.resolve('<p>async</p>'); }}; }")
    ):
        fallback_page = b.new_page()
        fallback_errors = []
        fallback_page.on('pageerror', lambda e, errors=fallback_errors:
                         errors.append(str(e)))
        fallback_page.goto(URL)
        fallback_page.evaluate(mutation)
        fallback_page.locator('#docNav a[data-i="1"]').click()
        fallback_page.wait_for_timeout(200)
        fallback_text = fallback_page.locator('#content > pre').text_content()
        fallback_pre_count = fallback_page.locator('#content > pre').count()
        check(fallback_pre_count == 1 and
              '# 账号清单' in fallback_text and not fallback_errors,
              f'Marked {label}时使用 textContent 原文安全降级：'
              f'pre={fallback_pre_count}, chars={len(fallback_text)}, '
              f'prefix={fallback_text[:40]!r}, errors={fallback_errors}')
        fallback_page.close()

    print('\n== build_docs raw-text 注入回归 ==')
    with tempfile.TemporaryDirectory(prefix='loop-docs-injection-') as temp:
        injection_root = pathlib.Path(temp)
        prepare_docs_build_case(injection_root)
        injection_doc = injection_root / '文档' / '页面清单.md'
        injection_doc.write_text(
            injection_doc.read_text() +
            "\n</SCRIPT><script>globalThis.__DOC_BUILD_INJECTION__='executed'"
            "</SCRIPT>\n")
        injection_bytes = run_docs_build_case(injection_root)
        injection_page = injection_root / 'docs.html'
        pg3 = b.new_page()
        pg3.goto(injection_page.as_uri())
        pg3.wait_for_timeout(300)
        executed = pg3.evaluate(
            "() => globalThis.__DOC_BUILD_INJECTION__ === 'executed'")
        check(not executed and
              re.search(rb'<\\/script><script>', injection_bytes, re.I) and
              not re.search(rb'</script><script>', injection_bytes, re.I),
              'build_docs 大小写无关转义 raw-text 结束标签，sentinel 不执行')
        pg3.close()

    print('\n== 深链与移动端 ==')
    pg.goto(f'{URL}#3')
    pg.wait_for_load_state('networkidle')
    pg.wait_for_timeout(500)
    t = pg.evaluate("() => document.getElementById('content').innerText")
    check('开发进度' in t or 'Go/No-Go' in t, '#3 深链直达开发进度安排')

    pg.set_viewport_size({'width': 390, 'height': 844})
    pg.wait_for_timeout(300)
    check(pg.locator('#docSelect').is_visible(), '窄屏显示文档下拉选择器')
    check(not pg.locator('aside').is_visible(), '窄屏隐藏侧栏')
    ow = pg.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check(ow <= 1, f'窄屏无横向溢出（溢出 {ow}px）')

    b.close()

print('\n' + ('全部通过' if not fails else f'{len(fails)} 项失败:'))
for f in fails:
    print(' -', f)
sys.exit(1 if fails else 0)
