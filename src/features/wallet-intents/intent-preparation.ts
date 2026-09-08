import type { Hex } from "viem";

import type { BscWriteConfig } from "../../config.js";
import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import type { V2CursorCodec } from "../../core/http/v2-cursor.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { isOpaqueId } from "../../core/ids/opaque-id.js";
import type {
  AccountWalletRecord,
  AccountWalletRepository,
} from "../../database/account-wallet-repository.js";
import type { BscIndexerRepository } from "../../database/bsc-indexer-repository.js";
import type {
  AssetRecord,
  ChainRegistryRepository,
} from "../../database/chain-registry-repository.js";
import {
  IdempotencyConflictError,
  type ControlPlaneRepository,
} from "../../database/control-plane-repository.js";
import type {
  WalletIntentRecord,
  WalletIntentRepository,
} from "../../database/wallet-intent-repository.js";
import {
  BscChainMismatchError,
  BscReadUnavailableError,
  type BscCallRequest,
  type BscChainCallClient,
  type BscFeeData,
} from "../../integrations/bsc/rpc-client.js";
import {
  fromHexQuantity,
  toHexQuantity,
} from "../../integrations/bsc/tx-builder.js";
import type { PrivySwapAdapter } from "../../integrations/privy/swap-adapter.js";
import {
  bscChainId,
  bscChainReference,
  bscNativeDecimals,
  decomposeAssetId,
  formatDecimalAmount,
  InvalidChainIdentityError,
  isAssetId,
  parseDecimalAmount,
} from "../chain/chain-contract.js";
import {
  compareDecimalStrings,
  multiplyDecimalStrings,
} from "../market/market-contract.js";
import type { MarketFactService } from "../market/market-fact-service.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  bscWriteCanaryPolicyVersion,
  openWalletIntentStates,
  walletIntentIdempotencyScope,
  walletIntentReasonCodes,
  walletIntentRefusalReasonCodes,
  type CanaryPolicyFact,
  type ExposureBasis,
  type IntentAssetSnapshot,
  type IntentBalanceFact,
  type IntentFeeFact,
  type IntentPublicReview,
  type SimulationFact,
  type SwapAuthorizationPayload,
  type UnsignedTransaction,
  type WalletIntentKind,
  type WalletIntentState,
} from "./intent-contract.js";

/**
 * Shared admission, fact-gathering, and projection helpers for every intent
 * kind (Decision 0035). Every prepare walks the same gates in the same order:
 *
 *   writes switch → verified chain → signable wallet → canary asset →
 *   USD ceiling → balance snapshot → pre-execution → fee/nonce → seal
 *
 * A missing dependency fails closed before any fact is gathered; a policy
 * refusal is POLICY_BLOCKED; a fact that cannot be established is
 * CAPABILITY_UNAVAILABLE, never a guess.
 */

export interface WalletIntentRuntimeConfig {
  readonly bscWrites: BscWriteConfig | null;
  readonly privyAppId: string | null;
  readonly gasReserveRawWei: bigint;
}

export interface WalletIntentRuntime {
  readonly config: WalletIntentRuntimeConfig;
  readonly repository: WalletIntentRepository;
  readonly wallets: AccountWalletRepository;
  readonly registry: ChainRegistryRepository;
  readonly indexer: BscIndexerRepository;
  readonly readClient: BscChainCallClient;
  readonly controlPlane: ControlPlaneRepository;
  readonly marketFacts: MarketFactService | null;
  readonly swapAdapter: PrivySwapAdapter;
  readonly cursorCodec: V2CursorCodec | null;
  readonly now: () => Date;
  readonly createUuid: () => string;
}

/** Native transfer gas is exact; contract calls get headroom on the estimate. */
const nativeTransferGas = 21_000n;
const gasHeadroomNumerator = 12n;
const gasHeadroomDenominator = 10n;
const fallbackContractGas = 120_000n;

export function chainUnavailable(error: unknown): never {
  if (
    error instanceof BscReadUnavailableError ||
    error instanceof BscChainMismatchError
  ) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error as Error;
}

/** Writes are closed unless configured, and never open against an unverified chain. */
export async function requireWriteAdmission(
  runtime: WalletIntentRuntime,
): Promise<BscWriteConfig> {
  const writes = runtime.config.bscWrites;
  if (writes === null) {
    throw V2ApiError.capabilityUnavailable();
  }
  if (runtime.readClient.currentVerification() !== "verified") {
    const state = await runtime.readClient.verifyChain();
    if (state !== "verified") {
      throw V2ApiError.capabilityUnavailable();
    }
  }
  return writes;
}

export async function requireWallet(
  runtime: WalletIntentRuntime,
  principal: AuthenticatedLoopPrincipal,
  walletId: unknown,
): Promise<AccountWalletRecord> {
  if (!isOpaqueId(walletId)) {
    throw V2ApiError.invalidRequest();
  }
  const wallet = await runtime.wallets.get(principal.userId, walletId);
  if (wallet === null || wallet.status !== "active") {
    throw V2ApiError.notFound();
  }
  return wallet;
}

/**
 * Only a Privy embedded wallet can sign through the app's signing exit. An
 * external wallet is a valid inventory row but never an intent signer.
 */
export async function requireSignableWallet(
  runtime: WalletIntentRuntime,
  principal: AuthenticatedLoopPrincipal,
  walletId: unknown,
): Promise<AccountWalletRecord & { readonly providerWalletId: string }> {
  const wallet = await requireWallet(runtime, principal, walletId);
  if (wallet.kind !== "embedded" || wallet.providerWalletId === null) {
    throw V2ApiError.fromCode("VALIDATION_FAILED");
  }
  return wallet as AccountWalletRecord & { readonly providerWalletId: string };
}

/**
 * Shape → chain → registry → not blocked. This is the asset admission every
 * intent shares; the canary allowlist is a separate, later gate so a kind
 * can insert its own structural check (e.g. "native has no allowance
 * surface") between the two.
 */
export async function requireAdmittedAsset(
  runtime: WalletIntentRuntime,
  assetId: unknown,
): Promise<AssetRecord> {
  if (!isAssetId(assetId)) {
    throw V2ApiError.invalidRequest();
  }
  let parsed;
  try {
    parsed = decomposeAssetId(assetId);
  } catch (error) {
    if (error instanceof InvalidChainIdentityError) {
      throw V2ApiError.invalidRequest();
    }
    throw error;
  }
  if (parsed.chainId !== bscChainId) {
    throw V2ApiError.fromCode("CHAIN_MISMATCH");
  }
  const asset = await runtime.registry.getAsset(assetId);
  if (asset === null) {
    throw V2ApiError.notFound();
  }
  if (asset.status === "blocked") {
    throw V2ApiError.fromCode("POLICY_BLOCKED", {
      reasonCode: walletIntentRefusalReasonCodes.assetBlocked,
    });
  }
  return asset;
}

export function requireCanaryAllowlisted(
  writes: BscWriteConfig,
  asset: AssetRecord,
): AssetRecord {
  if (!writes.canaryAssetIds.includes(asset.assetId)) {
    throw V2ApiError.fromCode("POLICY_BLOCKED", {
      reasonCode: walletIntentRefusalReasonCodes.assetNotInCanaryAllowlist,
    });
  }
  return asset;
}

export async function requireCanaryAsset(
  runtime: WalletIntentRuntime,
  writes: BscWriteConfig,
  assetId: unknown,
): Promise<AssetRecord> {
  return requireCanaryAllowlisted(
    writes,
    await requireAdmittedAsset(runtime, assetId),
  );
}

export function parseIntentAmount(value: unknown, decimals: number): bigint {
  if (typeof value !== "string") {
    throw V2ApiError.invalidRequest();
  }
  let raw: bigint;
  try {
    raw = parseDecimalAmount(value, decimals);
  } catch {
    throw V2ApiError.invalidRequest();
  }
  if (raw <= 0n) {
    throw V2ApiError.invalidRequest();
  }
  return raw;
}

export function assetSnapshot(asset: AssetRecord): IntentAssetSnapshot {
  return Object.freeze({
    assetId: asset.assetId,
    address: asset.address,
    symbol: asset.symbol,
    decimals: asset.decimals,
  });
}

export interface UsdValuation {
  readonly valueUsd: string;
  readonly priceSource: string;
  readonly fetchedAt: string;
}

/**
 * USD value of an amount from the market fact service. The canary ceiling is
 * a hard product rule, so an amount that cannot be priced is not admitted
 * (CAPABILITY_UNAVAILABLE, retryable) rather than assumed to be small.
 */
export async function valueInUsd(
  runtime: WalletIntentRuntime,
  asset: AssetRecord,
  raw: bigint,
  signal: AbortSignal,
): Promise<UsdValuation> {
  if (runtime.marketFacts === null) {
    throw V2ApiError.capabilityUnavailable();
  }
  // The ceiling is enforced on a fresh Provider price only; a stale price
  // could under-value the intent and is refused rather than tolerated.
  const price = await runtime.marketFacts.readAssetPrice(asset, {
    signal,
    requireFresh: true,
  });
  if (
    price.fact.fetchedAt === null ||
    price.fact.quality !== "fresh" ||
    price.pair === null ||
    price.pair.priceUsd === null
  ) {
    throw V2ApiError.capabilityUnavailable();
  }
  return Object.freeze({
    valueUsd: multiplyDecimalStrings(
      formatDecimalAmount(raw, asset.decimals),
      price.pair.priceUsd,
    ),
    priceSource: price.fact.source,
    fetchedAt: price.fact.fetchedAt,
  });
}

export function enforceCanaryCeiling(
  writes: BscWriteConfig,
  valueUsd: string,
  reasonCode:
    | typeof walletIntentRefusalReasonCodes.canaryCeilingExceeded
    | typeof walletIntentRefusalReasonCodes.unlimitedExposureExceedsCeiling = walletIntentRefusalReasonCodes.canaryCeilingExceeded,
): void {
  if (compareDecimalStrings(valueUsd, writes.canaryMaxUsd) > 0) {
    // The exposure and the ceiling are the two numbers the sign sheet shows
    // ("your exposure is $X, the ceiling is $Y"); both are decimal strings.
    throw V2ApiError.fromCode("POLICY_BLOCKED", {
      reasonCode,
      exposureUsd: valueUsd,
      ceilingUsd: writes.canaryMaxUsd,
    });
  }
}

export function canaryPolicyFact(
  writes: BscWriteConfig,
  valuation: UsdValuation | null,
  exposure: {
    readonly basis: ExposureBasis;
    readonly raw: bigint | null;
    readonly blockNumber: string | null;
  },
): CanaryPolicyFact {
  return Object.freeze({
    configVersion: bscWriteCanaryPolicyVersion,
    canaryMaxUsd: writes.canaryMaxUsd,
    exposureBasis: exposure.basis,
    exposureRaw: exposure.raw === null ? null : exposure.raw.toString(10),
    exposureBlockNumber: exposure.blockNumber,
    valueUsd: valuation?.valueUsd ?? null,
    priceSource: valuation?.priceSource ?? null,
    priceFetchedAt: valuation?.fetchedAt ?? null,
  });
}

export interface BalanceSnapshot {
  readonly fact: IntentBalanceFact;
  readonly rawBalance: bigint;
  readonly rawNativeBalance: bigint;
}

export async function readBalanceSnapshot(
  runtime: WalletIntentRuntime,
  wallet: AccountWalletRecord,
  asset: AssetRecord,
): Promise<BalanceSnapshot> {
  const nativeAssetId = `${bscChainId}:native`;
  const items =
    asset.address === null
      ? [{ assetId: asset.assetId, address: null }]
      : [
          { assetId: asset.assetId, address: asset.address },
          { assetId: nativeAssetId, address: null },
        ];
  let read;
  try {
    read = await runtime.readClient.readBalances(wallet.address, items);
  } catch (error) {
    return chainUnavailable(error);
  }
  const rawBalance = read.balances.find(
    (balance) => balance.assetId === asset.assetId,
  )?.rawValue;
  const rawNativeBalance =
    asset.address === null
      ? rawBalance
      : read.balances.find((balance) => balance.assetId === nativeAssetId)
          ?.rawValue;
  if (
    rawBalance === undefined ||
    rawBalance === null ||
    rawNativeBalance === undefined ||
    rawNativeBalance === null
  ) {
    throw V2ApiError.capabilityUnavailable();
  }
  return Object.freeze({
    fact: Object.freeze({
      blockNumber: read.head.blockNumber.toString(10),
      blockHash: read.head.blockHash,
      observedAt: read.head.observedAt,
      rawBalance: rawBalance.toString(10),
      displayBalance: formatDecimalAmount(rawBalance, asset.decimals),
      rawNativeBalance: rawNativeBalance.toString(10),
      gasReserveRaw: runtime.config.gasReserveRawWei.toString(10),
    }),
    rawBalance,
    rawNativeBalance,
  });
}

export interface PreExecution {
  readonly simulation: SimulationFact;
  readonly gasLimit: bigint;
}

/**
 * `eth_call` then `estimateGas` for the exact payload. A revert is a fact
 * about the payload (`reverted`); an endpoint failure is `unavailable`. In
 * both cases the intent is still created so the user can see why, but it
 * never becomes signable.
 */
export async function preExecute(
  runtime: WalletIntentRuntime,
  request: BscCallRequest,
  isNativeTransfer: boolean,
): Promise<PreExecution> {
  const observedAt = runtime.now().toISOString();
  const fallbackGas = isNativeTransfer
    ? nativeTransferGas
    : fallbackContractGas;
  let outcome;
  try {
    outcome = await runtime.readClient.call(request);
  } catch (error) {
    if (
      error instanceof BscReadUnavailableError ||
      error instanceof BscChainMismatchError
    ) {
      throw V2ApiError.capabilityUnavailable();
    }
    return Object.freeze({
      simulation: Object.freeze({
        status: "unavailable" as const,
        source: "rpc_call" as const,
        observedAt,
        reasonCode: walletIntentReasonCodes.simulationUnavailable,
      }),
      gasLimit: fallbackGas,
    });
  }
  if (outcome.status === "reverted") {
    return Object.freeze({
      simulation: Object.freeze({
        status: "reverted" as const,
        source: "rpc_call" as const,
        observedAt,
        reasonCode: outcome.reasonCode,
      }),
      gasLimit: fallbackGas,
    });
  }
  let estimate: bigint | null;
  try {
    estimate = await runtime.readClient.estimateGas(request);
  } catch {
    estimate = null;
  }
  if (estimate === null) {
    return Object.freeze({
      simulation: Object.freeze({
        status: "unavailable" as const,
        source: "rpc_call" as const,
        observedAt,
        reasonCode: walletIntentReasonCodes.gasEstimateUnavailable,
      }),
      gasLimit: fallbackGas,
    });
  }
  const gasLimit = isNativeTransfer
    ? estimate > nativeTransferGas
      ? estimate
      : nativeTransferGas
    : (estimate * gasHeadroomNumerator) / gasHeadroomDenominator;
  return Object.freeze({
    simulation: Object.freeze({
      status: "passed" as const,
      source: "rpc_call" as const,
      observedAt,
      reasonCode: null,
    }),
    gasLimit,
  });
}

export interface FeeSnapshot {
  readonly feeData: BscFeeData;
  readonly fact: IntentFeeFact;
  readonly maximumFeeRaw: bigint;
}

export async function readFeeSnapshot(
  runtime: WalletIntentRuntime,
  gasLimit: bigint,
): Promise<FeeSnapshot> {
  let feeData: BscFeeData;
  try {
    feeData = await runtime.readClient.getFeeData();
  } catch (error) {
    return chainUnavailable(error);
  }
  const perGas =
    feeData.type === "eip1559" ? feeData.maxFeePerGas : feeData.gasPrice;
  const maximumFeeRaw = gasLimit * perGas;
  return Object.freeze({
    feeData,
    maximumFeeRaw,
    fact: Object.freeze({
      gasLimit: gasLimit.toString(10),
      type: feeData.type,
      maxFeePerGas:
        feeData.type === "eip1559" ? feeData.maxFeePerGas.toString(10) : null,
      maxPriorityFeePerGas:
        feeData.type === "eip1559"
          ? feeData.maxPriorityFeePerGas.toString(10)
          : null,
      gasPrice:
        feeData.type === "legacy" ? feeData.gasPrice.toString(10) : null,
      maximumFeeRaw: maximumFeeRaw.toString(10),
      maximumFee: formatDecimalAmount(maximumFeeRaw, bscNativeDecimals),
      observedAt: runtime.now().toISOString(),
    }),
  });
}

export async function readNonce(
  runtime: WalletIntentRuntime,
  address: string,
): Promise<number> {
  try {
    return await runtime.readClient.getTransactionCount(address);
  } catch (error) {
    return chainUnavailable(error);
  }
}

export function buildUnsignedTransaction(input: {
  readonly from: string;
  readonly to: string;
  readonly data: Hex;
  readonly value: bigint;
  readonly gasLimit: bigint;
  readonly nonce: number;
  readonly feeData: BscFeeData;
}): UnsignedTransaction {
  return Object.freeze({
    chainId: bscChainReference,
    from: input.from,
    to: input.to,
    data: input.data,
    value: toHexQuantity(input.value),
    gas: toHexQuantity(input.gasLimit),
    nonce: toHexQuantity(BigInt(input.nonce)),
    type: input.feeData.type,
    maxFeePerGas:
      input.feeData.type === "eip1559"
        ? toHexQuantity(input.feeData.maxFeePerGas)
        : null,
    maxPriorityFeePerGas:
      input.feeData.type === "eip1559"
        ? toHexQuantity(input.feeData.maxPriorityFeePerGas)
        : null,
    gasPrice:
      input.feeData.type === "legacy"
        ? toHexQuantity(input.feeData.gasPrice)
        : null,
  });
}

/**
 * Native sufficiency: the amount (for a native send) plus the maximum fee
 * must fit in the native balance, and a native send must also leave the
 * configured gas reserve untouched.
 */
export function assertNativeSufficiency(input: {
  readonly rawNativeBalance: bigint;
  readonly nativeAmount: bigint;
  readonly maximumFeeRaw: bigint;
  readonly gasReserveRaw: bigint;
}): void {
  if (input.nativeAmount + input.maximumFeeRaw > input.rawNativeBalance) {
    throw V2ApiError.fromCode("INSUFFICIENT_BALANCE");
  }
  if (
    input.nativeAmount > 0n &&
    input.nativeAmount + input.gasReserveRaw > input.rawNativeBalance
  ) {
    throw V2ApiError.fromCode("INSUFFICIENT_BALANCE");
  }
}

export function intentStateForSimulation(
  simulation: SimulationFact,
): "prepared" | "awaiting_signature" {
  return simulation.status === "passed" ? "awaiting_signature" : "prepared";
}

/**
 * Binds the prepare to the client's Idempotency-Key through the generic
 * provider-operation journal. A replay with the same digest returns the
 * intent the first call created; a different digest is a conflict.
 */
export async function withPrepareIdempotency(
  runtime: WalletIntentRuntime,
  input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly kind: WalletIntentKind;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
    readonly requestId: string;
  },
  build: (operationId: string) => Promise<WalletIntentRecord>,
): Promise<{ readonly created: boolean; readonly record: WalletIntentRecord }> {
  let prepared;
  try {
    prepared = await runtime.controlPlane.prepareProviderOperation({
      ownerUserId: input.principal.userId,
      scope: walletIntentIdempotencyScope,
      idempotencyKey: input.idempotencyKey,
      keySource: "client",
      requestSha256: input.requestSha256,
      domain: input.kind === "swap" ? "privy" : "bsc",
      operationKind: `wallet_intent_${input.kind}`,
      requestId: input.requestId,
    });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      throw V2ApiError.idempotencyConflict();
    }
    throw error;
  }
  if (!prepared.created) {
    const existing = await runtime.repository.findByOperationId(
      input.principal.userId,
      prepared.operation.id,
    );
    if (existing !== null) {
      return Object.freeze({ created: false, record: existing });
    }
  }
  const record = await build(prepared.operation.id);
  return Object.freeze({ created: true, record });
}

export interface WalletIntentReceiptProjection {
  readonly status: "success" | "reverted";
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly gasUsed: string;
  readonly effectiveGasPrice: string;
  readonly confirmations: number | null;
  readonly observedAt: string;
}

export interface WalletIntentResource {
  readonly intentId: string;
  readonly kind: WalletIntentKind;
  readonly state: WalletIntentState;
  readonly walletId: string;
  readonly chainId: string;
  readonly review: IntentPublicReview;
  readonly reviewSha256: string;
  readonly factsObservedAt: string;
  readonly expiresAt: string;
  readonly simulation: SimulationFact;
  readonly policy: CanaryPolicyFact;
  readonly signing: {
    readonly mode:
      "device_eth_send_transaction" | "privy_authorization_signature";
    readonly allowed: boolean;
    readonly reasonCode: string | null;
  };
  readonly unsignedTransaction: UnsignedTransaction | null;
  readonly authorizationPayload: SwapAuthorizationPayload | null;
  readonly result: {
    readonly transactionHash: string | null;
    readonly providerActionId: string | null;
    readonly reasonCode: string | null;
    readonly receipt: WalletIntentReceiptProjection | null;
  };
  readonly version: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly contractVersion: typeof v2ContractVersion;
}

export function isElapsed(record: WalletIntentRecord, now: Date): boolean {
  return (
    openWalletIntentStates.has(record.state) &&
    Date.parse(record.expiresAt) <= now.getTime()
  );
}

/**
 * Projects a record for the client. An open intent past its expiry is shown
 * as `expired` even before the lane persists it, so the signing sheet can
 * never enable a button on stale facts.
 */
export function projectIntent(
  record: WalletIntentRecord,
  now: Date,
  headBlockNumber: bigint | null,
  confirmationsRequired: number,
): WalletIntentResource {
  const elapsed = isElapsed(record, now);
  const state: WalletIntentState = elapsed ? "expired" : record.state;
  const reasonCode = elapsed
    ? walletIntentReasonCodes.expired
    : record.reasonCode;
  const payload = record.canonicalPayload;
  const signingAllowed = state === "awaiting_signature";
  const signingReason = signingAllowed
    ? null
    : state === "prepared"
      ? (payload.simulation.reasonCode ??
        (record.simulationStatus === "reverted"
          ? walletIntentReasonCodes.simulationReverted
          : walletIntentReasonCodes.simulationUnavailable))
      : (reasonCode ?? `INTENT_${state.toUpperCase()}`);
  const receipt = record.receipt;
  return Object.freeze({
    intentId: record.intentId,
    kind: record.kind,
    state,
    walletId: record.walletId,
    chainId: record.chainId,
    review: record.publicReview,
    reviewSha256: record.reviewSha256,
    factsObservedAt: record.factsObservedAt,
    expiresAt: record.expiresAt,
    simulation: payload.simulation,
    policy: payload.policy,
    signing: Object.freeze({
      mode: payload.signingMode,
      allowed: signingAllowed,
      reasonCode: signingReason,
    }),
    unsignedTransaction: payload.transaction,
    authorizationPayload: payload.swap?.authorizationPayload ?? null,
    result: Object.freeze({
      transactionHash: record.transactionHash,
      providerActionId: record.providerActionId,
      reasonCode,
      receipt:
        receipt === null
          ? null
          : Object.freeze({
              status: receipt.status,
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash,
              gasUsed: receipt.gasUsed,
              effectiveGasPrice: receipt.effectiveGasPrice,
              confirmations:
                headBlockNumber === null
                  ? null
                  : Math.min(
                      Number(
                        headBlockNumber - BigInt(receipt.blockNumber) + 1n,
                      ),
                      Math.max(confirmationsRequired, 1) * 1000,
                    ),
              observedAt: receipt.observedAt,
            }),
    }),
    version: record.recordVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    contractVersion: v2ContractVersion,
  });
}

export { fromHexQuantity };
