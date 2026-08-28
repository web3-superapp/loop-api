import type {
  BeginSpotIntentSubmissionInput,
  SpotCanonicalAction,
  SpotIntentRepository,
  SpotIntentSubmissionRecoveryRepository,
} from "../../database/spot-intent-repository.js";

export type SpotIntentSubmissionRepository = Pick<
  SpotIntentRepository,
  "findOwned" | "beginSubmission"
> &
  Pick<SpotIntentSubmissionRecoveryRepository, "recordSubmissionUnknown">;

export interface SpotIntentSubmissionEvidence {
  readonly walletEvidence: BeginSpotIntentSubmissionInput["walletEvidence"];
  readonly marketEvidence: BeginSpotIntentSubmissionInput["marketEvidence"];
  readonly accountEvidence: BeginSpotIntentSubmissionInput["accountEvidence"];
  readonly policyEvidence: BeginSpotIntentSubmissionInput["policyEvidence"];
}

/**
 * Immutable server-sensitive facts derived from the persisted intent. They
 * contain owner/account identifiers, so adapters must not log or expose this
 * subject even though it contains no signing key. The route cannot construct
 * or override it.
 */
export interface SpotIntentSubmissionSubject {
  readonly ownerUserId: string;
  readonly intentId: string;
  readonly network: "testnet";
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
  readonly metadataVersion: string;
  readonly metadataSha256: string;
  readonly policyVersion: string;
  readonly accountAddress: string;
  readonly bindingVersion: string;
  readonly agentIdentityId: string;
  readonly reviewSha256: string;
  readonly side: "buy" | "sell";
  readonly computedBaseSize: string;
  readonly maximumSpendOrMinimumReceive: Readonly<{
    readonly kind: "maximum_spend" | "minimum_receive";
    readonly value: string;
  }>;
  readonly feeRate: string;
  readonly expiresAt: string;
}

/**
 * Produces a short-lived aggregate mutation decision. A real implementation
 * remains absent until product/legal, signer, and reconciliation gates exist.
 */
export interface SpotIntentSubmissionPolicyGate {
  evaluate(input: {
    readonly subject: SpotIntentSubmissionSubject;
    readonly requestId: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

/**
 * Resolves fresh server-side authority before the durable transport attempt is
 * opened. Implementations must be read-only and must never sign or send here.
 */
export interface SpotIntentSubmissionPreflight {
  prepare(input: {
    readonly ownerUserId: string;
    readonly privyUserId: string;
    readonly intentId: string;
    readonly marketId: string;
    readonly network: "testnet";
    readonly action: "spot_ioc_order";
    readonly expectedReviewSha256: string;
    readonly subject: SpotIntentSubmissionSubject;
    readonly requestId: string;
    readonly signal: AbortSignal;
  }): Promise<SpotIntentSubmissionEvidence>;
}

export interface SpotIocSignature {
  readonly r: string;
  readonly s: string;
  readonly v: 27 | 28;
}

/**
 * Signs only the exact Testnet IOC action returned by the durable submission
 * journal. It cannot choose an action, network, nonce, or signer identity.
 */
export interface SpotIocSigner {
  sign(input: {
    readonly signingRequestId: string;
    readonly network: "testnet";
    readonly signerRef: string;
    readonly expectedSignerAddress: string;
    readonly action: SpotCanonicalAction;
    readonly nonce: string;
    readonly vaultAddress: null;
    readonly expiresAfter: string;
    /** Persisted DB deadline; implementations must refuse late signing. */
    readonly attemptDeadlineAt: string;
    readonly signal: AbortSignal;
  }): Promise<SpotIocSignature>;
}

/**
 * Sends one already-signed Testnet IOC attempt. Resolve means that the adapter
 * discarded an unclassified response; reject means transport ambiguity. The
 * coordinator never retries either outcome. Production adapters remain
 * uncomposed and the main runtime injects an unavailable service.
 */
export interface SpotIocExchangeWriter {
  submit(input: {
    readonly transportAttemptId: string;
    readonly network: "testnet";
    readonly action: SpotCanonicalAction;
    readonly nonce: string;
    readonly signature: SpotIocSignature;
    readonly vaultAddress: null;
    readonly expiresAfter: string;
    /** Persisted DB deadline; implementations must refuse a late send. */
    readonly attemptDeadlineAt: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
}
