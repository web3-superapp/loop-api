#!/usr/bin/env python3
"""Strict, dependency-free v6 verifier for the LOOP A-I whole-app reuse catalog."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile
from collections import Counter
from pathlib import Path
from pathlib import PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "contracts" / "integration-catalog"
PROVENANCE_ARCHIVE = ROOT / "_tmp" / "integration-catalog-provenance" / "hyperliquid_python_sdk-0.24.0.tar.gz"
STREAM_LEGAL_SOURCE = "https://getstream.io/legal/"
EXPECTED_TREE = {
    "README.md",
    "catalog.json",
    "custom-code-budget.json",
    "implementation-slices.json",
    "offline-fixtures.json",
    "provider-lock.json",
    "screen-inventory.json",
    "sources.md",
}
EXPECTED_IDS = {
    "A": [f"A{i}" for i in range(1, 13)],
    "B": [f"B{i}" for i in range(1, 10)],
    "C": ["C1", "C2", "C3", "C5", "C6", "C7", "C9", "C10", "C11"],
    "D": [f"D{i}" for i in range(1, 13)],
    "E": ["E1", "E2", "E3", "E4", "E5", "E7", "E8", "E9", "E10", "E11", "E12", "E13", "E14"],
    "F": [f"F{i}" for i in range(1, 21)],
    "G": [f"G{i}" for i in range(1, 5)],
    "H": [f"H{i}" for i in range(1, 17)],
    "I": [f"I{i}" for i in range(1, 9)],
}
EXPECTED_MODULE_COUNTS = {"A": 12, "B": 9, "C": 9, "D": 12, "E": 13, "F": 20, "G": 4, "H": 16, "I": 8}
EXPECTED_PRIORITY_COUNTS = {"A": 47, "B": 46, "C": 10}
CORE_AUTHORITY = {"wallet": "privy_service", "communication": "stream_service", "perp": "hyperliquid_service"}
EXPECTED_SLICE_IDS = {
    "platform_foundation",
    "privy_identity_wallet",
    "stream_communication",
    "hyperliquid_core_perp",
    "market_data_charts",
    "risk_preview_compliance",
    "notifications_observability",
    "privy_funds",
    "dashboard_search",
    "moonpay_onramp",
    "dapp_browser_isolation",
    "approval_revoke",
    "hosted_support",
    "phase2_hold",
}
# Set only after the v2 canonical inventory + mapping decision is encoded. The digest
# covers each exact id/module/priority/name/surface/route/state/profile/owner row.
CANONICAL_BINDING_SHA256 = "564e2b53b4632d5d877bde1a745b055b81878aeb768788842ecd4e22aa11dc14"
CANONICAL_PROVIDER_SHA256 = "c375c78f57215de1e40f8077ddb5f1c972d1e4d31e12093ee6f39ab416774cb0"
CANONICAL_PROFILE_SHA256 = "073c5ff0bdac3ee9443d2e25777cad3b0279e8ed2addf24a9c526f331900868a"
CANONICAL_CANDIDATE_SHA256 = "b3b99bfa6a1439b1b49db5c8097b5025f14f4917f5cf87bea24646ca0a4d5f6c"
CANONICAL_COMPONENT_SHA256 = "1ee233515d6da8f229b8e9880c5bccb112d14913ce62877d66c449bf50f7e123"
CANONICAL_SELECTION_GATE_SHA256 = "7026abbf4b76fc04f9a88a6001d35dc8f34eb1240f7aeefbf9befd68b9a23886"
EXPECTED_PROVIDER_IDS = {
    "privy_service", "stream_service", "hyperliquid_service", "alchemy_service", "privy_preview_service",
    "blockaid_service", "goplus_service", "chainalysis_service", "coingecko_service", "dexscreener_service",
    "geckoterminal_service", "birdeye_service", "nansen_service", "moonpay_service", "firebase_service",
    "sentry_service", "posthog_service", "phase2_disabled", "product_spec_authority",
    "whole_app_core_selection_pending", "tradingview_advanced_pending", "privy_flutter_package",
    "privy_node_runtime_pin", "privy_node_upgrade_candidate", "reown_appkit_package", "stream_chat_package",
    "stream_video_package", "hyperliquid_ts_runtime_pin", "hyperliquid_ts_upgrade_candidate",
    "hyperliquid_python_package", "lightweight_charts_package", "firebase_messaging_package",
    "sentry_flutter_package", "posthog_flutter_package", "go_router_package", "riverpod_package", "dio_package",
    "connectivity_package", "permission_handler_package", "local_auth_package", "mobile_scanner_package",
    "package_info_package", "url_launcher_package", "inappwebview_package", "flutter_web3_webview_package",
    "qrcode_generator_package",
}
EXPECTED_PROFILE_IDS = {
    "app_shell", "onboarding_static", "privy_auth", "external_wallet", "privy_wallet", "profile_local",
    "notifications", "dashboard", "federated_search", "pay_scan", "pay_receive", "privy_transfer",
    "privy_swap_bridge", "unified_intent_review_composition", "onramp", "security_facts", "market_data",
    "lightweight_chart", "advanced_chart", "watchlist", "perp_market_readonly", "perp_trading_mutations",
    "stream_chat", "stream_audio", "stream_cards", "phase2_placeholder", "dapp_browser", "approvals",
    "about_legal", "support", "regional_gate", "permissions",
}
EXPECTED_SELECTION_GATE_IDS = {
    "social_profile_store", "relationship_graph", "watchlist_store", "notification_inbox",
    "price_alert_scheduler", "provider_event_ingestion", "activity_feed", "federated_search_indexing",
    "hosted_support",
}
EXPECTED_CANDIDATE_IDS = {
    "supabase_app_data_candidate", "novu_notification_candidate", "courier_notification_candidate",
    "trigger_dev_scheduler_candidate", "hookdeck_event_gateway_candidate", "meilisearch_index_candidate",
    "chatwoot_support_candidate", "stream_feeds_candidate",
}
EXPECTED_COMPONENT_IDS = {"chatwoot_flutter_component_candidate"}
EXPECTED_GATE_CANDIDATES = {
    "social_profile_store": ["supabase_app_data_candidate"],
    "relationship_graph": ["stream_feeds_candidate"],
    "watchlist_store": ["supabase_app_data_candidate"],
    "notification_inbox": ["novu_notification_candidate", "courier_notification_candidate"],
    "price_alert_scheduler": ["trigger_dev_scheduler_candidate"],
    "provider_event_ingestion": ["hookdeck_event_gateway_candidate"],
    "activity_feed": ["stream_feeds_candidate"],
    "federated_search_indexing": ["meilisearch_index_candidate"],
    "hosted_support": ["chatwoot_support_candidate"],
}
EXPECTED_SLICE_CANDIDATES = {
    "platform_foundation": ["supabase_app_data_candidate"],
    "risk_preview_compliance": [],
    "privy_identity_wallet": [],
    "stream_communication": ["stream_feeds_candidate"],
    "market_data_charts": [],
    "notifications_observability": [
        "novu_notification_candidate", "courier_notification_candidate",
        "trigger_dev_scheduler_candidate", "hookdeck_event_gateway_candidate",
    ],
    "hosted_support": ["chatwoot_support_candidate"],
    "hyperliquid_core_perp": [],
    "privy_funds": [],
    "moonpay_onramp": [],
    "dapp_browser_isolation": [],
    "approval_revoke": [],
    "dashboard_search": ["stream_feeds_candidate", "meilisearch_index_candidate"],
    "phase2_hold": [],
}
ALLOWED_CUSTOM = {"ui", "orchestration", "state_projection", "policy_mapping", "thin_adapter", "copy"}
ALLOWED_CREDENTIALS = {
    "none_public",
    "public_app_config",
    "server_secret",
    "user_authorization",
    "provider_account",
    "provider_account_kyb",
    "device_permission",
    "legal_compliance",
    "phase2_disabled",
}
FORBIDDEN_TERMS = {
    "custom_wallet",
    "custom_signer",
    "custom_key_store",
    "custom_swap_router",
    "custom_bridge_router",
    "custom_im_transport",
    "custom_rtc_media",
    "custom_sfu",
    "custom_matching_engine",
    "custom_perp_ledger",
    "custom_market_data",
    "custom_indexer",
    "custom_rpc_node",
    "custom_chart_engine",
    "custom_push_transport",
    "custom_crash_ingestion",
    "custom_analytics_backend",
    "custom_kyc",
    "custom_aml_dataset",
    "custom_transaction_simulator",
    "custom_profile_store",
    "custom_social_graph",
    "custom_relationship_graph",
    "custom_watchlist_store",
    "custom_notification_inbox",
    "custom_price_alert_scheduler",
    "custom_activity_feed",
    "custom_search_index",
    "custom_event_bus",
    "custom_job_scheduler",
    "custom_authorization_core",
    "custom_support_backend",
}


class Violation(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Violation(message)


def no_duplicate_object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Violation(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path: Path):
    resolved = path.resolve(strict=True)
    require(resolved.is_relative_to(CONTRACT.resolve(strict=True)), f"path escapes contract: {path}")
    mode = path.lstat().st_mode
    require(stat.S_ISREG(mode) and not stat.S_ISLNK(mode), f"not a regular non-symlink file: {path}")
    raw = path.read_bytes()
    require(0 < len(raw) <= 2_000_000, f"invalid JSON byte size: {path}")
    require(not raw.startswith(b"\xef\xbb\xbf") and b"\x00" not in raw, f"unsafe JSON encoding: {path}")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=no_duplicate_object_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise Violation(f"invalid JSON {path.name}: {error}") from error


def exact_keys(value, keys, where):
    require(type(value) is dict, f"{where} must be object")
    require(set(value) == set(keys), f"{where} keys differ: {set(value) ^ set(keys)}")


def nonempty_string(value, where):
    require(type(value) is str and value.strip() == value and 1 <= len(value) <= 600, f"{where} invalid string")


def validate_tree():
    require(CONTRACT.exists(), "missing contracts/integration-catalog directory")
    require(not CONTRACT.is_symlink(), "integration-catalog directory must not be symlink")
    actual = set()
    for path in CONTRACT.rglob("*"):
        require(not path.is_symlink(), f"symlink forbidden: {path}")
        if path.is_file():
            actual.add(path.relative_to(CONTRACT).as_posix())
        else:
            raise Violation(f"unexpected directory in exact tree: {path}")
    require(actual == EXPECTED_TREE, f"exact tree mismatch missing={EXPECTED_TREE-actual} extra={actual-EXPECTED_TREE}")


def validate_stream_legal_source(provider):
    """Bind VERIFIED Stream service terms to the current official Legal Center."""
    require(provider["license_source"] == STREAM_LEGAL_SOURCE, "Stream legal source must be current official Legal Center")
    require(provider["canonical_identity"] == "official:getstream-chat-video", "Stream legal source identity drift")


def validate_hyperliquid_python_archive(provider):
    """Resolve the exact license locator against the byte-locked upstream sdist."""
    require(PROVENANCE_ARCHIVE.exists(), "missing locked Hyperliquid Python sdist evidence")
    mode = PROVENANCE_ARCHIVE.lstat().st_mode
    require(stat.S_ISREG(mode) and not stat.S_ISLNK(mode), "Hyperliquid Python sdist evidence must be regular non-symlink")
    archive_bytes = PROVENANCE_ARCHIVE.read_bytes()
    require(0 < len(archive_bytes) <= 5_000_000, "invalid Hyperliquid Python sdist evidence size")
    require(provider["integrity"] == "sha256:" + hashlib.sha256(archive_bytes).hexdigest(), "Hyperliquid Python sdist hash mismatch")
    locator = provider["license_source"]
    require(locator.startswith("archive:"), "Hyperliquid Python license locator must use archive:<exact-member-path>")
    member_path = locator.removeprefix("archive:")
    pure_path = PurePosixPath(member_path)
    require(member_path == pure_path.as_posix() and not pure_path.is_absolute() and ".." not in pure_path.parts, "unsafe Hyperliquid Python archive locator")
    try:
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
            matches = [member for member in archive.getmembers() if member.name == member_path]
            require(len(matches) == 1, "Hyperliquid Python archive locator is not exactly resolvable")
            member = matches[0]
            require(member.isfile() and member.size <= 1_000_000, "Hyperliquid Python license member must be a bounded regular file")
            extracted = archive.extractfile(member)
            require(extracted is not None, "Hyperliquid Python license member is unreadable")
            license_bytes = extracted.read(1_000_001)
    except (tarfile.TarError, OSError) as error:
        raise Violation(f"invalid locked Hyperliquid Python sdist: {error}") from error
    require(len(license_bytes) <= 1_000_000, "Hyperliquid Python license member too large")
    require(provider["license_integrity"] == "sha256:" + hashlib.sha256(license_bytes).hexdigest(), "Hyperliquid Python license hash mismatch")


def validate_inventory(document):
    exact_keys(document, ["schema_version", "authority", "screens"], "inventory")
    require(document["schema_version"] == "loop.screen-inventory/v1", "inventory schema")
    require(document["authority"] == "文档/页面清单.md v1.4 2026-08-23", "inventory authority")
    screens = document["screens"]
    require(type(screens) is list and len(screens) == 103, "inventory must contain 103 screens")
    ids = []
    module_counts = Counter()
    priority_counts = Counter()
    for index, screen in enumerate(screens):
        exact_keys(screen, ["id", "module", "name", "surface", "route", "state", "priority"], f"screen[{index}]")
        screen_id = screen["id"]
        require(type(screen_id) is str and re.fullmatch(r"[A-I](?:[1-9]|1[0-9]|20)", screen_id), f"bad screen id {screen_id}")
        require(screen["module"] == screen_id[0], f"module mismatch {screen_id}")
        nonempty_string(screen["name"], f"{screen_id}.name")
        require(screen["surface"] in {"routed_screen", "sheet", "component", "global_state"}, f"bad surface {screen_id}")
        require(screen["route"] is None or re.fullmatch(r"#[a-z0-9-]+", screen["route"]), f"bad route {screen_id}")
        require((screen["surface"] == "routed_screen") == (screen["route"] is not None), f"surface/route mismatch {screen_id}")
        require(screen["state"] in {"新", "已有", "已有扩", "已有改"}, f"bad canonical state {screen_id}")
        require(screen["priority"] in {"A", "B", "C"}, f"bad priority {screen_id}")
        ids.append(screen_id)
        module_counts[screen["module"]] += 1
        priority_counts[screen["priority"]] += 1
    require(len(ids) == len(set(ids)), "duplicate inventory screen id")
    require(set(ids) == {item for group in EXPECTED_IDS.values() for item in group}, "inventory screen IDs differ from canonical 103")
    require(dict(module_counts) == EXPECTED_MODULE_COUNTS, f"module counts wrong: {module_counts}")
    require(dict(priority_counts) == EXPECTED_PRIORITY_COUNTS, f"priority counts wrong: {priority_counts}")
    return {item["id"]: item for item in screens}


def validate_provider_lock(document):
    exact_keys(document, ["schema_version", "checked_at", "whole_app_reuse_policy", "notification_runtime_selection", "provider_event_trust_boundary", "candidates", "candidate_components", "candidate_component_dependencies", "chatwoot_server_license_boundary", "providers", "capability_selection_gates"], "provider-lock")
    require(document["schema_version"] == "loop.provider-lock/v4", "provider lock schema")
    require(document["checked_at"] == "2026-08-23", "provider lock check date")
    require(document["whole_app_reuse_policy"] == {
        "github_reuse_definition": "mature_application_level_business_capability_or_managed_service",
        "ui_component_library_counts_as_whole_app_reuse": False,
        "example_or_starter_counts_as_runtime": False,
        "unknown_license_code_copy_allowed": False,
        "candidate_counts_as_runtime_before_gate_selection": False,
        "runtime_core_authorities": {
            "wallet": "privy_service", "signature": "privy_service",
            "chat": "stream_service", "perp": "hyperliquid_service",
        },
        "forbidden_secondary_core": ["wallet", "signature", "chat", "perp"],
    }, "whole-app GitHub reuse policy or core authorities weakened")
    require(document["notification_runtime_selection"] == {
        "gate": "notification_inbox", "status": "PENDING", "runtime_selected": None,
        "candidate_ids": ["novu_notification_candidate", "courier_notification_candidate"],
        "single_runtime_required": True, "dual_runtime_forbidden": True,
    }, "notification runtime must remain unselected and single-runtime")
    require(document["provider_event_trust_boundary"] == {
        "gate": "provider_event_ingestion",
        "status": "PENDING",
        "ingress_candidate": "hookdeck_event_gateway_candidate",
        "ingress_role": "untrusted_reliability_only",
        "raw_forwarding": "byte_and_required_headers_lossless_conformance_required",
        "verifier_owner": "provider_specific_thin_bff",
        "verifier_contract": "current_provider_official_algorithm_or_sdk",
        "verification_checks": [
            "cryptographic_signature",
            "timestamp_when_required_by_provider_contract",
            "replay_when_required_by_provider_contract",
        ],
        "before_verification": ["payload_untrusted", "no_transform", "no_business_side_effect"],
        "failure_action": "quarantine_security_record_only_no_trusted_event",
        "hyperliquid_path": "separate_official_websocket_adapter_not_hookdeck",
    }, "provider event trust boundary weakened or Hookdeck promoted to verifier")
    candidates = document["candidates"]
    require(type(candidates) is list and len(candidates) == 8, "candidate lock must contain exact 8 records")
    require({item.get("id") for item in candidates if type(item) is dict} == EXPECTED_CANDIDATE_IDS, "candidate ID set drift")
    candidate_keys = [
        "id", "gate_ids", "status", "application_level", "capability", "deployment",
        "repository", "tag", "commit", "release_date", "license", "license_source",
        "artifact_integrity", "maintenance_evidence", "data_exit", "core_conflict_guard",
        "credentialed_gates", "sources",
    ]
    candidate_result = {}
    for index, candidate in enumerate(candidates):
        exact_keys(candidate, candidate_keys, f"candidate[{index}]")
        candidate_id = candidate["id"]
        require(candidate_id not in candidate_result, f"duplicate candidate {candidate_id}")
        require(candidate["status"] in {"PENDING", "PENDING_MUST_REMAIN"}, f"candidate pretends runtime readiness {candidate_id}")
        require(candidate["application_level"] is True, f"UI component masquerades as application reuse {candidate_id}")
        require(type(candidate["gate_ids"]) is list and candidate["gate_ids"], f"candidate gate coverage missing {candidate_id}")
        require(set(candidate["gate_ids"]) <= EXPECTED_SELECTION_GATE_IDS, f"unknown candidate gate {candidate_id}")
        for field in ["capability", "repository", "tag", "commit", "release_date", "license", "license_source", "artifact_integrity", "maintenance_evidence", "data_exit"]:
            nonempty_string(candidate[field], f"{candidate_id}.{field}")
        require(candidate["repository"].startswith("https://github.com/") and candidate["repository"].count("/") == 4, f"noncanonical candidate repository {candidate_id}")
        require(re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", candidate["tag"]), f"candidate must use exact release tag, not latest or branch {candidate_id}")
        require(re.fullmatch(r"[0-9a-f]{40}", candidate["commit"]), f"candidate exact commit missing {candidate_id}")
        require(re.fullmatch(r"2026-[0-9]{2}-[0-9]{2}", candidate["release_date"]), f"candidate release date missing {candidate_id}")
        require(not any(term in candidate["license"].lower() for term in ["unknown", "noassertion", "pending"]), f"candidate license unknown {candidate_id}")
        require(candidate["license_source"].startswith(candidate["repository"] + "/blob/" + candidate["tag"] + "/"), f"candidate license is not exact-tag scoped {candidate_id}")
        require(candidate["artifact_integrity"].startswith("PENDING_EXACT_"), f"candidate incorrectly presents an approved artifact pin {candidate_id}")
        require("GitHub release " + candidate["tag"] in candidate["maintenance_evidence"], f"candidate maintenance release evidence missing {candidate_id}")
        require(type(candidate["deployment"]) is list and candidate["deployment"] and all(type(x) is str and x for x in candidate["deployment"]), f"candidate deployment missing {candidate_id}")
        require(any(term in candidate["data_exit"].lower() for term in ["export", "dump", "backup", "rebuild", "ledger"]), f"candidate migration/export exit missing {candidate_id}")
        for field in ["core_conflict_guard", "credentialed_gates", "sources"]:
            require(type(candidate[field]) is list and candidate[field] and all(type(x) is str and x for x in candidate[field]), f"candidate {field} missing {candidate_id}")
        require(len(candidate["credentialed_gates"]) >= 5, f"candidate credentialed gate matrix incomplete {candidate_id}")
        require(all(source.startswith("https://") for source in candidate["sources"]), f"candidate source URL invalid {candidate_id}")
        candidate_result[candidate_id] = candidate
    require(candidate_result["stream_feeds_candidate"]["status"] == "PENDING_MUST_REMAIN", "Stream Feeds promoted before GA")
    require("no official Flutter Inbox SDK" in candidate_result["novu_notification_candidate"]["capability"], "Novu Flutter SDK gap hidden")
    require("official Flutter SDK" in candidate_result["courier_notification_candidate"]["capability"], "Courier Flutter comparison evidence missing")
    require("scheduler_never_creates_or_overrides_market_price_facts" in candidate_result["trigger_dev_scheduler_candidate"]["core_conflict_guard"], "scheduler usurps provider price facts")
    require("index_is_disposable_and_never_source_of_truth" in candidate_result["meilisearch_index_candidate"]["core_conflict_guard"], "search index usurps provider facts")
    require("Hookdeck_is_untrusted_reliability_ingress_only" in candidate_result["hookdeck_event_gateway_candidate"]["core_conflict_guard"], "Hookdeck trust role drift")
    chatwoot = candidate_result["chatwoot_support_candidate"]
    require(chatwoot["license"] == "mixed boundary: non-enterprise community code is MIT Expat; enterprise/** is governed by the separate Chatwoot Enterprise License; third-party components retain their own licenses", "Chatwoot server mixed license boundary collapsed")
    require("Flutter client integration is a separately blocked component dependency" in chatwoot["capability"], "Chatwoot Flutter dependency hidden")
    require("official Flutter integration" not in json.dumps(chatwoot, ensure_ascii=False), "Chatwoot server claims official Flutter integration readiness")
    candidate_digest = hashlib.sha256(json.dumps(candidates, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    require(candidate_digest == CANONICAL_CANDIDATE_SHA256, f"canonical candidate records drift: {candidate_digest}")
    components = document["candidate_components"]
    require(type(components) is list and len(components) == 1, "candidate component lock must contain exact 1 record")
    require({item.get("id") for item in components if type(item) is dict} == EXPECTED_COMPONENT_IDS, "candidate component ID set drift")
    component = components[0]
    component_keys = [
        "id", "parent_candidate", "status", "capability", "repository", "tag", "commit",
        "release_evidence", "package_name", "package_version", "package_archive", "package_integrity",
        "package_published", "package_repository_binding", "rejected_alias_artifacts", "license",
        "license_source", "license_integrity", "archive_license_integrity", "maintenance_evidence",
        "credentialed_gates", "sources",
    ]
    exact_keys(component, component_keys, "candidate component")
    require(component["parent_candidate"] == "chatwoot_support_candidate", "Chatwoot Flutter parent candidate drift")
    require(component["status"] == "PENDING_ARTIFACT_SELECTION", "Chatwoot Flutter component promoted before artifact binding")
    require(component["capability"] == "Flutter support client dependency; no official or ready artifact claim", "Chatwoot Flutter readiness claim drift")
    require(component["repository"] == "https://github.com/chatwoot/chatwoot-flutter-sdk", "Chatwoot Flutter canonical repository drift")
    require(component["tag"] is None, "Chatwoot Flutter fake tag/release pin")
    require(component["commit"] == "544025790ec0ff30ce44e3dc527453b22c30eb49", "Chatwoot Flutter exact commit evidence drift")
    require(component["package_name"] == "chatwoot_sdk" and component["package_version"] == "0.0.9", "Chatwoot Flutter package identity drift")
    require(component["package_archive"] == "https://pub.dev/api/archives/chatwoot_sdk-0.0.9.tar.gz", "Chatwoot Flutter archive URL drift")
    require(component["package_integrity"] == "sha256:77248ecffddc15711b050767913426396af7b36b4982a2ce60fc095e7cd5d1f9", "Chatwoot Flutter archive integrity drift")
    require(component["package_repository_binding"] == "PENDING_same_version_repo_content_drift_and_no_tag_binds_archive", "Chatwoot Flutter repository/archive binding falsely closed")
    require(component["license_source"] == "https://github.com/chatwoot/chatwoot-flutter-sdk/blob/544025790ec0ff30ce44e3dc527453b22c30eb49/LICENSE", "Chatwoot Flutter immutable license URL drift")
    require(component["license_integrity"] == "sha256:0a68ac469d389dacbb97a7e396a4d6cbd577479c6ac51a03c06d8e69a2493c2b", "Chatwoot Flutter commit license integrity drift")
    require(component["archive_license_integrity"] == component["license_integrity"], "Chatwoot Flutter archive/commit license bytes differ")
    require(component["rejected_alias_artifacts"] == ["chatwoot_flutter_sdk@0.1.1_points_to_noncanonical_lordkkjmix_repository"], "Chatwoot Flutter noncanonical alias rejection drift")
    require(type(component["credentialed_gates"]) is list and len(component["credentialed_gates"]) >= 5, "Chatwoot Flutter component gates incomplete")
    require(all(type(source) is str and source.startswith("https://") for source in component["sources"]), "Chatwoot Flutter source URL invalid")
    component_digest = hashlib.sha256(json.dumps(components, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    require(component_digest == CANONICAL_COMPONENT_SHA256, f"canonical component record drift: {component_digest}")
    require(document["candidate_component_dependencies"] == {"chatwoot_support_candidate": ["chatwoot_flutter_component_candidate"]}, "Chatwoot capability dependency missing or duplicated")
    boundary = document["chatwoot_server_license_boundary"]
    require(boundary == {
        "candidate_id": "chatwoot_support_candidate",
        "tag": "v4.17.0",
        "community_scope": "non_enterprise_code",
        "community_license": "MIT Expat",
        "community_license_url": "https://github.com/chatwoot/chatwoot/blob/v4.17.0/LICENSE",
        "community_license_sha256": "602d38a808315f221a5e72e2e90e40cb9300f09aa4b317a6a8f1a0c7a3d2175d",
        "enterprise_scope": "enterprise/**",
        "enterprise_license": "Chatwoot Enterprise License",
        "enterprise_license_url": "https://github.com/chatwoot/chatwoot/blob/v4.17.0/enterprise/LICENSE",
        "enterprise_license_sha256": "4c7b8e19559f923835d564cd7830b7a8f5c46c65855dccca5203383782470207",
    }, "Chatwoot server tag-scoped mixed license evidence drift")
    providers = document["providers"]
    require(type(providers) is list and len(providers) == 46, "provider lock must contain exact 46 records")
    require({item.get("id") for item in providers if type(item) is dict} == EXPECTED_PROVIDER_IDS, "provider ID set drift")
    result = {}
    keys = ["id", "kind", "status", "authority_scope", "package_name", "version", "tag", "commit", "source", "integrity", "license", "license_source", "license_integrity", "maintenance_evidence", "checked_at", "upgrade_gate", "identity_kind", "canonical_identity", "canonical_url", "identity_evidence"]
    for index, provider in enumerate(providers):
        exact_keys(provider, keys, f"provider[{index}]")
        provider_id = provider["id"]
        nonempty_string(provider_id, "provider.id")
        require(provider_id not in result, f"duplicate provider {provider_id}")
        require(provider["kind"] in {"hosted_service", "registry_package", "phase_gate", "existing_vendor_lock"}, f"bad provider kind {provider_id}")
        require(provider["status"] in {"VERIFIED", "PENDING"}, f"bad provider status {provider_id}")
        for field in ["authority_scope", "version", "source", "integrity", "license", "license_source", "license_integrity", "maintenance_evidence", "checked_at", "upgrade_gate", "identity_kind", "canonical_identity", "canonical_url", "identity_evidence"]:
            nonempty_string(provider[field], f"{provider_id}.{field}")
        require(provider["checked_at"] == "2026-08-23", f"stale provider check {provider_id}")
        if provider["status"] == "VERIFIED":
            require("PENDING" not in json.dumps(provider), f"verified provider contains PENDING: {provider_id}")
        if provider["kind"] == "registry_package":
            nonempty_string(provider["package_name"], f"{provider_id}.package_name")
            nonempty_string(provider["tag"], f"{provider_id}.tag")
            nonempty_string(provider["commit"], f"{provider_id}.commit")
            require(provider["integrity"].startswith(("sha256:", "sha512-")), f"package integrity missing {provider_id}")
            require(provider["license_integrity"].startswith("sha256:"), f"license integrity missing {provider_id}")
            require(re.fullmatch(r"[0-9a-f]{40}", provider["commit"]), f"exact commit missing {provider_id}")
            require(provider["identity_kind"] == "github_repository", f"registry package lacks GitHub identity {provider_id}")
            require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", provider["canonical_identity"]), f"bad GitHub owner/repo {provider_id}")
            require(provider["canonical_url"] == f"https://github.com/{provider['canonical_identity']}", f"noncanonical GitHub URL {provider_id}")
            require(provider["identity_evidence"] == f"{provider['canonical_url']}/tree/{provider['tag']}", f"release evidence mismatch {provider_id}")
            require(provider["version"] in provider["source"], f"artifact URL/version mismatch {provider_id}")
            require("GitHub" in provider["maintenance_evidence"], f"maintenance evidence missing GitHub release check {provider_id}")
        else:
            require(provider["package_name"] is None and provider["tag"] is None and provider["commit"] is None, f"service package metadata must be null {provider_id}")
            require(provider["integrity"] == "not_applicable_hosted_service", f"service integrity semantics {provider_id}")
            require(provider["identity_kind"] == "official_service_or_gate", f"service/gate identity kind {provider_id}")
            require(provider["canonical_identity"].startswith(("official:", "project-gate:", "selection-gate:")), f"service/gate canonical identity {provider_id}")
            require(provider["canonical_url"].startswith(("https://", "contracts/", "文档/", "调研/", "README.md")), f"service/gate canonical URL {provider_id}")
        if provider["status"] == "PENDING":
            require("PENDING" in provider["maintenance_evidence"] or "pending" in provider["upgrade_gate"].lower(), f"PENDING not explicit {provider_id}")
        result[provider_id] = provider
    validate_stream_legal_source(result["stream_service"])
    validate_hyperliquid_python_archive(result["hyperliquid_python_package"])
    web3_gate = result["flutter_web3_webview_package"]["upgrade_gate"]
    require("tag/commit" not in web3_gate.lower() and not re.search(r"pending.{0,20}(?:tag|commit)", web3_gate.lower()), "Flutter Web3 WebView gate contradicts verified tag/commit")
    require(all(term in web3_gate.lower() for term in ["document-start", "method allowlist", "hostile-dapp", "flutter/webview", "maintenance"]), "Flutter Web3 WebView gate omits remaining audit boundary")
    provider_digest = hashlib.sha256(json.dumps(providers, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    require(provider_digest == CANONICAL_PROVIDER_SHA256, f"canonical provider records drift: {provider_digest}")
    gates = document["capability_selection_gates"]
    require(type(gates) is list and len(gates) == 9, "capability selection gates must be exact 9")
    require({item.get("id") for item in gates if type(item) is dict} == EXPECTED_SELECTION_GATE_IDS, "selection gate ID set drift")
    gate_profiles = {}
    for gate in gates:
        exact_keys(gate, ["id", "covers", "profile", "authority", "status", "default", "prohibited_fallback", "required_evidence", "candidate_ids", "runtime_selected"], "capability selection gate")
        require(type(gate["covers"]) is list and gate["covers"] and all(type(x) is str and x for x in gate["covers"]), f"selection gate coverage {gate['id']}")
        require(gate["authority"] == "whole_app_core_selection_pending", f"selection gate authority {gate['id']}")
        expected_status = "PENDING_MUST_REMAIN" if gate["id"] in {"relationship_graph", "activity_feed"} else "PENDING"
        require(gate["status"] == expected_status and gate["default"] == "deny_runtime_implementation", f"selection gate bypass {gate['id']}")
        require(gate["prohibited_fallback"] == "custom_core_or_unreviewed_fork", f"selection fallback weakened {gate['id']}")
        require(set(gate["required_evidence"]) == {"official_or_canonical_github_identity", "exact_release_and_integrity", "license", "maintenance", "security_and_privacy", "migration_and_export", "credentialed_conformance"}, f"selection evidence drift {gate['id']}")
        require(gate["candidate_ids"] == EXPECTED_GATE_CANDIDATES[gate["id"]], f"selection candidate mapping drift {gate['id']}")
        require(gate["runtime_selected"] is None, f"candidate promoted before selection gate {gate['id']}")
        require(all(gate["id"] in candidate_result[candidate_id]["gate_ids"] for candidate_id in gate["candidate_ids"]), f"candidate reverse gate mapping drift {gate['id']}")
        gate_profiles.setdefault(gate["profile"], []).append(gate["id"])
    gate_digest = hashlib.sha256(json.dumps(gates, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    require(gate_digest == CANONICAL_SELECTION_GATE_SHA256, f"canonical selection gates drift: {gate_digest}")
    for domain, provider_id in CORE_AUTHORITY.items():
        require(provider_id in result, f"missing core authority {domain}")
    require(result["alchemy_service"]["version"].startswith("deprecated_no_new_integration"), "Alchemy simulation deprecation gate missing")
    require(result["privy_preview_service"]["status"] == "PENDING", "Privy preview capability audit must remain PENDING")
    require(result["blockaid_service"]["status"] == "PENDING", "Blockaid credentialed audit must remain PENDING")
    require(result["moonpay_service"]["status"] == "PENDING", "MoonPay Flutter/widget audit must remain PENDING")
    approved_pins = {
        "privy_node_runtime_pin": (
            "@privy-io/node", "0.29.0", "v0.29.0",
            "401f07812626c047d98181e1abe58611984fce2b",
            "sha512-Tcpy8ZDi14SzAmqFXRSgKTgMsk8truxAXodHuRR08XjLSfZLAx2Kfh8EBSoKTPxK9KakMjRhO6+nw66RtiiYdg==",
        ),
        "hyperliquid_ts_runtime_pin": (
            "@nktkas/hyperliquid", "0.33.2", "v0.33.2",
            "65431f93edadc9bc3e17502c107b694bf373db34",
            "sha512-6Jf7USFst6DDI8/5VQjsRJMZLQJJURGIGtVZeXjnsW9II3brfkAPsdS90Z+DhLuC+iTugTb7qwqUuYp6/aCtqQ==",
        ),
    }
    upgrade_candidates = {
        "privy_node_upgrade_candidate": ("@privy-io/node", "0.30.0"),
        "hyperliquid_ts_upgrade_candidate": ("@nktkas/hyperliquid", "0.33.3"),
    }
    for provider_id, expected in approved_pins.items():
        require(provider_id in result, f"missing approved runtime pin {provider_id}")
        provider = result[provider_id]
        actual = tuple(provider[field] for field in ["package_name", "version", "tag", "commit", "integrity"])
        require(actual == expected, f"approved runtime pin drift {provider_id}")
        require(provider["status"] == "VERIFIED", f"approved runtime pin not verified {provider_id}")
        require("runtime_selected_pin" in provider["authority_scope"], f"runtime pin role missing {provider_id}")
    for provider_id, expected in upgrade_candidates.items():
        require(provider_id in result, f"missing upgrade candidate {provider_id}")
        provider = result[provider_id]
        require((provider["package_name"], provider["version"]) == expected, f"upgrade candidate drift {provider_id}")
        require(provider["status"] == "PENDING", f"upgrade candidate bypassed slice audit {provider_id}")
        require("upgrade_candidate_pending_slice_audit" in provider["authority_scope"], f"upgrade role missing {provider_id}")
    return result, candidate_result, gate_profiles


def validate_budget(document):
    exact_keys(document, ["schema_version", "policy", "reuse_acceptance", "allowed_custom_categories", "forbidden_reimplementations", "exception_gate"], "custom budget")
    require(document["schema_version"] == "loop.custom-code-budget/v3", "custom budget schema")
    require(document["policy"] == "LOOP code is limited to UI, orchestration, state projection, policy mapping, thin adapters and copy; durable whole-app business cores require an approved official provider or maintained OSS", "custom budget policy")
    require(set(document["allowed_custom_categories"]) == ALLOWED_CUSTOM, "allowed custom categories changed")
    require(set(document["forbidden_reimplementations"]) == FORBIDDEN_TERMS, "forbidden reimplementations changed")
    require(document["reuse_acceptance"] == {
        "qualifying_github_reuse": "mature_application_level_business_capability_or_managed_service",
        "non_qualifying_as_whole_app_reuse": ["UI_component_library", "screen_template", "demo_or_example_app", "unknown_license_code"],
        "unknown_license_copy": "forbidden",
        "candidate_before_selection_gate": "PENDING_default_deny_not_runtime",
        "required_before_copy_or_import": [
            "canonical_repository_identity", "exact_tag_and_commit", "artifact_integrity",
            "license_and_NOTICE", "SBOM", "upgrade_gate",
        ],
    }, "GitHub whole-app reuse acceptance policy weakened")
    gate = document["exception_gate"]
    exact_keys(gate, ["required_status", "required_evidence", "owner_approval"], "exception gate")
    require(gate["required_status"] == "PENDING" and gate["owner_approval"] == "explicit_written_required", "exception gate weakened")
    require(set(gate["required_evidence"]) == {"provider_gap", "cost", "security_risk", "maintenance_risk", "replacement_plan"}, "exception evidence changed")


def validate_fixtures(document, profiles):
    exact_keys(document, ["schema_version", "network", "fixtures"], "offline fixtures")
    require(document["schema_version"] == "loop.integration-offline-fixtures/v1", "fixture schema")
    require(document["network"] == "forbidden", "offline fixture network must be forbidden")
    fixtures = document["fixtures"]
    require(type(fixtures) is list, "fixtures must be list")
    result = {}
    for fixture in fixtures:
        exact_keys(fixture, ["id", "label", "credential_state", "mutations", "provider_claim", "fallback_to_production"], "fixture")
        nonempty_string(fixture["id"], "fixture.id")
        require(fixture["id"] not in result, f"duplicate fixture {fixture['id']}")
        require(fixture["label"].startswith("Offline fixture — "), f"fixture label not explicit {fixture['id']}")
        require(fixture["credential_state"] == "omitted", f"fixture credential semantics {fixture['id']}")
        require(fixture["mutations"] == "disabled", f"offline mutation enabled {fixture['id']}")
        require(fixture["provider_claim"] == "none", f"fixture claims provider evidence {fixture['id']}")
        require(fixture["fallback_to_production"] == "forbidden", f"fixture fallback unsafe {fixture['id']}")
        result[fixture["id"]] = fixture
    require({profile["offline_fixture"] for profile in profiles.values()} <= set(result), "profile fixture missing")
    return result


def validate_catalog(document, inventory, providers, gate_profiles):
    exact_keys(document, ["schema_version", "whole_app_reuse_policy_ref", "authorities", "credential_categories", "intent_review_composition", "profiles", "screen_mappings"], "catalog")
    require(document["schema_version"] == "loop.integration-catalog/v3", "catalog schema")
    require(document["whole_app_reuse_policy_ref"] == "provider-lock.json#whole_app_reuse_policy", "catalog reuse policy reference drift")
    require(document["authorities"] == CORE_AUTHORITY, "Privy/Stream/Hyperliquid authorities changed")
    require(set(document["credential_categories"]) == ALLOWED_CREDENTIALS, "credential categories changed")
    profiles = {}
    require(type(document["profiles"]) is list and len(document["profiles"]) == 32, "catalog must contain exact 32 profiles")
    require({item.get("id") for item in document["profiles"] if type(item) is dict} == EXPECTED_PROFILE_IDS, "profile ID set drift")
    profile_keys = ["id", "capability", "primary_authority", "official_interface", "reuse", "credential_category", "offline_fixture", "fail_closed", "custom_categories", "upgrade_gate", "status", "forbidden_custom", "selection_gates"]
    for profile in document["profiles"]:
        exact_keys(profile, profile_keys, "profile")
        profile_id = profile["id"]
        nonempty_string(profile_id, "profile.id")
        require(profile_id not in profiles, f"duplicate profile {profile_id}")
        require(profile["primary_authority"] in providers, f"unknown primary authority {profile_id}")
        require(type(profile["reuse"]) is list and profile["reuse"], f"reuse empty {profile_id}")
        require(all(item in providers for item in profile["reuse"]), f"unknown reuse provider {profile_id}")
        require(profile["credential_category"] in ALLOWED_CREDENTIALS, f"bad credentials {profile_id}")
        require(profile["fail_closed"].startswith("disable_") or profile["fail_closed"].startswith("show_"), f"fail-closed semantics missing {profile_id}")
        require(type(profile["custom_categories"]) is list and set(profile["custom_categories"]) <= ALLOWED_CUSTOM, f"custom category violation {profile_id}")
        require(type(profile["forbidden_custom"]) is list and set(profile["forbidden_custom"]) <= FORBIDDEN_TERMS, f"forbidden custom vocabulary {profile_id}")
        require(type(profile["selection_gates"]) is list and len(profile["selection_gates"]) == len(set(profile["selection_gates"])), f"selection gate list {profile_id}")
        require(set(profile["selection_gates"]) == set(gate_profiles.get(profile_id, [])), f"profile selection gates drift {profile_id}")
        require(profile["status"] in {"READY_FOR_CREDENTIALED_R0", "PENDING"}, f"profile status {profile_id}")
        if any(providers[item]["status"] == "PENDING" for item in [profile["primary_authority"], *profile["reuse"]]):
            require(profile["status"] == "PENDING", f"profile masks PENDING dependency {profile_id}")
        if profile["selection_gates"]:
            require(profile["status"] == "PENDING", f"profile bypasses selection gate {profile_id}")
            require(profile["primary_authority"] == "whole_app_core_selection_pending", f"profile pretends client/delivery tool is durable authority {profile_id}")
            policy = " ".join([profile["official_interface"], profile["upgrade_gate"]]).lower()
            require("provider_selection_gate=pending/default-deny" in policy and "official provider or maintained oss" in policy, f"provider selection policy missing {profile_id}")
            require("loop bff" not in policy, f"custom LOOP BFF core survived {profile_id}")
        profiles[profile_id] = profile
    profile_digest = hashlib.sha256(json.dumps(document["profiles"], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    require(profile_digest == CANONICAL_PROFILE_SHA256, f"canonical profile records drift: {profile_digest}")
    required_gate_profiles = {"profile_local", "watchlist", "notifications", "dashboard", "federated_search", "support"}
    require(set(gate_profiles) == required_gate_profiles, "whole-app core gate/profile closure drift")
    require(set(profiles["profile_local"]["selection_gates"]) == {"social_profile_store", "relationship_graph"}, "social/profile gate split drift")
    require(set(profiles["notifications"]["selection_gates"]) == {"notification_inbox", "price_alert_scheduler", "provider_event_ingestion"}, "notification core gate split drift")
    require(profiles["watchlist"]["selection_gates"] == ["watchlist_store"], "watchlist gate missing")
    require(profiles["dashboard"]["selection_gates"] == ["activity_feed"], "activity feed gate missing")
    require(profiles["federated_search"]["selection_gates"] == ["federated_search_indexing"], "search/index gate missing")
    runtime_providers = {
        provider_id
        for profile in profiles.values()
        for provider_id in [profile["primary_authority"], *profile["reuse"]]
    }
    require("alchemy_service" not in runtime_providers, "deprecated Alchemy simulation is a runtime dependency")
    require("privy_node_upgrade_candidate" not in runtime_providers, "Privy upgrade candidate used as runtime pin")
    require("hyperliquid_ts_upgrade_candidate" not in runtime_providers, "Hyperliquid upgrade candidate used as runtime pin")
    require("hyperliquid_perp" not in profiles, "monolithic Perp profile survived split")
    require({"perp_market_readonly", "perp_trading_mutations", "unified_intent_review_composition"} <= set(profiles), "required v2 profiles missing")
    readonly = profiles["perp_market_readonly"]
    trading = profiles["perp_trading_mutations"]
    require(readonly["primary_authority"] == "hyperliquid_service", "read-only Perp authority")
    require(trading["primary_authority"] == "hyperliquid_service", "trading Perp authority")
    require(trading["status"] == "PENDING" and trading["credential_category"] == "legal_compliance", "trading legal gate bypassed")
    trading_policy = " ".join([trading["official_interface"], trading["fail_closed"], trading["upgrade_gate"]]).lower()
    for term in ["regional", "legal", "eligibility", "unknown"]:
        require(term in trading_policy, f"Perp trading policy missing {term}")
    for chart_id in ["lightweight_chart", "advanced_chart", "perp_market_readonly", "perp_trading_mutations"]:
        chart = profiles[chart_id]
        require("inappwebview_package" in chart["reuse"], f"Flutter chart lacks WebView dependency {chart_id}")
        require(chart["status"] == "PENDING", f"unaudited Flutter chart marked ready {chart_id}")
    composition = document["intent_review_composition"]
    exact_keys(composition, ["profile", "signature_authority", "source_profiles", "source_screens", "request_kind_policy", "preview_authorities", "simulator_policy"], "intent review composition")
    require(composition == {
        "profile": "unified_intent_review_composition",
        "signature_authority": "privy_service",
        "source_profiles": ["privy_transfer", "privy_swap_bridge", "approvals", "dapp_browser"],
        "source_screens": ["F5", "F7", "F9", "F15", "F16", "F17"],
        "request_kind_policy": "approved_request_kind_policy",
        "preview_authorities": ["privy_preview_service", "blockaid_service"],
        "simulator_policy": "provider_only_no_custom_transaction_simulator",
    }, "intent review composition drift")
    unified = profiles["unified_intent_review_composition"]
    require(unified["primary_authority"] == "privy_service", "Privy is not unified review signature authority")
    unified_text = " ".join([unified["capability"], unified["official_interface"], unified["fail_closed"], unified["upgrade_gate"]])
    for term in ["transfer", "swap", "bridge", "approval", "DApp", "approved_request_kind_policy"]:
        require(term in unified_text, f"unified review missing {term}")
    mappings = document["screen_mappings"]
    require(type(mappings) is list and len(mappings) == 103, "catalog must map 103 screens")
    mapped = {}
    mapping_keys = ["screen_id", "profile", "thin_adapter_owner", "custom_gap", "review_tier", "status"]
    for mapping in mappings:
        exact_keys(mapping, mapping_keys, "screen mapping")
        screen_id = mapping["screen_id"]
        require(screen_id in inventory and screen_id not in mapped, f"duplicate/unknown mapping {screen_id}")
        require(mapping["profile"] in profiles, f"unknown profile {screen_id}")
        require(re.fullmatch(r"(?:lib|server|contracts)/[A-Za-z0-9_./*-]+", mapping["thin_adapter_owner"]), f"bad adapter owner {screen_id}")
        nonempty_string(mapping["custom_gap"], f"{screen_id}.custom_gap")
        require(not any(term.replace("custom_", "") in mapping["custom_gap"].lower().replace(" ", "_") for term in FORBIDDEN_TERMS), f"forbidden custom gap {screen_id}")
        require(mapping["review_tier"] in {"R0", "R1", "R2", "R3"}, f"review tier {screen_id}")
        require(mapping["status"] in {"READY_FOR_CREDENTIALED_R0", "PENDING"}, f"mapping status {screen_id}")
        profile = profiles[mapping["profile"]]
        if profile["status"] == "PENDING":
            require(mapping["status"] == "PENDING", f"mapping masks profile PENDING {screen_id}")
        if screen_id.startswith("D"):
            require(profile["primary_authority"] == "hyperliquid_service", f"Perp authority wrong {screen_id}")
            require("HIP-3" not in mapping["custom_gap"] and "hip-3" not in mapping["custom_gap"].lower(), f"HIP-3 forbidden {screen_id}")
            expected_profile = "perp_market_readonly" if screen_id in {"D1", "D11"} else "perp_trading_mutations"
            require(mapping["profile"] == expected_profile, f"Perp profile split wrong {screen_id}")
            require(mapping["status"] == "PENDING", f"Perp gate bypassed {screen_id}")
        if screen_id.startswith("E"):
            require(profile["primary_authority"] in {"stream_service", "phase2_disabled"}, f"communication authority wrong {screen_id}")
        if screen_id in {"A3", "A4", "A6", "A7", "A8", "A9", "A10", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14", "F16", "F17", "H5", "H6", "H7", "H8"}:
            require(profile["primary_authority"] in {"privy_service", "goplus_service", "alchemy_service", "phase2_disabled"}, f"wallet authority wrong {screen_id}")
        mapped[screen_id] = mapping
    require(set(mapped) == set(inventory), "screen coverage mismatch")
    require(mapped["F11"]["profile"] == "unified_intent_review_composition", "F11 unified composition missing")
    require(mapped["F7"]["profile"] == "privy_swap_bridge", "F7 source profile drift")
    require(mapped["F15"]["profile"] == "dapp_browser", "F15 source profile drift")
    require(mapped["F16"]["profile"] == "approvals", "F16 source profile drift")
    binding_rows = [
        {
            "id": screen_id,
            "module": inventory[screen_id]["module"],
            "priority": inventory[screen_id]["priority"],
            "name": inventory[screen_id]["name"],
            "surface": inventory[screen_id]["surface"],
            "route": inventory[screen_id]["route"],
            "state": inventory[screen_id]["state"],
            "profile": mapped[screen_id]["profile"],
            "owner": mapped[screen_id]["thin_adapter_owner"],
        }
        for screen_id in sorted(inventory)
    ]
    binding_hash = hashlib.sha256(json.dumps(binding_rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    require(binding_hash == CANONICAL_BINDING_SHA256, f"canonical 103 binding drift: {binding_hash}")
    return profiles


def validate_slices(document, profiles, candidates, mappings):
    exact_keys(document, ["schema_version", "ordering", "slices"], "implementation slices")
    require(document["schema_version"] == "loop.integration-slices/v2", "slice schema")
    require(document["ordering"] == "ascending_wave_then_order; equal-wave slices are parallel-safe", "slice ordering")
    slices = document["slices"]
    require(type(slices) is list and len(slices) == 14, "implementation slices must be exact 14")
    require({item.get("id") for item in slices if type(item) is dict} == EXPECTED_SLICE_IDS, "implementation slice IDs drift")
    owners = {}
    last = (-1, -1)
    positions = {}
    profile_counts = Counter()
    candidate_counts = Counter()
    by_id = {}
    for item in slices:
        exact_keys(item, ["id", "wave", "order", "provider_slice", "candidate_reuse", "depends_on", "owns", "profiles", "credentialed_gate", "status"], "slice")
        require(type(item["wave"]) is int and type(item["order"]) is int, f"slice ordering types {item['id']}")
        require((item["wave"], item["order"]) > last, "slices not strictly sorted or duplicate position")
        last = (item["wave"], item["order"])
        require(item["id"] not in by_id, f"duplicate slice ID {item['id']}")
        by_id[item["id"]] = item
        positions[item["id"]] = (item["wave"], item["order"])
        require(item["candidate_reuse"] == EXPECTED_SLICE_CANDIDATES[item["id"]], f"slice candidate mapping drift {item['id']}")
        require(all(candidate_id in candidates for candidate_id in item["candidate_reuse"]), f"unknown candidate in slice {item['id']}")
        candidate_counts.update(item["candidate_reuse"])
        require(type(item["depends_on"]) is list and len(item["depends_on"]) == len(set(item["depends_on"])), f"slice dependency list {item['id']}")
        require(type(item["owns"]) is list and item["owns"], f"slice owns empty {item['id']}")
        for owner in item["owns"]:
            require(type(owner) is str and owner.endswith("/**"), f"slice ownership must be prefix glob {owner}")
            require(re.fullmatch(r"(?:lib|server|contracts|test)/[A-Za-z0-9_./-]+/\*\*", owner), f"bad slice ownership {owner}")
            prefix = owner[:-2]
            for existing_prefix, existing_slice in owners.items():
                require(not prefix.startswith(existing_prefix) and not existing_prefix.startswith(prefix), f"overlapping prefix ownership {owner} vs {existing_slice}")
            owners[prefix] = item["id"]
        require(set(item["profiles"]) <= set(profiles), f"unknown profile in slice {item['id']}")
        profile_counts.update(item["profiles"])
        require(item["status"] in {"READY_FOR_CREDENTIALED_R0", "PENDING"}, f"slice status {item['id']}")
        if any(profiles[profile_id]["status"] == "PENDING" for profile_id in item["profiles"]):
            require(item["status"] == "PENDING", f"slice masks PENDING profile {item['id']}")
        nonempty_string(item["credentialed_gate"], f"slice gate {item['id']}")
    require(set(profile_counts) == set(profiles) and all(count == 1 for count in profile_counts.values()), "each profile must belong to exactly one slice")
    require(set(candidate_counts) == set(candidates), "every candidate must map to at least one slice")
    for slice_id, item in by_id.items():
        for dependency in item["depends_on"]:
            require(dependency in by_id, f"unknown slice dependency {slice_id}->{dependency}")
            require(positions[dependency][0] < positions[slice_id][0], f"dependency is not in an earlier wave {slice_id}->{dependency}")
            if by_id[dependency]["status"] == "PENDING":
                require(item["status"] == "PENDING", f"slice masks PENDING dependency {slice_id}->{dependency}")
    require("risk_preview_compliance" in by_id["hyperliquid_core_perp"]["depends_on"], "Hyperliquid mutations bypass regional/risk slice")
    require(by_id["hyperliquid_core_perp"]["status"] == "PENDING", "Hyperliquid slice bypassed regional/legal/eligibility gate")
    visiting = set()
    visited = set()

    def visit(slice_id):
        require(slice_id not in visiting, f"slice dependency cycle at {slice_id}")
        if slice_id in visited:
            return
        visiting.add(slice_id)
        for dependency in by_id[slice_id]["depends_on"]:
            visit(dependency)
        visiting.remove(slice_id)
        visited.add(slice_id)

    for slice_id in by_id:
        visit(slice_id)
    for mapping in mappings:
        mapping_prefix = mapping["thin_adapter_owner"][:-1]
        matching = [slice_id for prefix, slice_id in owners.items() if mapping_prefix.startswith(prefix)]
        require(len(matching) == 1, f"mapping owner must match exactly one slice {mapping['screen_id']}: {matching}")
        slice_item = by_id[matching[0]]
        require(mapping["profile"] in slice_item["profiles"], f"mapping profile not declared by owning slice {mapping['screen_id']}")
        if slice_item["status"] == "PENDING":
            require(mapping["status"] == "PENDING", f"mapping masks PENDING owning slice {mapping['screen_id']}")


def validate_documents(providers):
    for name in ["README.md", "sources.md"]:
        text = (CONTRACT / name).read_text("utf-8")
        require(500 <= len(text) <= 100_000, f"{name} length")
        require("custom_code_budget" in text and "HIP-3" in text and "PENDING" in text, f"{name} missing binding terms")
        require("Privy" in text and "Stream" in text and "Hyperliquid" in text, f"{name} missing authorities")
        for term in ["GitHub", "UI component", "未知", "runtime_selected", "Hookdeck", "raw", "PENDING_MUST_REMAIN"]:
            require(term.lower() in text.lower(), f"{name} missing v5 whole-app reuse term {term}")
    sources = (CONTRACT / "sources.md").read_text("utf-8")
    require("provider-lock.json is the single machine-readable pin truth" in sources, "sources single-truth declaration missing")
    require("sha256" not in sources.lower() and "sha512" not in sources.lower(), "sources duplicates integrity values")
    require(not re.search(r"\b[0-9a-f]{40}\b", sources), "sources duplicates commit values")
    for provider in providers.values():
        if provider["kind"] == "registry_package":
            require(provider["version"] not in sources, f"sources duplicates version pin {provider['id']}")


def load_documents():
    return {
        "inventory": load_json(CONTRACT / "screen-inventory.json"),
        "providers": load_json(CONTRACT / "provider-lock.json"),
        "budget": load_json(CONTRACT / "custom-code-budget.json"),
        "fixtures": load_json(CONTRACT / "offline-fixtures.json"),
        "catalog": load_json(CONTRACT / "catalog.json"),
        "slices": load_json(CONTRACT / "implementation-slices.json"),
    }


def validate_all(documents):
    inventory = validate_inventory(documents["inventory"])
    providers, candidates, gate_profiles = validate_provider_lock(documents["providers"])
    validate_budget(documents["budget"])
    profiles = validate_catalog(documents["catalog"], inventory, providers, gate_profiles)
    validate_fixtures(documents["fixtures"], profiles)
    validate_slices(documents["slices"], profiles, candidates, documents["catalog"]["screen_mappings"])
    return inventory, providers, candidates, profiles


def mutation_suite(documents):
    mutations = []

    def add(name, fn):
        mutations.append((name, fn))

    def profile(d, profile_id):
        return next(item for item in d["catalog"]["profiles"] if item["id"] == profile_id)

    def provider(d, provider_id):
        return next(item for item in d["providers"]["providers"] if item["id"] == provider_id)

    def candidate_item(d, candidate_id):
        return next(item for item in d["providers"]["candidates"] if item["id"] == candidate_id)

    def candidate_component(d, component_id):
        return next(item for item in d["providers"]["candidate_components"] if item["id"] == component_id)

    def mapping(d, screen_id):
        return next(item for item in d["catalog"]["screen_mappings"] if item["screen_id"] == screen_id)

    def slice_item(d, slice_id):
        return next(item for item in d["slices"]["slices"] if item["id"] == slice_id)

    def selection_gate(d, gate_id):
        return next(item for item in d["providers"]["capability_selection_gates"] if item["id"] == gate_id)

    def weaken_trade_policy(d):
        item = profile(d, "perp_trading_mutations")
        item["official_interface"] = "Hyperliquid mutation API"
        item["fail_closed"] = "disable_on_provider_error"
        item["upgrade_gate"] = "credentialed R0"

    def weaken_unified_review(d):
        item = profile(d, "unified_intent_review_composition")
        item["capability"] = "generic confirmation"
        item["official_interface"] = "generic provider"
        item["fail_closed"] = "disable_on_error"
        item["upgrade_gate"] = "credentialed R0"

    add("drop-screen", lambda d: d["inventory"]["screens"].pop())
    add("duplicate-screen", lambda d: d["inventory"]["screens"].append(copy.deepcopy(d["inventory"]["screens"][0])))
    add("priority-drift", lambda d: d["inventory"]["screens"][0].__setitem__("priority", "B"))
    add("module-drift", lambda d: d["inventory"]["screens"][0].__setitem__("module", "B"))
    add("name-drift", lambda d: d["inventory"]["screens"][0].__setitem__("name", "启动"))
    add("surface-drift", lambda d: d["inventory"]["screens"][0].__setitem__("surface", "component"))
    add("route-drift", lambda d: d["inventory"]["screens"][0].__setitem__("route", "#boot"))
    add("state-drift", lambda d: d["inventory"]["screens"][0].__setitem__("state", "已有"))
    add("missing-mapping", lambda d: d["catalog"]["screen_mappings"].pop())
    add("duplicate-mapping", lambda d: d["catalog"]["screen_mappings"].append(copy.deepcopy(d["catalog"]["screen_mappings"][0])))
    add("unknown-profile", lambda d: d["catalog"]["screen_mappings"][0].__setitem__("profile", "missing"))
    add("empty-custom-gap", lambda d: d["catalog"]["screen_mappings"][0].__setitem__("custom_gap", ""))
    add("forbidden-custom-core", lambda d: d["catalog"]["screen_mappings"][0].__setitem__("custom_gap", "custom_wallet"))
    add("wrong-perp-read-authority", lambda d: profile(d, "perp_market_readonly").__setitem__("primary_authority", "privy_service"))
    add("wrong-perp-trade-authority", lambda d: profile(d, "perp_trading_mutations").__setitem__("primary_authority", "privy_service"))
    add("wrong-chat-authority", lambda d: profile(d, "stream_chat").__setitem__("primary_authority", "privy_service"))
    add("wrong-wallet-authority", lambda d: profile(d, "privy_wallet").__setitem__("primary_authority", "stream_service"))
    add("hip3", lambda d: mapping(d, "D1").__setitem__("custom_gap", "Enable HIP-3"))
    add("d2-readonly-bypass", lambda d: mapping(d, "D2").__setitem__("profile", "perp_market_readonly"))
    add("d11-trading-drift", lambda d: mapping(d, "D11").__setitem__("profile", "perp_trading_mutations"))
    add("perp-trade-ready", lambda d: profile(d, "perp_trading_mutations").__setitem__("status", "READY_FOR_CREDENTIALED_R0"))
    add("perp-trade-policy-weakened", weaken_trade_policy)
    add("perp-slice-ready", lambda d: slice_item(d, "hyperliquid_core_perp").__setitem__("status", "READY_FOR_CREDENTIALED_R0"))
    add("perp-regional-dependency-removed", lambda d: slice_item(d, "hyperliquid_core_perp")["depends_on"].remove("risk_preview_compliance"))
    add("chart-direct-js", lambda d: profile(d, "lightweight_chart")["reuse"].remove("inappwebview_package"))
    add("perp-chart-direct-js", lambda d: profile(d, "perp_market_readonly")["reuse"].remove("inappwebview_package"))
    add("chart-ready-before-bridge", lambda d: profile(d, "lightweight_chart").__setitem__("status", "READY_FOR_CREDENTIALED_R0"))
    add("f11-not-unified", lambda d: mapping(d, "F11").__setitem__("profile", "privy_transfer"))
    add("unified-signature-authority", lambda d: d["catalog"]["intent_review_composition"].__setitem__("signature_authority", "blockaid_service"))
    add("unified-source-gap", lambda d: d["catalog"]["intent_review_composition"]["source_profiles"].pop())
    add("unified-custom-simulator", lambda d: d["catalog"]["intent_review_composition"].__setitem__("simulator_policy", "custom_transaction_simulator"))
    add("unified-profile-authority", lambda d: profile(d, "unified_intent_review_composition").__setitem__("primary_authority", "blockaid_service"))
    add("unified-policy-weakened", weaken_unified_review)
    add("unknown-reuse", lambda d: d["catalog"]["profiles"][0]["reuse"].append("missing"))
    add("alchemy-runtime-reuse", lambda d: d["catalog"]["profiles"][0]["reuse"].append("alchemy_service"))
    add("privy-upgrade-as-runtime", lambda d: profile(d, "privy_auth")["reuse"].__setitem__(1, "privy_node_upgrade_candidate"))
    add("hyperliquid-upgrade-as-runtime", lambda d: profile(d, "perp_market_readonly")["reuse"].__setitem__(1, "hyperliquid_ts_upgrade_candidate"))
    add("empty-reuse", lambda d: d["catalog"]["profiles"][0].__setitem__("reuse", []))
    add("bad-credential", lambda d: d["catalog"]["profiles"][0].__setitem__("credential_category", "client_secret"))
    add("unsafe-fallback", lambda d: d["catalog"]["profiles"][0].__setitem__("fail_closed", "fallback_custom"))
    add("mask-pending-profile", lambda d: next(p for p in d["catalog"]["profiles"] if p["status"] == "PENDING").__setitem__("status", "READY_FOR_CREDENTIALED_R0"))
    add("privy-runtime-version-drift", lambda d: provider(d, "privy_node_runtime_pin").__setitem__("version", "0.30.0"))
    add("privy-runtime-commit-drift", lambda d: provider(d, "privy_node_runtime_pin").__setitem__("commit", "0" * 40))
    add("hyperliquid-runtime-version-drift", lambda d: provider(d, "hyperliquid_ts_runtime_pin").__setitem__("version", "0.33.3"))
    add("privy-upgrade-autoapproved", lambda d: provider(d, "privy_node_upgrade_candidate").__setitem__("status", "VERIFIED"))
    add("hyperliquid-upgrade-autoapproved", lambda d: provider(d, "hyperliquid_ts_upgrade_candidate").__setitem__("status", "VERIFIED"))
    add("provider-fortyseventh", lambda d: d["providers"]["providers"].append({**copy.deepcopy(d["providers"]["providers"][-1]), "id": "malicious_extra_provider"}))
    add("provider-id-replaced", lambda d: provider(d, "posthog_service").__setitem__("id", "fake_analytics"))
    add("stream-fake-version", lambda d: provider(d, "stream_chat_package").__setitem__("version", "99.99.99"))
    add("stream-fake-repository", lambda d: provider(d, "stream_chat_package").__setitem__("canonical_url", "https://invalid.example/fake/repo"))
    add("stream-fake-commit", lambda d: provider(d, "stream_chat_package").__setitem__("commit", "0" * 40))
    add("stream-fake-artifact-hash", lambda d: provider(d, "stream_chat_package").__setitem__("integrity", "sha256:" + "0" * 64))
    add("stream-fake-license-hash", lambda d: provider(d, "stream_chat_package").__setitem__("license_integrity", "sha256:" + "0" * 64))
    add("stream-fake-maintenance", lambda d: provider(d, "stream_chat_package").__setitem__("maintenance_evidence", "GitHub fake release checked"))
    add("hosted-fake-official-identity", lambda d: provider(d, "stream_service").__setitem__("canonical_identity", "official:fake-stream"))
    add("hosted-fake-evidence-url", lambda d: provider(d, "stream_service").__setitem__("identity_evidence", "https://invalid.example/stream"))
    add("stream-legal-404-url", lambda d: provider(d, "stream_service").__setitem__("license_source", "https://getstream.io/legal/terms/"))
    add("stream-legal-fake-domain", lambda d: provider(d, "stream_service").__setitem__("license_source", "https://invalid.example/legal/"))
    add("hyperliquid-license-unresolvable-locator", lambda d: provider(d, "hyperliquid_python_package").__setitem__("license_source", "archive:LICENSE.md"))
    add("hyperliquid-license-pseudo-locator", lambda d: provider(d, "hyperliquid_python_package").__setitem__("license_source", "archive-strip-root:LICENSE.md"))
    add("flutter-web3-upgrade-gate-contradiction", lambda d: provider(d, "flutter_web3_webview_package").__setitem__("upgrade_gate", "pending tag/commit, document-start injection audit, method allowlist and hostile-DApp R0"))
    add("profile-thirtythird", lambda d: d["catalog"]["profiles"].append({**copy.deepcopy(d["catalog"]["profiles"][-1]), "id": "malicious_extra_profile"}))
    add("profile-id-replaced", lambda d: profile(d, "watchlist").__setitem__("id", "local_watchlist_core"))
    add("selection-gate-tenth", lambda d: d["providers"]["capability_selection_gates"].append({**copy.deepcopy(d["providers"]["capability_selection_gates"][-1]), "id": "extra_core"}))
    add("selection-gate-dropped", lambda d: d["providers"]["capability_selection_gates"].pop())
    add("selection-gate-ready", lambda d: selection_gate(d, "social_profile_store").__setitem__("status", "VERIFIED"))
    add("selection-gate-default-allow", lambda d: selection_gate(d, "watchlist_store").__setitem__("default", "allow_custom_core"))
    add("selection-gate-custom-fork", lambda d: selection_gate(d, "notification_inbox").__setitem__("prohibited_fallback", "review_later"))
    add("profile-selection-gate-removed", lambda d: profile(d, "profile_local")["selection_gates"].pop())
    add("notification-fcm-as-durable-authority", lambda d: profile(d, "notifications").__setitem__("primary_authority", "firebase_service"))
    add("profile-loop-bff-core", lambda d: profile(d, "profile_local").__setitem__("official_interface", "LOOP identity BFF social graph core"))
    add("watchlist-loop-store", lambda d: profile(d, "watchlist").__setitem__("official_interface", "LOOP durable watchlist store"))
    add("search-custom-index", lambda d: profile(d, "federated_search")["forbidden_custom"].remove("custom_search_index"))
    add("missing-license", lambda d: d["providers"]["providers"][0].__setitem__("license", ""))
    add("missing-integrity", lambda d: next(p for p in d["providers"]["providers"] if p["kind"] == "registry_package").__setitem__("integrity", "none"))
    add("missing-license-integrity", lambda d: next(p for p in d["providers"]["providers"] if p["kind"] == "registry_package").__setitem__("license_integrity", "none"))
    add("missing-source", lambda d: d["providers"]["providers"][0].__setitem__("source", ""))
    add("verified-with-pending", lambda d: next(p for p in d["providers"]["providers"] if p["status"] == "PENDING").__setitem__("status", "VERIFIED"))
    add("service-fake-integrity", lambda d: next(p for p in d["providers"]["providers"] if p["kind"] == "hosted_service").__setitem__("integrity", "sha256:fake"))
    add("budget-expand", lambda d: d["budget"]["allowed_custom_categories"].append("provider_core"))
    add("budget-remove-forbidden", lambda d: d["budget"]["forbidden_reimplementations"].pop())
    add("exception-autoapprove", lambda d: d["budget"]["exception_gate"].__setitem__("owner_approval", "automatic"))
    add("fixture-network", lambda d: d["fixtures"].__setitem__("network", "allowed"))
    add("fixture-mutation", lambda d: d["fixtures"]["fixtures"][0].__setitem__("mutations", "enabled"))
    add("fixture-provider-claim", lambda d: d["fixtures"]["fixtures"][0].__setitem__("provider_claim", "success"))
    add("slice-overlap", lambda d: d["slices"]["slices"][1]["owns"].append(d["slices"]["slices"][0]["owns"][0]))
    add("slice-prefix-overlap", lambda d: slice_item(d, "risk_preview_compliance")["owns"].append("lib/platform/foundation/nested/**"))
    add("slice-unsorted", lambda d: d["slices"]["slices"][0].__setitem__("wave", 99))
    add("slice-profile-gap", lambda d: d["slices"]["slices"][0].__setitem__("profiles", []))
    add("slice-profile-duplicate", lambda d: slice_item(d, "risk_preview_compliance")["profiles"].append("app_shell"))
    add("slice-id-drift", lambda d: d["slices"]["slices"][0].__setitem__("id", "foundation"))
    add("slice-fifteenth", lambda d: d["slices"]["slices"].append({**copy.deepcopy(d["slices"]["slices"][-1]), "id": "extra_slice", "wave": 5}))
    add("slice-unknown-dependency", lambda d: slice_item(d, "privy_funds")["depends_on"].append("missing_slice"))
    add("slice-same-wave-dependency", lambda d: slice_item(d, "risk_preview_compliance")["depends_on"].append("privy_identity_wallet"))
    add("slice-cycle", lambda d: slice_item(d, "platform_foundation")["depends_on"].append("phase2_hold"))
    add("stream-slice-masks-pending-platform", lambda d: slice_item(d, "stream_communication").__setitem__("status", "READY_FOR_CREDENTIALED_R0"))
    add("dashboard-slice-masks-pending-stream", lambda d: slice_item(d, "dashboard_search").__setitem__("status", "READY_FOR_CREDENTIALED_R0"))
    add("stream-page-masks-pending-owner", lambda d: mapping(d, "E1").__setitem__("status", "READY_FOR_CREDENTIALED_R0"))
    add("search-page-masks-pending-owner", lambda d: mapping(d, "B4").__setitem__("status", "READY_FOR_CREDENTIALED_R0"))
    add("slice-bad-owner-glob", lambda d: slice_item(d, "platform_foundation")["owns"].__setitem__(0, "lib/platform/foundation/*"))
    add("a1-owner-drift", lambda d: mapping(d, "A1").__setitem__("thin_adapter_owner", "lib/platform/app_shell/*"))
    add("f3-owner-drift", lambda d: mapping(d, "F3").__setitem__("thin_adapter_owner", "lib/integrations/privy/transfer/*"))
    add("d12-owner-drift", lambda d: mapping(d, "D12").__setitem__("thin_adapter_owner", "lib/features/perp_risk/*"))
    add("whole-app-ui-library-masquerade", lambda d: d["providers"]["whole_app_reuse_policy"].__setitem__("ui_component_library_counts_as_whole_app_reuse", True))
    add("whole-app-example-promoted-runtime", lambda d: d["providers"]["whole_app_reuse_policy"].__setitem__("example_or_starter_counts_as_runtime", True))
    add("whole-app-second-wallet-core", lambda d: d["providers"]["whole_app_reuse_policy"]["runtime_core_authorities"].__setitem__("wallet", "second_wallet_service"))
    add("whole-app-second-signature-core", lambda d: d["providers"]["whole_app_reuse_policy"]["runtime_core_authorities"].__setitem__("signature", "second_signer_service"))
    add("whole-app-second-chat-core", lambda d: d["providers"]["whole_app_reuse_policy"]["runtime_core_authorities"].__setitem__("chat", "second_chat_service"))
    add("whole-app-second-perp-core", lambda d: d["providers"]["whole_app_reuse_policy"]["runtime_core_authorities"].__setitem__("perp", "second_perp_service"))
    add("unknown-license-copy-policy", lambda d: d["providers"]["whole_app_reuse_policy"].__setitem__("unknown_license_code_copy_allowed", True))
    add("unknown-license-candidate", lambda d: candidate_item(d, "supabase_app_data_candidate").__setitem__("license", "UNKNOWN"))
    add("candidate-latest-pin", lambda d: candidate_item(d, "trigger_dev_scheduler_candidate").__setitem__("tag", "latest"))
    add("candidate-branch-pin", lambda d: candidate_item(d, "meilisearch_index_candidate").__setitem__("tag", "main"))
    add("candidate-promoted-before-gate", lambda d: selection_gate(d, "social_profile_store").__setitem__("runtime_selected", "supabase_app_data_candidate"))
    add("notification-dual-runtime", lambda d: d["providers"]["notification_runtime_selection"].__setitem__("runtime_selected", ["novu_notification_candidate", "courier_notification_candidate"]))
    add("notification-single-runtime-disabled", lambda d: d["providers"]["notification_runtime_selection"].__setitem__("single_runtime_required", False))
    add("hookdeck-self-claims-signature-verification", lambda d: d["providers"]["provider_event_trust_boundary"].__setitem__("verifier_owner", "hookdeck_event_gateway_candidate"))
    add("hookdeck-raw-forwarding-optional", lambda d: d["providers"]["provider_event_trust_boundary"].__setitem__("raw_forwarding", "parsed_JSON_is_sufficient"))
    add("hookdeck-transform-before-verification", lambda d: d["providers"]["provider_event_trust_boundary"]["before_verification"].__setitem__(1, "transform_allowed"))
    add("hookdeck-side-effect-before-verification", lambda d: d["providers"]["provider_event_trust_boundary"]["before_verification"].__setitem__(2, "business_side_effect_allowed"))
    add("feeds-candidate-premature-GA", lambda d: candidate_item(d, "stream_feeds_candidate").__setitem__("status", "PENDING"))
    add("feeds-gate-premature-GA", lambda d: selection_gate(d, "relationship_graph").__setitem__("status", "PENDING"))
    add("candidate-migration-export-missing", lambda d: candidate_item(d, "chatwoot_support_candidate").__setitem__("data_exit", ""))
    add("chatwoot-license-collapse", lambda d: d["providers"]["chatwoot_server_license_boundary"].__setitem__("enterprise_license", "MIT Expat"))
    add("chatwoot-capability-dependency-dropped", lambda d: d["providers"]["candidate_component_dependencies"].__setitem__("chatwoot_support_candidate", []))
    add("chatwoot-capability-dependency-fake-pin", lambda d: candidate_component(d, "chatwoot_flutter_component_candidate").__setitem__("package_integrity", "sha256:" + "0" * 64))
    add("chatwoot-flutter-premature-ready", lambda d: candidate_component(d, "chatwoot_flutter_component_candidate").__setitem__("status", "READY"))
    add("index-usurps-provider-facts", lambda d: candidate_item(d, "meilisearch_index_candidate")["core_conflict_guard"].__setitem__(0, "index_is_source_of_truth"))
    add("scheduler-usurps-price-facts", lambda d: candidate_item(d, "trigger_dev_scheduler_candidate")["core_conflict_guard"].__setitem__(0, "scheduler_creates_market_price_facts"))
    add("slice-candidate-mapping-dropped", lambda d: slice_item(d, "hosted_support").__setitem__("candidate_reuse", []))
    add("budget-unknown-license-copy", lambda d: d["budget"]["reuse_acceptance"].__setitem__("unknown_license_copy", "allowed"))

    for name, mutate in mutations:
        candidate = copy.deepcopy(documents)
        mutate(candidate)
        try:
            validate_all(candidate)
        except Violation:
            continue
        raise Violation(f"malicious mutation survived: {name}")
    return len(mutations)


def tree_hash():
    digest = hashlib.sha256()
    for name in sorted(EXPECTED_TREE):
        digest.update(name.encode("utf-8") + b"\0")
        digest.update((CONTRACT / name).read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def main():
    try:
        validate_tree()
        documents = load_documents()
        inventory, providers, candidates, profiles = validate_all(documents)
        validate_documents(providers)
        count = mutation_suite(documents) if "--mutations" in sys.argv else 0
    except (Violation, OSError) as error:
        print(f"FAIL: {error}")
        return 1
    print(
        "PASS: integration catalog "
        f"screens={len(inventory)} A={sum(v['priority']=='A' for v in inventory.values())} "
        f"providers={len(providers)} candidates={len(candidates)} components={len(documents['providers']['candidate_components'])} profiles={len(profiles)} mutations={count} tree={tree_hash()}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
