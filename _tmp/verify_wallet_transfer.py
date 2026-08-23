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

CONTRACT_ONLY = sys.argv[1:] == ['--contract-only']
if sys.argv[1:] and not CONTRACT_ONLY:
    raise SystemExit('usage: verify_wallet_transfer.py [--contract-only]')
if not CONTRACT_ONLY:
    from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
APP = ROOT / 'app.html'
SCREENS = [
    'splash', 'auth', 'auth-otp', 'auth-wallet', 'wallet-create',
    'wallet-backup', 'seed-show', 'seed-verify', 'wallet-import',
    'home', 'pay', 'market', 'token', 'launchpad', 'chat', 'group',
    'wallet', 'asset', 'send', 'send-to', 'send-confirm', 'receive',
    'tx-result', 'swap', 'dapp', 'profile',
]
SCRIPTS = ['vendor/qrcode-generator-1.4.4.js', 'wallet-provider.js',
           'wallet-review.js', 'wallet-transfer.js', 'app.js']
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
)
SIGNED_HEADERS = ('privy-app-id', 'privy-idempotency-key', 'privy-request-expiry')
FORBIDDEN_SIGNED_HEADERS = (
    'authorization', 'authorization-signature', 'content-type', 'traceparent',
    'tracestate', 'x-request-id', 'privy-authorization-signature',
)
OPERATION_SPECS = (
    ('asset_selections', 'GET', '/v1/transfer/assets', (),
     'asset_selection_list', 'authenticated_server_session'),
    ('recipient_preflight', 'POST', '/v1/transfer/recipient-preflight',
     ('asset_selection_id', 'recipient_input'), 'recipient_preflight',
     'preflight_server_session_digest_bound'),
    ('review_prepare', 'POST', '/v1/transfer/reviews',
     ('asset_selection_id', 'recipient_input', 'amount_decimal'),
     'prepared_review_handle', 'preflight_server_session_digest_bound'),
    ('authorization_submission', 'POST', '/v1/transfer/authorize',
     ('prepared_review_handle', 'wallet_api_payload', 'authorization_signature'),
     'result_binding_handle', 'authenticated_server_session'),
    ('result_projection', 'GET', '/v1/transfer/result',
     ('result_binding_handle',), 'transfer_result_snapshot',
     'authenticated_server_session'),
    ('current_wallet_reconciliation', 'GET', '/v1/transfer/current-result', (),
     'unique_current_result_cursor_or_unavailable', 'authenticated_server_session'),
)
POST_SIGNATURE_SEQUENCE = (
    'validate_exact_official_formatter_bytes',
    'validate_flutter_authorization_signature',
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
    'schema_version', 'submission_record_id', 'record_version', 'owner_user_id',
    'wallet_id', 'internal_review_id', 'signed_request_digest',
    'idempotency_key', 'request_expiry_ms', 'replay_material', 'state',
    'provider_action_id', 'recovery_lease', 'fencing_token',
    'exact_replay_count', 'synchronous_5xx_record', 'zero_byte_proof',
    'operator_close_evidence', 'created_at_ms', 'updated_at_ms',
)
AUDIT_EVENT_KEYS = (
    'schema_version', 'event_id', 'submission_record_id', 'record_version',
    'fencing_token', 'event_type', 'occurred_at_ms', 'evidence_digest', 'details',
)
ATTEMPT_STATES = (
    'committed_before_write', 'transport_in_progress', 'submission_unknown',
    'response_recorded', 'action_bound', 'proved_not_submitted', 'operator_closed',
)
AUDIT_EVENT_TYPES = (
    'attempt_lock_committed', 'transport_started', 'zero_byte_proved',
    'synchronous_5xx_recorded', 'exact_replay_started', 'submission_unknown',
    'provider_response_recorded', 'action_bound', 'lease_acquired',
    'operator_closed',
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
ALLOWED_TRANSITIONS = (
    {'from': 'committed_before_write', 'event': 'transport_started_after_durable_commit',
     'to': 'transport_in_progress', 'unlock': False,
     'requires': 'current_cas_lease_and_fencing_token'},
    {'from': 'committed_before_write', 'event': 'audited_zero_byte_proof_committed',
     'to': 'proved_not_submitted', 'unlock': True,
     'requires': 'durable_zero_byte_proof_record_version_and_fence'},
    {'from': 'committed_before_write',
     'event': 'crash_before_write_without_audited_zero_byte_proof',
     'to': 'submission_unknown', 'unlock': False,
     'requires': 'durable_unknown_current_cas_lease_fence_and_retained_lock'},
    {'from': 'transport_in_progress', 'event': 'ambiguous_write_or_timeout',
     'to': 'submission_unknown', 'unlock': False,
     'requires': 'durable_unknown_event'},
    {'from': 'transport_in_progress', 'event': 'synchronous_5xx_durably_recorded',
     'to': 'submission_unknown', 'unlock': False,
     'requires': 'exact_response_record_and_exact_replay_count_zero'},
    {'from': 'submission_unknown', 'event': 'exact_replay_started',
     'to': 'transport_in_progress', 'unlock': False,
     'requires': 'original_expiry_current_fence_and_exact_replay_count_zero'},
    {'from': 'transport_in_progress', 'event': 'exact_action_response_durably_recorded',
     'to': 'response_recorded', 'unlock': False,
     'requires': 'provider_response_record_before_binding'},
    {'from': 'response_recorded', 'event': 'atomic_result_binding_committed',
     'to': 'action_bound', 'unlock': True,
     'requires': 'same_submission_exact_action_id'},
    {'from': 'submission_unknown', 'event': 'verified_exact_action_event_bound',
     'to': 'action_bound', 'unlock': True,
     'requires': 'durable_verified_event_and_same_submission_binding'},
    {'from': 'submission_unknown', 'event': 'signed_expiry_elapsed',
     'to': 'submission_unknown', 'unlock': False,
     'requires': 'no_further_replay'},
    {'from': 'submission_unknown', 'event': 'second_uncertain_or_replay_exhausted',
     'to': 'submission_unknown', 'unlock': False,
     'requires': 'exact_replay_count_one_and_no_further_replay'},
    {'from': 'submission_unknown', 'event': 'operator_evidence_close_committed',
     'to': 'operator_closed', 'unlock': True,
     'requires': 'provider_reconciliation_evidence_digest_reason_actor_and_timestamp'},
)
CUT_POINT_TABLE = (
    {'cut_point': 'signature_missing_or_pre_bff_validation_failure',
     'predecessor': 'no_attempt', 'successor': 'not_submitted',
     'provider_request': 'forbidden', 'lock': 'absent',
     'next_action': 'consume_review_and_require_new_f5_prepare'},
    {'cut_point': 'attempt_and_lock_transaction_failure',
     'predecessor': 'no_attempt', 'successor': 'not_submitted',
     'provider_request': 'forbidden', 'lock': 'absent',
     'next_action': 'require_new_f5_prepare'},
    {'cut_point': 'commit_then_audited_zero_byte_proof',
     'predecessor': 'committed_before_write', 'successor': 'proved_not_submitted',
     'provider_request': 'zero_bytes_proved', 'lock': 'release_after_proof_cas_only',
     'next_action': 'require_new_f5_prepare'},
    {'cut_point': 'crash_before_write_without_zero_byte_proof',
     'predecessor': 'committed_before_write', 'successor': 'submission_unknown',
     'provider_request': 'ambiguous', 'lock': 'retain',
     'next_action': 'exact_replay_within_original_expiry_only'},
    {'cut_point': 'crash_during_or_after_ambiguous_write_or_timeout',
     'predecessor': 'transport_in_progress', 'successor': 'submission_unknown',
     'provider_request': 'ambiguous', 'lock': 'retain',
     'next_action': 'exact_replay_within_original_expiry_only'},
    {'cut_point': 'response_received_before_durable_record',
     'predecessor': 'transport_in_progress', 'successor': 'submission_unknown',
     'provider_request': 'written', 'lock': 'retain',
     'next_action': 'exact_replay_within_original_expiry_only'},
    {'cut_point': 'response_recorded_before_binding',
     'predecessor': 'response_recorded', 'successor': 'response_recorded',
     'provider_request': 'no_resend', 'lock': 'retain',
     'next_action': 'atomic_binding_from_durable_response'},
    {'cut_point': 'action_id_response', 'predecessor': 'transport_in_progress',
     'successor': 'response_recorded_then_action_bound',
     'provider_request': 'written', 'lock': 'release_after_atomic_binding_only',
     'next_action': 'persist_response_before_binding'},
    {'cut_point': 'synchronous_5xx', 'predecessor': 'transport_in_progress',
     'successor': 'submission_unknown', 'provider_request': 'written',
     'lock': 'retain', 'next_action': 'record_5xx_then_one_exact_replay_only'},
    {'cut_point': 'second_uncertain_outcome', 'predecessor': 'transport_in_progress',
     'successor': 'submission_unknown', 'provider_request': 'no_further_replay',
     'lock': 'retain', 'next_action': 'reconciliation_only'},
    {'cut_point': 'signed_expiry_elapsed', 'predecessor': 'submission_unknown',
     'successor': 'submission_unknown', 'provider_request': 'no_further_replay',
     'lock': 'retain', 'next_action': 'reconciliation_only'},
    {'cut_point': 'duplicate_worker_or_stale_fence', 'predecessor': 'any_nonterminal',
     'successor': 'unchanged', 'provider_request': 'forbidden', 'lock': 'retain',
     'next_action': 'current_fence_owner_only'},
    {'cut_point': 'operator_evidence_close', 'predecessor': 'submission_unknown',
     'successor': 'operator_closed', 'provider_request': 'forbidden',
     'lock': 'release_after_evidence_commit_only', 'next_action': 'audit_terminal'},
)
CRASH_BEFORE_WRITE_CONSISTENCY = {
    'transition_event': 'crash_before_write_without_audited_zero_byte_proof',
    'cut_point': 'crash_before_write_without_zero_byte_proof',
    'predecessor': 'committed_before_write', 'successor': 'submission_unknown',
    'unlock': False, 'retained_lock': True, 'current_fence_required': True,
}


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


def validate_bff_contract(document):
    exact_object(document, ('schema_version', 'authorities', 'mode', 'operations',
                             'recipient_acknowledgements', 'wallet_api_payload_v1',
                             'post_signature_pre_post', 'result_projection',
                             'submission_state_machine', 'staging_r0'), 'bff')
    exact_integer(document['schema_version'], 'bff.schema_version', 1, 1)
    authorities = exact_object(document['authorities'],
                               ('wallet_delivery', 'communication', 'perp', 'auxiliary'),
                               'bff.authorities')
    require_contract(authorities['wallet_delivery'] == 'Privy', 'Privy is wallet/delivery authority')
    require_contract(authorities['communication'] == 'Stream', 'Stream is communication authority')
    require_contract(authorities['perp'] == 'Hyperliquid', 'Hyperliquid is Perp authority')
    auxiliary = exact_object(authorities['auxiliary'],
                             ('address_resolution', 'sanctions_screening'),
                             'bff.authorities.auxiliary')
    for key in ('address_resolution', 'sanctions_screening'):
        item = exact_object(auxiliary[key],
                            ('authority_relationship', 'credential_state', 'enablement'),
                            f'bff.authorities.auxiliary.{key}')
        require_contract(type_strict_equal(item, {
            'authority_relationship': 'subordinate_to_privy_delivery',
            'credential_state': 'not_configured',
            'enablement': 'disabled_fail_closed_until_credentialed_capability_audit',
        }), f'bff.authorities.auxiliary.{key} must remain subordinate and disabled')
    mode = exact_object(document['mode'],
                        ('production_adapter_enabled', 'missing_credentials',
                         'prototype_provider'), 'bff.mode')
    require_contract(type_strict_equal(mode, {
        'production_adapter_enabled': False,
        'missing_credentials': 'fail_closed',
        'prototype_provider': 'Simulated Privy — no network, no signing',
    }), 'production must be disabled and fail closed without credentials')
    operations = document['operations']
    require_contract(type(operations) is list and len(operations) == len(OPERATION_SPECS),
                     'bff.operations must contain six exact operations')
    for actual, expected in zip(operations, OPERATION_SPECS):
        exact_object(actual, ('name', 'http_method', 'path', 'client_request_keys',
                              'forbidden_client_keys', 'response', 'session_binding'),
                     f'bff.operations.{expected[0]}')
        name, method, path, request_keys, response, binding = expected
        require_contract(actual['name'] == name and actual['http_method'] == method and
                         actual['path'] == path and actual['response'] == response and
                         actual['session_binding'] == binding,
                         f'bff operation mismatch: {name}')
        exact_string_list(actual['client_request_keys'], request_keys,
                          f'bff.operations.{name}.client_request_keys')
        exact_string_list(actual['forbidden_client_keys'], CALLER_FORBIDDEN,
                          f'bff.operations.{name}.forbidden_client_keys')
    acknowledgement = exact_object(document['recipient_acknowledgements'],
                                   ('owner', 'binding', 'fields', 'client_cannot_assert',
                                    'reset_on_material_change'),
                                   'bff.recipient_acknowledgements')
    require_contract(type_strict_equal(acknowledgement, {
        'owner': 'bff_preflight_server_session',
        'binding': 'digest_bound_to_owner_wallet_epoch_asset_recipient_and_preflight',
        'fields': ['first_recipient_acknowledged', 'history_unknown_acknowledged'],
        'client_cannot_assert': True,
        'reset_on_material_change': True,
    }), 'F4 acknowledgements must be preflight server-session digest-bound state')
    envelope = exact_object(document['wallet_api_payload_v1'],
                            ('version', 'url_template', 'http_method', 'semantic_method',
                             'signed_header_keys', 'forbidden_signed_header_keys',
                             'body_exact_keys', 'source_exact_keys',
                             'destination_exact_keys', 'amount_type',
                             'same_chain_named_asset_only', 'forbidden_body_keys'),
                            'bff.wallet_api_payload_v1')
    exact_integer(envelope['version'], 'bff.wallet_api_payload_v1.version', 1, 1)
    require_contract(envelope['url_template'] ==
                     'https://api.privy.io/v1/wallets/{wallet_id}/transfer',
                     'exact full Privy URL template required')
    require_contract(envelope['http_method'] == 'POST' and
                     envelope['semantic_method'] == 'transfer',
                     'POST/transfer methods must remain distinct')
    exact_string_list(envelope['signed_header_keys'], SIGNED_HEADERS,
                      'bff.wallet_api_payload_v1.signed_header_keys')
    exact_string_list(envelope['forbidden_signed_header_keys'], FORBIDDEN_SIGNED_HEADERS,
                      'bff.wallet_api_payload_v1.forbidden_signed_header_keys')
    exact_string_list(envelope['body_exact_keys'],
                      ('amount_type', 'source', 'destination', 'nonce'),
                      'bff.wallet_api_payload_v1.body_exact_keys')
    exact_string_list(envelope['source_exact_keys'], ('asset', 'amount', 'chain'),
                      'bff.wallet_api_payload_v1.source_exact_keys')
    exact_string_list(envelope['destination_exact_keys'], ('address',),
                      'bff.wallet_api_payload_v1.destination_exact_keys')
    require_contract(envelope['amount_type'] == 'exact_input' and
                     envelope['same_chain_named_asset_only'] is True,
                     'same-chain named-asset exact_input required')
    exact_string_list(envelope['forbidden_body_keys'],
                      ('destination_chain', 'destination_asset', 'slippage_bps',
                       'fee_configuration', 'custom_token', 'token_address'),
                      'bff.wallet_api_payload_v1.forbidden_body_keys')
    pre_post = exact_object(document['post_signature_pre_post'],
                            ('ordered_steps', 'mismatch_result', 'write_ahead_before_transport'),
                            'bff.post_signature_pre_post')
    exact_string_list(pre_post['ordered_steps'], POST_SIGNATURE_SEQUENCE,
                      'bff.post_signature_pre_post.ordered_steps')
    require_contract(pre_post['mismatch_result'] ==
                     'consume_review_return_f5_require_wholly_new_prepare' and
                     pre_post['write_ahead_before_transport'] is True,
                     'post-signature mismatch/write-ahead semantics required')
    validate_result_projection(document['result_projection'])
    validate_submission_state_machine(document['submission_state_machine'])
    validate_staging(document['staging_r0'], 'bff.staging_r0')


def validate_result_projection(result):
    exact_object(result, ('dto_schema', 'union_kinds', 'wallet_action_statuses',
                          'step_kinds', 'step_statuses', 'unknown_step_projection',
                          'provider_unknown_keys', 'polling', 'webhook'),
                 'bff.result_projection')
    require_contract(type_strict_equal(result['dto_schema'], RESULT_DTO_SCHEMA),
                     'exact WalletActionResult/SubmissionUnknownResult/'
                     'WalletActionSnapshot/WalletActionStep keys and kind discriminator required')
    exact_string_list(result['union_kinds'], ('wallet_action', 'submission_unknown'),
                      'bff.result_projection.union_kinds')
    exact_string_list(result['wallet_action_statuses'],
                      ('pending', 'succeeded', 'rejected', 'failed'),
                      'bff.result_projection.wallet_action_statuses')
    exact_string_list(result['step_kinds'], WALLET_ACTION_STEP_KINDS,
                      'bff.result_projection.step_kinds')
    exact_string_list(result['step_statuses'], WALLET_ACTION_STEP_STATUSES,
                      'bff.result_projection.step_statuses')
    require_contract(type_strict_equal(result['unknown_step_projection'], {
        'kind': 'provider_step', 'status': 'unknown', 'explorer_link': None,
        'may_override_top_level_status': False,
    }), 'unknown provider steps must map safely')
    require_contract(result['provider_unknown_keys'] == 'ignore_without_authority',
                     'provider unknown-key policy required')
    require_contract(type_strict_equal(result['polling'], {
        'transport': 'rest', 'frequency': 'low', 'terminal_stop': True,
        'caller_supplied_action_or_submission_id': False,
    }), 'REST-first terminal-stopping polling required')
    require_contract(type_strict_equal(result['webhook'], {
        'enabled': False, 'enablement': 'enterprise_credentialed_capability_audit_required',
        'verified_binding_required': True,
    }), 'webhook must remain capability-gated')


def validate_submission_state_machine(machine):
    exact_object(machine, ('submission_attempt', 'audit_event', 'states', 'lock_key',
                           'allowed_transitions', 'cut_point_table',
                           'crash_before_write_consistency', 'recovery',
                           'synchronous_5xx', 'invariants'),
                 'bff.submission_state_machine')
    attempt = exact_object(machine['submission_attempt'],
                           ('schema_version', 'exact_keys', 'encrypted_fields',
                            'persistent_proof_fields'),
                           'bff.submission_state_machine.submission_attempt')
    exact_integer(attempt['schema_version'], 'submission_attempt.schema_version', 1, 1)
    exact_string_list(attempt['exact_keys'], ATTEMPT_KEYS, 'submission_attempt.exact_keys')
    exact_string_list(attempt['encrypted_fields'], ('idempotency_key', 'replay_material'),
                      'submission_attempt.encrypted_fields')
    exact_string_list(attempt['persistent_proof_fields'],
                      ('record_version', 'fencing_token', 'exact_replay_count',
                       'synchronous_5xx_record', 'zero_byte_proof',
                       'operator_close_evidence'),
                      'submission_attempt.persistent_proof_fields')
    event = exact_object(machine['audit_event'],
                         ('schema_version', 'exact_keys', 'event_types',
                          'append_only', 'record_version_and_fence_required'),
                         'bff.submission_state_machine.audit_event')
    exact_integer(event['schema_version'], 'audit_event.schema_version', 1, 1)
    exact_string_list(event['exact_keys'], AUDIT_EVENT_KEYS, 'audit_event.exact_keys')
    exact_string_list(event['event_types'], AUDIT_EVENT_TYPES, 'audit_event.event_types')
    require_contract(event['append_only'] is True and
                     event['record_version_and_fence_required'] is True,
                     'audit events must durably bind record version and fence')
    exact_string_list(machine['states'], ATTEMPT_STATES, 'submission_state_machine.states')
    exact_string_list(machine['lock_key'], ('owner_user_id', 'wallet_id'),
                      'submission_state_machine.lock_key')
    require_contract(type(machine['allowed_transitions']) is list and
                     type_strict_equal(machine['allowed_transitions'],
                                       list(ALLOWED_TRANSITIONS)) and
                     all(type(item) is dict and list(item) ==
                         ['from', 'event', 'to', 'unlock', 'requires']
                         for item in machine['allowed_transitions']),
                     'exact predecessor/successor/unlock transition table required')
    require_contract(type(machine['cut_point_table']) is list and
                     type_strict_equal(machine['cut_point_table'],
                                       list(CUT_POINT_TABLE)) and
                     all(type(item) is dict and list(item) ==
                         ['cut_point', 'predecessor', 'successor', 'provider_request',
                          'lock', 'next_action']
                         for item in machine['cut_point_table']),
                     'exact crash/expiry/5xx/response/binding cut-point table required')
    require_contract(type_strict_equal(machine['crash_before_write_consistency'],
                                       CRASH_BEFORE_WRITE_CONSISTENCY),
                     'crash-before-write consistency requires bool-exact retained lock/fence')
    crash_transition = next((item for item in machine['allowed_transitions']
                             if item['event'] ==
                             'crash_before_write_without_audited_zero_byte_proof'), None)
    crash_cut_point = next((item for item in machine['cut_point_table']
                            if item['cut_point'] ==
                            'crash_before_write_without_zero_byte_proof'), None)
    require_contract(type_strict_equal(crash_transition, {
        'from': 'committed_before_write',
        'event': 'crash_before_write_without_audited_zero_byte_proof',
        'to': 'submission_unknown', 'unlock': False,
        'requires': 'durable_unknown_current_cas_lease_fence_and_retained_lock',
    }) and type_strict_equal(crash_cut_point, {
        'cut_point': 'crash_before_write_without_zero_byte_proof',
        'predecessor': 'committed_before_write', 'successor': 'submission_unknown',
        'provider_request': 'ambiguous', 'lock': 'retain',
        'next_action': 'exact_replay_within_original_expiry_only',
    }), 'crash-before-write recovery transition/cut-point must agree and retain lock/fence')
    require_contract(type_strict_equal(machine['recovery'], {
        'startup_scan': True, 'periodic_scan': True, 'cas_lease': True,
        'monotonic_fencing_token': True, 'stale_worker_write_forbidden': True,
        'exact_replay_within_original_signed_expiry_only': True,
    }), 'startup/CAS/fencing recovery required')
    require_contract(type_strict_equal(machine['synchronous_5xx'], {
        'durable_record_before_replay': True, 'max_exact_replays': 1,
        'byte_identical_fields': ['url', 'method', 'signed_headers', 'body',
                                  'authorization_signature', 'idempotency_key'],
        'new_key_review_or_body_forbidden': True,
        'second_uncertain_outcome': 'submission_unknown',
    }), 'synchronous 5xx must record then allow one exact replay')
    exact_string_list(machine['invariants'], (
        'attempt_and_owner_wallet_lock_commit_before_any_transport_byte',
        'only_audited_zero_byte_proof_may_release_as_proved_not_submitted',
        'response_is_durable_before_atomic_action_binding',
        'ambiguous_or_expired_attempt_remains_submission_unknown_and_locked',
        'operator_close_requires_reconciliation_evidence_digest_and_reason',
        'restart_never_creates_new_key_review_body_or_request',
    ), 'submission_state_machine.invariants')


def validate_staging(staging, where):
    exact_object(staging, ('status', 'credentials_configured', 'commands',
                           'required_evidence', 'production_integration_complete'), where)
    require_contract(staging['status'] == 'NOT RUN — CREDENTIALS REQUIRED',
                     f'{where}.status must remain NOT RUN')
    require_contract(staging['credentials_configured'] is False and
                     staging['production_integration_complete'] is False,
                     f'{where} cannot claim configured/complete')
    require_contract(type(staging['commands']) is list and len(staging['commands']) == 6 and
                     all(type(item) is str and 1 <= len(item) <= 240
                         for item in staging['commands']),
                     f'{where}.commands must have six bounded placeholders')
    exact_string_list(staging['required_evidence'], (
        'official_flutter_and_server_formatter_staging_execution',
        'amount_base_units_decimals_independent_oracle',
        'credentialed_alchemy_chainalysis_ens_failure_injection',
        'same_chain_named_asset_action_steps_hash_explorer_reconciliation',
        'uncertain_submit_cut_points_at_most_once',
        'succeeded_only_balance_history_refresh_recalculation',
    ), f'{where}.required_evidence')


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
    ('privy_flutter', '0.10.1', 'pub', None, 'MIT',
     'https://pub.dev/packages/privy_flutter/versions/0.10.1',
     'https://github.com/privy-io/privy-flutter.git',
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
    exact_object(document, ('schema_version', 'status', 'package', 'payload_sha256',
                             'authorization_signature', 'public_verification_material',
                             'credentialed_staging_required',
                             'production_integration_complete'), 'flutter fixture')
    exact_integer(document['schema_version'], 'flutter fixture.schema_version', 1, 1)
    package = exact_object(document['package'],
                           ('name', 'version', 'publisher', 'archive_sha256'),
                           'flutter fixture.package')
    require_contract(type_strict_equal(package, {'name': 'privy_flutter', 'version': '0.10.1',
                                  'publisher': 'privy.io', 'archive_sha256': None},
                     ), 'Flutter package hash must remain pending/null until Task 4 audit')
    require_contract(document['status'] == 'NOT RUN — CREDENTIALS REQUIRED' and
                     document['payload_sha256'] is None and
                     document['authorization_signature'] is None and
                     document['public_verification_material'] is None and
                     document['credentialed_staging_required'] is True and
                     document['production_integration_complete'] is False,
                     'Flutter evidence must be null/NOT RUN and never fabricated')


def validate_provenance(document, wallet_fixture_path):
    exact_object(document, ('schema_version', 'status', 'formatter', 'flutter',
                             'fixture_hashes', 'generation'), 'provenance')
    exact_integer(document['schema_version'], 'provenance.schema_version', 1, 1)
    require_contract(document['status'] == 'PENDING — TASK 4 OFFICIAL FORMATTER AUDIT',
                     'provenance must remain pending until Task 4')
    formatter = exact_object(document['formatter'],
                             ('package', 'version', 'source', 'integrity',
                              'canonical_payload_sha256'), 'provenance.formatter')
    require_contract(type_strict_equal(formatter, {
        'package': '@privy-io/node', 'version': '0.29.0',
        'source': 'https://github.com/privy-io/node-sdk.git',
        'integrity': PACKAGE_SPECS[2][3], 'canonical_payload_sha256': None,
    }), 'formatter canonical hash must remain pending/null until Task 4')
    flutter = exact_object(document['flutter'],
                           ('package', 'version', 'publisher', 'archive_sha256',
                            'signature_status'), 'provenance.flutter')
    require_contract(type_strict_equal(flutter, {
        'package': 'privy_flutter', 'version': '0.10.1', 'publisher': 'privy.io',
        'archive_sha256': None, 'signature_status': 'NOT RUN — CREDENTIALS REQUIRED',
    }), 'Flutter provenance must remain pending/null')
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
        'command': None, 'generated_at': None,
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
        'enablement': 'disabled_fail_closed_until_credentialed_capability_audit',
    } for key in ('address_resolution', 'sanctions_screening')}
    operations = [{
        'name': name, 'http_method': method, 'path': path,
        'client_request_keys': list(request_keys),
        'forbidden_client_keys': list(CALLER_FORBIDDEN), 'response': response,
        'session_binding': binding,
    } for name, method, path, request_keys, response, binding in OPERATION_SPECS]
    staging = {
        'status': 'NOT RUN — CREDENTIALS REQUIRED', 'credentials_configured': False,
        'commands': [f'credentialed-staging-r0-step-{index}' for index in range(1, 7)],
        'required_evidence': [
            'official_flutter_and_server_formatter_staging_execution',
            'amount_base_units_decimals_independent_oracle',
            'credentialed_alchemy_chainalysis_ens_failure_injection',
            'same_chain_named_asset_action_steps_hash_explorer_reconciliation',
            'uncertain_submit_cut_points_at_most_once',
            'succeeded_only_balance_history_refresh_recalculation',
        ], 'production_integration_complete': False,
    }
    bff = {
        'schema_version': 1,
        'authorities': {'wallet_delivery': 'Privy', 'communication': 'Stream',
                        'perp': 'Hyperliquid', 'auxiliary': auxiliary},
        'mode': {'production_adapter_enabled': False, 'missing_credentials': 'fail_closed',
                 'prototype_provider': 'Simulated Privy — no network, no signing'},
        'operations': operations,
        'recipient_acknowledgements': {
            'owner': 'bff_preflight_server_session',
            'binding': 'digest_bound_to_owner_wallet_epoch_asset_recipient_and_preflight',
            'fields': ['first_recipient_acknowledged', 'history_unknown_acknowledged'],
            'client_cannot_assert': True, 'reset_on_material_change': True,
        },
        'wallet_api_payload_v1': {
            'version': 1,
            'url_template': 'https://api.privy.io/v1/wallets/{wallet_id}/transfer',
            'http_method': 'POST', 'semantic_method': 'transfer',
            'signed_header_keys': list(SIGNED_HEADERS),
            'forbidden_signed_header_keys': list(FORBIDDEN_SIGNED_HEADERS),
            'body_exact_keys': ['amount_type', 'source', 'destination', 'nonce'],
            'source_exact_keys': ['asset', 'amount', 'chain'],
            'destination_exact_keys': ['address'], 'amount_type': 'exact_input',
            'same_chain_named_asset_only': True,
            'forbidden_body_keys': ['destination_chain', 'destination_asset',
                                    'slippage_bps', 'fee_configuration',
                                    'custom_token', 'token_address'],
        },
        'post_signature_pre_post': {
            'ordered_steps': list(POST_SIGNATURE_SEQUENCE),
            'mismatch_result': 'consume_review_return_f5_require_wholly_new_prepare',
            'write_ahead_before_transport': True,
        },
        'result_projection': {
            'dto_schema': copy.deepcopy(RESULT_DTO_SCHEMA),
            'union_kinds': ['wallet_action', 'submission_unknown'],
            'wallet_action_statuses': ['pending', 'succeeded', 'rejected', 'failed'],
            'step_kinds': list(WALLET_ACTION_STEP_KINDS),
            'step_statuses': list(WALLET_ACTION_STEP_STATUSES),
            'unknown_step_projection': {'kind': 'provider_step', 'status': 'unknown',
                                        'explorer_link': None,
                                        'may_override_top_level_status': False},
            'provider_unknown_keys': 'ignore_without_authority',
            'polling': {'transport': 'rest', 'frequency': 'low', 'terminal_stop': True,
                        'caller_supplied_action_or_submission_id': False},
            'webhook': {'enabled': False,
                        'enablement': 'enterprise_credentialed_capability_audit_required',
                        'verified_binding_required': True},
        },
        'submission_state_machine': {
            'submission_attempt': {'schema_version': 1, 'exact_keys': list(ATTEMPT_KEYS),
                                   'encrypted_fields': ['idempotency_key', 'replay_material'],
                                   'persistent_proof_fields': ['record_version', 'fencing_token',
                                                               'exact_replay_count',
                                                               'synchronous_5xx_record',
                                                               'zero_byte_proof',
                                                               'operator_close_evidence']},
            'audit_event': {'schema_version': 1, 'exact_keys': list(AUDIT_EVENT_KEYS),
                            'event_types': list(AUDIT_EVENT_TYPES), 'append_only': True,
                            'record_version_and_fence_required': True},
            'states': list(ATTEMPT_STATES), 'lock_key': ['owner_user_id', 'wallet_id'],
            'allowed_transitions': copy.deepcopy(list(ALLOWED_TRANSITIONS)),
            'cut_point_table': copy.deepcopy(list(CUT_POINT_TABLE)),
            'crash_before_write_consistency': copy.deepcopy(CRASH_BEFORE_WRITE_CONSISTENCY),
            'recovery': {'startup_scan': True, 'periodic_scan': True, 'cas_lease': True,
                         'monotonic_fencing_token': True,
                         'stale_worker_write_forbidden': True,
                         'exact_replay_within_original_signed_expiry_only': True},
            'synchronous_5xx': {
                'durable_record_before_replay': True, 'max_exact_replays': 1,
                'byte_identical_fields': ['url', 'method', 'signed_headers', 'body',
                                          'authorization_signature', 'idempotency_key'],
                'new_key_review_or_body_forbidden': True,
                'second_uncertain_outcome': 'submission_unknown'},
            'invariants': [
                'attempt_and_owner_wallet_lock_commit_before_any_transport_byte',
                'only_audited_zero_byte_proof_may_release_as_proved_not_submitted',
                'response_is_durable_before_atomic_action_binding',
                'ambiguous_or_expired_attempt_remains_submission_unknown_and_locked',
                'operator_close_requires_reconciliation_evidence_digest_and_reason',
                'restart_never_creates_new_key_review_body_or_request'],
        }, 'staging_r0': copy.deepcopy(staging),
    }
    dependency = {'schema_version': 1,
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
    payload = {'version': 1,
               'url': 'https://api.privy.io/v1/wallets/wallet_dummy_public_01/transfer',
               'method': 'POST',
               'headers': {'privy-app-id': 'app_dummy_public_01',
                           'privy-idempotency-key': 'idempotency_dummy_public_0001',
                           'privy-request-expiry': '1893456000000'},
               'body': {'amount_type': 'exact_input',
                        'source': {'asset': 'usdc', 'amount': '1.25', 'chain': 'base'},
                        'destination': {'address': '0x1111111111111111111111111111111111111111'},
                        'nonce': 'nonce_dummy_public_000000000001'}}
    flutter = {'schema_version': 1, 'status': 'NOT RUN — CREDENTIALS REQUIRED',
               'package': {'name': 'privy_flutter', 'version': '0.10.1',
                           'publisher': 'privy.io', 'archive_sha256': None},
               'payload_sha256': None, 'authorization_signature': None,
               'public_verification_material': None,
               'credentialed_staging_required': True,
               'production_integration_complete': False}
    provenance = {'schema_version': 1,
                  'status': 'PENDING — TASK 4 OFFICIAL FORMATTER AUDIT',
                  'formatter': {'package': '@privy-io/node', 'version': '0.29.0',
                                'source': 'https://github.com/privy-io/node-sdk.git',
                                'integrity': PACKAGE_SPECS[2][3],
                                'canonical_payload_sha256': None},
                  'flutter': {'package': 'privy_flutter', 'version': '0.10.1',
                              'publisher': 'privy.io', 'archive_sha256': None,
                              'signature_status': 'NOT RUN — CREDENTIALS REQUIRED'},
                  'fixture_hashes': {'wallet_api_payload_json_sha256': None,
                                     'canonical_payload_sha256': None,
                                     'flutter_signature_sha256': None},
                  'generation': {'command': None, 'generated_at': None,
                                 'status': 'PENDING — TASK 4 OFFICIAL FORMATTER AUDIT'}}
    return bff, dependency, payload, flutter, provenance


def rejection_proved(action):
    try:
        action()
    except (ContractViolation, UnicodeError, OSError):
        return True
    return False


def run_malicious_contract_matrix():
    bff, dependency, payload, flutter, provenance = _valid_documents()
    wallet_result = {
        'kind': 'wallet_action',
        'wallet_action': {
            'action_id': 'action_01', 'review_id': 'review_01',
            'wallet_id': 'wallet_01', 'type': 'transfer', 'status': 'pending',
            'source_chain': 'base', 'source_asset': 'usdc',
            'source_amount': '1.25',
            'destination_address': '0x1111111111111111111111111111111111111111',
            'destination_amount': None, 'created_at_ms': 1700000000000,
            'failure': None,
            'steps': [{'kind': 'evm_transaction', 'status': 'pending',
                       'chain_id': 'base', 'transaction_hash': None}],
        },
    }
    unknown_result = {
        'kind': 'submission_unknown', 'submission_record_id': 'submission_01',
        'wallet_id': 'wallet_01', 'created_at_ms': 1700000000000,
        'signed_request_expires_at_ms': 1700000060000,
        'safe_message_code': 'TRANSFER_RECONCILING', 'action_id': None, 'steps': [],
    }
    checks = []
    mutate = lambda value: copy.deepcopy(value)
    with tempfile.TemporaryDirectory(prefix='loop-contract-red-') as directory:
        temp = pathlib.Path(directory)
        contract = temp / 'contract'
        contract.mkdir()
        scratch = contract / 'probe.json'
        def raw_rejected(raw):
            scratch.unlink(missing_ok=True)
            scratch.write_bytes(raw)
            return rejection_proved(lambda: strict_json_load(scratch, contract))
        checks.extend([
            raw_rejected(b'{"outer":{"nested":1,"nested":2}}'),
            raw_rejected(b'\xef\xbb\xbf{"schema_version":1}'),
            raw_rejected(b'\xff{"schema_version":1}'),
            raw_rejected(b'{"schema_version":1}\x00'),
            raw_rejected(b'{"schema_version":1.0}'),
            raw_rejected(b'{"schema_version":NaN}'),
            raw_rejected(b'{"schema_version":Infinity}'),
        ])
        scratch.unlink(missing_ok=True)
        scratch.mkdir()
        checks.append(rejection_proved(lambda: strict_json_load(scratch, contract)))
        scratch.rmdir()
        outside = temp / 'outside.json'
        outside.write_text('{"schema_version":1}', encoding='utf-8')
        checks.append(rejection_proved(lambda: strict_json_load(outside, contract)))
        link = contract / 'link.json'
        link.symlink_to(outside)
        checks.append(rejection_proved(lambda: strict_json_load(link, contract)))
        payload_path = contract / 'payload.json'
        payload_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n',
                                encoding='utf-8')
        provenance['fixture_hashes']['wallet_api_payload_json_sha256'] = digest(payload_path)

        def schema_rejections(document, validator, version_key):
            missing = mutate(document); missing.pop(next(reversed(missing)))
            extra = mutate(document); extra['unknown_schema_key'] = 'forbidden'
            version = mutate(document); version[version_key] = 2
            wrong_type = mutate(document); wrong_type[version_key] = True
            return [rejection_proved(lambda item=item: validator(item))
                    for item in (missing, extra, version, wrong_type)]

        checks.extend(schema_rejections(bff, validate_bff_contract, 'schema_version'))
        checks.extend(schema_rejections(dependency, validate_dependency_lock, 'schema_version'))
        checks.extend(schema_rejections(payload, validate_wallet_payload, 'version'))
        checks.extend(schema_rejections(flutter, validate_flutter_fixture, 'schema_version'))
        checks.extend(schema_rejections(
            provenance, lambda item: validate_provenance(item, payload_path), 'schema_version'))
        bad = mutate(bff); bad['schema_version'] = True
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['schema_version'] = 2
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['unknown'] = 'forbidden'
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['authorities']['wallet_delivery'] = 'LocalWallet'
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['operations'][1]['client_request_keys'].append('wallet_id')
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['recipient_acknowledgements']['binding'] = 'client_boolean'
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['submission_state_machine']['synchronous_5xx']['max_exact_replays'] = 2
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['result_projection']['step_kinds'].pop()
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['result_projection']['step_statuses'].pop(0)
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['result_projection']['dto_schema']['discriminator']['field'] = 'type'
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['result_projection']['dto_schema']['schema_version'] = True
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff)
        bad['result_projection']['dto_schema']['wallet_action_snapshot']['id_bounds'][0] = True
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff)
        bad['result_projection']['dto_schema']['wallet_action_snapshot']['timestamp_bounds'][0] = False
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['result_projection']['unknown_step_projection']['may_override_top_level_status'] = 0
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['result_projection']['polling']['terminal_stop'] = 1
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff)
        bad['result_projection']['polling']['caller_supplied_action_or_submission_id'] = 0
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['result_projection']['webhook']['enabled'] = 0
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['result_projection']['webhook']['verified_binding_required'] = 1
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['submission_state_machine']['recovery']['startup_scan'] = 1
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff)
        bad['submission_state_machine']['recovery']['stale_worker_write_forbidden'] = 1
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff)
        bad['submission_state_machine']['synchronous_5xx']['durable_record_before_replay'] = 1
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['submission_state_machine']['synchronous_5xx']['max_exact_replays'] = True
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['submission_state_machine']['allowed_transitions'][0]['unlock'] = 0
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['submission_state_machine']['allowed_transitions'][1]['unlock'] = 1
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['submission_state_machine']['allowed_transitions'][1]['unlock'] = False
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff)
        bad['submission_state_machine']['crash_before_write_consistency']['retained_lock'] = 0
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff)
        bad['submission_state_machine']['allowed_transitions'][2]['to'] = 'proved_not_submitted'
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['submission_state_machine']['allowed_transitions'].pop()
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['submission_state_machine']['cut_point_table'][6]['lock'] = 'release'
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['staging_r0']['status'] = 'PASSED'
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['staging_r0']['production_integration_complete'] = True
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(bff); bad['mode']['production_adapter_enabled'] = True
        checks.append(rejection_proved(lambda: validate_bff_contract(bad)))
        bad = mutate(payload); bad['wallet_id'] = 'caller-forbidden'
        checks.append(rejection_proved(lambda: validate_wallet_payload(bad)))
        bad = mutate(payload); bad['url'] = 'https://evil.invalid/v1/wallets/wallet_dummy_public_01/transfer'
        checks.append(rejection_proved(lambda: validate_wallet_payload(bad)))
        bad = mutate(payload); bad['method'] = 'GET'
        checks.append(rejection_proved(lambda: validate_wallet_payload(bad)))
        bad = mutate(payload); bad['headers'].pop('privy-request-expiry')
        checks.append(rejection_proved(lambda: validate_wallet_payload(bad)))
        bad = mutate(payload); bad['headers']['authorization'] = 'Basic forbidden'
        checks.append(rejection_proved(lambda: validate_wallet_payload(bad)))
        bad = mutate(payload); bad['body'].pop('nonce')
        checks.append(rejection_proved(lambda: validate_wallet_payload(bad)))
        bad = mutate(payload); bad['body']['destination_chain'] = 'ethereum'
        checks.append(rejection_proved(lambda: validate_wallet_payload(bad)))
        bad = mutate(payload); bad['body']['source']['wallet_id'] = 'caller-forbidden'
        checks.append(rejection_proved(lambda: validate_wallet_payload(bad)))
        bad = mutate(payload); bad['body']['source']['amount'] = '1' * 102
        checks.append(rejection_proved(lambda: validate_wallet_payload(bad)))
        bad = mutate(dependency); bad['installed'] = True
        checks.append(rejection_proved(lambda: validate_dependency_lock(bad)))
        bad = mutate(dependency); bad['packages'][0]['installed'] = True
        checks.append(rejection_proved(lambda: validate_dependency_lock(bad)))
        bad = mutate(dependency); bad['declared_runtime_targets'] = ['production_bff']
        checks.append(rejection_proved(lambda: validate_dependency_lock(bad)))
        for package_index, package in enumerate(dependency['packages']):
            for field in ('name', 'version', 'registry', 'integrity', 'license',
                          'source', 'repository', 'role', 'runtime_target'):
                bad = mutate(dependency)
                bad['packages'][package_index][field] = (
                    'invalid-metadata' if package[field] is not None else 'sha256-fabricated')
                checks.append(rejection_proved(
                    lambda bad=bad: validate_dependency_lock(bad)))
        import_src = temp / 'import-root/src'
        import_src.mkdir(parents=True)
        (import_src / 'bad.js').write_text("import x from 'viem'\n", encoding='utf-8')
        (import_src / '._noise.js').write_bytes(b'\xff\x00AppleDouble')
        checks.append(dependency_import_findings(temp / 'import-root') == ['src/bad.js'])
        decode_src = temp / 'decode-root/src'
        decode_src.mkdir(parents=True)
        (decode_src / 'broken.js').write_bytes(b'\xff')
        decode_findings = dependency_import_findings(temp / 'decode-root')
        checks.append(len(decode_findings) == 1 and
                      decode_findings[0].startswith('unreadable:src/broken.js:'))
        bad = mutate(flutter); bad['authorization_signature'] = 'fabricated'
        checks.append(rejection_proved(lambda: validate_flutter_fixture(bad)))
        bad = mutate(flutter); bad['production_integration_complete'] = True
        checks.append(rejection_proved(lambda: validate_flutter_fixture(bad)))
        bad = mutate(flutter); bad['status'] = 'PASSED'; bad['production_integration_complete'] = True
        checks.append(rejection_proved(lambda: validate_flutter_fixture(bad)))
        bad = mutate(provenance); bad['formatter']['canonical_payload_sha256'] = '0' * 64
        checks.append(rejection_proved(lambda: validate_provenance(bad, payload_path)))
        bad = mutate(unknown_result); bad['action_id'] = 'provider_action_forbidden'
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(unknown_result)
        bad['steps'] = [{'kind': 'provider_step', 'status': 'unknown',
                         'chain_id': 'base', 'transaction_hash': None}]
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(unknown_result); bad['provider_text'] = 'raw provider failure text'
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(unknown_result); bad['safe_message_code'] = 'ACTION_FAILED'
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(unknown_result); bad['created_at_ms'] = True
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(unknown_result); bad['submission_record_id'] = 'x' * 129
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(unknown_result); bad['signed_request_expires_at_ms'] = 1
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(wallet_result); bad['kind'] = 'submission_unknown'
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(wallet_result); bad['wallet_action']['type'] = 'send'
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(wallet_result); bad['wallet_action']['action_id'] = 'x' * 129
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(wallet_result); bad['wallet_action']['steps'] = [
            mutate(wallet_result['wallet_action']['steps'][0]) for _ in range(65)]
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(wallet_result); bad['wallet_action']['steps'][0]['kind'] = 'transaction'
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(wallet_result); bad['wallet_action']['steps'][0]['status'] = 'success'
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(wallet_result); bad['wallet_action']['steps'][0]['chain_id'] = 'x' * 65
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(wallet_result); bad['wallet_action']['steps'][0]['provider_text'] = 'unsafe'
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(wallet_result)
        bad['wallet_action']['steps'][0] = {'kind': 'provider_step', 'status': 'unknown',
                                            'chain_id': 'base',
                                            'transaction_hash': '0x12345678'}
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(wallet_result)
        bad['wallet_action']['failure'] = {'code': 'ACTION_FAILED',
                                           'safe_message': 'Safe LOOP copy',
                                           'provider_text': 'unsafe raw provider text'}
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        bad = mutate(wallet_result)
        bad['wallet_action']['failure'] = {'code': 'ACTION_FAILED',
                                           'safe_message': 'x' * 241}
        checks.append(rejection_proved(lambda: validate_transfer_result_snapshot(bad)))
        validate_bff_contract(bff)
        validate_dependency_lock(dependency)
        validate_wallet_payload(payload)
        validate_flutter_fixture(flutter)
        validate_provenance(provenance, payload_path)
        validate_transfer_result_snapshot(wallet_result)
        validate_transfer_result_snapshot(unknown_result)
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
check(screen_manifest == SCREENS, f'exact pinned 26-screen order: {screen_manifest}')
check(script_manifest == SCRIPTS, f'exact pinned five-script order: {script_manifest}')
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
check('length>22' not in app_source and app_source.count('length>26') == 3,
      'all three navigation/F11 stack bounds use the 26-screen limit')

build_source = (ROOT / 'build.py').read_text()
check('exact pinned 26-screen order' in build_source, 'builder pins 26-screen error text')
check('exact pinned five-script order' in build_source, 'builder pins five-script error text')
build = subprocess.run([sys.executable, 'build.py'], cwd=ROOT, text=True,
                       capture_output=True, check=False)
check(build.returncode == 0 and '26 screens' in build.stdout,
      f'build succeeds at 26 screens: {(build.stderr or build.stdout).strip()}')

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
      "stack=array(item.stack,22,'stack')" not in review_source,
      'wallet-review origin pins the 26-screen stack bound')
review_probe = subprocess.run(['node', '-e', r"""
require(process.argv[1]);
require(process.argv[2]);
const P=globalThis.LoopWalletProvider,R=globalThis.LoopWalletReview;
const live={user_id:'fixture-user-1',wallet_id:'fixture-wallet-1',
  wallet_class:'privy_embedded',endpoint:'/v1/wallets/fixture-wallet-1/actions'};
const voice={state:'idle',open:false,minimized:false,muted:true};
const open=n=>R.createController({adapter:P.createSimulatedAdapter({
  walletClass:'privy_embedded',scenario:'normal'})}).open({
    review_id:'review-transfer',
    origin:{stack:Array.from({length:n},(_,index)=>`scr-level-${index}`),voice},
    live_context:live,trigger_ref:'fixture-trigger',now_ms:100001});
const bounded=[23,24,25,26].map(n=>open(n));
const overflow=open(27);
process.stdout.write(JSON.stringify({
  bounded:bounded.map(result=>result.ok),
  bounded_codes:bounded.map(result=>result.error?.code||null),
  overflow:!overflow.ok&&overflow.error?.code==='INVALID_REQUEST'
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
          'overflow': True,
      },
      'F11 origin accepts legal 23-26 layer stacks and rejects >26: '
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
            page.goto(f'{APP.as_uri()}#{name}')
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
        page.goto(f'{APP.as_uri()}#send-confirm')
        page.wait_for_load_state('networkidle')
        f5_projection = page.evaluate("""() => {
          const projection=sanitizeReviewProjectionForWrite.projection(history.state);
          return {stack:projection.stack,history:history.state.stack};
        }""")
        check(f5_projection == {'stack': CANONICAL_STACKS['send-confirm'],
                                'history': CANONICAL_STACKS['send-confirm']},
              f'F11 accepts the canonical F5 origin projection: {f5_projection}')
        accepted_screens = page.evaluate("""screens => screens.filter(screen => {
          const projection=sanitizeReviewProjectionForWrite.projection({stack:[screen],
            voice:{state:'idle',open:false,minimized:false,muted:false}});
          return projection.stack.length===1&&projection.stack[0]===screen;
        })""", [f'scr-{name}' for name in SCREENS])
        check(accepted_screens == [f'scr-{name}' for name in SCREENS],
              f'F11 projection knows all 26 manifest screens: {accepted_screens}')
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
