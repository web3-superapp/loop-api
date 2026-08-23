#!/usr/bin/env python3
"""Fail-closed contract verifier for the P0 managed app integrations."""
import copy
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTRACT_DIR = ROOT / "contracts/app-integrations-p0"
SERVER_DIR = ROOT / "server/app-integrations-p0"
FILES = (
    "README.md", "contract.json", "dependency-lock.json",
    "fixtures/offline-r0.json", "sources.md",
)
SERVER_FILES = ("adapter.mjs",)
FAILS = []


def check(value, message):
    print(("  ok   " if value else "  FAIL ") + message)
    if not value:
        FAILS.append(message)


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate key: {key}")
        result[key] = value
    return result


def load_json(path):
    return json.loads(path.read_text(), object_pairs_hook=strict_object)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


EXPECTED_PACKAGES = {
    "@supabase/supabase-js": {
        "version": "2.112.3",
        "tag": "v2.112.3",
        "commit": "0dbc66a448ca9efddc971e9dd9b926059748e802",
        "license": "MIT",
        "archive_sha256": "f28b54178a3ab925260562e4089beb8bb3edccee1cea6391ebe20facff0aa211",
        "license_sha256": "334dd6820e2eaeab2064e7c59001b810566728a28a41a7c1dbf69bbee17d0936",
    },
    "@trycourier/courier": {
        "version": "9.1.0",
        "tag": "v9.1.0",
        "commit": "98bc03111db1e45b1a5d4cb8c306d284cbaec060",
        "license": "Apache-2.0",
        "archive_sha256": "fef2eee9bca80ba149dbcecb2b3ef621f51e2df94d2b02e712609c64668d8235",
        "license_sha256": "7575e6dc01d1b7a9ba1435d66074b43c0277e46ef4ad015823118b5b648e834c",
    },
    "courier_flutter": {
        "version": "5.0.3",
        "tag": "v5.0.3",
        "commit": "65559b81504420ef6ab5efe81ce579b054964d3a",
        "license": "MIT",
        "archive_sha256": "d979da01ea5a25754f06024b4fddfbd5a0493248e7ee2fe308928784cbbc6887",
        "license_sha256": "734b9166756f78f153ace4c6a1046f248dd0208fe9679bac8b41a1aae4add8b1",
    },
    "@trigger.dev/sdk": {
        "version": "4.5.12",
        "tag": "v4.5.12",
        "commit": "ce40d0259fead12ac2bad8fc6f8ca574b221228a",
        "license": "MIT",
        "archive_sha256": "cd30d7779a996e35feddb9f9027e8f9085eded0f43ff5ab4d3944e3264646030",
        "license_sha256": "08ba90c393a607a7dc83a3dbf6db16a31617925f27b378cd6f959640c3bfa59f",
    },
}
EXPECTED_TABLES = {
    "profiles": ["privy_did", "alias", "avatar_ref", "updated_at"],
    "privacy_preferences": ["privy_did", "discoverable", "copy_trade_visibility", "updated_at"],
    "watchlists": ["privy_did", "asset_key", "position", "updated_at"],
    "price_alert_definitions": ["alert_id", "privy_did", "asset_key", "condition", "threshold_decimal", "source_allowlist", "expires_at", "updated_at"],
    "notification_preferences": ["privy_did", "event_type", "enabled", "updated_at"],
    "delivery_outbox_refs": ["idempotency_key", "privy_did", "event_type", "provider_delivery_ref", "status", "updated_at"],
}


def validate(contract, lock, fixture):
    errors = []
    def need(condition, message):
        if not condition:
            errors.append(message)

    need(contract.get("schema_version") == "loop.app-integrations-p0/v2", "schema")
    need(contract.get("status") == "R0_CONTRACT_READY_RUNTIME_DISABLED", "status")
    auth = contract.get("authorities", {})
    need(auth.get("identity") == "privy_service", "Privy identity authority")
    need(auth.get("wallet_and_signature") == "privy_service", "Privy wallet/sign authority")
    need(auth.get("chat_and_video") == "stream_service", "Stream authority")
    need(auth.get("perp") == "hyperliquid_service", "Hyperliquid authority")
    need(auth.get("app_records") == "supabase_app_records_only", "Supabase app-record authority")
    need(auth.get("notification_runtime") == "courier_single_runtime_spike", "Courier single runtime")
    need(auth.get("price_alert_scheduler") == "trigger_dev_scheduler_only", "Trigger scheduler")
    need("novu" in contract.get("forbidden_runtime_authorities", []), "Novu forbidden concurrently")
    need(set(contract.get("forbidden_runtime_authorities", [])) >= {
        "supabase_auth", "supabase_wallet_truth", "supabase_provider_truth",
        "courier_auth", "trigger_price_oracle", "novu",
    }, "secondary authorities forbidden")

    runtime = contract.get("runtime", {})
    need(runtime.get("production_enabled") is False, "production disabled")
    need(runtime.get("missing_credentials") == "FAIL_CLOSED_NO_FIXTURE_FALLBACK", "credentials fail closed")
    need(runtime.get("offline_fixture_opt_in") == "LOOP_OFFLINE_APP_INTEGRATIONS_FIXTURE=1", "explicit offline opt-in")
    need(runtime.get("offline_fixture_claim") == "NON_PRODUCTION_NO_NETWORK_NO_PROVIDER_TRUTH_NO_MUTATION", "offline is non-production")
    need(runtime.get("enablement_capability") == "PRIVATE_WEAKSET_BRANDED_ONE_SHOT_CLOSURE_ONLY", "private one-shot enablement")
    need(runtime.get("official_port_bundle") == "PRIVATE_WEAKSET_BRANDED_COMPOSITION_ROOT_ONLY", "private official-port brand")
    need(runtime.get("dependency_method_binding") == "DESCRIPTOR_SAFE_EXACT_FROZEN_BOUND_SNAPSHOT_BEFORE_BRANDING", "stable dependency method snapshot")
    need(runtime.get("magic_string_or_plain_object_enablement") == "FORBIDDEN", "magic/plain enablement forbidden")
    need(runtime.get("capability_replay_or_copy") == "FAIL_CLOSED_AND_FIRST_ATTEMPT_CONSUMES", "capability replay/copy fail closed")
    credentials = runtime.get("required_credential_refs", [])
    need(credentials == ["PRIVY_APP_ID", "PRIVY_VERIFICATION_KEY_REF", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_REF", "COURIER_API_KEY_REF", "TRIGGER_SECRET_KEY_REF"], "credential references exact")

    identity = contract.get("identity_boundary", {})
    need(identity.get("principal") == "server_derived_privy_did", "server DID")
    need(identity.get("client_user_id") == "FORBIDDEN", "client identity forbidden")
    need(identity.get("verification") == "privy_bff_official_verifier_before_side_effect", "Privy verifier first")

    supabase = contract.get("supabase_app_records", {})
    need(supabase.get("auth_api") == "FORBIDDEN", "Supabase Auth forbidden")
    need(supabase.get("service_role_location") == "SERVER_ONLY", "service role server-only")
    allowed = supabase.get("allowed_tables", {})
    need(allowed == EXPECTED_TABLES, "app-record table and column allowlist exact")
    forbidden = set(supabase.get("forbidden_facts", []))
    need(forbidden >= {"wallet_balance", "wallet_transaction", "stream_message", "stream_membership", "hyperliquid_order", "hyperliquid_position", "market_price"}, "provider facts forbidden")
    need(supabase.get("write_preconditions") == ["verified_privy_did", "route_allowlisted", "intent_allowlisted", "idempotency_key"], "write preconditions")
    need(supabase.get("row_validation") == "DESCRIPTOR_SAFE_EXACT_TYPED_INPUT_AND_OUTPUT", "typed row validation")
    need(supabase.get("nested_or_unknown_values") == "FORBIDDEN", "nested/unknown row values forbidden")
    need(supabase.get("read_projection") == "VALIDATE_EVERY_ROW_AND_RETURN_FROZEN_ALLOWLIST_ONLY", "read result projection")
    need(supabase.get("provider_truth_key_at_any_depth") == "FORBIDDEN_BY_EXACT_TYPED_SCHEMA", "deep provider truth forbidden")

    courier = contract.get("courier", {})
    need(courier.get("runtime_selected") == "courier", "Courier selected")
    need(courier.get("parallel_runtime") == "FORBIDDEN", "parallel notification runtime forbidden")
    need(courier.get("client_api_key") == "FORBIDDEN", "Courier API key server only")
    need(courier.get("user_token_issuer") == "verified_privy_did_bff", "Courier token issuer")
    need(courier.get("allowed_events") == ["price_alert_triggered", "provider_activity_projected", "security_notice", "support_update"], "Courier event allowlist")
    need(courier.get("delivery_idempotency") == "SERVER_SHA256_EVENT_TYPE_PRIVY_DID_SOURCE_EVENT_ID", "server-derived Courier idempotency")
    need(courier.get("caller_idempotency_override") == "FORBIDDEN", "caller Courier key forbidden")
    need(courier.get("event_schema") == "EXACT_TYPE_SOURCE_EVENT_ID_DESTINATION_ROUTE_TYPED_PAYLOAD", "typed Courier envelope")
    need(courier.get("caller_routing_template_channel_or_extra") == "FORBIDDEN", "Courier routing/extra forbidden")
    need(courier.get("destination_route_allowlist_by_event_type") == {
        "price_alert_triggered": ["asset", "notifications", "perp", "token"],
        "provider_activity_projected": ["chat", "group", "notifications", "perp", "wallet"],
        "security_notice": ["notifications", "security"],
        "support_update": ["notifications"],
    }, "Courier route allowlist exact")

    trigger = contract.get("trigger_price_alerts", {})
    need(trigger.get("role") == "SCHEDULE_RETRY_IDEMPOTENCY_ONLY", "Trigger role")
    need(trigger.get("may_create_or_mutate_market_fact") is False, "scheduler cannot mutate facts")
    need(trigger.get("verified_fact_required") is True, "verified fact required")
    need(trigger.get("stale_or_unknown_fact") == "FAIL_CLOSED", "stale fact rejected")
    need(trigger.get("numeric_format") == "CANONICAL_DECIMAL_STRING_NO_FLOAT", "no float comparison")
    need(trigger.get("max_fact_age_seconds") == 300, "fact freshness bound")
    need(trigger.get("production_clock") == "PRIVATE_BRANDED_MONOTONIC_SERVER_CLOCK_PORT", "private production clock")
    need(trigger.get("caller_clock") == "FORBIDDEN_IGNORED_EVEN_AS_EXTRA_ARGUMENT", "caller clock forbidden")
    need(trigger.get("test_clock") == "PRIVATE_WEAKSET_BRANDED_TEST_FACTORY_ONLY", "private branded test clock")
    need(trigger.get("clock_rollback_or_non_finite") == "FAIL_CLOSED", "clock rollback/non-finite denied")
    need(trigger.get("alert_expiry") == "REQUIRED_AND_CHECKED_AGAINST_AUTHORITATIVE_CLOCK", "alert expiry required")

    policy = contract.get("request_policy", {})
    need(policy.get("routes") == ["asset", "chat", "group", "market", "notifications", "perp", "privacy", "profile", "security", "token", "wallet"], "route allowlist exact")
    need(policy.get("intents") == ["app_record_read", "app_record_write", "courier_issue_user_token", "notification_deliver", "price_alert_evaluate"], "intent allowlist exact")
    need(policy.get("arbitrary_url") == "FORBIDDEN", "arbitrary URL forbidden")
    need(policy.get("idempotency") == "CALLER_KEY_ONLY_FOR_APP_RECORD_WRITE;COURIER_AND_TRIGGER_SERVER_DERIVED", "idempotency ownership exact")

    packages = {item.get("name"): item for item in lock.get("packages", [])}
    need(set(packages) == set(EXPECTED_PACKAGES), "locked package set exact")
    for name, expected in EXPECTED_PACKAGES.items():
        actual = packages.get(name, {})
        for field, value in expected.items():
            need(actual.get(field) == value, f"{name} {field} exact")
        need(actual.get("installed") is False, f"{name} not installed")
        need(actual.get("runtime_enablement") == "CREDENTIAL_AND_TRANSITIVE_LOCK_AUDIT_REQUIRED", f"{name} gated")
        source = actual.get("source", "")
        need(source.startswith("https://") and "latest" not in source and "main" not in source, f"{name} immutable source")
    trigger_pkg = packages.get("@trigger.dev/sdk", {})
    need(trigger_pkg.get("repository_license_scope") == "Apache-2.0_ROOT_PLATFORM_REPO_PACKAGE_ARCHIVE_IS_MIT", "Trigger mixed license scope")
    courier_pkg = packages.get("@trycourier/courier", {})
    need(courier_pkg.get("bundled_license_notices") == [{"path": "package/src/internal/qs/LICENSE.md", "license": "BSD-3-Clause", "sha256": "d8c77eaffed7f1f874b97f66ee47a557ae24fd59bae8ae14f9b1b84f26a94d2f"}], "Courier bundled license notice")

    need(fixture.get("mode") == "EXPLICIT_OFFLINE_R0", "fixture mode")
    need(fixture.get("production") is False, "fixture non-production")
    need(fixture.get("network") == "FORBIDDEN", "fixture no network")
    need(fixture.get("mutations") == "FORBIDDEN", "fixture no mutations")
    need(fixture.get("provider_truth") == "FORBIDDEN", "fixture no provider truth")
    return errors


def set_path(value, path, replacement):
    target = value
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = replacement


def source_inventory(root):
    entries = []
    for path in root.rglob("*"):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            kind = "symlink"
        elif path.is_file() and path.name.startswith("._"):
            continue
        elif path.is_dir():
            kind = "directory"
        elif path.is_file():
            kind = "file"
        else:
            kind = "other"
        entries.append(f"{kind}:{relative}")
    return sorted(entries)


required = [CONTRACT_DIR / item for item in FILES] + [SERVER_DIR / item for item in SERVER_FILES]
check(all(path.is_file() for path in required), "required P0 integration files exist")
expected_contract_inventory = sorted([f"file:{item}" for item in FILES] + ["directory:fixtures"])
expected_server_inventory = [f"file:{item}" for item in SERVER_FILES]
check(CONTRACT_DIR.is_dir() and source_inventory(CONTRACT_DIR) == expected_contract_inventory, "contract source inventory exact")
check(SERVER_DIR.is_dir() and source_inventory(SERVER_DIR) == expected_server_inventory, "server source inventory exact")

if all(path.is_file() for path in required):
    try:
        contract = load_json(CONTRACT_DIR / "contract.json")
        lock = load_json(CONTRACT_DIR / "dependency-lock.json")
        fixture = load_json(CONTRACT_DIR / "fixtures/offline-r0.json")
    except Exception as error:
        check(False, f"strict JSON loads: {error}")
    else:
        errors = validate(contract, lock, fixture)
        check(not errors, "contract, lock and fixture satisfy authority boundary" + (f": {errors}" if errors else ""))

        cases = [
            ("second auth", "contract", ["forbidden_runtime_authorities"], ["novu"]),
            ("Supabase Auth", "contract", ["supabase_app_records", "auth_api"], "ENABLED"),
            ("provider truth table", "contract", ["supabase_app_records", "allowed_tables"], {"wallet_balances": ["did", "balance"]}),
            ("client service role", "contract", ["supabase_app_records", "service_role_location"], "CLIENT"),
            ("client identity", "contract", ["identity_boundary", "client_user_id"], "ALLOWED"),
            ("verifier after write", "contract", ["identity_boundary", "verification"], "after_side_effect"),
            ("dual notification runtime", "contract", ["courier", "parallel_runtime"], "novu"),
            ("Novu selection", "contract", ["courier", "runtime_selected"], "novu"),
            ("client Courier key", "contract", ["courier", "client_api_key"], "PUBLIC"),
            ("unverified Courier subject", "contract", ["courier", "user_token_issuer"], "client_user_id"),
            ("arbitrary Courier event", "contract", ["courier", "allowed_events"], ["any"]),
            ("scheduler oracle", "contract", ["trigger_price_alerts", "role"], "PRICE_AUTHORITY"),
            ("scheduler mutates fact", "contract", ["trigger_price_alerts", "may_create_or_mutate_market_fact"], True),
            ("unverified price", "contract", ["trigger_price_alerts", "verified_fact_required"], False),
            ("stale price accepted", "contract", ["trigger_price_alerts", "stale_or_unknown_fact"], "ACCEPT"),
            ("float price", "contract", ["trigger_price_alerts", "numeric_format"], "FLOAT"),
            ("unbounded fact age", "contract", ["trigger_price_alerts", "max_fact_age_seconds"], 86400),
            ("arbitrary route", "contract", ["request_policy", "routes"], ["https://evil.test"]),
            ("arbitrary intent", "contract", ["request_policy", "intents"], ["sign_transaction"]),
            ("missing idempotency", "contract", ["request_policy", "idempotency"], "OPTIONAL"),
            ("production enabled without credentials", "contract", ["runtime", "production_enabled"], True),
            ("fixture fallback", "contract", ["runtime", "missing_credentials"], "USE_FIXTURE"),
            ("implicit offline", "contract", ["runtime", "offline_fixture_opt_in"], "AUTO"),
            ("fixture claims production", "fixture", ["production"], True),
            ("fixture network", "fixture", ["network"], "ALLOWED"),
            ("fixture mutation", "fixture", ["mutations"], "ALLOWED"),
            ("fixture provider truth", "fixture", ["provider_truth"], "ALLOWED"),
        ]
        for label, which, path, replacement in cases:
            values = {"contract": copy.deepcopy(contract), "lock": copy.deepcopy(lock), "fixture": copy.deepcopy(fixture)}
            set_path(values[which], path, replacement)
            check(bool(validate(values["contract"], values["lock"], values["fixture"])), f"mutation rejects {label}")

        v2_cases = [
            ("copyable enablement", ["runtime", "enablement_capability"], "PUBLIC_STRING"),
            ("unbranded official ports", ["runtime", "official_port_bundle"], "CALLER_FUNCTIONS"),
            ("mutable dependency implementation", ["runtime", "dependency_method_binding"], "DYNAMIC_PROPERTY_LOOKUP"),
            ("magic enablement", ["runtime", "magic_string_or_plain_object_enablement"], "ALLOWED"),
            ("capability replay", ["runtime", "capability_replay_or_copy"], "REUSABLE"),
            ("column-only rows", ["supabase_app_records", "row_validation"], "TOP_LEVEL_COLUMNS_ONLY"),
            ("nested row values", ["supabase_app_records", "nested_or_unknown_values"], "ALLOWED"),
            ("raw select result", ["supabase_app_records", "read_projection"], "RAW_SDK_RESULT"),
            ("deep provider truth", ["supabase_app_records", "provider_truth_key_at_any_depth"], "ALLOWED"),
            ("caller Courier key", ["courier", "caller_idempotency_override"], "ALLOWED"),
            ("loose Courier event", ["courier", "event_schema"], "TYPE_ONLY"),
            ("caller Courier routing", ["courier", "caller_routing_template_channel_or_extra"], "ALLOWED"),
            ("Courier arbitrary route", ["courier", "destination_route_allowlist_by_event_type"], {"security_notice": ["https://evil.test"]}),
            ("caller production clock", ["trigger_price_alerts", "production_clock"], "CALLER_ARGUMENT"),
            ("caller clock accepted", ["trigger_price_alerts", "caller_clock"], "ALLOWED"),
            ("public test clock", ["trigger_price_alerts", "test_clock"], "PUBLIC_FACTORY"),
            ("clock rollback accepted", ["trigger_price_alerts", "clock_rollback_or_non_finite"], "ACCEPT"),
            ("alert expiry optional", ["trigger_price_alerts", "alert_expiry"], "OPTIONAL"),
        ]
        for label, path, replacement in v2_cases:
            changed = copy.deepcopy(contract)
            set_path(changed, path, replacement)
            check(bool(validate(changed, lock, fixture)), f"v2 mutation rejects {label}")

        for name, expected in EXPECTED_PACKAGES.items():
            for field, bad in (("version", "latest"), ("tag", "main"), ("commit", "HEAD"), ("license", "UNKNOWN"), ("archive_sha256", "0" * 64), ("license_sha256", "0" * 64), ("installed", True), ("runtime_enablement", "READY")):
                changed = copy.deepcopy(lock)
                item = next(item for item in changed["packages"] if item["name"] == name)
                item[field] = bad
                check(bool(validate(contract, changed, fixture)), f"mutation rejects {name} {field} drift")
        changed = copy.deepcopy(lock)
        next(item for item in changed["packages"] if item["name"] == "@trycourier/courier")["bundled_license_notices"] = []
        check(bool(validate(contract, changed, fixture)), "mutation rejects Courier bundled-license removal")

        source = (SERVER_DIR / "adapter.mjs").read_text()
        forbidden = ["parseFloat(", "Number(", "@supabase/auth", "novu", "signTransaction", "sendMessage(", "placeOrder("]
        for token in forbidden:
            check(token not in source, f"adapter forbids {token}")
        check("Object.freeze" in source and "createProductionAdapters" in source and "createOfflineFixtureAdapters" in source, "adapter exposes frozen production/offline factories")
        check("RUNTIME_ENABLED_AFTER_CREDENTIALED_GATES" not in source and "productionCapabilities = new WeakSet" in source and "consumedProductionCapabilities = new WeakSet" in source, "adapter has private one-shot production capability without magic string")
        check("snapshotPortBundle" in source and "snapshotClock" in source and ".bind(ports)" in source and ".bind(clock)" in source, "adapter freezes bound dependency method snapshots before branding")
        check("Object.getOwnPropertyDescriptors" in source and "utilTypes.isProxy" in source and "projectRows" in source, "adapter validates descriptor-safe typed input/output rows")
        check("SERVER_SHA256_EVENT_TYPE_PRIVY_DID_SOURCE_EVENT_ID" in (CONTRACT_DIR / "contract.json").read_text() and "hashMaterial([event.type, did, event.source_event_id])" in source, "Courier key is canonical server-derived material")
        check("async function evaluatePriceAlert(principal, requestValue, alertValue, fact)" in source and "PRIVATE_BRANDED_MONOTONIC_SERVER_CLOCK_PORT" in (CONTRACT_DIR / "contract.json").read_text(), "price alert has no public clock parameter")
        whitespace_guard = "if (credential.trim().length === 0) fail(code);"
        if source.count(whitespace_guard) == 1:
            mutated_source = source.replace(whitespace_guard, "if (false) fail(code);")
            with tempfile.NamedTemporaryFile(mode="w", suffix=".mjs", dir=ROOT / "_tmp", delete=False) as handle:
                handle.write(mutated_source)
                mutated_path = pathlib.Path(handle.name)
            try:
                mutated_runtime = subprocess.run(["node", str(mutated_path), "--self-test"], cwd=ROOT, text=True, capture_output=True, check=False)
                check(mutated_runtime.returncode != 0 and "SELF_TEST_CREDENTIAL_WHITESPACE" in mutated_runtime.stderr, "v3 mutation rejects removed credential whitespace guard")
            finally:
                mutated_path.unlink(missing_ok=True)
        else:
            check(False, "v3 credential whitespace guard is exact and mutation-addressable")
        runtime = subprocess.run(["node", str(ROOT / "_tmp/verify_app_integrations_p0_v2_runtime.mjs")], cwd=ROOT, text=True, capture_output=True, check=False)
        runtime_diagnostics = {"exit": runtime.returncode, "stdout": runtime.stdout, "stderr": runtime.stderr}
        check(runtime.returncode == 0 and runtime.stdout.strip() == "PASS app-integrations-p0 v3 black-box runtime", "adapter v3 black-box runtime" + ("" if runtime.returncode == 0 else f": {json.dumps(runtime_diagnostics, ensure_ascii=False)}"))

        if os.environ.get("LOOP_P0_UNICODE_PATH_CHILD") != "1":
            with tempfile.TemporaryDirectory(prefix="LOOP P0 Unicode 中文 空格 ", dir=ROOT / "_tmp") as holder:
                unicode_root = pathlib.Path(holder) / "fresh copy 中文 path"
                unicode_files = required + [
                    ROOT / "_tmp/verify_app_integrations_p0.py",
                    ROOT / "_tmp/verify_app_integrations_p0_v2_runtime.mjs",
                ]
                for source_path in unicode_files:
                    target_path = unicode_root / source_path.relative_to(ROOT)
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source_path, target_path)
                appledouble_execution_sentinel = "APPLEDOUBLE_SIDECAR_MUST_NOT_BE_READ_OR_EXECUTED"
                (unicode_root / "server/app-integrations-p0/._adapter.mjs").write_text(f'throw new Error("{appledouble_execution_sentinel}");')
                (unicode_root / "contracts/app-integrations-p0/._contract.json").write_text(f'not-json:{appledouble_execution_sentinel}')
                (unicode_root / "contracts/app-integrations-p0/fixtures/._offline-r0.json").write_text(f'not-json:{appledouble_execution_sentinel}')
                child_env = os.environ.copy()
                child_env["LOOP_P0_UNICODE_PATH_CHILD"] = "1"
                unicode_commands = [
                    ["node", str(unicode_root / "server/app-integrations-p0/adapter.mjs"), "--self-test"],
                    ["node", str(unicode_root / "_tmp/verify_app_integrations_p0_v2_runtime.mjs")],
                    [sys.executable, str(unicode_root / "_tmp/verify_app_integrations_p0.py")],
                ]
                unicode_results = [subprocess.run(command, cwd=unicode_root, env=child_env, text=True, capture_output=True, check=False) for command in unicode_commands]
                unicode_expected = [
                    "PASS app-integrations-p0 v3 adapter self-test: typed_rows courier_idempotency authoritative_clock one_shot_capability credential_whitespace",
                    "PASS app-integrations-p0 v3 black-box runtime",
                    "PASS: P0 app integrations v3 contract (4 immutable packages; 60 legacy + 19 v2/v3 contract and source mutations; runtime attack matrix)",
                ]
                unicode_ok = all(
                    result.returncode == 0
                    and expected in result.stdout
                    and appledouble_execution_sentinel not in result.stdout
                    and appledouble_execution_sentinel not in result.stderr
                    for result, expected in zip(unicode_results, unicode_expected)
                )

                mutated_root = pathlib.Path(holder) / "mutated copy 中文 path"
                shutil.copytree(unicode_root, mutated_root)
                mutated_adapter = mutated_root / "server/app-integrations-p0/adapter.mjs"
                mutated_source = mutated_adapter.read_text()
                if mutated_source.count(whitespace_guard) == 1:
                    mutated_adapter.write_text(mutated_source.replace(whitespace_guard, "if (false) fail(code);"))
                mutated_adapter_result = subprocess.run(["node", str(mutated_adapter), "--self-test"], cwd=mutated_root, env=child_env, text=True, capture_output=True, check=False)
                mutated_wrapper_result = subprocess.run(["node", str(mutated_root / "_tmp/verify_app_integrations_p0_v2_runtime.mjs")], cwd=mutated_root, env=child_env, text=True, capture_output=True, check=False)
                mutated_ok = (
                    mutated_adapter_result.returncode != 0
                    and "SELF_TEST_CREDENTIAL_WHITESPACE" in mutated_adapter_result.stderr
                    and mutated_wrapper_result.returncode != 0
                    and "exit=1" in mutated_wrapper_result.stderr
                    and "signal=null" in mutated_wrapper_result.stderr
                    and "SELF_TEST_CREDENTIAL_WHITESPACE" in mutated_wrapper_result.stderr
                )

                inventory_mutations = []
                inventory_cases = [
                    ("evil source file", "server/app-integrations-p0/evil.mjs", False, "server source inventory exact"),
                    ("non-AppleDouble hidden file", "server/app-integrations-p0/.hidden.mjs", False, "server source inventory exact"),
                    ("unknown normal file", "contracts/app-integrations-p0/notes.txt", False, "contract source inventory exact"),
                    ("unknown directory", "server/app-integrations-p0/unknown-directory", True, "server source inventory exact"),
                    ("AppleDouble-looking directory", "server/app-integrations-p0/._unknown-directory", True, "server source inventory exact"),
                ]
                for label, relative, is_directory, expected_failure in inventory_cases:
                    inventory_root = pathlib.Path(holder) / f"inventory mutation {label} 中文 path"
                    shutil.copytree(unicode_root, inventory_root)
                    mutation_path = inventory_root / relative
                    if is_directory:
                        mutation_path.mkdir(parents=True)
                    else:
                        mutation_path.parent.mkdir(parents=True, exist_ok=True)
                        mutation_path.write_text("ordinary unknown source must fail closed")
                    inventory_result = subprocess.run(
                        [sys.executable, str(inventory_root / "_tmp/verify_app_integrations_p0.py")],
                        cwd=inventory_root,
                        env=child_env,
                        text=True,
                        capture_output=True,
                        check=False,
                    )
                    inventory_mutations.append((
                        label,
                        inventory_result.returncode != 0
                        and expected_failure in inventory_result.stdout
                        and appledouble_execution_sentinel not in inventory_result.stdout
                        and appledouble_execution_sentinel not in inventory_result.stderr,
                        {"exit": inventory_result.returncode, "stdout": inventory_result.stdout, "stderr": inventory_result.stderr},
                    ))
                inventory_ok = all(item[1] for item in inventory_mutations)
                unicode_diagnostics = {
                    "unicode": [{"exit": item.returncode, "stdout": item.stdout, "stderr": item.stderr} for item in unicode_results],
                    "mutated_adapter": {"exit": mutated_adapter_result.returncode, "stdout": mutated_adapter_result.stdout, "stderr": mutated_adapter_result.stderr},
                    "mutated_wrapper": {"exit": mutated_wrapper_result.returncode, "stdout": mutated_wrapper_result.stdout, "stderr": mutated_wrapper_result.stderr},
                    "inventory_mutations": [{"label": label, **diagnostics} for label, _, diagnostics in inventory_mutations],
                }
                check(unicode_ok and mutated_ok and inventory_ok, "v5 Unicode+space AppleDouble-safe copied-path self-test, black-box, 79 mutations, same-path mutant and 5 strict inventory mutations" + ("" if unicode_ok and mutated_ok and inventory_ok else f": {json.dumps(unicode_diagnostics, ensure_ascii=False)}"))

if FAILS:
    print(f"FAIL: {len(FAILS)} P0 integration checks failed")
    raise SystemExit(1)
print(f"PASS: P0 app integrations v3 contract ({len(EXPECTED_PACKAGES)} immutable packages; 60 legacy + 19 v2/v3 contract and source mutations; runtime attack matrix)")
