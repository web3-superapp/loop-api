import type {
  PerpIntentActionKind,
  PerpIntentRequest,
} from "./perp-intent-contract.js";

export type PerpReconciliationCoin = "BTC" | "ETH" | "SOL";
export type PerpReconciliationItemTargetKind = "order_id" | "client_order_id";

export interface PerpReconciliationItemIdentity {
  readonly index: number;
  readonly coin: PerpReconciliationCoin;
  readonly targetKind: PerpReconciliationItemTargetKind | null;
  readonly targetOrderId: string | null;
  readonly targetClientOrderId: string | null;
  readonly generatedClientOrderId: string | null;
}

export interface PerpReconciliationSubject {
  readonly operationId: string;
  readonly ownerUserId: string;
  readonly action: PerpIntentActionKind;
  readonly accountAddress: string;
  readonly accountKind: "master" | "subaccount";
  readonly attemptCommittedAt: string;
  readonly intentRecordVersion: string;
  readonly canonicalAction: PerpIntentRequest;
  readonly items: readonly PerpReconciliationItemIdentity[];
}

export interface LoadClaimedPerpReconciliationSubjectInput {
  readonly ownerUserId: string;
  readonly operationId: string;
  readonly workerId: string;
  readonly fenceToken: string;
  readonly recordVersion: string;
}

export type PerpOrderReconciliationItemState =
  "accepted" | "partial" | "filled" | "cancelled" | "rejected";

export interface PerpOrderReconciliationResolutionItem {
  readonly index: number;
  readonly coin: PerpReconciliationCoin;
  readonly generatedClientOrderId: string;
  readonly state: PerpOrderReconciliationItemState;
  readonly providerOrderId: string;
  readonly clientOrderId: string;
  readonly filledSize: string | null;
  readonly averageFillPrice: string | null;
  readonly reasonCode: string | null;
}

/**
 * A terminal database decision for the currently approved limit-order-only
 * reconciliation slice. Market orders and every non-order action must be
 * parked for an operator instead of being passed to this finalizer.
 */
export interface PerpOrderReconciliationResolution {
  readonly genericState: "accepted" | "succeeded" | "rejected";
  readonly intentState: PerpOrderReconciliationItemState;
  readonly observedAt: string;
  readonly reasonCode: string | null;
  readonly items: readonly PerpOrderReconciliationResolutionItem[];
}

export interface FinalizePerpOrderReconciliationInput extends LoadClaimedPerpReconciliationSubjectInput {
  readonly expectedIntentRecordVersion: string;
  readonly requestId: string;
  readonly resolution: PerpOrderReconciliationResolution;
}

export interface PerpReconciliationRepository {
  loadClaimedSubject(
    input: LoadClaimedPerpReconciliationSubjectInput,
  ): Promise<PerpReconciliationSubject>;
  finalizeOrderResolution(
    input: FinalizePerpOrderReconciliationInput,
  ): Promise<void>;
}
