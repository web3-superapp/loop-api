import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { isOpaqueId } from "../../core/ids/opaque-id.js";
import type {
  AccountWalletRecord,
  AccountWalletRepository,
} from "../../database/account-wallet-repository.js";
import type {
  WalletNetWorthQuality,
  WalletNetWorthSnapshotRecord,
  WalletNetWorthSnapshotRepository,
} from "../../database/wallet-networth-snapshot-repository.js";
import {
  compareDecimalStrings,
  divideDecimalStrings,
  multiplyDecimalStrings,
  subtractDecimalStrings,
} from "../market/market-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  netWorthChangePctDigits,
  netWorthChangeUsdDigits,
  roundHalfAwayFromZero,
} from "./net-worth-change.js";
import type { WalletNetWorthMeasurement } from "./wallet-read-service.js";

/**
 * Decision 0145: `GET /v2/wallets/:walletId/networth/history`. The points
 * are the hourly `wallet_networth_snapshots` rows downsampled per range;
 * `current` is measured live with the balances valuation and falls back to
 * the newest snapshot when the live read is unavailable. Display
 * information only: nothing here is a balance.
 */

export const walletNetWorthHistoryReasonCodes = Object.freeze({
  historyUnavailable: "WALLET_NETWORTH_HISTORY_UNAVAILABLE",
  currentUnavailable: "WALLET_NETWORTH_CURRENT_UNAVAILABLE",
} as const);

export const walletNetWorthHistoryRanges = Object.freeze([
  "1d",
  "7d",
  "30d",
  "180d",
  "360d",
] as const);

export type WalletNetWorthHistoryRange =
  (typeof walletNetWorthHistoryRanges)[number];

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;

/** Window and downsampling slot per range (Decision 0145 §3). */
export const walletNetWorthRangePolicy: Readonly<
  Record<
    WalletNetWorthHistoryRange,
    { readonly windowMs: number; readonly bucketSeconds: number }
  >
> = Object.freeze({
  "1d": { windowMs: dayMs, bucketSeconds: 3_600 },
  "7d": { windowMs: 7 * dayMs, bucketSeconds: 4 * 3_600 },
  "30d": { windowMs: 30 * dayMs, bucketSeconds: 86_400 },
  "180d": { windowMs: 180 * dayMs, bucketSeconds: 3 * 86_400 },
  "360d": { windowMs: 360 * dayMs, bucketSeconds: 7 * 86_400 },
});

export const walletNetWorthHistoryMaxPoints = 120;

/**
 * The 24 h baseline is the newest snapshot at or before `current.at − 24 h`
 * and no older than `current.at − 48 h`; an older one is not "24 h ago".
 */
export const walletNetWorthBaselineToleranceMs = dayMs;

/** CNY amounts are rounded half away from zero to 2 places. */
export const walletNetWorthFiatDigits = 2;

export interface WalletNetWorthHistoryResource {
  readonly walletId: string;
  readonly range: WalletNetWorthHistoryRange;
  readonly points: readonly {
    readonly at: string;
    readonly netWorthUsd: string;
    readonly quality: WalletNetWorthQuality;
  }[];
  readonly current: {
    readonly netWorthUsd: string;
    readonly at: string;
    readonly quality: WalletNetWorthQuality;
    /** `live`: measured for this response; `snapshot`: the newest snapshot. */
    readonly origin: "live" | "snapshot";
  };
  readonly change24h: {
    readonly usd: string;
    /** Null when the baseline is zero (no percentage of nothing). */
    readonly pct: string | null;
    readonly baselineAt: string;
  } | null;
  readonly high: { readonly at: string; readonly netWorthUsd: string } | null;
  readonly low: { readonly at: string; readonly netWorthUsd: string } | null;
  readonly fiat: {
    readonly currency: "CNY";
    readonly rate: string;
    readonly amount: string;
  } | null;
  readonly source: "dexscreener";
  readonly observedAt: string;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface WalletNetWorthHistoryService {
  getHistory(input: {
    readonly principal: Pick<AuthenticatedLoopPrincipal, "userId">;
    readonly walletId: string;
    readonly range: unknown;
    readonly signal: AbortSignal;
  }): Promise<WalletNetWorthHistoryResource>;
}

export interface CreateWalletNetWorthHistoryServiceInput {
  readonly wallets: Pick<AccountWalletRepository, "get">;
  /** `null`: the snapshot table is not composed (503). */
  readonly snapshots: WalletNetWorthSnapshotRepository | null;
  /**
   * Live measurement with the balances valuation; `null` when the market
   * runtime is not composed. Rejecting or answering `null` falls back to
   * the newest snapshot.
   */
  readonly measure:
    | ((
        wallet: AccountWalletRecord,
        signal: AbortSignal,
      ) => Promise<WalletNetWorthMeasurement | null>)
    | null;
  /** FIAT_CNY_PER_USD as a canonical positive decimal, or null. */
  readonly fiatCnyPerUsd: string | null;
  readonly now?: () => Date;
}

function unavailable(reasonCode: string): V2ApiError {
  return V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", { reasonCode });
}

function isRange(value: unknown): value is WalletNetWorthHistoryRange {
  return (
    typeof value === "string" &&
    (walletNetWorthHistoryRanges as readonly string[]).includes(value)
  );
}

export function createWalletNetWorthHistoryService(
  input: CreateWalletNetWorthHistoryServiceInput,
): WalletNetWorthHistoryService {
  const now = input.now ?? ((): Date => new Date());

  return Object.freeze({
    async getHistory({
      principal,
      walletId,
      range,
      signal,
    }: {
      readonly principal: Pick<AuthenticatedLoopPrincipal, "userId">;
      readonly walletId: string;
      readonly range: unknown;
      readonly signal: AbortSignal;
    }): Promise<WalletNetWorthHistoryResource> {
      if (!isOpaqueId(walletId) || !isRange(range)) {
        throw V2ApiError.invalidRequest();
      }
      const wallet = await input.wallets.get(principal.userId, walletId);
      if (wallet === null) {
        throw V2ApiError.notFound();
      }
      const snapshots = input.snapshots;
      if (snapshots === null) {
        throw unavailable(walletNetWorthHistoryReasonCodes.historyUnavailable);
      }
      const observedAt = now();
      const policy = walletNetWorthRangePolicy[range];
      const until = observedAt.toISOString();
      const since = new Date(
        observedAt.getTime() - policy.windowMs,
      ).toISOString();

      const measure = input.measure;
      const livePending: Promise<WalletNetWorthMeasurement | null> =
        measure === null
          ? Promise.resolve(null)
          : measure(wallet, signal).catch(() => null);

      let points: readonly WalletNetWorthSnapshotRecord[];
      let extremes: Awaited<
        ReturnType<WalletNetWorthSnapshotRepository["readExtremes"]>
      >;
      let latest: WalletNetWorthSnapshotRecord | null;
      try {
        [points, extremes, latest] = await Promise.all([
          snapshots.readDownsampled({
            walletId: wallet.walletId,
            since,
            until,
            bucketSeconds: policy.bucketSeconds,
            limit: walletNetWorthHistoryMaxPoints,
          }),
          snapshots.readExtremes({ walletId: wallet.walletId, since, until }),
          snapshots.readLatest({
            walletId: wallet.walletId,
            notAfter: until,
            notBefore: null,
          }),
        ]);
      } catch {
        void livePending.catch(() => undefined);
        throw unavailable(walletNetWorthHistoryReasonCodes.historyUnavailable);
      }

      const live = await livePending;
      const current =
        live !== null
          ? Object.freeze({
              netWorthUsd: live.netWorthUsd,
              at: observedAt.toISOString(),
              quality: live.quality,
              origin: "live" as const,
            })
          : latest !== null
            ? Object.freeze({
                netWorthUsd: latest.netWorthUsd,
                at: latest.at,
                // An old reading is at best stale; a partial one stays partial.
                quality:
                  latest.quality === "partial"
                    ? ("partial" as const)
                    : ("stale" as const),
                origin: "snapshot" as const,
              })
            : null;
      if (current === null) {
        throw unavailable(walletNetWorthHistoryReasonCodes.currentUnavailable);
      }

      const currentAtMs = Date.parse(current.at);
      let baseline: WalletNetWorthSnapshotRecord | null;
      try {
        baseline = await snapshots.readLatest({
          walletId: wallet.walletId,
          notAfter: new Date(currentAtMs - dayMs).toISOString(),
          notBefore: new Date(
            currentAtMs - dayMs - walletNetWorthBaselineToleranceMs,
          ).toISOString(),
        });
      } catch {
        throw unavailable(walletNetWorthHistoryReasonCodes.historyUnavailable);
      }

      return Object.freeze({
        walletId: wallet.walletId,
        range,
        points: Object.freeze(
          points.map((point) =>
            Object.freeze({
              at: point.at,
              netWorthUsd: point.netWorthUsd,
              quality: point.quality,
            }),
          ),
        ),
        current,
        change24h:
          baseline === null ? null : change(current.netWorthUsd, baseline),
        high: pickExtreme(extremes.high, current, "high"),
        low: pickExtreme(extremes.low, current, "low"),
        fiat:
          input.fiatCnyPerUsd === null
            ? null
            : Object.freeze({
                currency: "CNY" as const,
                rate: input.fiatCnyPerUsd,
                amount: roundHalfAwayFromZero(
                  multiplyDecimalStrings(
                    current.netWorthUsd,
                    input.fiatCnyPerUsd,
                  ),
                  walletNetWorthFiatDigits,
                ),
              }),
        source: "dexscreener" as const,
        observedAt: observedAt.toISOString(),
        contractVersion: v2ContractVersion,
      });
    },
  });
}

function change(
  currentUsd: string,
  baseline: WalletNetWorthSnapshotRecord,
): NonNullable<WalletNetWorthHistoryResource["change24h"]> {
  const delta = subtractDecimalStrings(currentUsd, baseline.netWorthUsd);
  const pct =
    compareDecimalStrings(baseline.netWorthUsd, "0") <= 0
      ? null
      : roundHalfAwayFromZero(
          divideDecimalStrings(
            multiplyDecimalStrings(delta, "100"),
            baseline.netWorthUsd,
            24,
          ) ?? "0",
          netWorthChangePctDigits,
        );
  return Object.freeze({
    usd: roundHalfAwayFromZero(delta, netWorthChangeUsdDigits),
    pct,
    baselineAt: baseline.at,
  });
}

/**
 * The range's high / low over the non-partial snapshots, with the current
 * reading counted too when it is not partial.
 */
function pickExtreme(
  snapshot: WalletNetWorthSnapshotRecord | null,
  current: WalletNetWorthHistoryResource["current"],
  side: "high" | "low",
): { readonly at: string; readonly netWorthUsd: string } | null {
  const candidates: { readonly at: string; readonly netWorthUsd: string }[] =
    [];
  if (snapshot !== null) {
    candidates.push({ at: snapshot.at, netWorthUsd: snapshot.netWorthUsd });
  }
  if (current.quality !== "partial") {
    candidates.push({ at: current.at, netWorthUsd: current.netWorthUsd });
  }
  let best: { readonly at: string; readonly netWorthUsd: string } | null = null;
  for (const candidate of candidates) {
    if (best === null) {
      best = candidate;
      continue;
    }
    const order = compareDecimalStrings(
      candidate.netWorthUsd,
      best.netWorthUsd,
    );
    if ((side === "high" && order > 0) || (side === "low" && order < 0)) {
      best = candidate;
    }
  }
  return best === null ? null : Object.freeze({ ...best });
}
