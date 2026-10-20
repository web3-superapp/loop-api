import { formatLaunch2Amount } from "../launch2/launch2-contract.js";
import type {
  Launch2AddressHolding,
  Launch2Service,
} from "../launch2/launch2-service.js";
import type { Launch2Stage } from "../launch2/launch2-contract.js";
import type {
  WalletActivityMergeRepository,
  WalletLaunch2ActivityItem,
} from "../wallet/wallet-activity-launch2.js";
import type { WalletActivityLaunch2Projection } from "../wallet/wallet-read-service.js";

/**
 * Decision 0169 (S260): the public profile's holdings and trades merged with
 * the owner's MEME v2 (launch2) facts on the Launch chain. Exists only while
 * PROFILE_LAUNCH2_EMIT is on; off keeps both routes byte-identical
 * (Decision 0166 §D).
 *
 * The owner's selected active wallet address is only matched against
 * indexed launch2 facts (and, for a graduated instance, its live MEME
 * balance); it is never published.
 */

export const profileLaunch2ReasonCodes = Object.freeze({
  repositoryUnavailable: "LAUNCH2_REPOSITORY_UNAVAILABLE",
  indexerNotStarted: "LAUNCH2_INDEXER_NOT_STARTED",
  activityReadFailed: "LAUNCH2_ACTIVITY_READ_FAILED",
  holdingsReadFailed: "LAUNCH2_HOLDINGS_READ_FAILED",
} as const);

/** The reads behind the merge; composed only while the switch is on. */
export interface ProfileLaunch2Sources {
  /** CAIP-2 of the Launch chain (`eip155:97`, or `eip155:56`). */
  readonly chainId: string;
  /** Decision 0167 reads; null = not composed (no database). */
  readonly activity: Pick<
    WalletActivityMergeRepository,
    "getLaunch2Checkpoint" | "listLaunch2Activity"
  > | null;
  /** The launch2 runtime; null = not composed. */
  readonly holdings: Pick<Launch2Service, "listAddressHoldings"> | null;
  /** The Launch chain head; null when it cannot be read. */
  readonly readHead: () => Promise<bigint | null>;
}

export type ProfileLaunch2Block = WalletActivityLaunch2Projection;

export const profileLaunch2HoldingKinds = Object.freeze([
  "launch2_meme",
  "launch2_nft",
] as const);
export type ProfileLaunch2HoldingKind =
  (typeof profileLaunch2HoldingKinds)[number];

/** One launch2 holding row of `GET /v2/profiles/{id}/holdings`. */
export interface ProfileLaunch2HoldingItem {
  readonly kind: ProfileLaunch2HoldingKind;
  readonly chainId: string;
  readonly instanceId: string;
  readonly ticker: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly amountMeme: string | null;
  readonly nftCount: number | null;
  readonly stage: Launch2Stage;
  readonly valueUsd1: string | null;
}

export type ProfileLaunch2TradeItem = WalletLaunch2ActivityItem;

const wad = 10n ** 18n;

/**
 * The rows of one instance: a `launch2_meme` row when the MEME held is
 * known and positive, then a `launch2_nft` row when NFTs are held. A
 * graduated balance that could not be read emits no MEME row (never a
 * guessed zero, and loop-mobile requires `amountMeme` on every MEME row).
 * The value is MEME × the indexed last price, null without a price.
 */
export function projectLaunch2Holdings(
  holdings: readonly Launch2AddressHolding[],
): readonly ProfileLaunch2HoldingItem[] {
  const items: ProfileLaunch2HoldingItem[] = [];
  for (const holding of holdings) {
    const common = {
      chainId: holding.chainId,
      instanceId: holding.instanceId,
      ticker: holding.ticker,
      name: holding.name,
      logoUrl: holding.logoUrl,
    };
    const meme = holding.memeRaw;
    if (meme !== null && meme > 0n) {
      items.push(
        Object.freeze({
          kind: "launch2_meme" as const,
          ...common,
          amountMeme: formatLaunch2Amount(meme),
          nftCount: null,
          stage: holding.stage,
          valueUsd1:
            holding.priceE18 <= 0n
              ? null
              : formatLaunch2Amount((meme * holding.priceE18) / wad),
        }),
      );
    }
    if (holding.nftHeld > 0) {
      items.push(
        Object.freeze({
          kind: "launch2_nft" as const,
          ...common,
          amountMeme: null,
          nftCount: holding.nftHeld,
          stage: holding.stage,
          valueUsd1: null,
        }),
      );
    }
  }
  return Object.freeze(items);
}
