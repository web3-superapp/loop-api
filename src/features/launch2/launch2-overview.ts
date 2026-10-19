import { v2ContractVersion } from "../meta/product-policy.js";
import type { TraderAccountProjection } from "../profile/wallet-account-directory.js";
import { formatLaunch2Amount, type Launch2Stage } from "./launch2-contract.js";
import type {
  Launch2ActivityRecord,
  Launch2OverviewInstanceFacts,
} from "./launch2-ports.js";
import { deriveLaunch2StageOf } from "./launch2-stage.js";

/**
 * Decision 0139: `GET /v2/launch2/overview` — the launchpad's live activity
 * feed (newest 30 indexed facts across instances) and its scoreboard. Pure
 * projection of what the repository read; nothing here reads the chain.
 */

export const launch2OverviewActivityLimit = 30;

/** The server's UTC Monday 00:00 of the week containing `now`. */
export function launch2WeekStart(now: Date): Date {
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  return new Date(midnight - sinceMonday * 86_400_000);
}

function compareActivity(
  a: Launch2ActivityRecord,
  b: Launch2ActivityRecord,
): number {
  const at = Date.parse(b.at) - Date.parse(a.at);
  if (at !== 0) return at;
  const block = nullableDescending(
    a.blockNumber === null ? null : BigInt(a.blockNumber),
    b.blockNumber === null ? null : BigInt(b.blockNumber),
  );
  if (block !== 0) return block;
  const log = nullableDescending(
    a.logIndex === null ? null : BigInt(a.logIndex),
    b.logIndex === null ? null : BigInt(b.logIndex),
  );
  if (log !== 0) return log;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const ah = a.transactionHash ?? "";
  const bh = b.transactionHash ?? "";
  return ah === bh ? 0 : ah < bh ? -1 : 1;
}

/** Descending, nulls last (the SQL `desc nulls last`). */
function nullableDescending(a: bigint | null, b: bigint | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a > b ? -1 : a < b ? 1 : 0;
}

function activityOf(
  record: Launch2ActivityRecord,
  accounts: ReadonlyMap<string, TraderAccountProjection | null>,
): Record<string, unknown> {
  return Object.freeze({
    kind: record.kind,
    instanceId: record.instanceId,
    ticker: record.ticker,
    name: record.name,
    logoUrl: record.logoUrl,
    actor: record.actor,
    // Decision 0162: the actor's LOOP account under the trade-visibility rule.
    account:
      record.actor === null
        ? null
        : (accounts.get(record.actor.toLowerCase()) ?? null),
    amountUsd1:
      record.amountUsd1 === null
        ? null
        : formatLaunch2Amount(BigInt(record.amountUsd1)),
    at: record.at,
    transactionHash: record.transactionHash,
  });
}

const liveStages: ReadonlySet<Launch2Stage> = new Set([
  "nft_sale",
  "priority",
  "public",
]);

export function projectLaunch2Overview(input: {
  readonly activity: readonly Launch2ActivityRecord[];
  readonly facts: readonly Launch2OverviewInstanceFacts[];
  readonly now: Date;
  /** Decision 0162: lower-case actor address → account (absent = null). */
  readonly accounts?: ReadonlyMap<string, TraderAccountProjection | null>;
}): Record<string, unknown> {
  const accounts = input.accounts ?? new Map();
  const nowSeconds = BigInt(Math.floor(input.now.getTime() / 1000));
  const weekStart = launch2WeekStart(input.now).getTime();
  const counts = new Map<Launch2Stage, number>();
  let graduatedThisWeek = 0;
  let buyback = 0n;
  let minted = 0n;
  for (const facts of input.facts) {
    const { stage } = deriveLaunch2StageOf(facts, nowSeconds);
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
    if (
      stage === "graduated" &&
      facts.graduation !== null &&
      Date.parse(facts.graduation.graduatedAt) >= weekStart
    ) {
      graduatedThisWeek += 1;
    }
    buyback += BigInt(facts.buybackUsd1);
    minted += BigInt(facts.nftMintedCount);
  }
  const count = (stage: Launch2Stage): number => counts.get(stage) ?? 0;
  let live = 0;
  for (const stage of liveStages) live += count(stage);
  return Object.freeze({
    activity: [...input.activity]
      .sort(compareActivity)
      .slice(0, launch2OverviewActivityLimit)
      .map((record) => activityOf(record, accounts)),
    stats: Object.freeze({
      liveCount: live,
      mintingCount: count("nft_sale"),
      priorityCount: count("priority"),
      curveCount: count("public"),
      upcomingCount: count("upcoming"),
      graduatedTotal: count("graduated"),
      graduatedThisWeek,
      buybackUsd1Total: formatLaunch2Amount(buyback),
      nftMintedTotal: Number(minted),
    }),
    observedAt: input.now.toISOString(),
    contractVersion: v2ContractVersion,
  });
}
