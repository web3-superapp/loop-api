import { createHash } from "node:crypto";

import type { Hex } from "viem";

import { canonicalJson } from "../../core/json/canonical-json.js";

/**
 * Unified wallet intent contract (D15/D16, Decision 0035).
 *
 * An intent is immutable evidence of what the user was shown. The canonical
 * payload and the public review are generated from one source object by
 * `sealIntent`, and `reviewSha256` is the SHA-256 of the canonical JSON of the
 * canonical payload. The client re-computes nothing; it compares the digest it
 * displays with the one bound to the payload it hands to the signer.
 */

export const walletIntentKinds = Object.freeze([
  "send",
  "approve",
  "revoke",
  "swap",
] as const);
export type WalletIntentKind = (typeof walletIntentKinds)[number];

export const walletIntentStates = Object.freeze([
  "prepared",
  "awaiting_signature",
  "submitted",
  "confirmed",
  "reverted",
  "failed",
  "unknown",
  "cancelled",
  "expired",
] as const);
export type WalletIntentState = (typeof walletIntentStates)[number];

/** States from which nothing further can happen. */
export const terminalWalletIntentStates: ReadonlySet<WalletIntentState> =
  new Set(["confirmed", "reverted", "failed", "cancelled", "expired"]);

/** States a cancel or a supersede may close. */
export const openWalletIntentStates: ReadonlySet<WalletIntentState> = new Set([
  "prepared",
  "awaiting_signature",
]);

export const simulationStatuses = Object.freeze([
  "passed",
  "reverted",
  "unavailable",
] as const);
export type SimulationStatus = (typeof simulationStatuses)[number];

export const signingModes = Object.freeze([
  "device_eth_send_transaction",
  "privy_authorization_signature",
] as const);
export type SigningMode = (typeof signingModes)[number];

export const walletIntentPayloadVersions = Object.freeze({
  send: "walletIntentSendV1",
  approve: "walletIntentApproveV1",
  revoke: "walletIntentRevokeV1",
  swap: "walletIntentSwapV1",
} as const);

/** Product policy snapshots published with every intent. */
export const bscWriteCanaryPolicyVersion = "bscWriteCanaryV1" as const;
export const swapPolicyVersion = "swapPolicyV1" as const;
export const swapPolicy = Object.freeze({
  configVersion: swapPolicyVersion,
  /** Awaiting product confirmation; carried on every quote and intent. */
  status: "pendingProductConfirmation" as const,
  defaultSlippageBps: 50,
  maximumSlippageBps: 300,
  /** Price impact at or above this fraction is POLICY_BLOCKED. */
  hardBlockPriceImpact: "0.05",
  /** Price impact at or above this fraction requires a second confirmation. */
  confirmPriceImpact: "0.01",
  quoteTtlSeconds: 30,
});

export const sendIntentTtlSeconds = 120;
export const approvalIntentTtlSeconds = 120;
export const swapIntentTtlSeconds = swapPolicy.quoteTtlSeconds;

export const walletIntentIdempotencyScope = "wallet_intent_prepare" as const;
export const walletIntentListLimits = Object.freeze({
  default: 25,
  maximum: 50,
} as const);

export const walletIntentReasonCodes = Object.freeze({
  writesDisabled: "BSC_WRITES_DISABLED",
  chainUnverified: "BSC_CHAIN_VERIFICATION_PENDING",
  runtimeUnavailable: "WALLET_INTENT_RUNTIME_UNAVAILABLE",
  privyNotConfigured: "PRIVY_NOT_CONFIGURED",
  privySwapEvidencePending: "PRIVY_BSC_SWAP_DEVICE_EVIDENCE_PENDING",
  canaryAssetNotAllowed: "CANARY_ASSET_NOT_ALLOWED",
  canaryMaxUsdExceeded: "CANARY_MAX_USD_EXCEEDED",
  canaryValueUnpriceable: "CANARY_VALUE_UNPRICEABLE",
  unlimitedApprovalBlocked: "UNLIMITED_APPROVAL_CANARY_BLOCKED",
  walletNotSignable: "WALLET_NOT_EMBEDDED",
  simulationReverted: "BSC_CALL_REVERTED",
  simulationUnavailable: "SIMULATION_UNAVAILABLE",
  gasEstimateUnavailable: "GAS_ESTIMATE_UNAVAILABLE",
  insufficientBalance: "INSUFFICIENT_BALANCE",
  insufficientGasReserve: "INSUFFICIENT_GAS_RESERVE",
  superseded: "INTENT_SUPERSEDED",
  expired: "INTENT_EXPIRED",
  cancelled: "USER_CANCELLED",
  policyVersionChanged: "POLICY_VERSION_CHANGED",
  txPayloadMismatch: "TX_PAYLOAD_MISMATCH",
  txPendingVerification: "TX_PENDING_VERIFICATION",
  txNotObserved: "TX_NOT_OBSERVED",
  txReverted: "TX_REVERTED",
  privyRejected: "PRIVY_SWAP_REJECTED",
  privyFailed: "PRIVY_SWAP_FAILED",
  providerAmbiguous: "PROVIDER_RESULT_AMBIGUOUS",
  reconciliationBudgetExhausted: "RECONCILIATION_BUDGET_EXHAUSTED",
  screeningNotConfigured: "GOPLUS_ADDRESS_SCREENING_NOT_CONFIGURED",
  contractRecipient: "RECIPIENT_IS_CONTRACT",
  priceImpactUnavailable: "PRICE_IMPACT_UNAVAILABLE",
  priceImpactBlocked: "PRICE_IMPACT_ABOVE_HARD_LIMIT",
  priceImpactConfirm: "PRICE_IMPACT_CONFIRMATION_REQUIRED",
  quoteExpired: "SWAP_QUOTE_EXPIRED",
  quoteNotFound: "SWAP_QUOTE_NOT_FOUND",
  swapSameAsset: "SWAP_SAME_ASSET",
} as const);

export interface IntentAssetSnapshot {
  readonly assetId: string;
  readonly address: string | null;
  readonly symbol: string;
  readonly decimals: number;
}

export interface IntentAmount {
  readonly raw: string;
  readonly display: string;
}

export const simulationSources = Object.freeze([
  "rpc_call",
  "provider_quote",
] as const);
export type SimulationSource = (typeof simulationSources)[number];

export interface SimulationFact {
  readonly status: SimulationStatus;
  /**
   * `rpc_call`: eth_call + estimateGas over the exact payload. `provider_quote`:
   * the Provider quoted the route (Swap); no exact payload exists to
   * pre-execute because the Provider builds it at execute time.
   */
  readonly source: SimulationSource;
  readonly observedAt: string;
  readonly reasonCode: string | null;
}

export interface CanaryPolicyFact {
  readonly configVersion: typeof bscWriteCanaryPolicyVersion;
  readonly canaryMaxUsd: string;
  /** Null only for a revoke (zero value). */
  readonly valueUsd: string | null;
  readonly priceSource: string | null;
  readonly priceFetchedAt: string | null;
}

/**
 * Raw JSON-RPC transaction object the device hands to Privy
 * `eth_sendTransaction` verbatim. Every quantity is a 0x hex string.
 */
export interface UnsignedTransaction {
  readonly chainId: 56;
  readonly from: string;
  readonly to: string;
  readonly data: Hex;
  readonly value: Hex;
  readonly gas: Hex;
  readonly nonce: Hex;
  readonly type: "eip1559" | "legacy";
  readonly maxFeePerGas: Hex | null;
  readonly maxPriorityFeePerGas: Hex | null;
  readonly gasPrice: Hex | null;
}

export interface IntentFeeFact {
  readonly gasLimit: string;
  readonly type: "eip1559" | "legacy";
  readonly maxFeePerGas: string | null;
  readonly maxPriorityFeePerGas: string | null;
  readonly gasPrice: string | null;
  /** gasLimit × (maxFeePerGas | gasPrice) in wei. */
  readonly maximumFeeRaw: string;
  readonly maximumFee: string;
  readonly observedAt: string;
}

export interface IntentBalanceFact {
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly observedAt: string;
  readonly rawBalance: string;
  readonly displayBalance: string;
  readonly rawNativeBalance: string;
  readonly gasReserveRaw: string;
}

export interface RecipientReview {
  readonly address: string;
  readonly checksumAddress: string;
  readonly isContract: boolean;
  readonly isFirstRecipient: boolean;
  readonly screening: {
    readonly status: "unavailable";
    readonly reasonCode: string;
  };
}

export interface SpenderReview {
  readonly address: string;
  readonly checksumAddress: string;
  readonly isContract: boolean;
  readonly isUnlimited: boolean;
}

export interface DecodedCallReview {
  readonly functionName: "transfer" | "approve";
  readonly selector: string;
  readonly args: Readonly<Record<string, string>>;
}

export interface SwapQuoteSnapshot {
  readonly quoteId: string;
  readonly provider: "privy";
  readonly amountType: "exact_input";
  readonly inputAmount: IntentAmount;
  readonly estimatedOutputAmount: IntentAmount;
  readonly minimumOutputAmount: IntentAmount;
  readonly slippageBps: number;
  readonly gasEstimateRaw: string;
  readonly quotedAt: string;
  readonly expiresAt: string;
  readonly priceImpact: PriceImpactFact;
  readonly platformFeeBps: number | null;
}

export interface PriceImpactFact {
  readonly status: "available" | "unavailable";
  /** Fraction as a decimal string (0.0123 = 1.23%); null when unavailable. */
  readonly value: string | null;
  readonly decision: "allowed" | "confirm" | "blocked";
  readonly reasonCode: string | null;
  readonly marketValueUsd: string | null;
  readonly estimatedOutputValueUsd: string | null;
  readonly priceSource: string | null;
}

/**
 * The exact Privy Wallet API request the user authorizes (Decision 0035).
 * The Flutter client signs this object with `generateAuthorizationSignature`
 * and the backend forwards the signature as `privy-authorization-signature`
 * without modifying any field. Whether this is byte-for-byte what Privy
 * expects is the pending device evidence (`PRIVY_BSC_SWAP_DEVICE_EVIDENCE_PENDING`).
 */
export interface SwapAuthorizationPayload {
  readonly version: 1;
  readonly method: "POST";
  readonly url: string;
  readonly body: {
    readonly base_amount: string;
    readonly source: { readonly asset_address: string; readonly caip2: string };
    readonly destination: {
      readonly asset_address: string;
      readonly caip2: string;
    };
    readonly amount_type: "exact_input";
    readonly slippage_bps: number;
    readonly fee_configuration?: {
      readonly type: "total_fee_bps";
      readonly value: number;
    };
  };
  readonly headers: {
    readonly "privy-app-id": string;
    readonly "privy-idempotency-key": string;
    readonly "privy-request-expiry": string;
  };
}

/** The one source object from which the payload and the review derive. */
export interface IntentSource {
  readonly version: string;
  readonly intentId: string;
  readonly kind: WalletIntentKind;
  readonly chainId: "eip155:56";
  readonly walletId: string;
  readonly from: string;
  readonly asset: IntentAssetSnapshot;
  readonly amount: IntentAmount;
  readonly recipient: RecipientReview | null;
  readonly spender: SpenderReview | null;
  readonly decodedCall: DecodedCallReview | null;
  readonly transaction: UnsignedTransaction | null;
  readonly fee: IntentFeeFact | null;
  readonly balance: IntentBalanceFact;
  readonly simulation: SimulationFact;
  readonly policy: CanaryPolicyFact;
  readonly swap: {
    readonly destinationAsset: IntentAssetSnapshot;
    readonly quote: SwapQuoteSnapshot;
    readonly policy: typeof swapPolicy;
    readonly authorizationPayload: SwapAuthorizationPayload;
    readonly providerWalletRef: string;
  } | null;
  readonly signingMode: SigningMode;
  readonly factsObservedAt: string;
  readonly expiresAt: string;
}

export interface SealedIntent {
  readonly canonicalPayload: IntentSource;
  readonly publicReview: IntentPublicReview;
  readonly reviewSha256: string;
}

/**
 * The review is the canonical payload minus nothing the user must see and
 * plus nothing the payload does not contain. It is a projection, never a
 * second source: a field shown here is always the one that is signed.
 */
export interface IntentPublicReview {
  readonly kind: WalletIntentKind;
  readonly asset: IntentAssetSnapshot;
  readonly amount: IntentAmount;
  readonly recipient: RecipientReview | null;
  readonly spender: SpenderReview | null;
  readonly decodedCall: DecodedCallReview | null;
  readonly fee: IntentFeeFact | null;
  readonly balance: IntentBalanceFact;
  readonly swap: {
    readonly destinationAsset: IntentAssetSnapshot;
    readonly quote: SwapQuoteSnapshot;
    readonly policy: typeof swapPolicy;
  } | null;
}

export function digestCanonicalPayload(payload: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

export function sealIntent(source: IntentSource): SealedIntent {
  const canonicalPayload: IntentSource = Object.freeze(
    JSON.parse(canonicalJson(source)) as IntentSource,
  );
  const publicReview: IntentPublicReview = Object.freeze({
    kind: canonicalPayload.kind,
    asset: canonicalPayload.asset,
    amount: canonicalPayload.amount,
    recipient: canonicalPayload.recipient,
    spender: canonicalPayload.spender,
    decodedCall: canonicalPayload.decodedCall,
    fee: canonicalPayload.fee,
    balance: canonicalPayload.balance,
    swap:
      canonicalPayload.swap === null
        ? null
        : Object.freeze({
            destinationAsset: canonicalPayload.swap.destinationAsset,
            quote: canonicalPayload.swap.quote,
            policy: canonicalPayload.swap.policy,
          }),
  });
  return Object.freeze({
    canonicalPayload,
    publicReview,
    reviewSha256: digestCanonicalPayload(canonicalPayload),
  });
}

/** Canonical SHA-256 over the prepare request so an idempotent replay binds to the same input. */
export function intentRequestDigest(
  kind: WalletIntentKind,
  parts: readonly string[],
): string {
  return createHash("sha256")
    .update(`loop.wallet-intent.${kind}.v1\0${parts.join("\0")}`, "utf8")
    .digest("hex");
}

export function isWalletIntentKind(value: unknown): value is WalletIntentKind {
  return (
    typeof value === "string" &&
    (walletIntentKinds as readonly string[]).includes(value)
  );
}
