import type { ReconciliationControlPlane } from "../reconciliation/reconciliation-service.js";

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

/**
 * Spot uses the shared reconciliation scheduler through a dedicated database
 * implementation. Generic completion is intentionally unavailable; a later
 * domain finalizer must resolve the shared operation and Spot projection in
 * one fenced transaction.
 */
export interface SpotReconciliationRepository extends ReconciliationControlPlane {
  loadClaimedSpotIntentSubject(
    input: LoadClaimedSpotIntentSubjectInput,
  ): Promise<SpotIntentReconciliationSubject>;
}
