import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { V2ApiError } from "../src/core/http/v2-error.js";
import type { AssetRecord } from "../src/database/chain-registry-repository.js";
import { createApprovalService } from "../src/features/wallet-intents/approval-service.js";
import { isIntentChainAllowed } from "../src/features/wallet-intents/intent-contract.js";
import { createWalletIntentService } from "../src/features/wallet-intents/wallet-intent-service.js";
import type { BscChainCallClient } from "../src/integrations/bsc/rpc-client.js";
import {
  nativeAsset,
  principal,
  readClientFake,
  registryFake,
  runtimeFake,
  spenderAddress,
  usdtAsset,
  usdtAssetId,
  walletId,
  wbnbAsset,
} from "./wallet-intent-fakes.js";

/**
 * Decision 0077: the launch slot's testnet (97) admits exactly one
 * allowance target — USD1 towards the Launch contract — valued at par
 * under the Decision 0065 canary. Send, swap, and every other approval stay
 * on 56. Fixtures only.
 */

const launchContract = "0x1111111111111111111111111111111111111111";
const launchUsd1 = "0x2222222222222222222222222222222222222222";
const usd1AssetId = `eip155:97:${launchUsd1}`;
const otherTestnetToken = "0x4444444444444444444444444444444444444444";
const signal = new AbortController().signal;

const usd1Asset: AssetRecord = Object.freeze({
  assetId: usd1AssetId,
  chainId: "eip155:97",
  address: launchUsd1,
  symbol: "USD1",
  name: "Mock USD1",
  decimals: 18,
  status: "pending",
  sourceKind: "chain_call",
  sourceBlockNumber: "1",
  sourceVerifiedAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
});
const otherAsset: AssetRecord = Object.freeze({
  ...usd1Asset,
  assetId: `eip155:97:${otherTestnetToken}`,
  address: otherTestnetToken,
});

function testnetClient(): BscChainCallClient {
  // 100 USD1 held: the approval exposure is min(allowance, balance).
  const base = readClientFake({
    code: { [launchContract]: "0x60" },
    tokenBalance: 100_000_000_000_000_000_000n,
  }).client;
  return Object.freeze({ ...base, chainId: "eip155:97", chainReference: 97 });
}

function build(
  options: {
    readonly slot?: boolean;
    readonly canary?: readonly string[];
  } = {},
) {
  const fake = runtimeFake({
    canaryAssetIds: options.canary ?? [usd1AssetId, usdtAssetId],
    canaryMaxUsd: "10",
  });
  const launchClient = testnetClient();
  const runtime = {
    ...fake.runtime,
    registry: registryFake([
      nativeAsset,
      wbnbAsset,
      usdtAsset,
      usd1Asset,
      otherAsset,
    ]),
    launchSlot:
      options.slot === false
        ? null
        : {
            chainId: "eip155:97",
            readClient: launchClient,
            contractAddress: launchContract,
            usd1Address: launchUsd1,
          },
  };
  return {
    approvals: createApprovalService(runtime),
    intents: createWalletIntentService(runtime),
    fake,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof V2ApiError) {
      return `${error.code}${error.detailsSafe === null ? "" : `:${String(error.detailsSafe["reasonCode"])}`}`;
    }
    throw error;
  }
  return "OK";
}

describe("launch-slot USD1 approval (Decision 0077)", () => {
  it("the chain rule admits 97 only for launch intents and the USD1 → Launch contract allowance", () => {
    const target = {
      token: launchUsd1,
      spender: launchContract,
      launchContractAddress: launchContract,
      launchUsd1Address: launchUsd1,
    };
    expect(isIntentChainAllowed("approve", 97, target)).toBe(true);
    expect(isIntentChainAllowed("revoke", 97, target)).toBe(true);
    expect(
      isIntentChainAllowed("approve", 97, {
        ...target,
        spender: spenderAddress,
      }),
    ).toBe(false);
    expect(
      isIntentChainAllowed("approve", 97, {
        ...target,
        token: otherTestnetToken,
      }),
    ).toBe(false);
    expect(isIntentChainAllowed("send", 97, target)).toBe(false);
    expect(isIntentChainAllowed("swap", 97, target)).toBe(false);
    expect(isIntentChainAllowed("approve", 97)).toBe(false);
    expect(isIntentChainAllowed("launch", 97)).toBe(true);
    for (const kind of ["send", "approve", "revoke", "swap"] as const) {
      expect(isIntentChainAllowed(kind, 56)).toBe(true);
    }
  });

  it("builds a chain-97 approve of USD1 to the Launch contract, valued at par", async () => {
    const { approvals, intents } = build();
    const { resource } = await approvals.prepareApprove({
      principal,
      idempotencyKey: randomUUID(),
      body: {
        walletId,
        assetId: usd1AssetId,
        spenderAddress: launchContract,
        allowance: { mode: "exact", amount: "5" },
      },
      signal,
    });
    expect(resource).toMatchObject({
      kind: "approve",
      chainId: "eip155:97",
      state: "awaiting_signature",
      policy: { valueUsd: "5", priceSource: "usd1_par" },
    });
    expect(resource.unsignedTransaction).toMatchObject({
      chainId: 97,
      to: launchUsd1,
    });
    // The same record reads back through the launch slot's client.
    const read = await intents.get({ principal, intentId: resource.intentId });
    expect(read.chainId).toBe("eip155:97");
  });

  it("keeps the canary: ceiling, asset allowlist; and refuses other spenders, other tokens, or no slot", async () => {
    const { approvals } = build();
    const approve = (assetId: string, spender: string, amount = "5") =>
      approvals.prepareApprove({
        principal,
        idempotencyKey: randomUUID(),
        body: {
          walletId,
          assetId,
          spenderAddress: spender,
          allowance: { mode: "exact", amount },
        },
        signal,
      });
    expect(await codeOf(approve(usd1AssetId, launchContract, "11"))).toBe(
      "POLICY_BLOCKED:CANARY_CEILING_EXCEEDED",
    );
    expect(await codeOf(approve(usd1AssetId, spenderAddress))).toBe(
      "CHAIN_MISMATCH",
    );
    expect(
      await codeOf(approve(`eip155:97:${otherTestnetToken}`, launchContract)),
    ).toBe("CHAIN_MISMATCH");
    const noCanary = build({ canary: [usdtAssetId] });
    expect(
      await codeOf(
        noCanary.approvals.prepareApprove({
          principal,
          idempotencyKey: randomUUID(),
          body: {
            walletId,
            assetId: usd1AssetId,
            spenderAddress: launchContract,
            allowance: { mode: "exact", amount: "5" },
          },
          signal,
        }),
      ),
    ).toBe("POLICY_BLOCKED:ASSET_NOT_IN_CANARY_ALLOWLIST");
    const noSlot = build({ slot: false });
    expect(
      await codeOf(
        noSlot.approvals.prepareApprove({
          principal,
          idempotencyKey: randomUUID(),
          body: {
            walletId,
            assetId: usd1AssetId,
            spenderAddress: launchContract,
            allowance: { mode: "exact", amount: "5" },
          },
          signal,
        }),
      ),
    ).toBe("CHAIN_MISMATCH");
  });

  it("leaves a chain-56 approve exactly on 56", async () => {
    const { approvals } = build();
    const { resource } = await approvals.prepareApprove({
      principal,
      idempotencyKey: randomUUID(),
      body: {
        walletId,
        assetId: usdtAssetId,
        spenderAddress,
        allowance: { mode: "exact", amount: "3" },
      },
      signal,
    });
    expect(resource.chainId).toBe("eip155:56");
    expect(resource.unsignedTransaction).toMatchObject({ chainId: 56 });
  });
});
