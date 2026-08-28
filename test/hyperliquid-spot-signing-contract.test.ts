import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const fixtureUrl = new URL(
  "../contracts/hyperliquid-spot/fixtures/signing-conformance-v1.json",
  import.meta.url,
);
const contractUrl = new URL(
  "../contracts/hyperliquid-spot/contract.json",
  import.meta.url,
);
const ossLockUrl = new URL(
  "../contracts/hyperliquid-spot/oss-lock.json",
  import.meta.url,
);
const packageUrl = new URL("../package.json", import.meta.url);

interface L1Vector {
  readonly id: string;
  readonly kind: "l1_spot_order";
  readonly semantic_input: {
    readonly network: string;
    readonly pair_index: number;
    readonly derived_order_asset: number;
    readonly price: string;
    readonly size: string;
    readonly time_in_force: string;
    readonly reduce_only: boolean;
  };
  readonly wire: {
    readonly action: {
      readonly type: string;
      readonly orders: readonly {
        readonly a: number;
        readonly b: boolean;
        readonly p: string;
        readonly s: string;
        readonly r: boolean;
        readonly t: { readonly limit: { readonly tif: string } };
        readonly c: string;
      }[];
      readonly grouping: string;
    };
    readonly key_order: {
      readonly action: readonly string[];
      readonly order: readonly string[];
      readonly limit: readonly string[];
    };
    readonly msgpack_hex: string;
    readonly nonce_big_endian_u64_hex: string;
    readonly vault_suffix_hex: string;
    readonly expires_suffix_hex: string;
    readonly action_hash_preimage_hex: string;
    readonly action_hash_keccak256_hex: string;
  };
  readonly phantom_agent: {
    readonly source: string;
    readonly connectionId: string;
  };
  readonly eip712: {
    readonly domain_separator_hex: string;
    readonly struct_hash_hex: string;
    readonly eip191_digest_hex: string;
  };
  readonly signature: {
    readonly official_json: {
      readonly r: string;
      readonly s: string;
      readonly v: number;
    };
    readonly r32_hex: string;
    readonly s32_hex: string;
    readonly signature65_hex: string;
    readonly expected_recovered_address: string;
  };
}

interface ApproveAgentVector {
  readonly id: string;
  readonly kind: "user_signed_approve_agent";
  readonly semantic_input: {
    readonly network: string;
  };
  readonly wire: {
    readonly action: {
      readonly type: string;
      readonly agentAddress: string;
      readonly agentName: string;
      readonly nonce: number;
      readonly signatureChainId: string;
      readonly hyperliquidChain: string;
    };
    readonly key_order: {
      readonly initial_action: readonly string[];
      readonly formatted_action: readonly string[];
    };
  };
  readonly eip712: {
    readonly full_message: {
      readonly domain: {
        readonly name: string;
        readonly version: string;
        readonly chainId: number;
        readonly verifyingContract: string;
      };
      readonly primaryType: string;
    };
    readonly domain_separator_hex: string;
    readonly struct_hash_hex: string;
    readonly eip191_digest_hex: string;
  };
  readonly signature: L1Vector["signature"];
}

interface SigningFixture {
  readonly schema_version: string;
  readonly classification: string;
  readonly network: string;
  readonly network_requests: number;
  readonly credentials: string;
  readonly runtime_fallback: boolean;
  readonly runtime_adapter: {
    readonly status: string;
    readonly conformance: string;
    readonly production_mutation: string;
  };
  readonly fixture_signer: {
    readonly classification: string;
    readonly credential: boolean;
    readonly key_material: string;
    readonly expected_address: string;
  };
  readonly oracle: {
    readonly package: string;
    readonly version: string;
    readonly commit: string;
    readonly signing_py_sha256: string;
    readonly signing_test_py_sha256: string;
  };
  readonly vectors: readonly (L1Vector | ApproveAgentVector)[];
}

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

const hex32Pattern = /^0x[0-9a-f]{64}$/;
const addressPattern = /^0x[0-9a-f]{40}$/;

describe("Hyperliquid Spot signing contract", () => {
  it("records non-secret official vectors without claiming runtime conformance", async () => {
    const fixture = await readJson<SigningFixture>(fixtureUrl);

    expect(fixture).toMatchObject({
      schema_version: "loop.hyperliquid-spot.signing-conformance/v1",
      classification: "public_nonsecret_test_vectors",
      network: "testnet",
      network_requests: 0,
      credentials: "omitted",
      runtime_fallback: false,
      runtime_adapter: {
        status: "not_selected",
        conformance: "not_run",
        production_mutation: "disabled",
      },
      fixture_signer: {
        classification: "public_test_vector_only",
        credential: false,
        key_material: "omitted",
      },
    });
    expect(fixture.fixture_signer.expected_address).toMatch(addressPattern);
    expect(fixture.oracle).toEqual({
      ...fixture.oracle,
      package: "hyperliquid-python-sdk",
      version: "0.24.0",
      commit: "2fdb18f9517675ea03695a0962bd19eece9c83f0",
      signing_py_sha256:
        "938ec0a1f9611874b423ca946696e19a71d32d14709f521ea5d526f4398c0b85",
      signing_test_py_sha256:
        "ea0d7b2e9e2a224b55e05b6d1abbcc727ce1f38e72572e607a4a7045bc01a042",
    });
  });

  it("pins two ordered Spot IOC vectors and every intermediate conformance value", async () => {
    const fixture = await readJson<SigningFixture>(fixtureUrl);
    const vectors = fixture.vectors.filter(
      (vector): vector is L1Vector => vector.kind === "l1_spot_order",
    );

    expect(vectors.map(({ id }) => id)).toEqual([
      "spot_buy_ioc_master_with_expiry",
      "spot_sell_ioc_subaccount_no_expiry",
    ]);

    for (const vector of vectors) {
      const [order] = vector.wire.action.orders;

      expect(vector.semantic_input.network).toBe("testnet");
      expect(vector.semantic_input.derived_order_asset).toBe(
        10_000 + vector.semantic_input.pair_index,
      );
      expect(vector.semantic_input.time_in_force).toBe("Ioc");
      expect(vector.semantic_input.reduce_only).toBe(false);
      expect(Object.keys(vector.wire.action)).toEqual(
        vector.wire.key_order.action,
      );
      expect(Object.keys(order ?? {})).toEqual(vector.wire.key_order.order);
      expect(Object.keys(order?.t.limit ?? {})).toEqual(
        vector.wire.key_order.limit,
      );
      expect(vector.wire.action).toMatchObject({
        type: "order",
        grouping: "na",
      });
      expect(vector.wire.action.orders).toHaveLength(1);
      expect(order).toMatchObject({
        a: vector.semantic_input.derived_order_asset,
        p: vector.semantic_input.price,
        s: vector.semantic_input.size,
        r: false,
        t: { limit: { tif: "Ioc" } },
      });
      expect(order?.c).toMatch(/^0x[0-9a-f]{32}$/);
      expect(vector.wire.msgpack_hex).toMatch(/^0x[0-9a-f]+$/);
      expect(vector.wire.nonce_big_endian_u64_hex).toMatch(/^0x[0-9a-f]{16}$/);
      expect(vector.wire.vault_suffix_hex).toMatch(/^0x[0-9a-f]*$/);
      expect(vector.wire.expires_suffix_hex).toMatch(/^0x[0-9a-f]*$/);
      expect(vector.wire.action_hash_preimage_hex).toMatch(/^0x[0-9a-f]+$/);
      expect(vector.wire.action_hash_keccak256_hex).toMatch(hex32Pattern);
      expect(vector.phantom_agent).toEqual({
        source: "b",
        connectionId: vector.wire.action_hash_keccak256_hex,
      });
      expect(vector.eip712.domain_separator_hex).toMatch(hex32Pattern);
      expect(vector.eip712.struct_hash_hex).toMatch(hex32Pattern);
      expect(vector.eip712.eip191_digest_hex).toMatch(hex32Pattern);
      expect(vector.signature.r32_hex).toMatch(hex32Pattern);
      expect(vector.signature.s32_hex).toMatch(hex32Pattern);
      expect(vector.signature.signature65_hex).toMatch(/^0x[0-9a-f]{130}$/);
      expect(vector.signature.official_json.v).toBeGreaterThanOrEqual(27);
      expect(vector.signature.official_json.v).toBeLessThanOrEqual(28);
      expect(vector.signature.expected_recovered_address).toBe(
        fixture.fixture_signer.expected_address,
      );
    }
  });

  it("pins the official Testnet approveAgent typed-data boundary", async () => {
    const fixture = await readJson<SigningFixture>(fixtureUrl);
    const vector = fixture.vectors.find(
      (candidate): candidate is ApproveAgentVector =>
        candidate.kind === "user_signed_approve_agent",
    );

    expect(vector?.id).toBe("approve_agent_testnet");
    expect(vector?.semantic_input.network).toBe("testnet");
    expect(Object.keys(vector?.wire.action ?? {})).toEqual(
      vector?.wire.key_order.formatted_action,
    );
    expect(vector?.wire.key_order.initial_action).toEqual([
      "type",
      "agentAddress",
      "agentName",
      "nonce",
    ]);
    expect(vector?.wire.action).toMatchObject({
      type: "approveAgent",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
    });
    expect(vector?.wire.action.agentAddress).toMatch(addressPattern);
    expect(vector?.eip712.full_message).toMatchObject({
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: 421_614,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      primaryType: "HyperliquidTransaction:ApproveAgent",
    });
    expect(vector?.eip712.domain_separator_hex).toMatch(hex32Pattern);
    expect(vector?.eip712.struct_hash_hex).toMatch(hex32Pattern);
    expect(vector?.eip712.eip191_digest_hex).toMatch(hex32Pattern);
    expect(vector?.signature.expected_recovered_address).toBe(
      fixture.fixture_signer.expected_address,
    );
  });

  it("keeps the writer absent until a selected dependency passes conformance", async () => {
    const [contract, ossLock, packageManifest] = await Promise.all([
      readJson<{
        readonly status: string;
        readonly runtime: {
          readonly writer: string;
          readonly signer_adapter: null;
        };
        readonly loop_api: {
          readonly routes: readonly {
            readonly method: string;
            readonly path: string;
          }[];
        };
        readonly submission_preflight: {
          readonly runtime_composed: boolean;
          readonly provider_write: boolean;
          readonly private_evidence_maximum_lifetime_ms: number;
          readonly database_clock_checks: readonly string[];
          readonly reserves_funds: boolean;
          readonly covers_full_attempt: boolean;
        };
        readonly agent_authorization: {
          readonly issuance_coordinator: {
            readonly implemented: boolean;
            readonly runtime_composed: boolean;
            readonly provider_write: boolean;
            readonly exact_replay_allocator_calls: number;
            readonly database_nonce_allocation: boolean;
            readonly independent_digest_match_required: boolean;
          };
          readonly nonce_representation: {
            readonly database_review_and_envelope: string;
            readonly typed_data_message: string;
            readonly maximum_typed_data_value: number;
            readonly round_trip_equality_required: boolean;
          };
          readonly signature_recovery: boolean;
          readonly relay: boolean;
          readonly authoritative_reconciliation: boolean;
        };
        readonly mainnet_boundary: {
          readonly activation_approved: boolean;
          readonly runtime_code_or_configuration_present: boolean;
        };
      }>(contractUrl),
      readJson<{
        readonly production_writer: {
          readonly enabled: boolean;
          readonly runtime_adapter: null;
          readonly status: string;
        };
        readonly typescript_spike_candidate: {
          readonly package: string;
          readonly version: string;
          readonly status: string;
        };
        readonly dependency_graph: {
          readonly candidate_installed: boolean;
          readonly runtime_graph_locked: boolean;
        };
      }>(ossLockUrl),
      readJson<{
        readonly dependencies?: Readonly<Record<string, string>>;
        readonly devDependencies?: Readonly<Record<string, string>>;
      }>(packageUrl),
    ]);

    expect(contract).toMatchObject({
      status: "approved_contract_writer_unavailable",
      runtime: { writer: "unavailable", signer_adapter: null },
      submission_preflight: {
        runtime_composed: false,
        provider_write: false,
        private_evidence_maximum_lifetime_ms: 2_000,
        database_clock_checks: [
          "after authority and intent locks before journal and nonce allocation",
          "after deferred constraints before transaction commit",
        ],
        reserves_funds: false,
        covers_full_attempt: false,
      },
      agent_authorization: {
        issuance_coordinator: {
          implemented: true,
          runtime_composed: false,
          provider_write: false,
          exact_replay_allocator_calls: 0,
          database_nonce_allocation: true,
          independent_digest_match_required: true,
        },
        nonce_representation: {
          database_review_and_envelope: "canonical decimal string",
          typed_data_message: "JSON safe nonnegative integer",
          maximum_typed_data_value: Number.MAX_SAFE_INTEGER,
          round_trip_equality_required: true,
        },
        signature_recovery: false,
        relay: false,
        authoritative_reconciliation: false,
      },
      mainnet_boundary: {
        activation_approved: false,
        runtime_code_or_configuration_present: false,
      },
    });
    expect(
      contract.loop_api.routes.map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "GET /v1/spot/config",
      "GET /v1/spot/markets/{market_id}/facts",
      "GET /v1/spot/balances",
      "POST /v1/spot/intents",
      "GET /v1/spot/intents/{intent_id}",
      "POST /v1/spot/intents/{intent_id}/submit",
      "GET /v1/spot/wallet-binding",
      "PUT /v1/spot/wallet-binding",
      "DELETE /v1/spot/wallet-binding",
      "POST /v1/spot/agent-authorizations",
      "GET /v1/spot/agent-authorizations/{authorization_id}",
      "POST /v1/spot/agent-authorizations/{authorization_id}/signatures",
    ]);
    expect(ossLock).toMatchObject({
      production_writer: {
        enabled: false,
        runtime_adapter: null,
        status: "unselected_default_closed",
      },
      typescript_spike_candidate: {
        package: "@nktkas/hyperliquid",
        version: "0.33.3",
        status: "research_only_not_installed_dependency_graph_and_sbom_pending",
      },
      dependency_graph: {
        candidate_installed: false,
        runtime_graph_locked: false,
      },
    });
    expect(
      packageManifest.dependencies?.["@nktkas/hyperliquid"],
    ).toBeUndefined();
    expect(
      packageManifest.devDependencies?.["@nktkas/hyperliquid"],
    ).toBeUndefined();
  });
});
