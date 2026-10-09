import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/core/json/canonical-json.js";
import {
  digestCanonicalPayload,
  isIntentChainAllowed,
  sealIntent,
  type IntentSource,
} from "../src/features/wallet-intents/intent-contract.js";
import { walletIntentRefusalReasonCodes } from "../src/features/wallet-intents/intent-contract.js";
import { buildUnsignedTransaction } from "../src/features/wallet-intents/intent-preparation.js";
import {
  policyBlockedErrorSchema,
  policyBlockedReasonCodes,
} from "../src/routes/v2/wallet-intents-schemas.js";
import { transactionMatchesPayload } from "../src/features/wallet-intents/wallet-intent-service.js";
import { assessPriceImpact } from "../src/features/wallet-intents/swap-service.js";
import {
  buildErc20Approve,
  buildErc20Transfer,
  buildNativeTransfer,
  checksumAddress,
  decodeErc20Call,
  fromHexQuantity,
  InvalidTransactionArgumentError,
  maxUint256,
  parseRecipientAddress,
  toHexQuantity,
} from "../src/integrations/bsc/tx-builder.js";

const usdt = "0x55d398326f99059ff775485246999027b3197955";
const recipient = "0x00000000000000000000000000000000000000b2";
const spender = "0x00000000000000000000000000000000000000c3";

describe("tx-builder", () => {
  it("encodes transfer(address,uint256) to the known selector and words", () => {
    const call = buildErc20Transfer({
      token: usdt,
      to: recipient,
      value: 1_000_000_000_000_000_000n,
    });
    expect(call.to).toBe(usdt);
    expect(call.value).toBe(0n);
    expect(call.data).toBe(
      "0xa9059cbb" +
        "00000000000000000000000000000000000000000000000000000000000000b2" +
        "0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    );
  });

  it("encodes approve(address,uint256) including the unlimited sentinel", () => {
    const call = buildErc20Approve({ token: usdt, spender, value: maxUint256 });
    expect(call.data).toBe(
      "0x095ea7b3" +
        "00000000000000000000000000000000000000000000000000000000000000c3" +
        "f".repeat(64),
    );
    const decoded = decodeErc20Call(call.data);
    expect(decoded).toEqual({
      functionName: "approve",
      spender,
      value: maxUint256,
      isUnlimited: true,
    });
  });

  it("round-trips transfer calldata and refuses a foreign selector", () => {
    const call = buildErc20Transfer({ token: usdt, to: recipient, value: 5n });
    expect(decodeErc20Call(call.data)).toEqual({
      functionName: "transfer",
      to: recipient,
      value: 5n,
    });
    expect(() => decodeErc20Call("0x23b872dd")).toThrow(
      InvalidTransactionArgumentError,
    );
  });

  it("builds a native transfer with empty calldata and refuses bad inputs", () => {
    expect(buildNativeTransfer({ to: recipient, value: 10n })).toEqual({
      to: recipient,
      data: "0x",
      value: 10n,
    });
    expect(() => buildNativeTransfer({ to: recipient, value: -1n })).toThrow(
      InvalidTransactionArgumentError,
    );
    expect(() =>
      buildNativeTransfer({ to: recipient.toUpperCase(), value: 1n }),
    ).toThrow(InvalidTransactionArgumentError);
    expect(() =>
      buildErc20Transfer({
        token: usdt,
        to: recipient,
        value: maxUint256 + 1n,
      }),
    ).toThrow(InvalidTransactionArgumentError);
  });

  it("accepts lowercase and valid checksummed addresses but not a wrong checksum", () => {
    const checksum = checksumAddress(usdt);
    expect(checksum).toBe("0x55d398326f99059fF775485246999027B3197955");
    expect(parseRecipientAddress(checksum)).toBe(usdt);
    expect(parseRecipientAddress(usdt)).toBe(usdt);
    expect(parseRecipientAddress(usdt.toUpperCase().replace("0X", "0x"))).toBe(
      usdt,
    );
    const corrupted = `${checksum.slice(0, -1)}${checksum.endsWith("5") ? "5" : "5"}`;
    const flipped = corrupted.replace("fF", "Ff");
    expect(() => parseRecipientAddress(flipped)).toThrow(
      InvalidTransactionArgumentError,
    );
    expect(() => parseRecipientAddress("0x1234")).toThrow(
      InvalidTransactionArgumentError,
    );
    expect(() => parseRecipientAddress(42)).toThrow(
      InvalidTransactionArgumentError,
    );
  });

  it("converts hex quantities without leading zeros", () => {
    expect(toHexQuantity(0n)).toBe("0x0");
    expect(toHexQuantity(21_000n)).toBe("0x5208");
    expect(fromHexQuantity("0x5208")).toBe(21_000n);
    expect(() => fromHexQuantity("0x05208")).toThrow(
      InvalidTransactionArgumentError,
    );
  });
});

function source(overrides: Partial<IntentSource> = {}): IntentSource {
  return {
    version: "walletIntentSendV1",
    intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    kind: "send",
    chainId: "eip155:56",
    walletId: "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
    from: "0x00000000000000000000000000000000000000a1",
    asset: {
      assetId: `eip155:56:${usdt}`,
      address: usdt,
      symbol: "USDT",
      decimals: 18,
    },
    amount: { raw: "1000000000000000000", display: "1" },
    recipient: {
      address: recipient,
      checksumAddress: checksumAddress(recipient),
      isContract: false,
      isFirstRecipient: true,
      basis: "indexed_erc20_transfers",
      screening: {
        status: "unavailable",
        reasonCode: "GOPLUS_ADDRESS_SCREENING_NOT_CONFIGURED",
      },
    },
    spender: null,
    decodedCall: null,
    transaction: {
      chainId: 56,
      from: "0x00000000000000000000000000000000000000a1",
      to: usdt,
      data: "0xa9059cbb",
      value: "0x0",
      gas: "0xcb20",
      nonce: "0x7",
      type: "eip1559",
      maxFeePerGas: "0xb2d05e00",
      maxPriorityFeePerGas: "0x3b9aca00",
      gasPrice: null,
    },
    fee: {
      gasLimit: "52000",
      type: "eip1559",
      maxFeePerGas: "3000000000",
      maxPriorityFeePerGas: "1000000000",
      gasPrice: null,
      maximumFeeRaw: "156000000000000",
      maximumFee: "0.000156",
      observedAt: "2026-09-08T00:00:00.000Z",
    },
    balance: {
      blockNumber: "44000000",
      blockHash: `0x${"1".repeat(64)}`,
      observedAt: "2026-09-08T00:00:00.000Z",
      rawBalance: "5000000000000000000",
      displayBalance: "5",
      rawNativeBalance: "2000000000000000000",
      gasReserveRaw: "5000000000000000",
    },
    simulation: {
      status: "passed",
      source: "rpc_call",
      observedAt: "2026-09-08T00:00:00.000Z",
      reasonCode: null,
    },
    policy: {
      configVersion: "bscWriteCanaryV1",
      canaryMaxUsd: "20",
      exposureBasis: "amount",
      exposureRaw: "1000000000000000000",
      exposureBlockNumber: "44000000",
      valueUsd: "1",
      priceSource: "dexscreener",
      priceFetchedAt: "2026-09-08T00:00:00.000Z",
    },
    swap: null,
    signingMode: "device_eth_send_transaction",
    factsObservedAt: "2026-09-08T00:00:00.000Z",
    expiresAt: "2026-09-08T00:02:00.000Z",
    ...overrides,
  };
}

describe("intent sealing", () => {
  it("derives the review and the digest from one canonical payload", () => {
    const sealed = sealIntent(source());
    expect(sealed.reviewSha256).toBe(
      createHash("sha256")
        .update(canonicalJson(sealed.canonicalPayload))
        .digest("hex"),
    );
    expect(sealed.reviewSha256).toBe(
      digestCanonicalPayload(sealed.canonicalPayload),
    );
    expect(sealed.publicReview.amount).toEqual(sealed.canonicalPayload.amount);
    expect(sealed.publicReview.recipient).toEqual(
      sealed.canonicalPayload.recipient,
    );
    expect(sealed.publicReview.fee).toEqual(sealed.canonicalPayload.fee);
    expect(Object.keys(sealed.publicReview).sort()).toEqual([
      "amount",
      "asset",
      "balance",
      "decodedCall",
      "fee",
      "kind",
      "recipient",
      "spender",
      "swap",
    ]);
  });

  it("changes the digest for any changed fact and is key-order independent", () => {
    const baseline = sealIntent(source()).reviewSha256;
    expect(
      sealIntent(
        source({
          amount: {
            raw: "1000000000000000001",
            display: "1.000000000000000001",
          },
        }),
      ).reviewSha256,
    ).not.toBe(baseline);
    expect(
      sealIntent(source({ expiresAt: "2026-09-08T00:03:00.000Z" }))
        .reviewSha256,
    ).not.toBe(baseline);
    const reordered = JSON.parse(
      JSON.stringify(source(), Object.keys(source()).sort().reverse()),
    ) as IntentSource;
    expect(sealIntent({ ...reordered, ...source() }).reviewSha256).toBe(
      baseline,
    );
    expect(canonicalJson({ b: 1, a: [{ d: null, c: "x" }] })).toBe(
      '{"a":[{"c":"x","d":null}],"b":1}',
    );
  });
});

describe("swap price impact policy", () => {
  it("allows under 1%, asks confirmation from 1%, blocks from 5%", () => {
    const allowed = assessPriceImpact({
      inputValueUsd: "10",
      outputValuation: {
        valueUsd: "9.95",
        priceSource: "dexscreener",
        fetchedAt: "t",
      },
    });
    expect(allowed).toMatchObject({
      status: "available",
      value: "0.005",
      decision: "allowed",
    });
    const confirm = assessPriceImpact({
      inputValueUsd: "10",
      outputValuation: {
        valueUsd: "9.8",
        priceSource: "dexscreener",
        fetchedAt: "t",
      },
    });
    expect(confirm).toMatchObject({
      decision: "confirm",
      reasonCode: "PRICE_IMPACT_CONFIRMATION_REQUIRED",
    });
    const blocked = assessPriceImpact({
      inputValueUsd: "10",
      outputValuation: {
        valueUsd: "9.4",
        priceSource: "dexscreener",
        fetchedAt: "t",
      },
    });
    expect(blocked).toMatchObject({
      value: "0.06",
      decision: "blocked",
      reasonCode: "PRICE_IMPACT_ABOVE_HARD_LIMIT",
    });
  });

  it("blocks when the output cannot be priced instead of assuming zero impact", () => {
    expect(
      assessPriceImpact({ inputValueUsd: "10", outputValuation: null }),
    ).toMatchObject({
      status: "unavailable",
      value: null,
      decision: "blocked",
      reasonCode: "PRICE_IMPACT_UNAVAILABLE",
    });
  });
});

describe("intent chain policy (Decision 0038)", () => {
  const feeData = {
    type: "eip1559" as const,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  };
  const call = {
    from: "0x00000000000000000000000000000000000000a1",
    to: usdt,
    data: "0xa9059cbb" as const,
    value: 0n,
    gasLimit: 52_000n,
    nonce: 7,
    feeData,
  };

  it("lets every intent bind the primary chain and only a launch intent bind the testnet", () => {
    for (const kind of [
      "send",
      "approve",
      "revoke",
      "swap",
      "launch",
    ] as const) {
      expect(isIntentChainAllowed(kind, 56), kind).toBe(true);
      expect(isIntentChainAllowed(kind, 1), kind).toBe(false);
      expect(isIntentChainAllowed(kind, 97), kind).toBe(kind === "launch");
    }
  });

  it("builds the unsigned transaction with the injected chain and refuses a disallowed pair before any field exists", () => {
    expect(
      buildUnsignedTransaction({ ...call, kind: "send", chainReference: 56 })
        .chainId,
    ).toBe(56);
    expect(
      buildUnsignedTransaction({ ...call, kind: "launch", chainReference: 97 })
        .chainId,
    ).toBe(97);
    for (const kind of ["send", "approve", "revoke", "swap"] as const) {
      expect(() =>
        buildUnsignedTransaction({ ...call, kind, chainReference: 97 }),
      ).toThrow(InvalidTransactionArgumentError);
    }
    expect(() =>
      buildUnsignedTransaction({ ...call, kind: "launch", chainReference: 1 }),
    ).toThrow(InvalidTransactionArgumentError);
  });

  it("verifies a broadcast against the payload's own chain, not a constant", () => {
    const mainnet = buildUnsignedTransaction({
      ...call,
      kind: "send",
      chainReference: 56,
    });
    const observed = {
      hash: `0x${"7".repeat(64)}`,
      from: mainnet.from,
      to: mainnet.to,
      input: mainnet.data,
      value: 0n,
      nonce: 7,
      chainId: 56,
      blockNumber: null,
    };
    expect(transactionMatchesPayload(observed, mainnet)).toBe(true);
    expect(
      transactionMatchesPayload({ ...observed, chainId: null }, mainnet),
    ).toBe(true);
    expect(
      transactionMatchesPayload({ ...observed, chainId: 97 }, mainnet),
    ).toBe(false);
    const testnetLaunch = buildUnsignedTransaction({
      ...call,
      kind: "launch",
      chainReference: 97,
    });
    expect(
      transactionMatchesPayload({ ...observed, chainId: 97 }, testnetLaunch),
    ).toBe(true);
    expect(
      transactionMatchesPayload({ ...observed, chainId: 56 }, testnetLaunch),
    ).toBe(false);
  });
});

describe("403 POLICY_BLOCKED detailsSafe enumeration (Decision 0071)", () => {
  it("lists every policy refusal code and nothing from the 422 family", () => {
    const { nativeAssetNotApprovable, ...policy } =
      walletIntentRefusalReasonCodes;
    expect([...policyBlockedReasonCodes].sort()).toEqual(
      Object.values(policy).sort(),
    );
    expect(policyBlockedReasonCodes).not.toContain(nativeAssetNotApprovable);
  });

  it("keeps the seven-field envelope and types the reason slot", () => {
    expect(Object.keys(policyBlockedErrorSchema.properties).sort()).toEqual([
      "category",
      "code",
      "correlationId",
      "detailsSafe",
      "providerReferenceSafe",
      "retryable",
      "userMessageKey",
    ]);
    const [typed, nullable] = policyBlockedErrorSchema.properties.detailsSafe
      .anyOf as readonly [
      {
        readonly additionalProperties: boolean;
        readonly required: readonly string[];
        readonly properties: Record<string, unknown>;
      },
      { readonly type: string },
    ];
    expect(typed.additionalProperties).toBe(false);
    expect(typed.required).toEqual(["reasonCode"]);
    expect(Object.keys(typed.properties).sort()).toEqual([
      "ceilingUsd",
      "exposureUsd",
      "reasonCode",
      "remainingUsd",
      "spentUsd",
    ]);
    expect(nullable).toEqual({ type: "null" });
  });
});
