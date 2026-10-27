import { randomUUID } from "node:crypto";

import { miningDefaultParameterDocument } from "../../src/features/mining/hourly-settlement-contract.js";

/**
 * Decision 0188: the power list (roster) is the only rule for a bound
 * asset's community weight — fixtures that used to approve a
 * `community_mining_weights` row approve a mining parameter version that
 * lets the external tokens in (`includedAssets`) at the given weights.
 */
export async function approveMiningPowerList(
  db: {
    query: (
      text: string,
      values?: readonly unknown[],
    ) => Promise<{ rows: Record<string, unknown>[] }>;
  },
  input: {
    readonly weights: readonly { assetId: string; weight: string }[];
    readonly includedAssets?: readonly string[];
    readonly excludedAssets?: readonly string[];
    /** SQL timestamp expression; default: one second ago. */
    readonly effectiveFrom?: string;
  },
): Promise<{ versionId: string; configVersion: string }> {
  const versionId = randomUUID();
  const configVersion = `power-list-${versionId.slice(0, 8)}`;
  await db.query(
    `insert into public.mining_parameter_versions (version_id, config_version, status,
       document, effective_from, draft_author_actor, approved_by, approved_at)
     values ($1, $2, 'approved', $3::jsonb,
       coalesce($4::timestamptz, clock_timestamp() - interval '1 second'),
       'seed', 'seed-reviewer', clock_timestamp())`,
    [
      versionId,
      configVersion,
      JSON.stringify({
        ...miningDefaultParameterDocument,
        releaseStartAt: "2026-01-01T00:00:00.000Z",
        assetWeights: [...input.weights].sort((a, b) =>
          a.assetId < b.assetId ? -1 : 1,
        ),
        communityCoefficients: [],
        includedAssets: [
          ...(input.includedAssets ??
            input.weights.map((entry) => entry.assetId)),
        ].sort(),
        excludedAssets: [...(input.excludedAssets ?? [])].sort(),
      }),
      input.effectiveFrom ?? null,
    ],
  );
  return { versionId, configVersion };
}
