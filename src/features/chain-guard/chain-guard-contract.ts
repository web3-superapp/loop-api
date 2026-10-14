/**
 * Decision 0134 (S174): the `chain_guard` lane — read-only monitoring of
 * the external contracts the launch chain depends on (docs/24 §7): the
 * USD1 issuer's pause / freeze / seizure / upgrade powers, the Uniswap v4
 * protocol fee on our graduated pools, and the BNB balance of the accounts
 * that sign for us. It never signs or sends.
 *
 * Every observed risk is an incident (`chain_guard_incidents`); an
 * unresolved USD1 pause or freeze of one of our addresses holds the three
 * signing lanes (`CHAIN_GUARD_HOLD`) until the lane sees it cleared.
 */

export const chainGuardLane = "chain_guard" as const;

/** Conditions the lane re-reads every tick; a cleared one is resolved. */
export const chainGuardStateKinds = Object.freeze([
  "usd1_paused",
  "usd1_address_frozen",
  "usd1_implementation_changed",
  "usd1_address_mismatch",
  "usd1_read_unsupported",
  "protocol_fee_controller_changed",
  "pool_protocol_fee_nonzero",
  "pool_protocol_fee_high",
  "account_balance_low",
] as const);

/**
 * One-off log facts. They cannot be "re-read", so they stay open for
 * `chainGuardEventIncidentTtlSeconds` after the last sighting and are then
 * resolved by the lane.
 */
export const chainGuardEventKinds = Object.freeze([
  "usd1_frozen_funds_drained",
  "usd1_frozen_funds_reallocated",
  "usd1_upgraded",
  "usd1_proxy_admin_changed",
  "usd1_proxy_admin_ownership_transferred",
  "usd1_owner_transferred",
] as const);

export type ChainGuardStateKind = (typeof chainGuardStateKinds)[number];
export type ChainGuardEventKind = (typeof chainGuardEventKinds)[number];
export type ChainGuardIncidentKind = ChainGuardStateKind | ChainGuardEventKind;

export const chainGuardIncidentKinds: readonly ChainGuardIncidentKind[] =
  Object.freeze([...chainGuardStateKinds, ...chainGuardEventKinds]);

/** Kinds that hold the keeper / executor / poke lanes while unresolved. */
export const chainGuardHoldKinds: readonly ChainGuardIncidentKind[] =
  Object.freeze(["usd1_paused", "usd1_address_frozen"]);

export const chainGuardEventIncidentTtlSeconds = 24 * 60 * 60;

export const chainGuardDefaults = Object.freeze({
  intervalSeconds: 60,
  /** docs/24 §7.2: the Hook tolerates ≤ 1000 pips; alert well before. */
  protocolFeeAlertPips: 500,
  /** 0.05 BNB. */
  minBnbWei: 50_000_000_000_000_000n,
  /** First run: how far behind the head the log cursor starts. */
  initialLogLookbackBlocks: 2_000n,
  maxLogRange: 2_000n,
  /** Ranges read per tick while catching up (bounded tick length). */
  maxLogRangesPerTick: 5,
});

/** Uniswap v4 `ProtocolFeeLibrary.MAX_PROTOCOL_FEE` (pips, per direction). */
export const uniswapV4MaxProtocolFeePips = 1000;

export const chainGuardReasonCodes = Object.freeze({
  hold: "CHAIN_GUARD_HOLD",
  holdReleased: "CHAIN_GUARD_HOLD_RELEASED",
  resolved: "CHAIN_GUARD_INCIDENT_RESOLVED",
  usd1NotConfigured: "CHAIN_GUARD_USD1_NOT_CONFIGURED",
  chainMismatch: "CHAIN_GUARD_CHAIN_MISMATCH",
  checkNotConfigured: "CHAIN_GUARD_CHECK_NOT_CONFIGURED",
  repositoryUnavailable: "CHAIN_GUARD_REPOSITORY_UNAVAILABLE",
  chainNotConfigured: "CHAIN_GUARD_CHAIN_NOT_CONFIGURED",
});

/** `CHAIN_GUARD_USD1_PAUSED` … — the log reason code of an incident kind. */
export function chainGuardIncidentReasonCode(
  kind: ChainGuardIncidentKind,
): string {
  return `CHAIN_GUARD_${kind.toUpperCase()}`;
}

export function isChainGuardEventKind(
  kind: ChainGuardIncidentKind,
): kind is ChainGuardEventKind {
  return (chainGuardEventKinds as readonly string[]).includes(kind);
}

export type ChainGuardDetails = Readonly<
  Record<string, string | number | boolean | null | readonly string[]>
>;

export interface ChainGuardIncidentRecord {
  readonly incidentId: string;
  readonly chainId: string;
  readonly kind: ChainGuardIncidentKind;
  readonly subject: string;
  readonly details: ChainGuardDetails;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly resolvedAt: string | null;
}

/** The addresses of one registered launch2 instance the lane watches. */
export interface ChainGuardInstanceRecord {
  readonly instanceId: string;
  readonly escrow: string;
  readonly nft: string;
  readonly curve: string;
  readonly graduationAdapter: string;
  readonly buybackAdapter: string;
  readonly buybackExecutor: string;
  /** OfficialTax `Graduated.officialPoolId` or the LoopDynamic pool id. */
  readonly poolId: string | null;
}

export interface ChainGuardRepository {
  listWatchInstances(
    chainId: string,
  ): Promise<readonly ChainGuardInstanceRecord[]>;
  /**
   * Opens the incident, or — when one is unresolved for the same
   * (chain, kind, subject) — moves its `last_seen_at` and replaces details.
   */
  openOrTouch(input: {
    readonly incidentId: string;
    readonly chainId: string;
    readonly kind: ChainGuardIncidentKind;
    readonly subject: string;
    readonly details: ChainGuardDetails;
    readonly now: Date;
  }): Promise<{
    readonly incident: ChainGuardIncidentRecord;
    readonly opened: boolean;
  }>;
  /**
   * Resolves unresolved incidents of `kinds` whose subject is not in
   * `keep` (key `kind|subject`), and event incidents last seen before
   * `eventsSeenBefore`. Returns the rows it resolved.
   */
  resolve(input: {
    readonly chainId: string;
    readonly kinds: readonly ChainGuardIncidentKind[];
    readonly keep: readonly string[];
    readonly eventsSeenBefore: Date;
    readonly now: Date;
  }): Promise<readonly ChainGuardIncidentRecord[]>;
  listUnresolved(input: {
    readonly chainId: string | null;
    readonly limit: number;
  }): Promise<readonly ChainGuardIncidentRecord[]>;
  /** Unresolved incidents of `chainGuardHoldKinds` (read-only). */
  listHolds(chainId: string): Promise<readonly ChainGuardIncidentRecord[]>;
  getCursor(chainId: string): Promise<bigint | null>;
  setCursor(input: {
    readonly chainId: string;
    readonly blockNumber: bigint;
    readonly now: Date;
  }): Promise<void>;
}

export function chainGuardIncidentKey(kind: string, subject: string): string {
  return `${kind}|${subject}`;
}
