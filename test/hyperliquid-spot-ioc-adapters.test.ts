import { readFile } from "node:fs/promises";

import { OrderRequest } from "@nktkas/hyperliquid/api/exchange";
import { canonicalize, createL1ActionHash } from "@nktkas/hyperliquid/signing";
import {
  hashTypedData,
  recoverTypedDataAddress,
  type Hex,
  type TypedData,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import type { SpotCanonicalAction } from "../src/database/spot-intent-repository.js";
import {
  createHyperliquidSpotIocExchangeWriter,
  HYPERLIQUID_TESTNET_EXCHANGE_URL,
} from "../src/integrations/hyperliquid/spot-ioc-exchange-writer.js";
import { createHyperliquidSpotIocSigner } from "../src/integrations/hyperliquid/spot-ioc-signer.js";
import { HyperliquidSpotIocAdapterUnavailableError } from "../src/integrations/hyperliquid/spot-ioc-wire.js";

const fixtureUrl = new URL(
  "../contracts/hyperliquid-spot/fixtures/signing-conformance-v1.json",
  import.meta.url,
);
const transportAttemptId = "87654321-4321-4321-8321-cba987654321";
const signingRequestId = "12345678-1234-4234-8234-123456789abc";

interface L1Vector {
  readonly id: string;
  readonly kind: "l1_spot_order";
  readonly semantic_input: {
    readonly nonce: string;
    readonly vault_address: string | null;
    readonly expires_after: string | null;
  };
  readonly wire: {
    readonly action: SpotCanonicalAction;
    readonly key_order: {
      readonly action: readonly string[];
      readonly order: readonly string[];
      readonly limit: readonly string[];
    };
    readonly action_hash_keccak256_hex: Hex;
  };
  readonly eip712: {
    readonly eip191_digest_hex: Hex;
  };
  readonly signature: {
    readonly official_json: {
      readonly r: Hex;
      readonly s: Hex;
      readonly v: 27 | 28;
    };
    readonly signature65_hex: Hex;
    readonly expected_recovered_address: Hex;
  };
}

interface Fixture {
  readonly vectors: readonly { readonly kind: string }[];
}

async function readVectors(): Promise<readonly L1Vector[]> {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as Fixture;
  return fixture.vectors.filter(
    (vector): vector is L1Vector => vector.kind === "l1_spot_order",
  );
}

function toSignatureHex(
  signature: L1Vector["signature"]["official_json"],
): Hex {
  return `0x${signature.r.slice(2)}${signature.s.slice(2)}${(signature.v - 27)
    .toString(16)
    .padStart(2, "0")}`;
}

function validWriterInput(vector: L1Vector) {
  if (vector.semantic_input.expires_after === null) {
    throw new Error("The runtime writer fixture requires expiresAfter");
  }
  const expiresAfter = Number(vector.semantic_input.expires_after);
  return {
    transportAttemptId,
    network: "testnet" as const,
    action: vector.wire.action,
    nonce: vector.semantic_input.nonce,
    signature: vector.signature.official_json,
    vaultAddress: null,
    expiresAfter: vector.semantic_input.expires_after,
    attemptDeadlineAt: new Date(expiresAfter - 1_000).toISOString(),
    signal: new AbortController().signal,
  };
}

describe("Hyperliquid Spot IOC signing adapter", () => {
  it("matches both pinned official Python L1 action hashes and Testnet typed-data digests", async () => {
    const vectors = await readVectors();
    expect(vectors).toHaveLength(2);

    for (const vector of vectors) {
      const action = canonicalize(
        OrderRequest.entries.action,
        vector.wire.action,
      ) as unknown as Record<string, unknown>;
      const nonce = Number(vector.semantic_input.nonce);
      const connectionId = createL1ActionHash({
        action,
        nonce,
        ...(vector.semantic_input.vault_address === null
          ? {}
          : { vaultAddress: vector.semantic_input.vault_address as Hex }),
        ...(vector.semantic_input.expires_after === null
          ? {}
          : { expiresAfter: Number(vector.semantic_input.expires_after) }),
      });

      expect(Object.keys(action)).toEqual(vector.wire.key_order.action);
      expect(Object.keys((action["orders"] as unknown[])[0] ?? {})).toEqual(
        vector.wire.key_order.order,
      );
      expect(connectionId).toBe(vector.wire.action_hash_keccak256_hex);

      const typedData = {
        domain: {
          name: "Exchange",
          version: "1",
          chainId: 1337,
          verifyingContract: "0x0000000000000000000000000000000000000000",
        },
        types: {
          Agent: [
            { name: "source", type: "string" },
            { name: "connectionId", type: "bytes32" },
          ],
        },
        primaryType: "Agent",
        message: { source: "b", connectionId },
      } as const;
      expect(hashTypedData(typedData)).toBe(vector.eip712.eip191_digest_hex);
      expect(
        (
          await recoverTypedDataAddress({
            ...typedData,
            signature: vector.signature.signature65_hex,
          })
        ).toLowerCase(),
      ).toBe(vector.signature.expected_recovered_address);
    }
  });

  it("binds provider idempotency and expiry to the expected signer and returns the official signature", async () => {
    const vector = (await readVectors()).find(
      ({ id }) => id === "spot_buy_ioc_master_with_expiry",
    );
    if (vector === undefined || vector.semantic_input.expires_after === null) {
      throw new Error("Missing signing fixture");
    }
    let capturedTypedData: Readonly<Record<string, unknown>> | undefined;
    const remoteSigner = {
      signTypedData: vi.fn((input: Readonly<Record<string, unknown>>) => {
        capturedTypedData = input["typedData"] as Readonly<
          Record<string, unknown>
        >;
        return Promise.resolve(toSignatureHex(vector.signature.official_json));
      }),
    };
    const now = Number(vector.semantic_input.nonce);
    const signer = createHyperliquidSpotIocSigner({
      remoteSigner,
      now: () => new Date(now),
    });
    const expiresAfter = Number(vector.semantic_input.expires_after);
    const signal = new AbortController().signal;

    await expect(
      signer.sign({
        signingRequestId,
        network: "testnet",
        signerRef: "privy-server-wallet-fixture",
        expectedSignerAddress: vector.signature.expected_recovered_address,
        action: vector.wire.action,
        nonce: vector.semantic_input.nonce,
        vaultAddress: null,
        expiresAfter: vector.semantic_input.expires_after,
        attemptDeadlineAt: new Date(expiresAfter - 1_000).toISOString(),
        signal,
      }),
    ).resolves.toEqual(vector.signature.official_json);

    expect(remoteSigner.signTypedData).toHaveBeenCalledOnce();
    expect(remoteSigner.signTypedData).toHaveBeenCalledWith({
      signingRequestId,
      signerRef: "privy-server-wallet-fixture",
      expectedSignerAddress: vector.signature.expected_recovered_address,
      typedData: capturedTypedData,
      requestExpiryMilliseconds: expiresAfter - 1_000,
      signal,
    });
    expect(capturedTypedData).toMatchObject({
      domain: {
        name: "Exchange",
        version: "1",
        chainId: 1337,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      primaryType: "Agent",
      message: {
        source: "b",
        connectionId: vector.wire.action_hash_keccak256_hex,
      },
    });
    expect(
      hashTypedData(
        capturedTypedData as unknown as {
          domain: Record<string, unknown>;
          types: TypedData;
          primaryType: string;
          message: Record<string, unknown>;
        },
      ),
    ).toBe(vector.eip712.eip191_digest_hex);
  });

  it("rejects a valid ECDSA signature that recovers a different signer", async () => {
    const vector = (await readVectors()).find(
      ({ id }) => id === "spot_buy_ioc_master_with_expiry",
    );
    if (vector === undefined || vector.semantic_input.expires_after === null) {
      throw new Error("Missing signing fixture");
    }
    const official = toSignatureHex(vector.signature.official_json);
    const wrongRecovery = `${official.slice(0, -2)}${official.endsWith("00") ? "01" : "00"}`;
    const remoteSigner = {
      signTypedData: vi.fn(() => Promise.resolve(wrongRecovery)),
    };
    const signer = createHyperliquidSpotIocSigner({
      remoteSigner,
      now: () => new Date(Number(vector.semantic_input.nonce)),
    });

    await expect(
      signer.sign({
        signingRequestId,
        network: "testnet",
        signerRef: "privy-server-wallet-fixture",
        expectedSignerAddress: vector.signature.expected_recovered_address,
        action: vector.wire.action,
        nonce: vector.semantic_input.nonce,
        vaultAddress: null,
        expiresAfter: vector.semantic_input.expires_after,
        attemptDeadlineAt: new Date(
          Number(vector.semantic_input.expires_after) - 1_000,
        ).toISOString(),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(HyperliquidSpotIocAdapterUnavailableError);
    expect(remoteSigner.signTypedData).toHaveBeenCalledOnce();
  });

  it("discards a remote signature returned after the attempt is aborted", async () => {
    const vector = (await readVectors()).find(
      ({ id }) => id === "spot_buy_ioc_master_with_expiry",
    );
    if (vector === undefined || vector.semantic_input.expires_after === null) {
      throw new Error("Missing signing fixture");
    }
    const controller = new AbortController();
    const remoteSigner = {
      signTypedData: vi.fn(() => {
        controller.abort();
        return Promise.resolve(toSignatureHex(vector.signature.official_json));
      }),
    };
    const signer = createHyperliquidSpotIocSigner({
      remoteSigner,
      now: () => new Date(Number(vector.semantic_input.nonce)),
    });

    await expect(
      signer.sign({
        signingRequestId,
        network: "testnet",
        signerRef: "privy-server-wallet-fixture",
        expectedSignerAddress: vector.signature.expected_recovered_address,
        action: vector.wire.action,
        nonce: vector.semantic_input.nonce,
        vaultAddress: null,
        expiresAfter: vector.semantic_input.expires_after,
        attemptDeadlineAt: new Date(
          Number(vector.semantic_input.expires_after) - 1_000,
        ).toISOString(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(remoteSigner.signTypedData).toHaveBeenCalledOnce();
  });

  it("fails closed before remote signing for malformed, late, unsafe, or non-Testnet input", async () => {
    const vector = (await readVectors()).find(
      ({ id }) => id === "spot_buy_ioc_master_with_expiry",
    );
    if (vector === undefined || vector.semantic_input.expires_after === null) {
      throw new Error("Missing signing fixture");
    }
    const remoteSigner = { signTypedData: vi.fn() };
    const now = Number(vector.semantic_input.nonce);
    const signer = createHyperliquidSpotIocSigner({
      remoteSigner,
      now: () => new Date(now),
    });
    const valid = {
      signingRequestId,
      network: "testnet" as const,
      signerRef: "privy-server-wallet-fixture",
      expectedSignerAddress: vector.signature.expected_recovered_address,
      action: vector.wire.action,
      nonce: vector.semantic_input.nonce,
      vaultAddress: null,
      expiresAfter: vector.semantic_input.expires_after,
      attemptDeadlineAt: new Date(
        Number(vector.semantic_input.expires_after) - 1_000,
      ).toISOString(),
      signal: new AbortController().signal,
    };
    const cases = [
      { ...valid, network: "mainnet" },
      { ...valid, signingRequestId: "not-a-uuid" },
      { ...valid, nonce: "9007199254740992" },
      { ...valid, attemptDeadlineAt: new Date(now).toISOString() },
      { ...valid, vaultAddress: `0x${"12".repeat(20)}` },
      {
        ...valid,
        expectedSignerAddress: `0x${"0".repeat(40)}`,
      },
      {
        ...valid,
        action: {
          ...valid.action,
          orders: [{ ...valid.action.orders[0], p: "12.3450" }],
        },
      },
      {
        ...valid,
        action: { ...valid.action, builder: { b: "unsafe", f: 1 } },
      },
    ];

    for (const badInput of cases) {
      await expect(
        signer.sign(badInput as unknown as Parameters<typeof signer.sign>[0]),
      ).rejects.toBeInstanceOf(HyperliquidSpotIocAdapterUnavailableError);
    }
    expect(remoteSigner.signTypedData).not.toHaveBeenCalled();
  });
});

describe("Hyperliquid Spot IOC Exchange writer", () => {
  it("sends exactly one fixed Testnet request with the journaled envelope", async () => {
    const vector = (await readVectors()).find(
      ({ id }) => id === "spot_buy_ioc_master_with_expiry",
    );
    if (vector === undefined) {
      throw new Error("Missing writer fixture");
    }
    const input = validWriterInput(vector);
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          '{"status":"ok","response":{"type":"order","data":{"statuses":[{"filled":{"oid":18446744073709551615,"totalSz":"0.007","avgPx":"12.345"}}]}}}',
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const writer = createHyperliquidSpotIocExchangeWriter({
      fetch,
      now: () => new Date(Number(vector.semantic_input.nonce)),
    });

    await expect(writer.submit(input)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(HYPERLIQUID_TESTNET_EXCHANGE_URL);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: input.signal,
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
    });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        action: vector.wire.action,
        nonce: Number(vector.semantic_input.nonce),
        signature: vector.signature.official_json,
        vaultAddress: null,
        expiresAfter: Number(vector.semantic_input.expires_after),
      }),
    );
  });

  it("never retries a rejected transport", async () => {
    const vector = (await readVectors()).find(
      ({ id }) => id === "spot_buy_ioc_master_with_expiry",
    );
    if (vector === undefined) {
      throw new Error("Missing writer fixture");
    }
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.reject(new Error("raw provider detail")),
    );
    const writer = createHyperliquidSpotIocExchangeWriter({
      fetch,
      now: () => new Date(Number(vector.semantic_input.nonce)),
    });

    await expect(writer.submit(validWriterInput(vector))).rejects.toEqual(
      new HyperliquidSpotIocAdapterUnavailableError(),
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "non-success HTTP status",
      new Response("{}", {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    ],
    ["wrong content type", new Response("{}")],
    [
      "malformed JSON",
      new Response("{", {
        headers: { "content-type": "application/json" },
      }),
    ],
    [
      "oversized body",
      new Response(JSON.stringify({ data: "x".repeat(256) }), {
        headers: { "content-type": "application/json" },
      }),
    ],
  ])("treats %s as one ambiguous attempt", async (_label, response) => {
    const vector = (await readVectors()).find(
      ({ id }) => id === "spot_buy_ioc_master_with_expiry",
    );
    if (vector === undefined) {
      throw new Error("Missing writer fixture");
    }
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(response),
    );
    const writer = createHyperliquidSpotIocExchangeWriter({
      fetch,
      maxResponseBytes: 64,
      now: () => new Date(Number(vector.semantic_input.nonce)),
    });

    await expect(
      writer.submit(validWriterInput(vector)),
    ).rejects.toBeInstanceOf(HyperliquidSpotIocAdapterUnavailableError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
  });

  it("rejects malformed authority and timing before fetch", async () => {
    const vector = (await readVectors()).find(
      ({ id }) => id === "spot_buy_ioc_master_with_expiry",
    );
    if (vector === undefined) {
      throw new Error("Missing writer fixture");
    }
    const valid = validWriterInput(vector);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const now = Number(vector.semantic_input.nonce);
    const writer = createHyperliquidSpotIocExchangeWriter({
      fetch,
      now: () => new Date(now),
    });
    const cases = [
      { ...valid, network: "mainnet" },
      { ...valid, transportAttemptId: "not-a-uuid" },
      { ...valid, nonce: "9007199254740992" },
      { ...valid, attemptDeadlineAt: new Date(now).toISOString() },
      { ...valid, vaultAddress: `0x${"12".repeat(20)}` },
      {
        ...valid,
        signature: { ...valid.signature, r: `0x${"AB".repeat(32)}` },
      },
    ];

    for (const badInput of cases) {
      await expect(
        writer.submit(
          badInput as unknown as Parameters<typeof writer.submit>[0],
        ),
      ).rejects.toBeInstanceOf(HyperliquidSpotIocAdapterUnavailableError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
