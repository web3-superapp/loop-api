import {
  MiningSettlementInputError,
  settleMiningHour,
} from "./hourly-settlement-calculator.js";
import {
  formatMiningDecimal,
  miningSettlementReasonCodes,
} from "./hourly-settlement-contract.js";
import type {
  MiningParameterVersionRecord,
  MiningSettlementFacts,
} from "./hourly-settlement-ports.js";
import {
  miningVersionAt,
  prepareMiningHour,
} from "./hourly-settlement-runner.js";
import {
  miningEffectiveAssetWeights,
  type MiningPoolExternalAssets,
} from "./mining-pool-roster.js";
import type {
  MiningSnapshotPower,
  MiningSnapshotSkip,
} from "./mining-snapshot.js";

/**
 * Decision 0187: the pool part of a Mining Power snapshot — the platform
 * MEMEs of the roster, valued by **the settlement's own rules** at one
 * instant. The facts are the settlement facts read for the 1-second window
 * `[at, at + 1)`; the same `prepareMiningHour` + `settleMiningHour` produce
 * each account's self power in that window (membership gate, wallet scope,
 * address attribution, graduation coverage, roster weights and NFT
 * coefficients all identical to the hourly settlement). One row per
 * (account, MEME):
 *
 *   power = MEME balance × token weight + Σ NFTs of that MEME's launch ×
 *           NFT coefficient
 *
 * `holding` is the MEME balance (18 decimals), `weight` the token weight;
 * the NFT part is folded into `power` (no new public key — the client's
 * strict codec would refuse one). Referral power is not part of a snapshot.
 * `referencePriceUsd` is the bonding-curve price after the last indexed
 * curve trade before `at` (for a graduated MEME: its graduation price); it
 * multiplies nothing (Decision 0125) and is published as `fresh` because
 * that is the only quality a chain-derived price can carry in the enum.
 */

export interface MiningPoolSnapshotBlock {
  readonly blockNumber: string;
  readonly blockHash: string;
}

export type MiningPoolSnapshotPart =
  | {
      readonly kind: "computed";
      /** Asset ids the pool owns in this snapshot (the formula path skips them). */
      readonly assetIds: readonly string[];
      readonly powers: readonly MiningSnapshotPower[];
      readonly blockNumber: string;
      readonly blockHash: string;
      readonly priceVersion: string;
      readonly skipped: readonly MiningSnapshotSkip[];
    }
  | {
      readonly kind: "unavailable";
      readonly reasonCode: string;
    };

export const miningPoolSnapshotReasonCodes = Object.freeze({
  /** The launch2 event lane has no checkpoint on the launch chain yet. */
  checkpointMissing: "MINING_POOL_CHECKPOINT_MISSING",
  /** The MEME has no Asset Registry row (or is blocked): no row can be stored. */
  assetUnregistered: "MINING_POOL_ASSET_UNREGISTERED",
  /** The roster row is unticked (token weight 0, NFT coefficient 0). */
  excluded: "MINING_POOL_EXCLUDED",
});

export function computeMiningPoolSnapshot(input: {
  /** Unix seconds of the snapshot instant. */
  readonly at: bigint;
  readonly versions: readonly MiningParameterVersionRecord[];
  /** Roster asset ids on the launch chain. */
  readonly poolAssetIds: readonly string[];
  /** Settlement facts for `[at, at + 1)`. */
  readonly facts: MiningSettlementFacts;
  readonly block: MiningPoolSnapshotBlock | null;
  /** Asset ids with a non-blocked Asset Registry row. */
  readonly registeredAssetIds: ReadonlySet<string>;
  /**
   * Decision 0189: the external roster assets — kept out of the pool part
   * (the formula path values them, weighted by the power list).
   */
  readonly external?: MiningPoolExternalAssets | null;
}): MiningPoolSnapshotPart {
  const version = miningVersionAt(input.versions, input.at);
  if (version === null) {
    return Object.freeze({
      kind: "unavailable" as const,
      reasonCode: miningSettlementReasonCodes.parametersPending,
    });
  }
  if (input.block === null) {
    return Object.freeze({
      kind: "unavailable" as const,
      reasonCode: miningPoolSnapshotReasonCodes.checkpointMissing,
    });
  }
  const poolAssetIds = [...new Set(input.poolAssetIds)].sort();
  const pool = new Set(poolAssetIds);
  let result;
  try {
    const prepared = prepareMiningHour({
      hourStart: input.at,
      versions: input.versions,
      facts: input.facts,
      poolAssetIds,
      ...(input.external === undefined || input.external === null
        ? {}
        : { poolExternal: input.external }),
      windowSeconds: 1n,
    });
    result = settleMiningHour(prepared.input);
  } catch (error) {
    if (error instanceof MiningSettlementInputError) {
      return Object.freeze({
        kind: "unavailable" as const,
        reasonCode: error.reasonCode,
      });
    }
    throw error;
  }
  const weights = miningEffectiveAssetWeights(version.document, poolAssetIds);
  const memeOf = new Map(
    input.facts.nftInstances.map((row) => [row.instanceId, row.memeAssetId]),
  );
  const priceOf = new Map(
    input.facts.assets.map((asset) => [asset.assetId, asset.openingPriceE18]),
  );
  const skipped: MiningSnapshotSkip[] = [];
  for (const assetId of poolAssetIds) {
    if (!input.registeredAssetIds.has(assetId)) {
      skipped.push({
        assetId,
        reasonCode: miningPoolSnapshotReasonCodes.assetUnregistered,
      });
    } else if ((weights.get(assetId) ?? 0n) === 0n) {
      // Token weight 0; the NFT part may still count (coefficient > 0).
      const anyNft = result.users.some((user) =>
        user.nftHoldings.some(
          (holding) =>
            memeOf.get(holding.instanceId) === assetId && holding.power > 0n,
        ),
      );
      if (!anyNft) {
        skipped.push({
          assetId,
          reasonCode: miningPoolSnapshotReasonCodes.excluded,
        });
      }
    }
  }
  const powers: MiningSnapshotPower[] = [];
  for (const user of result.users) {
    const rows = new Map<string, { balance: bigint; power: bigint }>();
    for (const holding of user.assetHoldings) {
      if (!pool.has(holding.assetId)) continue;
      const row = rows.get(holding.assetId) ?? { balance: 0n, power: 0n };
      row.balance += holding.balanceAtEndRaw;
      row.power += holding.power;
      rows.set(holding.assetId, row);
    }
    for (const holding of user.nftHoldings) {
      const assetId = memeOf.get(holding.instanceId);
      if (assetId === undefined || !pool.has(assetId)) continue;
      const row = rows.get(assetId) ?? { balance: 0n, power: 0n };
      row.power += holding.power;
      rows.set(assetId, row);
    }
    for (const [assetId, row] of rows) {
      if (row.power <= 0n || !input.registeredAssetIds.has(assetId)) continue;
      powers.push(
        Object.freeze({
          ownerUserId: user.userId,
          assetId,
          holding: formatMiningDecimal(row.balance),
          referencePriceUsd: formatMiningDecimal(priceOf.get(assetId) ?? 0n),
          referencePriceQuality: "fresh" as const,
          referencePriceProxyAssetId: null,
          referencePricePairAddress: null,
          weight: formatMiningDecimal(weights.get(assetId) ?? 0n),
          power: formatMiningDecimal(row.power),
          blockNumber: input.block.blockNumber,
        }),
      );
    }
  }
  powers.sort((left, right) =>
    left.ownerUserId === right.ownerUserId
      ? left.assetId.localeCompare(right.assetId)
      : left.ownerUserId.localeCompare(right.ownerUserId),
  );
  return Object.freeze({
    kind: "computed" as const,
    assetIds: Object.freeze(poolAssetIds),
    powers: Object.freeze(powers),
    blockNumber: input.block.blockNumber,
    blockHash: input.block.blockHash,
    priceVersion: `launch2_curve:${new Date(Number(input.at) * 1000).toISOString()}`,
    skipped: Object.freeze(skipped),
  });
}
