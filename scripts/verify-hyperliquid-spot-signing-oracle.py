#!/usr/bin/env python3
"""Verify committed Spot signing vectors with one exact official SDK checkout.

This verification-only command never writes repository files, sends a network
request, or acts as a production signer. Supply the public fixture identity used
by the official SDK tests through LOOP_HL_ORACLE_TEST_SIGNER_KEY. The value is
deliberately not committed or printed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


EXPECTED_COMMIT = "2fdb18f9517675ea03695a0962bd19eece9c83f0"
EXPECTED_FILES = {
    "hyperliquid/utils/signing.py": "938ec0a1f9611874b423ca946696e19a71d32d14709f521ea5d526f4398c0b85",
    "tests/signing_test.py": "ea0d7b2e9e2a224b55e05b6d1abbcc727ce1f38e72572e607a4a7045bc01a042",
    "poetry.lock": "1580d7eb44762dfd6598e32009319a7eb6da45070a4040b237526f21a1af7b6b",
}
SIGNER_ENV = "LOOP_HL_ORACLE_TEST_SIGNER_KEY"


def fail(message: str) -> None:
    raise RuntimeError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require_official_checkout(sdk_root: Path) -> None:
    commit = subprocess.run(
        ["git", "-C", str(sdk_root), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if commit != EXPECTED_COMMIT:
        fail("official SDK commit mismatch")

    for relative_path, expected_hash in EXPECTED_FILES.items():
        path = sdk_root / relative_path
        if not path.is_file() or sha256(path) != expected_hash:
            fail(f"official SDK source hash mismatch: {relative_path}")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--sdk-root",
        required=True,
        type=Path,
        help="Exact official hyperliquid-python-sdk checkout",
    )
    parser.add_argument(
        "--fixture",
        type=Path,
        default=Path("contracts/hyperliquid-spot/fixtures/signing-conformance-v1.json"),
    )
    return parser.parse_args()


def to_hex_bytes(value: bytes) -> str:
    return "0x" + value.hex()


def fixed_hex32(value: str) -> str:
    return "0x" + int(value, 16).to_bytes(32, "big").hex()


def assert_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        fail(f"oracle mismatch: {label}")


def main() -> None:
    arguments = parse_arguments()
    sdk_root = arguments.sdk_root.resolve(strict=True)
    fixture_path = arguments.fixture.resolve(strict=True)
    require_official_checkout(sdk_root)

    sys.path.insert(0, str(sdk_root))

    import msgpack  # type: ignore[import-not-found]  # noqa: PLC0415
    from eth_account import Account  # type: ignore[import-not-found]  # noqa: PLC0415
    from eth_account.messages import (  # type: ignore[import-not-found]  # noqa: PLC0415
        _hash_eip191_message,
        encode_typed_data,
    )
    from eth_utils import to_hex  # type: ignore[import-not-found]  # noqa: PLC0415
    from hyperliquid.utils.signing import (  # type: ignore[import-not-found]  # noqa: PLC0415
        action_hash,
        construct_phantom_agent,
        l1_payload,
        sign_agent,
        sign_l1_action,
        user_signed_payload,
    )

    signer_key = os.environ.get(SIGNER_ENV)
    if signer_key is None or signer_key == "":
        fail(f"{SIGNER_ENV} is required and is never printed")

    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    signer = Account.from_key(signer_key)
    expected_signer = fixture["fixture_signer"]["expected_address"]
    assert_equal(signer.address.lower(), expected_signer, "fixture signer address")

    if fixture["runtime_adapter"] != {
        "status": "selected_low_level_only",
        "package": "@nktkas/hyperliquid",
        "version": "0.33.3",
        "conformance": "offline_node_hash_digest_and_signature_vectors_passed",
        "production_mutation": "disabled",
    }:
        fail("runtime adapter evidence boundary mismatch")

    for vector in fixture["vectors"]:
        if vector["kind"] == "l1_spot_order":
            action = vector["wire"]["action"]
            semantic = vector["semantic_input"]
            nonce = int(semantic["nonce"])
            vault_address = semantic["vault_address"]
            expires_after = (
                None
                if semantic["expires_after"] is None
                else int(semantic["expires_after"])
            )
            packed = msgpack.packb(action)
            nonce_bytes = nonce.to_bytes(8, "big")
            vault_suffix = (
                b"\x00"
                if vault_address is None
                else b"\x01" + bytes.fromhex(vault_address[2:])
            )
            expires_suffix = (
                b""
                if expires_after is None
                else b"\x00" + expires_after.to_bytes(8, "big")
            )
            preimage = packed + nonce_bytes + vault_suffix + expires_suffix
            connection_id = action_hash(
                action,
                vault_address,
                nonce,
                expires_after,
            )
            phantom = construct_phantom_agent(connection_id, False)
            typed_data = l1_payload(phantom)
            signable = encode_typed_data(full_message=typed_data)
            signature = sign_l1_action(
                signer,
                action,
                vault_address,
                nonce,
                expires_after,
                False,
            )

            assert_equal(
                list(action.keys()),
                vector["wire"]["key_order"]["action"],
                f"{vector['id']} action key order",
            )
            assert_equal(
                list(action["orders"][0].keys()),
                vector["wire"]["key_order"]["order"],
                f"{vector['id']} order key order",
            )
            assert_equal(
                to_hex_bytes(packed),
                vector["wire"]["msgpack_hex"],
                f"{vector['id']} MessagePack",
            )
            assert_equal(
                to_hex_bytes(nonce_bytes),
                vector["wire"]["nonce_big_endian_u64_hex"],
                f"{vector['id']} nonce bytes",
            )
            assert_equal(
                to_hex_bytes(vault_suffix),
                vector["wire"]["vault_suffix_hex"],
                f"{vector['id']} vault suffix",
            )
            assert_equal(
                to_hex_bytes(expires_suffix),
                vector["wire"]["expires_suffix_hex"],
                f"{vector['id']} expiry suffix",
            )
            assert_equal(
                to_hex_bytes(preimage),
                vector["wire"]["action_hash_preimage_hex"],
                f"{vector['id']} action-hash preimage",
            )
            assert_equal(
                to_hex(connection_id),
                vector["wire"]["action_hash_keccak256_hex"],
                f"{vector['id']} action hash",
            )
            assert_equal(
                to_hex(signable.header),
                vector["eip712"]["domain_separator_hex"],
                f"{vector['id']} domain separator",
            )
            assert_equal(
                to_hex(signable.body),
                vector["eip712"]["struct_hash_hex"],
                f"{vector['id']} struct hash",
            )
            assert_equal(
                to_hex(_hash_eip191_message(signable)),
                vector["eip712"]["eip191_digest_hex"],
                f"{vector['id']} signing digest",
            )
        elif vector["kind"] == "user_signed_approve_agent":
            wire_action = vector["wire"]["action"]
            action = {
                "type": wire_action["type"],
                "agentAddress": wire_action["agentAddress"],
                "agentName": wire_action["agentName"],
                "nonce": wire_action["nonce"],
            }
            signature = sign_agent(signer, action, False)
            payload_types = [
                {"name": "hyperliquidChain", "type": "string"},
                {"name": "agentAddress", "type": "address"},
                {"name": "agentName", "type": "string"},
                {"name": "nonce", "type": "uint64"},
            ]
            typed_data = user_signed_payload(
                "HyperliquidTransaction:ApproveAgent",
                payload_types,
                action,
            )
            signable = encode_typed_data(full_message=typed_data)
            assert_equal(action, wire_action, f"{vector['id']} formatted action")
            assert_equal(
                to_hex(signable.header),
                vector["eip712"]["domain_separator_hex"],
                f"{vector['id']} domain separator",
            )
            assert_equal(
                to_hex(signable.body),
                vector["eip712"]["struct_hash_hex"],
                f"{vector['id']} struct hash",
            )
            assert_equal(
                to_hex(_hash_eip191_message(signable)),
                vector["eip712"]["eip191_digest_hex"],
                f"{vector['id']} signing digest",
            )
        else:
            fail("unknown signing vector kind")

        r32 = fixed_hex32(signature["r"])
        s32 = fixed_hex32(signature["s"])
        signature65 = (
            "0x"
            + r32[2:]
            + s32[2:]
            + bytes([signature["v"] - 27]).hex()
        )
        recovered = Account.recover_message(
            signable,
            vrs=[signature["v"], signature["r"], signature["s"]],
        ).lower()
        assert_equal(
            signature,
            vector["signature"]["official_json"],
            f"{vector['id']} official signature",
        )
        assert_equal(r32, vector["signature"]["r32_hex"], f"{vector['id']} r32")
        assert_equal(s32, vector["signature"]["s32_hex"], f"{vector['id']} s32")
        assert_equal(
            signature65,
            vector["signature"]["signature65_hex"],
            f"{vector['id']} signature65",
        )
        assert_equal(
            recovered,
            vector["signature"]["expected_recovered_address"],
            f"{vector['id']} recovered signer",
        )

    print("Hyperliquid Spot official signing oracle verification passed")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # fail closed with a safe one-line diagnostic
        print(f"Hyperliquid Spot oracle verification failed: {error}", file=sys.stderr)
        raise SystemExit(1) from None
