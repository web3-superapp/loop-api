import type { Pool } from "pg";
import type {
  MiningRepository,
  MiningFormulaRecord,
} from "../mining/mining-repository.js";
import { createPostgresMiningRepository } from "../../database/mining-repository.js";
import {
  createMiningSnapshotWorker,
  type CreateMiningSnapshotWorkerOptions,
} from "../../mining-snapshot-worker.js";
import { miningPackageSchema, opsHash, OpsError } from "./ops-contract.js";

export type OpsMiningRuntime = Pick<
  CreateMiningSnapshotWorkerOptions,
  "registry" | "prices"
> & {
  forTransaction?: (
    pool: Pool,
  ) => Pick<CreateMiningSnapshotWorkerOptions, "registry" | "prices">;
};
export async function runOpsMiningJob(
  pool: Pool,
  job: { action: string; target: string; payload: Record<string, unknown> },
  runtime: OpsMiningRuntime,
) {
  runtime = runtime.forTransaction?.(pool) ?? runtime;
  const source = createPostgresMiningRepository(pool);
  const evidence: Record<string, unknown> = {};
  let formula: MiningFormulaRecord | null;
  let repo: MiningRepository = source;
  if (job.action === "mining.trial") {
    const draft = (
      await pool.query<{
        revision: number;
        content_hash: string;
        package: unknown;
      }>("select * from public.ops_mining_drafts where id=$1 for share", [
        job.target,
      ])
    ).rows[0];
    if (
      !draft ||
      draft["revision"] !== job.payload["expectedRevision"] ||
      draft["content_hash"] !== job.payload["contentHash"]
    )
      throw new OpsError("OPS_VERSION_CONFLICT");
    const pkg = miningPackageSchema.parse(draft["package"]);
    formula = {
      ...pkg,
      status: "pending_approval",
      effectiveAt: null,
      approvedAt: null,
      createdAt: new Date().toISOString(),
    };
    const communities = (
      await pool.query<{
        community_id: string;
        bound_asset_key: string | null;
      }>(
        "select community_id,bound_asset_key from public.communities where bound_asset_key is not null for share",
      )
    ).rows;
    for (const w of pkg.communityWeights) {
      if (
        communities.find((c) => c.community_id === w.communityId)
          ?.bound_asset_key !== w.boundAssetId
      )
        throw new OpsError("OPS_COMMUNITY_BINDING_CHANGED");
    }
    const weights = communities.map((c) => ({
      communityId: c.community_id,
      assetId: c.bound_asset_key!,
      weight:
        pkg.communityWeights.find((w) => w.communityId === c.community_id)
          ?.weight ?? null,
      status: pkg.communityWeights.some((w) => w.communityId === c.community_id)
        ? ("approved" as const)
        : ("pending_review" as const),
    }));
    repo = {
      ...source,
      getApprovedFormula: () => Promise.resolve(formula),
      listCommunityWeightInputs: () => Promise.resolve(weights),
      writeSnapshot: (input) => {
        evidence["computation"] = input;
        return Promise.resolve({
          ...input,
          accountCount: new Set(input.powers.map((p) => p.ownerUserId)).size,
          computedAt: new Date().toISOString(),
        });
      },
      writeIncompleteSnapshot: (input) => {
        evidence["computation"] = input;
        return Promise.resolve({
          ...input,
          status: "incomplete",
          computedAt: new Date().toISOString(),
          invalidatedAt: null,
          invalidationReason: null,
        });
      },
    };
  } else {
    formula = await source.getApprovedFormula();
    if (
      !formula ||
      formula.configVersion !== job.payload["expectedActiveVersion"]
    )
      throw new OpsError("OPS_ACTIVE_VERSION_CONFLICT");
  }
  evidence["formula"] = formula;
  const original = repo;
  repo = {
    ...repo,
    writeSnapshot: async (input) => {
      evidence["computation"] = input;
      return original.writeSnapshot(input);
    },
    writeIncompleteSnapshot: async (input) => {
      evidence["computation"] = input;
      return original.writeIncompleteSnapshot(input);
    },
    listBalanceInputs: async (options) => {
      const rows = await original.listBalanceInputs(options);
      evidence["balances"] = rows;
      return rows;
    },
    listCommunityWeightInputs: async (version) => {
      const rows = await original.listCommunityWeightInputs(version);
      evidence["communityWeights"] = rows;
      return rows;
    },
  };
  const prices: unknown[] = [];
  const result = await createMiningSnapshotWorker({
    repository: repo,
    registry: {
      listAssets: async (ids) => {
        const rows = await runtime.registry.listAssets(ids);
        evidence["assets"] = rows;
        return rows;
      },
    },
    prices: {
      readAssetPrice: async (asset, options) => {
        const fact = await runtime.prices.readAssetPrice(asset, options);
        prices.push({ kind: "asset", asset, fact });
        return fact;
      },
      readPair: async (address, options) => {
        const fact = await runtime.prices.readPair(address, options);
        prices.push({ kind: "pair", address, fact });
        return fact;
      },
    },
    includeMockSeedHoldings: false,
  }).runOnce(AbortSignal.timeout(8000));
  evidence["priceFacts"] = prices;
  const computation = evidence["computation"] as
    Record<string, unknown> | undefined;
  return {
    result: {
      ...result,
      summary: computation
        ? {
            totalPower: computation["totalPower"] ?? null,
            blockNumber: computation["blockNumber"],
            blockHash: computation["blockHash"],
            priceVersion: computation["priceVersion"],
            formulaVersion: computation["formulaVersion"],
          }
        : null,
      configHash: opsHash(formula),
      snapshotId: job.action === "mining.trial" ? null : result.snapshotId,
      published: job.action !== "mining.trial" && result.kind === "snapshotted",
    },
    evidence,
    inputHash: opsHash(evidence),
  };
}
