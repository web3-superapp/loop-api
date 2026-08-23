#!/usr/bin/env python3
"""Focused verifier for the wallet-transfer route-shell foundation."""
import hashlib
from html.parser import HTMLParser
import json
import copy
import os
import pathlib
import re
import stat
import shutil
import subprocess
import sys
import tempfile
from platform_policy_test_app import production_policy_test_app

CONTRACT_ONLY = sys.argv[1:] == ['--contract-only']
if sys.argv[1:] and not CONTRACT_ONLY:
    raise SystemExit('usage: verify_wallet_transfer.py [--contract-only]')
if not CONTRACT_ONLY:
    from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
APP = ROOT / 'app.html'
RUNTIME_APP = production_policy_test_app(ROOT) if not CONTRACT_ONLY else APP
SCREENS = [
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
SCRIPTS = ['vendor/qrcode-generator-1.4.4.js', 'wallet-provider.js',
           'wallet-review.js', 'wallet-transfer.js', 'stream-chat-provider.js',
           'platform-provider.js', 'platform-offline-fixture.js',
           'perp-read-provider.js', 'perp-offline-fixture.js',
           'perp-account-provider.js', 'perp-account-offline-fixture.js', 'app.js']
SHELLS = ('send', 'send-to', 'send-confirm', 'tx-result')
CANONICAL_STACKS = {
    'send': ['scr-wallet', 'scr-send'],
    'send-to': ['scr-wallet', 'scr-send', 'scr-send-to'],
    'send-confirm': ['scr-wallet', 'scr-send', 'scr-send-to', 'scr-send-confirm'],
    'tx-result': ['scr-wallet', 'scr-tx-result'],
}
AST_SCANNER = ROOT / '_tmp/js_ast_call_model.js'
ACORN = ROOT / '_tmp/vendor/acorn-8.15.0/acorn.js'
ACORN_LICENSE = ROOT / '_tmp/vendor/acorn-8.15.0/LICENSE'
AST_SHA256 = '2854f7865b63218249ac622e70339a8a2450c253400db30c53c50a032c9c0624'
ACORN_SHA256 = 'fdb08546776ec6228b03e8d02b40d4ab3255bae5f401adba7ff5dad927ac5c9c'
ACORN_LICENSE_SHA256 = '76a876cf886ff9be2a8b5e2e86514fed06223c8c9f0c1e9ee9606e93841e00b7'
CONTRACT = ROOT / 'contracts/privy-transfer'
CONTRACT_FILES = (
    'README.md',
    'bff-contract.json',
    'dependency-lock.json',
    'fixtures/flutter-authorization-signature.json',
    'fixtures/provenance.json',
    'fixtures/wallet-api-payload-v1.canonical.bin.sha256',
    'fixtures/wallet-api-payload-v1.json',
)
JSON_CONTRACT_FILES = (
    'bff-contract.json',
    'dependency-lock.json',
    'fixtures/flutter-authorization-signature.json',
    'fixtures/provenance.json',
    'fixtures/wallet-api-payload-v1.json',
)
fails = []


def check(condition, message):
    print(('  ok   ' if condition else '  FAIL ') + message)
    if not condition:
        fails.append(message)


def lines(path):
    return path.read_text().splitlines() if path.is_file() else []


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


class ShellSecurityParser(HTMLParser):
    RESOURCE_ATTRIBUTES = frozenset(('src', 'href', 'action', 'formaction',
                                     'poster', 'data'))

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.executables = []
        self.resources = []
        self._script = None

    def handle_starttag(self, tag, attrs):
        self._inspect(tag, attrs)

    def handle_startendtag(self, tag, attrs):
        self._inspect(tag, attrs)

    def _inspect(self, tag, attrs):
        if tag.lower() == 'script':
            self._script = []
        for key, value in attrs:
            key = key.lower()
            value = value or ''
            if key.startswith('on'):
                self.executables.append(value)
            if key in self.RESOURCE_ATTRIBUTES and value:
                self.resources.append(value.strip())

    def handle_data(self, data):
        if self._script is not None:
            self._script.append(data)

    def handle_endtag(self, tag):
        if tag.lower() == 'script' and self._script is not None:
            self.executables.append(''.join(self._script))
            self._script = None


def require_ast_integrity(scanner=AST_SCANNER, acorn=ACORN,
                          license_file=ACORN_LICENSE):
    expected = ((scanner, AST_SHA256), (acorn, ACORN_SHA256),
                (license_file, ACORN_LICENSE_SHA256))
    mismatches = [str(path) for path, expected_digest in expected
                  if digest(path) != expected_digest]
    if mismatches:
        raise RuntimeError('AST scanner integrity failure before launch: ' +
                           ', '.join(mismatches))


def ast_model(source, *, scanner=AST_SCANNER, acorn=ACORN,
              license_file=ACORN_LICENSE, runner=subprocess.run):
    require_ast_integrity(scanner, acorn, license_file)
    result = runner(
        ['node', str(scanner)], input=json.dumps({'source': source}) + '\n',
        cwd=ROOT, text=True, capture_output=True, check=False)
    if result.returncode != 0 or not result.stdout.strip():
        return {'ok': False, 'error': (result.stderr or 'no AST output').strip()}
    try:
        return json.loads(result.stdout.splitlines()[0])
    except json.JSONDecodeError as error:
        return {'ok': False, 'error': str(error)}


def exact_routes_source(source):
    start_marker = 'const ROUTES = {'
    end_marker = '\nconst WALLET_ROUTE_DEFAULT='
    if source.count(start_marker) != 1 or source.count(end_marker) != 1:
        raise ValueError('ROUTES source delimiters must each occur exactly once')
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    if end <= start:
        raise ValueError('ROUTES source delimiters are out of order')
    return source[start:end]


def integrity_rejection_probe(mutate):
    launches = []
    with tempfile.TemporaryDirectory(prefix='loop-transfer-ast-integrity-') as temp:
        case = pathlib.Path(temp)
        scanner = case / 'js_ast_call_model.js'
        acorn = case / 'vendor/acorn-8.15.0/acorn.js'
        license_file = case / 'vendor/acorn-8.15.0/LICENSE'
        acorn.parent.mkdir(parents=True)
        shutil.copy2(AST_SCANNER, scanner)
        shutil.copy2(ACORN, acorn)
        shutil.copy2(ACORN_LICENSE, license_file)
        mutate(scanner, acorn, license_file)

        def forbidden_runner(*args, **kwargs):
            launches.append((args, kwargs))
            raise AssertionError('unverified AST subprocess launched')

        error = ''
        try:
            ast_model('back()', scanner=scanner, acorn=acorn,
                      license_file=license_file, runner=forbidden_runner)
        except RuntimeError as caught:
            error = str(caught)
        return {'launches': len(launches), 'error': error}


def security_findings(fragment_sources, route_source, facade_source):
    findings = []
    inline_sources = []
    for name, source in fragment_sources.items():
        parser = ShellSecurityParser()
        parser.feed(source)
        parser.close()
        inline_sources.extend(parser.executables)
        for resource in parser.resources:
            if resource.startswith('//') or re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', resource):
                if not resource.lower().startswith('file:'):
                    findings.append(f'{name}: remote resource {resource}')
    try:
        routes = exact_routes_source(route_source)
    except ValueError as error:
        routes = ''
        findings.append(f'routes: source extraction failed: {error}')
    sources = [('routes', routes, {'fetch', 'XMLHttpRequest', 'WebSocket',
                'EventSource', 'sendBeacon', 'sendTransaction', 'signMessage',
                'signTypedData', 'localStorage', 'sessionStorage', 'indexedDB'})]
    sources.append(('facade', facade_source, {'fetch', 'XMLHttpRequest', 'WebSocket',
                    'EventSource', 'sendBeacon', 'sendTransaction', 'signMessage',
                    'signTypedData', 'localStorage', 'sessionStorage', 'indexedDB'}))
    sources.extend(('inline', source, {'fetch', 'XMLHttpRequest', 'WebSocket',
                    'EventSource', 'sendBeacon', 'sendTransaction', 'signMessage',
                    'signTypedData', 'localStorage', 'sessionStorage', 'indexedDB'})
                   for source in inline_sources)
    for owner, source, forbidden in sources:
        model = ast_model(source)
        if not model.get('ok'):
            findings.append(f'{owner}: AST rejected: {model.get("error", "unknown")}')
            continue
        for site in model.get('calls', []):
            leaf = site.get('callee', '').split('.')[-1]
            if not site.get('local') and leaf in forbidden:
                findings.append(f'{owner}: executable {site.get("callee")}')
        for site in model.get('references', []):
            if not site.get('local') and site.get('name') in forbidden:
                findings.append(f'{owner}: reference {site.get("path")}')
    return findings


class ContractViolation(ValueError):
    pass


def require_contract(condition, message):
    if not condition:
        raise ContractViolation(message)


def exact_object(value, keys, where):
    require_contract(type(value) is dict, f'{where} must be an object')
    require_contract(list(value) == list(keys),
                     f'{where} exact keys {list(keys)}, got {list(value)}')
    return value


def bounded_string(value, where, minimum=1, maximum=512):
    require_contract(type(value) is str, f'{where} must be a string')
    require_contract(minimum <= len(value) <= maximum,
                     f'{where} length must be {minimum}..{maximum}')
    return value


def exact_integer(value, where, minimum=0, maximum=2 ** 53 - 1):
    require_contract(type(value) is int, f'{where} must be an integer, not bool/float')
    require_contract(minimum <= value <= maximum,
                     f'{where} must be in {minimum}..{maximum}')
    return value


def exact_enum(value, allowed, where):
    require_contract(value in allowed and type(value) is type(allowed[0]),
                     f'{where} must be one of {allowed}')
    return value


def exact_string_list(value, expected, where):
    require_contract(type(value) is list and value == list(expected),
                     f'{where} must equal {list(expected)}')
    require_contract(all(type(item) is str for item in value),
                     f'{where} members must be strings')
    return value


def type_strict_equal(actual, expected):
    if type(actual) is not type(expected):
        return False
    if type(actual) is dict:
        return (list(actual) == list(expected) and
                all(type_strict_equal(actual[key], expected[key]) for key in actual))
    if type(actual) in (list, tuple):
        return (len(actual) == len(expected) and
                all(type_strict_equal(left, right)
                    for left, right in zip(actual, expected)))
    return actual == expected


def _reject_duplicate_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ContractViolation(f'duplicate JSON key: {key}')
        result[key] = value
    return result


def _reject_json_number(value):
    raise ContractViolation(f'non-integer JSON number forbidden: {value}')


def strict_json_load(path, boundary):
    path = pathlib.Path(path)
    boundary = pathlib.Path(boundary).resolve()
    try:
        path.resolve(strict=False).relative_to(boundary)
    except ValueError as error:
        raise ContractViolation(f'JSON path escapes contract boundary: {path}') from error
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError as error:
        raise ContractViolation(f'missing JSON file: {path}') from error
    require_contract(not stat.S_ISLNK(mode), f'JSON file is a symlink: {path}')
    require_contract(stat.S_ISREG(mode), f'JSON file is not regular: {path}')
    raw = path.read_bytes()
    require_contract(0 < len(raw) <= 512 * 1024, f'JSON byte bound failed: {path}')
    require_contract(not raw.startswith(b'\xef\xbb\xbf'), f'UTF-8 BOM forbidden: {path}')
    require_contract(b'\x00' not in raw, f'NUL forbidden: {path}')
    try:
        source = raw.decode('utf-8', errors='strict')
    except UnicodeDecodeError as error:
        raise ContractViolation(f'invalid UTF-8: {path}') from error
    try:
        return json.loads(source, object_pairs_hook=_reject_duplicate_pairs,
                          parse_float=_reject_json_number,
                          parse_constant=_reject_json_number)
    except (json.JSONDecodeError, ContractViolation) as error:
        raise ContractViolation(f'strict JSON rejected {path}: {error}') from error


CALLER_FORBIDDEN = (
    'owner_user_id', 'wallet_id', 'wallet_epoch', 'chain_family', 'chain_id',
    'provider_chain', 'asset_id', 'token_address', 'action_id',
    'submission_record_id', 'endpoint_path', 'url', 'request_expiry_ms',
    'nonce', 'idempotency_key', 'screening_verdict', 'screening_status',
    'wallet_api_payload', 'formatted_payload_bytes', 'structured_payload',
    'acknowledgement_binding_digest', 'acknowledgement_verdict',
    'result_binding_handle', 'cursor',
)
SIGNED_HEADERS = ('privy-app-id', 'privy-idempotency-key', 'privy-request-expiry')
FORBIDDEN_SIGNED_HEADERS = (
    'authorization', 'authorization-signature', 'content-type', 'traceparent',
    'tracestate', 'x-request-id', 'privy-authorization-signature',
)
SCHEMA_EXAMPLE = 'schema_example_only_not_provider_evidence'
OPERATION_CONTRACTS = (
    {
        'name': 'asset_selections', 'http_method': 'GET',
        'path': '/v1/transfer/assets', 'facade_access': 'page',
        'request_variants': [
            {'variant': 'default', 'exact_keys': []}],
        'response_variants': [
            {'variant': 'default', 'exact_keys': ['asset_selections']}],
        'session_binding': 'authenticated_server_session',
    },
    {
        'name': 'recipient_preflight', 'http_method': 'POST',
        'path': '/v1/transfer/recipient-preflight', 'facade_access': 'page',
        'request_variants': [
            {'variant': 'resolve',
             'exact_keys': ['command', 'asset_selection_id', 'recipient_input']},
            {'variant': 'acknowledge',
             'exact_keys': ['command', 'preflight_handle',
                            'acknowledgement_kind']}],
        'response_variants': [
            {'variant': 'resolve',
             'exact_keys': ['kind', 'preflight_handle', 'recipient_display',
                            'requires_acknowledgements']},
            {'variant': 'acknowledge',
             'exact_keys': ['kind', 'preflight_handle',
                            'acknowledgements_recorded']}],
        'session_binding': 'preflight_server_session_digest_bound',
    },
    {
        'name': 'review_prepare', 'http_method': 'POST',
        'path': '/v1/transfer/reviews', 'facade_access': 'page',
        'request_variants': [
            {'variant': 'default',
             'exact_keys': ['preflight_handle', 'amount_decimal']}],
        'response_variants': [
            {'variant': 'default', 'exact_keys': ['prepared_review_handle']}],
        'session_binding': 'preflight_server_session_digest_bound',
    },
    {
        'name': 'authorization_submission', 'http_method': 'POST',
        'path': '/v1/transfer/authorize',
        'facade_access': 'private_f11_flutter_signer_handoff_only',
        'request_variants': [
            {'variant': 'issue_payload',
             'exact_keys': ['command', 'prepared_review_handle']},
            {'variant': 'submit_signature',
             'exact_keys': ['command', 'prepared_review_handle',
                            'authorization_signature',
                            'official_formatter_envelope_sha256']}],
        'response_variants': [
            {'variant': 'issue_payload',
             'exact_keys': ['kind', 'prepared_review_handle',
                            'official_formatter_envelope_bytes_base64',
                            'official_formatter_envelope_sha256']},
            {'variant': 'submit_signature',
             'exact_keys': ['kind', 'result_binding_handle']}],
        'session_binding': 'authenticated_private_signer_session',
    },
    {
        'name': 'result_projection', 'http_method': 'GET',
        'path': '/v1/transfer/current-result', 'facade_access': 'page',
        'request_variants': [
            {'variant': 'default', 'exact_keys': []}],
        'response_variants': [
            {'variant': 'transfer_result_snapshot',
             'exact_keys': ['kind', 'result']},
            {'variant': 'unavailable', 'exact_keys': ['kind']}],
        'session_binding': 'authenticated_server_session_derived_cursor',
    },
    {
        'name': 'current_wallet_reconciliation', 'http_method': 'GET',
        'path': '/v1/transfer/reconciliation', 'facade_access': 'page',
        'request_variants': [
            {'variant': 'default', 'exact_keys': []}],
        'response_variants': [
            {'variant': 'state', 'exact_keys': ['kind', 'state']},
            {'variant': 'unavailable', 'exact_keys': ['kind']}],
        'session_binding': 'authenticated_server_session',
    },
)
OPERATION_VARIANT_EXAMPLES = {
    'asset_selections': {
        'requests': {'default': {}},
        'responses': {'default': {'asset_selections': []}}},
    'recipient_preflight': {
        'requests': {
            'resolve': {'command': 'resolve', 'asset_selection_id': 'asset_usdc',
                        'recipient_input': '0x1111111111111111111111111111111111111111'},
            'acknowledge': {'command': 'acknowledge',
                            'preflight_handle': 'preflight_dummy_01',
                            'acknowledgement_kind': 'first_recipient'}},
        'responses': {
            'resolve': {'kind': 'resolve', 'preflight_handle': 'preflight_dummy_01',
                        'recipient_display': '0x1111…1111',
                        'requires_acknowledgements': ['first_recipient']},
            'acknowledge': {'kind': 'acknowledge',
                            'preflight_handle': 'preflight_dummy_01',
                            'acknowledgements_recorded': ['first_recipient']}}},
    'review_prepare': {
        'requests': {'default': {'preflight_handle': 'preflight_dummy_01',
                                 'amount_decimal': '1.25'}},
        'responses': {'default': {'prepared_review_handle': 'review_dummy_01'}}},
    'authorization_submission': {
        'requests': {
            'issue_payload': {'command': 'issue_payload',
                              'prepared_review_handle': 'review_dummy_01'},
            'submit_signature': {
                'command': 'submit_signature',
                'prepared_review_handle': 'review_dummy_01',
                'authorization_signature': 'c2lnbmF0dXJlX2R1bW15',
                'official_formatter_envelope_sha256': '0' * 64}},
        'responses': {
            'issue_payload': {
                'kind': 'issue_payload',
                'prepared_review_handle': 'review_dummy_01',
                'official_formatter_envelope_bytes_base64':
                    'eyJkdW1teSI6InNjaGVtYS1leGFtcGxlIn0=',
                'official_formatter_envelope_sha256': '0' * 64},
            'submit_signature': {
                'kind': 'submit_signature',
                'result_binding_handle': 'result_binding_dummy_01'}}},
    'result_projection': {
        'requests': {'default': {}},
        'responses': {
            'transfer_result_snapshot': {
                'kind': 'transfer_result_snapshot', 'result': {}},
            'unavailable': {'kind': 'unavailable'}}},
    'current_wallet_reconciliation': {
        'requests': {'default': {}},
        'responses': {
            'state': {'kind': 'state', 'state': 'submission_unknown'},
            'unavailable': {'kind': 'unavailable'}}},
}
POST_SIGNATURE_SEQUENCE = (
    'validate_exact_official_formatter_envelope_bytes',
    'validate_authorization_signature_encoding_presence_and_session_binding',
    'validate_signed_expiry_nonce_idempotency_review_binding',
    're_resolve_recipient_on_bound_chain',
    're_screen_canonical_recipient',
    're_read_authenticated_owner_wallet_and_epoch',
    're_read_balance_and_sponsorship_configuration',
    'deep_compare_all_material_fields_to_signed_review_and_body',
    'consume_review_on_any_mismatch_and_require_wholly_new_f5_prepare',
    'durably_commit_attempt_and_owner_wallet_lock',
    'allow_transport_bytes_only_after_durable_commit',
)
ATTEMPT_KEYS = (
    'evidence_class', 'schema_version', 'submission_record_id',
    'record_version', 'owner_user_id', 'wallet_id', 'internal_review_id',
    'signed_request_digest', 'idempotency_key', 'request_expiry_ms',
    'replay_material', 'state', 'unknown_reason', 'provider_action_id',
    'action_binding_evidence', 'recovery_lease', 'fencing_token',
    'exact_replay_count', 'transport_ordinal', 'replay_origin',
    'replay_reason',
    'synchronous_5xx_records', 'zero_byte_proof',
    'operator_close_evidence', 'provider_response_record',
    'result_binding_tombstone', 'created_at_ms', 'updated_at_ms',
)
AUDIT_EVENT_KEYS = (
    'evidence_class', 'schema_version', 'event_id', 'transition_id',
    'submission_record_id', 'owner_user_id', 'wallet_id', 'event_type',
    'occurred_at_ms', 'before_record_version', 'before_fencing_token',
    'after_record_version', 'after_fencing_token', 'predecessor_state',
    'successor_state', 'evidence_digest', 'payload',
)
ATTEMPT_STATES = (
    'committed_before_write', 'transport_in_progress', 'submission_unknown',
    'response_recorded', 'action_bound', 'provider_rejected_before_action',
    'proved_not_submitted', 'operator_closed',
)
UNKNOWN_REASONS = (
    'crash_prewrite_ambiguous', 'timeout_or_write_ambiguous',
    'response_before_durable_record', 'signed_expiry_elapsed',
    'first_synchronous_5xx_before_replay',
    'second_uncertain_after_exact_replay',
    'second_synchronous_5xx_after_exact_replay',
    'nonallowlisted_4xx',
)
REPLAY_REASONS = (
    'first_synchronous_5xx', 'other_uncertain',
)
WALLET_ACTION_STEP_KINDS = (
    'evm_transaction', 'evm_user_operation', 'svm_transaction',
    'external_transaction', 'tvm_transaction', 'custodian_transaction',
    'provider_step',
)
WALLET_ACTION_STEP_STATUSES = (
    'queued', 'preparing', 'pending', 'confirmed', 'rejected', 'reverted',
    'replaced', 'abandoned', 'failed', 'unknown',
)
RESULT_DTO_SCHEMA = {
    'schema_version': 1,
    'discriminator': {'field': 'kind',
                      'variants': ['wallet_action', 'submission_unknown']},
    'wallet_action_result': {
        'exact_keys': ['kind', 'wallet_action'], 'kind_const': 'wallet_action',
        'wallet_action_type': 'WalletActionSnapshot'},
    'submission_unknown_result': {
        'exact_keys': ['kind', 'submission_record_id', 'wallet_id', 'created_at_ms',
                       'signed_request_expires_at_ms', 'safe_message_code',
                       'action_id', 'steps'],
        'kind_const': 'submission_unknown',
        'safe_message_code_const': 'TRANSFER_RECONCILING',
        'action_id_const': None, 'steps_const': [],
        'id_bounds': [1, 128], 'timestamp_bounds': [0, 2 ** 53 - 1]},
    'wallet_action_snapshot': {
        'exact_keys': ['action_id', 'review_id', 'wallet_id', 'type', 'status',
                       'source_chain', 'source_asset', 'source_amount',
                       'destination_address', 'destination_amount', 'created_at_ms',
                       'failure', 'steps'],
        'type_const': 'transfer',
        'status_enum': ['pending', 'succeeded', 'rejected', 'failed'],
        'id_bounds': [1, 128], 'chain_asset_bounds': [1, 64],
        'decimal_bounds': [1, 101], 'address_bounds': [8, 128],
        'timestamp_bounds': [0, 2 ** 53 - 1], 'steps_max_items': 64},
    'wallet_action_failure': {
        'nullable': True, 'exact_keys': ['code', 'safe_message'],
        'code_bounds': [1, 64], 'safe_message_bounds': [1, 240],
        'safe_message_authority': 'LOOP_owned_copy_only'},
    'wallet_action_step': {
        'exact_keys': ['kind', 'status', 'chain_id', 'transaction_hash'],
        'kind_enum': list(WALLET_ACTION_STEP_KINDS),
        'status_enum': list(WALLET_ACTION_STEP_STATUSES),
        'chain_bounds': [1, 64], 'transaction_hash_bounds': [8, 128],
        'unknown_provider_step_hash_const': None},
}
WALLET_PAYLOAD_EXAMPLE = {
    'version': 1,
    'url': 'https://api.privy.io/v1/wallets/wallet_dummy_public_01/transfer',
    'method': 'POST',
    'headers': {
        'privy-app-id': 'app_dummy_public_01',
        'privy-idempotency-key': 'idempotency_dummy_public_0001',
        'privy-request-expiry': '1893456000000'},
    'body': {
        'amount_type': 'exact_input',
        'source': {'asset': 'usdc', 'amount': '1.25', 'chain': 'base'},
        'destination': {
            'address': '0x1111111111111111111111111111111111111111'},
        'nonce': 'nonce_dummy_public_000000000001'},
}
import base64
CANONICAL_BODY_BYTES = json.dumps(
    WALLET_PAYLOAD_EXAMPLE['body'], ensure_ascii=False,
    separators=(',', ':')).encode('utf-8')
CANONICAL_BODY_BASE64 = base64.b64encode(CANONICAL_BODY_BYTES).decode('ascii')
CANONICAL_BODY_SHA256 = hashlib.sha256(CANONICAL_BODY_BYTES).hexdigest()
SCHEMA_EXAMPLE_ENVELOPE_BYTES = json.dumps(
    WALLET_PAYLOAD_EXAMPLE, ensure_ascii=False,
    separators=(',', ':')).encode('utf-8')
SCHEMA_EXAMPLE_ENVELOPE_BASE64 = base64.b64encode(
    SCHEMA_EXAMPLE_ENVELOPE_BYTES).decode('ascii')
SCHEMA_EXAMPLE_ENVELOPE_SHA256 = hashlib.sha256(
    SCHEMA_EXAMPLE_ENVELOPE_BYTES).hexdigest()
SIGNATURE_EXAMPLE_BASE64 = base64.b64encode(
    b'signature_schema_example').decode('ascii')
OPERATION_VARIANT_EXAMPLES['authorization_submission']['requests'][
    'submit_signature'][
        'official_formatter_envelope_sha256'] = SCHEMA_EXAMPLE_ENVELOPE_SHA256
OPERATION_VARIANT_EXAMPLES['authorization_submission']['responses'][
    'issue_payload'][
        'official_formatter_envelope_bytes_base64'] = (
            SCHEMA_EXAMPLE_ENVELOPE_BASE64)
OPERATION_VARIANT_EXAMPLES['authorization_submission']['responses'][
    'issue_payload'][
        'official_formatter_envelope_sha256'] = SCHEMA_EXAMPLE_ENVELOPE_SHA256
OPERATION_VARIANT_EXAMPLES['result_projection']['responses'][
    'transfer_result_snapshot']['result'] = {
        'kind': 'submission_unknown',
        'submission_record_id': 'submission_result_01',
        'wallet_id': 'wallet_dummy_public_01',
        'created_at_ms': 1700000000000,
        'signed_request_expires_at_ms': 1893456000000,
        'safe_message_code': 'TRANSFER_RECONCILING',
        'action_id': None, 'steps': [],
    }

_TRANSITIONS = (
    ('t01_transport_start', 'committed_before_write',
     'transport_started_after_durable_commit', 'transport_in_progress', False,
     'current_cas_lease_and_fencing_token', 'transport_start',
     'transport_started'),
    ('t02_zero_byte', 'committed_before_write',
     'audited_zero_byte_proof_committed', 'proved_not_submitted', True,
     'durable_zero_byte_proof_record_version_and_fence', 'zero_byte_proof',
     'zero_byte_proved'),
    ('t03_crash_prewrite', 'committed_before_write',
     'crash_before_write_without_audited_zero_byte_proof',
     'submission_unknown', False,
     'durable_unknown_current_cas_lease_fence_and_retained_lock',
     'crash_before_write_without_zero_byte_proof', 'submission_unknown'),
    ('t04_timeout_write', 'transport_in_progress',
     'ambiguous_write_or_timeout', 'submission_unknown', False,
     'durable_unknown_event', 'ambiguous_write_or_timeout',
     'submission_unknown'),
    ('t05_first_5xx', 'transport_in_progress',
     'synchronous_5xx_durably_recorded', 'submission_unknown', False,
     'exact_response_record_and_exact_replay_count_zero',
     'first_synchronous_5xx', 'synchronous_5xx_recorded'),
    ('t06_second_5xx', 'transport_in_progress',
     'second_synchronous_5xx_durably_recorded_after_exact_replay',
     'submission_unknown', False,
     'exact_replay_count_one_no_further_replay_and_retained_lock',
     'second_synchronous_5xx_after_exact_replay',
     'second_synchronous_5xx_recorded'),
    ('t07_nonallowlisted_4xx', 'transport_in_progress',
     'nonallowlisted_4xx_durably_recorded', 'submission_unknown', False,
     'durable_4xx_response_not_in_credentialed_tuple_allowlist',
     'nonallowlisted_4xx', 'nonallowlisted_4xx_recorded'),
    ('t08_definitive_4xx', 'transport_in_progress',
     'audited_definitive_non_action_4xx_durably_recorded',
     'provider_rejected_before_action', True,
     'credentialed_tuple_allowlist_and_durable_no_action_proof',
     'audited_definitive_non_action_4xx',
     'definitive_non_action_4xx_recorded'),
    ('t09_exact_replay', 'submission_unknown', 'exact_replay_started',
     'transport_in_progress', False,
     'original_expiry_current_fence_and_exact_replay_count_zero',
     'exact_replay', 'exact_replay_started'),
    ('t10_response_record', 'transport_in_progress',
     'exact_action_response_durably_recorded', 'response_recorded', False,
     'provider_response_record_before_binding', 'response_received',
     'provider_response_recorded'),
    ('t11_atomic_binding', 'response_recorded',
     'atomic_result_binding_committed', 'action_bound', True,
     'same_submission_exact_action_id', 'response_recorded_before_binding',
     'action_bound'),
    ('t12_verified_event_binding', 'submission_unknown',
     'verified_exact_action_event_bound', 'action_bound', True,
     'durable_verified_event_and_same_submission_binding',
     'verified_pre_response_event', 'action_bound'),
    ('t13_expiry', 'submission_unknown', 'signed_expiry_elapsed',
     'submission_unknown', False, 'no_further_replay',
     'signed_expiry_elapsed', 'submission_unknown'),
    ('t14_replay_exhausted', 'submission_unknown',
     'second_uncertain_or_replay_exhausted', 'submission_unknown', False,
     'exact_replay_count_one_and_no_further_replay',
     'second_uncertain_outcome', 'submission_unknown'),
    ('t15_operator_close', 'submission_unknown',
     'operator_evidence_close_committed', 'operator_closed', True,
     'provider_reconciliation_evidence_digest_reason_actor_and_timestamp',
     'operator_evidence_close', 'operator_closed'),
    ('t16_second_uncertain', 'transport_in_progress',
     'second_uncertain_after_exact_replay_durably_recorded',
     'submission_unknown', False,
     'transport_ordinal_two_exact_replay_count_one_retained_lock',
     'second_uncertain_after_exact_replay', 'submission_unknown'),
    ('t17_response_before_record', 'transport_in_progress',
     'response_observed_before_durable_response_record',
     'submission_unknown', False,
     'no_action_binding_without_durable_response_or_verified_event_record',
     'response_before_durable_record', 'submission_unknown'),
)
ALLOWED_TRANSITIONS = tuple({
    'transition_id': item[0], 'from': item[1], 'event': item[2],
    'to': item[3], 'unlock': item[4], 'requires': item[5],
    'cut_point': item[6], 'audit_event_type': item[7],
} for item in _TRANSITIONS)
_CUT_DETAILS = {
    't01_transport_start': ('forbidden_until_commit', 'retain', 'send_once'),
    't02_zero_byte': ('zero_bytes_proved', 'release_after_proof_cas_only',
                      'require_new_f5_prepare'),
    't03_crash_prewrite': ('ambiguous', 'retain',
                           'exact_replay_within_original_expiry_only'),
    't04_timeout_write': ('ambiguous', 'retain',
                          'exact_replay_within_original_expiry_only'),
    't05_first_5xx': ('written', 'retain',
                      'record_first_5xx_then_one_exact_replay_only'),
    't06_second_5xx': ('no_further_replay', 'retain',
                       'durably_record_second_5xx_and_reconcile_only'),
    't07_nonallowlisted_4xx': ('written_nonallowlisted_4xx', 'retain',
                               'submission_unknown_reconcile_only'),
    't08_definitive_4xx': ('definitive_non_action',
                           'release_after_durable_tuple_proof_only',
                           'not_submitted_require_new_f5_prepare'),
    't09_exact_replay': ('byte_identical_only', 'retain',
                         'single_exact_replay'),
    't10_response_record': ('written', 'retain',
                            'persist_response_before_binding'),
    't11_atomic_binding': ('no_resend', 'release_after_atomic_binding_only',
                           'project_exact_action'),
    't12_verified_event_binding': ('no_resend',
                                   'release_after_verified_binding_only',
                                   'project_exact_action'),
    't13_expiry': ('no_further_replay', 'retain', 'reconciliation_only'),
    't14_replay_exhausted': ('no_further_replay', 'retain',
                             'reconciliation_only'),
    't15_operator_close': ('forbidden', 'release_after_evidence_commit_only',
                           'reconciliation_closed'),
    't16_second_uncertain': ('no_further_replay', 'retain',
                             'reconciliation_only'),
    't17_response_before_record': ('response_not_durable', 'retain',
                                   'reconciliation_only'),
}
CUT_POINT_TABLE = tuple({
    'transition_id': transition['transition_id'],
    'cut_point': transition['cut_point'],
    'predecessor': transition['from'], 'successor': transition['to'],
    'provider_request': _CUT_DETAILS[transition['transition_id']][0],
    'lock': _CUT_DETAILS[transition['transition_id']][1],
    'next_action': _CUT_DETAILS[transition['transition_id']][2],
} for transition in ALLOWED_TRANSITIONS)
TRANSITION_PAYLOAD_SCHEMAS = {
    't01_transport_start': {'request_digest': 'hex64'},
    't02_zero_byte': {'zero_byte_proof_digest': 'hex64'},
    't03_crash_prewrite': {'unknown_reason': 'unknown_reason'},
    't04_timeout_write': {'unknown_reason': 'unknown_reason'},
    't05_first_5xx': {
        'ordinal': 'positive_integer', 'response_body_sha256': 'hex64',
        'unknown_reason': 'unknown_reason'},
    't06_second_5xx': {
        'ordinal': 'positive_integer', 'response_body_sha256': 'hex64',
        'unknown_reason': 'unknown_reason'},
    't07_nonallowlisted_4xx': {
        'http_status': 'http_4xx', 'privy_error_code': 'bounded_opaque',
        'provider_response_record_digest': 'hex64',
        'unknown_reason': 'unknown_reason'},
    't08_definitive_4xx': {
        'http_status': 'http_4xx', 'privy_error_code': 'bounded_opaque',
        'response_schema_version': 'bounded_opaque',
        'audit_tuple_digest': 'hex64',
        'provider_response_record_digest': 'hex64'},
    't09_exact_replay': {
        'exact_replay_count': 'positive_integer',
        'transport_ordinal': 'positive_integer',
        'replay_origin': 'replay_origin',
        'replay_reason': 'replay_reason',
        'retained_5xx_count': 'nonnegative_integer',
        'request_expiry_ms': 'timestamp',
        'observed_at_ms': 'timestamp'},
    't10_response_record': {'provider_response_record_digest': 'hex64'},
    't11_atomic_binding': {
        'provider_response_record_digest': 'hex64',
        'action_id': 'bounded_opaque'},
    't12_verified_event_binding': {
        'verified_event_id': 'bounded_opaque', 'action_id': 'bounded_opaque',
        'verified_event_binding_record_digest': 'hex64'},
    't13_expiry': {
        'unknown_reason': 'unknown_reason',
        'request_expiry_ms': 'timestamp', 'observed_at_ms': 'timestamp'},
    't14_replay_exhausted': {'unknown_reason': 'unknown_reason'},
    't15_operator_close': {
        'operator_close_evidence_digest': 'hex64',
        'tombstone_digest': 'hex64', 'reason_code': 'bounded_opaque',
        'actor_id': 'bounded_opaque', 'closed_at_ms': 'timestamp'},
    't16_second_uncertain': {
        'transport_ordinal': 'positive_integer',
        'exact_replay_count': 'positive_integer',
        'unknown_reason': 'unknown_reason'},
    't17_response_before_record': {'unknown_reason': 'unknown_reason'},
}
UNKNOWN_REASON_BY_TRANSITION = {
    't03_crash_prewrite': 'crash_prewrite_ambiguous',
    't04_timeout_write': 'timeout_or_write_ambiguous',
    't05_first_5xx': 'first_synchronous_5xx_before_replay',
    't06_second_5xx': 'second_synchronous_5xx_after_exact_replay',
    't07_nonallowlisted_4xx': 'nonallowlisted_4xx',
    't13_expiry': 'signed_expiry_elapsed',
    't14_replay_exhausted': 'second_uncertain_after_exact_replay',
    't16_second_uncertain': 'second_uncertain_after_exact_replay',
    't17_response_before_record': 'response_before_durable_record',
}
AUDIT_EVENT_TYPES = tuple(dict.fromkeys(
    ['attempt_lock_committed'] +
    [item['audit_event_type'] for item in ALLOWED_TRANSITIONS]))
R0_EVIDENCE = (
    'official_flutter_and_server_formatter_staging_execution',
    'amount_base_units_decimals_independent_oracle',
    'credentialed_alchemy_chainalysis_ens_failure_injection',
    'same_chain_named_asset_action_steps_hash_explorer_reconciliation',
    'uncertain_submit_cut_points_at_most_once',
    'succeeded_only_balance_history_refresh_recalculation',
)
R0_COMMANDS = (
    'staging-r0 official-formatter-flutter-signature --credentials-required',
    'staging-r0 amount-base-units-decimals-oracle --credentials-required',
    'staging-r0 alchemy-chainalysis-ens-failure-injection --credentials-required',
    'staging-r0 same-chain-action-steps-explorer-reconcile --credentials-required',
    'staging-r0 uncertain-submit-at-most-once-proxy --credentials-required',
    'staging-r0 succeeded-only-balance-history-recalculation --credentials-required',
)
R0_MAP = [{
    'command': command, 'evidence': evidence,
    'additional_audits': additional,
} for command, evidence, additional in zip(R0_COMMANDS, R0_EVIDENCE, (
    ['private_f11_server_bytes_session_binding'],
    [],
    ['definitive_non_action_4xx_tuple_allowlist'],
    ['rest_webhook_inbox_dedupe_conflict_quarantine'],
    ['second_synchronous_5xx_no_replay'],
    ['operator_close_no_action_tombstone'],
))]

def _schema_record(record):
    record['evidence_class'] = SCHEMA_EXAMPLE
    return record

REPLAY_TEMPLATE = _schema_record({
    'schema_version': 1, 'submission_record_id': 'submission_template_01',
    'owner_user_id': 'owner_dummy_01', 'wallet_id': 'wallet_dummy_public_01',
    'record_version': 1,
    'url': WALLET_PAYLOAD_EXAMPLE['url'], 'method': WALLET_PAYLOAD_EXAMPLE['method'],
    'signed_headers': copy.deepcopy(WALLET_PAYLOAD_EXAMPLE['headers']),
    'body_base64': CANONICAL_BODY_BASE64,
    'body_sha256': CANONICAL_BODY_SHA256,
    'official_formatter_envelope_bytes_base64':
        SCHEMA_EXAMPLE_ENVELOPE_BASE64,
    'official_formatter_envelope_sha256': SCHEMA_EXAMPLE_ENVELOPE_SHA256,
    'authorization_signature_base64': SIGNATURE_EXAMPLE_BASE64,
    'idempotency_key': WALLET_PAYLOAD_EXAMPLE['headers']['privy-idempotency-key'],
    'request_expiry_ms': int(
        WALLET_PAYLOAD_EXAMPLE['headers']['privy-request-expiry']),
    'encrypted_at_rest': True,
})
RESPONSE_TEMPLATE = _schema_record({
    'schema_version': 1, 'submission_record_id': 'submission_template_01',
    'owner_user_id': 'owner_dummy_01', 'wallet_id': 'wallet_dummy_public_01',
    'response_record_version': 1, 'fencing_token': 2,
    'http_status': 200, 'received_at_ms': 1700000000000,
    'response_body_sha256': 'b' * 64,
    'encrypted_response_body_base64':
        base64.b64encode(b'ciphertext_dummy_public').decode('ascii'),
    'body_encoding': 'base64', 'encrypted_body_byte_length': 23,
    'provider_action_id': 'action_dummy_01',
    'provider_wallet_id': 'wallet_dummy_public_01',
    'provider_schema_version': 'wallet_action_v1',
    'record_digest': 'c' * 64,
})
VERIFIED_EVENT_TEMPLATE = _schema_record({
    'schema_version': 1, 'submission_record_id': 'submission_template_01',
    'owner_user_id': 'owner_dummy_01', 'wallet_id': 'wallet_dummy_public_01',
    'record_version': 1, 'fencing_token': 2,
    'event_id': 'event_verified_dummy_01',
    'provider_action_id': 'action_dummy_01',
    'received_at_ms': 1700000000000,
    'raw_body_sha256': '2' * 64,
    'signature_verified': True,
    'exact_action_binding_verified': True,
    'record_digest': '3' * 64,
})
LEASE_TEMPLATE = _schema_record({
    'schema_version': 1, 'submission_record_id': 'submission_template_01',
    'owner_user_id': 'owner_dummy_01', 'wallet_id': 'wallet_dummy_public_01',
    'record_version': 1, 'lease_owner': 'worker_dummy_01',
    'lease_expires_at_ms': 1700000030000, 'fencing_token': 2,
})
ZERO_TEMPLATE = _schema_record({
    'schema_version': 1, 'submission_record_id': 'submission_template_01',
    'owner_user_id': 'owner_dummy_01', 'wallet_id': 'wallet_dummy_public_01',
    'primitive': 'http_client_prewrite_counter',
    'proved_at_ms': 1700000001000, 'record_version': 1,
    'fencing_token': 2, 'evidence_digest': 'd' * 64,
})
FIVE_TEMPLATES = [
    _schema_record({
        'schema_version': 1, 'submission_record_id': 'submission_template_01',
        'owner_user_id': 'owner_dummy_01', 'wallet_id': 'wallet_dummy_public_01',
        'ordinal': ordinal, 'http_status': status,
        'received_at_ms': 1700000002000 + ordinal,
        'response_body_sha256': digest_char * 64,
        'record_version': ordinal, 'fencing_token': 2})
    for ordinal, status, digest_char in ((1, 500, 'e'), (2, 503, 'f'))]

def operator_evidence_digest(record):
    projection = {
        'submission_record_id': record['submission_record_id'],
        'owner_user_id': record['owner_user_id'],
        'wallet_id': record['wallet_id'],
        'proved_no_action': record['proved_no_action'],
        'reason_code': record['reason_code'],
        'actor_id': record['actor_id'],
        'closed_at_ms': record['closed_at_ms'],
        'record_version': record['record_version'],
        'fencing_token': record['fencing_token'],
    }
    encoded = json.dumps(projection, separators=(',', ':'),
                         ensure_ascii=False).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()

OPERATOR_TEMPLATE = _schema_record({
    'schema_version': 1, 'submission_record_id': 'submission_template_01',
    'owner_user_id': 'owner_dummy_01', 'wallet_id': 'wallet_dummy_public_01',
    'proved_no_action': True, 'provider_evidence_digest': '1' * 64,
    'reason_code': 'PROVIDER_CONFIRMED_NO_ACTION',
    'actor_id': 'operator_dummy_01', 'closed_at_ms': 1700000004000,
    'record_version': 1, 'fencing_token': 2,
})
OPERATOR_TEMPLATE['provider_evidence_digest'] = operator_evidence_digest(
    OPERATOR_TEMPLATE)
TOMBSTONE_TEMPLATE = _schema_record({
    'schema_version': 1, 'submission_record_id': 'submission_template_01',
    'owner_user_id': 'owner_dummy_01', 'wallet_id': 'wallet_dummy_public_01',
    'record_version': 1,
    'evidence_digest': OPERATOR_TEMPLATE['provider_evidence_digest'],
    'closed_at_ms': 1700000004000, 'reusable': False,
})

RECORD_SCHEMAS = {
    'replay_material': {
        'exact_keys': list(REPLAY_TEMPLATE),
        'body_envelope_and_signature_max_bytes': 131072,
        'envelope_exact_keys': [
            'version', 'url', 'method', 'headers', 'body'],
        'envelope_evidence_class': SCHEMA_EXAMPLE,
        'idempotency_key_bounds': [16, 255],
        'timestamp_bounds': [0, 9007199254740991]},
    'provider_response_record': {
        'exact_keys': list(RESPONSE_TEMPLATE),
        'http_status_bounds': [100, 599],
        'timestamp_bounds': [0, 9007199254740991],
        'encrypted_body_max_bytes': 65536},
    'verified_event_binding_record': {
        'exact_keys': list(VERIFIED_EVENT_TEMPLATE)},
    'action_binding_evidence': {
        'exact_keys': [
            'kind', 'provider_response_record',
            'verified_event_binding_record'],
        'kind_enum': ['post_response', 'verified_event']},
    'recovery_lease': {'exact_keys': list(LEASE_TEMPLATE)},
    'zero_byte_proof': {'exact_keys': list(ZERO_TEMPLATE)},
    'synchronous_5xx_record': {'exact_keys': list(FIVE_TEMPLATES[0])},
    'operator_close_evidence': {'exact_keys': list(OPERATOR_TEMPLATE)},
    'result_binding_tombstone': {'exact_keys': list(TOMBSTONE_TEMPLATE)},
    'audit_event': {
        'exact_keys': list(AUDIT_EVENT_KEYS),
        'transition_payload_schemas': copy.deepcopy(TRANSITION_PAYLOAD_SCHEMAS)},
    'audit_history': {
        'exact_keys': [
            'evidence_class', 'schema_version', 'history_id',
            'coverage_transition_id', 'submission_record_id',
            'owner_user_id', 'wallet_id', 'events']},
}
STATE_RULES = {
    'committed_before_write': {
        'replay': True, 'lease': True, 'response': False, 'action': False,
        'binding': False, 'zero': False, 'operator': False, 'tombstone': False},
    'transport_in_progress': {
        'replay': True, 'lease': True, 'response': False, 'action': False,
        'binding': False, 'zero': False, 'operator': False, 'tombstone': False},
    'submission_unknown': {
        'replay': True, 'lease': True, 'response': 'reason_dependent',
        'action': False, 'binding': False, 'zero': False,
        'operator': False, 'tombstone': False},
    'response_recorded': {
        'replay': True, 'lease': True, 'response': True, 'action': True,
        'binding': False, 'zero': False, 'operator': False, 'tombstone': False},
    'action_bound': {
        'replay': False, 'lease': False, 'response': 'binding_dependent',
        'action': True, 'binding': True,
        'zero': False, 'operator': False, 'tombstone': False},
    'provider_rejected_before_action': {
        'replay': False, 'lease': False, 'response': True, 'action': False,
        'binding': False, 'zero': False, 'operator': False, 'tombstone': False},
    'proved_not_submitted': {
        'replay': False, 'lease': False, 'response': False, 'action': False,
        'binding': False, 'zero': True, 'operator': False, 'tombstone': False},
    'operator_closed': {
        'replay': False, 'lease': False, 'response': False, 'action': False,
        'binding': False, 'zero': False, 'operator': True, 'tombstone': True},
}
UNKNOWN_INSTANCE_SPECS = (
    ('crash_prewrite_ambiguous', 0, 0, False, 1, 'initial_submission', None),
    ('timeout_or_write_ambiguous', 0, 0, False, 1, 'initial_submission', None),
    ('response_before_durable_record', 0, 0, False, 1,
     'initial_submission', None),
    ('signed_expiry_elapsed', 0, 0, False, 1, 'initial_submission', None),
    ('first_synchronous_5xx_before_replay', 0, 1, False, 1,
     'initial_submission', None),
    ('second_uncertain_after_exact_replay', 1, 0, False, 2,
     'exact_replay', 'other_uncertain'),
    ('second_synchronous_5xx_after_exact_replay', 1, 2, False, 2,
     'exact_replay', 'first_synchronous_5xx'),
    ('nonallowlisted_4xx', 0, 0, True, 1, 'initial_submission', None),
)

def _bind_record(template, submission_id, record_version, *,
                 response_status=None):
    value = copy.deepcopy(template)
    value['submission_record_id'] = submission_id
    value['record_version' if 'record_version' in value
          else 'response_record_version'] = record_version
    if response_status is not None:
        value['http_status'] = response_status
        value['provider_action_id'] = None
        value['provider_wallet_id'] = None
        value['record_digest'] = '7' * 64
    return value

def _make_attempt(state, index, unknown_reason=None, replay_count=0,
                  five_count=0, nonallowlisted_response=False,
                  transport_ordinal=1, replay_origin='initial_submission',
                  replay_reason=None, binding_kind=None):
    submission_id = f'submission_state_{index}'
    version = 100 + index
    updated = 1700000100000 + index
    rule = STATE_RULES[state]
    replay = (_bind_record(REPLAY_TEMPLATE, submission_id, version)
              if rule['replay'] else None)
    lease = (_bind_record(LEASE_TEMPLATE, submission_id, version)
             if rule['lease'] else None)
    response_required = (rule['response'] is True or
                         (rule['response'] == 'binding_dependent' and
                          binding_kind == 'post_response') or
                         (rule['response'] == 'reason_dependent' and
                          nonallowlisted_response))
    response = (_bind_record(
        RESPONSE_TEMPLATE, submission_id, version,
        response_status=429 if nonallowlisted_response else None)
        if response_required else None)
    fives = []
    for ordinal in range(five_count):
        historical_offset = five_count - ordinal - 1
        if replay_count == 1 and replay_reason == 'first_synchronous_5xx':
            if five_count == 2:
                historical_offset = 2 if ordinal == 0 else 0
            elif state == 'transport_in_progress':
                historical_offset = 1
            elif state == 'response_recorded':
                historical_offset = 2
            elif state == 'action_bound':
                historical_offset = 3
        item = _bind_record(
            FIVE_TEMPLATES[ordinal], submission_id,
            version - historical_offset)
        fives.append(item)
    if response is not None and state == 'action_bound':
        # The terminal attempt points back to the response record committed by
        # t10; t11 is the following CAS, never the response record itself.
        response['response_record_version'] = version - 1
    if (response is not None and replay_count == 1 and
            replay_reason == 'first_synchronous_5xx'):
        response['received_at_ms'] = fives[0]['received_at_ms'] + 2
        updated = (response['received_at_ms'] + 1
                   if state == 'action_bound' else
                   response['received_at_ms'])
    elif (state == 'transport_in_progress' and replay_count == 1 and
          replay_reason == 'first_synchronous_5xx'):
        updated = fives[0]['received_at_ms'] + 1
    zero = (_bind_record(ZERO_TEMPLATE, submission_id, version)
            if rule['zero'] else None)
    close = (_bind_record(OPERATOR_TEMPLATE, submission_id, version)
             if rule['operator'] else None)
    tombstone = (_bind_record(TOMBSTONE_TEMPLATE, submission_id, version)
                 if rule['tombstone'] else None)
    if close is not None:
        close['closed_at_ms'] = updated
        tombstone['closed_at_ms'] = updated
        close['provider_evidence_digest'] = operator_evidence_digest(close)
        tombstone['evidence_digest'] = close['provider_evidence_digest']
    action_binding = None
    if rule['binding']:
        if binding_kind == 'post_response':
            action_binding = {
                'kind': 'post_response',
                'provider_response_record': copy.deepcopy(response),
                'verified_event_binding_record': None,
            }
        elif binding_kind == 'verified_event':
            verified = _bind_record(
                VERIFIED_EVENT_TEMPLATE, submission_id, version)
            action_binding = {
                'kind': 'verified_event',
                'provider_response_record': None,
                'verified_event_binding_record': verified,
            }
        else:
            raise AssertionError('action_bound schema example needs binding kind')
    values = {
        'evidence_class': SCHEMA_EXAMPLE, 'schema_version': 1,
        'submission_record_id': submission_id, 'record_version': version,
        'owner_user_id': 'owner_dummy_01',
        'wallet_id': 'wallet_dummy_public_01',
        'internal_review_id': 'review_dummy_01',
        'signed_request_digest': SCHEMA_EXAMPLE_ENVELOPE_SHA256,
        'idempotency_key':
            WALLET_PAYLOAD_EXAMPLE['headers']['privy-idempotency-key'],
        'request_expiry_ms': int(
            WALLET_PAYLOAD_EXAMPLE['headers']['privy-request-expiry']),
        'replay_material': replay, 'state': state,
        'unknown_reason': unknown_reason,
        'provider_action_id': (
            response['provider_action_id'] if response is not None else
            action_binding['verified_event_binding_record']['provider_action_id']
            if action_binding is not None and
            action_binding['kind'] == 'verified_event' else None),
        'action_binding_evidence': action_binding,
        'recovery_lease': lease, 'fencing_token': 2,
        'exact_replay_count': replay_count,
        'transport_ordinal': transport_ordinal,
        'replay_origin': replay_origin,
        'replay_reason': replay_reason,
        'synchronous_5xx_records': fives,
        'zero_byte_proof': zero, 'operator_close_evidence': close,
        'provider_response_record': response,
        'result_binding_tombstone': tombstone,
        'created_at_ms': 1700000000000, 'updated_at_ms': updated,
    }
    attempt = {key: values[key] for key in ATTEMPT_KEYS}
    if unknown_reason == 'signed_expiry_elapsed':
        attempt['updated_at_ms'] = attempt['request_expiry_ms']
    return attempt

ATTEMPT_INSTANCES = [
    _make_attempt('committed_before_write', 0),
    _make_attempt('transport_in_progress', 1),
    _make_attempt('transport_in_progress', 2, replay_count=1, five_count=1,
                  transport_ordinal=2, replay_origin='exact_replay',
                  replay_reason='first_synchronous_5xx'),
]
ATTEMPT_INSTANCES.extend(
    _make_attempt('submission_unknown', index + 3, reason, replay, fives,
                  nonallowlisted, ordinal, origin, replay_reason)
    for index, (reason, replay, fives, nonallowlisted, ordinal, origin,
                replay_reason)
    in enumerate(UNKNOWN_INSTANCE_SPECS))
ATTEMPT_INSTANCES.extend([
    _make_attempt('response_recorded', 11),
    _make_attempt('action_bound', 12, binding_kind='post_response'),
    _make_attempt('action_bound', 13, binding_kind='verified_event'),
    _make_attempt('proved_not_submitted', 14),
    _make_attempt('operator_closed', 15),
    _make_attempt(
        'response_recorded', 16, replay_count=1, five_count=1,
        transport_ordinal=2, replay_origin='exact_replay',
        replay_reason='first_synchronous_5xx'),
    _make_attempt(
        'action_bound', 17, replay_count=1, five_count=1,
        transport_ordinal=2, replay_origin='exact_replay',
        replay_reason='first_synchronous_5xx', binding_kind='post_response'),
])

def _payload_value(transition_id, key, field_type):
    if field_type == 'positive_integer':
        if key == 'ordinal':
            return 2 if transition_id == 't06_second_5xx' else 1
        if key == 'transport_ordinal':
            return 2
        return 1
    if field_type == 'nonnegative_integer':
        return 1 if key == 'retained_5xx_count' else 0
    if field_type == 'timestamp':
        return 1700000004000
    if field_type == 'replay_origin':
        return 'exact_replay'
    if field_type == 'replay_reason':
        return 'first_synchronous_5xx'
    if field_type == 'http_4xx':
        return 429
    if field_type == 'unknown_reason':
        return UNKNOWN_REASON_BY_TRANSITION[transition_id]
    if field_type == 'bounded_opaque':
        return 'PRIVY_SCHEMA_EXAMPLE'
    if key == 'response_body_sha256':
        return ('f' if transition_id == 't06_second_5xx' else 'e') * 64
    if (transition_id == 't07_nonallowlisted_4xx' and
            key == 'provider_response_record_digest'):
        return '7' * 64
    return hashlib.sha256(f'{transition_id}:{key}'.encode()).hexdigest()

def _attempt_with_reason(reason):
    return next(item for item in ATTEMPT_INSTANCES
                if item['unknown_reason'] == reason)

def _transition_companion(transition_id):
    if transition_id == 't05_first_5xx':
        return _attempt_with_reason('first_synchronous_5xx_before_replay')
    if transition_id == 't06_second_5xx':
        return _attempt_with_reason(
            'second_synchronous_5xx_after_exact_replay')
    if transition_id == 't07_nonallowlisted_4xx':
        return _attempt_with_reason('nonallowlisted_4xx')
    if transition_id == 't09_exact_replay':
        return next(item for item in ATTEMPT_INSTANCES
                    if item['state'] == 'transport_in_progress' and
                    item['replay_origin'] == 'exact_replay')
    if transition_id == 't10_response_record':
        return next(item for item in ATTEMPT_INSTANCES
                    if item['state'] == 'response_recorded' and
                    item['replay_reason'] == 'first_synchronous_5xx')
    if transition_id == 't11_atomic_binding':
        return next(item for item in ATTEMPT_INSTANCES
                    if item['state'] == 'action_bound' and
                    item['action_binding_evidence']['kind'] == 'post_response' and
                    item['replay_reason'] == 'first_synchronous_5xx')
    if transition_id == 't12_verified_event_binding':
        return next(item for item in ATTEMPT_INSTANCES
                    if item['state'] == 'action_bound' and
                    item['action_binding_evidence']['kind'] == 'verified_event')
    if transition_id == 't15_operator_close':
        return next(item for item in ATTEMPT_INSTANCES
                    if item['state'] == 'operator_closed')
    if transition_id == 't14_replay_exhausted':
        return _attempt_with_reason('second_uncertain_after_exact_replay')
    if transition_id == 't13_expiry':
        return _attempt_with_reason('signed_expiry_elapsed')
    if transition_id == 't16_second_uncertain':
        return _attempt_with_reason('second_uncertain_after_exact_replay')
    if transition_id == 't17_response_before_record':
        return _attempt_with_reason('response_before_durable_record')
    return None

def _transition_payload(transition_id, companion=None):
    schema = TRANSITION_PAYLOAD_SCHEMAS[transition_id]
    payload = {
        key: _payload_value(transition_id, key, field_type)
        for key, field_type in schema.items()}
    if companion is None:
        return payload
    if transition_id == 't01_transport_start':
        payload['request_digest'] = companion['signed_request_digest']
    elif transition_id in ('t05_first_5xx', 't06_second_5xx'):
        record = companion['synchronous_5xx_records'][
            0 if transition_id == 't05_first_5xx' else -1]
        payload['ordinal'] = record['ordinal']
        payload['response_body_sha256'] = record['response_body_sha256']
    elif transition_id == 't07_nonallowlisted_4xx':
        response = companion['provider_response_record']
        payload['http_status'] = response['http_status']
        payload['provider_response_record_digest'] = response['record_digest']
    elif transition_id == 't09_exact_replay':
        payload.update({
            'exact_replay_count': companion['exact_replay_count'],
            'transport_ordinal': companion['transport_ordinal'],
            'replay_origin': companion['replay_origin'],
            'replay_reason': companion['replay_reason'],
            'retained_5xx_count': min(
                len(companion['synchronous_5xx_records']), 1),
            'request_expiry_ms': companion['request_expiry_ms'],
            'observed_at_ms': companion['updated_at_ms']})
    elif transition_id in ('t10_response_record', 't11_atomic_binding'):
        response = companion['provider_response_record']
        payload['provider_response_record_digest'] = response['record_digest']
        if 'action_id' in payload:
            payload['action_id'] = companion['provider_action_id']
    elif transition_id == 't12_verified_event_binding':
        record = companion['action_binding_evidence'][
            'verified_event_binding_record']
        payload.update({
            'verified_event_id': record['event_id'],
            'action_id': record['provider_action_id'],
            'verified_event_binding_record_digest': record['record_digest']})
    elif transition_id == 't15_operator_close':
        close = companion['operator_close_evidence']
        tombstone = companion['result_binding_tombstone']
        payload.update({
            'operator_close_evidence_digest':
                close['provider_evidence_digest'],
            'tombstone_digest': tombstone['evidence_digest'],
            'reason_code': close['reason_code'],
            'actor_id': close['actor_id'],
            'closed_at_ms': close['closed_at_ms']})
    elif transition_id == 't13_expiry':
        payload.update({
            'request_expiry_ms': companion['request_expiry_ms'],
            'observed_at_ms': companion['updated_at_ms']})
    elif transition_id == 't16_second_uncertain':
        payload.update({
            'transport_ordinal': companion['transport_ordinal'],
            'exact_replay_count': companion['exact_replay_count']})
    return payload

def _path_to_state(target_state):
    if target_state == 'committed_before_write':
        return []
    queue = [('committed_before_write', [])]
    visited = {'committed_before_write'}
    while queue:
        state, path = queue.pop(0)
        for transition in ALLOWED_TRANSITIONS:
            if transition['from'] != state or transition['to'] == state:
                continue
            next_path = path + [transition]
            if transition['to'] == target_state:
                return next_path
            if transition['to'] not in visited:
                visited.add(transition['to'])
                queue.append((transition['to'], next_path))
    raise AssertionError(f'no schema-example path to {target_state}')

def _transition_by_id(transition_id):
    return next(item for item in ALLOWED_TRANSITIONS
                if item['transition_id'] == transition_id)

def _audit_path_for_target(target):
    special = {
        't06_second_5xx': [
            't01_transport_start', 't05_first_5xx',
            't09_exact_replay', 't06_second_5xx'],
        't09_exact_replay': [
            't01_transport_start', 't05_first_5xx', 't09_exact_replay'],
        't10_response_record': [
            't01_transport_start', 't05_first_5xx',
            't09_exact_replay', 't10_response_record'],
        't11_atomic_binding': [
            't01_transport_start', 't05_first_5xx',
            't09_exact_replay', 't10_response_record',
            't11_atomic_binding'],
        't14_replay_exhausted': [
            't01_transport_start', 't04_timeout_write',
            't09_exact_replay', 't16_second_uncertain',
            't14_replay_exhausted'],
        't16_second_uncertain': [
            't01_transport_start', 't04_timeout_write',
            't09_exact_replay', 't16_second_uncertain'],
    }.get(target['transition_id'])
    if special is not None:
        return [_transition_by_id(item) for item in special]
    return _path_to_state(target['from']) + [target]

def _successful_replay_timeline(target, companion, path):
    if (target['transition_id'] not in (
            't09_exact_replay', 't10_response_record', 't11_atomic_binding') or
            companion is None or companion['replay_reason'] !=
            'first_synchronous_5xx'):
        return None
    first_5xx = companion['synchronous_5xx_records'][0]
    final_version = companion['record_version']
    final_fence = companion['fencing_token']
    lock_version = final_version - len(path)
    require_contract(lock_version >= 1,
                     'successful replay audit version underflow')
    times = {
        't01_transport_start': first_5xx['received_at_ms'] - 1,
        't05_first_5xx': first_5xx['received_at_ms'],
        't09_exact_replay': first_5xx['received_at_ms'] + 1,
    }
    if companion['provider_response_record'] is not None:
        times['t10_response_record'] = companion[
            'provider_response_record']['received_at_ms']
    if target['transition_id'] == 't11_atomic_binding':
        times['t11_atomic_binding'] = companion['updated_at_ms']
    return {
        'lock_version': lock_version,
        'fence': final_fence,
        'lock_time': times['t01_transport_start'] - 1,
        'event_times': times,
    }

def _make_audit_histories():
    histories = []
    for history_index, target in enumerate(ALLOWED_TRANSITIONS, 1):
        companion = _transition_companion(target['transition_id'])
        path = _audit_path_for_target(target)
        replay_timeline = _successful_replay_timeline(
            target, companion, path)
        submission_id = (companion['submission_record_id'] if companion else
                         f'submission_audit_{history_index:02d}')
        owner_id = (companion['owner_user_id'] if companion else
                    f'owner_audit_{history_index:02d}')
        wallet_id = (companion['wallet_id'] if companion else
                     f'wallet_audit_{history_index:02d}')
        lock_version = (replay_timeline['lock_version']
                        if replay_timeline else 1)
        lock_fence = (replay_timeline['fence']
                      if replay_timeline else 1)
        lock_time = (replay_timeline['lock_time'] if replay_timeline else
                     1700000000000 + history_index * 100)
        events = [{
            'evidence_class': SCHEMA_EXAMPLE, 'schema_version': 1,
            'event_id': f'event_h{history_index:02d}_lock',
            'transition_id': 'attempt_lock',
            'submission_record_id': submission_id,
            'owner_user_id': owner_id, 'wallet_id': wallet_id,
            'event_type': 'attempt_lock_committed',
            'occurred_at_ms': lock_time,
            'before_record_version': None, 'before_fencing_token': None,
            'after_record_version': lock_version,
            'after_fencing_token': lock_fence,
            'predecessor_state': None,
            'successor_state': 'committed_before_write',
            'evidence_digest': hashlib.sha256(
                f'history:{history_index}:lock'.encode()).hexdigest(),
            'payload': {'lock_key_digest': hashlib.sha256(
                f'lock:{submission_id}:{owner_id}:{wallet_id}'.encode()
            ).hexdigest()},
        }]
        for event_index, transition in enumerate(path, 1):
            transition_id = transition['transition_id']
            target_companion = (
                companion if transition_id == target['transition_id'] or
                transition_id in ('t01_transport_start',
                                  't05_first_5xx', 't09_exact_replay',
                                  't16_second_uncertain') and
                target['transition_id'] in (
                    't06_second_5xx', 't14_replay_exhausted',
                    't16_second_uncertain', 't10_response_record',
                    't11_atomic_binding') or
                (target['transition_id'] == 't11_atomic_binding' and
                 transition_id == 't10_response_record') else None)
            payload = _transition_payload(
                transition_id, target_companion)
            if (replay_timeline is not None and
                    transition_id == 't09_exact_replay'):
                payload['observed_at_ms'] = replay_timeline[
                    'event_times'][transition_id]
            occurred_at_ms = (
                replay_timeline['event_times'][transition_id]
                if replay_timeline is not None else
                payload['observed_at_ms']
                if transition_id in ('t09_exact_replay', 't13_expiry')
                else max(
                    1700000000000 + history_index * 100 + event_index,
                    events[-1]['occurred_at_ms'] + 1))
            events.append({
                'evidence_class': SCHEMA_EXAMPLE, 'schema_version': 1,
                'event_id': f'event_h{history_index:02d}_{event_index:02d}',
                'transition_id': transition_id,
                'submission_record_id': submission_id,
                'owner_user_id': owner_id, 'wallet_id': wallet_id,
                'event_type': transition['audit_event_type'],
                'occurred_at_ms': occurred_at_ms,
                'before_record_version': lock_version + event_index - 1,
                'before_fencing_token': lock_fence,
                'after_record_version': lock_version + event_index,
                'after_fencing_token': lock_fence,
                'predecessor_state': transition['from'],
                'successor_state': transition['to'],
                'evidence_digest': hashlib.sha256(
                    f'history:{history_index}:{transition_id}'.encode()
                ).hexdigest(),
                'payload': payload,
            })
        histories.append({
            'evidence_class': SCHEMA_EXAMPLE, 'schema_version': 1,
            'history_id': f'audit_history_{history_index:02d}',
            'coverage_transition_id': target['transition_id'],
            'submission_record_id': submission_id,
            'owner_user_id': owner_id, 'wallet_id': wallet_id,
            'events': events,
        })
    return histories

AUDIT_HISTORIES = _make_audit_histories()
RECOVERY_CONTRACT = {
    'startup_scan': {
        'enabled': True,
        'eligible_states': [
            'committed_before_write', 'transport_in_progress',
            'submission_unknown', 'response_recorded']},
    'periodic_scan': {'enabled': True, 'interval_ms': 30000},
    'lease': {
        'acquire': 'cas_record_version_and_current_fencing_token',
        'renew': 'cas_record_version_lease_owner_and_fencing_token',
        'duration_ms': 30000},
    'fencing': {
        'monotonic_increase_on_acquire': True,
        'stale_worker_write': 'forbidden',
        'stale_worker_send': 'forbidden'},
    'replay': {
        'maximum_exact_replays': 1,
        'same_envelope_digest_idempotency_expiry_required': True,
        'only_before_original_signed_expiry': True,
        'second_uncertain_retains_lock_and_forbids_replay': True},
    'audit_history_binding': {
        'terminal_replay_history_identity':
            'submission_record_id_owner_user_id_wallet_id_exact_match',
        'all_events_identity':
            'same_as_history_header_and_terminal_attempt',
        'parent_chain':
            'state_record_version_and_fencing_token_contiguous'},
}
SCHEMA_EXAMPLES = {
    'evidence_class': SCHEMA_EXAMPLE,
    'official_formatter_envelope': copy.deepcopy(WALLET_PAYLOAD_EXAMPLE),
    'official_formatter_envelope_bytes_base64':
        SCHEMA_EXAMPLE_ENVELOPE_BASE64,
    'official_formatter_envelope_sha256': SCHEMA_EXAMPLE_ENVELOPE_SHA256,
    'official_formatter_output_provenance':
        'not_run_schema_shape_only_not_official_formatter_output',
}
OFFICIAL_INTEGRATION_V4 = {
    'schema_version': 1,
    'implementation_boundaries': {
        'wallet_delivery_core': 'Privy_official_SDK_and_Wallet_API',
        'server_formatter_and_signature_authority': 'Privy_official_only',
        'viem_role': 'thin_EVM_address_and_ENS_adapter_only',
        'anza_role': 'thin_Solana_address_adapter_only',
        'custom_formatter_signature_wallet_or_provider_lifecycle': 'forbidden',
    },
    'project_profile': {
        'profile_id': 'loop_same_chain_transfer_profile_v1',
        'generic_privy_schema_authority': 'Privy Wallet API',
        'profile_scope': 'same_chain_named_asset_exact_input',
        'idempotency_key_bounds': [16, 255], 'nonce_bounds': [24, 255]},
    'authorization_flow': {
        'review_prepare_page_response_exact_keys': ['prepared_review_handle'],
        'page_forbidden_response_keys': [
            'official_formatter_envelope_bytes_base64',
            'official_formatter_envelope_sha256'],
        'issue_payload': {
            'operation': 'authorization_submission',
            'facade_access': 'private_f11_flutter_signer_handoff_only',
            'request_exact_keys': ['command', 'prepared_review_handle'],
            'response_exact_keys': [
                'kind', 'prepared_review_handle',
                'official_formatter_envelope_bytes_base64',
                'official_formatter_envelope_sha256']},
        'submit_signature': {
            'operation': 'authorization_submission',
            'request_exact_keys': [
                'command', 'prepared_review_handle',
                'authorization_signature',
                'official_formatter_envelope_sha256']},
        'signature_path': 'server_formatted_bytes',
        'server_formatter': {
            'package': '@privy-io/node', 'version': '0.29.0',
            'method': 'formatRequestForAuthorizationSignature'},
        'flutter': {
            'package': 'privy_flutter', 'version': '0.10.1',
            'method': 'PrivyUser.generateAuthorizationSignatureFromBytes',
            'payload_encoding': 'base64_to_Uint8List'},
        'server_session_holds_official_formatter_envelope_bytes': True,
        'submit_compares_stored_envelope_bytes_and_digest': True,
        'schema_example_envelope_is_not_official_golden': True,
        'crypto_authority': 'Privy',
        'bff_crypto_responsibility':
            'validate_encoding_presence_and_session_binding_only',
        'structured_wallet_api_payload_path': 'forbidden'},
    'recipient_preflight': {
        'operation': 'recipient_preflight',
        'resolve_request_exact_keys': [
            'command', 'asset_selection_id', 'recipient_input'],
        'acknowledge_request_exact_keys': [
            'command', 'preflight_handle', 'acknowledgement_kind'],
        'acknowledgement_kind_enum': ['first_recipient', 'history_unknown'],
        'server_derived_digest_bind': True,
        'material_change_clears_acknowledgements': True,
        'review_prepare_consumes_bound_handle': True},
    'definitive_non_action_4xx': {
        'audited_tuple_allowlist': [],
        'allowlist_tuple_exact_keys': [
            'http_status', 'privy_error_code', 'response_schema_version'],
        'credentialed_tuple_and_proof_required': True,
        'empty_allowlist_forbids_active_provider_rejected_instance': True,
        'nonallowlisted_transition_id': 't07_nonallowlisted_4xx',
        'definitive_transition_id': 't08_definitive_4xx',
        'client_response': 'not_submitted_require_new_f5_prepare',
        'f12_rejected_projection': 'forbidden'},
    'record_schemas': copy.deepcopy(RECORD_SCHEMAS),
    'schema_examples': copy.deepcopy(SCHEMA_EXAMPLES),
    'recovery_contract': copy.deepcopy(RECOVERY_CONTRACT),
    'graph_authority': {
        'allowed_transitions': copy.deepcopy(list(ALLOWED_TRANSITIONS)),
        'cut_point_table': copy.deepcopy(list(CUT_POINT_TABLE)),
        'transition_payload_schemas': copy.deepcopy(
            TRANSITION_PAYLOAD_SCHEMAS)},
    'state_rules': copy.deepcopy(STATE_RULES),
    'record_instances': {
        'wallet_payload': copy.deepcopy(WALLET_PAYLOAD_EXAMPLE),
        'replay_material_template': copy.deepcopy(REPLAY_TEMPLATE),
        'provider_response_template': copy.deepcopy(RESPONSE_TEMPLATE),
        'verified_event_binding_template': copy.deepcopy(
            VERIFIED_EVENT_TEMPLATE),
        'recovery_lease_template': copy.deepcopy(LEASE_TEMPLATE),
        'zero_byte_proof_template': copy.deepcopy(ZERO_TEMPLATE),
        'synchronous_5xx_templates': copy.deepcopy(FIVE_TEMPLATES),
        'operator_close_template': copy.deepcopy(OPERATOR_TEMPLATE),
        'result_binding_tombstone_template': copy.deepcopy(TOMBSTONE_TEMPLATE),
        'submission_attempt_instances': copy.deepcopy(ATTEMPT_INSTANCES),
        'audit_histories': copy.deepcopy(AUDIT_HISTORIES)},
    'result_access': {
        'method': 'GET', 'path': '/v1/transfer/current-result',
        'query_exact_keys': [], 'body_exact_keys': [],
        'response_union': ['TransferResultSnapshot', 'unavailable'],
        'cursor_location': 'private_authenticated_server_session_only',
        'caller_supplied_handle_or_id': 'forbidden',
        'excluded_from_url_query_log_history': [
            'action_id', 'submission_record_id',
            'result_binding_handle', 'cursor']},
    'provider_reads': {
        'rest': {
            'method': 'GET',
            'path': '/v1/wallets/{wallet_id}/actions/{action_id}',
            'query': {'include': 'steps'},
            'wallet_and_action_ids': 'server_bound_only',
            'status_map': {
                'pending': 'pending', 'succeeded': 'succeeded',
                'rejected': 'rejected', 'failed': 'failed'},
            'unrecognized_status_policy':
                'quarantine_and_project_unavailable_then_privy_schema_audit',
            'cadence_ms': {
                'initial': 2000, 'maximum': 30000,
                'multiplier_numerator': 3, 'multiplier_denominator': 2},
            'pending_authenticated_reload_resume': True,
            'first_terminal_permanently_stops_across': [
                'route_change', 'visibility_change', 'reload'],
            'role': 'primary_polling_and_conflict_reconciliation_source'},
        'webhook': {
            'enabled': False,
            'enablement':
                'privy_enterprise_credentialed_schema_signature_audit_required',
            'event_map': {
                'wallet_action.transfer.created': 'pending',
                'wallet_action.transfer.succeeded': 'succeeded',
                'wallet_action.transfer.rejected': 'rejected',
                'wallet_action.transfer.failed': 'failed'},
            'verified_raw_body_and_exact_action_binding_required': True,
            'role': 'enterprise_optimization_not_authority_replacement'},
        'merge_rules': {
            'event_id_dedupe': True,
            'pending_to_single_terminal': True,
            'terminal_conflict': 'quarantine_then_rest_reconcile',
            'same_terminal': 'merge_steps',
            'pre_response_inbox': {
                'capacity': 128, 'ttl_ms': 300000,
                'overflow': 'quarantine_then_rest_reconcile'},
            'similar_transaction_binding': 'forbidden'}},
    'staging_r0_command_evidence_map': copy.deepcopy(R0_MAP),
}

def exact_hex64(value, where):
    require_contract(type(value) is str and
                     bool(re.fullmatch(r'[0-9a-f]{64}', value)),
                     f'{where} must be lowercase hex64')

def positive_integer(value, where):
    exact_integer(value, where, 1, 9007199254740991)

def canonical_base64_bytes(value, where, minimum=1, maximum=131072):
    bounded_string(value, where, 1, maximum * 2)
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as error:
        raise ContractViolation(f'{where} invalid base64') from error
    require_contract(minimum <= len(decoded) <= maximum,
                     f'{where} decoded bytes must be {minimum}..{maximum}')
    require_contract(base64.b64encode(decoded).decode('ascii') == value,
                     f'{where} must use canonical base64 encoding')
    return decoded

def strict_canonical_json_bytes(value, where):
    try:
        parsed = json.loads(value.decode('utf-8'),
                            object_pairs_hook=_reject_duplicate_pairs,
                            parse_float=_reject_json_number,
                            parse_constant=_reject_json_number)
    except (UnicodeError, json.JSONDecodeError, ContractViolation) as error:
        raise ContractViolation(f'{where} canonical JSON invalid') from error
    canonical = json.dumps(parsed, ensure_ascii=False,
                           separators=(',', ':')).encode('utf-8')
    require_contract(canonical == value, f'{where} must be canonical JSON')
    return parsed

def validate_replay_material(replay, wallet_payload, where):
    exact_object(replay, RECORD_SCHEMAS['replay_material']['exact_keys'], where)
    require_contract(replay['evidence_class'] == SCHEMA_EXAMPLE,
                     f'{where} must disclaim provider evidence')
    exact_integer(replay['schema_version'], f'{where}.schema_version', 1, 1)
    for key in ('submission_record_id', 'owner_user_id', 'wallet_id'):
        bounded_opaque_id(replay[key], f'{where}.{key}')
    positive_integer(replay['record_version'], f'{where}.record_version')
    require_contract(replay['url'] == wallet_payload['url'] and
                     replay['method'] == wallet_payload['method'] == 'POST' and
                     type_strict_equal(replay['signed_headers'],
                                       wallet_payload['headers']),
                     f'{where} URL/method/headers must equal wallet fixture')
    body_bytes = canonical_base64_bytes(replay['body_base64'],
                                        f'{where}.body_base64')
    parsed_body = strict_canonical_json_bytes(body_bytes, f'{where}.body')
    require_contract(body_bytes != b'{}' and
                     type_strict_equal(parsed_body, wallet_payload['body']),
                     f'{where} body must be canonical JSON equal to wallet fixture body')
    exact_hex64(replay['body_sha256'], f'{where}.body_sha256')
    require_contract(hashlib.sha256(body_bytes).hexdigest() ==
                     replay['body_sha256'], f'{where} body digest mismatch')
    envelope_bytes = canonical_base64_bytes(
        replay['official_formatter_envelope_bytes_base64'],
        f'{where}.official_formatter_envelope_bytes_base64')
    envelope = strict_canonical_json_bytes(
        envelope_bytes, f'{where}.official_formatter_envelope')
    exact_object(envelope, ('version', 'url', 'method', 'headers', 'body'),
                 f'{where}.official_formatter_envelope')
    validate_wallet_payload(envelope, f'{where}.official_formatter_envelope')
    require_contract(
        type_strict_equal(envelope, wallet_payload) and
        envelope['url'] == replay['url'] and
        envelope['method'] == replay['method'] == 'POST' and
        type_strict_equal(envelope['headers'], replay['signed_headers']) and
        type_strict_equal(envelope['body'], parsed_body),
        f'{where} full envelope must bind exact URL/POST/headers/body fixture')
    require_contract(envelope_bytes != body_bytes,
                     f'{where} body bytes cannot substitute for full envelope bytes')
    canonical_base64_bytes(replay['authorization_signature_base64'],
                           f'{where}.signature', 8, 131072)
    bounded_string(replay['idempotency_key'],
                   f'{where}.idempotency_key', 16, 255)
    require_contract(replay['idempotency_key'] ==
                     replay['signed_headers']['privy-idempotency-key'],
                     f'{where} duplicated idempotency key mismatch')
    expiry = exact_integer(replay['request_expiry_ms'],
                           f'{where}.request_expiry_ms')
    require_contract(str(expiry) ==
                     replay['signed_headers']['privy-request-expiry'],
                     f'{where} duplicated expiry mismatch')
    exact_hex64(replay['official_formatter_envelope_sha256'],
                f'{where}.official_formatter_envelope_sha256')
    require_contract(hashlib.sha256(envelope_bytes).hexdigest() ==
                     replay['official_formatter_envelope_sha256'],
                     f'{where} stored full envelope bytes/digest mismatch')
    require_contract(replay['encrypted_at_rest'] is True,
                     f'{where} must be encrypted at rest')

def validate_response_record(response, where):
    exact_object(response, RECORD_SCHEMAS['provider_response_record']['exact_keys'],
                 where)
    require_contract(response['evidence_class'] == SCHEMA_EXAMPLE,
                     f'{where} must disclaim provider evidence')
    exact_integer(response['schema_version'], f'{where}.schema_version', 1, 1)
    for key in ('submission_record_id', 'owner_user_id', 'wallet_id'):
        bounded_opaque_id(response[key], f'{where}.{key}')
    positive_integer(response['response_record_version'],
                     f'{where}.response_record_version')
    positive_integer(response['fencing_token'], f'{where}.fencing_token')
    exact_integer(response['http_status'], f'{where}.http_status', 100, 599)
    exact_integer(response['received_at_ms'], f'{where}.received_at_ms')
    exact_hex64(response['response_body_sha256'], f'{where}.body_sha256')
    encrypted = canonical_base64_bytes(
        response['encrypted_response_body_base64'],
        f'{where}.encrypted_body', 1, 65536)
    require_contract(response['body_encoding'] == 'base64',
                     f'{where}.body_encoding must be base64')
    require_contract(exact_integer(
        response['encrypted_body_byte_length'], f'{where}.byte_length',
        1, 65536) == len(encrypted), f'{where} byte length mismatch')
    pair = (response['provider_action_id'], response['provider_wallet_id'])
    require_contract((all(item is None for item in pair) or
                      all(type(item) is str for item in pair)),
                     f'{where} action/wallet IDs must be both null or both strings')
    for key in ('provider_action_id', 'provider_wallet_id'):
        if response[key] is not None:
            bounded_opaque_id(response[key], f'{where}.{key}')
    if response['provider_schema_version'] is not None:
        bounded_string(response['provider_schema_version'],
                       f'{where}.provider_schema_version', 1, 64)
    exact_hex64(response['record_digest'], f'{where}.record_digest')

def validate_verified_event_record(record, where):
    exact_object(
        record,
        RECORD_SCHEMAS['verified_event_binding_record']['exact_keys'], where)
    require_contract(record['evidence_class'] == SCHEMA_EXAMPLE,
                     f'{where} must disclaim provider evidence')
    exact_integer(record['schema_version'], f'{where}.schema_version', 1, 1)
    for key in ('submission_record_id', 'owner_user_id', 'wallet_id',
                'event_id', 'provider_action_id'):
        bounded_opaque_id(record[key], f'{where}.{key}')
    positive_integer(record['record_version'], f'{where}.record_version')
    positive_integer(record['fencing_token'], f'{where}.fencing_token')
    exact_integer(record['received_at_ms'], f'{where}.received_at_ms')
    exact_hex64(record['raw_body_sha256'], f'{where}.raw_body_sha256')
    require_contract(record['signature_verified'] is True and
                     record['exact_action_binding_verified'] is True,
                     f'{where} verified event proof booleans required')
    exact_hex64(record['record_digest'], f'{where}.record_digest')

def validate_action_binding_evidence(evidence, attempt, where):
    exact_object(
        evidence, RECORD_SCHEMAS['action_binding_evidence']['exact_keys'], where)
    kind = exact_enum(evidence['kind'], ('post_response', 'verified_event'),
                      f'{where}.kind')
    if kind == 'post_response':
        require_contract(evidence['verified_event_binding_record'] is None and
                         evidence['provider_response_record'] is not None,
                         f'{where} post_response exact union mismatch')
        record = evidence['provider_response_record']
        validate_response_record(record, f'{where}.provider_response_record')
        validate_bound_identity(record, attempt, 'response_record_version',
                                f'{where}.provider_response_record',
                                expected_version=attempt['record_version'] - 1)
        require_contract(type_strict_equal(
            record, attempt['provider_response_record']),
            f'{where} must reference the durable provider response record')
        action_id = record['provider_action_id']
    else:
        require_contract(evidence['provider_response_record'] is None and
                         evidence['verified_event_binding_record'] is not None,
                         f'{where} verified_event exact union mismatch')
        record = evidence['verified_event_binding_record']
        validate_verified_event_record(
            record, f'{where}.verified_event_binding_record')
        validate_bound_identity(record, attempt, 'record_version',
                                f'{where}.verified_event_binding_record')
        require_contract(attempt['provider_response_record'] is None,
                         f'{where} verified event must not fabricate POST response')
        action_id = record['provider_action_id']
    require_contract(action_id == attempt['provider_action_id'],
                     f'{where} action ID must bind exact durable record')

def validate_bound_identity(record, attempt, version_key, where, *,
                            expected_version=None):
    if expected_version is None:
        expected_version = attempt['record_version']
    require_contract(record['submission_record_id'] ==
                     attempt['submission_record_id'] and
                     record['owner_user_id'] == attempt['owner_user_id'] and
                     record['wallet_id'] == attempt['wallet_id'] and
                     record[version_key] == expected_version,
                     f'{where} parent identity/version mismatch')
    require_contract(record.get('fencing_token', attempt['fencing_token']) ==
                     attempt['fencing_token'],
                     f'{where} parent fencing token mismatch')

def validate_simple_proof(record, schema_name, attempt, where):
    exact_object(record, RECORD_SCHEMAS[schema_name]['exact_keys'], where)
    require_contract(record['evidence_class'] == SCHEMA_EXAMPLE,
                     f'{where} must disclaim provider evidence')
    exact_integer(record['schema_version'], f'{where}.schema_version', 1, 1)
    for key in ('submission_record_id', 'owner_user_id', 'wallet_id'):
        bounded_opaque_id(record[key], f'{where}.{key}')
    positive_integer(record['record_version'], f'{where}.record_version')
    if 'fencing_token' in record:
        positive_integer(record['fencing_token'], f'{where}.fencing_token')
    validate_bound_identity(record, attempt, 'record_version', where)

def validate_attempt(attempt, wallet_payload, allowlist, where):
    exact_object(attempt, ATTEMPT_KEYS, where)
    require_contract(attempt['evidence_class'] == SCHEMA_EXAMPLE,
                     f'{where} must disclaim provider evidence')
    exact_integer(attempt['schema_version'], f'{where}.schema_version', 1, 1)
    for key in ('submission_record_id', 'owner_user_id', 'wallet_id',
                'internal_review_id'):
        bounded_opaque_id(attempt[key], f'{where}.{key}')
    positive_integer(attempt['record_version'], f'{where}.record_version')
    exact_hex64(attempt['signed_request_digest'], f'{where}.signed_request_digest')
    bounded_string(attempt['idempotency_key'], f'{where}.idempotency_key', 16, 255)
    exact_integer(attempt['request_expiry_ms'], f'{where}.request_expiry_ms')
    state = exact_enum(attempt['state'], ATTEMPT_STATES, f'{where}.state')
    if state == 'submission_unknown':
        exact_enum(attempt['unknown_reason'], UNKNOWN_REASONS,
                   f'{where}.unknown_reason')
    else:
        require_contract(attempt['unknown_reason'] is None,
                         f'{where}.unknown_reason forbidden outside unknown')
    positive_integer(attempt['fencing_token'], f'{where}.fencing_token')
    replay_count = exact_integer(
        attempt['exact_replay_count'], f'{where}.exact_replay_count', 0, 1)
    transport_ordinal = exact_integer(
        attempt['transport_ordinal'], f'{where}.transport_ordinal', 1, 2)
    replay_origin = exact_enum(
        attempt['replay_origin'], ('initial_submission', 'exact_replay'),
        f'{where}.replay_origin')
    require_contract(
        (replay_count, transport_ordinal, replay_origin) in (
            (0, 1, 'initial_submission'), (1, 2, 'exact_replay')),
        f'{where} replay origin/transport ordinal/count mismatch')
    replay_reason = attempt['replay_reason']
    if replay_count == 0:
        require_contract(replay_reason is None,
                         f'{where} replay_reason forbidden before replay')
    else:
        exact_enum(replay_reason, REPLAY_REASONS, f'{where}.replay_reason')
    exact_integer(attempt['created_at_ms'], f'{where}.created_at_ms')
    exact_integer(attempt['updated_at_ms'], f'{where}.updated_at_ms')
    require_contract(attempt['updated_at_ms'] >= attempt['created_at_ms'],
                     f'{where} updated precedes created')
    if state == 'transport_in_progress' and replay_count == 1:
        require_contract(attempt['updated_at_ms'] <
                         attempt['request_expiry_ms'],
                         f'{where} exact replay in progress must start before signed expiry')
    if attempt['unknown_reason'] == 'signed_expiry_elapsed':
        require_contract(attempt['updated_at_ms'] >=
                         attempt['request_expiry_ms'],
                         f'{where} signed expiry observation must be at/after expiry')
    rule = STATE_RULES[state]
    expected_replay = rule['replay']
    require_contract((attempt['replay_material'] is not None) is expected_replay,
                     f'{where} replay presence mismatch')
    if attempt['replay_material'] is not None:
        validate_replay_material(attempt['replay_material'], wallet_payload,
                                 f'{where}.replay_material')
        validate_bound_identity(attempt['replay_material'], attempt,
                                'record_version', f'{where}.replay_material')
        require_contract(attempt['idempotency_key'] ==
                         attempt['replay_material']['idempotency_key'] and
                         attempt['request_expiry_ms'] ==
                         attempt['replay_material']['request_expiry_ms'] and
                         attempt['signed_request_digest'] ==
                         attempt['replay_material'][
                             'official_formatter_envelope_sha256'],
                         f'{where} attempt/replay envelope-digest/key/expiry mismatch')
    require_contract((attempt['recovery_lease'] is not None) is rule['lease'],
                     f'{where} recovery lease presence mismatch')
    if attempt['recovery_lease'] is not None:
        validate_simple_proof(attempt['recovery_lease'], 'recovery_lease',
                              attempt, f'{where}.recovery_lease')
        bounded_opaque_id(attempt['recovery_lease']['lease_owner'],
                          f'{where}.lease_owner')
        exact_integer(attempt['recovery_lease']['lease_expires_at_ms'],
                      f'{where}.lease_expires_at_ms')
    response_expected = (
        rule['response'] is True or
        (rule['response'] == 'binding_dependent' and
         type(attempt['action_binding_evidence']) is dict and
         attempt['action_binding_evidence'].get('kind') == 'post_response') or
        (rule['response'] == 'reason_dependent' and
         attempt['unknown_reason'] == 'nonallowlisted_4xx'))
    require_contract((attempt['provider_response_record'] is not None) is
                     response_expected, f'{where} response presence mismatch')
    if attempt['provider_response_record'] is not None:
        validate_response_record(attempt['provider_response_record'],
                                 f'{where}.provider_response')
        expected_response_version = (
            attempt['record_version'] - 1
            if state == 'action_bound' else attempt['record_version'])
        validate_bound_identity(attempt['provider_response_record'], attempt,
                                'response_record_version',
                                f'{where}.provider_response',
                                expected_version=expected_response_version)
        require_contract(attempt['provider_action_id'] ==
                         attempt['provider_response_record']['provider_action_id'],
                         f'{where} action relation mismatch')
        if attempt['unknown_reason'] == 'nonallowlisted_4xx':
            require_contract(
                400 <= attempt['provider_response_record']['http_status'] <= 499 and
                all(not type_strict_equal({
                    'http_status': attempt['provider_response_record']['http_status'],
                    'privy_error_code': 'PRIVY_SCHEMA_EXAMPLE',
                    'response_schema_version':
                        attempt['provider_response_record']['provider_schema_version'],
                }, item) for item in allowlist),
                f'{where} nonallowlisted 4xx relation mismatch')
    require_contract((attempt['provider_action_id'] is not None) is rule['action'],
                     f'{where} action presence mismatch')
    require_contract((attempt['action_binding_evidence'] is not None) is
                     rule['binding'], f'{where} action binding presence mismatch')
    if attempt['action_binding_evidence'] is not None:
        validate_action_binding_evidence(
            attempt['action_binding_evidence'], attempt,
            f'{where}.action_binding_evidence')
    fives = attempt['synchronous_5xx_records']
    require_contract(type(fives) is list and len(fives) <= 2,
                     f'{where} 5xx list bound')
    if attempt['unknown_reason'] == 'first_synchronous_5xx_before_replay':
        expected_fives = (0, 1)
    elif (attempt['unknown_reason'] ==
          'second_synchronous_5xx_after_exact_replay'):
        expected_fives = (1, 2)
    elif replay_count == 1:
        expected_fives = (
            1, 1 if replay_reason == 'first_synchronous_5xx' else 0)
    else:
        expected_fives = (0, 0)
    require_contract((replay_count, len(fives)) == expected_fives,
                     f'{where} unknown reason/replay/5xx discriminator mismatch')
    for ordinal, record in enumerate(fives, 1):
        exact_object(record, RECORD_SCHEMAS['synchronous_5xx_record']['exact_keys'],
                     f'{where}.5xx[{ordinal}]')
        require_contract(record['evidence_class'] == SCHEMA_EXAMPLE,
                         f'{where}.5xx evidence disclaimer')
        exact_integer(record['schema_version'], f'{where}.5xx.schema', 1, 1)
        exact_integer(record['ordinal'], f'{where}.5xx.ordinal', ordinal, ordinal)
        exact_integer(record['http_status'], f'{where}.5xx.status', 500, 599)
        exact_integer(record['received_at_ms'], f'{where}.5xx.received')
        exact_hex64(record['response_body_sha256'], f'{where}.5xx.digest')
        positive_integer(record['record_version'], f'{where}.5xx.version')
        positive_integer(record['fencing_token'], f'{where}.5xx.fence')
        for key in ('submission_record_id', 'owner_user_id', 'wallet_id'):
            require_contract(record[key] == attempt[key],
                             f'{where}.5xx identity mismatch')
        require_contract(record['fencing_token'] == attempt['fencing_token'] and
                         record['record_version'] <= attempt['record_version'],
                         f'{where}.5xx version/fence mismatch')
    if fives:
        if (replay_count == 1 and len(fives) == 1 and
                replay_reason == 'first_synchronous_5xx'):
            replay_offsets = {
                'transport_in_progress': 1,
                'response_recorded': 2,
                'action_bound': 3,
            }
            require_contract(state in replay_offsets,
                             f'{where} successful replay state unsupported')
            expected_latest_version = (
                attempt['record_version'] - replay_offsets[state])
        else:
            expected_latest_version = attempt['record_version']
        require_contract(
            expected_latest_version >= 1 and
            fives[-1]['record_version'] == expected_latest_version,
            f'{where} append-only 5xx history/current parent version mismatch')
    require_contract((attempt['zero_byte_proof'] is not None) is rule['zero'],
                     f'{where} zero proof presence mismatch')
    if attempt['zero_byte_proof'] is not None:
        validate_simple_proof(attempt['zero_byte_proof'], 'zero_byte_proof',
                              attempt, f'{where}.zero')
        exact_enum(attempt['zero_byte_proof']['primitive'],
                   ('http_client_prewrite_counter', 'audited_transport_receipt'),
                   f'{where}.zero.primitive')
        exact_integer(attempt['zero_byte_proof']['proved_at_ms'],
                      f'{where}.zero.proved_at_ms')
        exact_hex64(attempt['zero_byte_proof']['evidence_digest'],
                    f'{where}.zero.digest')
    is_closed = state == 'operator_closed'
    require_contract((attempt['operator_close_evidence'] is not None) is
                     rule['operator'] and
                     (attempt['result_binding_tombstone'] is not None) is
                     rule['tombstone'], f'{where} close/tombstone presence mismatch')
    if is_closed:
        close = attempt['operator_close_evidence']
        tombstone = attempt['result_binding_tombstone']
        validate_simple_proof(close, 'operator_close_evidence', attempt,
                              f'{where}.operator_close')
        validate_simple_proof(tombstone, 'result_binding_tombstone', attempt,
                              f'{where}.tombstone')
        require_contract(close['proved_no_action'] is True and
                         tombstone['reusable'] is False,
                         f'{where} close proof/tombstone constants')
        for key in ('provider_evidence_digest',):
            exact_hex64(close[key], f'{where}.close.{key}')
        exact_enum(close['reason_code'],
                   ('PROVIDER_CONFIRMED_NO_ACTION',
                    'AUDITED_CHAIN_CONFIRMED_NO_ACTION'),
                   f'{where}.close.reason_code')
        bounded_opaque_id(close['actor_id'], f'{where}.close.actor_id')
        exact_integer(close['closed_at_ms'], f'{where}.close.closed_at_ms')
        exact_hex64(tombstone['evidence_digest'], f'{where}.tombstone.digest')
        require_contract(
            close['closed_at_ms'] == tombstone['closed_at_ms'] ==
            attempt['updated_at_ms'] and
            tombstone['evidence_digest'] == close['provider_evidence_digest'] and
            close['provider_evidence_digest'] ==
            operator_evidence_digest(close),
            f'{where} close/tombstone/attempt time and evidence mismatch')
    if not allowlist:
        require_contract(state != 'provider_rejected_before_action',
                         f'{where} provider_rejected active instance forbidden')
    if state in ('action_bound', 'proved_not_submitted', 'operator_closed'):
        require_contract(attempt['replay_material'] is None,
                         f'{where} terminal state must erase replay material')

def validate_transition_payload(transition_id, payload, where):
    schema = TRANSITION_PAYLOAD_SCHEMAS[transition_id]
    payload = exact_object(payload, tuple(schema), where)
    for key, field_type in schema.items():
        value = payload[key]
        if field_type == 'hex64':
            exact_hex64(value, f'{where}.{key}')
        elif field_type == 'positive_integer':
            positive_integer(value, f'{where}.{key}')
        elif field_type == 'nonnegative_integer':
            exact_integer(value, f'{where}.{key}')
        elif field_type == 'timestamp':
            exact_integer(value, f'{where}.{key}')
        elif field_type == 'http_4xx':
            exact_integer(value, f'{where}.{key}', 400, 499)
        elif field_type == 'unknown_reason':
            exact_enum(value, UNKNOWN_REASONS, f'{where}.{key}')
        elif field_type == 'replay_origin':
            exact_enum(value, ('initial_submission', 'exact_replay'),
                       f'{where}.{key}')
        elif field_type == 'replay_reason':
            exact_enum(value, REPLAY_REASONS, f'{where}.{key}')
        else:
            bounded_opaque_id(value, f'{where}.{key}')
    if transition_id == 't06_second_5xx':
        require_contract(payload['ordinal'] == 2,
                         f'{where} second 5xx ordinal must be 2')
    if transition_id == 't07_nonallowlisted_4xx':
        require_contract(payload['unknown_reason'] == 'nonallowlisted_4xx',
                         f'{where} nonallowlisted 4xx reason mismatch')
    if transition_id == 't09_exact_replay':
        require_contract(
            payload['exact_replay_count'] == 1 and
            payload['transport_ordinal'] == 2 and
            payload['replay_origin'] == 'exact_replay' and
            ((payload['replay_reason'] == 'first_synchronous_5xx' and
              payload['retained_5xx_count'] == 1) or
             (payload['replay_reason'] == 'other_uncertain' and
              payload['retained_5xx_count'] == 0)) and
            type(payload['retained_5xx_count']) is int,
            f'{where} replay successor must preserve prior 5xx count and ordinal two')
        require_contract(payload['observed_at_ms'] <
                         payload['request_expiry_ms'],
                         f'{where} replay observation must precede signed expiry')
    if transition_id == 't13_expiry':
        require_contract(payload['observed_at_ms'] >=
                         payload['request_expiry_ms'],
                         f'{where} expiry observation must be at/after signed expiry')
    if transition_id == 't16_second_uncertain':
        require_contract(payload['transport_ordinal'] == 2 and
                         payload['exact_replay_count'] == 1 and
                         payload['unknown_reason'] ==
                         'second_uncertain_after_exact_replay',
                         f'{where} second uncertain replay invariant mismatch')

def validate_audit_histories(histories):
    require_contract(type(histories) is list and
                     len(histories) == len(ALLOWED_TRANSITIONS),
                     'one independent audit history per coverage transition required')
    transition_by_id = {
        item['transition_id']: item for item in ALLOWED_TRANSITIONS}
    coverage = []
    for history_index, history in enumerate(histories):
        where = f'audit_histories[{history_index}]'
        exact_object(history, RECORD_SCHEMAS['audit_history']['exact_keys'], where)
        require_contract(history['evidence_class'] == SCHEMA_EXAMPLE,
                         f'{where} must disclaim provider evidence')
        exact_integer(history['schema_version'], f'{where}.schema_version', 1, 1)
        for key in ('history_id', 'coverage_transition_id',
                    'submission_record_id', 'owner_user_id', 'wallet_id'):
            bounded_opaque_id(history[key], f'{where}.{key}')
        coverage_id = history['coverage_transition_id']
        require_contract(coverage_id in transition_by_id,
                         f'{where} unknown coverage transition')
        coverage.append(coverage_id)
        events = history['events']
        require_contract(type(events) is list and len(events) >= 2,
                         f'{where} needs lock plus legal transition path')
        first = exact_object(events[0], AUDIT_EVENT_KEYS, f'{where}.lock')
        require_contract(first['evidence_class'] == SCHEMA_EXAMPLE,
                         f'{where}.lock evidence disclaimer')
        exact_integer(first['schema_version'], f'{where}.lock.schema', 1, 1)
        for key in ('event_id', 'submission_record_id',
                    'owner_user_id', 'wallet_id'):
            bounded_opaque_id(first[key], f'{where}.lock.{key}')
        require_contract(
            first['transition_id'] == 'attempt_lock' and
            first['event_type'] == 'attempt_lock_committed' and
            first['before_record_version'] is None and
            first['before_fencing_token'] is None and
            first['predecessor_state'] is None and
            first['successor_state'] == 'committed_before_write',
            f'{where} first lock null-before contract mismatch')
        positive_integer(first['after_record_version'],
                         f'{where}.lock.after_version')
        positive_integer(first['after_fencing_token'],
                         f'{where}.lock.after_fence')
        exact_integer(first['occurred_at_ms'], f'{where}.lock.time')
        exact_hex64(first['evidence_digest'], f'{where}.lock.digest')
        lock_payload = exact_object(
            first['payload'], ('lock_key_digest',), f'{where}.lock.payload')
        exact_hex64(lock_payload['lock_key_digest'],
                    f'{where}.lock.payload.digest')
        identity = (history['submission_record_id'], history['owner_user_id'],
                    history['wallet_id'])
        require_contract(
            identity == (first['submission_record_id'], first['owner_user_id'],
                         first['wallet_id']),
            f'{where} history/lock identity mismatch')
        previous = first
        for event_index, event in enumerate(events[1:], 1):
            event_where = f'{where}.events[{event_index}]'
            event = exact_object(event, AUDIT_EVENT_KEYS, event_where)
            require_contract(event['evidence_class'] == SCHEMA_EXAMPLE,
                             f'{event_where} evidence disclaimer')
            exact_integer(event['schema_version'], f'{event_where}.schema', 1, 1)
            transition_id = bounded_opaque_id(
                event['transition_id'], f'{event_where}.transition_id')
            require_contract(transition_id in transition_by_id,
                             f'{event_where} unknown transition')
            transition = transition_by_id[transition_id]
            require_contract(
                event['event_type'] == transition['audit_event_type'] and
                event['predecessor_state'] == transition['from'] and
                event['successor_state'] == transition['to'],
                f'{event_where} transition/event/from/to mismatch')
            for key in ('event_id', 'submission_record_id',
                        'owner_user_id', 'wallet_id'):
                bounded_opaque_id(event[key], f'{event_where}.{key}')
            require_contract(
                identity == (event['submission_record_id'],
                             event['owner_user_id'], event['wallet_id']),
                f'{event_where} cross-submission/owner/wallet event')
            for key in ('before_record_version', 'before_fencing_token',
                        'after_record_version', 'after_fencing_token'):
                positive_integer(event[key], f'{event_where}.{key}')
            require_contract(
                event['predecessor_state'] == previous['successor_state'] and
                event['before_record_version'] ==
                previous['after_record_version'] and
                event['before_fencing_token'] ==
                previous['after_fencing_token'] and
                event['after_record_version'] ==
                event['before_record_version'] + 1 and
                event['after_fencing_token'] >=
                event['before_fencing_token'],
                f'{event_where} per-history state/CAS/fence continuity mismatch')
            exact_integer(event['occurred_at_ms'], f'{event_where}.time')
            require_contract(event['occurred_at_ms'] >=
                             previous['occurred_at_ms'],
                             f'{event_where} time moved backwards')
            exact_hex64(event['evidence_digest'], f'{event_where}.digest')
            validate_transition_payload(
                transition_id, event['payload'], f'{event_where}.payload')
            if transition_id in ('t09_exact_replay', 't13_expiry'):
                require_contract(
                    event['occurred_at_ms'] ==
                    event['payload']['observed_at_ms'],
                    f'{event_where} occurrence must bind temporal observation')
            previous = event
        require_contract(events[-1]['transition_id'] == coverage_id,
                         f'{where} final event must be designated coverage transition')
    require_contract(coverage == [item['transition_id']
                                  for item in ALLOWED_TRANSITIONS],
                     'audit history transition coverage/order must be exact')

def validate_successful_replay_timeline(attempt, history, where):
    require_contract(
        attempt['state'] == 'action_bound' and
        attempt['replay_origin'] == 'exact_replay' and
        attempt['replay_reason'] == 'first_synchronous_5xx' and
        attempt['exact_replay_count'] == 1 and
        attempt['transport_ordinal'] == 2,
        f'{where} terminal replay discriminator mismatch')
    events = history['events']
    require_contract(
        [event['transition_id'] for event in events] == [
            'attempt_lock', 't01_transport_start', 't05_first_5xx',
            't09_exact_replay', 't10_response_record',
            't11_atomic_binding'],
        f'{where} exact successful replay history required')
    by_id = {event['transition_id']: event for event in events}
    first_5xx = attempt['synchronous_5xx_records'][0]
    response = attempt['provider_response_record']
    t01 = by_id['t01_transport_start']
    t05 = by_id['t05_first_5xx']
    t09 = by_id['t09_exact_replay']
    t10 = by_id['t10_response_record']
    t11 = by_id['t11_atomic_binding']
    identities = [
        (item['submission_record_id'], item['owner_user_id'], item['wallet_id'])
        for item in (first_5xx, response)]
    expected_identity = (
        attempt['submission_record_id'], attempt['owner_user_id'],
        attempt['wallet_id'])
    history_identity = (
        history['submission_record_id'], history['owner_user_id'],
        history['wallet_id'])
    event_identities = [
        (event['submission_record_id'], event['owner_user_id'],
         event['wallet_id'])
        for event in events]
    require_contract(
        history_identity == expected_identity and
        all(identity == history_identity for identity in event_identities),
        f'{where} history/event identity must bind terminal attempt')
    require_contract(
        all(
            current['predecessor_state'] == previous['successor_state'] and
            current['before_record_version'] ==
            previous['after_record_version'] and
            current['before_fencing_token'] ==
            previous['after_fencing_token']
            for previous, current in zip(events, events[1:])),
        f'{where} history parent chain must bind one terminal attempt')
    require_contract(all(item == expected_identity for item in identities),
                     f'{where} durable record identity mismatch')
    require_contract(
        t01['payload']['request_digest'] == attempt['signed_request_digest'] and
        t05['payload']['response_body_sha256'] ==
        first_5xx['response_body_sha256'] and
        t10['payload']['provider_response_record_digest'] ==
        t11['payload']['provider_response_record_digest'] ==
        response['record_digest'] and
        t11['payload']['action_id'] ==
        response['provider_action_id'] == attempt['provider_action_id'],
        f'{where} request/5xx/response/action digest binding mismatch')
    require_contract(
        t05['after_record_version'] == first_5xx['record_version'] ==
        attempt['record_version'] - 3 and
        t09['before_record_version'] == first_5xx['record_version'] and
        t09['after_record_version'] == first_5xx['record_version'] + 1 and
        t10['before_record_version'] == t09['after_record_version'] and
        t10['after_record_version'] ==
        response['response_record_version'] == attempt['record_version'] - 1 and
        t11['before_record_version'] == response['response_record_version'] and
        t11['after_record_version'] == attempt['record_version'],
        f'{where} t05/t09/t10/t11 record-version timeline mismatch')
    require_contract(
        t05['after_fencing_token'] == first_5xx['fencing_token'] ==
        t09['before_fencing_token'] == t09['after_fencing_token'] ==
        t10['before_fencing_token'] == t10['after_fencing_token'] ==
        response['fencing_token'] == t11['before_fencing_token'] ==
        t11['after_fencing_token'] == attempt['fencing_token'],
        f'{where} t05/t09/t10/t11 fence timeline mismatch')
    require_contract(
        t05['occurred_at_ms'] == first_5xx['received_at_ms'] <
        t09['occurred_at_ms'] == t09['payload']['observed_at_ms'] <
        response['received_at_ms'] <= t10['occurred_at_ms'] <=
        t11['occurred_at_ms'] == attempt['updated_at_ms'] and
        t09['payload']['observed_at_ms'] < attempt['request_expiry_ms'],
        f'{where} replay response/audit chronology mismatch')

def validate_official_integration(integration):
    exact_object(integration, (
        'schema_version', 'implementation_boundaries', 'project_profile',
        'authorization_flow',
        'recipient_preflight', 'definitive_non_action_4xx', 'record_schemas',
        'schema_examples', 'recovery_contract',
        'graph_authority', 'state_rules', 'record_instances',
        'result_access', 'provider_reads',
        'staging_r0_command_evidence_map'), 'official')
    exact_integer(integration['schema_version'], 'official.schema_version', 1, 1)
    require_contract(type_strict_equal(
        integration['implementation_boundaries'],
        OFFICIAL_INTEGRATION_V4['implementation_boundaries']),
        'Privy core and OSS thin-adapter boundaries mismatch')
    profile = exact_object(
        integration['project_profile'],
        ('profile_id', 'generic_privy_schema_authority', 'profile_scope',
         'idempotency_key_bounds', 'nonce_bounds'), 'official.profile')
    require_contract(type_strict_equal(profile, OFFICIAL_INTEGRATION_V4[
        'project_profile']), 'project profile exact mismatch')
    require_contract(type_strict_equal(
        integration['authorization_flow'],
        OFFICIAL_INTEGRATION_V4['authorization_flow']),
        'authorization page/private command boundary mismatch')
    require_contract(type_strict_equal(
        integration['recipient_preflight'],
        OFFICIAL_INTEGRATION_V4['recipient_preflight']),
        'recipient preflight variant contract mismatch')
    fourxx = exact_object(
        integration['definitive_non_action_4xx'],
        tuple(OFFICIAL_INTEGRATION_V4['definitive_non_action_4xx']),
        'official.definitive_4xx')
    require_contract(type(fourxx['audited_tuple_allowlist']) is list and
                     fourxx['audited_tuple_allowlist'] == [],
                     'audited 4xx tuple allowlist must remain empty')
    require_contract(type_strict_equal(
        integration['record_schemas'], RECORD_SCHEMAS),
        'record schemas exact mismatch')
    examples = exact_object(
        integration['schema_examples'], tuple(SCHEMA_EXAMPLES),
        'official.schema_examples')
    require_contract(examples['evidence_class'] == SCHEMA_EXAMPLE and
                     examples['official_formatter_output_provenance'] ==
                     'not_run_schema_shape_only_not_official_formatter_output',
                     'formatter envelope example must disclaim official evidence')
    validate_wallet_payload(
        examples['official_formatter_envelope'],
        'official.schema_examples.envelope')
    example_bytes = canonical_base64_bytes(
        examples['official_formatter_envelope_bytes_base64'],
        'official.schema_examples.envelope_bytes')
    parsed_example = strict_canonical_json_bytes(
        example_bytes, 'official.schema_examples.envelope_json')
    exact_hex64(examples['official_formatter_envelope_sha256'],
                'official.schema_examples.envelope_sha256')
    require_contract(
        type_strict_equal(parsed_example,
                          examples['official_formatter_envelope']) and
        hashlib.sha256(example_bytes).hexdigest() ==
        examples['official_formatter_envelope_sha256'] and
        example_bytes != CANONICAL_BODY_BYTES,
        'schema example full envelope relation/body separation mismatch')
    recovery = integration['recovery_contract']
    require_contract(type_strict_equal(recovery, RECOVERY_CONTRACT),
                     'exact recovery scan/CAS/lease/fence/replay contract mismatch')
    exact_integer(recovery['periodic_scan']['interval_ms'],
                  'recovery.periodic.interval_ms', 1000, 86400000)
    exact_integer(recovery['lease']['duration_ms'],
                  'recovery.lease.duration_ms', 1000, 86400000)
    exact_integer(recovery['replay']['maximum_exact_replays'],
                  'recovery.replay.maximum', 1, 1)
    graph = exact_object(
        integration['graph_authority'],
        ('allowed_transitions', 'cut_point_table',
         'transition_payload_schemas'), 'official.graph')
    require_contract(type_strict_equal(
        graph['allowed_transitions'], list(ALLOWED_TRANSITIONS)) and
        type_strict_equal(graph['cut_point_table'], list(CUT_POINT_TABLE)) and
        type_strict_equal(graph['transition_payload_schemas'],
                          TRANSITION_PAYLOAD_SCHEMAS),
        'single transition/cut-point/payload graph authority mismatch')
    transition_ids = [item['transition_id']
                      for item in graph['allowed_transitions']]
    require_contract(len(transition_ids) == len(set(transition_ids)) and
                     [item['transition_id'] for item in
                      graph['cut_point_table']] == transition_ids,
                     'transition IDs must be unique and cut points aligned')
    require_contract(type_strict_equal(integration['state_rules'], STATE_RULES),
                     'state presence rules mismatch')
    records = exact_object(
        integration['record_instances'],
        ('wallet_payload', 'replay_material_template',
         'provider_response_template', 'verified_event_binding_template',
         'recovery_lease_template',
         'zero_byte_proof_template', 'synchronous_5xx_templates',
         'operator_close_template', 'result_binding_tombstone_template',
         'submission_attempt_instances', 'audit_histories'),
        'official.record_instances')
    validate_wallet_payload(records['wallet_payload'], 'official.wallet_payload')
    validate_replay_material(records['replay_material_template'],
                             records['wallet_payload'],
                             'official.replay_template')
    validate_response_record(records['provider_response_template'],
                             'official.response_template')
    validate_verified_event_record(
        records['verified_event_binding_template'],
        'official.verified_event_template')
    attempts = records['submission_attempt_instances']
    require_contract(type(attempts) is list and
                     len(attempts) == len(UNKNOWN_INSTANCE_SPECS) + 10,
                     'initial/replay active, terminal/binding union, and all unknown instances required')
    for index, attempt in enumerate(attempts):
        validate_attempt(attempt, records['wallet_payload'],
                         fourxx['audited_tuple_allowlist'],
                         f'official.attempt[{index}]')
    observed_reasons = [item['unknown_reason'] for item in attempts
                        if item['state'] == 'submission_unknown']
    require_contract(observed_reasons == list(UNKNOWN_REASONS),
                     'all unknown reason discriminators must be covered exactly')
    validate_audit_histories(records['audit_histories'])
    attempts_by_reason = {
        item['unknown_reason']: item for item in attempts
        if item['state'] == 'submission_unknown'}
    events_by_transition = {
        history['coverage_transition_id']: history['events'][-1]
        for history in records['audit_histories']}
    histories_by_transition = {
        history['coverage_transition_id']: history
        for history in records['audit_histories']}
    second_5xx_path = {
        event['transition_id']: event
        for event in histories_by_transition['t06_second_5xx']['events'][1:]}
    second_uncertain_path = {
        event['transition_id']: event
        for event in histories_by_transition[
            't16_second_uncertain']['events'][1:]}
    replay_transport = next(
        item for item in attempts
        if item['state'] == 'transport_in_progress' and
        item['replay_reason'] == 'first_synchronous_5xx')
    expiry_attempt = attempts_by_reason['signed_expiry_elapsed']
    require_contract(
        events_by_transition['t05_first_5xx']['payload'][
            'response_body_sha256'] ==
        attempts_by_reason['first_synchronous_5xx_before_replay'][
            'synchronous_5xx_records'][0]['response_body_sha256'] and
        events_by_transition['t06_second_5xx']['payload'][
            'response_body_sha256'] ==
        attempts_by_reason['second_synchronous_5xx_after_exact_replay'][
            'synchronous_5xx_records'][1]['response_body_sha256'] and
        events_by_transition['t07_nonallowlisted_4xx']['payload'][
            'provider_response_record_digest'] ==
        attempts_by_reason['nonallowlisted_4xx'][
            'provider_response_record']['record_digest'] and
        events_by_transition['t09_exact_replay']['payload'][
            'retained_5xx_count'] == 1 and
        events_by_transition['t16_second_uncertain']['payload'][
            'exact_replay_count'] ==
        attempts_by_reason['second_uncertain_after_exact_replay'][
            'exact_replay_count'] and
        second_5xx_path['t05_first_5xx']['payload'][
            'response_body_sha256'] ==
        attempts_by_reason['second_synchronous_5xx_after_exact_replay'][
            'synchronous_5xx_records'][0]['response_body_sha256'] and
        second_5xx_path['t09_exact_replay']['payload'][
            'retained_5xx_count'] == 1 and
        second_uncertain_path['t09_exact_replay']['payload'][
            'retained_5xx_count'] == 0 and
        events_by_transition['t09_exact_replay']['payload'][
            'request_expiry_ms'] == replay_transport['request_expiry_ms'] and
        events_by_transition['t09_exact_replay']['payload'][
            'observed_at_ms'] == replay_transport['updated_at_ms'] and
        events_by_transition['t13_expiry']['payload'][
            'request_expiry_ms'] == expiry_attempt['request_expiry_ms'] and
        events_by_transition['t13_expiry']['payload'][
            'observed_at_ms'] == expiry_attempt['updated_at_ms'],
        '5xx/4xx/replay AuditEvent payloads must bind durable attempt records')
    post_bound = next(item for item in attempts
                      if item['state'] == 'action_bound' and
                      item['action_binding_evidence']['kind'] == 'post_response' and
                      item['replay_reason'] == 'first_synchronous_5xx')
    replay_response = next(item for item in attempts
                           if item['state'] == 'response_recorded' and
                           item['replay_reason'] == 'first_synchronous_5xx')
    event_bound = next(item for item in attempts
                       if item['state'] == 'action_bound' and
                       item['action_binding_evidence']['kind'] ==
                       'verified_event')
    closed = next(item for item in attempts if item['state'] == 'operator_closed')
    post_history = next(
        history for history in records['audit_histories']
        if history['coverage_transition_id'] == 't11_atomic_binding')
    post_history_events = {
        event['transition_id']: event for event in post_history['events'][1:]}
    validate_successful_replay_timeline(
        post_bound, post_history, 'official.successful_replay_timeline')
    require_contract(
        post_history_events['t05_first_5xx']['payload'][
            'response_body_sha256'] ==
        post_bound['synchronous_5xx_records'][0][
            'response_body_sha256'] and
        post_history_events['t09_exact_replay']['payload'][
            'request_expiry_ms'] == post_bound['request_expiry_ms'] and
        post_history_events['t09_exact_replay']['payload'][
            'observed_at_ms'] == post_bound['synchronous_5xx_records'][0][
                'received_at_ms'] + 1 and
        post_history_events['t09_exact_replay']['payload'][
            'replay_reason'] == post_bound['replay_reason'] and
        post_history_events['t10_response_record']['payload'][
            'provider_response_record_digest'] ==
        post_history_events['t11_atomic_binding']['payload'][
            'provider_response_record_digest'] ==
        post_bound['provider_response_record']['record_digest'] and
        events_by_transition['t10_response_record']['payload'][
            'provider_response_record_digest'] ==
        replay_response['provider_response_record']['record_digest'] and
        events_by_transition['t11_atomic_binding']['payload'][
            'provider_response_record_digest'] ==
        post_bound['provider_response_record']['record_digest'] and
        events_by_transition['t12_verified_event_binding']['payload'][
            'verified_event_binding_record_digest'] ==
        event_bound['action_binding_evidence'][
            'verified_event_binding_record']['record_digest'] and
        events_by_transition['t15_operator_close']['payload'][
            'operator_close_evidence_digest'] ==
        closed['operator_close_evidence']['provider_evidence_digest'] and
        events_by_transition['t15_operator_close']['payload']['reason_code'] ==
        closed['operator_close_evidence']['reason_code'] and
        events_by_transition['t15_operator_close']['payload']['actor_id'] ==
        closed['operator_close_evidence']['actor_id'] and
        events_by_transition['t15_operator_close']['payload']['closed_at_ms'] ==
        closed['operator_close_evidence']['closed_at_ms'],
        'action binding/operator close audit payload relation mismatch')
    require_contract(type_strict_equal(
        integration['result_access'], OFFICIAL_INTEGRATION_V4['result_access']),
        'current-result server-session access mismatch')
    reads = integration['provider_reads']
    require_contract(type_strict_equal(
        reads, OFFICIAL_INTEGRATION_V4['provider_reads']),
        'REST/webhook polling lifecycle mismatch')
    inbox = reads['merge_rules']['pre_response_inbox']
    exact_integer(inbox['capacity'], 'inbox.capacity', 1, 4096)
    exact_integer(inbox['ttl_ms'], 'inbox.ttl_ms', 1000, 86400000)
    require_contract(type_strict_equal(
        integration['staging_r0_command_evidence_map'], R0_MAP),
        'R0 command/evidence map mismatch')


def validate_wallet_payload(document, where='wallet payload'):
    exact_object(document, ('version', 'url', 'method', 'headers', 'body'), where)
    require_contract(exact_integer(document['version'], f'{where}.version', 1, 1) == 1,
                     f'{where}.version must be 1')
    url = bounded_string(document['url'], f'{where}.url', 40, 240)
    require_contract(bool(re.fullmatch(
        r'https://api\.privy\.io/v1/wallets/[A-Za-z0-9_-]{8,96}/transfer', url)),
        f'{where}.url must be the full fixed Privy transfer URL with a public dummy ID')
    require_contract(document['method'] == 'POST', f'{where}.method must be POST')
    headers = exact_object(document['headers'], SIGNED_HEADERS, f'{where}.headers')
    bounded_string(headers['privy-app-id'], f'{where}.headers.privy-app-id', 6, 128)
    bounded_string(headers['privy-idempotency-key'],
                   f'{where}.headers.privy-idempotency-key', 16, 255)
    expiry = bounded_string(headers['privy-request-expiry'],
                            f'{where}.headers.privy-request-expiry', 10, 16)
    require_contract(expiry.isascii() and expiry.isdecimal(),
                     f'{where}.headers.privy-request-expiry must be decimal milliseconds')
    body = exact_object(document['body'],
                        ('amount_type', 'source', 'destination', 'nonce'), f'{where}.body')
    require_contract(body['amount_type'] == 'exact_input',
                     f'{where}.body.amount_type must be exact_input')
    source = exact_object(body['source'], ('asset', 'amount', 'chain'),
                          f'{where}.body.source')
    for key in ('asset', 'chain'):
        bounded_string(source[key], f'{where}.body.source.{key}', 1, 64)
    amount = bounded_string(source['amount'], f'{where}.body.source.amount', 1, 101)
    require_contract(bool(re.fullmatch(r'(?:0|[1-9][0-9]*)(?:\.[0-9]+)?', amount)),
                     f'{where}.body.source.amount must be canonical decimal')
    destination = exact_object(body['destination'], ('address',),
                               f'{where}.body.destination')
    bounded_string(destination['address'], f'{where}.body.destination.address', 8, 128)
    bounded_string(body['nonce'], f'{where}.body.nonce', 24, 255)


def bounded_opaque_id(value, where):
    value = bounded_string(value, where, 1, 128)
    require_contract(bool(re.fullmatch(r'[A-Za-z0-9_-]+', value)),
                     f'{where} must be a bounded opaque ID')
    return value


def canonical_decimal(value, where):
    value = bounded_string(value, where, 1, 101)
    require_contract(bool(re.fullmatch(r'(?:0|[1-9][0-9]*)(?:\.[0-9]+)?', value)),
                     f'{where} must be a canonical decimal string')
    return value


def validate_wallet_action_failure(value, where):
    if value is None:
        return
    exact_object(value, ('code', 'safe_message'), where)
    code = bounded_string(value['code'], f'{where}.code', 1, 64)
    require_contract(bool(re.fullmatch(r'[A-Z][A-Z0-9_]*', code)),
                     f'{where}.code must be a bounded LOOP code')
    message = bounded_string(value['safe_message'], f'{where}.safe_message', 1, 240)
    require_contract(not any(ord(character) < 32 and character not in '\t'
                             for character in message),
                     f'{where}.safe_message contains control text')


def validate_wallet_action_step(value, where):
    exact_object(value, ('kind', 'status', 'chain_id', 'transaction_hash'), where)
    exact_enum(value['kind'], WALLET_ACTION_STEP_KINDS, f'{where}.kind')
    exact_enum(value['status'], WALLET_ACTION_STEP_STATUSES, f'{where}.status')
    bounded_string(value['chain_id'], f'{where}.chain_id', 1, 64)
    transaction_hash = value['transaction_hash']
    if transaction_hash is not None:
        transaction_hash = bounded_string(transaction_hash,
                                          f'{where}.transaction_hash', 8, 128)
        require_contract(bool(re.fullmatch(r'(?:0x)?[A-Za-z0-9]+', transaction_hash)),
                         f'{where}.transaction_hash must be canonical bounded text')
    if value['kind'] == 'provider_step' and value['status'] == 'unknown':
        require_contract(transaction_hash is None,
                         f'{where} unknown provider step cannot carry a hash/link fact')


def validate_wallet_action_snapshot(value, where='wallet action snapshot'):
    exact_object(value, ('action_id', 'review_id', 'wallet_id', 'type', 'status',
                         'source_chain', 'source_asset', 'source_amount',
                         'destination_address', 'destination_amount', 'created_at_ms',
                         'failure', 'steps'), where)
    for key in ('action_id', 'review_id', 'wallet_id'):
        bounded_opaque_id(value[key], f'{where}.{key}')
    require_contract(value['type'] == 'transfer', f'{where}.type must be transfer')
    exact_enum(value['status'], ('pending', 'succeeded', 'rejected', 'failed'),
               f'{where}.status')
    bounded_string(value['source_chain'], f'{where}.source_chain', 1, 64)
    bounded_string(value['source_asset'], f'{where}.source_asset', 1, 64)
    canonical_decimal(value['source_amount'], f'{where}.source_amount')
    bounded_string(value['destination_address'], f'{where}.destination_address', 8, 128)
    if value['destination_amount'] is not None:
        canonical_decimal(value['destination_amount'], f'{where}.destination_amount')
    exact_integer(value['created_at_ms'], f'{where}.created_at_ms')
    validate_wallet_action_failure(value['failure'], f'{where}.failure')
    steps = value['steps']
    require_contract(type(steps) is list and len(steps) <= 64,
                     f'{where}.steps must be an array of at most 64 items')
    for index, step in enumerate(steps):
        validate_wallet_action_step(step, f'{where}.steps[{index}]')


def validate_transfer_result_snapshot(value, where='transfer result'):
    require_contract(type(value) is dict, f'{where} must be an object')
    kind = value.get('kind')
    if kind == 'wallet_action':
        exact_object(value, ('kind', 'wallet_action'), where)
        validate_wallet_action_snapshot(value['wallet_action'], f'{where}.wallet_action')
        return
    if kind == 'submission_unknown':
        exact_object(value, ('kind', 'submission_record_id', 'wallet_id', 'created_at_ms',
                             'signed_request_expires_at_ms', 'safe_message_code',
                             'action_id', 'steps'), where)
        bounded_opaque_id(value['submission_record_id'], f'{where}.submission_record_id')
        bounded_opaque_id(value['wallet_id'], f'{where}.wallet_id')
        created = exact_integer(value['created_at_ms'], f'{where}.created_at_ms')
        expiry = exact_integer(value['signed_request_expires_at_ms'],
                               f'{where}.signed_request_expires_at_ms')
        require_contract(created <= expiry, f'{where} expiry precedes creation')
        require_contract(value['safe_message_code'] == 'TRANSFER_RECONCILING',
                         f'{where}.safe_message_code must be TRANSFER_RECONCILING')
        require_contract(value['action_id'] is None and value['steps'] == [],
                         f'{where} unknown submission cannot expose action or steps')
        return
    raise ContractViolation(f'{where}.kind must discriminate wallet_action/submission_unknown')


def validate_operation_variant_payload(operation, direction, variant,
                                       payload, where):
    variants = operation[f'{direction}_variants']
    schema = next((item for item in variants
                   if item['variant'] == variant), None)
    require_contract(schema is not None, f'{where} unknown variant')
    exact_object(payload, schema['exact_keys'], where)
    if len(variants) > 1:
        discriminator = 'command' if direction == 'request' else 'kind'
        require_contract(payload[discriminator] == variant,
                         f'{where} discriminator mismatch')
    if 'preflight_handle' in payload:
        bounded_opaque_id(payload['preflight_handle'],
                          f'{where}.preflight_handle')
    if 'prepared_review_handle' in payload:
        bounded_opaque_id(payload['prepared_review_handle'],
                          f'{where}.prepared_review_handle')
    if 'amount_decimal' in payload:
        canonical_decimal(payload['amount_decimal'], f'{where}.amount_decimal')
    if 'acknowledgement_kind' in payload:
        exact_enum(payload['acknowledgement_kind'],
                   ('first_recipient', 'history_unknown'),
                   f'{where}.acknowledgement_kind')
    if 'authorization_signature' in payload:
        canonical_base64_bytes(payload['authorization_signature'],
                               f'{where}.authorization_signature', 8, 131072)
    if 'official_formatter_envelope_bytes_base64' in payload:
        formatted = canonical_base64_bytes(
            payload['official_formatter_envelope_bytes_base64'],
            f'{where}.official_formatter_envelope_bytes_base64')
        envelope = strict_canonical_json_bytes(
            formatted, f'{where}.official_formatter_envelope')
        validate_wallet_payload(envelope,
                                f'{where}.official_formatter_envelope')
        exact_hex64(payload['official_formatter_envelope_sha256'],
                    f'{where}.official_formatter_envelope_sha256')
        require_contract(
            hashlib.sha256(formatted).hexdigest() ==
            payload['official_formatter_envelope_sha256'] and
            type_strict_equal(envelope, WALLET_PAYLOAD_EXAMPLE),
            f'{where} full formatter-envelope schema example mismatch')
    elif 'official_formatter_envelope_sha256' in payload:
        exact_hex64(payload['official_formatter_envelope_sha256'],
                    f'{where}.official_formatter_envelope_sha256')
    if operation['name'] == 'review_prepare' and direction == 'response':
        require_contract(list(payload) == ['prepared_review_handle'],
                         'page review_prepare response must remain opaque')
    if operation['name'] == 'result_projection' and direction == 'response':
        if variant == 'transfer_result_snapshot':
            validate_transfer_result_snapshot(payload['result'],
                                              f'{where}.result')
        else:
            require_contract(payload == {'kind': 'unavailable'},
                             f'{where} unavailable exact DTO')

def validate_operation_contract(actual, expected, where):
    exact_object(actual, (
        'name', 'http_method', 'path', 'facade_access',
        'request_variants', 'response_variants', 'forbidden_client_keys',
        'session_binding'), where)
    for key in ('name', 'http_method', 'path', 'facade_access',
                'request_variants', 'response_variants', 'session_binding'):
        require_contract(type_strict_equal(actual[key], expected[key]),
                         f'{where}.{key} mismatch')
    exact_string_list(actual['forbidden_client_keys'], CALLER_FORBIDDEN,
                      f'{where}.forbidden_client_keys')
    examples = OPERATION_VARIANT_EXAMPLES[expected['name']]
    for direction in ('request', 'response'):
        variants = actual[f'{direction}_variants']
        require_contract(type(variants) is list and variants,
                         f'{where}.{direction}_variants nonempty')
        names = []
        for schema in variants:
            exact_object(schema, ('variant', 'exact_keys'),
                         f'{where}.{direction}_variant')
            bounded_opaque_id(schema['variant'],
                              f'{where}.{direction}.variant')
            require_contract(type(schema['exact_keys']) is list and
                             all(type(key) is str for key in schema['exact_keys']),
                             f'{where}.{direction}.exact_keys strings')
            names.append(schema['variant'])
            validate_operation_variant_payload(
                actual, direction, schema['variant'],
                examples[f'{direction}s'][schema['variant']],
                f'{where}.{direction}.{schema["variant"]}')
        require_contract(len(names) == len(set(names)),
                         f'{where}.{direction} variant names unique')
    if expected['name'] == 'recipient_preflight':
        require_contract(
            [item['variant'] for item in actual['request_variants']] ==
            ['resolve', 'acknowledge'],
            'recipient preflight must cross-validate resolve+acknowledge variants')
    if expected['name'] == 'authorization_submission':
        require_contract(
            [item['variant'] for item in actual['request_variants']] ==
            ['issue_payload', 'submit_signature'] and
            actual['facade_access'] ==
            'private_f11_flutter_signer_handoff_only',
            'authorization must cross-validate private issue+submit commands')

def validate_bff_contract(document):
    exact_object(document, (
        'schema_version', 'authorities', 'mode', 'operations',
        'recipient_acknowledgements', 'wallet_api_payload_v1',
        'post_signature_pre_post', 'result_projection',
        'submission_state_machine', 'official_integration_v4',
        'staging_r0'), 'bff')
    exact_integer(document['schema_version'], 'bff.schema_version', 1, 1)
    authorities = exact_object(
        document['authorities'],
        ('wallet_delivery', 'communication', 'perp', 'auxiliary'),
        'bff.authorities')
    require_contract(authorities['wallet_delivery'] == 'Privy' and
                     authorities['communication'] == 'Stream' and
                     authorities['perp'] == 'Hyperliquid',
                     'Privy/Stream/Hyperliquid authority boundaries required')
    auxiliary = exact_object(
        authorities['auxiliary'],
        ('address_resolution', 'sanctions_screening'),
        'bff.authorities.auxiliary')
    for key in auxiliary:
        require_contract(type_strict_equal(auxiliary[key], {
            'authority_relationship': 'subordinate_to_privy_delivery',
            'credential_state': 'not_configured',
            'enablement':
                'disabled_fail_closed_until_credentialed_capability_audit'}),
            f'bff auxiliary {key} must remain disabled/subordinate')
    require_contract(type_strict_equal(document['mode'], {
        'production_adapter_enabled': False,
        'missing_credentials': 'fail_closed',
        'prototype_provider': 'Simulated Privy — no network, no signing'}),
        'production must fail closed without credentials')
    operations = document['operations']
    require_contract(type(operations) is list and
                     len(operations) == len(OPERATION_CONTRACTS) == 6,
                     'exactly six BFF operations required')
    for index, (actual, expected) in enumerate(
            zip(operations, OPERATION_CONTRACTS)):
        validate_operation_contract(actual, expected,
                                    f'bff.operations[{index}]')
    acknowledgement = exact_object(
        document['recipient_acknowledgements'],
        ('owner', 'binding', 'fields', 'client_cannot_assert',
         'reset_on_material_change'), 'bff.recipient_acknowledgements')
    require_contract(type_strict_equal(acknowledgement, {
        'owner': 'bff_preflight_server_session',
        'binding':
            'digest_bound_to_owner_wallet_epoch_asset_recipient_and_preflight',
        'fields': [
            'first_recipient_acknowledged',
            'history_unknown_acknowledged'],
        'client_cannot_assert': True,
        'reset_on_material_change': True}),
        'acknowledgements must be server-derived digest-bound state')
    envelope = exact_object(
        document['wallet_api_payload_v1'],
        ('version', 'url_template', 'http_method', 'semantic_method',
         'signed_header_keys', 'forbidden_signed_header_keys',
         'body_exact_keys', 'source_exact_keys',
         'destination_exact_keys', 'amount_type',
         'same_chain_named_asset_only', 'forbidden_body_keys'),
        'bff.wallet_api_payload_v1')
    exact_integer(envelope['version'], 'wallet_api_payload_v1.version', 1, 1)
    require_contract(
        envelope['url_template'] ==
        'https://api.privy.io/v1/wallets/{wallet_id}/transfer' and
        envelope['http_method'] == 'POST' and
        envelope['semantic_method'] == 'transfer',
        'exact Privy Wallet API transfer envelope required')
    exact_string_list(envelope['signed_header_keys'], SIGNED_HEADERS,
                      'wallet_api_payload_v1.signed_headers')
    exact_string_list(envelope['forbidden_signed_header_keys'],
                      FORBIDDEN_SIGNED_HEADERS,
                      'wallet_api_payload_v1.forbidden_headers')
    exact_string_list(
        envelope['body_exact_keys'],
        ('amount_type', 'source', 'destination', 'nonce'),
        'wallet_api_payload_v1.body_keys')
    exact_string_list(envelope['source_exact_keys'],
                      ('asset', 'amount', 'chain'),
                      'wallet_api_payload_v1.source_keys')
    exact_string_list(envelope['destination_exact_keys'], ('address',),
                      'wallet_api_payload_v1.destination_keys')
    require_contract(envelope['amount_type'] == 'exact_input' and
                     envelope['same_chain_named_asset_only'] is True,
                     'same-chain exact-input profile required')
    exact_string_list(
        envelope['forbidden_body_keys'],
        ('destination_chain', 'destination_asset', 'slippage_bps',
         'fee_configuration', 'custom_token', 'token_address'),
        'wallet_api_payload_v1.forbidden_body_keys')
    prepost = exact_object(
        document['post_signature_pre_post'],
        ('ordered_steps', 'mismatch_result',
         'write_ahead_before_transport'), 'bff.post_signature_pre_post')
    exact_string_list(prepost['ordered_steps'], POST_SIGNATURE_SEQUENCE,
                      'post_signature_pre_post.ordered_steps')
    require_contract(
        prepost['mismatch_result'] ==
        'consume_review_return_f5_require_wholly_new_prepare' and
        prepost['write_ahead_before_transport'] is True,
        'post-signature TOCTOU/write-ahead sequence mismatch')
    validate_result_projection(document['result_projection'])
    validate_submission_state_machine(document['submission_state_machine'])
    validate_official_integration(document['official_integration_v4'])
    validate_staging(document['staging_r0'], 'bff.staging_r0')
    require_contract(
        [item['command'] for item in
         document['official_integration_v4'][
             'staging_r0_command_evidence_map']] ==
        document['staging_r0']['commands'] and
        [item['evidence'] for item in
         document['official_integration_v4'][
             'staging_r0_command_evidence_map']] ==
        document['staging_r0']['required_evidence'],
        'R0 map must exactly pair full command strings and evidence')

def validate_result_projection(result):
    exact_object(result, (
        'dto_schema', 'union_kinds', 'wallet_action_statuses',
        'step_kinds', 'step_statuses', 'unknown_step_projection',
        'provider_unknown_keys', 'polling', 'webhook'),
        'bff.result_projection')
    require_contract(type_strict_equal(result['dto_schema'], RESULT_DTO_SCHEMA),
                     'result DTO exact discriminated schema required')
    exact_string_list(result['union_kinds'],
                      ('wallet_action', 'submission_unknown'),
                      'result.union_kinds')
    exact_string_list(result['wallet_action_statuses'],
                      ('pending', 'succeeded', 'rejected', 'failed'),
                      'result.wallet_action_statuses')
    exact_string_list(result['step_kinds'], WALLET_ACTION_STEP_KINDS,
                      'result.step_kinds')
    exact_string_list(result['step_statuses'], WALLET_ACTION_STEP_STATUSES,
                      'result.step_statuses')
    require_contract(type_strict_equal(result['unknown_step_projection'], {
        'kind': 'provider_step', 'status': 'unknown',
        'explorer_link': None, 'may_override_top_level_status': False}),
        'safe provider unknown step projection required')
    require_contract(result['provider_unknown_keys'] ==
                     'ignore_without_authority',
                     'provider unknown keys lack authority')
    require_contract(type_strict_equal(result['polling'], {
        'transport': 'rest_authoritative',
        'pending_authenticated_reload_resume': True,
        'first_terminal_permanent_stop': True,
        'caller_supplied_action_or_submission_id': False}),
        'polling pending resume/terminal stop contract mismatch')
    require_contract(type_strict_equal(result['webhook'], {
        'enabled': False,
        'enablement':
            'enterprise_credentialed_capability_audit_required',
        'verified_binding_required': True}),
        'webhook capability gate mismatch')

def validate_submission_state_machine(machine):
    exact_object(machine, (
        'schema_version', 'submission_attempt_exact_keys', 'states',
        'unknown_reason_enum', 'graph_authority_ref',
        'persistent_proof_fields', 'invariants'),
        'bff.submission_state_machine')
    exact_integer(machine['schema_version'], 'state_machine.schema_version', 1, 1)
    exact_string_list(machine['submission_attempt_exact_keys'], ATTEMPT_KEYS,
                      'state_machine.attempt_keys')
    exact_string_list(machine['states'], ATTEMPT_STATES,
                      'state_machine.states')
    exact_string_list(machine['unknown_reason_enum'], UNKNOWN_REASONS,
                      'state_machine.unknown_reasons')
    require_contract(machine['graph_authority_ref'] ==
                     'official_integration_v4.graph_authority',
                     'one graph authority reference required')
    exact_string_list(machine['persistent_proof_fields'], (
        'record_version', 'fencing_token', 'exact_replay_count',
        'transport_ordinal', 'replay_origin', 'replay_reason',
        'replay_material', 'recovery_lease', 'synchronous_5xx_records',
        'provider_response_record', 'action_binding_evidence',
        'zero_byte_proof',
        'operator_close_evidence', 'result_binding_tombstone'),
        'state_machine.persistent_proof_fields')
    exact_string_list(machine['invariants'], (
        'attempt_and_owner_wallet_lock_commit_before_any_transport_byte',
        'only_audited_zero_byte_proof_may_release_as_proved_not_submitted',
        'response_is_durable_before_atomic_action_binding',
        'unknown_retains_encrypted_replay_material_for_single_replay_or_reconcile',
        'exact_replay_preserves_envelope_digest_idempotency_expiry_and_prior_5xx',
        'second_uncertain_after_exact_replay_forbids_further_replay',
        'action_bound_references_exactly_one_durable_response_or_verified_event_record',
        'terminal_states_erase_replay_material',
        'empty_4xx_allowlist_forbids_provider_rejected_active_instance',
        'operator_close_atomically_tombstones_binding_and_unlocks',
        'restart_never_creates_new_key_review_body_or_request'),
        'state_machine.invariants')

def validate_staging(staging, where):
    exact_object(staging, (
        'status', 'credentials_configured', 'commands',
        'required_evidence', 'production_integration_complete'), where)
    require_contract(staging['status'] ==
                     'NOT RUN — CREDENTIALS REQUIRED',
                     f'{where}.status must remain NOT RUN')
    require_contract(staging['credentials_configured'] is False and
                     staging['production_integration_complete'] is False,
                     f'{where} cannot claim configured/complete')
    exact_string_list(staging['commands'], R0_COMMANDS, f'{where}.commands')
    exact_string_list(staging['required_evidence'], R0_EVIDENCE,
                      f'{where}.required_evidence')


FLUTTER_ARCHIVE_SHA256 = (
    '3f3b3215b0ea41ad059ed5a11a9edadcfffa72b6efed45e9694c089281ef643e')
FLUTTER_ARCHIVE_URL = (
    'https://pub.dev/api/archives/privy_flutter-0.10.1.tar.gz')
FLUTTER_REPOSITORY = 'https://github.com/privy-io/flutter-sdk'
FLUTTER_PACKAGE_PROVENANCE = {
    'name': 'privy_flutter',
    'version': '0.10.1',
    'publisher': 'privy.io',
    'archive_url': FLUTTER_ARCHIVE_URL,
    'archive_sha256': FLUTTER_ARCHIVE_SHA256,
    'license': 'MIT',
    'repository': FLUTTER_REPOSITORY,
}


PACKAGE_SPECS = (
    ('viem', '2.55.10', 'npm',
     'sha512-Q9Ba+/ma81U2M5o5P2AQ7Ux8rTIwmCZvUcr8rKdQ22bV0IBFHllM2m5gWDP8hFaUN2nH2oW3QG44amRazflYNQ==',
     'MIT', 'https://registry.npmjs.org/viem/-/viem-2.55.10.tgz',
     'https://github.com/wevm/viem.git', 'evm_address_and_ens_adapter',
     'production_bff'),
    ('@solana/addresses', '6.10.0', 'npm',
     'sha512-vEoCGBTxG0HCERAn84KXkrJjl+pDaNzOpZ0qbgcPS98fYxP5yzbKB8SNOY2bzrbkRUmmw5Q3hqTRERemUN2Gcw==',
     'MIT', 'https://registry.npmjs.org/@solana/addresses/-/addresses-6.10.0.tgz',
     'https://github.com/anza-xyz/kit.git', 'solana_address_adapter',
     'production_bff'),
    ('@privy-io/node', '0.29.0', 'npm',
     'sha512-Tcpy8ZDi14SzAmqFXRSgKTgMsk8truxAXodHuRR08XjLSfZLAx2Kfh8EBSoKTPxK9KakMjRhO6+nw66RtiiYdg==',
     'Apache-2.0', 'https://registry.npmjs.org/@privy-io/node/-/node-0.29.0.tgz',
     'https://github.com/privy-io/node-sdk.git', 'official_server_formatter',
     'production_bff'),
    ('privy_flutter', '0.10.1', 'pub', FLUTTER_ARCHIVE_SHA256, 'MIT',
     FLUTTER_ARCHIVE_URL, FLUTTER_REPOSITORY,
     'official_flutter_authorization_signature', 'flutter_client'),
)


def validate_dependency_lock(document):
    exact_object(document, ('schema_version', 'declared_runtime_targets', 'installed',
                             'enablement', 'packages'), 'dependency-lock')
    exact_integer(document['schema_version'], 'dependency-lock.schema_version', 1, 1)
    exact_string_list(document['declared_runtime_targets'],
                      ('production_bff', 'flutter_client'),
                      'dependency-lock.declared_runtime_targets')
    require_contract(document['installed'] is False and
                     document['enablement'] == 'credential_and_capability_audit_required',
                     'dependency lock must remain uninstalled and capability-gated')
    packages = document['packages']
    require_contract(type(packages) is list and len(packages) == len(PACKAGE_SPECS),
                     'dependency-lock.packages exact count')
    for actual, expected in zip(packages, PACKAGE_SPECS):
        exact_object(actual, ('name', 'version', 'registry', 'integrity', 'license',
                              'source', 'repository', 'role', 'runtime_target',
                              'installed', 'enablement'),
                     f'dependency-lock.packages.{expected[0]}')
        (name, version, registry, integrity, license_name, source, repository,
         role, runtime_target) = expected
        require_contract(type_strict_equal(actual, {
            'name': name, 'version': version, 'registry': registry,
            'integrity': integrity, 'license': license_name, 'source': source,
            'repository': repository, 'role': role, 'runtime_target': runtime_target,
            'installed': False,
            'enablement': 'credential_and_capability_audit_required',
        }), f'exact dependency metadata required for {name}')


def validate_flutter_fixture(document):
    exact_object(document, (
        'schema_version', 'status', 'signature_path', 'method',
        'payload_encoding', 'formatter', 'package',
        'authorization_payload_base64', 'authorization_payload_sha256',
        'authorization_signature', 'public_verification_material',
        'generation', 'credentialed_staging_required',
        'production_integration_complete'), 'flutter fixture')
    exact_integer(document['schema_version'], 'flutter fixture.schema_version', 1, 1)
    require_contract(
        document['signature_path'] == 'server_formatted_bytes' and
        document['method'] ==
        'PrivyUser.generateAuthorizationSignatureFromBytes' and
        document['payload_encoding'] == 'base64_to_Uint8List',
        'Flutter signature path/method/encoding exact contract required')
    require_contract(type_strict_equal(document['formatter'], {
        'package': '@privy-io/node', 'version': '0.29.0',
        'method': 'formatRequestForAuthorizationSignature',
    }), 'Flutter formatter package/version/method required')
    package = exact_object(document['package'],
                           ('name', 'version', 'publisher', 'archive_url',
                            'archive_sha256', 'license', 'repository'),
                           'flutter fixture.package')
    require_contract(type_strict_equal(package, FLUTTER_PACKAGE_PROVENANCE),
                     'Flutter exact pub.dev archive provenance required')
    generation = exact_object(
        document['generation'],
        ('command', 'tool_versions', 'generated_at', 'status'),
        'flutter fixture.generation')
    require_contract(type_strict_equal(generation, {
        'command':
            'task4 generate-official-privy-signature --credentials-required',
        'tool_versions': {'node': None, 'dart': None, 'flutter': None},
        'generated_at': None,
        'status': 'NOT RUN — CREDENTIALS REQUIRED',
    }), 'Flutter generation command/tool versions must remain NOT RUN/null')
    require_contract(document['status'] == 'NOT RUN — CREDENTIALS REQUIRED' and
                     document['authorization_payload_base64'] is None and
                     document['authorization_payload_sha256'] == 'PENDING' and
                     document['authorization_signature'] is None and
                     document['public_verification_material'] is None and
                     document['credentialed_staging_required'] is True and
                     document['production_integration_complete'] is False,
                     'Flutter evidence must be null/NOT RUN and never fabricated')


def validate_provenance(document, wallet_fixture_path):
    exact_object(document, (
        'schema_version', 'status', 'signature_path', 'method',
        'payload_encoding', 'authorization_payload_base64',
        'authorization_payload_sha256', 'formatter', 'flutter',
        'fixture_hashes', 'generation'), 'provenance')
    exact_integer(document['schema_version'], 'provenance.schema_version', 1, 1)
    require_contract(document['status'] == 'PENDING — TASK 4 OFFICIAL FORMATTER AUDIT',
                     'provenance must remain pending until Task 4')
    require_contract(
        document['signature_path'] == 'server_formatted_bytes' and
        document['method'] ==
        'PrivyUser.generateAuthorizationSignatureFromBytes' and
        document['payload_encoding'] == 'base64_to_Uint8List',
        'provenance signature path/method/encoding mismatch')
    require_contract(document['authorization_payload_base64'] is None and
                     document['authorization_payload_sha256'] == 'PENDING',
                     'authorization payload evidence remains null/PENDING until Task 4')
    formatter = exact_object(document['formatter'],
                             ('package', 'version', 'method', 'source', 'integrity',
                              'canonical_payload_sha256'), 'provenance.formatter')
    require_contract(type_strict_equal(formatter, {
        'package': '@privy-io/node', 'version': '0.29.0',
        'method': 'formatRequestForAuthorizationSignature',
        'source': 'https://github.com/privy-io/node-sdk.git',
        'integrity': PACKAGE_SPECS[2][3], 'canonical_payload_sha256': None,
    }), 'formatter canonical hash must remain pending/null until Task 4')
    flutter = exact_object(document['flutter'],
                           ('package', 'version', 'publisher', 'archive_url',
                            'archive_sha256', 'license', 'repository', 'method',
                            'payload_encoding', 'signature_status'),
                           'provenance.flutter')
    require_contract(type_strict_equal(flutter, {
        'package': FLUTTER_PACKAGE_PROVENANCE['name'],
        'version': FLUTTER_PACKAGE_PROVENANCE['version'],
        'publisher': FLUTTER_PACKAGE_PROVENANCE['publisher'],
        'archive_url': FLUTTER_PACKAGE_PROVENANCE['archive_url'],
        'archive_sha256': FLUTTER_PACKAGE_PROVENANCE['archive_sha256'],
        'license': FLUTTER_PACKAGE_PROVENANCE['license'],
        'repository': FLUTTER_PACKAGE_PROVENANCE['repository'],
        'method': 'PrivyUser.generateAuthorizationSignatureFromBytes',
        'payload_encoding': 'base64_to_Uint8List',
        'signature_status': 'NOT RUN — CREDENTIALS REQUIRED',
    }), 'Flutter exact pub.dev provenance and pending signature status required')
    fixture_hashes = exact_object(document['fixture_hashes'],
                                  ('wallet_api_payload_json_sha256',
                                   'canonical_payload_sha256',
                                   'flutter_signature_sha256'),
                                  'provenance.fixture_hashes')
    require_contract(fixture_hashes['wallet_api_payload_json_sha256'] ==
                     digest(wallet_fixture_path),
                     'wallet fixture JSON hash must match bytes')
    require_contract(fixture_hashes['canonical_payload_sha256'] is None and
                     fixture_hashes['flutter_signature_sha256'] is None,
                     'Task 4 golden/signature hashes must remain null')
    require_contract(type_strict_equal(document['generation'], {
        'command':
            'task4 generate-official-privy-signature --credentials-required',
        'tool_versions': {'node': None, 'dart': None, 'flutter': None},
        'generated_at': None,
        'status': 'PENDING — TASK 4 OFFICIAL FORMATTER AUDIT',
    }), 'generation evidence cannot be fabricated before Task 4')


def inspect_contract_tree(root):
    root = pathlib.Path(root)
    require_contract(root.exists(), f'missing exact seven-file contract tree: {root}')
    root_mode = root.lstat().st_mode
    require_contract(stat.S_ISDIR(root_mode) and not stat.S_ISLNK(root_mode),
                     'contract root must be a real directory')
    actual_files = []
    actual_dirs = ['.']
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        base = pathlib.Path(directory)
        dirnames[:] = [name for name in dirnames if not name.startswith('._')]
        filenames = [name for name in filenames if not name.startswith('._')]
        for name in dirnames:
            child = base / name
            mode = child.lstat().st_mode
            require_contract(stat.S_ISDIR(mode) and not stat.S_ISLNK(mode),
                             f'contract directory must not be a symlink: {child}')
            actual_dirs.append(child.relative_to(root).as_posix())
        for name in filenames:
            child = base / name
            mode = child.lstat().st_mode
            require_contract(stat.S_ISREG(mode) and not stat.S_ISLNK(mode),
                             f'contract file must be regular and not symlink: {child}')
            actual_files.append(child.relative_to(root).as_posix())
    require_contract(sorted(actual_dirs) == ['.', 'fixtures'],
                     f'exact contract directories required, got {sorted(actual_dirs)}')
    require_contract(sorted(actual_files) == sorted(CONTRACT_FILES),
                     f'exact seven-file contract tree required, got {sorted(actual_files)}')


def dependency_import_findings(root):
    patterns = (
        r"(?:from|require\s*\(|import\s*\()[^\n]{0,120}['\"]viem(?:/|['\"])",
        r"(?:from|require\s*\(|import\s*\()[^\n]{0,120}['\"]@solana/addresses(?:/|['\"])",
        r"(?:from|require\s*\(|import\s*\()[^\n]{0,120}['\"]@privy-io/node(?:/|['\"])",
        r"(?:from|require\s*\(|import\s*\()[^\n]{0,120}['\"]privy_flutter(?:/|['\"])",
    )
    findings = []
    for path in sorted((pathlib.Path(root) / 'src').rglob('*')):
        if (path.is_file() and not path.name.startswith('._') and
                path.suffix in ('.js', '.html')):
            try:
                source = path.read_text(encoding='utf-8', errors='strict')
            except (OSError, UnicodeError) as error:
                findings.append(f'unreadable:{path.relative_to(root).as_posix()}:'
                                f'{type(error).__name__}')
                continue
            if any(re.search(pattern, source) for pattern in patterns):
                findings.append(path.relative_to(root).as_posix())
    for name in ('package.json', 'package-lock.json', 'pubspec.yaml', 'pubspec.lock'):
        if (pathlib.Path(root) / name).exists():
            findings.append(name)
    if (pathlib.Path(root) / 'node_modules').exists():
        findings.append('node_modules')
    return findings


def validate_readme(path):
    source = pathlib.Path(path).read_text(encoding='utf-8', errors='strict')
    lowered = source.lower()
    for needle in ('privy', 'stream', 'hyperliquid', 'fail closed',
                   'not run — credentials required', 'production_integration_complete',
                   'alchemy', 'chainalysis', 'pending_credentialed_audit',
                   'secret manager', 'staging r0'):
        require_contract(needle in lowered, f'README missing required boundary: {needle}')
    require_contract(not re.search(r'(?i)(app[_ -]?secret|private[_ -]?key|authorization[_ -]?signature)\s*[:=]\s*[^<\s][^\n]*', source),
                     'README must document categories, never secret values')


def _valid_documents():
    auxiliary = {key: {
        'authority_relationship': 'subordinate_to_privy_delivery',
        'credential_state': 'not_configured',
        'enablement':
            'disabled_fail_closed_until_credentialed_capability_audit',
    } for key in ('address_resolution', 'sanctions_screening')}
    operations = [{
        'name': item['name'], 'http_method': item['http_method'],
        'path': item['path'], 'facade_access': item['facade_access'],
        'request_variants': copy.deepcopy(item['request_variants']),
        'response_variants': copy.deepcopy(item['response_variants']),
        'forbidden_client_keys': list(CALLER_FORBIDDEN),
        'session_binding': item['session_binding'],
    } for item in OPERATION_CONTRACTS]
    staging = {
        'status': 'NOT RUN — CREDENTIALS REQUIRED',
        'credentials_configured': False,
        'commands': list(R0_COMMANDS),
        'required_evidence': list(R0_EVIDENCE),
        'production_integration_complete': False,
    }
    bff = {
        'schema_version': 1,
        'authorities': {
            'wallet_delivery': 'Privy', 'communication': 'Stream',
            'perp': 'Hyperliquid', 'auxiliary': auxiliary},
        'mode': {
            'production_adapter_enabled': False,
            'missing_credentials': 'fail_closed',
            'prototype_provider': 'Simulated Privy — no network, no signing'},
        'operations': operations,
        'recipient_acknowledgements': {
            'owner': 'bff_preflight_server_session',
            'binding':
                'digest_bound_to_owner_wallet_epoch_asset_recipient_and_preflight',
            'fields': [
                'first_recipient_acknowledged',
                'history_unknown_acknowledged'],
            'client_cannot_assert': True,
            'reset_on_material_change': True},
        'wallet_api_payload_v1': {
            'version': 1,
            'url_template':
                'https://api.privy.io/v1/wallets/{wallet_id}/transfer',
            'http_method': 'POST', 'semantic_method': 'transfer',
            'signed_header_keys': list(SIGNED_HEADERS),
            'forbidden_signed_header_keys': list(FORBIDDEN_SIGNED_HEADERS),
            'body_exact_keys': [
                'amount_type', 'source', 'destination', 'nonce'],
            'source_exact_keys': ['asset', 'amount', 'chain'],
            'destination_exact_keys': ['address'],
            'amount_type': 'exact_input',
            'same_chain_named_asset_only': True,
            'forbidden_body_keys': [
                'destination_chain', 'destination_asset', 'slippage_bps',
                'fee_configuration', 'custom_token', 'token_address']},
        'post_signature_pre_post': {
            'ordered_steps': list(POST_SIGNATURE_SEQUENCE),
            'mismatch_result':
                'consume_review_return_f5_require_wholly_new_prepare',
            'write_ahead_before_transport': True},
        'result_projection': {
            'dto_schema': copy.deepcopy(RESULT_DTO_SCHEMA),
            'union_kinds': ['wallet_action', 'submission_unknown'],
            'wallet_action_statuses': [
                'pending', 'succeeded', 'rejected', 'failed'],
            'step_kinds': list(WALLET_ACTION_STEP_KINDS),
            'step_statuses': list(WALLET_ACTION_STEP_STATUSES),
            'unknown_step_projection': {
                'kind': 'provider_step', 'status': 'unknown',
                'explorer_link': None,
                'may_override_top_level_status': False},
            'provider_unknown_keys': 'ignore_without_authority',
            'polling': {
                'transport': 'rest_authoritative',
                'pending_authenticated_reload_resume': True,
                'first_terminal_permanent_stop': True,
                'caller_supplied_action_or_submission_id': False},
            'webhook': {
                'enabled': False,
                'enablement':
                    'enterprise_credentialed_capability_audit_required',
                'verified_binding_required': True}},
        'submission_state_machine': {
            'schema_version': 1,
            'submission_attempt_exact_keys': list(ATTEMPT_KEYS),
            'states': list(ATTEMPT_STATES),
            'unknown_reason_enum': list(UNKNOWN_REASONS),
            'graph_authority_ref':
                'official_integration_v4.graph_authority',
            'persistent_proof_fields': [
                'record_version', 'fencing_token', 'exact_replay_count',
                'transport_ordinal', 'replay_origin', 'replay_reason',
                'replay_material', 'recovery_lease',
                'synchronous_5xx_records', 'provider_response_record',
                'action_binding_evidence',
                'zero_byte_proof', 'operator_close_evidence',
                'result_binding_tombstone'],
            'invariants': [
                'attempt_and_owner_wallet_lock_commit_before_any_transport_byte',
                'only_audited_zero_byte_proof_may_release_as_proved_not_submitted',
                'response_is_durable_before_atomic_action_binding',
                'unknown_retains_encrypted_replay_material_for_single_replay_or_reconcile',
                'exact_replay_preserves_envelope_digest_idempotency_expiry_and_prior_5xx',
                'second_uncertain_after_exact_replay_forbids_further_replay',
                'action_bound_references_exactly_one_durable_response_or_verified_event_record',
                'terminal_states_erase_replay_material',
                'empty_4xx_allowlist_forbids_provider_rejected_active_instance',
                'operator_close_atomically_tombstones_binding_and_unlocks',
                'restart_never_creates_new_key_review_body_or_request']},
        'official_integration_v4': copy.deepcopy(OFFICIAL_INTEGRATION_V4),
        'staging_r0': staging,
    }
    dependency = {
        'schema_version': 1,
        'declared_runtime_targets': ['production_bff', 'flutter_client'],
        'installed': False,
        'enablement': 'credential_and_capability_audit_required',
        'packages': [{
            'name': item[0], 'version': item[1], 'registry': item[2],
            'integrity': item[3], 'license': item[4], 'source': item[5],
            'repository': item[6], 'role': item[7],
            'runtime_target': item[8], 'installed': False,
            'enablement': 'credential_and_capability_audit_required',
        } for item in PACKAGE_SPECS]}
    payload = copy.deepcopy(WALLET_PAYLOAD_EXAMPLE)
    generation = {
        'command':
            'task4 generate-official-privy-signature --credentials-required',
        'tool_versions': {'node': None, 'dart': None, 'flutter': None},
        'generated_at': None,
        'status': 'NOT RUN — CREDENTIALS REQUIRED'}
    flutter = {
        'schema_version': 1,
        'status': 'NOT RUN — CREDENTIALS REQUIRED',
        'signature_path': 'server_formatted_bytes',
        'method': 'PrivyUser.generateAuthorizationSignatureFromBytes',
        'payload_encoding': 'base64_to_Uint8List',
        'formatter': {
            'package': '@privy-io/node', 'version': '0.29.0',
            'method': 'formatRequestForAuthorizationSignature'},
        'package': copy.deepcopy(FLUTTER_PACKAGE_PROVENANCE),
        'authorization_payload_base64': None,
        'authorization_payload_sha256': 'PENDING',
        'authorization_signature': None,
        'public_verification_material': None,
        'generation': copy.deepcopy(generation),
        'credentialed_staging_required': True,
        'production_integration_complete': False}
    provenance = {
        'schema_version': 1,
        'status': 'PENDING — TASK 4 OFFICIAL FORMATTER AUDIT',
        'signature_path': 'server_formatted_bytes',
        'method': 'PrivyUser.generateAuthorizationSignatureFromBytes',
        'payload_encoding': 'base64_to_Uint8List',
        'authorization_payload_base64': None,
        'authorization_payload_sha256': 'PENDING',
        'formatter': {
            'package': '@privy-io/node', 'version': '0.29.0',
            'method': 'formatRequestForAuthorizationSignature',
            'source': 'https://github.com/privy-io/node-sdk.git',
            'integrity': PACKAGE_SPECS[2][3],
            'canonical_payload_sha256': None},
        'flutter': {
            'package': FLUTTER_PACKAGE_PROVENANCE['name'],
            'version': FLUTTER_PACKAGE_PROVENANCE['version'],
            'publisher': FLUTTER_PACKAGE_PROVENANCE['publisher'],
            'archive_url': FLUTTER_PACKAGE_PROVENANCE['archive_url'],
            'archive_sha256': FLUTTER_PACKAGE_PROVENANCE['archive_sha256'],
            'license': FLUTTER_PACKAGE_PROVENANCE['license'],
            'repository': FLUTTER_PACKAGE_PROVENANCE['repository'],
            'method': 'PrivyUser.generateAuthorizationSignatureFromBytes',
            'payload_encoding': 'base64_to_Uint8List',
            'signature_status': 'NOT RUN — CREDENTIALS REQUIRED'},
        'fixture_hashes': {
            'wallet_api_payload_json_sha256': None,
            'canonical_payload_sha256': None,
            'flutter_signature_sha256': None},
        'generation': copy.deepcopy(generation)}
    provenance['generation']['status'] = (
        'PENDING — TASK 4 OFFICIAL FORMATTER AUDIT')
    return bff, dependency, payload, flutter, provenance

def rejection_proved(action):
    try:
        action()
    except (ContractViolation, UnicodeError, OSError):
        return True
    return False

def run_malicious_contract_matrix():
    bff, dependency, payload, flutter, provenance = _valid_documents()
    checks = []
    mutate = copy.deepcopy
    with tempfile.TemporaryDirectory(
            prefix='loop-contract-v4-matrix-') as directory:
        temp = pathlib.Path(directory)
        contract = temp / 'contract'
        contract.mkdir()
        scratch = contract / 'probe.json'

        def raw_rejected(raw):
            scratch.unlink(missing_ok=True)
            scratch.write_bytes(raw)
            return rejection_proved(
                lambda: strict_json_load(scratch, contract))

        checks.extend([
            raw_rejected(b'{"outer":{"nested":1,"nested":2}}'),
            raw_rejected(b'\xef\xbb\xbf{"schema_version":1}'),
            raw_rejected(b'\xff{"schema_version":1}'),
            raw_rejected(b'{"schema_version":1}\x00'),
            raw_rejected(b'{"schema_version":1.0}'),
            raw_rejected(b'{"schema_version":NaN}'),
            raw_rejected(b'{"schema_version":Infinity}'),
            raw_rejected(b'{"schema_version":-Infinity}'),
        ])
        scratch.unlink(missing_ok=True)
        scratch.mkdir()
        checks.append(rejection_proved(
            lambda: strict_json_load(scratch, contract)))
        scratch.rmdir()
        outside = temp / 'outside.json'
        outside.write_text('{"schema_version":1}', encoding='utf-8')
        checks.append(rejection_proved(
            lambda: strict_json_load(outside, contract)))
        link = contract / 'link.json'
        link.symlink_to(outside)
        checks.append(rejection_proved(
            lambda: strict_json_load(link, contract)))
        payload_path = contract / 'payload.json'
        payload_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + '\n',
            encoding='utf-8')
        provenance['fixture_hashes'][
            'wallet_api_payload_json_sha256'] = digest(payload_path)

        validate_bff_contract(bff)
        validate_dependency_lock(dependency)
        validate_wallet_payload(payload)
        validate_flutter_fixture(flutter)
        validate_provenance(provenance, payload_path)

        def schema_rejections(document, validator, version_key):
            missing = mutate(document)
            missing.pop(next(reversed(missing)))
            extra = mutate(document)
            extra['unknown_schema_key'] = 'forbidden'
            version = mutate(document)
            version[version_key] = 2
            wrong_type = mutate(document)
            wrong_type[version_key] = True
            return [rejection_proved(lambda item=item: validator(item))
                    for item in (missing, extra, version, wrong_type)]

        checks.extend(schema_rejections(
            bff, validate_bff_contract, 'schema_version'))
        checks.extend(schema_rejections(
            dependency, validate_dependency_lock, 'schema_version'))
        checks.extend(schema_rejections(
            payload, validate_wallet_payload, 'version'))
        checks.extend(schema_rejections(
            flutter, validate_flutter_fixture, 'schema_version'))
        checks.extend(schema_rejections(
            provenance,
            lambda item: validate_provenance(item, payload_path),
            'schema_version'))

        for operation_index, operation in enumerate(bff['operations']):
            expected = OPERATION_CONTRACTS[operation_index]
            for direction in ('request', 'response'):
                for schema in operation[f'{direction}_variants']:
                    variant = schema['variant']
                    example = OPERATION_VARIANT_EXAMPLES[
                        operation['name']][f'{direction}s'][variant]
                    missing = mutate(example)
                    if missing:
                        missing.pop(next(reversed(missing)))
                        checks.append(rejection_proved(
                            lambda missing=missing, operation=operation,
                                   direction=direction, variant=variant:
                            validate_operation_variant_payload(
                                operation, direction, variant, missing,
                                'matrix.variant.missing')))
                    extra = mutate(example)
                    extra['unknown_forbidden'] = 'x'
                    checks.append(rejection_proved(
                        lambda extra=extra, operation=operation,
                               direction=direction, variant=variant:
                        validate_operation_variant_payload(
                            operation, direction, variant, extra,
                            'matrix.variant.extra')))
                    bad_schema = mutate(bff)
                    bad_schema['operations'][operation_index][
                        f'{direction}_variants'][
                            operation[f'{direction}_variants'].index(schema)][
                                'exact_keys'].append('unknown_forbidden')
                    checks.append(rejection_proved(
                        lambda bad_schema=bad_schema:
                        validate_bff_contract(bad_schema)))
            bad = mutate(bff)
            bad['operations'][operation_index]['facade_access'] = 'public'
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))

        variant_cases = []
        review_leak = mutate(
            OPERATION_VARIANT_EXAMPLES['review_prepare'][
                'responses']['default'])
        review_leak['official_formatter_envelope_bytes_base64'] = (
            SCHEMA_EXAMPLE_ENVELOPE_BASE64)
        variant_cases.append((2, 'response', 'default', review_leak))
        recipient_confusion = mutate(
            OPERATION_VARIANT_EXAMPLES['recipient_preflight'][
                'requests']['resolve'])
        recipient_confusion['command'] = 'acknowledge'
        variant_cases.append((1, 'request', 'resolve', recipient_confusion))
        auth_confusion = mutate(
            OPERATION_VARIANT_EXAMPLES['authorization_submission'][
                'requests']['issue_payload'])
        auth_confusion['command'] = 'submit_signature'
        variant_cases.append((3, 'request', 'issue_payload', auth_confusion))
        bad_signature = mutate(
            OPERATION_VARIANT_EXAMPLES['authorization_submission'][
                'requests']['submit_signature'])
        bad_signature['authorization_signature'] = '***'
        variant_cases.append(
            (3, 'request', 'submit_signature', bad_signature))
        bad_issue_digest = mutate(
            OPERATION_VARIANT_EXAMPLES['authorization_submission'][
                'responses']['issue_payload'])
        bad_issue_digest['official_formatter_envelope_sha256'] = '0' * 64
        variant_cases.append(
            (3, 'response', 'issue_payload', bad_issue_digest))
        result_handle = {'result_binding_handle': 'forbidden'}
        variant_cases.append((4, 'request', 'default', result_handle))
        for index, direction, variant, value in variant_cases:
            operation = bff['operations'][index]
            checks.append(rejection_proved(
                lambda operation=operation, direction=direction,
                       variant=variant, value=value:
                validate_operation_variant_payload(
                    operation, direction, variant, value,
                    'matrix.variant.confusion')))

        replay_paths = (
            (('body_base64',), 'e30='),
            (('body_base64',), '***'),
            (('body_base64',), base64.b64encode(
                b'{"amount_type": "exact_input"}').decode()),
            (('body_base64',), base64.b64encode(b'not-json').decode()),
            (('body_sha256',), '0' * 64),
            (('official_formatter_envelope_bytes_base64',), 'e30='),
            (('official_formatter_envelope_bytes_base64',), '***'),
            (('authorization_signature_base64',), '***'),
            (('authorization_signature_base64',), ''),
            (('url',), 'https://example.invalid/transfer'),
            (('method',), 'GET'),
            (('signed_headers', 'privy-idempotency-key'), 'different_key_000000'),
            (('signed_headers', 'privy-request-expiry'), '1893456000001'),
            (('idempotency_key',), 'different_key_000000'),
            (('request_expiry_ms',), 9007199254740992),
            (('official_formatter_envelope_sha256',), '0' * 64),
            (('record_version',), True),
            (('body_base64',), base64.b64encode(
                b'x' * 131073).decode('ascii')),
        )
        for path, value in replay_paths:
            bad = mutate(bff)
            target = bad['official_integration_v4'][
                'record_instances']['replay_material_template']
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))

        def mutated_envelope_document(change):
            bad = mutate(bff)
            replay = bad['official_integration_v4'][
                'record_instances']['replay_material_template']
            envelope = mutate(WALLET_PAYLOAD_EXAMPLE)
            change(envelope)
            encoded = json.dumps(
                envelope, ensure_ascii=False,
                separators=(',', ':')).encode('utf-8')
            replay['official_formatter_envelope_bytes_base64'] = (
                base64.b64encode(encoded).decode('ascii'))
            replay['official_formatter_envelope_sha256'] = hashlib.sha256(
                encoded).hexdigest()
            return bad

        envelope_relational_cases = (
            lambda envelope: envelope.__setitem__(
                'url', 'https://api.privy.io/v1/wallets/wallet_other_01/transfer'),
            lambda envelope: envelope.__setitem__('method', 'GET'),
            lambda envelope: envelope['headers'].__setitem__(
                'privy-app-id', 'app_other_public_01'),
            lambda envelope: envelope['headers'].__setitem__(
                'privy-idempotency-key', 'other_idempotency_000001'),
            lambda envelope: envelope['headers'].__setitem__(
                'privy-request-expiry', '1893456000001'),
            lambda envelope: envelope['body']['source'].__setitem__(
                'amount', '1.26'),
        )
        for change in envelope_relational_cases:
            bad = mutated_envelope_document(change)
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))
        bad = mutate(bff)
        replay = bad['official_integration_v4'][
            'record_instances']['replay_material_template']
        replay['official_formatter_envelope_bytes_base64'] = replay['body_base64']
        replay['official_formatter_envelope_sha256'] = replay['body_sha256']
        checks.append(rejection_proved(
            lambda bad=bad: validate_bff_contract(bad)))

        response_paths = (
            ('schema_version', True), ('response_record_version', 0),
            ('fencing_token', False), ('http_status', 600),
            ('received_at_ms', 9007199254740992),
            ('response_body_sha256', 'nothex'),
            ('encrypted_response_body_base64', '***'),
            ('encrypted_body_byte_length', 65537),
            ('provider_wallet_id', None), ('body_encoding', 'utf8'),
        )
        for key, value in response_paths:
            bad = mutate(bff)
            bad['official_integration_v4']['record_instances'][
                'provider_response_template'][key] = value
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))

        for key, value in (
                ('schema_version', True), ('record_version', 0),
                ('fencing_token', False), ('received_at_ms', True),
                ('raw_body_sha256', 'nothex'),
                ('signature_verified', 1),
                ('exact_action_binding_verified', 0),
                ('record_digest', 'nothex')):
            bad = mutate(bff)
            bad['official_integration_v4']['record_instances'][
                'verified_event_binding_template'][key] = value
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))

        attempts = bff['official_integration_v4'][
            'record_instances']['submission_attempt_instances']
        unknown_indices = [
            index for index, item in enumerate(attempts)
            if item['state'] == 'submission_unknown']
        for index in unknown_indices:
            for key, value in (
                    ('unknown_reason', None),
                    ('exact_replay_count', True),
                    ('replay_material', None)):
                bad = mutate(bff)
                bad['official_integration_v4']['record_instances'][
                    'submission_attempt_instances'][index][key] = value
                checks.append(rejection_proved(
                    lambda bad=bad: validate_bff_contract(bad)))
            bad = mutate(bff)
            target_attempt = bad['official_integration_v4']['record_instances'][
                'submission_attempt_instances'][index]
            target_attempt['synchronous_5xx_records'] = (
                [] if target_attempt['synchronous_5xx_records'] else
                [copy.deepcopy(FIVE_TEMPLATES[0])])
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))
        bad = mutate(bff)
        rejected = mutate(attempts[0])
        rejected['state'] = 'provider_rejected_before_action'
        rejected['replay_material'] = None
        rejected['recovery_lease'] = None
        rejected['provider_response_record'] = _bind_record(
            RESPONSE_TEMPLATE, rejected['submission_record_id'],
            rejected['record_version'], response_status=400)
        rejected['provider_action_id'] = None
        bad['official_integration_v4']['record_instances'][
            'submission_attempt_instances'].append(rejected)
        checks.append(rejection_proved(
            lambda: validate_bff_contract(bad)))

        def attempt_index(predicate):
            return next(index for index, item in enumerate(attempts)
                        if predicate(item))

        first_5xx_index = attempt_index(
            lambda item: item['unknown_reason'] ==
            'first_synchronous_5xx_before_replay')
        second_5xx_index = attempt_index(
            lambda item: item['unknown_reason'] ==
            'second_synchronous_5xx_after_exact_replay')
        nonallowlisted_index = attempt_index(
            lambda item: item['unknown_reason'] == 'nonallowlisted_4xx')
        replay_transport_index = attempt_index(
            lambda item: item['state'] == 'transport_in_progress' and
            item['replay_origin'] == 'exact_replay')
        response_index = attempt_index(
            lambda item: item['state'] == 'response_recorded')
        post_bound_index = attempt_index(
            lambda item: item['state'] == 'action_bound' and
            item['action_binding_evidence']['kind'] == 'post_response')
        event_bound_index = attempt_index(
            lambda item: item['state'] == 'action_bound' and
            item['action_binding_evidence']['kind'] == 'verified_event')
        replay_response_index = attempt_index(
            lambda item: item['state'] == 'response_recorded' and
            item['replay_reason'] == 'first_synchronous_5xx')
        replay_post_bound_index = attempt_index(
            lambda item: item['state'] == 'action_bound' and
            item['action_binding_evidence']['kind'] == 'post_response' and
            item['replay_reason'] == 'first_synchronous_5xx')
        expiry_index = attempt_index(
            lambda item: item['unknown_reason'] == 'signed_expiry_elapsed')
        zero_index = attempt_index(
            lambda item: item['state'] == 'proved_not_submitted')
        close_index = attempt_index(
            lambda item: item['state'] == 'operator_closed')
        relational_cases = (
            (first_5xx_index, ('synchronous_5xx_records', 0,
                               'response_body_sha256'), 'a' * 64),
            (second_5xx_index, ('synchronous_5xx_records', 1,
                                'response_body_sha256'), 'a' * 64),
            (nonallowlisted_index,
             ('provider_response_record', 'record_digest'), 'a' * 64),
            (response_index,
             ('provider_response_record', 'submission_record_id'),
             'other_submission'),
            (response_index,
             ('provider_response_record', 'response_record_version'), 99),
            (response_index, ('provider_response_record', 'fencing_token'), 3),
            (response_index, ('provider_action_id',), 'similar_action'),
            (post_bound_index,
             ('action_binding_evidence', 'provider_response_record',
              'record_digest'), 'a' * 64),
            (event_bound_index,
             ('action_binding_evidence', 'verified_event_binding_record',
              'provider_action_id'), 'similar_action'),
            (event_bound_index, ('provider_response_record',),
             copy.deepcopy(RESPONSE_TEMPLATE)),
            (zero_index, ('zero_byte_proof', 'owner_user_id'), 'other_owner'),
            (close_index, ('operator_close_evidence', 'closed_at_ms'), 1),
            (close_index, ('operator_close_evidence', 'reason_code'), 'OTHER'),
            (close_index, ('operator_close_evidence', 'actor_id'), ''),
            (close_index, ('result_binding_tombstone', 'evidence_digest'),
             '6' * 64),
            (close_index, ('updated_at_ms',), 1),
            (replay_transport_index, ('transport_ordinal',), 1),
            (replay_transport_index, ('replay_origin',), 'initial_submission'),
            (replay_transport_index, ('replay_reason',), 'other_uncertain'),
            (replay_transport_index, ('synchronous_5xx_records',), []),
            (replay_transport_index, ('updated_at_ms',),
             attempts[replay_transport_index]['request_expiry_ms']),
            (expiry_index, ('updated_at_ms',),
             attempts[expiry_index]['request_expiry_ms'] - 1),
            (replay_response_index, ('synchronous_5xx_records',), []),
            (replay_response_index,
             ('synchronous_5xx_records', 0, 'record_version'),
             attempts[replay_response_index]['record_version']),
            (replay_response_index, ('replay_reason',), 'other_uncertain'),
            (replay_post_bound_index, ('synchronous_5xx_records',), []),
            (replay_post_bound_index,
             ('synchronous_5xx_records', 0, 'response_body_sha256'),
             'a' * 64),
            (0, ('signed_request_digest',), '0' * 64),
        )
        for index, path, value in relational_cases:
            bad = mutate(bff)
            target = bad['official_integration_v4']['record_instances'][
                'submission_attempt_instances'][index]
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))

        for index, transition in enumerate(ALLOWED_TRANSITIONS):
            for key, value in (
                    ('transition_id', 'duplicate_transition'),
                    ('from', 'wrong_state'), ('to', 'wrong_state'),
                    ('unlock', 1 if transition['unlock'] is False else 0),
                    ('cut_point', 'wrong_cut'),
                    ('audit_event_type', 'wrong_event')):
                bad = mutate(bff)
                bad['official_integration_v4']['graph_authority'][
                    'allowed_transitions'][index][key] = value
                checks.append(rejection_proved(
                    lambda bad=bad: validate_bff_contract(bad)))
            bad = mutate(bff)
            bad['official_integration_v4']['graph_authority'][
                'cut_point_table'][index]['transition_id'] = 'wrong'
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))

        histories = bff['official_integration_v4'][
            'record_instances']['audit_histories']
        for index, transition in enumerate(ALLOWED_TRANSITIONS):
            for key, value in (
                    ('transition_id', 'wrong_transition'),
                    ('before_record_version', True),
                    ('after_record_version', 999),
                    ('predecessor_state', 'wrong_state')):
                bad = mutate(bff)
                event = bad['official_integration_v4']['record_instances'][
                    'audit_histories'][index]['events'][-1]
                event[key] = value
                checks.append(rejection_proved(
                    lambda bad=bad: validate_bff_contract(bad)))
            bad = mutate(bff)
            bad['official_integration_v4']['record_instances'][
                'audit_histories'][index]['events'][-1][
                    'payload']['unknown_key'] = 'x'
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))
        for key, value in (
                ('before_record_version', 0),
                ('before_fencing_token', 0),
                ('predecessor_state', 'none'),
                ('after_record_version', True),
                ('evidence_class', 'provider_evidence'),
                ('evidence_digest', 'nothex')):
            bad = mutate(bff)
            event = bad['official_integration_v4']['record_instances'][
                'audit_histories'][0]['events'][0]
            event[key] = value
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))
        bad = mutate(bff)
        bad['official_integration_v4']['record_instances'][
            'audit_histories'][0]['events'][0]['payload']['unknown_key'] = 'x'
        checks.append(rejection_proved(
            lambda bad=bad: validate_bff_contract(bad)))

        history_relations = (
            (0, -1, 'submission_record_id', 'cross_submission'),
            (0, -1, 'owner_user_id', 'cross_owner'),
            (0, -1, 'wallet_id', 'cross_wallet'),
            (next(i for i, h in enumerate(histories)
                  if len(h['events']) >= 3), 2,
             'before_record_version', 999),
            (next(i for i, h in enumerate(histories)
                  if len(h['events']) >= 3), 2,
             'before_fencing_token', 999),
            (next(i for i, h in enumerate(histories)
                  if len(h['events']) >= 3), 2,
             'predecessor_state', 'committed_before_write'),
        )
        for history_index, event_index, key, value in history_relations:
            bad = mutate(bff)
            bad['official_integration_v4']['record_instances'][
                'audit_histories'][history_index]['events'][event_index][key] = value
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))
        bad = mutate(bff)
        bad['official_integration_v4']['record_instances'][
            'audit_histories'][1]['coverage_transition_id'] = (
                bad['official_integration_v4']['record_instances'][
                    'audit_histories'][0]['coverage_transition_id'])
        checks.append(rejection_proved(
            lambda bad=bad: validate_bff_contract(bad)))
        bad = mutate(bff)
        audit_list = bad['official_integration_v4']['record_instances'][
            'audit_histories']
        audit_list[0], audit_list[1] = audit_list[1], audit_list[0]
        checks.append(rejection_proved(
            lambda bad=bad: validate_bff_contract(bad)))
        for transition_id, payload_key, value in (
                ('t06_second_5xx', 'ordinal', 1),
                ('t09_exact_replay', 'retained_5xx_count', 0),
                ('t09_exact_replay', 'transport_ordinal', 1),
                ('t09_exact_replay', 'replay_reason', 'other_uncertain'),
                ('t16_second_uncertain', 'exact_replay_count', 0),
                ('t15_operator_close', 'reason_code', 'OTHER')):
            bad = mutate(bff)
            history = next(item for item in
                           bad['official_integration_v4']['record_instances'][
                               'audit_histories']
                           if item['coverage_transition_id'] == transition_id)
            history['events'][-1]['payload'][payload_key] = value
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))
        bad = mutate(bff)
        post_history = next(
            item for item in bad['official_integration_v4'][
                'record_instances']['audit_histories']
            if item['coverage_transition_id'] == 't11_atomic_binding')
        next(event for event in post_history['events']
             if event['transition_id'] == 't10_response_record')[
                 'payload']['provider_response_record_digest'] = 'a' * 64
        checks.append(rejection_proved(
            lambda bad=bad: validate_bff_contract(bad)))
        for transition_id, key, value_factory in (
                ('t09_exact_replay', 'observed_at_ms',
                 lambda payload: payload['request_expiry_ms']),
                ('t09_exact_replay', 'request_expiry_ms',
                 lambda payload: payload['request_expiry_ms'] + 1),
                ('t13_expiry', 'observed_at_ms',
                 lambda payload: payload['request_expiry_ms'] - 1),
                ('t13_expiry', 'request_expiry_ms',
                 lambda payload: payload['request_expiry_ms'] + 1)):
            bad = mutate(bff)
            history = next(
                item for item in bad['official_integration_v4'][
                    'record_instances']['audit_histories']
                if item['coverage_transition_id'] == transition_id)
            payload = history['events'][-1]['payload']
            payload[key] = value_factory(payload)
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))
        for transition_id in ('t09_exact_replay', 't13_expiry'):
            bad = mutate(bff)
            history = next(
                item for item in bad['official_integration_v4'][
                    'record_instances']['audit_histories']
                if item['coverage_transition_id'] == transition_id)
            history['events'][-1]['occurred_at_ms'] += 1
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))
        for coverage_id, nested_transition_id, key, value in (
                ('t06_second_5xx', 't05_first_5xx',
                 'response_body_sha256', 'a' * 64),
                ('t06_second_5xx', 't09_exact_replay',
                 'retained_5xx_count', 0),
                ('t16_second_uncertain', 't09_exact_replay',
                 'retained_5xx_count', 1)):
            bad = mutate(bff)
            history = next(
                item for item in bad['official_integration_v4'][
                    'record_instances']['audit_histories']
                if item['coverage_transition_id'] == coverage_id)
            next(event for event in history['events']
                 if event['transition_id'] == nested_transition_id)[
                     'payload'][key] = value
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))
        bad = mutate(bff)
        post_history = next(
            item for item in bad['official_integration_v4'][
                'record_instances']['audit_histories']
            if item['coverage_transition_id'] == 't11_atomic_binding')
        post_history['events'] = [
            event for event in post_history['events']
            if event['transition_id'] != 't05_first_5xx']
        checks.append(rejection_proved(
            lambda bad=bad: validate_bff_contract(bad)))
        bad = mutate(bff)
        post_history = next(
            item for item in bad['official_integration_v4'][
                'record_instances']['audit_histories']
            if item['coverage_transition_id'] == 't11_atomic_binding')
        next(event for event in post_history['events']
             if event['transition_id'] == 't05_first_5xx')[
                 'payload']['response_body_sha256'] = 'a' * 64
        checks.append(rejection_proved(
            lambda bad=bad: validate_bff_contract(bad)))

        replay_terminal = attempts[replay_post_bound_index]
        replay_attempt_mutations = (
            (('synchronous_5xx_records', 0, 'record_version'),
             replay_terminal['synchronous_5xx_records'][0]['record_version'] + 1),
            (('synchronous_5xx_records', 0, 'fencing_token'),
             replay_terminal['fencing_token'] + 1),
            (('updated_at_ms',), replay_terminal['updated_at_ms'] + 1),
            (('provider_action_id',), 'cross_action_id'),
        )
        for path, value in replay_attempt_mutations:
            bad = mutate(bff)
            target = bad['official_integration_v4']['record_instances'][
                'submission_attempt_instances'][replay_post_bound_index]
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))

        response_mutations = (
            ('response_record_version', replay_terminal['record_version']),
            ('fencing_token', replay_terminal['fencing_token'] + 1),
            ('received_at_ms', replay_terminal[
                'synchronous_5xx_records'][0]['received_at_ms']),
            ('received_at_ms', replay_terminal['updated_at_ms'] + 1),
            ('submission_record_id', 'cross_submission_record'),
            ('owner_user_id', 'cross_owner_record'),
            ('wallet_id', 'cross_wallet_record'),
        )
        for key, value in response_mutations:
            bad = mutate(bff)
            target = bad['official_integration_v4']['record_instances'][
                'submission_attempt_instances'][replay_post_bound_index]
            target['provider_response_record'][key] = value
            target['action_binding_evidence'][
                'provider_response_record'][key] = value
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))

        replay_history_mutations = (
            ('t01_transport_start', 'payload', 'request_digest', '0' * 64),
            ('t05_first_5xx', 'after_record_version', None,
             replay_terminal['record_version'] - 2),
            ('t05_first_5xx', 'after_fencing_token', None,
             replay_terminal['fencing_token'] + 1),
            ('t09_exact_replay', 'after_record_version', None,
             replay_terminal['record_version'] - 1),
            ('t10_response_record', 'after_record_version', None,
             replay_terminal['record_version']),
            ('t10_response_record', 'after_fencing_token', None,
             replay_terminal['fencing_token'] + 1),
            ('t10_response_record', 'occurred_at_ms', None,
             replay_terminal['provider_response_record']['received_at_ms'] - 1),
            ('t11_atomic_binding', 'after_record_version', None,
             replay_terminal['record_version'] - 1),
            ('t11_atomic_binding', 'after_fencing_token', None,
             replay_terminal['fencing_token'] + 1),
            ('t11_atomic_binding', 'occurred_at_ms', None,
             replay_terminal['updated_at_ms'] + 1),
        )
        for transition_id, key, nested_key, value in replay_history_mutations:
            bad = mutate(bff)
            history = next(
                item for item in bad['official_integration_v4'][
                    'record_instances']['audit_histories']
                if item['coverage_transition_id'] == 't11_atomic_binding')
            event = next(item for item in history['events']
                         if item['transition_id'] == transition_id)
            if nested_key is None:
                event[key] = value
            else:
                event[key][nested_key] = value
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))

        bad = mutate(bff)
        history = next(
            item for item in bad['official_integration_v4'][
                'record_instances']['audit_histories']
            if item['coverage_transition_id'] == 't11_atomic_binding')
        cross_identity = {
            'submission_record_id': 'cross_submission_history',
            'owner_user_id': 'cross_owner_history',
            'wallet_id': 'cross_wallet_history',
        }
        for key, value in cross_identity.items():
            history[key] = value
            for event in history['events']:
                event[key] = value
        checks.append(rejection_proved(
            lambda bad=bad: validate_bff_contract(bad)))

        official_paths = (
            (('implementation_boundaries', 'viem_role'),
             'custom_wallet_lifecycle'),
            (('authorization_flow',
              'review_prepare_page_response_exact_keys'),
             ['prepared_review_handle',
              'official_formatter_envelope_bytes_base64']),
            (('authorization_flow', 'issue_payload', 'facade_access'), 'page'),
            (('authorization_flow', 'crypto_authority'), 'BFF'),
            (('result_access', 'query_exact_keys'), ['cursor']),
            (('result_access', 'response_union'), ['cursor']),
            (('provider_reads', 'rest',
              'pending_authenticated_reload_resume'), 1),
            (('provider_reads', 'rest',
              'first_terminal_permanently_stops_across'), ['route_change']),
            (('provider_reads', 'rest', 'unrecognized_status_policy'),
             'failed'),
            (('provider_reads', 'rest', 'role'), 'authority'),
            (('recovery_contract', 'startup_scan', 'enabled'), 1),
            (('recovery_contract', 'periodic_scan', 'interval_ms'), 0),
            (('recovery_contract', 'lease', 'acquire'), 'blind_write'),
            (('recovery_contract', 'fencing',
              'monotonic_increase_on_acquire'), 1),
            (('recovery_contract', 'fencing', 'stale_worker_send'), 'allowed'),
            (('recovery_contract', 'replay', 'maximum_exact_replays'), 2),
            (('recovery_contract', 'replay',
              'only_before_original_signed_expiry'), 1),
            (('schema_examples', 'evidence_class'), 'provider_evidence'),
            (('schema_examples', 'official_formatter_output_provenance'),
             'official_golden'),
            (('provider_reads', 'merge_rules',
              'pre_response_inbox', 'capacity'), 4097),
            (('provider_reads', 'merge_rules',
              'pre_response_inbox', 'ttl_ms'), 86400001),
            (('staging_r0_command_evidence_map', 0, 'command'), 'short-command'),
            (('staging_r0_command_evidence_map', 0, 'evidence'),
             R0_EVIDENCE[1]),
        )
        for path, value in official_paths:
            bad = mutate(bff)
            target = bad['official_integration_v4']
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))
        for path, value in (
                (('commands', 0), R0_COMMANDS[0].replace(
                    ' --credentials-required', '')),
                (('required_evidence', 0), R0_EVIDENCE[1]),
                (('credentials_configured',), 0),
                (('production_integration_complete',), 1)):
            bad = mutate(bff)
            target = bad['staging_r0']
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            checks.append(rejection_proved(
                lambda bad=bad: validate_bff_contract(bad)))

        for base, validator in (
                (flutter, validate_flutter_fixture),
                (provenance,
                 lambda item: validate_provenance(item, payload_path))):
            for path, value in (
                    (('signature_path',), 'structured_payload'),
                    (('method',), 'customSign'),
                    (('payload_encoding',), 'json'),
                    (('formatter', 'version'), 'latest'),
                    (('generation', 'command'), None),
                    (('generation', 'tool_versions', 'node'), 'fake'),
                    (('generation', 'generated_at'), 'fake'),
                    (('authorization_payload_base64',),
                     SCHEMA_EXAMPLE_ENVELOPE_BASE64),
                    (('authorization_payload_sha256',),
                     SCHEMA_EXAMPLE_ENVELOPE_SHA256),
                    (('authorization_signature',), 'fabricated')
                    if base is flutter else
                    (('fixture_hashes', 'canonical_payload_sha256'), 'a' * 64)):
                bad = mutate(base)
                target = bad
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value
                checks.append(rejection_proved(
                    lambda bad=bad, validator=validator: validator(bad)))

        for package_index in range(len(dependency['packages'])):
            for key, value in (
                    ('version', 'latest'), ('registry', 'unknown'),
                    ('integrity', 'fabricated'), ('license', 'UNKNOWN'),
                    ('source', 'https://example.invalid'),
                    ('repository', 'https://example.invalid'),
                    ('runtime_target', 'wrong_runtime'),
                    ('installed', True)):
                bad = mutate(dependency)
                bad['packages'][package_index][key] = value
                checks.append(rejection_proved(
                    lambda bad=bad: validate_dependency_lock(bad)))

        # Pin Flutter source provenance independently of the generic package
        # metadata mutations.  The first case is the superseded v8 repository;
        # it deliberately remains a no-op under v8 and therefore proves RED
        # until the canonical pub.dev/archive repository is corrected.
        for repository in (
                'https://github.com/privy-io/privy-flutter.git',
                'https://example.invalid/privy-io/flutter-sdk',
                'https://github.com/not-privy/flutter-sdk',
                'https://github.com/privy-io/not-flutter-sdk'):
            bad = mutate(dependency)
            bad['packages'][3]['repository'] = repository
            checks.append(rejection_proved(
                lambda bad=bad: validate_dependency_lock(bad)))

        provenance_drifts = (
            ('archive_url', 'https://example.invalid/privy_flutter-0.10.1.tar.gz'),
            ('archive_sha256', '0' * 64),
            ('license', 'UNKNOWN'),
            ('repository', 'https://github.com/privy-io/privy-flutter.git'),
            ('repository', 'https://example.invalid/privy-io/flutter-sdk'),
            ('repository', 'https://github.com/not-privy/flutter-sdk'),
            ('repository', 'https://github.com/privy-io/not-flutter-sdk'),
        )
        for base, nested_key, validator in (
                (flutter, 'package', validate_flutter_fixture),
                (provenance, 'flutter',
                 lambda item: validate_provenance(item, payload_path))):
            for key, value in provenance_drifts:
                bad = mutate(base)
                bad[nested_key][key] = value
                checks.append(rejection_proved(
                    lambda bad=bad, validator=validator: validator(bad)))

        # Synchronized tampering across every package-provenance record must
        # also remain RED, so self-consistency cannot bless a wrong origin.
        for repository in (
                'https://github.com/privy-io/privy-flutter.git',
                'https://example.invalid/privy-io/flutter-sdk',
                'https://github.com/not-privy/flutter-sdk',
                'https://github.com/privy-io/not-flutter-sdk'):
            bad_dependency = mutate(dependency)
            bad_flutter = mutate(flutter)
            bad_provenance = mutate(provenance)
            bad_dependency['packages'][3]['repository'] = repository
            bad_flutter['package']['repository'] = repository
            bad_provenance['flutter']['repository'] = repository
            checks.append(rejection_proved(
                lambda bad_dependency=bad_dependency,
                       bad_flutter=bad_flutter,
                       bad_provenance=bad_provenance: (
                    validate_dependency_lock(bad_dependency),
                    validate_flutter_fixture(bad_flutter),
                    validate_provenance(bad_provenance, payload_path))))

        wallet_result = {
            'kind': 'wallet_action',
            'wallet_action': {
                'action_id': 'action_01', 'review_id': 'review_01',
                'wallet_id': 'wallet_01', 'type': 'transfer',
                'status': 'pending', 'source_chain': 'base',
                'source_asset': 'usdc', 'source_amount': '1.25',
                'destination_address':
                    '0x1111111111111111111111111111111111111111',
                'destination_amount': None,
                'created_at_ms': 1700000000000, 'failure': None,
                'steps': [{
                    'kind': 'evm_transaction', 'status': 'pending',
                    'chain_id': 'base', 'transaction_hash': None}]}}
        unknown_result = {
            'kind': 'submission_unknown',
            'submission_record_id': 'submission_01',
            'wallet_id': 'wallet_01',
            'created_at_ms': 1700000000000,
            'signed_request_expires_at_ms': 1700000060000,
            'safe_message_code': 'TRANSFER_RECONCILING',
            'action_id': None, 'steps': []}
        validate_transfer_result_snapshot(wallet_result)
        validate_transfer_result_snapshot(unknown_result)
        for key, value in (
                ('action_id', 'forbidden'),
                ('steps', [{'kind': 'provider_step'}]),
                ('safe_message_code', 'provider raw failure'),
                ('created_at_ms', True)):
            bad = mutate(unknown_result)
            bad[key] = value
            checks.append(rejection_proved(
                lambda bad=bad: validate_transfer_result_snapshot(bad)))

    return len(checks), all(checks)


def run_contract_checks():
    print('== Credential-gated production contract ==')
    tree_ok = True
    try:
        inspect_contract_tree(CONTRACT)
    except ContractViolation as error:
        tree_ok = False
        check(False, str(error))
    else:
        check(True, 'exact seven-file contract tree, regular files, no symlinks')
    if tree_ok:
        documents = {}
        for relative in JSON_CONTRACT_FILES:
            try:
                documents[relative] = strict_json_load(CONTRACT / relative, CONTRACT)
            except ContractViolation as error:
                check(False, str(error))
        if len(documents) == len(JSON_CONTRACT_FILES):
            validators = (
                ('bff-contract.json', lambda: validate_bff_contract(documents['bff-contract.json'])),
                ('dependency-lock.json',
                 lambda: validate_dependency_lock(documents['dependency-lock.json'])),
                ('fixtures/wallet-api-payload-v1.json',
                 lambda: validate_wallet_payload(documents['fixtures/wallet-api-payload-v1.json'])),
                ('fixtures/flutter-authorization-signature.json',
                 lambda: validate_flutter_fixture(
                     documents['fixtures/flutter-authorization-signature.json'])),
                ('fixtures/provenance.json', lambda: validate_provenance(
                    documents['fixtures/provenance.json'],
                    CONTRACT / 'fixtures/wallet-api-payload-v1.json')),
            )
            for name, validator in validators:
                try:
                    validator()
                except ContractViolation as error:
                    check(False, f'{name}: {error}')
                else:
                    check(True, f'{name} exact schema v1/enums/bounds')
        try:
            canonical_status = (CONTRACT / 'fixtures/wallet-api-payload-v1.canonical.bin.sha256').read_bytes()
            require_contract(canonical_status == b'PENDING\n',
                             'canonical formatter hash must be PENDING, not fabricated 64hex')
            validate_readme(CONTRACT / 'README.md')
        except (ContractViolation, OSError, UnicodeError) as error:
            check(False, str(error))
        else:
            check(True, 'README boundaries and Task 4 pending canonical hash')
    count, isolated = run_malicious_contract_matrix()
    check(isolated, f'malicious contract isolation matrix rejects all {count} mutations')
    import_findings = dependency_import_findings(ROOT)
    check(not import_findings,
          f'production dependencies are declared only, not installed/imported: {import_findings}')


run_contract_checks()
if CONTRACT_ONLY:
    if fails:
        print(f'\n{len(fails)} production-contract checks failed.')
        sys.exit(1)
    print('\nCredential-gated production contract checks passed.')
    sys.exit(0)


print('== Transfer source/build contract ==')
screen_manifest = lines(SRC / 'screens-order.txt')
script_manifest = lines(SRC / 'scripts-order.txt')
check(screen_manifest == SCREENS, f'exact pinned 42-screen order: {screen_manifest}')
check(script_manifest == SCRIPTS, f'exact pinned twelve-script order: {script_manifest}')
screen_sources = sorted(p.stem for p in (SRC / 'screens').glob('*.html')
                        if not p.name.startswith('._'))
script_sources = sorted(p.relative_to(SRC).as_posix() for p in SRC.rglob('*.js')
                        if not p.name.startswith('._') and
                        p.relative_to(SRC).parts[0] != 'test-fixtures')
check(screen_sources == sorted(SCREENS), 'no missing/orphan screen sources')
check(script_sources == sorted(SCRIPTS), 'no missing/orphan script sources')

fragments = {}
for name in SHELLS:
    path = SRC / 'screens' / f'{name}.html'
    text = path.read_text() if path.is_file() else ''
    fragments[name] = text
    check(len(re.findall(r'<section\b[^>]*\bclass="[^"]*\bscr\b', text)) == 1,
          f'{name} has exactly one .scr')
    check(bool(re.search(rf'\bid="scr-{re.escape(name)}"', text)),
          f'{name} has its unique screen id')
    check(len(re.findall(r'<h1\b', text)) == 1 and
          len(re.findall(r'<h1\b[^>]*\bdata-route-focus\b', text)) == 1,
          f'{name} has one route-focus H1')
    check(bool(re.search(r'<button\b[^>]*\bonclick="back\(\)"', text)),
          f'{name} has a safe back control')
    check(len(re.findall(r'<(?:p|div)\b[^>]*\brole="status"', text)) == 1,
          f'{name} has one semantic status container')
h1s = [re.search(r'<h1\b[^>]*>(.*?)</h1>', fragments[n], re.S).group(1).strip()
       if re.search(r'<h1\b[^>]*>(.*?)</h1>', fragments[n], re.S) else ''
       for n in SHELLS]
check(len(set(h1s)) == 4 and all(h1s), f'unique non-empty H1 labels: {h1s}')

shell_text = '\n'.join(fragments.values())
for pattern, label in (
        (r'data-requires-signing', 'functional signing controls'),
        (r'\baction[_-]?id\b', 'action IDs'),
        (r'0x[a-fA-F0-9]{8,}', 'recipient/transaction addresses'),
        (r'\b(?:success|succeeded)\b', 'fake success claims'),
        (r'\b(?:recipient|amount|provider)\b', 'recipient/amount/provider data')):
    check(not re.search(pattern, shell_text, re.I), f'shells contain no {label}')
check('role="dialog"' not in shell_text and 'confirmation-dialog' not in shell_text,
      'shells add no second confirmation dialog')

app_source = (SRC / 'app.js').read_text()
for name in SHELLS:
    check(bool(re.search(rf"['\"]?{re.escape(name)}['\"]?:\{{screen:'scr-{re.escape(name)}'",
                         app_source)), f'ROUTES includes {name}')
shell_close = (SRC / 'shell-close.html').read_text()
check(len(re.findall(r'\bid="review-dialog"[^>]*\brole="dialog"|'
                     r'\brole="dialog"[^>]*\bid="review-dialog"', shell_close)) == 1,
      'F11 remains one review dialog')

transfer = SRC / 'wallet-transfer.js'
transfer_source = transfer.read_text() if transfer.is_file() else ''
review = SRC / 'wallet-review.js'
review_source = review.read_text() if review.is_file() else ''
check('globalThis.LoopWalletTransfer = Object.freeze({createDraftController,createResultController});'
      in transfer_source, 'exact frozen transfer facade export')
check(not re.search(r'\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendTransaction|'
                    r'signMessage|signTypedData|localStorage|sessionStorage|indexedDB)\b',
                    transfer_source), 'no network/storage/signing primitive')
check(not re.search(r'^\s*(?:let|const|var)\s+', transfer_source, re.M),
      'all transfer internals are closure-owned')
integrity_evidence = {
    'scanner': integrity_rejection_probe(
        lambda scanner, _acorn, _license:
        scanner.write_bytes(scanner.read_bytes() + b'\n// tampered\n')),
    'acorn': integrity_rejection_probe(
        lambda _scanner, acorn, _license:
        acorn.write_bytes(acorn.read_bytes() + b'\n// tampered\n')),
    'license': integrity_rejection_probe(
        lambda _scanner, _acorn, license_file:
        license_file.write_bytes(license_file.read_bytes() + b'\ntampered\n')),
}
check(all(item['launches'] == 0 and item['error'].startswith(
          'AST scanner integrity failure before launch:')
          for item in integrity_evidence.values()),
      'scanner/Acorn/license mismatches fail before the first AST subprocess: '
      f'{integrity_evidence}')
require_ast_integrity()
check(True, 'semantic security scanner, parser, and license are byte-pinned')
source_findings = security_findings(fragments, app_source, transfer_source)
check(not source_findings,
      f'four fragments, ROUTES/app, and facade executable surfaces are safe: {source_findings}')
inline_mutation = dict(fragments)
inline_mutation['send'] += (
    '<script>globalThis["fe"+"tch"]("https://invalid.example/inline")</script>')
remote_mutation = dict(fragments)
remote_mutation['send-to'] += '<img src="https://invalid.example/pixel">'
route_needle = "send:{screen:'scr-send',stack:['scr-wallet','scr-send']}"
route_mutation = app_source.replace(
    route_needle, route_needle[:-1] +
    ",effect:()=>globalThis['fe'+'tch']('https://invalid.example/route')}", 1)
storage_route_mutation = app_source.replace(
    route_needle, route_needle[:-1] +
    ",effect:()=>localStorage.setItem('route-draft','forbidden')}", 1)
check(any('executable' in item or 'reference' in item for item in
          security_findings(inline_mutation, app_source, transfer_source)),
      'inline network mutation fails the semantic security gate')
check(any('remote resource' in item for item in
          security_findings(remote_mutation, app_source, transfer_source)),
      'remote resource mutation fails the parsed-HTML security gate')
check(route_mutation != app_source and
      any('executable' in item or 'reference' in item for item in
          security_findings(fragments, route_mutation, transfer_source)),
      'ROUTES executable mutation fails the semantic security gate')
check(storage_route_mutation != app_source and
      any('executable' in item or 'reference' in item for item in
          security_findings(fragments, storage_route_mutation, transfer_source)),
      'dormant ROUTES localStorage mutation fails the semantic security gate')
check(app_source.count('length>26') == 3 and 'length>30' not in app_source,
      'all three navigation/F11 stack bounds retain the approved 26-entry limit')

build_source = (ROOT / 'build.py').read_text()
check('exact pinned 42-screen order' in build_source, 'builder pins 42-screen error text')
check('exact pinned twelve-script order' in build_source, 'builder pins twelve-script error text')
build = subprocess.run([sys.executable, 'build.py'], cwd=ROOT, text=True,
                       capture_output=True, check=False)
check(build.returncode == 0 and '42 screens' in build.stdout,
      f'build succeeds at 42 screens: {(build.stderr or build.stdout).strip()}')

print('\n== Frozen minimal facade ==')
probe = subprocess.run(['node', '-e', r"""
require(process.argv[1]);
const T=globalThis.LoopWalletTransfer,d=T?.createDraftController(),r=T?.createResultController();
const empty=v=>v&&Object.isFrozen(v)&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===0;
if(!T||!Object.isFrozen(T)||Reflect.ownKeys(T).join(',')!=='createDraftController,createResultController'||
   !empty(d)||!empty(r)||d===r)process.exit(1);
""", str(transfer)], cwd=ROOT, capture_output=True, text=True, check=False)
check(probe.returncode == 0, 'constructors return separate frozen empty shells')

print('\n== F11 review-origin stack bound ==')
check("stack=array(item.stack,26,'stack')" in review_source and
      "stack=array(item.stack,30,'stack')" not in review_source,
      'wallet-review origin retains the approved 26-entry stack bound')
review_probe = subprocess.run(['node', '-e', r"""
require(process.argv[1]);
require(process.argv[2]);
const P=globalThis.LoopWalletProvider,R=globalThis.LoopWalletReview;
const live={user_id:'fixture-user-1',wallet_id:'fixture-wallet-1',
  wallet_class:'privy_embedded',endpoint:'/v1/wallets/fixture-wallet-1/actions'};
const open=n=>R.createController({adapter:P.createSimulatedAdapter({
  walletClass:'privy_embedded',scenario:'normal'})}).open({
    review_id:'review-transfer',
    origin:{stack:Array.from({length:n},(_,index)=>`scr-level-${index}`)},
    live_context:live,trigger_ref:'fixture-trigger',now_ms:100001});
const bounded=[23,24,25,26].map(n=>open(n));
const overflow=[27,28,29,30].map(n=>open(n));
const excluded=['scr-notifications','scr-search','scr-privacy','scr-security'].map(screen=>
  R.createController({adapter:P.createSimulatedAdapter({
    walletClass:'privy_embedded',scenario:'normal'})}).open({
      review_id:'review-transfer',origin:{stack:[screen]},live_context:live,
      trigger_ref:'fixture-trigger',now_ms:100001}));
process.stdout.write(JSON.stringify({
  bounded:bounded.map(result=>result.ok),
  bounded_codes:bounded.map(result=>result.error?.code||null),
  overflow:overflow.map(result=>!result.ok&&result.error?.code==='INVALID_REQUEST'),
  excluded:excluded.map(result=>!result.ok&&result.error?.code==='INVALID_REQUEST')
}));
""", str(SRC / 'wallet-provider.js'), str(review)], cwd=ROOT,
                              capture_output=True, text=True, check=False)
try:
    review_result = json.loads(review_probe.stdout)
except json.JSONDecodeError:
    review_result = None
check(review_probe.returncode == 0 and review_result == {
          'bounded': [True, True, True, True],
          'bounded_codes': [None, None, None, None],
          'overflow': [True, True, True, True],
          'excluded': [True, True, True, True],
      },
      'F11 origin accepts <=26 and rejects synthetic 27-30 layer stacks: '
      f'{review_result or review_probe.stderr.strip()}')

print('\n== Direct-link route shells ==')
if build.returncode == 0 and APP.is_file():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 390, 'height': 844})
        errors = []
        console_messages = []
        requests = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: console_messages.append(
            {'type': message.type, 'text': message.text}))
        page.on('request', lambda request: requests.append(request.url))
        for name in SHELLS:
            page.goto('about:blank')
            page.goto(f'{RUNTIME_APP.as_uri()}#{name}')
            page.wait_for_load_state('networkidle')
            page.wait_for_timeout(300)
            active = page.evaluate("""() => [...document.querySelectorAll('.scr')]
              .filter(s=>s.classList.contains('active')&&!s.hasAttribute('inert')).map(s=>s.id)""")
            bad = page.evaluate("""() => [...document.querySelectorAll('.scr:not(.active)')]
              .filter(s=>!s.hasAttribute('inert')||s.getAttribute('aria-hidden')!=='true').map(s=>s.id)""")
            check(active == [f'scr-{name}'], f'#{name} activates one target: {active}')
            check(not bad, f'#{name} leaves inactive screens inert: {bad}')
            history_stack = page.evaluate('history.state?.stack')
            check(history_stack == CANONICAL_STACKS[name],
                  f'#{name} canonical history.state.stack: {history_stack}')
            route_shape = page.evaluate("""name => {
              const route=ROUTES[name],descriptors=Object.getOwnPropertyDescriptors(route||{});
              return {keys:Reflect.ownKeys(route||{}),screen:descriptors.screen?.value,
                stack:descriptors.stack?.value};
            }""", name)
            check(route_shape == {'keys': ['screen', 'stack'],
                                  'screen': f'scr-{name}',
                                  'stack': CANONICAL_STACKS[name]},
                  f'#{name} route is an exact inert data record: {route_shape}')
            if name in ('send-to', 'send-confirm', 'tx-result'):
                status = page.locator(f'#scr-{name} [role="status"]').inner_text()
                check('unavailable' in status.lower(),
                      f'#{name} honestly reports unavailable: {status!r}')
        page.goto('about:blank')
        page.goto(f'{RUNTIME_APP.as_uri()}#send-confirm')
        page.wait_for_load_state('networkidle')
        f5_projection = page.evaluate("""() => {
          const projection=sanitizeReviewProjectionForWrite.projection(history.state);
          return {stack:projection.stack,history:history.state.stack};
        }""")
        check(f5_projection == {'stack': CANONICAL_STACKS['send-confirm'],
                                'history': CANONICAL_STACKS['send-confirm']},
              f'F11 accepts the canonical F5 origin projection: {f5_projection}')
        accepted_screens = page.evaluate("""screens => screens.filter(screen => {
          const projection=sanitizeReviewProjectionForWrite.projection({stack:[screen]});
          return projection.stack.length===1&&projection.stack[0]===screen;
        })""", [f'scr-{name}' for name in SCREENS])
        expected_review_origins = [f'scr-{name}' for name in SCREENS
                                   if name not in ('notifications', 'search', 'privacy', 'security',
                                                   'perp-account', 'perp-transfer', 'perp-deposit',
                                                   'perp-funding', 'perp-risk-notice')]
        check(accepted_screens == expected_review_origins,
              f'F11 projection excludes nine non-wallet platform/account routes: {accepted_screens}')
        non_file_requests = [url for url in requests if not url.startswith('file:')]
        console_errors = [item for item in console_messages if item['type'] == 'error']
        check(not errors and not console_errors,
              f'new routes have no page/console errors: {errors}/{console_errors}')
        check(not non_file_requests,
              f'new routes issue no non-file requests: {non_file_requests}')
        browser.close()
else:
    check(False, 'direct-link checks reachable after build')

if fails:
    print(f'\n{len(fails)} transfer-shell checks failed.')
    sys.exit(1)
print('\nWallet transfer route-shell checks passed.')
