#!/usr/bin/env python3
"""Verify the credential-gated Hyperliquid Perp contract without SDK installs."""

from __future__ import annotations

import argparse
import copy
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile


EXPECTED_TREE = {
    "README.md",
    "contract.json",
    "fixtures/offline-r0.json",
    "implementation-plan.md",
    "oss-lock.json",
    "sources.md",
    "target-inventory.json",
}
EXPECTED_CONTRACT_ARTIFACTS = {
    "README.md": {"size": 5829, "sha256": "0c52273f5b136a1a04a11f252583521cccc9cc9a7bc51bb01f413e05b6d1ab02"},
    "contract.json": {"size": 23480, "sha256": "d77c57422754d2cebe8c7dc79d10e7046688f93d77fe3c520018f61e87322849"},
    "fixtures/offline-r0.json": {"size": 22826, "sha256": "bb9fa32a132e3f715024b0a1ce6f6b3723390d98aa2929c1bf141166fe3a8d22"},
    "implementation-plan.md": {"size": 16273, "sha256": "7172fee4e1d06a625fc318e98efc7f6dceb8c3d58098ea68cdc883813c98f1a6"},
    "oss-lock.json": {"size": 3350, "sha256": "25fe55c272d3eb489d882b08bda56eb3074f3ec05ec78321752fb0d838b8b6b2"},
    "sources.md": {"size": 6616, "sha256": "2319d6acf1270a1e7ca5448b6dbbc74ad0ea982c6d9c6a97047df1aa313d73fb"},
    "target-inventory.json": {"size": 4656, "sha256": "983e8d40daae99d384635d86172a2a58fbd658ec63adedf53d93bf696a30faca"},
}

INFO_OPERATIONS = {
    "meta",
    "metaAndAssetCtxs",
    "l2Book",
    "clearinghouseState",
    "openOrders",
    "orderStatus",
    "userFillsByTime",
    "userFunding",
    "extraAgents",
    "maxBuilderFee",
    "approvedBuilders",
    "fundingHistory",
    "userRateLimit",
}
EXCHANGE_ACTIONS = {
    "order",
    "cancel",
    "cancelByCloid",
    "modify",
    "batchModify",
    "updateLeverage",
    "updateIsolatedMargin",
    "scheduleCancel",
    "approveAgent",
}
USER_STREAMS = {
    "orderUpdates",
    "userEvents",
    "userFills",
    "userFundings",
    "userNonFundingLedgerUpdates",
}
MARKET_STREAMS = {"allMids", "l2Book", "trades", "activeAssetCtx", "bbo"}
TARGET_ID_DIRECTIVE_RE = re.compile(r"^- Target (T[0-9]{2}): .+$", re.MULTILINE)
OWNER_ONLY = {"approveAgent", "withdraw3", "usdSend", "sendAsset"}
AGENT_ALLOWED = {
    "order",
    "cancel",
    "cancelByCloid",
    "modify",
    "batchModify",
    "updateLeverage",
    "updateIsolatedMargin",
    "scheduleCancel",
}
RECONCILE_READS = {
    "orderStatus",
    "openOrders",
    "clearinghouseState",
    "userFillsByTime",
    "userFunding",
    "extraAgents",
    "maxBuilderFee",
    "approvedBuilders",
}
CORE_TERMINAL_ORDER_STATUSES = {
    "filled",
    "canceled",
    "rejected",
    "marginCanceled",
    "openInterestCapCanceled",
    "selfTradeCanceled",
    "reduceOnlyCanceled",
    "delistedCanceled",
    "liquidatedCanceled",
    "scheduledCancel",
    "tickRejected",
    "minTradeNtlRejected",
    "perpMarginRejected",
    "reduceOnlyRejected",
    "badAloPxRejected",
    "iocCancelRejected",
    "marketOrderNoLiquidityRejected",
    "positionIncreaseAtOpenInterestCapRejected",
    "positionFlipAtOpenInterestCapRejected",
    "tooAggressiveAtOpenInterestCapRejected",
    "openInterestIncreaseRejected",
    "oracleRejected",
    "perpMaxPositionRejected",
}
EXCLUDED_PROVIDER_STATUSES = {
    "triggered",
    "vaultWithdrawalCanceled",
    "siblingFilledCanceled",
    "badTriggerPxRejected",
    "insufficientSpotBalanceRejected",
}
FORBIDDEN_ACTIONS = {
    "approveBuilderFee",
    "perpDeploy",
    "agentSetAbstraction",
    "agentEnableDexAbstraction",
    "userSetAbstraction",
    "userDexAbstraction",
}


class ContractError(AssertionError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)


def load_json(path: Path):
    def no_duplicates(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, f"duplicate JSON key {key!r} in {path.name}")
            value[key] = item
        return value

    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=no_duplicates)


def exact_keys(value: dict, keys: set[str], label: str) -> None:
    require(set(value) == keys, f"{label} keys changed: {sorted(set(value) ^ keys)}")


def decimal_string(value, label: str, *, signed: bool = False) -> Decimal:
    require(isinstance(value, str), f"{label} must be a decimal string")
    pattern = r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?" if signed else r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?"
    require(re.fullmatch(pattern, value) is not None, f"{label} is not canonical decimal text")
    try:
        return Decimal(value)
    except InvalidOperation as error:
        raise ContractError(f"{label} is not a decimal") from error


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical_json_sha256(value) -> str:
    return sha256_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def parse_raw_json(value: str, label: str):
    def no_duplicates(pairs):
        document = {}
        for key, item in pairs:
            require(key not in document, f"duplicate raw JSON key {key!r} in {label}")
            document[key] = item
        return document

    require(isinstance(value, str), f"{label} must be exact UTF-8 text")
    return json.loads(value, object_pairs_hook=no_duplicates)


def canonical_quote_from_raw(raw_message_utf8: str, label: str) -> dict:
    frame = parse_raw_json(raw_message_utf8, label)
    exact_keys(frame, {"channel", "data"}, f"{label} frame")
    require(frame["channel"] in {"bbo", "l2Book"}, f"{label} unsupported channel")
    data = frame["data"]
    exact_keys(data, {"coin", "time", "bbo"} if frame["channel"] == "bbo" else {"coin", "time", "levels"}, f"{label} data")
    require(isinstance(data["coin"], str) and data["coin"] and type(data["time"]) is int, f"{label} identity invalid")
    levels = data["bbo"] if frame["channel"] == "bbo" else data["levels"]
    require(isinstance(levels, list) and len(levels) == 2, f"{label} must have bid/ask sides")
    if frame["channel"] == "l2Book":
        require(all(isinstance(side, list) and side for side in levels), f"{label} book sides must be nonempty")
        levels = [levels[0][0], levels[1][0]]
    require(all(isinstance(level, dict) for level in levels), f"{label} top levels must be records")
    for side, level in zip(("bid", "ask"), levels):
        exact_keys(level, {"px", "sz", "n"}, f"{label} {side}")
        require(decimal_string(level["px"], f"{label} {side} px") > 0, f"{label} {side} px invalid")
        require(decimal_string(level["sz"], f"{label} {side} sz") >= 0, f"{label} {side} sz invalid")
        require(type(level["n"]) is int and level["n"] >= 0, f"{label} {side} n invalid")
    bid, ask = levels
    return {
        "source_kind": frame["channel"],
        "coin": data["coin"],
        "provider_time": data["time"],
        "bid_px": bid["px"],
        "bid_sz": bid["sz"],
        "bid_n": bid["n"],
        "ask_px": ask["px"],
        "ask_sz": ask["sz"],
        "ask_n": ask["n"],
    }


def canonical_source_envelope(message: dict, network: str) -> dict:
    quote = message["normalized_quote"]
    return {
        "provider": "hyperliquid",
        "network": network,
        "subscription_epoch": message["subscription_epoch"],
        "monotonic_arrival_sequence": message["monotonic_arrival_sequence"],
        "raw_message_sha256": message["raw_message_sha256"],
        "source_kind": quote["source_kind"],
        "coin": quote["coin"],
        "provider_time": quote["provider_time"],
        "bid_px": quote["bid_px"],
        "bid_sz": quote["bid_sz"],
        "bid_n": quote["bid_n"],
        "ask_px": quote["ask_px"],
        "ask_sz": quote["ask_sz"],
        "ask_n": quote["ask_n"],
    }


def floor_to_tick(value: Decimal, tick: Decimal) -> Decimal:
    return (value // tick) * tick


def ceil_to_tick(value: Decimal, tick: Decimal) -> Decimal:
    quotient = value // tick
    return quotient * tick if value == quotient * tick else (quotient + 1) * tick


def validate_order_wire(wire: dict, *, allowed_assets: set[int], seen_cloids: set[str], label: str) -> None:
    exact_keys(wire, {"a", "b", "p", "s", "r", "t", "c"}, label)
    require(type(wire["a"]) is int and wire["a"] in allowed_assets, f"{label} asset not bound to fresh Core meta")
    require(type(wire["b"]) is bool and type(wire["r"]) is bool, f"{label} boolean fields invalid")
    require(decimal_string(wire["p"], f"{label}.p") > 0, f"{label}.p must be positive")
    require(decimal_string(wire["s"], f"{label}.s") > 0, f"{label}.s must be positive")
    exact_keys(wire["t"], {"limit"}, f"{label}.t")
    exact_keys(wire["t"]["limit"], {"tif"}, f"{label}.t.limit")
    require(wire["t"]["limit"]["tif"] in {"Gtc", "Alo", "Ioc"}, f"{label} tif forbidden")
    require(isinstance(wire["c"], str) and re.fullmatch(r"0x[0-9a-f]{32}", wire["c"]) is not None, f"{label} cloid invalid")
    require(wire["c"] not in seen_cloids, f"{label} cloid duplicated")
    seen_cloids.add(wire["c"])


def validate_exchange_examples(examples: dict, *, allowed_assets: set[int]) -> None:
    require(set(examples) == EXCHANGE_ACTIONS - {"approveAgent"}, "fixture Exchange action coverage changed")
    seen_cloids: set[str] = set()
    order = examples["order"]
    exact_keys(order, {"type", "orders", "grouping"}, "order action")
    require(order["type"] == "order" and order["grouping"] == "na" and len(order["orders"]) == 1, "order envelope widened")
    validate_order_wire(order["orders"][0], allowed_assets=allowed_assets, seen_cloids=seen_cloids, label="order wire")
    require(order["orders"][0]["t"]["limit"]["tif"] == "Ioc", "fixture market order must be final reviewed IOC")

    modify = examples["modify"]
    exact_keys(modify, {"type", "oid", "order"}, "modify action")
    require(modify["type"] == "modify" and type(modify["oid"]) is int, "modify identity invalid")
    validate_order_wire(modify["order"], allowed_assets=allowed_assets, seen_cloids=seen_cloids, label="modify wire")

    batch = examples["batchModify"]
    exact_keys(batch, {"type", "modifies"}, "batchModify action")
    require(batch["type"] == "batchModify" and isinstance(batch["modifies"], list) and batch["modifies"], "batchModify invalid")
    for index, item in enumerate(batch["modifies"]):
        exact_keys(item, {"oid", "order"}, f"batchModify[{index}]")
        require(type(item["oid"]) is int, "batchModify oid invalid")
        validate_order_wire(item["order"], allowed_assets=allowed_assets, seen_cloids=seen_cloids, label=f"batchModify[{index}].order")

    cancel = examples["cancel"]
    exact_keys(cancel, {"type", "cancels"}, "cancel action")
    require(cancel["type"] == "cancel" and cancel["cancels"], "cancel invalid")
    for item in cancel["cancels"]:
        exact_keys(item, {"a", "o"}, "cancel item")
        require(type(item["a"]) is int and item["a"] in allowed_assets and type(item["o"]) is int, "cancel item invalid")

    cancel_cloid = examples["cancelByCloid"]
    exact_keys(cancel_cloid, {"type", "cancels"}, "cancelByCloid action")
    require(cancel_cloid["type"] == "cancelByCloid" and cancel_cloid["cancels"], "cancelByCloid invalid")
    for item in cancel_cloid["cancels"]:
        exact_keys(item, {"asset", "cloid"}, "cancelByCloid item")
        require(item["asset"] in allowed_assets and re.fullmatch(r"0x[0-9a-f]{32}", item["cloid"]), "cancelByCloid item invalid")

    leverage = examples["updateLeverage"]
    exact_keys(leverage, {"type", "asset", "isCross", "leverage"}, "updateLeverage")
    require(leverage["type"] == "updateLeverage" and leverage["asset"] in allowed_assets and type(leverage["leverage"]) is int, "leverage action invalid")
    margin = examples["updateIsolatedMargin"]
    exact_keys(margin, {"type", "asset", "isBuy", "ntli"}, "updateIsolatedMargin")
    require(margin["type"] == "updateIsolatedMargin" and margin["asset"] in allowed_assets and type(margin["ntli"]) is int, "margin action invalid")
    schedule = examples["scheduleCancel"]
    exact_keys(schedule, {"type", "time"}, "scheduleCancel")
    require(schedule["type"] == "scheduleCancel" and type(schedule["time"]) is int, "schedule cancel invalid")


def normalized_repository_path(value, label: str) -> str:
    require(type(value) is str, f"{label} must be a regular string")
    require(value and value == value.strip(), f"{label} must be nonempty canonical text")
    require("\\" not in value, f"{label} contains a backslash")
    require(not value.startswith("/"), f"{label} must be repository-relative")
    require("//" not in value, f"{label} contains a duplicate separator")
    require("*" not in value, f"{label} must be an exact file path, not a glob")
    parts = value.split("/")
    require(all(part not in {"", ".", ".."} for part in parts), f"{label} contains an empty or dot segment")
    require(all(re.fullmatch(r"[A-Za-z0-9._-]+", part) is not None for part in parts), f"{label} contains forbidden path syntax")
    normalized = "/".join(parts)
    require(normalized == value, f"{label} is not normalized")
    return normalized


def canonical_owner_roots(owns, label: str) -> list[str]:
    require(isinstance(owns, list) and owns, f"{label} must be a nonempty list")
    roots = []
    for index, pattern in enumerate(owns):
        require(type(pattern) is str, f"{label}[{index}] must be a regular string")
        require(pattern.endswith("/**") and pattern.count("*") == 2, f"{label}[{index}] must be one exact recursive prefix")
        roots.append(normalized_repository_path(pattern[:-3], f"{label}[{index}] root"))
    require(len(set(roots)) == len(roots), f"{label} contains duplicate roots")
    for index, left in enumerate(roots):
        for right in roots[index + 1:]:
            require(not left.startswith(right + "/") and not right.startswith(left + "/"), f"{label} contains overlapping roots {left!r} and {right!r}")
    return roots


def validate_artifact_pins(contract_dir: Path) -> None:
    require(set(EXPECTED_CONTRACT_ARTIFACTS) == EXPECTED_TREE, "artifact pin inventory drift")
    for relative, expected in EXPECTED_CONTRACT_ARTIFACTS.items():
        exact_keys(expected, {"size", "sha256"}, f"artifact pin {relative}")
        payload = (contract_dir / relative).read_bytes()
        require(len(payload) == expected["size"], f"contract artifact size drift: {relative}")
        require(hashlib.sha256(payload).hexdigest() == expected["sha256"], f"contract artifact digest drift: {relative}")


def validate_target_inventory(inventory: dict, implementation_plan: str) -> None:
    exact_keys(inventory, {"schema_version", "authority", "catalog_path", "slice_id", "profiles", "owner_order", "targets"}, "target inventory")
    require(inventory["schema_version"] == "loop.hyperliquid-perp.target-inventory/v10", "target inventory schema drift")
    require(inventory["authority"] == "sole_machine_readable_implementation_target_owner_order_root", "target inventory authority drift")
    require(inventory["catalog_path"] == "contracts/integration-catalog/implementation-slices.json", "target inventory catalog path drift")
    require(inventory["slice_id"] == "hyperliquid_core_perp", "target inventory slice drift")
    require(inventory["profiles"] == ["perp_market_readonly", "perp_trading_mutations"], "target inventory profiles drift")
    roots = canonical_owner_roots(inventory["owner_order"], "target inventory owner order")
    require(len(roots) == 4, "target inventory must declare exactly four owners")

    targets = inventory["targets"]
    require(isinstance(targets, list) and len(targets) == 30, "target inventory must contain exactly 30 targets")
    expected_ids = [f"T{index:02d}" for index in range(1, 31)]
    resolved_paths = []
    resolved_owners = []
    for index, item in enumerate(targets):
        exact_keys(item, {"id", "path", "owner"}, f"target inventory item[{index}]")
        require(item["id"] == expected_ids[index], f"target inventory symbolic order drift at {index}")
        path = normalized_repository_path(item["path"], f"target inventory item[{index}] path")
        require(item["owner"] in inventory["owner_order"], f"target inventory item[{index}] owner is undeclared")
        matches = [owner for owner, root in zip(inventory["owner_order"], roots) if path.startswith(root + "/")]
        require(matches == [item["owner"]], f"target inventory item[{index}] must resolve to its exact owner")
        resolved_paths.append(path)
        resolved_owners.append(item["owner"])
    require(len(set(resolved_paths)) == 30, "target inventory contains duplicate paths")
    require([resolved_owners.count(owner) for owner in inventory["owner_order"]] == [14, 2, 6, 8], "target inventory owner distribution drift")
    expected_owner_order = [owner for owner, count in zip(inventory["owner_order"], [14, 2, 6, 8]) for _ in range(count)]
    require(resolved_owners == expected_owner_order, "target inventory target owner order drift")
    require(TARGET_ID_DIRECTIVE_RE.findall(implementation_plan) == expected_ids, "implementation plan symbolic target sequence drift")


def validate_catalog_ownership(root: Path, inventory: dict, implementation_plan: str, *, require_catalog: bool) -> str:
    validate_target_inventory(inventory, implementation_plan)
    catalog_path = root / inventory["catalog_path"]
    if not catalog_path.exists():
        require(not require_catalog, "merge-context integration catalog is required")
        return "embedded_candidate_fixture"

    catalog = load_json(catalog_path)
    require(catalog.get("schema_version") == "loop.integration-slices/v2", "integration catalog schema drift")
    slices = [item for item in catalog.get("slices", []) if item.get("id") == inventory["slice_id"]]
    require(len(slices) == 1, "integration catalog Hyperliquid slice must be unique")
    canonical_slice = slices[0]
    canonical_owner_roots(canonical_slice.get("owns"), "integration catalog Hyperliquid ownership")
    require(canonical_slice.get("owns") == inventory["owner_order"], "integration catalog Hyperliquid ownership drift")
    require(canonical_slice.get("profiles") == inventory["profiles"], "integration catalog Hyperliquid profile drift")
    require("contracts/hyperliquid-core-perp/**" in canonical_slice["owns"], "canonical contract path is not owned")
    return "merge_context_catalog"


def validate(root: Path, *, require_catalog: bool = False) -> dict[str, str | int]:
    contract_dir = root / "contracts" / "hyperliquid-core-perp"
    require(contract_dir.is_dir(), "contracts/hyperliquid-core-perp is missing")
    actual_tree = {
        path.relative_to(contract_dir).as_posix()
        for path in contract_dir.rglob("*")
        if path.is_file()
    }
    require(actual_tree == EXPECTED_TREE, f"exact contract tree changed: {sorted(actual_tree ^ EXPECTED_TREE)}")
    for path in contract_dir.rglob("*"):
        require(not path.is_symlink(), f"symlink forbidden: {path}")
    validate_artifact_pins(contract_dir)

    contract = load_json(contract_dir / "contract.json")
    exact_keys(
        contract,
        {
            "schema_version",
            "implementation_inventory",
            "authority",
            "execution_ownership",
            "trading_eligibility",
            "market_scope",
            "runtime",
            "networks",
            "transport",
            "signing",
            "operations",
            "order_schema",
            "market_order_review",
            "builder_policy",
            "websocket",
            "rate_limits",
            "errors",
            "reconciliation",
            "status_policy",
            "numeric_rules",
            "r0_acceptance",
        },
        "contract",
    )
    require(contract["schema_version"] == "loop.hyperliquid-perp.contract/v10", "schema version drift")
    require(contract["implementation_inventory"] == {
        "path": "contracts/hyperliquid-core-perp/target-inventory.json",
        "schema_version": "loop.hyperliquid-perp.target-inventory/v10",
        "authority": "sole_machine_readable_implementation_target_owner_order_root",
    }, "contract implementation inventory reference drift")
    inventory = load_json(contract_dir / "target-inventory.json")
    implementation_plan = (contract_dir / "implementation-plan.md").read_text(encoding="utf-8")
    catalog_evidence = validate_catalog_ownership(
        root,
        inventory,
        implementation_plan,
        require_catalog=require_catalog,
    )

    authority = contract["authority"]
    require(authority["perp_source_of_truth"] == "Hyperliquid", "Hyperliquid must remain the only Perp authority")
    require(authority["wallet_and_signing_source_of_truth"] == "Privy", "Privy must remain wallet/signing authority")
    require(authority["loop_role"] == "presentation_orchestration_policy_only", "LOOP role broadened")
    require(authority["forbidden_reimplementations"] == ["matching", "market_data", "positions", "settlement", "signing"], "forbidden infrastructure changed")

    ownership = contract["execution_ownership"]
    require(ownership == {
        "sdk_nonce_scope": "globalNonceManager and semaphore are process-local only",
        "required_topology": "one protected executor and one durable input queue per distinct Privy agent address and Hyperliquid network; no warm or concurrent signer-capable standby",
        "executor_identity": "each executor receives a distinct Privy agent address that is never reused by any replacement",
        "queue_lease_scope": "a lease may select the queue consumer only; it cannot revoke signer access, fence an ExchangeClient, or prove the old process stopped",
        "automatic_failover": "forbidden",
        "replacement_gate": "terminate old infrastructure; owner revokes old Hyperliquid agent authorization; Privy revokes old agent signing authority; credentialed negative signing probe proves an old-instance request is rejected by Privy; reconcile unknown actions; only then start a replacement with a new distinct agent address",
        "unproven_replacement": "operator_hold_no_new_executor_no_trading",
        "pause_after_check": "any second instance, ownership ambiguity, or signer-capable process observed after a queue check pauses all SDK calls and enters operator hold",
        "forbidden": ["application lease claimed as provider or signer fence", "automatic or concurrent failover", "agent address reuse", "LOOP nonce generation", "cross-process use of SDK globalNonceManager as coordination"],
    }, "protected executor/replacement contract changed")

    eligibility = contract["trading_eligibility"]
    require(eligibility == {
        "status": "PENDING_default_deny",
        "production_mutation_scope": "every Hyperliquid /exchange action and every Privy/owner or agent signer request, including order, cancel, modify, leverage, margin, agent authorization, withdrawal, transfer, and funding mutations",
        "read_only_scope": "public Info and market WebSocket reads are separately scoped and can never enable a signer, Exchange action, account mutation, or funds movement",
        "required_decisions": ["jurisdiction", "sanctions", "product_availability", "age_or_entity_eligibility", "provider_terms"],
        "authoritative_evidence_fields": ["decision", "evidence_ref", "policy_version", "checked_at_ms", "expires_at_ms"],
        "approved_evidence": "every required decision is exact approved with nonempty authoritative evidence_ref and policy_version, integer checked_at_ms/expires_at_ms, checked_at_ms <= now_ms < expires_at_ms",
        "deny_states": ["missing", "PENDING", "unknown", "denied", "stale", "malformed", "evidence_unavailable"],
        "enforcement": "one mandatory pre-SDK production mutation gate evaluates the exact user, account, jurisdiction, product, action, provider terms, and evidence versions; no ExchangeClient or Privy signing call occurs unless all technical and eligibility gates approve",
        "r0_result": "all production mutations blocked; no eligibility evidence has been approved",
    }, "regional/legal/trading eligibility gate changed")

    market_scope = contract["market_scope"]
    require(market_scope == {
        "mode": "core_perps_only",
        "dex": "",
        "core_coin_allowlist": ["BTC", "ETH", "SOL"],
        "meta_max_age_ms": 60000,
        "asset_binding": "asset index and coin must come from the same fresh Core meta universe snapshot and immutable allowlist",
        "info_dex_rule": "every Info request that accepts dex must send the exact empty string",
        "coin_rule": "reject colon-prefixed or dex-qualified coins including xyz:*",
        "forbidden_actions": sorted(FORBIDDEN_ACTIONS),
        "forbidden_features": ["HIP-3", "spot", "dex abstraction", "perp deploy", "trigger orders", "TP/SL", "TWAP"],
    }, "Core-only market scope changed")

    runtime = contract["runtime"]
    require(runtime["production"]["enabled"] is False, "R0 production must be disabled")
    require(runtime["production"]["missing_configuration"] == "fail_closed", "production must fail closed")
    require(runtime["production"]["fixture_fallback"] == "forbidden", "production may not fall back to fixtures")
    require(runtime["production"]["network_default"] is None, "production network must be explicit")
    require(runtime["production"]["credentials"] == [
        "PRIVY_APP_ID",
        "PRIVY_APP_SECRET_REF",
        "PRIVY_AGENT_WALLET_ID_REF",
        "HYPERLIQUID_ACCOUNT_ADDRESS",
        "HYPERLIQUID_NETWORK",
    ], "credential references changed")
    require(runtime["offline_html_fixture"] == {
        "enabled": True,
        "explicit_opt_in": "LOOP_OFFLINE_HYPERLIQUID_FIXTURE=1",
        "label": "Simulated Hyperliquid testnet fixture — no network, signing, or submission",
        "network_access": "forbidden",
        "signing": "forbidden",
        "submission": "forbidden",
    }, "offline fixture gate weakened")

    networks = contract["networks"]
    require(networks == {
        "mainnet": {"rest": "https://api.hyperliquid.xyz", "websocket": "wss://api.hyperliquid.xyz/ws", "l1_source": "a"},
        "testnet": {"rest": "https://api.hyperliquid-testnet.xyz", "websocket": "wss://api.hyperliquid-testnet.xyz/ws", "l1_source": "b"},
    }, "network endpoints or L1 source discriminator changed")

    transport = contract["transport"]
    require(transport == {
        "info": {"method": "POST", "path": "/info", "authentication": "none_read_only"},
        "exchange": {"method": "POST", "path": "/exchange", "authentication": "eip712_signature"},
        "websocket_path": "/ws",
        "sdk_install_allowed_at_r0": False,
        "sdk_import_allowed_at_r0": False,
    }, "transport boundary changed")

    signing = contract["signing"]
    require(signing["schemes"] == {
        "l1_actions": "msgpack action + nonce + vault marker/address + expiresAfter marker/value -> keccak -> Agent EIP-712",
        "user_signed_actions": "HyperliquidSignTransaction EIP-712 with action-specific primary type",
    }, "two signing schemes must remain distinct")
    require(signing["implementation"] == "pinned @nktkas/hyperliquid SDK only, using Privy-backed wallet accounts; LOOP never encodes, hashes, or signs", "custom signing implementation introduced")
    require(signing["l1_domain"] == {"name": "Exchange", "version": "1", "chain_id": 1337, "verifying_contract": "0x0000000000000000000000000000000000000000"}, "L1 signing domain changed")
    require(signing["user_domain"] == {"name": "HyperliquidSignTransaction", "version": "1", "chain_id_source": "signatureChainId", "verifying_contract": "0x0000000000000000000000000000000000000000"}, "user signing domain changed")
    require(signing["canonicalization"] == ["preserve_field_order", "lowercase_addresses", "no_trailing_zero_normalization_after_review", "bind_nonce_vault_and_expires_after"], "signing canonicalization weakened")
    require(set(signing["owner_wallet_only"]) == OWNER_ONLY, "owner-only action boundary changed")
    require(set(signing["agent_wallet_allowed"]) == AGENT_ALLOWED, "agent action boundary changed")
    require(signing["privy_boundary"]["owner_wallet"] == "Privy user-owned wallet or connected external wallet", "owner wallet boundary changed")
    require(signing["privy_boundary"]["agent_wallet"] == "Privy-managed embedded EVM wallet registered by owner", "agent wallet boundary changed")
    require(signing["privy_boundary"]["private_key_visibility"] == "never visible to LOOP", "private key boundary weakened")
    require(signing["nonce"]["scope"] == "per signer, shared across master/subaccount/vault targets", "nonce scope changed")
    require(signing["nonce"]["manager"] == "pinned @nktkas/hyperliquid ExchangeClient globalNonceManager with its per-wallet-and-network request lock", "SDK nonce manager boundary changed")
    require(signing["nonce"]["loop_role"] == "one long-lived ExchangeClient inside one protected executor per distinct agent address/network; never generate, increment, persist, override, or reuse nonces", "custom nonce management introduced")
    require(signing["nonce"]["reuse_after_deregister_or_expiry"] == "forbidden; provision a new address", "nonce replay protection weakened")
    require(signing["nonce"]["window"] == "Hyperliquid retains the 100 highest nonces; each new nonce must be unused and greater than the smallest retained", "nonce window changed")
    require(signing["query_address"] == "master_or_subaccount_address_never_agent_address", "account queries must never use agent address")

    operations = contract["operations"]
    require(set(operations["info"]) == INFO_OPERATIONS, "Info API coverage changed")
    require(set(operations["exchange"]) == EXCHANGE_ACTIONS, "Exchange API coverage changed")
    require(operations["market_order_semantics"] == "aggressive_limit_with_Ioc", "market order semantics changed")
    require(operations["time_in_force"] == ["Gtc", "Alo", "Ioc"], "time-in-force set changed")
    require(operations["client_order_id"] == "required unique 128-bit lowercase hex for every order, modify replacement, and batchModify replacement", "cloid reconciliation boundary changed")
    require(operations["positions_source"] == "clearinghouseState.assetPositions", "position authority changed")
    require(operations["fills_source"] == "userFillsByTime plus userFills websocket", "fill authority changed")
    require(operations["funding_source"] == "userFunding/fundingHistory plus userFundings websocket", "funding authority changed")
    require(operations["liquidation_source"] == "userEvents.liquidation plus clearinghouseState reconciliation", "liquidation authority changed")
    require(operations["decimal_policy"] == "provider decimal strings only; never IEEE-754 arithmetic for prices, sizes, margin, PnL, funding, or liquidation", "money arithmetic weakened")

    order_schema = contract["order_schema"]
    require(order_schema == {
        "order_action_keys": ["type", "orders", "grouping"],
        "order_wire_keys": ["a", "b", "p", "s", "r", "t", "c"],
        "limit_type_keys": ["limit"],
        "limit_keys": ["tif"],
        "time_in_force": ["Gtc", "Alo", "Ioc"],
        "grouping": "na",
        "cloid": "required unique lowercase 0x plus 32 hex digits",
        "builder_field": "forbidden",
        "priority_field": "forbidden",
        "unknown_fields": "reject",
        "forbidden_order_types": ["trigger", "tp", "sl", "FrontendMarket", "normalTpsl", "positionTpsl"],
    }, "nested order schema changed")

    market_review = contract["market_order_review"]
    require(market_review == {
        "source": "fresh provider bbo or l2Book message from pinned SDK",
        "max_source_age_ms": 2000,
        "max_slippage_percent_cap": "1.00",
        "source_revision_policy": {
            "authority": "LOOP adapter-generated identity, never a provider field",
            "tuple": ["subscription_epoch", "monotonic_arrival_sequence", "raw_message_sha256"],
            "subscription_epoch": "new opaque epoch on every reconnect",
            "arrival_sequence": "strictly increasing for every raw message within one subscription epoch before normalization",
            "raw_message_sha256": "sha256 of the exact raw WebSocket message UTF-8 bytes before normalization",
            "same_timestamp": "messages sharing provider time remain distinct when sequence or digest differs",
        },
        "canonical_quote_parser": {
            "authority": "one strict exact-decimal parser consumes the exact hashed SDK-delivered raw frame and atomically emits source kind, coin, provider time, bid/ask price, size, and level count",
            "accepted_provider_frames": ["bbo data.bbo[bid,ask]", "l2Book data.levels[bid,ask] top level"],
            "unknown_or_malformed": "reject before normalization or review",
            "schema_non_interchangeability": "channel bbo requires only data.bbo semantics; channel l2Book requires only data.levels semantics; no relabeling or cross-parser fallback",
            "correlation": "one synchronous immutable envelope per SDK-delivered raw frame before any await; never join raw and normalized records by coin, provider time, callback order, or latest cache",
            "normalized_digest": "sha256 of UTF-8 RFC8259 JSON with lexicographically sorted object keys, no insignificant whitespace, and provider decimal strings preserved exactly",
            "source_envelope_digest": "sha256 of canonical provider, network, subscription epoch, arrival sequence, raw-message sha256, source kind, coin, provider time, and normalized bid/ask price, size, and count",
            "transport_gate": "PENDING until the pinned SDK transport exposes the exact raw frame and atomic callback correlation; no parallel WebSocket or custom feed is allowed",
        },
        "price_policy": {
            "implementation": "thin adapter over mature decimal.js only after complete dependency lock; never delegate both sides to SDK ROUND_DOWN",
            "dependency_gate": "PENDING full transitive version/source/integrity/license lock blocks production",
            "buy_bounds": "ask <= final_ioc_limit_px <= ask * (1 + slippage_percent / 100)",
            "sell_bounds": "bid * (1 - slippage_percent / 100) <= final_ioc_limit_px <= bid",
            "grid_rule": "same fresh Core meta plus official tick and significant-digit constraints",
            "rounding": "buy chooses greatest valid grid price at or below upper bound; sell chooses least valid grid price at or above lower bound; reject if rounding no longer crosses BBO",
            "zero_liquidity": "reject buy without ask and sell without bid",
        },
        "bind_fields": ["account_address", "provider", "network", "dex", "coin", "asset", "meta_snapshot_digest", "meta_fetched_at_ms", "subscription_epoch", "source_revision", "source_time_ms", "source_kind", "normalized_quote_sha256", "source_envelope_sha256", "bid_px", "bid_sz", "ask_px", "ask_sz", "side", "size", "max_slippage_percent", "final_ioc_limit_px"],
        "structural_identity_invariant": "review.coin == normalized_quote.coin == fresh_core_meta.coin == order_intent.coin; review.source_kind == normalized_quote.source_kind == raw subscription channel; review/order asset == fresh Core meta asset; provider/network/epoch/sequence/raw hash/source kind/coin/provider time/normalized prices and sizes are committed by source_envelope_sha256 before IOC calculation",
        "final_order": "immutable reviewed order_intent carries coin and asset; Hyperliquid wire carries the same asset index, exact-decimal price/size, tif Ioc, and grouping na",
        "decimal_rule": "BBO prices, size, max slippage, and final IOC limit are decimal strings; no IEEE-754",
        "invalidate_on": ["disconnect", "subscription_epoch_change", "source_stale", "meta_stale", "adapter_source_revision_change", "account_change", "input_change"],
        "re_review": "every invalidation requires a new provider snapshot and a new owner review",
    }, "market-order review binding changed")

    builder = contract["builder_policy"]
    require(builder == {
        "r0_enabled": False,
        "r0_builder_address": None,
        "r0_fee_tenths_of_basis_point": None,
        "order_builder_field": "reject",
        "approve_builder_fee_action": "reject",
        "future_enablement_gate": "new owner-approved audit with exact lowercase LOOP address, exact fee cap, main-wallet approval, maxBuilderFee and approvedBuilders readback, credentialed testnet evidence, and new mutations",
    }, "R0 builder prohibition changed")

    websocket = contract["websocket"]
    require(set(websocket["market_subscriptions"]) == MARKET_STREAMS, "market stream coverage changed")
    require(set(websocket["user_subscriptions"]) == USER_STREAMS, "user stream coverage changed")
    require(websocket["snapshot_delta"] == "SDK subscription payloads are authoritative; time-series snapshots precede events per subscription; each l2Book message replaces the displayed book atomically; never reconstruct an orderbook from trades or custom diffs", "snapshot/orderbook rule changed")
    require(websocket["reconnect"] == "exponential_backoff_with_jitter_then_resubscribe_and_reconcile_via_Info", "reconnect rule changed")
    require(websocket["heartbeat"] == "send ping before 60s idle timeout; reconnect on missed pong or close", "heartbeat rule changed")
    require(websocket["dedupe_keys"] == {
        "fills": ["hash", "tid"],
        "orders": ["oid", "status", "statusTimestamp"],
        "funding": ["time", "coin", "usdc"],
        "liquidation": ["account_address", "network", "lid"],
    }, "stream dedupe keys changed")
    require(websocket["liquidation_raw_schema"] == ["lid", "liquidator", "liquidated_user", "liquidated_ntl_pos", "liquidated_account_value"], "raw liquidation schema changed")
    require(websocket["liquidation_ui_rule"] == "show only raw aggregate liquidation values; per-coin rows require provider fills and clearinghouse readback; never invent time, coin, or szi", "liquidation presentation boundary changed")
    require(websocket["ordering"] == "partition by subscription key; reject older epoch; stable-sort snapshot rows by provider timestamp then provider id; never invent global ordering", "ordering rule changed")
    require(websocket["gap_policy"] == "mark stale, disable mutations dependent on stale state, fetch authoritative Info snapshots, then resume", "stream gap policy weakened")

    limits = contract["rate_limits"]
    require(limits == {
        "rest_weight_per_ip_per_minute": 1200,
        "exchange_weight": "1 + floor(batch_length / 40)",
        "info_weight_2": ["l2Book", "allMids", "clearinghouseState", "orderStatus", "spotClearinghouseState", "exchangeStatus"],
        "other_documented_info_weight": 20,
        "websocket_connections_per_ip": 10,
        "websocket_new_connections_per_minute": 30,
        "websocket_subscriptions_per_ip": 1000,
        "websocket_unique_users_per_ip": 10,
        "pre_sdk_unique_user_gate": "ten distinct users allowed; eleventh distinct user rejected before SDK subscribe",
        "sdk_known_drift": "@nktkas/hyperliquid v0.33.2 hard-codes 15 unique users; LOOP enforces current official 10 first",
        "websocket_messages_sent_per_minute": 2000,
        "websocket_inflight_posts": 100,
        "client_policy": "central token buckets by IP and signer; queue or fail before provider; Retry-After else exponential backoff with jitter; never retry signed mutation blindly",
    }, "rate-limit contract changed")

    errors = contract["errors"]
    require(errors["classes"] == ["validation", "provider_rejection", "rate_limited", "transport", "unknown_submission", "stale_state", "auth_or_policy", "configuration"], "error classes changed")
    require(errors["batch_shape"] == "accept either one pre-validation error for the whole batch or one status per item", "batch error handling weakened")
    require(errors["provider_status_ok_may_contain_item_errors"] is True, "nested item errors must be inspected")
    require(errors["unknown_submission"] == "freeze affected intent; do not resubmit; run the action-specific reconciliation policy; future nonce handling remains inside the pinned SDK", "unknown submission safety changed")
    require("terminal_order_statuses" not in errors, "legacy unscoped status list forbidden")

    reconciliation = contract["reconciliation"]
    require(reconciliation["required_after"] == ["startup", "websocket_reconnect", "unknown_submission", "timeout", "rate_limit_after_send", "provider_5xx_after_send", "process_restart"], "reconciliation triggers changed")
    require(set(reconciliation["reads"]) == RECONCILE_READS, "reconciliation reads changed")
    require(reconciliation["submission_identity"] == "account_address + network + action_kind + required cloid for order replacements or oid for cancels + immutable_review_intent_digest + opaque_adapter_request_id", "submission identity changed")
    require(reconciliation["state_precedence"] == "Info/Exchange confirmed terminal state > websocket delta > local pending; local state never fabricates fills, positions, funding, liquidation, or settlement", "state precedence weakened")
    require(reconciliation["retention"] == "persist intent digest and non-secret identifiers; never persist signatures, Privy authorization keys, app secret, or agent private key", "secret retention boundary weakened")
    require(reconciliation["per_action"] == {
        "order": "required unique cloid -> orderStatus by cloid + openOrders + userFillsByTime + clearinghouseState",
        "modify": "replacement required unique cloid -> orderStatus by cloid + openOrders + userFillsByTime + clearinghouseState",
        "batchModify": "every replacement required unique cloid -> reconcile every cloid independently; whole batch remains held until all items resolve",
        "cancel": "oid -> orderStatus + openOrders; unknownOid stays quarantined until fills/readback or operator decision",
        "cancelByCloid": "cloid -> orderStatus + openOrders + userFillsByTime",
        "approveAgent": "extraAgents readback for exact agent address/name/validUntil",
        "updateLeverage": "clearinghouseState exact coin leverage type/value readback",
        "updateIsolatedMargin": "clearinghouseState exact coin isolated margin and position fields readback",
        "scheduleCancel": "operator_hold_no_auto_retry because no authoritative schedule read endpoint",
        "approveBuilderFee_future_only": "maxBuilderFee plus approvedBuilders readback; disabled in R0",
    }, "action-specific reconciliation changed")

    status_policy = contract["status_policy"]
    require(status_policy == {
        "scope": "Core perpetual non-trigger limit orders only",
        "nonterminal": ["open"],
        "terminal": sorted(CORE_TERMINAL_ORDER_STATUSES),
        "excluded_provider_statuses": sorted(EXCLUDED_PROVIDER_STATUSES),
        "excluded_reason": "trigger/TP-SL, vault, or spot status outside the approved R0 action schema",
        "unknown_status": "quarantine and operator review; never coerce to success, failure, or terminal",
        "unknown_oid": "quarantine and reconcile fills/open orders/positions; never treat as proof the action was absent",
    }, "Core status policy changed")

    numeric_rules = contract["numeric_rules"]
    require(numeric_rules == {
        "wire_prices_and_sizes": "exact decimal strings validated against meta.szDecimals and official tick/lot rules",
        "isolated_margin_ntli": "signed integer in 1e-6 USDC units",
        "leverage": "integer bounded by metadata maxLeverage and position margin mode",
        "market_ioc_rounding": "mature decimal.js thin policy after full dependency lock: buy rounds toward lower aggression and sell toward lower aggression, then both revalidate crossing and slippage; SDK uniform ROUND_DOWN is forbidden",
    }, "numeric contract changed")

    acceptance = contract["r0_acceptance"]
    require(acceptance == {
        "credentialed_network_calls": "not_run_credentials_later",
        "sdk": "evaluated_and_pinned_not_installed_or_imported",
        "production": "disabled_fail_closed",
        "html": "explicit_offline_fixture_only",
        "go_live_gate": {
            "all_required": True,
            "required_evidence": ["credentialed testnet", "official SDK vectors", "Privy policy audit", "protected single-executor topology", "old infrastructure termination", "owner agent revocation", "Privy negative signing rejection", "no automatic failover", "buy/sell IOC boundary tests", "raw-to-normalized source-revision tests", "action-specific unknown-submission", "10/11 user gate", "websocket reconnect", "full dependency lock", "regional/legal/trading eligibility authoritative current approval", "independent review", "owner approval"],
            "production_mutation_enablement": "the single pre-SDK technical and eligibility gate must approve every action; unknown, missing, pending, stale, malformed, or denied evidence blocks order, cancel, account mutation, signing, and funds movement",
            "read_only_independence": "public market data may pass a separately approved read-only gate that has no path to ExchangeClient or Privy signing",
        },
    }, "R0 acceptance changed")

    fixture = load_json(contract_dir / "fixtures" / "offline-r0.json")
    require(fixture["fixture_schema"] == "loop.hyperliquid-perp.offline-fixture/v10", "fixture schema changed")
    require(fixture["mode"] == "offline_html_fixture", "fixture must be offline-only")
    require(fixture["label"] == runtime["offline_html_fixture"]["label"], "fixture label drift")
    require(fixture["public_test_data"] is True and fixture["network_requests"] == 0, "fixture provenance weakened")
    require(fixture["signatures"] == "omitted" and fixture["credentials"] == "omitted", "fixture may not contain signatures or credentials")
    require(fixture["network"] == "testnet", "offline fixture must be visibly testnet")
    require(fixture["account_address"] != fixture["agent_address"], "account and agent addresses must be distinct")
    require(fixture["query_address"] == fixture["account_address"], "fixture query uses agent address")
    eligibility_evidence = fixture["trading_eligibility_evidence"]
    require(set(eligibility_evidence) == set(eligibility["required_decisions"]), "eligibility evidence coverage changed")
    for name in eligibility["required_decisions"]:
        evidence = eligibility_evidence[name]
        exact_keys(evidence, set(eligibility["authoritative_evidence_fields"]), f"eligibility evidence {name}")
        require(evidence == {"decision": "PENDING", "evidence_ref": None, "policy_version": None, "checked_at_ms": None, "expires_at_ms": None}, f"R0 eligibility evidence {name} must remain PENDING")
    require(fixture["production_mutation_gate"] == {"technical_gate": "PENDING", "eligibility_gate": "PENDING_default_deny", "decision": "deny_before_sdk_or_privy", "sdk_calls": 0, "privy_signing_calls": 0}, "fixture production mutation gate weakened")
    require(fixture["eligibility_gate_cases"] == [
        {"case": "missing_jurisdiction_order", "capability": "production_mutation", "action": "order", "evidence_state": "missing", "decision": "deny_before_sdk_or_privy"},
        {"case": "unknown_sanctions_cancel", "capability": "production_mutation", "action": "cancel", "evidence_state": "unknown", "decision": "deny_before_sdk_or_privy"},
        {"case": "stale_product_modify", "capability": "production_mutation", "action": "modify", "evidence_state": "stale", "decision": "deny_before_sdk_or_privy"},
        {"case": "denied_terms_withdraw", "capability": "production_mutation", "action": "withdraw", "evidence_state": "denied", "decision": "deny_before_sdk_or_privy"},
        {"case": "approved_eligibility_technical_pending", "capability": "production_mutation", "action": "order", "evidence_state": "all_approved_current", "decision": "deny_before_sdk_or_privy"},
        {"case": "public_market_read_pending_eligibility", "capability": "read_only_market_data", "action": "bbo", "evidence_state": "PENDING", "decision": "separate_read_only_gate_only"},
    ], "eligibility default-deny cases changed")
    require(fixture["execution_owner"] == {"executor_id": "fixture-executor-a", "agent_address": fixture["agent_address"], "topology": "single_protected_executor", "queue_mode": "durable_single_consumer", "automatic_failover": "forbidden", "state": "active"}, "fixture execution ownership invalid")
    execution_cases = fixture["execution_cases"]
    require(execution_cases == [
        {"case": "dual_instance_same_agent", "agent_address": fixture["agent_address"], "second_instance_signer_access": "forbidden", "decision": "operator_hold_no_trading"},
        {"case": "second_instance_pause_after_queue_check", "first_executor": "fixture-executor-a", "first_queue_check": "passed_then_paused", "second_instance_detected": True, "privy_old_agent_rejection_proven": False, "decision": "operator_hold_no_sdk_call_no_replacement"},
        {"case": "replacement_unproven", "old_infrastructure_terminated": True, "owner_revocation_confirmed": False, "privy_negative_signing_probe": "pending", "decision": "operator_hold_no_new_executor_no_trading"},
        {"case": "replacement_after_authoritative_revocation", "old_executor": "fixture-executor-a", "old_agent": fixture["agent_address"], "old_infrastructure_terminated": True, "owner_revocation_confirmed": True, "privy_negative_signing_probe": "rejected_by_privy", "new_executor": "fixture-executor-b", "new_agent": "0x4444444444444444444444444444444444444444", "agent_address_reused": False, "decision": "allow_new_executor_after_reconcile"},
    ], "protected-executor/replacement fixtures weakened")
    require(fixture["info_request_scope"] == {"dex": "", "meta_snapshot_id": "core-meta-fixture-v2", "fetched_at_ms": 1777000000000, "expires_at_ms": 1777000060000}, "fixture Core Info scope invalid")
    require(fixture["market"]["meta"]["dex"] == "" and fixture["market"]["meta"]["snapshot_id"] == fixture["info_request_scope"]["meta_snapshot_id"], "fixture meta scope mismatch")
    require(fixture["market"]["meta"]["coin"] in market_scope["core_coin_allowlist"] and ":" not in fixture["market"]["meta"]["coin"], "fixture coin outside Core allowlist")
    allowed_assets = {fixture["market"]["meta"]["asset"]}
    validate_exchange_examples(fixture["exchange_examples"], allowed_assets=allowed_assets)
    require(set(fixture["user_state"]) == {"positions", "open_orders", "fills", "fundings", "liquidations"}, "fixture state coverage changed")
    require(len(fixture["user_state"]["liquidations"]) == 1, "fixture liquidation count changed")
    liquidation = fixture["user_state"]["liquidations"][0]
    exact_keys(liquidation, {"lid", "liquidator", "liquidated_user", "liquidated_ntl_pos", "liquidated_account_value"}, "raw liquidation")
    require(type(liquidation["lid"]) is int, "liquidation lid invalid")
    require(re.fullmatch(r"0x[0-9a-f]{40}", liquidation["liquidator"]) is not None, "liquidator invalid")
    require(re.fullmatch(r"0x[0-9a-f]{40}", liquidation["liquidated_user"]) is not None, "liquidated user invalid")
    require(decimal_string(liquidation["liquidated_ntl_pos"], "liquidated_ntl_pos") >= 0, "liquidated notional invalid")
    require(decimal_string(liquidation["liquidated_account_value"], "liquidated_account_value", signed=True).is_finite(), "liquidated account value invalid")
    require(fixture["liquidation_ui"] == {"aggregate_source": "raw userEvents.liquidation", "per_coin_rows_source": "provider fills plus clearinghouse readback only", "invented_fields": []}, "liquidation UI provenance weakened")

    gate_attempts = fixture["subscription_gate_attempts"]
    require(len(gate_attempts) == 12, "10/11 user gate fixture count changed")
    distinct: set[str] = set()
    for index, attempt in enumerate(gate_attempts):
        exact_keys(attempt, {"user", "decision"}, f"subscription gate attempt {index}")
        require(re.fullmatch(r"0x[0-9a-f]{40}", attempt["user"]) is not None, "subscription gate user invalid")
        is_new = attempt["user"] not in distinct
        expected_decision = "reject_before_sdk" if is_new and len(distinct) >= 10 else "allow"
        require(attempt["decision"] == expected_decision, f"subscription user gate failed at attempt {index + 1}")
        if expected_decision == "allow":
            distinct.add(attempt["user"])
    require(len(distinct) == 10 and gate_attempts[-1]["decision"] == "allow", "existing user must remain allowed after 10 distinct users")

    review = fixture["market_order_review"]
    exact_keys(review, set(market_review["bind_fields"]) | {"reviewed_at_ms"}, "market order review")
    require(review["account_address"] == fixture["account_address"] and review["provider"] == "hyperliquid" and review["network"] == "testnet" and review["dex"] == "", "market review context invalid")
    require(review["coin"] == fixture["market"]["meta"]["coin"] and review["asset"] in allowed_assets, "market review asset binding invalid")
    require(review["meta_fetched_at_ms"] == fixture["info_request_scope"]["fetched_at_ms"], "market review meta timestamp mismatch")
    source_messages = fixture["source_messages"]
    require(len(source_messages) == 4, "source identity fixture count changed")
    for index, message in enumerate(source_messages):
        exact_keys(message, {"subscription_epoch", "monotonic_arrival_sequence", "raw_message_utf8", "raw_message_sha256", "provider_time", "source_kind", "source_revision", "normalized_quote", "normalized_quote_sha256", "source_envelope_sha256"}, f"source message {index}")
        require(message["raw_message_sha256"] == sha256_text(message["raw_message_utf8"]), f"source message {index} digest mismatch")
        require(message["source_revision"] == {"subscription_epoch": message["subscription_epoch"], "monotonic_arrival_sequence": message["monotonic_arrival_sequence"], "raw_message_sha256": message["raw_message_sha256"]}, f"source message {index} tuple mismatch")
        derived_quote = canonical_quote_from_raw(message["raw_message_utf8"], f"source message {index}")
        require(message["normalized_quote"] == derived_quote, f"source message {index} raw-to-normalized quote mismatch")
        require(message["normalized_quote_sha256"] == canonical_json_sha256(derived_quote), f"source message {index} normalized digest mismatch")
        require(message["source_envelope_sha256"] == canonical_json_sha256(canonical_source_envelope(message, fixture["network"])), f"source message {index} envelope digest mismatch")
        require(message["provider_time"] == derived_quote["provider_time"] and message["source_kind"] == derived_quote["source_kind"], f"source message {index} raw identity mismatch")
    require(source_messages[0]["provider_time"] == source_messages[1]["provider_time"], "same-millisecond source case missing")
    require(source_messages[0]["monotonic_arrival_sequence"] < source_messages[1]["monotonic_arrival_sequence"] and source_messages[0]["raw_message_sha256"] != source_messages[1]["raw_message_sha256"], "same-time messages must retain distinct sequence and digest")
    require(source_messages[2]["source_kind"] == "l2Book" and source_messages[2]["monotonic_arrival_sequence"] > source_messages[1]["monotonic_arrival_sequence"], "l2Book canonical parser case missing")
    require(source_messages[3]["subscription_epoch"] != source_messages[2]["subscription_epoch"] and source_messages[3]["monotonic_arrival_sequence"] == 1, "reconnect must create a new epoch and sequence")
    correlation_cases = fixture["source_correlation_cases"]
    require([case["case"] for case in correlation_cases] == ["same_atomic_envelope", "reordered_sdk_callback", "latest_cache_same_millisecond"], "source correlation cases changed")
    for case in correlation_cases:
        exact_keys(case, {"case", "raw_source_revision", "normalized_source_revision", "decision"}, f"source correlation {case['case']}")
        same_envelope = case["raw_source_revision"] == case["normalized_source_revision"]
        require(case["decision"] == ("allow_review" if same_envelope else "reject_before_review"), f"source correlation {case['case']} did not fail closed")
    review_source = source_messages[0]
    require(review["source_time_ms"] == review_source["provider_time"] and review["source_revision"] == review_source["source_revision"], "market review adapter source identity binding invalid")
    require(review["normalized_quote_sha256"] == review_source["normalized_quote_sha256"], "market review normalized digest binding invalid")
    require(review["source_envelope_sha256"] == review_source["source_envelope_sha256"], "market review source envelope digest binding invalid")
    require(review["provider"] == "hyperliquid" and review["network"] == fixture["network"], "market review provider/network binding invalid")
    require(review["coin"] == review_source["normalized_quote"]["coin"] == fixture["market"]["meta"]["coin"], "raw/normalized/review/meta coin binding invalid")
    require(review["source_kind"] == review_source["normalized_quote"]["source_kind"] == review_source["source_kind"], "raw/normalized/review source-kind binding invalid")
    for field in ("bid_px", "bid_sz", "ask_px", "ask_sz"):
        require(review[field] == review_source["normalized_quote"][field], f"market review {field} not derived from raw frame")
    require(fixture["market"]["bbo"] == {"time": review_source["normalized_quote"]["provider_time"], "bid_px": review["bid_px"], "bid_sz": review["bid_sz"], "bid_n": review_source["normalized_quote"]["bid_n"], "ask_px": review["ask_px"], "ask_sz": review["ask_sz"], "ask_n": review_source["normalized_quote"]["ask_n"]}, "display BBO not bound to canonical normalized quote")
    require(review["reviewed_at_ms"] - review["source_time_ms"] <= market_review["max_source_age_ms"], "market review source stale")
    require(review["source_kind"] in {"bbo", "l2Book"} and review["subscription_epoch"] == review_source["subscription_epoch"] == "fixture-epoch-1", "market review source invalid")
    require(review["side"] == "buy", "fixture review side changed")
    size = decimal_string(review["size"], "review size")
    slippage = decimal_string(review["max_slippage_percent"], "review slippage")
    final_px = decimal_string(review["final_ioc_limit_px"], "review final IOC")
    ask_px = decimal_string(review["ask_px"], "review raw-derived ask")
    require(size > 0 and Decimal("0") <= slippage <= Decimal(market_review["max_slippage_percent_cap"]), "review size/slippage invalid")
    require(final_px >= ask_px and ((final_px / ask_px) - Decimal("1")) * Decimal("100") <= slippage, "final IOC exceeds reviewed slippage")
    require(final_px == floor_to_tick(ask_px * (Decimal("1") + slippage / Decimal("100")), Decimal("0.1")), "reviewed buy IOC must use less-aggressive valid Core grid price")
    order_wire = fixture["exchange_examples"]["order"]["orders"][0]
    order_intent = fixture["order_intent"]
    exact_keys(order_intent, {"provider", "network", "dex", "coin", "asset", "source_kind", "source_envelope_sha256", "side", "size", "final_ioc_limit_px"}, "order intent")
    require(order_intent == {
        "provider": review["provider"],
        "network": review["network"],
        "dex": review["dex"],
        "coin": review["coin"],
        "asset": review["asset"],
        "source_kind": review["source_kind"],
        "source_envelope_sha256": review["source_envelope_sha256"],
        "side": review["side"],
        "size": review["size"],
        "final_ioc_limit_px": review["final_ioc_limit_px"],
    }, "review-to-order intent structural binding invalid")
    require(order_intent["coin"] == review["coin"] == review_source["normalized_quote"]["coin"] == fixture["market"]["meta"]["coin"], "order/review/normalized/meta coin binding invalid")
    require(order_intent["asset"] == review["asset"] == fixture["market"]["meta"]["asset"] == order_wire["a"], "order/review/meta/wire asset binding invalid")
    require(order_wire["p"] == review["final_ioc_limit_px"] and order_wire["s"] == review["size"], "final IOC not immutable-review bound")

    binding_cases = fixture["independent_coin_binding_fixtures"]
    require([case["case"] for case in binding_cases] == ["primary_eth_bbo", "independent_btc_l2book"], "independent coin binding fixtures changed")
    for case in binding_cases:
        exact_keys(case, {"case", "record_id", "source_record_id", "review_source_record_id", "order_review_record_id", "provider", "network", "raw_coin", "normalized_coin", "review_coin", "meta_coin", "order_coin", "raw_source_kind", "normalized_source_kind", "review_source_kind", "meta_asset", "order_asset", "decision"}, f"coin binding case {case['case']}")
        same_record = case["record_id"] == case["source_record_id"] == case["review_source_record_id"] == case["order_review_record_id"]
        same_coin = case["raw_coin"] == case["normalized_coin"] == case["review_coin"] == case["meta_coin"] == case["order_coin"]
        same_kind = case["raw_source_kind"] == case["normalized_source_kind"] == case["review_source_kind"]
        valid_context = case["provider"] == "hyperliquid" and case["network"] == "testnet" and case["meta_asset"] == case["order_asset"]
        require(case["decision"] == ("allow_independent_record" if same_record and same_coin and same_kind and valid_context else "reject_cross_record"), f"coin binding case {case['case']} decision invalid")

    policy_cases = fixture["market_order_policy_cases"]
    require([item["case"] for item in policy_cases] == ["buy_boundary", "sell_boundary", "buy_cross_tick_no_safe_price", "sell_cross_tick_no_safe_price", "buy_significant_digit_boundary", "zero_buy_liquidity", "zero_sell_liquidity", "stale_source"], "market IOC policy cases changed")
    for case in policy_cases:
        exact_keys(case, {"case", "side", "bid_px", "ask_px", "slippage_percent", "tick_size", "source_time_ms", "reviewed_at_ms", "final_ioc_limit_px", "decision"}, f"policy case {case['case']}")
        slippage = decimal_string(case["slippage_percent"], f"{case['case']} slippage")
        tick = decimal_string(case["tick_size"], f"{case['case']} tick")
        require(tick > 0 and Decimal("0") <= slippage <= Decimal(market_review["max_slippage_percent_cap"]), f"{case['case']} tick/slippage invalid")
        required_quote = case["ask_px"] if case["side"] == "buy" else case["bid_px"]
        stale = case["reviewed_at_ms"] - case["source_time_ms"] > market_review["max_source_age_ms"]
        if required_quote is None or stale:
            require(case["decision"] == "reject" and case["final_ioc_limit_px"] is None, f"{case['case']} must reject")
            continue
        quote = decimal_string(required_quote, f"{case['case']} quote")
        if case["side"] == "buy":
            upper = quote * (Decimal("1") + slippage / Decimal("100"))
            expected = floor_to_tick(upper, tick)
            safe = expected >= quote
        else:
            require(case["side"] == "sell", f"{case['case']} side invalid")
            lower = quote * (Decimal("1") - slippage / Decimal("100"))
            expected = ceil_to_tick(lower, tick)
            safe = expected <= quote
        if not safe:
            require(case["decision"] == "reject" and case["final_ioc_limit_px"] is None, f"{case['case']} must reject after conservative rounding")
            continue
        actual = decimal_string(case["final_ioc_limit_px"], f"{case['case']} final IOC")
        require(case["decision"] == "allow" and actual == expected, f"{case['case']} conservative grid conversion changed")
    require(fixture["websocket_sequence"][0]["isSnapshot"] is True, "first stream event must be a snapshot")
    require(all(item["epoch"] == "fixture-epoch-1" for item in fixture["websocket_sequence"]), "fixture epoch drift")
    require(all(item["isSnapshot"] is False for item in fixture["websocket_sequence"][1:]), "post-snapshot events must be deltas")
    liquidation_events = [item for item in fixture["websocket_sequence"] if item["channel"] == "userEvents"]
    require(liquidation_events and liquidation_events[0]["items"][0] == {"liquidation": liquidation}, "raw liquidation stream fixture drift")

    oss_lock = load_json(contract_dir / "oss-lock.json")
    exact_keys(oss_lock, {"schema_version", "selected_runtime_candidate", "official_reference_sdk", "source_oracles", "price_arithmetic_candidate", "dependency_graph", "upgrade_gate"}, "OSS lock")
    require(oss_lock["schema_version"] == "loop.hyperliquid-perp.oss-lock/v4", "OSS lock schema drift")
    selected = oss_lock["selected_runtime_candidate"]
    require(selected == {
        "package": "@nktkas/hyperliquid",
        "version": "0.33.2",
        "repository": "https://github.com/nktkas/hyperliquid",
        "commit": "65431f93edadc9bc3e17502c107b694bf373db34",
        "license": "MIT",
        "license_sha256": "dc69b5f489b78ff65d128fe457f39b0e8d1d707d84e23beafe6a6a16209c38e7",
        "npm_integrity": "sha512-6Jf7USFst6DDI8/5VQjsRJMZLQJJURGIGtVZeXjnsW9II3brfkAPsdS90Z+DhLuC+iTugTb7qwqUuYp6/aCtqQ==",
        "npm_tarball_sha256": "ef7e9f1425e43b8ac9f537e1ac210cd47b3a3dd56838b81ba7794709a1107f86",
        "runtime": "Node.js >=22.12.0, ESM-only",
        "pin_scope": "top_level_package_only",
        "status": "top_level_candidate_pinned_not_installed_runtime_graph_not_locked",
    }, "selected OSS pin changed")
    official = oss_lock["official_reference_sdk"]
    require(official == {
        "package": "hyperliquid-python-sdk",
        "version": "0.24.0",
        "repository": "https://github.com/hyperliquid-dex/hyperliquid-python-sdk",
        "commit": "2fdb18f9517675ea03695a0962bd19eece9c83f0",
        "release_archive_sha256": "18e489f3432da8357a6bd0aa9ccfd057fbc1674a027c0a82e75c79ae67bf5381",
        "signing_py_sha256": "938ec0a1f9611874b423ca946696e19a71d32d14709f521ea5d526f4398c0b85",
        "exchange_py_sha256": "0bd885c5b64fd77893db58d4982b0d24e92b5be5036d0e9d6d05c40a1812d432",
        "info_py_sha256": "fc36d225a2b865d474e5682ad4f095d9917e84ef5dba9c80de3d4600467f4882",
        "websocket_manager_py_sha256": "1382a63068488932a1b9e4995e3a9807f3bf0e68ac71c7cd022edb3fea126b87",
        "status": "read_only_conformance_oracle_not_installed",
    }, "official SDK reference pin changed")
    require(oss_lock["source_oracles"] == {
        "nonce_ts_sha256": "5e93b8ff2ee6cf7ee70d29392a5254f81fa50865d3c0fe8569a011438086ff41",
        "exchange_shell_ts_sha256": "26deed9a14fb4b3cbfee232d3e64b4d329b912d36ed247f2435ddb920a6d24bc",
        "subscription_manager_ts_sha256": "1ef6f6afb3161744d68ceab5d2d64daa706426fa977db27239c7619dff0c3700",
        "user_events_ts_sha256": "c512e1f7024052e955da50e25ac6fc5c55b4928aba5df2ad787c57cb49323850",
        "order_ts_sha256": "27c361bd9e6d9f3d6c9f548a2c1ae9a29e717cd9cddefaa91f35ea6b84e06650",
        "deno_json_sha256": "c28dcc1af8b606a1fdf7c499052276bdf3c3ba2b99aa53fa053805534ebad74d",
    }, "community SDK source oracle changed")
    require(oss_lock["price_arithmetic_candidate"] == {
        "package": "decimal.js",
        "declared_range": "^10.6.0",
        "role": "thin exact-decimal market IOC boundary and Core price-grid policy only",
        "status": "PENDING_full_transitive_lock_integrity_and_license_gate",
        "production": "blocked",
    }, "price arithmetic dependency gate changed")
    require(oss_lock["dependency_graph"] == {
        "status": "PENDING_full_lockfile_transitive_integrity_and_license_audit_before_implementation",
        "runtime_graph_locked": False,
        "declared_ranges": {
            "@nktkas/rews": "^4.1.0",
            "@noble/hashes": "^2.2.0",
            "@std/async/unstable-semaphore": "1.5.0",
            "@std/msgpack/encode": "^1.0.3",
            "@valibot/valibot": "^1.4.2",
            "decimal.js": "^10.6.0",
        },
        "implementation_gate": "generate committed complete lockfile; pin every transitive version/source/integrity; collect every license; deny mutable ranges or missing integrity; rerun source and semantic mutations",
    }, "dependency graph honesty/gate changed")
    require(oss_lock["upgrade_gate"] == "fail closed until complete dependency graph lock; then review upstream diff, license, release provenance, signing and nonce ownership, API schemas, Core-only action allowlist, limits, reconnect behavior, semantic mutations, and credentialed testnet evidence", "OSS upgrade gate weakened")

    combined = "\n".join((contract_dir / name).read_text(encoding="utf-8") for name in sorted(EXPECTED_TREE))
    forbidden = ["@nktkas/hyperliquid';", '@nktkas/hyperliquid";', "npm install", "pnpm add", "yarn add", "Bun.add", "PRIVATE KEY", "BEGIN PRIVATE"]
    require(not any(token in combined for token in forbidden), "SDK install/import or secret material found")
    require("not production-ready" in (contract_dir / "README.md").read_text(encoding="utf-8"), "R0 honesty label missing")
    require("credentials later" in (contract_dir / "README.md").read_text(encoding="utf-8"), "credential gate disclosure missing")
    require("unknown submission" in (contract_dir / "implementation-plan.md").read_text(encoding="utf-8").lower(), "implementation plan lacks unknown-submission drill")
    require("cannot fence" in combined and "automatic failover" in combined, "application lease/failover limitation disclosure missing")
    require("adapter-generated" in combined and "raw_message_sha256" in combined, "adapter source-revision provenance missing")
    require("PENDING_default_deny" in combined and "before Hyperliquid SDK or Privy" in combined, "eligibility fail-closed disclosure missing")
    require("canonical strict parser" in combined or "strict parser" in combined, "raw-to-normalized parser disclosure missing")
    require("buy" in combined and "sell" in combined and "ROUND_DOWN" in combined, "two-sided IOC rounding boundary missing")
    digests = {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(contract_dir.rglob("*"))
        if path.is_file()
    }
    return {"files": len(actual_tree), "tree_sha256": hashlib.sha256(json.dumps(digests, sort_keys=True).encode()).hexdigest(), "catalog_evidence": catalog_evidence}


def set_document_path(root: Path, relative: str, path: tuple[str | int, ...], value) -> None:
    target = root / "contracts" / "hyperliquid-core-perp" / relative
    document = load_json(target)
    cursor = document
    for key in path[:-1]:
        cursor = cursor[key]
    cursor[path[-1]] = value
    target.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def set_path(root: Path, path: tuple[str | int, ...], value) -> None:
    set_document_path(root, "contract.json", path, value)


def set_fixture_path(root: Path, path: tuple[str | int, ...], value) -> None:
    set_document_path(root, "fixtures/offline-r0.json", path, value)


def set_lock_path(root: Path, path: tuple[str | int, ...], value) -> None:
    set_document_path(root, "oss-lock.json", path, value)


def set_inventory_path(root: Path, path: tuple[str | int, ...], value) -> None:
    set_document_path(root, "target-inventory.json", path, value)


def replace_plan_text(root: Path, old: str, new: str) -> None:
    target = root / "contracts" / "hyperliquid-core-perp" / "implementation-plan.md"
    content = target.read_text(encoding="utf-8")
    require(old in content, f"plan mutation source missing: {old}")
    target.write_text(content.replace(old, new, 1), encoding="utf-8")


def append_plan_text(root: Path, value: str) -> None:
    target = root / "contracts" / "hyperliquid-core-perp" / "implementation-plan.md"
    target.write_text(target.read_text(encoding="utf-8") + value, encoding="utf-8")


def retain_one_plan_target_for_owner(root: Path, owner_index: int) -> None:
    inventory = load_json(root / "contracts" / "hyperliquid-core-perp" / "target-inventory.json")
    owner = inventory["owner_order"][owner_index]
    target_ids = [item["id"] for item in inventory["targets"] if item["owner"] == owner]
    target = root / "contracts" / "hyperliquid-core-perp" / "implementation-plan.md"
    lines = target.read_text(encoding="utf-8").splitlines(keepends=True)
    matching = [index for index, line in enumerate(lines) if any(line.startswith(f"- Target {target_id}:") for target_id in target_ids)]
    require(len(matching) > 1, f"plan retention mutation needs multiple targets for owner {owner}")
    kept = matching[0]
    target.write_text("".join(line for index, line in enumerate(lines) if index == kept or index not in matching), encoding="utf-8")


def write_catalog_fixture(root: Path, *, ownership_drift: bool = False, profile_drift: bool = False, ownership_overlap: bool = False) -> None:
    inventory = load_json(root / "contracts" / "hyperliquid-core-perp" / "target-inventory.json")
    owns = copy.deepcopy(inventory["owner_order"])
    profiles = copy.deepcopy(inventory["profiles"])
    if ownership_drift:
        owns[0] = "server/perp/**"
    if ownership_overlap:
        owns.append("server/integrations/hyperliquid/core/internal/**")
    if profile_drift:
        profiles[0] = "perp_all"
    target = root / inventory["catalog_path"]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({
        "schema_version": "loop.integration-slices/v2",
        "ordering": "candidate merge-context fixture",
        "slices": [{
            "id": inventory["slice_id"],
            "owns": owns,
            "profiles": profiles,
        }],
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def set_source_identity(root: Path, index: int, field: str, value) -> None:
    target = root / "contracts" / "hyperliquid-core-perp" / "fixtures" / "offline-r0.json"
    document = load_json(target)
    document["source_messages"][index][field] = value
    document["source_messages"][index]["source_revision"][field] = value
    target.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def mutate_raw_bbo_with_synced_revision(root: Path, index: int, path: tuple[str | int, ...], value) -> None:
    target = root / "contracts" / "hyperliquid-core-perp" / "fixtures" / "offline-r0.json"
    document = load_json(target)
    message = document["source_messages"][index]
    raw = parse_raw_json(message["raw_message_utf8"], f"mutation source {index}")
    cursor = raw
    for key in path[:-1]:
        cursor = cursor[key]
    cursor[path[-1]] = value
    message["raw_message_utf8"] = json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
    digest = sha256_text(message["raw_message_utf8"])
    message["raw_message_sha256"] = digest
    message["source_revision"]["raw_message_sha256"] = digest
    if document["market_order_review"]["source_revision"]["subscription_epoch"] == message["subscription_epoch"] and document["market_order_review"]["source_revision"]["monotonic_arrival_sequence"] == message["monotonic_arrival_sequence"]:
        document["market_order_review"]["source_revision"]["raw_message_sha256"] = digest
    target.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def set_review_and_wire_ioc(root: Path, value: str) -> None:
    target = root / "contracts" / "hyperliquid-core-perp" / "fixtures" / "offline-r0.json"
    document = load_json(target)
    document["market_order_review"]["final_ioc_limit_px"] = value
    document["exchange_examples"]["order"]["orders"][0]["p"] = value
    target.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def mutate_normalized_with_synced_records(root: Path, index: int, field: str, value) -> None:
    target = root / "contracts" / "hyperliquid-core-perp" / "fixtures" / "offline-r0.json"
    document = load_json(target)
    message = document["source_messages"][index]
    message["normalized_quote"][field] = value
    digest = canonical_json_sha256(message["normalized_quote"])
    message["normalized_quote_sha256"] = digest
    if index == 0:
        document["market_order_review"][field] = value
        document["market_order_review"]["normalized_quote_sha256"] = digest
        document["market"]["bbo"][field] = value
    target.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def synchronize_primary_source_coin(root: Path, coin: str, *, sync_review: bool) -> None:
    target = root / "contracts" / "hyperliquid-core-perp" / "fixtures" / "offline-r0.json"
    document = load_json(target)
    message = document["source_messages"][0]
    raw = parse_raw_json(message["raw_message_utf8"], "synchronized cross-coin mutation")
    raw["data"]["coin"] = coin
    message["raw_message_utf8"] = json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
    message["raw_message_sha256"] = sha256_text(message["raw_message_utf8"])
    message["source_revision"]["raw_message_sha256"] = message["raw_message_sha256"]
    message["normalized_quote"] = canonical_quote_from_raw(message["raw_message_utf8"], "synchronized cross-coin mutation")
    message["normalized_quote_sha256"] = canonical_json_sha256(message["normalized_quote"])
    message["source_envelope_sha256"] = canonical_json_sha256(canonical_source_envelope(message, document["network"]))
    review = document["market_order_review"]
    review["source_revision"] = dict(message["source_revision"])
    review["normalized_quote_sha256"] = message["normalized_quote_sha256"]
    review["source_envelope_sha256"] = message["source_envelope_sha256"]
    if sync_review:
        review["coin"] = coin
    target.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_mutations(root: Path) -> int:
    mutations = [
        ("candidate canonical server owner drift", lambda r: set_inventory_path(r, ("owner_order", 0), "server/perp/**")),
        ("candidate canonical contract owner drift", lambda r: set_inventory_path(r, ("owner_order", 2), "contracts/hyperliquid-perp/**")),
        ("candidate canonical profile drift", lambda r: set_inventory_path(r, ("profiles", 0), "perp_all")),
        ("implementation plan symbolic id drift", lambda r: replace_plan_text(r, "- Target T01:", "- Target T99:")),
        ("integration catalog server owner drift", lambda r: write_catalog_fixture(r, ownership_drift=True)),
        ("integration catalog profile drift", lambda r: write_catalog_fixture(r, profile_drift=True)),
        ("candidate implementation inventory drift", lambda r: set_inventory_path(r, ("targets", 0, "path"), "server/rogue/hyperliquid-config.ts")),
        ("inventory single server file rogue", lambda r: set_inventory_path(r, ("targets", 5, "path"), "server/rogue/hyperliquid-info.ts")),
        ("inventory single client file rogue", lambda r: set_inventory_path(r, ("targets", 14, "path"), "lib/rogue/hyperliquid-dtos.ts")),
        ("inventory single test file rogue", lambda r: set_inventory_path(r, ("targets", 24, "path"), "test/rogue/info-and-core-scope.test.ts")),
        ("inventory single contract file rogue", lambda r: set_inventory_path(r, ("targets", 21, "path"), "contracts/rogue/sources.md")),
        ("inventory similar owner prefix", lambda r: set_inventory_path(r, ("targets", 4, "path"), "server/integrations/hyperliquid/corex/hyperliquid-client.ts")),
        ("inventory parent dot segment", lambda r: set_inventory_path(r, ("targets", 8, "path"), "server/integrations/hyperliquid/core/../rogue.ts")),
        ("inventory current dot segment", lambda r: set_inventory_path(r, ("targets", 15, "path"), "lib/integrations/hyperliquid/core/./hyperliquid-risk-notice.ts")),
        ("inventory absolute path", lambda r: set_inventory_path(r, ("targets", 28, "path"), "/test/conformance/hyperliquid/contract-mutations.test.ts")),
        ("inventory backslash path", lambda r: set_inventory_path(r, ("targets", 16, "path"), "contracts\\hyperliquid-core-perp\\README.md")),
        ("inventory duplicate separator", lambda r: set_inventory_path(r, ("targets", 9, "path"), "server/integrations/hyperliquid//core/hyperliquid-policy.ts")),
        ("inventory wildcard target", lambda r: set_inventory_path(r, ("targets", 29, "path"), "test/conformance/hyperliquid/*.test.ts")),
        ("plan untracked plain rogue path", lambda r: append_plan_text(r, "\nUntracked implementation target: server/rogue/untracked.ts\n")),
        ("plan untracked src path", lambda r: append_plan_text(r, "\nUntracked future file `src/rogue-hidden.js` must also be built.\n")),
        ("plan untracked extensionless src path", lambda r: append_plan_text(r, "\nUntracked future file src/rogue must also be built.\n")),
        ("plan untracked tmp path without code ticks", lambda r: append_plan_text(r, "\nUntracked future file _tmp/rogue.py must also be built.\n")),
        ("plan untracked docs path with punctuation", lambda r: append_plan_text(r, "\nDo not forget (docs/rogue.md), either.\n")),
        ("plan untracked Markdown-link destination", lambda r: append_plan_text(r, "\nSee [rogue plan](docs/rogue-link.md) before release.\n")),
        ("plan untracked table path", lambda r: append_plan_text(r, "\n| Future target | src/table-rogue.ts |\n")),
        ("plan untracked scripts path without code ticks", lambda r: append_plan_text(r, "\nBuild scripts/rogue.ts during integration.\n")),
        ("plan percent encoded separator", lambda r: append_plan_text(r, "\nHidden target src%2Frogue.ts is required.\n")),
        ("plan double percent encoded separator", lambda r: append_plan_text(r, "\nHidden target src%252Frogue.ts is required.\n")),
        ("plan percent encoded parent segment", lambda r: append_plan_text(r, "\nHidden target src/%2e%2e/rogue.ts is required.\n")),
        ("plan plain current dot segment outside roots", lambda r: append_plan_text(r, "\nHidden target src/./rogue.ts is required.\n")),
        ("plan plain parent dot segment outside roots", lambda r: append_plan_text(r, "\nHidden target docs/../rogue.md is required.\n")),
        ("plan backslash outside roots", lambda r: append_plan_text(r, "\nHidden target src\\rogue.ts is required.\n")),
        ("plan duplicate exact target hidden in prose", lambda r: append_plan_text(r, "\nRepeat server/integrations/hyperliquid/core/hyperliquid-config.ts later.\n")),
        ("plan backticked semantic-looking agent path", lambda r: append_plan_text(r, "\nBuild the untracked file `agent/network` during integration.\n")),
        ("plan backticked semantic-looking locks path", lambda r: append_plan_text(r, "\nBuild the untracked file `locks/licenses` during integration.\n")),
        ("plan backticked scoped-looking repository path", lambda r: append_plan_text(r, "\nBuild the untracked file `@src/rogue.ts` during integration.\n")),
        ("plan Markdown semantic-looking path", lambda r: append_plan_text(r, "\nSee [untracked target](agent/network) before integration.\n")),
        ("plan table scoped-looking repository path", lambda r: append_plan_text(r, "\n| Untracked target | `@src/rogue.ts` |\n")),
        ("plan encoded semantic-looking path", lambda r: append_plan_text(r, "\nBuild agent%2Fnetwork during integration.\n")),
        ("plan encoded scoped-looking path", lambda r: append_plan_text(r, "\nBuild @src%2Frogue.ts during integration.\n")),
        ("plan raw approved package outside declaration context", lambda r: append_plan_text(r, "\nBuild `@nktkas/hyperliquid` as a repository path.\n")),
        ("plan raw approved semantic outside declaration context", lambda r: append_plan_text(r, "\nBuild `BBO/l2Book` as a repository path.\n")),
        ("plan duplicate approved package declaration", lambda r: append_plan_text(r, "\n[[npm:@nktkas/hyperliquid@0.33.2]]\n")),
        ("plan fake semantic declaration", lambda r: append_plan_text(r, "\n[[semantic:agent/network]]\n")),
        ("plan URL followed by Markdown rogue path", lambda r: append_plan_text(r, "\nhttps://api.hyperliquid.xyz/info/path?q=a%2Fb | [rogue](docs/url-adjacent-rogue.md)\n")),
        ("plan HTML comment split path", lambda r: append_plan_text(r, "\nsrc/<!-- -->rogue.ts\n")),
        ("plan slash entity path", lambda r: append_plan_text(r, "\nsrc&#47;rogue.ts\n")),
        ("plan ASCII slash zero-width split", lambda r: append_plan_text(r, "\nsrc/\u200brogue.ts\n")),
        ("plan fullwidth slash path", lambda r: append_plan_text(r, "\nsrc／rogue.ts\n")),
        ("plan division slash path", lambda r: append_plan_text(r, "\nsrc∕rogue.ts\n")),
        ("plan percent-u slash path", lambda r: append_plan_text(r, "\nsrc%u002Frogue.ts\n")),
        ("plan HTML comment marker path", lambda r: append_plan_text(r, "\n<!-- src/rogue.ts -->\n")),
        ("plan fenced marker path", lambda r: append_plan_text(r, "\n```text\nsrc/rogue.ts\n```\n")),
        ("plan entity inside Markdown link", lambda r: append_plan_text(r, "\n[rogue](src&#47;rogue.ts)\n")),
        ("plan Unicode path inside table", lambda r: append_plan_text(r, "\n| target | src／rogue.ts |\n")),
        ("plan copied canonical path", lambda r: append_plan_text(r, "\nserver/integrations/hyperliquid/core/hyperliquid-config.ts\n")),
        ("plan migrated target path into prose", lambda r: append_plan_text(r, "\nMoved target T01 to src/rogue.ts.\n")),
        ("plan retains only one server owner id", lambda r: retain_one_plan_target_for_owner(r, 0)),
        ("plan retains only one client owner id", lambda r: retain_one_plan_target_for_owner(r, 1)),
        ("plan retains only one test owner id", lambda r: retain_one_plan_target_for_owner(r, 3)),
        ("plan retains only one contract owner id", lambda r: retain_one_plan_target_for_owner(r, 2)),
        ("integration catalog overlapping owner", lambda r: write_catalog_fixture(r, ownership_overlap=True)),
        ("mainnet endpoint", lambda r: set_path(r, ("networks", "mainnet", "rest"), "https://evil.invalid")),
        ("production enabled", lambda r: set_path(r, ("runtime", "production", "enabled"), True)),
        ("fixture fallback", lambda r: set_path(r, ("runtime", "production", "fixture_fallback"), "allowed")),
        ("fixture opt-in", lambda r: set_path(r, ("runtime", "offline_html_fixture", "explicit_opt_in"), "automatic")),
        ("Perp authority", lambda r: set_path(r, ("authority", "perp_source_of_truth"), "LOOP")),
        ("wallet authority", lambda r: set_path(r, ("authority", "wallet_and_signing_source_of_truth"), "LOOP")),
        ("SDK import", lambda r: set_path(r, ("transport", "sdk_import_allowed_at_r0"), True)),
        ("signing schemes", lambda r: set_path(r, ("signing", "schemes"), {"all": "personal_sign"})),
        ("custom signing", lambda r: set_path(r, ("signing", "implementation"), "LOOP encoder")),
        ("agent withdrawal", lambda r: set_path(r, ("signing", "agent_wallet_allowed"), sorted(AGENT_ALLOWED | {"withdraw3"}))),
        ("query with agent", lambda r: set_path(r, ("signing", "query_address"), "agent_address")),
        ("nonce reuse", lambda r: set_path(r, ("signing", "nonce", "reuse_after_deregister_or_expiry"), "allowed")),
        ("custom nonce", lambda r: set_path(r, ("signing", "nonce", "loop_role"), "LOOP allocator")),
        ("multi owner", lambda r: set_path(r, ("execution_ownership", "required_topology"), "many active owners")),
        ("lease claims signer fence", lambda r: set_path(r, ("execution_ownership", "queue_lease_scope"), "lease fences old signer process")),
        ("reused agent replacement", lambda r: set_path(r, ("execution_ownership", "executor_identity"), "replacement may reuse agent")),
        ("automatic failover", lambda r: set_path(r, ("execution_ownership", "automatic_failover"), "allowed")),
        ("replacement without proof", lambda r: set_path(r, ("execution_ownership", "unproven_replacement"), "allow_new_executor")),
        ("pause-after-check continues", lambda r: set_path(r, ("execution_ownership", "pause_after_check"), "continue after queue check")),
        ("eligibility falsely ready", lambda r: set_path(r, ("trading_eligibility", "status"), "READY")),
        ("eligibility omits sanctions", lambda r: set_path(r, ("trading_eligibility", "required_decisions"), ["jurisdiction", "product_availability", "age_or_entity_eligibility", "provider_terms"])),
        ("eligibility stale allowed", lambda r: set_path(r, ("trading_eligibility", "deny_states"), ["missing", "PENDING", "unknown", "denied", "malformed", "evidence_unavailable"])),
        ("eligibility bypasses SDK", lambda r: set_path(r, ("trading_eligibility", "enforcement"), "check after submission")),
        ("read-only signer path", lambda r: set_path(r, ("trading_eligibility", "read_only_scope"), "read-only may enable ExchangeClient")),
        ("go-live omits eligibility", lambda r: set_path(r, ("r0_acceptance", "go_live_gate", "required_evidence"), [item for item in ["credentialed testnet", "official SDK vectors", "Privy policy audit", "protected single-executor topology", "old infrastructure termination", "owner agent revocation", "Privy negative signing rejection", "no automatic failover", "buy/sell IOC boundary tests", "raw-to-normalized source-revision tests", "action-specific unknown-submission", "10/11 user gate", "websocket reconnect", "full dependency lock", "regional/legal/trading eligibility authoritative current approval", "independent review", "owner approval"] if item != "regional/legal/trading eligibility authoritative current approval"])),
        ("HIP3 dex", lambda r: set_path(r, ("market_scope", "dex"), "xyz")),
        ("HIP3 coin", lambda r: set_path(r, ("market_scope", "coin_rule"), "allow xyz:*")),
        ("dex abstraction", lambda r: set_path(r, ("market_scope", "forbidden_actions"), sorted(FORBIDDEN_ACTIONS - {"agentSetAbstraction"}))),
        ("stale meta", lambda r: set_path(r, ("market_scope", "meta_max_age_ms"), 600000)),
        ("missing order action", lambda r: set_path(r, ("operations", "exchange"), sorted(EXCHANGE_ACTIONS - {"order"}))),
        ("float money", lambda r: set_path(r, ("operations", "decimal_policy"), "IEEE-754")),
        ("optional cloid", lambda r: set_path(r, ("operations", "client_order_id"), "optional")),
        ("trigger schema", lambda r: set_path(r, ("order_schema", "limit_type_keys"), ["limit", "trigger"])),
        ("TP grouping", lambda r: set_path(r, ("order_schema", "grouping"), "normalTpsl")),
        ("builder schema", lambda r: set_path(r, ("order_schema", "builder_field"), "optional")),
        ("priority schema", lambda r: set_path(r, ("order_schema", "priority_field"), "optional")),
        ("builder enabled", lambda r: set_path(r, ("builder_policy", "r0_enabled"), True)),
        ("builder address", lambda r: set_path(r, ("builder_policy", "r0_builder_address"), "0x1111111111111111111111111111111111111111")),
        ("market review stale", lambda r: set_path(r, ("market_order_review", "max_source_age_ms"), 60000)),
        ("market review missing final IOC", lambda r: set_path(r, ("market_order_review", "bind_fields"), [item for item in ["account_address", "network", "dex", "coin", "asset", "meta_snapshot_digest", "meta_fetched_at_ms", "subscription_epoch", "source_revision", "source_time_ms", "side", "size", "max_slippage_percent", "final_ioc_limit_px"] if item != "final_ioc_limit_px"])),
        ("provider revision claim", lambda r: set_path(r, ("market_order_review", "source_revision_policy", "authority"), "provider revision field")),
        ("source revision without digest", lambda r: set_path(r, ("market_order_review", "source_revision_policy", "tuple"), ["subscription_epoch", "monotonic_arrival_sequence"])),
        ("parallel raw feed", lambda r: set_path(r, ("market_order_review", "canonical_quote_parser", "transport_gate"), "open a parallel WebSocket")),
        ("latest-cache correlation", lambda r: set_path(r, ("market_order_review", "canonical_quote_parser", "correlation"), "join raw and normalized by latest coin cache")),
        ("interchangeable BBO/l2Book parser", lambda r: set_path(r, ("market_order_review", "canonical_quote_parser", "schema_non_interchangeability"), "parse either data shape under either channel")),
        ("source envelope digest omits identity", lambda r: set_path(r, ("market_order_review", "canonical_quote_parser", "source_envelope_digest"), "sha256 normalized prices only")),
        ("structural coin invariant weakened", lambda r: set_path(r, ("market_order_review", "structural_identity_invariant"), "bind price digest only")),
        ("source kind omitted from immutable review", lambda r: set_path(r, ("market_order_review", "bind_fields"), ["account_address", "provider", "network", "dex", "coin", "asset", "meta_snapshot_digest", "meta_fetched_at_ms", "subscription_epoch", "source_revision", "source_time_ms", "normalized_quote_sha256", "source_envelope_sha256", "bid_px", "bid_sz", "ask_px", "ask_sz", "side", "size", "max_slippage_percent", "final_ioc_limit_px"])),
        ("normalized digest omitted", lambda r: set_path(r, ("market_order_review", "bind_fields"), [item for item in ["account_address", "network", "dex", "coin", "asset", "meta_snapshot_digest", "meta_fetched_at_ms", "subscription_epoch", "source_revision", "source_time_ms", "normalized_quote_sha256", "bid_px", "bid_sz", "ask_px", "ask_sz", "side", "size", "max_slippage_percent", "final_ioc_limit_px"] if item != "normalized_quote_sha256"])),
        ("uniform SDK rounding", lambda r: set_path(r, ("market_order_review", "price_policy", "implementation"), "SDK ROUND_DOWN for both sides")),
        ("sell bound omitted", lambda r: set_path(r, ("market_order_review", "price_policy", "sell_bounds"), "unchecked")),
        ("significant digit grid omitted", lambda r: set_path(r, ("market_order_review", "price_policy", "grid_rule"), "tick only")),
        ("snapshot order", lambda r: set_path(r, ("websocket", "snapshot_delta"), "deltas before snapshot")),
        ("no reconciliation reconnect", lambda r: set_path(r, ("websocket", "reconnect"), "blind reconnect")),
        ("dedupe removed", lambda r: set_path(r, ("websocket", "dedupe_keys"), {})),
        ("liquidation invented coin dedupe", lambda r: set_path(r, ("websocket", "dedupe_keys", "liquidation"), ["time", "coin", "szi"])),
        ("liquidation raw schema", lambda r: set_path(r, ("websocket", "liquidation_raw_schema"), ["time", "coin", "szi"])),
        ("liquidation UI invention", lambda r: set_path(r, ("websocket", "liquidation_ui_rule"), "derive coin and szi")),
        ("global ordering", lambda r: set_path(r, ("websocket", "ordering"), "invent global order")),
        ("stale mutations", lambda r: set_path(r, ("websocket", "gap_policy"), "keep trading")),
        ("connections limit", lambda r: set_path(r, ("rate_limits", "websocket_connections_per_ip"), 100)),
        ("SDK 15 user limit trusted", lambda r: set_path(r, ("rate_limits", "websocket_unique_users_per_ip"), 15)),
        ("no pre-SDK user gate", lambda r: set_path(r, ("rate_limits", "pre_sdk_unique_user_gate"), "SDK handles it")),
        ("blind retry", lambda r: set_path(r, ("rate_limits", "client_policy"), "retry all mutations")),
        ("nested errors", lambda r: set_path(r, ("errors", "provider_status_ok_may_contain_item_errors"), False)),
        ("unknown resubmit", lambda r: set_path(r, ("errors", "unknown_submission"), "resubmit with new nonce")),
        ("reconciliation reads", lambda r: set_path(r, ("reconciliation", "reads"), ["localCache"])),
        ("order reconcile no cloid", lambda r: set_path(r, ("reconciliation", "per_action", "order"), "openOrders only")),
        ("approve agent no readback", lambda r: set_path(r, ("reconciliation", "per_action", "approveAgent"), "assume success")),
        ("margin generic readback", lambda r: set_path(r, ("reconciliation", "per_action", "updateIsolatedMargin"), "clearinghouseState")),
        ("schedule retry", lambda r: set_path(r, ("reconciliation", "per_action", "scheduleCancel"), "auto retry")),
        ("future builder no readback", lambda r: set_path(r, ("reconciliation", "per_action", "approveBuilderFee_future_only"), "enabled")),
        ("terminal omitted", lambda r: set_path(r, ("status_policy", "terminal"), sorted(CORE_TERMINAL_ORDER_STATUSES - {"perpMaxPositionRejected"}))),
        ("trigger terminal", lambda r: set_path(r, ("status_policy", "terminal"), sorted(CORE_TERMINAL_ORDER_STATUSES | {"triggered"}))),
        ("unknown status succeeds", lambda r: set_path(r, ("status_policy", "unknown_status"), "success")),
        ("local precedence", lambda r: set_path(r, ("reconciliation", "state_precedence"), "local pending wins")),
        ("store signatures", lambda r: set_path(r, ("reconciliation", "retention"), "persist signatures")),
        ("fixture dual instance allowed", lambda r: set_fixture_path(r, ("execution_cases", 0, "decision"), "allow")),
        ("fixture pause-after-check SDK call", lambda r: set_fixture_path(r, ("execution_cases", 1, "decision"), "allow_sdk_call")),
        ("fixture unproven replacement", lambda r: set_fixture_path(r, ("execution_cases", 2, "decision"), "allow_new_executor")),
        ("fixture old agent reused", lambda r: set_fixture_path(r, ("execution_cases", 3, "new_agent"), "0x2222222222222222222222222222222222222222")),
        ("fixture pending eligibility allows order", lambda r: set_fixture_path(r, ("production_mutation_gate", "decision"), "allow")),
        ("fixture pending eligibility calls SDK", lambda r: set_fixture_path(r, ("production_mutation_gate", "sdk_calls"), 1)),
        ("fixture read-only enables mutation", lambda r: set_fixture_path(r, ("eligibility_gate_cases", 5, "decision"), "allow_exchange")),
        ("fixture nonempty dex", lambda r: set_fixture_path(r, ("info_request_scope", "dex"), "xyz")),
        ("fixture HIP3 coin", lambda r: set_fixture_path(r, ("market", "meta", "coin"), "xyz:ETH")),
        ("fixture trigger order", lambda r: set_fixture_path(r, ("exchange_examples", "order", "orders", 0, "t"), {"trigger": {"isMarket": True, "triggerPx": "3000", "tpsl": "sl"}})),
        ("fixture TP grouping", lambda r: set_fixture_path(r, ("exchange_examples", "order", "grouping"), "positionTpsl")),
        ("fixture builder field", lambda r: set_fixture_path(r, ("exchange_examples", "order", "builder"), {"b": "0x1111111111111111111111111111111111111111", "f": 10})),
        ("fixture missing cloid", lambda r: set_fixture_path(r, ("exchange_examples", "modify", "order", "c"), None)),
        ("fixture duplicate cloid", lambda r: set_fixture_path(r, ("exchange_examples", "batchModify", "modifies", 0, "order", "c"), "0x0000000000000000000000000000f002")),
        ("fixture numeric price", lambda r: set_fixture_path(r, ("exchange_examples", "order", "orders", 0, "p"), 3257.5)),
        ("fixture stale BBO", lambda r: set_fixture_path(r, ("market_order_review", "reviewed_at_ms"), 1777000005001)),
        ("fixture final IOC drift", lambda r: set_fixture_path(r, ("exchange_examples", "order", "orders", 0, "p"), "4000")),
        ("fixture cross-record IOC drift", lambda r: set_review_and_wire_ioc(r, "4000")),
        ("fixture source digest tamper", lambda r: set_source_identity(r, 0, "raw_message_sha256", "0" * 64)),
        ("fixture raw ask changed with synced revision", lambda r: mutate_raw_bbo_with_synced_revision(r, 0, ("data", "bbo", 1, "px"), "3999.9")),
        ("fixture raw bid changed with synced revision", lambda r: mutate_raw_bbo_with_synced_revision(r, 0, ("data", "bbo", 0, "px"), "3000.0")),
        ("fixture raw coin changed with synced revision", lambda r: mutate_raw_bbo_with_synced_revision(r, 0, ("data", "coin"), "BTC")),
        ("fixture raw time changed with synced revision", lambda r: mutate_raw_bbo_with_synced_revision(r, 0, ("data", "time"), 1777000001001)),
        ("fixture BBO relabeled l2Book with synced revision", lambda r: mutate_raw_bbo_with_synced_revision(r, 0, ("channel",), "l2Book")),
        ("fixture fully synced source BTC but review meta order ETH", lambda r: synchronize_primary_source_coin(r, "BTC", sync_review=False)),
        ("fixture synced source and review BTC but meta order ETH", lambda r: synchronize_primary_source_coin(r, "BTC", sync_review=True)),
        ("fixture normalized ask drift", lambda r: set_fixture_path(r, ("source_messages", 0, "normalized_quote", "ask_px"), "3999.9")),
        ("fixture synced normalized bid without raw", lambda r: mutate_normalized_with_synced_records(r, 0, "bid_px", "3000.0")),
        ("fixture review normalized ask drift", lambda r: set_fixture_path(r, ("market_order_review", "ask_px"), "3999.9")),
        ("fixture review source kind changed to l2Book", lambda r: set_fixture_path(r, ("market_order_review", "source_kind"), "l2Book")),
        ("fixture order intent coin drift", lambda r: set_fixture_path(r, ("order_intent", "coin"), "BTC")),
        ("fixture order intent source kind drift", lambda r: set_fixture_path(r, ("order_intent", "source_kind"), "l2Book")),
        ("fixture independent coin record crossed", lambda r: set_fixture_path(r, ("independent_coin_binding_fixtures", 1, "order_review_record_id"), "eth-bbo-order-1")),
        ("fixture display normalized ask drift", lambda r: set_fixture_path(r, ("market", "bbo", "ask_px"), "3999.9")),
        ("fixture reordered callback allowed", lambda r: set_fixture_path(r, ("source_correlation_cases", 1, "decision"), "allow_review")),
        ("fixture same-time sequence collision", lambda r: set_source_identity(r, 1, "monotonic_arrival_sequence", 17)),
        ("fixture reconnect epoch reuse", lambda r: set_source_identity(r, 3, "subscription_epoch", "fixture-epoch-1")),
        ("fixture buy aggressive rounding", lambda r: set_fixture_path(r, ("market_order_policy_cases", 0, "final_ioc_limit_px"), "100.7")),
        ("fixture sell aggressive rounding", lambda r: set_fixture_path(r, ("market_order_policy_cases", 1, "final_ioc_limit_px"), "99.5")),
        ("fixture buy cross-tick allowed", lambda r: set_fixture_path(r, ("market_order_policy_cases", 2, "decision"), "allow")),
        ("fixture sell cross-tick allowed", lambda r: set_fixture_path(r, ("market_order_policy_cases", 3, "decision"), "allow")),
        ("fixture significant digit boundary drift", lambda r: set_fixture_path(r, ("market_order_policy_cases", 4, "final_ioc_limit_px"), "10001")),
        ("fixture zero buy liquidity allowed", lambda r: set_fixture_path(r, ("market_order_policy_cases", 5, "decision"), "allow")),
        ("fixture zero sell liquidity allowed", lambda r: set_fixture_path(r, ("market_order_policy_cases", 6, "decision"), "allow")),
        ("fixture stale policy source allowed", lambda r: set_fixture_path(r, ("market_order_policy_cases", 7, "decision"), "allow")),
        ("fixture liquidation old schema", lambda r: set_fixture_path(r, ("user_state", "liquidations", 0), {"time": 1, "coin": "ETH", "szi": "1"})),
        ("fixture liquidation invented UI", lambda r: set_fixture_path(r, ("liquidation_ui", "invented_fields"), ["coin"])),
        ("fixture eleventh user allowed", lambda r: set_fixture_path(r, ("subscription_gate_attempts", 10, "decision"), "allow")),
        ("runtime graph falsely locked", lambda r: set_lock_path(r, ("dependency_graph", "runtime_graph_locked"), True)),
        ("dependency range omitted", lambda r: set_lock_path(r, ("dependency_graph", "declared_ranges"), {"decimal.js": "^10.6.0"})),
        ("source oracle drift", lambda r: set_lock_path(r, ("source_oracles", "nonce_ts_sha256"), "0" * 64)),
        ("price dependency falsely ready", lambda r: set_lock_path(r, ("price_arithmetic_candidate", "production"), "ready")),
    ]
    killed = 0
    for name, mutate in mutations:
        with tempfile.TemporaryDirectory(prefix="hl-perp-mutation-") as temp:
            candidate = Path(temp) / "candidate"
            shutil.copytree(root, candidate)
            mutate(candidate)
            try:
                validate(candidate)
            except ContractError:
                killed += 1
            else:
                raise ContractError(f"mutation survived: {name}")
    require(killed == len(mutations), "mutation count mismatch")
    return killed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--mutation-suite", action="store_true")
    parser.add_argument("--require-catalog", action="store_true", help="require and validate the merged whole-app integration catalog")
    args = parser.parse_args()
    try:
        result = validate(args.root.resolve(), require_catalog=args.require_catalog)
        mutations = run_mutations(args.root.resolve()) if args.mutation_suite else 0
    except (ContractError, OSError, json.JSONDecodeError) as error:
        print(f"FAIL: {error}")
        return 1
    print(f"PASS: Hyperliquid Perp R0 contract ({result['files']} files, tree {result['tree_sha256']}, catalog {result['catalog_evidence']}, mutations {mutations})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
