import type { PerpIntentRequest } from "../../features/perp/perp-intent-contract.js";
import type { WalletAccountKind } from "../../features/wallet/wallet-binding-resolver.js";

export interface PerpIntentReviewItem {
  readonly index: number;
  readonly coin: "BTC" | "ETH" | "SOL";
  readonly targetKind: "order_id" | "client_order_id" | null;
  readonly targetOrderId: string | null;
  readonly targetClientOrderId: string | null;
  readonly generatedClientOrderId: string | null;
}

export interface ReviewPerpIntentInput {
  readonly ownerUserId: string;
  readonly accountAddress: string;
  readonly accountKind: WalletAccountKind;
  readonly bindingVersion: string;
  readonly network: "testnet";
  readonly market: "core_perps";
  readonly dex: "";
  readonly request: PerpIntentRequest;
  readonly items: readonly PerpIntentReviewItem[];
  readonly signal: AbortSignal;
}

/**
 * Reviewer output is deliberately `unknown`: the service must parse the exact
 * public review contract before persisting or returning it.
 */
export interface HyperliquidPerpIntentReviewer {
  review(input: ReviewPerpIntentInput): Promise<unknown>;
}

export class HyperliquidPerpIntentReviewerUnavailableError extends Error {
  readonly code = "hyperliquid_perp_intent_reviewer_unavailable";

  constructor() {
    super("Hyperliquid Perp intent review is unavailable");
    this.name = "HyperliquidPerpIntentReviewerUnavailableError";
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new HyperliquidPerpIntentReviewerUnavailableError());
}

export function createUnavailableHyperliquidPerpIntentReviewer(): HyperliquidPerpIntentReviewer {
  return Object.freeze({ review: unavailable });
}
