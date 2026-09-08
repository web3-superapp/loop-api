import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { isOpaqueId } from "../../core/ids/opaque-id.js";
import type { AssetRecord } from "../../database/chain-registry-repository.js";
import {
  InvalidProviderOperationStateError,
  type ProviderOperation,
} from "../../database/control-plane-repository.js";
import type { WalletIntentRecord } from "../../database/wallet-intent-repository.js";
import { WalletIntentStateConflictError } from "../../database/wallet-intent-repository.js";
import {
  PrivySwapProviderError,
  type PrivySwapAction,
} from "../../integrations/privy/swap-adapter.js";
import { bscChainId, formatDecimalAmount } from "../chain/chain-contract.js";
import {
  compareDecimalStrings,
  formatRational,
} from "../market/market-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  intentRequestDigest,
  sealIntent,
  swapIntentTtlSeconds,
  swapPolicy,
  walletIntentPayloadVersions,
  walletIntentReasonCodes,
  type IntentSource,
  type PriceImpactFact,
  type SwapAuthorizationPayload,
  type SwapQuoteSnapshot,
} from "./intent-contract.js";
import {
  assetSnapshot,
  canaryPolicyFact,
  enforceCanaryCeiling,
  isElapsed,
  parseIntentAmount,
  projectIntent,
  readBalanceSnapshot,
  requireCanaryAsset,
  requireSignableWallet,
  requireWriteAdmission,
  valueInUsd,
  withPrepareIdempotency,
  type UsdValuation,
  type WalletIntentResource,
  type WalletIntentRuntime,
} from "./intent-preparation.js";

/**
 * D15 Privy Swap (Decision 0035): quote → immutable intent → one execute.
 *
 * The quote is a server-side `wallets.swap.quote` call with LOOP's own 30 s
 * expiry. The intent binds the quote snapshot, the exact Privy execute body,
 * and the authorization payload the device must sign. `execute` forwards the
 * device signature once, journals the single attempt, and turns any
 * ambiguous outcome into `unknown` for the reconciliation lane.
 */

export interface SwapQuoteResource {
  readonly walletId: string;
  readonly sourceAsset: ReturnType<typeof assetSnapshot>;
  readonly destinationAsset: ReturnType<typeof assetSnapshot>;
  readonly quote: SwapQuoteSnapshot;
  readonly policy: typeof swapPolicy;
  readonly canary: {
    readonly configVersion: string;
    readonly canaryMaxUsd: string;
    readonly inputValueUsd: string;
  };
  readonly contractVersion: typeof v2ContractVersion;
}

export interface SwapService {
  quote(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly body: unknown;
    readonly signal: AbortSignal;
  }): Promise<SwapQuoteResource>;
  prepare(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly body: unknown;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly created: boolean;
    readonly resource: WalletIntentResource;
  }>;
  execute(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly intentId: string;
    readonly body: unknown;
    readonly signal: AbortSignal;
  }): Promise<WalletIntentResource>;
}

/** A quote the client may turn into an intent; single-process, bounded by TTL. */
export interface StoredSwapQuote {
  readonly quoteId: string;
  readonly ownerUserId: string;
  readonly walletId: string;
  readonly providerWalletId: string;
  readonly sourceAsset: AssetRecord;
  readonly destinationAsset: AssetRecord;
  readonly inputValuation: UsdValuation;
  readonly snapshot: SwapQuoteSnapshot;
}

export interface SwapQuoteStore {
  put(quote: StoredSwapQuote): void;
  take(ownerUserId: string, quoteId: string): StoredSwapQuote | null;
}

const maximumStoredQuotes = 1_000;

/**
 * In-process quote store. A quote is only ever valid for 30 s, so an
 * evicted or restarted process simply makes the client re-quote
 * (`QUOTE_EXPIRED`); nothing is inferred from a quote the process cannot see.
 */
export function createInMemorySwapQuoteStore(
  now: () => Date = (): Date => new Date(),
): SwapQuoteStore {
  const quotes = new Map<string, StoredSwapQuote>();
  return Object.freeze({
    put(quote: StoredSwapQuote): void {
      const cutoff = now().getTime();
      for (const [key, stored] of quotes) {
        if (Date.parse(stored.snapshot.expiresAt) <= cutoff) {
          quotes.delete(key);
        }
      }
      if (quotes.size >= maximumStoredQuotes) {
        const oldest = quotes.keys().next().value;
        if (oldest !== undefined) {
          quotes.delete(oldest);
        }
      }
      quotes.set(quote.quoteId, quote);
    },
    take(ownerUserId: string, quoteId: string): StoredSwapQuote | null {
      const stored = quotes.get(quoteId);
      if (stored === undefined || stored.ownerUserId !== ownerUserId) {
        return null;
      }
      return stored;
    },
  });
}

function parseSlippage(value: unknown): number {
  if (value === undefined) {
    return swapPolicy.defaultSlippageBps;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > swapPolicy.maximumSlippageBps
  ) {
    throw V2ApiError.invalidRequest();
  }
  return value;
}

const usdScaleDigits = 18;

/** Decimal USD string → integer scaled by 10^18, truncating extra digits. */
function toScaledUsd(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(
    `${whole}${fraction.slice(0, usdScaleDigits).padEnd(usdScaleDigits, "0")}`,
  );
}

function privyAssetAddress(asset: AssetRecord): string {
  return asset.address ?? "native";
}

/**
 * Price impact from two Provider prices: 1 − (estimated output value ÷ input
 * value). Without both prices it is unavailable and the swap is blocked: the
 * hard limit cannot be enforced on an unknown number.
 */
export function assessPriceImpact(input: {
  readonly inputValueUsd: string;
  readonly outputValuation: UsdValuation | null;
}): PriceImpactFact {
  if (
    input.outputValuation === null ||
    compareDecimalStrings(input.inputValueUsd, "0") <= 0
  ) {
    return Object.freeze({
      status: "unavailable" as const,
      value: null,
      decision: "blocked" as const,
      reasonCode: walletIntentReasonCodes.priceImpactUnavailable,
      marketValueUsd: input.inputValueUsd,
      estimatedOutputValueUsd: input.outputValuation?.valueUsd ?? null,
      priceSource: input.outputValuation?.priceSource ?? null,
    });
  }
  const inputScaled = toScaledUsd(input.inputValueUsd);
  const outputScaled = toScaledUsd(input.outputValuation.valueUsd);
  const lost = inputScaled > outputScaled ? inputScaled - outputScaled : 0n;
  const impact = formatRational(lost, inputScaled, 6);
  const decision =
    compareDecimalStrings(impact, swapPolicy.hardBlockPriceImpact) >= 0
      ? ("blocked" as const)
      : compareDecimalStrings(impact, swapPolicy.confirmPriceImpact) >= 0
        ? ("confirm" as const)
        : ("allowed" as const);
  return Object.freeze({
    status: "available" as const,
    value: impact,
    decision,
    reasonCode:
      decision === "blocked"
        ? walletIntentReasonCodes.priceImpactBlocked
        : decision === "confirm"
          ? walletIntentReasonCodes.priceImpactConfirm
          : null,
    marketValueUsd: input.inputValueUsd,
    estimatedOutputValueUsd: input.outputValuation.valueUsd,
    priceSource: input.outputValuation.priceSource,
  });
}

export interface CreateSwapServiceInput {
  readonly runtime: WalletIntentRuntime;
  readonly quoteStore: SwapQuoteStore;
  readonly privyApiBaseUrl?: string;
}

const defaultPrivyApiBaseUrl = "https://api.privy.io";
const executeAttemptMs = 10_000;
const postExecuteReconcileDelayMs = 5_000;

export function createSwapService(input: CreateSwapServiceInput): SwapService {
  const { runtime, quoteStore } = input;
  const privyApiBaseUrl = (
    input.privyApiBaseUrl ?? defaultPrivyApiBaseUrl
  ).replace(/\/$/, "");

  function requirePrivyAppId(): string {
    const appId = runtime.config.privyAppId;
    if (appId === null) {
      throw V2ApiError.capabilityUnavailable();
    }
    return appId;
  }

  async function resolveExecuteOutcome(
    principal: AuthenticatedLoopPrincipal,
    record: WalletIntentRecord,
    operation: ProviderOperation,
    requestId: string,
    outcome:
      | { readonly kind: "accepted"; readonly action: PrivySwapAction }
      | { readonly kind: "rejected"; readonly reasonCode: string }
      | { readonly kind: "ambiguous"; readonly reasonCode: string },
  ): Promise<WalletIntentRecord> {
    const transitionInput = {
      ownerUserId: principal.userId,
      operationId: operation.id,
      requestId,
      transportAttemptId: operation.transportAttemptId as string,
      recordVersion: operation.recordVersion,
    };
    if (outcome.kind === "accepted") {
      const action = outcome.action;
      const hash =
        action.steps.find((step) => step.transactionHash !== null)
          ?.transactionHash ?? null;
      const settled =
        action.status === "succeeded"
          ? ("confirmed" as const)
          : action.status === "rejected" || action.status === "failed"
            ? ("failed" as const)
            : ("submitted" as const);
      await runtime.controlPlane.markProviderOperationResult({
        ...transitionInput,
        state: "accepted",
      });
      return runtime.repository.transition({
        ownerUserId: principal.userId,
        intentId: record.intentId,
        expectedVersion: record.recordVersion,
        fromStates: ["submitted"],
        toState: settled,
        eventType: "provider_accepted",
        actorType: "api",
        requestId,
        reasonCode:
          settled === "failed"
            ? (action.failureReasonCode ?? walletIntentReasonCodes.privyFailed)
            : null,
        providerActionId: action.actionId,
        transactionHash: hash,
        reconcileAfter:
          settled === "submitted"
            ? new Date(
                runtime.now().getTime() + postExecuteReconcileDelayMs,
              ).toISOString()
            : null,
        details: { providerStatus: action.status },
      });
    }
    if (outcome.kind === "rejected") {
      await runtime.controlPlane.markProviderOperationResult({
        ...transitionInput,
        state: "rejected",
        reasonCode: "privy_swap_rejected",
      });
      return runtime.repository.transition({
        ownerUserId: principal.userId,
        intentId: record.intentId,
        expectedVersion: record.recordVersion,
        fromStates: ["submitted"],
        toState: "failed",
        eventType: "provider_rejected",
        actorType: "api",
        requestId,
        reasonCode: outcome.reasonCode,
        reconcileAfter: null,
      });
    }
    await runtime.controlPlane.markProviderOperationUnknown({
      ...transitionInput,
      reasonCode: "privy_swap_result_ambiguous",
      retryDelayMs: postExecuteReconcileDelayMs,
    });
    return runtime.repository.transition({
      ownerUserId: principal.userId,
      intentId: record.intentId,
      expectedVersion: record.recordVersion,
      fromStates: ["submitted"],
      toState: "unknown",
      eventType: "provider_result_ambiguous",
      actorType: "api",
      requestId,
      reasonCode: outcome.reasonCode,
      reconcileAfter: new Date(
        runtime.now().getTime() + postExecuteReconcileDelayMs,
      ).toISOString(),
    });
  }

  const service: SwapService = {
    async quote({ principal, body, signal }) {
      if (typeof body !== "object" || body === null) {
        throw V2ApiError.invalidRequest();
      }
      const request = body as {
        readonly walletId?: unknown;
        readonly sourceAssetId?: unknown;
        readonly destinationAssetId?: unknown;
        readonly amount?: unknown;
        readonly slippageBps?: unknown;
      };
      const writes = await requireWriteAdmission(runtime);
      requirePrivyAppId();
      const slippageBps = parseSlippage(request.slippageBps);
      const wallet = await requireSignableWallet(
        runtime,
        principal,
        request.walletId,
      );
      const sourceAsset = await requireCanaryAsset(
        runtime,
        writes,
        request.sourceAssetId,
      );
      const destinationAsset = await requireCanaryAsset(
        runtime,
        writes,
        request.destinationAssetId,
      );
      if (sourceAsset.assetId === destinationAsset.assetId) {
        throw V2ApiError.fromCode("VALIDATION_FAILED");
      }
      const amountRaw = parseIntentAmount(request.amount, sourceAsset.decimals);
      const inputValuation = await valueInUsd(
        runtime,
        sourceAsset,
        amountRaw,
        signal,
      );
      enforceCanaryCeiling(writes, inputValuation.valueUsd);
      const balance = await readBalanceSnapshot(runtime, wallet, sourceAsset);
      if (amountRaw > balance.rawBalance) {
        throw V2ApiError.fromCode("INSUFFICIENT_BALANCE");
      }
      let providerQuote;
      try {
        providerQuote = await runtime.swapAdapter.quote({
          providerWalletId: wallet.providerWalletId,
          source: {
            assetAddress: privyAssetAddress(sourceAsset),
            caip2: bscChainId,
          },
          destination: {
            assetAddress: privyAssetAddress(destinationAsset),
            caip2: bscChainId,
          },
          baseAmount: amountRaw.toString(10),
          slippageBps,
          feeBps: writes.swapFeeBps,
          signal,
        });
      } catch (error) {
        if (error instanceof PrivySwapProviderError) {
          throw error.kind === "rejected"
            ? V2ApiError.fromCode("VALIDATION_FAILED")
            : V2ApiError.fromCode("PROVIDER_DISCONNECTED");
        }
        throw error;
      }
      if (providerQuote.caip2 !== bscChainId) {
        throw V2ApiError.fromCode("CHAIN_MISMATCH");
      }
      if (providerQuote.inputAmount !== amountRaw.toString(10)) {
        throw V2ApiError.fromCode("PROVIDER_DISCONNECTED");
      }
      let outputValuation: UsdValuation | null = null;
      try {
        outputValuation = await valueInUsd(
          runtime,
          destinationAsset,
          BigInt(providerQuote.estimatedOutputAmount),
          signal,
        );
      } catch (error) {
        if (!(error instanceof V2ApiError)) {
          throw error;
        }
      }
      const now = runtime.now();
      const expiresAt = new Date(
        now.getTime() + swapPolicy.quoteTtlSeconds * 1000,
      );
      const snapshot: SwapQuoteSnapshot = Object.freeze({
        quoteId: runtime.createUuid(),
        provider: "privy" as const,
        amountType: "exact_input" as const,
        inputAmount: Object.freeze({
          raw: providerQuote.inputAmount,
          display: formatDecimalAmount(
            BigInt(providerQuote.inputAmount),
            sourceAsset.decimals,
          ),
        }),
        estimatedOutputAmount: Object.freeze({
          raw: providerQuote.estimatedOutputAmount,
          display: formatDecimalAmount(
            BigInt(providerQuote.estimatedOutputAmount),
            destinationAsset.decimals,
          ),
        }),
        minimumOutputAmount: Object.freeze({
          raw: providerQuote.minimumOutputAmount,
          display: formatDecimalAmount(
            BigInt(providerQuote.minimumOutputAmount),
            destinationAsset.decimals,
          ),
        }),
        slippageBps,
        gasEstimateRaw: providerQuote.gasEstimate,
        quotedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        priceImpact: assessPriceImpact({
          inputValueUsd: inputValuation.valueUsd,
          outputValuation,
        }),
        platformFeeBps: writes.swapFeeBps,
      });
      quoteStore.put({
        quoteId: snapshot.quoteId,
        ownerUserId: principal.userId,
        walletId: wallet.walletId,
        providerWalletId: wallet.providerWalletId,
        sourceAsset,
        destinationAsset,
        inputValuation,
        snapshot,
      });
      return Object.freeze({
        walletId: wallet.walletId,
        sourceAsset: assetSnapshot(sourceAsset),
        destinationAsset: assetSnapshot(destinationAsset),
        quote: snapshot,
        policy: swapPolicy,
        canary: Object.freeze({
          configVersion: writes.configVersion,
          canaryMaxUsd: writes.canaryMaxUsd,
          inputValueUsd: inputValuation.valueUsd,
        }),
        contractVersion: v2ContractVersion,
      });
    },

    async prepare({ principal, idempotencyKey, body }) {
      if (typeof body !== "object" || body === null) {
        throw V2ApiError.invalidRequest();
      }
      const request = body as {
        readonly walletId?: unknown;
        readonly quoteId?: unknown;
        readonly confirmPriceImpact?: unknown;
      };
      if (!isOpaqueId(request.quoteId)) {
        throw V2ApiError.invalidRequest();
      }
      if (
        request.confirmPriceImpact !== undefined &&
        typeof request.confirmPriceImpact !== "boolean"
      ) {
        throw V2ApiError.invalidRequest();
      }
      const writes = await requireWriteAdmission(runtime);
      const appId = requirePrivyAppId();
      const wallet = await requireSignableWallet(
        runtime,
        principal,
        request.walletId,
      );
      const quote = quoteStore.take(principal.userId, request.quoteId);
      if (quote === null || quote.walletId !== wallet.walletId) {
        throw V2ApiError.fromCode("QUOTE_EXPIRED");
      }
      if (Date.parse(quote.snapshot.expiresAt) <= runtime.now().getTime()) {
        throw V2ApiError.fromCode("QUOTE_EXPIRED");
      }
      // Re-admit the assets: the allowlist may have changed since the quote.
      await requireCanaryAsset(runtime, writes, quote.sourceAsset.assetId);
      await requireCanaryAsset(runtime, writes, quote.destinationAsset.assetId);
      enforceCanaryCeiling(writes, quote.inputValuation.valueUsd);
      if (quote.snapshot.priceImpact.decision === "blocked") {
        throw V2ApiError.fromCode("POLICY_BLOCKED");
      }
      if (
        quote.snapshot.priceImpact.decision === "confirm" &&
        request.confirmPriceImpact !== true
      ) {
        throw V2ApiError.fromCode("VALIDATION_FAILED");
      }
      const requestId = runtime.createUuid();
      const outcome = await withPrepareIdempotency(
        runtime,
        {
          principal,
          kind: "swap",
          idempotencyKey,
          requestSha256: intentRequestDigest("swap", [
            wallet.walletId,
            quote.quoteId,
          ]),
          requestId,
        },
        async (operationId): Promise<WalletIntentRecord> => {
          const balance = await readBalanceSnapshot(
            runtime,
            wallet,
            quote.sourceAsset,
          );
          const amountRaw = BigInt(quote.snapshot.inputAmount.raw);
          if (amountRaw > balance.rawBalance) {
            throw V2ApiError.fromCode("INSUFFICIENT_BALANCE");
          }
          const now = runtime.now();
          const intentId = runtime.createUuid();
          const expiresAtMs = Math.min(
            Date.parse(quote.snapshot.expiresAt),
            now.getTime() + swapIntentTtlSeconds * 1000,
          );
          const authorizationPayload: SwapAuthorizationPayload = Object.freeze({
            version: 1 as const,
            method: "POST" as const,
            url: `${privyApiBaseUrl}/v1/wallets/${wallet.providerWalletId}/swap`,
            body: Object.freeze({
              base_amount: quote.snapshot.inputAmount.raw,
              source: Object.freeze({
                asset_address: privyAssetAddress(quote.sourceAsset),
                caip2: bscChainId,
              }),
              destination: Object.freeze({
                asset_address: privyAssetAddress(quote.destinationAsset),
                caip2: bscChainId,
              }),
              amount_type: "exact_input" as const,
              slippage_bps: quote.snapshot.slippageBps,
              ...(writes.swapFeeBps === null
                ? {}
                : {
                    fee_configuration: Object.freeze({
                      type: "total_fee_bps" as const,
                      value: writes.swapFeeBps,
                    }),
                  }),
            }),
            headers: Object.freeze({
              "privy-app-id": appId,
              "privy-idempotency-key": intentId,
              "privy-request-expiry": String(expiresAtMs),
            }),
          });
          const source: IntentSource = {
            version: walletIntentPayloadVersions.swap,
            intentId,
            kind: "swap",
            chainId: bscChainId,
            walletId: wallet.walletId,
            from: wallet.address,
            asset: assetSnapshot(quote.sourceAsset),
            amount: quote.snapshot.inputAmount,
            recipient: null,
            spender: null,
            decodedCall: null,
            transaction: null,
            fee: null,
            balance: balance.fact,
            // Privy builds and routes the transaction at execute time, so
            // there is no exact payload for eth_call; the Provider quote is
            // the pre-execution evidence and is labelled as such.
            simulation: Object.freeze({
              status: "passed" as const,
              source: "provider_quote" as const,
              observedAt: quote.snapshot.quotedAt,
              reasonCode: null,
            }),
            policy: canaryPolicyFact(writes, quote.inputValuation),
            swap: Object.freeze({
              destinationAsset: assetSnapshot(quote.destinationAsset),
              quote: quote.snapshot,
              policy: swapPolicy,
              authorizationPayload,
              providerWalletRef: wallet.providerWalletId,
            }),
            signingMode: "privy_authorization_signature",
            factsObservedAt: now.toISOString(),
            expiresAt: new Date(expiresAtMs).toISOString(),
          };
          const sealed = sealIntent(source);
          return runtime.repository.create({
            intentId,
            ownerUserId: principal.userId,
            walletId: wallet.walletId,
            providerOperationId: operationId,
            kind: "swap",
            state: "awaiting_signature",
            chainId: bscChainId,
            canonicalPayload: sealed.canonicalPayload,
            publicReview: sealed.publicReview,
            reviewSha256: sealed.reviewSha256,
            policyConfigVersion: writes.configVersion,
            factsObservedAt: source.factsObservedAt,
            expiresAt: source.expiresAt,
            simulationStatus: "passed",
            requestId,
          });
        },
      );
      return Object.freeze({
        created: outcome.created,
        resource: projectIntent(
          outcome.record,
          runtime.now(),
          null,
          runtime.readClient.confirmations,
        ),
      });
    },

    async execute({ principal, intentId, body, signal }) {
      if (!isOpaqueId(intentId)) {
        throw V2ApiError.invalidRequest();
      }
      if (typeof body !== "object" || body === null) {
        throw V2ApiError.invalidRequest();
      }
      const signature = (body as { readonly authorizationSignature?: unknown })
        .authorizationSignature;
      if (
        typeof signature !== "string" ||
        signature.length === 0 ||
        signature.length > 4_096
      ) {
        throw V2ApiError.invalidRequest();
      }
      const writes = await requireWriteAdmission(runtime);
      const record = await runtime.repository.get(principal.userId, intentId);
      if (record === null) {
        throw V2ApiError.notFound();
      }
      if (record.kind !== "swap") {
        throw V2ApiError.fromCode("VALIDATION_FAILED");
      }
      const requestId = runtime.createUuid();
      if (isElapsed(record, runtime.now())) {
        await runtime.repository.transition({
          ownerUserId: principal.userId,
          intentId,
          expectedVersion: record.recordVersion,
          fromStates: ["prepared", "awaiting_signature"],
          toState: "expired",
          eventType: "intent_expired",
          actorType: "api",
          requestId,
          reasonCode: walletIntentReasonCodes.expired,
        });
        throw V2ApiError.fromCode("QUOTE_EXPIRED");
      }
      if (record.state !== "awaiting_signature") {
        throw record.state === "submitted" || record.state === "unknown"
          ? V2ApiError.fromCode("SUBMISSION_UNKNOWN")
          : V2ApiError.fromCode("DATA_STALE");
      }
      if (record.policyConfigVersion !== writes.configVersion) {
        throw V2ApiError.fromCode("DATA_STALE");
      }
      enforceCanaryCeiling(
        writes,
        record.canonicalPayload.policy.valueUsd ?? "0",
      );
      const swap = record.canonicalPayload.swap;
      if (swap === null || record.providerOperationId === null) {
        throw V2ApiError.fromCode("VALIDATION_FAILED");
      }
      const wallet = await requireSignableWallet(
        runtime,
        principal,
        record.walletId,
      );
      if (wallet.providerWalletId !== swap.providerWalletRef) {
        throw V2ApiError.fromCode("DATA_STALE");
      }

      // Single attempt: the intent moves to `submitted` and the provider
      // operation to `submitting` before any bytes leave the process, so a
      // crash in between can only ever be reconciled, never replayed.
      let submitted: WalletIntentRecord;
      try {
        submitted = await runtime.repository.transition({
          ownerUserId: principal.userId,
          intentId,
          expectedVersion: record.recordVersion,
          fromStates: ["awaiting_signature"],
          toState: "submitted",
          eventType: "provider_attempt_started",
          actorType: "api",
          requestId,
          reasonCode: walletIntentReasonCodes.providerAmbiguous,
          reconcileAfter: new Date(
            runtime.now().getTime() + executeAttemptMs * 6,
          ).toISOString(),
        });
      } catch (error) {
        if (error instanceof WalletIntentStateConflictError) {
          throw V2ApiError.fromCode("SUBMISSION_UNKNOWN");
        }
        throw error;
      }
      let operation: ProviderOperation;
      try {
        operation = await runtime.controlPlane.markProviderOperationSubmitting({
          ownerUserId: principal.userId,
          operationId: record.providerOperationId,
          requestId,
          attemptDurationMs: executeAttemptMs,
        });
      } catch (error) {
        if (error instanceof InvalidProviderOperationStateError) {
          throw V2ApiError.fromCode("SUBMISSION_UNKNOWN");
        }
        throw error;
      }

      let resolved: WalletIntentRecord;
      try {
        const action = await runtime.swapAdapter.execute({
          providerWalletId: wallet.providerWalletId,
          body: swap.authorizationPayload.body,
          authorizationSignature: signature,
          idempotencyKey:
            swap.authorizationPayload.headers["privy-idempotency-key"],
          requestExpiryMs:
            swap.authorizationPayload.headers["privy-request-expiry"],
          signal,
        });
        resolved = await resolveExecuteOutcome(
          principal,
          submitted,
          operation,
          requestId,
          { kind: "accepted", action },
        );
      } catch (error) {
        if (error instanceof PrivySwapProviderError) {
          resolved = await resolveExecuteOutcome(
            principal,
            submitted,
            operation,
            requestId,
            error.kind === "rejected"
              ? {
                  kind: "rejected",
                  reasonCode: walletIntentReasonCodes.privyRejected,
                }
              : {
                  kind: "ambiguous",
                  reasonCode: walletIntentReasonCodes.providerAmbiguous,
                },
          );
        } else {
          resolved = await resolveExecuteOutcome(
            principal,
            submitted,
            operation,
            requestId,
            {
              kind: "ambiguous",
              reasonCode: walletIntentReasonCodes.providerAmbiguous,
            },
          );
        }
      }
      return projectIntent(
        resolved,
        runtime.now(),
        null,
        runtime.readClient.confirmations,
      );
    },
  };
  return Object.freeze(service);
}
