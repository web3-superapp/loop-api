import type { ReconciliationControlPlane } from "../reconciliation/reconciliation-service.js";

export const spotNotFilledReconciliationReasonCodes = Object.freeze([
  "hyperliquid_ioc_cancel_rejected",
] as const);

export const spotRejectedReconciliationReasonCodes = Object.freeze([
  "hyperliquid_insufficient_spot_balance_rejected",
  "hyperliquid_min_trade_ntl_rejected",
  "hyperliquid_oracle_rejected",
  "hyperliquid_tick_rejected",
  "hyperliquid_rejected",
] as const);

export type SpotNotFilledReconciliationReasonCode =
  (typeof spotNotFilledReconciliationReasonCodes)[number];
export type SpotRejectedReconciliationReasonCode =
  (typeof spotRejectedReconciliationReasonCodes)[number];

export interface SpotReconciliationCanonicalAction {
  readonly type: "order";
  readonly orders: readonly [
    Readonly<{
      readonly a: number;
      readonly b: boolean;
      readonly p: string;
      readonly s: string;
      readonly r: false;
      readonly t: Readonly<{
        readonly limit: Readonly<{ readonly tif: "Ioc" }>;
      }>;
      readonly c: string;
    }>,
  ];
  readonly grouping: "na";
}

export interface LoadClaimedSpotIntentSubjectInput {
  readonly ownerUserId: string;
  readonly operationId: string;
  readonly workerId: string;
  readonly fenceToken: string;
  readonly recordVersion: string;
}

/**
 * Immutable, sanitized facts needed for an authoritative Hyperliquid Spot
 * read. Signer references, signatures, nonces, and raw provider payloads are
 * deliberately absent from this boundary.
 */
export interface SpotIntentReconciliationSubject {
  readonly operationId: string;
  readonly ownerUserId: string;
  readonly network: "testnet";
  readonly transportAttemptId: string;
  readonly attemptCommittedAt: string;
  readonly intentRecordVersion: string;
  readonly marketId: string;
  readonly providerCoin: string;
  readonly baseTokenIndex: number;
  readonly baseTokenId: string;
  readonly baseDisplayIdentity: string;
  readonly quoteTokenIndex: number;
  readonly quoteTokenId: string;
  readonly quoteDisplayIdentity: string;
  readonly spotPairIndex: number;
  readonly exchangeOrderAsset: number;
  readonly side: "buy" | "sell";
  readonly amountMode: "quote" | "base";
  readonly amountValue: string;
  readonly computedBaseSize: string;
  readonly worstIocLimitPrice: string;
  readonly accountAddress: string;
  readonly accountKind: "master";
  readonly clientOrderId: string;
  readonly canonicalAction: SpotReconciliationCanonicalAction;
}

export interface SpotReconciliationFee {
  readonly amount: string;
  readonly tokenIndex: number;
  readonly tokenId: string;
  readonly assetDisplayIdentity: string;
}

export type SpotIntentTerminalResolution =
  | Readonly<{
      state: "filled";
      providerOrderId: string;
      clientOrderId: string;
      filledBaseSize: string;
      quoteAmount: string;
      averageFillPrice: string;
      fee: SpotReconciliationFee;
      observedAt: string;
      reasonCode: null;
    }>
  | Readonly<{
      state: "not_filled";
      providerOrderId: string;
      clientOrderId: string;
      filledBaseSize: null;
      quoteAmount: null;
      averageFillPrice: null;
      fee: null;
      observedAt: string;
      reasonCode: SpotNotFilledReconciliationReasonCode;
    }>
  | Readonly<{
      state: "rejected";
      providerOrderId: string;
      clientOrderId: string;
      filledBaseSize: null;
      quoteAmount: null;
      averageFillPrice: null;
      fee: null;
      observedAt: string;
      reasonCode: SpotRejectedReconciliationReasonCode;
    }>;

export interface FinalizeSpotIntentResolutionInput extends LoadClaimedSpotIntentSubjectInput {
  readonly expectedIntentRecordVersion: string;
  readonly requestId: string;
  /**
   * Only strictly proven terminal outcomes are accepted. Partial fills,
   * accepted/open orders, unknown OIDs, and truncated evidence must be parked
   * or retried before this boundary. A negative fee/maker rebate must enter
   * operator_required and must never be coerced, dropped, or retried here.
   */
  readonly resolution: SpotIntentTerminalResolution;
}

/**
 * Spot uses the shared reconciliation scheduler through a dedicated database
 * implementation. Generic completion is intentionally unavailable; this
 * domain finalizer resolves the shared operation and Spot projection in one
 * fenced transaction.
 */
export interface SpotReconciliationRepository extends ReconciliationControlPlane {
  loadClaimedSpotIntentSubject(
    input: LoadClaimedSpotIntentSubjectInput,
  ): Promise<SpotIntentReconciliationSubject>;
  finalizeSpotIntentResolution(
    input: FinalizeSpotIntentResolutionInput,
  ): Promise<void>;
}
