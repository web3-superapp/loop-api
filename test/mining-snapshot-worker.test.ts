import { describe, expect, it, vi } from "vitest";

import type { AssetRecord } from "../src/database/chain-registry-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import {
  createUnavailableMiningRepository,
  type MiningFormulaRecord,
  type MiningRepository,
  type WriteMiningSnapshotInput,
} from "../src/features/mining/mining-repository.js";
import { calls } from "./s7-route-fakes.js";
import {
  createMiningSnapshotWorker,
  type MiningPriceReader,
} from "../src/mining-snapshot-worker.js";

const loopAssetId = "eip155:56:0x0000000000000000000000000000000000000001";
const communityAssetId = "eip155:56:0x0000000000000000000000000000000000000002";
const alice = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const hash = `0x${"b".repeat(64)}`;

/** TEST-ONLY formula fixture; no approved formula exists in the product. */
const approvedTestFormula: MiningFormulaRecord = {
  configVersion: "miningFormulaTestOnly",
  formula: {
    kind: "holding_times_reference_price_times_weight",
    expressionKey: "mining.rules.formula.holdingTimesReferencePriceTimesWeight",
    dailyOutputKey: "mining.rules.dailyOutput.shareOfNetworkPower",
    assetWeights: { [loopAssetId]: "1" },
    referralBoost: { status: "pending_approval" },
  },
  weightRange: {
    loop: { status: "approved", descriptionKey: "k" },
    community: { status: "pending_approval", descriptionKey: "k" },
    reviewFactorKeys: [],
  },
  priceGuardRules: [],
  status: "approved",
  effectiveAt: "2026-09-08T00:00:00.000Z",
  approvedAt: "2026-09-08T00:00:00.000Z",
  createdAt: "2026-09-08T00:00:00.000Z",
};

const loopAsset: AssetRecord = Object.freeze({
  assetId: loopAssetId,
  chainId: bscChainId,
  address: "0x0000000000000000000000000000000000000001",
  symbol: "LOOP",
  name: "LOOP",
  decimals: 18,
  status: "verified",
  sourceKind: "chain_call",
  sourceBlockNumber: "1",
  sourceVerifiedAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
});

function repositoryFake(
  overrides: Partial<MiningRepository> = {},
): MiningRepository {
  return {
    ...createUnavailableMiningRepository(),
    getApprovedFormula: vi.fn(() => Promise.resolve(null)),
    listBalanceInputs: vi.fn(() =>
      Promise.resolve([
        {
          ownerUserId: alice,
          walletId: "d64786bb-408d-415d-8a69-6277d56c921b",
          assetId: loopAssetId,
          decimals: 18,
          rawValue: "4000000000000000000",
          blockNumber: "500",
          blockHash: hash,
        },
      ]),
    ),
    listCommunityWeightInputs: vi.fn((configVersion: string) =>
      Promise.resolve(
        configVersion === approvedTestFormula.configVersion
          ? []
          : [
              {
                communityId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                assetId: communityAssetId,
                weight: "0.9",
                status: "approved" as const,
              },
            ],
      ),
    ),
    writeSnapshot: vi.fn((input: WriteMiningSnapshotInput) =>
      Promise.resolve({
        snapshotId: input.snapshotId,
        blockNumber: input.blockNumber,
        blockHash: input.blockHash,
        formulaVersion: input.formulaVersion,
        priceVersion: input.priceVersion,
        totalPower: input.totalPower,
        accountCount: 1,
        computedAt: "2026-09-08T00:05:00.000Z",
      }),
    ),
    ...overrides,
  };
}

function priceReader(
  quality: "fresh" | "stale",
  proxyAsset: string | null = null,
): MiningPriceReader {
  return {
    readAssetPrice: vi.fn(() =>
      Promise.resolve({
        fact: {
          value: {
            tokenAddress: "0x0000000000000000000000000000000000000001",
            pairs: [],
          },
          source: "dexscreener" as const,
          fetchedAt: "2026-09-08T00:04:00.000Z",
          ttlSeconds: 30,
          quality,
          reasonCode: null,
          rawDigest: null,
        },
        pair: {
          pairAddress: "0x172fcd41e0913e95784454622d1c3724f546f849",
          dexId: "pancakeswap",
          labels: [],
          baseTokenAddress: "0x0000000000000000000000000000000000000001",
          baseTokenSymbol: "LOOP",
          quoteTokenAddress: "0x55d398326f99059ff775485246999027b3197955",
          quoteTokenSymbol: "USDT",
          priceUsd: "0.5",
          priceNative: null,
          liquidityUsd: "1000",
          volumeH24: null,
          priceChangeH24: null,
          fdv: null,
          marketCap: null,
          buysH24: null,
          sellsH24: null,
          pairCreatedAt: null,
        },
        proxyAsset,
      }),
    ),
  };
}

describe("mining-snapshot lane", () => {
  it("is idle with MINING_FORMULA_BASELINE_PENDING and reads nothing else without an approved formula", async () => {
    const repository = repositoryFake();
    const prices = priceReader("fresh");
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
      prices,
    });
    expect(worker.lane).toBe("mining-snapshot");
    const result = await worker.runOnce();
    expect(result).toEqual({
      kind: "idle",
      reasonCode: "MINING_FORMULA_BASELINE_PENDING",
      snapshotId: null,
      powerRowCount: 0,
      skipped: [],
    });
    expect(calls(repository, "listBalanceInputs")).not.toHaveBeenCalled();
    expect(calls(prices, "readAssetPrice")).not.toHaveBeenCalled();
    expect(calls(repository, "writeSnapshot")).not.toHaveBeenCalled();
  });

  it("computes and writes a snapshot under an approved formula with fresh prices", async () => {
    const repository = repositoryFake({
      getApprovedFormula: vi.fn(() => Promise.resolve(approvedTestFormula)),
    });
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
      prices: priceReader("fresh"),
      createUuid: () => "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
    });
    const result = await worker.runOnce();
    expect(result).toMatchObject({
      kind: "snapshotted",
      snapshotId: "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      powerRowCount: 1,
    });
    expect(calls(repository, "writeSnapshot")).toHaveBeenCalledWith(
      expect.objectContaining({
        formulaVersion: "miningFormulaTestOnly",
        blockNumber: "500",
        blockHash: hash,
        priceVersion: "dexscreener:2026-09-08T00:04:00.000Z",
        totalPower: "2",
        powers: [
          expect.objectContaining({
            ownerUserId: alice,
            assetId: loopAssetId,
            power: "2",
          }),
        ],
      }),
    );
  });

  it("asks for community weights of the approved formula version only and never weights an asset the formula does not list", async () => {
    const repository = repositoryFake({
      getApprovedFormula: vi.fn(() => Promise.resolve(approvedTestFormula)),
      listBalanceInputs: vi.fn(() =>
        Promise.resolve([
          {
            ownerUserId: alice,
            walletId: "d64786bb-408d-415d-8a69-6277d56c921b",
            assetId: communityAssetId,
            decimals: 18,
            rawValue: "1000000000000000000",
            blockNumber: "500",
            blockHash: hash,
          },
        ]),
      ),
    });
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([])) },
      prices: priceReader("fresh"),
    });
    const result = await worker.runOnce();
    expect(calls(repository, "listCommunityWeightInputs")).toHaveBeenCalledWith(
      "miningFormulaTestOnly",
    );
    expect(result.kind).toBe("idle");
    // The community asset is not in the formula's assetWeights, so no price
    // is even read for it and it is skipped as unweighted (Decision 0043).
    expect(result.skipped).toEqual([
      {
        assetId: communityAssetId,
        reasonCode: "MINING_ASSET_WEIGHT_NOT_CONFIGURED",
      },
    ]);
    expect(calls(repository, "writeSnapshot")).not.toHaveBeenCalled();
  });

  it("stays idle when the only price is stale or proxied and never writes", async () => {
    for (const [quality, proxy] of [
      ["stale", null],
      ["fresh", "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"],
    ] as const) {
      const repository = repositoryFake({
        getApprovedFormula: vi.fn(() => Promise.resolve(approvedTestFormula)),
      });
      const worker = createMiningSnapshotWorker({
        repository,
        registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
        prices: priceReader(quality, proxy),
      });
      const result = await worker.runOnce();
      expect(result.kind).toBe("idle");
      expect(result.reasonCode).toBe("MINING_PRICE_NOT_FRESH");
      expect(calls(repository, "writeSnapshot")).not.toHaveBeenCalled();
    }
  });

  it("stops the loop on abort and reports infrastructure backoff on a failure", async () => {
    const backoffs: unknown[] = [];
    const repository = repositoryFake({
      getApprovedFormula: vi.fn(() =>
        Promise.reject(new Error("database unavailable")),
      ),
    });
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([])) },
      prices: priceReader("fresh"),
      onInfrastructureBackoff: (event) => backoffs.push(event),
    });
    const controller = new AbortController();
    const running = worker.run(controller.signal);
    await vi.waitFor(() => expect(backoffs.length).toBeGreaterThan(0));
    controller.abort();
    await running;
    expect(backoffs[0]).toMatchObject({
      reasonCode: "mining_snapshot_unavailable",
      consecutiveFailureCount: 1,
      retryDelayMs: 1_000,
    });
  });
});
