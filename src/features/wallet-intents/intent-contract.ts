import { createHash } from "node:crypto";

import type { Hex } from "viem";

import { canonicalJson } from "../../core/json/canonical-json.js";
import {
  bscChainReference,
  bscTestnetChainReference,
  type LaunchChainId,
  type LaunchChainReference,
} from "../chain/chain-contract.js";

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
  // Decision 0194 (S339): a LOOP Launch project NFT (ERC-721)
  // `safeTransferFrom` on the launch slot. Created only through
  // POST /v2/wallet-intents/send-nft (NFT_SEND_ENABLED) and hidden from
  // the intent list unless the client opts in.
  "send_nft",
  // Decision 0197 (S342, LOOP decision 0270): a transaction / a message
  // signature an in-app DApp page requested. Created only through
  // POST /v2/wallet-intents/dapp-tx and /dapp-sign (DAPP_BROWSER_ENABLED)
  // and hidden from the intent list unless the client opts in.
  "dapp_tx",
  "dapp_sign",
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

/**
 * Intent families that bind a chain (Decision 0038). `launch` is reserved for
 * the Launch intent the 02 contract document will define; it is not a
 * `WalletIntentKind` and has no prepare path in this step.
 */
export type ChainBoundIntentKind = WalletIntentKind | "launch";

/**
 * The Launch settlement pair an allowance intent may target on the launch
 * slot's testnet (Decision 0077): only USD1 (`LAUNCH_USD1_ADDRESS`) towards
 * the Launch contract (`LAUNCH_CONTRACT_ADDRESS`).
 */
export interface LaunchSlotAllowanceTarget {
  /** The token the allowance is set on (lowercase). */
  readonly token: string;
  /** The spender (lowercase). */
  readonly spender: string;
  readonly launchContractAddress: string;
  readonly launchUsd1Address: string;
}

/**
 * The single chain rule for signable payloads: every intent may bind the
 * primary chain (56); only a Launch intent may bind the launch slot's testnet
 * (97) — plus, since Decision 0077, an approve/revoke whose token is the
 * configured USD1 and whose spender is the configured Launch contract, so a
 * buyer can grant (and withdraw) exactly the allowance `buy` needs — and,
 * since Decision 0194, a `send_nft` of a Launch project NFT. Send, swap,
 * and every other approval never leave mainnet.
 */
export function isIntentChainAllowed(
  kind: ChainBoundIntentKind,
  chainReference: number,
  launchAllowance: LaunchSlotAllowanceTarget | null = null,
): chainReference is LaunchChainReference {
  if (chainReference === bscChainReference) {
    return true;
  }
  if (chainReference !== bscTestnetChainReference) {
    return false;
  }
  // Decision 0194: a project NFT lives on the launch slot, so its send is
  // built there (the service checks the slot is open first).
  if (kind === "launch" || kind === "send_nft") {
    return true;
  }
  // Decision 0197: a DApp transaction is only ever built on the launch
  // slot's testnet; the service refuses chain 56 before reaching here
  // (BSC Mainnet signing stays closed, docs/00 rule 8).
  if (kind === "dapp_tx") {
    return true;
  }
  return (
    (kind === "approve" || kind === "revoke") &&
    launchAllowance !== null &&
    launchAllowance.token.toLowerCase() ===
      launchAllowance.launchUsd1Address.toLowerCase() &&
    launchAllowance.spender.toLowerCase() ===
      launchAllowance.launchContractAddress.toLowerCase()
  );
}

/**
 * Decision 0194: kinds the intent list omits unless the client names them in
 * `includeKinds` — a client released before the kind existed decodes the
 * list strictly and would reject the whole page.
 */
export const walletIntentOptInKinds = Object.freeze([
  "send_nft",
  // Decision 0197: the DApp browser kinds follow the same opt-in rule.
  "dapp_tx",
  "dapp_sign",
] as const);
export type WalletIntentOptInKind = (typeof walletIntentOptInKinds)[number];

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
  // Decision 0197: a `dapp_sign` intent — the device hands
  // `signatureRequest` to Privy `personal_sign` / `eth_signTypedData_v4`.
  "device_personal_sign",
  "device_sign_typed_data_v4",
] as const);
export type SigningMode = (typeof signingModes)[number];

export const walletIntentPayloadVersions = Object.freeze({
  send: "walletIntentSendV1",
  approve: "walletIntentApproveV1",
  revoke: "walletIntentRevokeV1",
  swap: "walletIntentSwapV1",
  send_nft: "walletIntentSendNftV1",
  dapp_tx: "walletIntentDappTxV1",
  dapp_sign: "walletIntentDappSignV1",
} as const);

/** Product policy snapshots published with every intent. */
export const bscWriteCanaryPolicyVersion = "bscWriteCanaryV1" as const;

/**
 * `detailsSafe.reasonCode` values that distinguish the policy refusals
 * (`403 POLICY_BLOCKED`) and the native-asset approval refusal
 * (`422 VALIDATION_FAILED`) so the sign sheet can say which rule fired
 * (S6 finding 1/2). Ceiling refusals also carry `exposureUsd` and
 * `ceilingUsd` as decimal strings.
 */
export const walletIntentRefusalReasonCodes = Object.freeze({
  assetBlocked: "ASSET_BLOCKED",
  assetNotInCanaryAllowlist: "ASSET_NOT_IN_CANARY_ALLOWLIST",
  canaryCeilingExceeded: "CANARY_CEILING_EXCEEDED",
  canaryDailyCeilingExceeded: "CANARY_DAILY_CEILING_EXCEEDED",
  counterpartyNotInCanaryAllowlist: "COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST",
  unlimitedExposureExceedsCeiling: "UNLIMITED_EXPOSURE_EXCEEDS_CEILING",
  nativeAssetNotApprovable: "NATIVE_ASSET_NOT_APPROVABLE",
  priceImpactBlocked: "PRICE_IMPACT_BLOCKED",
} as const);
/**
 * The in-transaction half of the Decision 0065 daily ceiling (Decision
 * 0104 M2): a repository that writes an Intent locks the owner row,
 * recomputes the account's spent total over `[since, now]` across wallet,
 * Launch, and MEME Intents, and calls `admit`, which throws the
 * `CANARY_DAILY_CEILING_EXCEEDED` refusal when the new Intent no longer fits.
 */
export interface CanaryExposureAdmission {
  /** Inclusive start of the rolling 24 h window (ISO 8601). */
  readonly since: string;
  readonly admit: (spentUsd: string) => void;
}

export type WalletIntentRefusalReasonCode =
  (typeof walletIntentRefusalReasonCodes)[keyof typeof walletIntentRefusalReasonCodes];
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
  simulationReverted: "BSC_CALL_REVERTED",
  simulationUnavailable: "SIMULATION_UNAVAILABLE",
  gasEstimateUnavailable: "GAS_ESTIMATE_UNAVAILABLE",
  swapSimulationPending: "SWAP_SIMULATION_PROVIDER_PENDING",
  walletNotSignable: "WALLET_NOT_EMBEDDED",
  superseded: "INTENT_SUPERSEDED",
  expired: "INTENT_EXPIRED",
  cancelled: "USER_CANCELLED",
  txPayloadMismatch: "TX_PAYLOAD_MISMATCH",
  txPendingVerification: "TX_PENDING_VERIFICATION",
  txNotObserved: "TX_NOT_OBSERVED",
  txReverted: "TX_REVERTED",
  rpcReceiptUnavailable: "RPC_RECEIPT_UNAVAILABLE",
  reconciliationReadFailed: "RECONCILIATION_READ_FAILED",
  privyRejected: "PRIVY_SWAP_REJECTED",
  privyFailed: "PRIVY_SWAP_FAILED",
  privyNotSent: "PRIVY_SWAP_NOT_SENT",
  providerAmbiguous: "PROVIDER_RESULT_AMBIGUOUS",
  screeningNotConfigured: "GOPLUS_ADDRESS_SCREENING_NOT_CONFIGURED",
  priceImpactUnavailable: "PRICE_IMPACT_UNAVAILABLE",
  priceImpactBlocked: "PRICE_IMPACT_ABOVE_HARD_LIMIT",
  priceImpactConfirm: "PRICE_IMPACT_CONFIRMATION_REQUIRED",
} as const);

/**
 * Decision 0194 (S339, LOOP decision 0267): `detailsSafe.reasonCode` of the
 * project NFT send refusals. `422 VALIDATION_FAILED` carries the first four;
 * `503 CAPABILITY_UNAVAILABLE` carries the last two.
 */
export const nftSendReasonCodes = Object.freeze({
  notOwned: "NFT_NOT_OWNED",
  contractUnsupported: "NFT_CONTRACT_UNSUPPORTED",
  recipientRejects: "NFT_RECIPIENT_REJECTS",
  recipientSelf: "RECIPIENT_SELF",
  disabled: "NFT_SEND_DISABLED",
  chainUnavailable: "NFT_SEND_CHAIN_UNAVAILABLE",
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
  // Decision 0197: a `dapp_sign` message has nothing to pre-execute.
  "not_applicable",
] as const);
export type SimulationSource = (typeof simulationSources)[number];

export interface SimulationFact {
  readonly status: SimulationStatus;
  /**
   * `rpc_call`: eth_call + estimateGas over the exact payload. `provider_quote`:
   * the Provider quoted the route (Swap); no exact payload exists to
   * pre-execute because the Provider builds it at execute time.
   * `not_applicable` (Decision 0197): a `dapp_sign` message signature.
   */
  readonly source: SimulationSource;
  readonly observedAt: string;
  readonly reasonCode: string | null;
}

export const exposureBases = Object.freeze([
  "amount",
  "balance_at_prepare",
  "none",
] as const);
export type ExposureBasis = (typeof exposureBases)[number];

export interface CanaryPolicyFact {
  readonly configVersion: typeof bscWriteCanaryPolicyVersion;
  readonly canaryMaxUsd: string;
  /**
   * What was priced against the ceiling: the amount itself (send, swap), the
   * actual exposure `min(allowance, balance)` at the snapshot block (approve),
   * or nothing (revoke).
   */
  readonly exposureBasis: ExposureBasis;
  readonly exposureRaw: string | null;
  readonly exposureBlockNumber: string | null;
  /** Null only for a revoke (zero value). */
  readonly valueUsd: string | null;
  readonly priceSource: string | null;
  readonly priceFetchedAt: string | null;
}

/**
 * Raw JSON-RPC transaction object the device hands to Privy
 * `eth_sendTransaction` verbatim. Every quantity is a 0x hex string. The
 * chain is the slot the intent was built for (`isIntentChainAllowed`); the
 * wallet-intent routes only ever produce 56.
 */
export interface UnsignedTransaction {
  readonly chainId: LaunchChainReference;
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

export const firstRecipientBasis = "indexed_erc20_transfers" as const;

export interface RecipientReview {
  readonly address: string;
  readonly checksumAddress: string;
  readonly isContract: boolean;
  /** Derived only from indexed ERC-20 transfers out of the wallet. */
  readonly isFirstRecipient: boolean;
  readonly basis: typeof firstRecipientBasis;
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
  /**
   * `safeTransferFrom` (Decision 0194) is the ERC-721
   * `safeTransferFrom(address from, address to, uint256 tokenId)`; its args
   * are `from`, `to` and `tokenId` (decimal).
   */
  readonly functionName: "transfer" | "approve" | "safeTransferFrom";
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

/**
 * Decision 0194: what a `send_nft` moves — the project NFT contract, the
 * token, and the launch2 project name. Present on `send_nft` payloads and
 * reviews only; every other kind omits the key (old clients decode reviews
 * with a closed key set).
 */
export interface IntentNftReview {
  readonly contractAddress: string;
  /** Decimal uint256. */
  readonly tokenId: string;
  readonly projectName: string;
}

/**
 * Decision 0197 (S342): the risk facts the DApp sign sheet shows. Each one
 * appears only when its condition holds; an empty list is "nothing to warn".
 */
export const dappRiskFlags = Object.freeze([
  "UNLIMITED_APPROVAL",
  "APPROVAL_FOR_ALL",
  // S346 (Decision 0197 amendment): an ERC-20 / ERC-721 approve,
  // increaseAllowance or setApprovalForAll whose spender / operator has no
  // code (an externally owned account).
  "EOA_SPENDER",
  "PERMIT_SIGNATURE",
  // S346: a personal_sign message that is exactly 32 bytes of hex — the
  // shape of a hash, which the user cannot read.
  "RAW_HASH_SIGNATURE",
  // S346: typed data whose primaryType is not one the review recognises.
  "UNRECOGNIZED_TYPED_DATA",
  "UNVERIFIED_CONTRACT",
  "SIMULATION_FAILED",
] as const);
export type DappRiskFlag = (typeof dappRiskFlags)[number];

export const dappRequestMethods = Object.freeze([
  "eth_sendTransaction",
  "personal_sign",
  "eth_signTypedData_v4",
] as const);
export type DappRequestMethod = (typeof dappRequestMethods)[number];

/** Decision 0197: what a LOOP-known contract is. */
export const dappKnownContractKinds = Object.freeze([
  "loopRouter",
  "launch2PoolRouter",
  "loopRouterRegistry",
  "launch2Factory",
  "launch2Instance",
  "launchContract",
  "usd1",
  "registryAsset",
] as const);
export type DappKnownContractKind = (typeof dappKnownContractKinds)[number];

export interface DappKnownContract {
  readonly kind: DappKnownContractKind;
  /** launch2Instance: the contract's role (meme, nft, curve, ...); else null. */
  readonly role: string | null;
  /** Project name / asset symbol when the directory has one. */
  readonly label: string | null;
}

export interface DappAddressReview {
  readonly address: string;
  readonly checksumAddress: string;
  readonly isContract: boolean;
  /** True only for a contract the LOOP directory knows (`knownContract`). */
  readonly isVerified: boolean;
  readonly knownContract: DappKnownContract | null;
}

export const dappCallStandards = Object.freeze([
  "erc20",
  "erc721",
  "permit2",
  "loop",
] as const);
export type DappCallStandard = (typeof dappCallStandards)[number];

export interface DappDecodedCall {
  /** Null when the selector is not one the API decodes (or no calldata). */
  readonly functionName: string | null;
  /** Null for a plain value transfer (empty calldata). */
  readonly selector: string | null;
  readonly standard: DappCallStandard | null;
  /** Decoded arguments as strings (addresses lower-case, integers decimal). */
  readonly args: Readonly<Record<string, string>>;
  /** Calldata length in bytes. */
  readonly dataLength: number;
}

export interface DappCounterpartyReview extends DappAddressReview {
  /** The decoded argument the call grants or sends to. */
  readonly role: "spender" | "operator" | "recipient";
}

export interface DappMessageReview {
  /** `utf8`: the bytes are printable UTF-8 (`text` set); else `hex`. */
  readonly encoding: "utf8" | "hex";
  readonly text: string | null;
  readonly hex: string;
  readonly byteLength: number;
}

export interface DappTypedDataField {
  /** Dotted path into the message (`details.amount`, `tokens[0]`). */
  readonly path: string;
  /** The EIP-712 type of the leaf. */
  readonly type: string;
  /** The leaf as a string, cut at 1,024 characters (`truncated`). */
  readonly value: string;
  readonly truncated: boolean;
}

export interface DappTypedDataReview {
  readonly primaryType: string;
  readonly domain: {
    readonly name: string | null;
    readonly version: string | null;
    readonly chainId: string | null;
    readonly verifyingContract: string | null;
    readonly salt: string | null;
  };
  /** The message tree flattened into leaves, in type order (≤ 256). */
  readonly fields: readonly DappTypedDataField[];
  /** True when the message has more leaves than `fields` holds. */
  readonly fieldsTruncated: boolean;
}

/**
 * Decision 0197: the DApp half of a `dapp_tx` / `dapp_sign` review. Keys
 * that do not apply to the kind are null so the key set is fixed.
 */
export interface IntentDappReview {
  /** Normalised https origin of the page that asked. */
  readonly origin: string;
  readonly method: DappRequestMethod;
  /** dapp_tx: the transaction target; null for dapp_sign. */
  readonly to: DappAddressReview | null;
  /** dapp_tx: the native value; null for dapp_sign. */
  readonly value: IntentAmount | null;
  /** dapp_tx only. */
  readonly decodedCall: DappDecodedCall | null;
  /** dapp_tx: the spender / operator / recipient argument when decoded. */
  readonly counterparty: DappCounterpartyReview | null;
  /** personal_sign only. */
  readonly message: DappMessageReview | null;
  /** eth_signTypedData_v4 only. */
  readonly typedData: DappTypedDataReview | null;
  readonly riskFlags: readonly DappRiskFlag[];
}

/**
 * Decision 0197: the exact JSON-RPC request the device hands to the Privy
 * embedded provider for a `dapp_sign` intent — `params` verbatim.
 */
export interface DappSignatureRequest {
  readonly method: "personal_sign" | "eth_signTypedData_v4";
  /**
   * personal_sign: `[message, address]` (the message exactly as the page
   * sent it); eth_signTypedData_v4: `[address, typedDataJson]`.
   */
  readonly params: readonly [string, string];
}

/**
 * Decision 0197: `detailsSafe.reasonCode` values of the DApp browser
 * refusals. 422 VALIDATION_FAILED carries the validation ones; 503
 * CAPABILITY_UNAVAILABLE carries `DAPP_BROWSER_DISABLED` /
 * `DAPP_BROWSER_CHAIN_UNAVAILABLE`.
 */
export const dappReasonCodes = Object.freeze({
  disabled: "DAPP_BROWSER_DISABLED",
  chainUnavailable: "DAPP_BROWSER_CHAIN_UNAVAILABLE",
  chainSigningDisabled: "CHAIN_SIGNING_DISABLED",
  typedDataChainMismatch: "TYPED_DATA_CHAIN_MISMATCH",
  typedDataInvalid: "TYPED_DATA_INVALID",
  originNotHttps: "ORIGIN_NOT_HTTPS",
  signatureMismatch: "SIGNATURE_MISMATCH",
  signatureNotApplicable: "SIGNATURE_NOT_SIMULATED",
  rpcMethodNotAllowed: "RPC_METHOD_NOT_ALLOWED",
  rpcLogRangeTooLarge: "RPC_LOG_RANGE_TOO_LARGE",
  // S346: 409 RESOURCE_CONFLICT — a send / swap / approve / send_nft intent
  // is open on the wallet; a DApp prepare does not supersede it.
  intentBusy: "INTENT_BUSY",
  // S346: 503 CAPABILITY_UNAVAILABLE — the RPC provider answered with a
  // quota / rate-limit error, or the answer exceeded the size ceiling.
  rpcUpstreamLimited: "RPC_UPSTREAM_LIMITED",
} as const);

/**
 * S346 (Decision 0197 amendment): the DApp kinds. A DApp prepare supersedes
 * only an open DApp intent; an open intent of any other kind makes it 409
 * INTENT_BUSY. Other prepares keep superseding every open intent.
 */
export const dappIntentKinds: readonly WalletIntentKind[] = Object.freeze([
  "dapp_tx",
  "dapp_sign",
]);

export function isDappIntentKind(kind: WalletIntentKind): boolean {
  return dappIntentKinds.includes(kind);
}

/** The one source object from which the payload and the review derive. */
export interface IntentSource {
  readonly version: string;
  readonly intentId: string;
  readonly kind: WalletIntentKind;
  readonly chainId: LaunchChainId;
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
  /** Decision 0194: `send_nft` only (absent otherwise). */
  readonly nft?: IntentNftReview;
  /** Decision 0197: `dapp_tx` / `dapp_sign` only (absent otherwise). */
  readonly dapp?: IntentDappReview;
  /** Decision 0197: `dapp_sign` only (absent otherwise). */
  readonly signatureRequest?: DappSignatureRequest;
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
  /** Decision 0194: `send_nft` only (absent otherwise). */
  readonly nft?: IntentNftReview;
  /** Decision 0197: `dapp_tx` / `dapp_sign` only (absent otherwise). */
  readonly dapp?: IntentDappReview;
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
    ...(canonicalPayload.nft === undefined
      ? {}
      : { nft: canonicalPayload.nft }),
    ...(canonicalPayload.dapp === undefined
      ? {}
      : { dapp: canonicalPayload.dapp }),
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
