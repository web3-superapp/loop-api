import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import type {
  PrepareTransferReviewRequest,
  RecipientPreflightRequest,
  TransferAuthorizationRequest,
} from "./transfer-contract.js";

export interface TransferRequestContext {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface RecipientPreflightInput extends TransferRequestContext {
  readonly body: RecipientPreflightRequest;
}

export interface PrepareTransferReviewInput extends TransferRequestContext {
  readonly body: PrepareTransferReviewRequest;
}

export interface TransferAuthorizationInput extends TransferRequestContext {
  readonly body: TransferAuthorizationRequest;
}

export interface TransferService {
  listAssets(input: TransferRequestContext): Promise<never>;
  recipientPreflight(input: RecipientPreflightInput): Promise<never>;
  prepareReview(input: PrepareTransferReviewInput): Promise<never>;
  authorize(input: TransferAuthorizationInput): Promise<never>;
  readCurrentResult(input: TransferRequestContext): Promise<never>;
  readReconciliation(input: TransferRequestContext): Promise<never>;
}

export class TransferUnavailableError extends Error {
  constructor() {
    super("Privy same-chain transfer is unavailable");
    this.name = "TransferUnavailableError";
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new TransferUnavailableError());
}

export function createUnavailableTransferService(): TransferService {
  return Object.freeze({
    listAssets: unavailable,
    recipientPreflight: unavailable,
    prepareReview: unavailable,
    authorize: unavailable,
    readCurrentResult: unavailable,
    readReconciliation: unavailable,
  });
}
