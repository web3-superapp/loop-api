import { z } from "zod";

/**
 * Narrow Privy Swap boundary (Decision 0035): `wallets.swap.quote`,
 * `wallets.swap.execute`, and `wallets.actions.get`.
 *
 * The adapter never builds an authorization signature. The user's device
 * signs the canonical request the backend issued, and the backend forwards
 * that signature together with `privy-idempotency-key` (= intent ID) and
 * `privy-request-expiry` unchanged. Provider response bodies are validated to
 * the fields LOOP uses and are never logged or stored raw.
 */

export interface PrivySwapSide {
  readonly assetAddress: string;
  readonly caip2: string;
}

export interface PrivySwapQuoteRequest {
  readonly providerWalletId: string;
  readonly source: PrivySwapSide;
  readonly destination: PrivySwapSide;
  readonly baseAmount: string;
  readonly slippageBps: number;
  readonly feeBps: number | null;
  readonly signal: AbortSignal;
}

export interface PrivySwapQuote {
  readonly caip2: string;
  readonly inputToken: string;
  readonly outputToken: string;
  readonly inputAmount: string;
  readonly estimatedOutputAmount: string;
  readonly minimumOutputAmount: string;
  readonly gasEstimate: string;
  readonly providerExpiresAt: string | null;
}

export interface PrivySwapExecuteRequest {
  readonly providerWalletId: string;
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
  readonly authorizationSignature: string;
  readonly idempotencyKey: string;
  readonly requestExpiryMs: string;
  readonly signal: AbortSignal;
}

export type PrivyActionStatus = "pending" | "succeeded" | "rejected" | "failed";

export interface PrivySwapAction {
  readonly actionId: string;
  readonly status: PrivyActionStatus;
  readonly inputAmount: string | null;
  readonly outputAmount: string | null;
  readonly steps: readonly {
    readonly status: string;
    readonly transactionHash: string | null;
  }[];
  readonly failureReasonCode: string | null;
}

export interface PrivySwapAdapter {
  quote(request: PrivySwapQuoteRequest): Promise<PrivySwapQuote>;
  execute(request: PrivySwapExecuteRequest): Promise<PrivySwapAction>;
  getAction(input: {
    readonly providerWalletId: string;
    readonly actionId: string;
    readonly signal: AbortSignal;
  }): Promise<PrivySwapAction>;
}

export type PrivySwapFailureKind = "rejected" | "ambiguous" | "unavailable";

/**
 * `rejected`: the Provider answered with a definitive 4xx before executing.
 * `ambiguous`: the request may have reached the Provider (timeout, 5xx, 429,
 * disconnect); the caller must treat the result as unknown and never retry.
 * `unavailable`: no credentials or no client; nothing was sent.
 */
export class PrivySwapProviderError extends Error {
  readonly code = "privy_swap_provider_error";

  constructor(
    readonly kind: PrivySwapFailureKind,
    readonly reasonCode: string,
  ) {
    super("The Privy Swap request did not complete");
    this.name = "PrivySwapProviderError";
  }
}

/** Structural mirror of the SDK's swap request parameters. */
export interface PrivySwapRequestParams {
  readonly base_amount: string;
  readonly destination: {
    readonly asset_address: string;
    readonly caip2?: string;
  };
  readonly source: { readonly asset_address: string; readonly caip2: string };
  readonly amount_type?: "exact_input" | "exact_output";
  readonly slippage_bps?: number;
  readonly fee_configuration?: {
    readonly type: "total_fee_bps";
    readonly value: number;
  };
  readonly "privy-authorization-signature"?: string;
  readonly "privy-idempotency-key"?: string;
  readonly "privy-request-expiry"?: string;
}

interface PrivyRequestOptions {
  readonly signal: AbortSignal;
  readonly timeout: number;
  readonly maxRetries: 0;
}

/** The SDK surface this adapter needs; `PrivyClient.wallets()` satisfies it. */
export interface PrivySwapClient {
  readonly swap: {
    quote(
      walletId: string,
      params: PrivySwapRequestParams,
      options: PrivyRequestOptions,
    ): Promise<unknown>;
    execute(
      walletId: string,
      params: PrivySwapRequestParams,
      options: PrivyRequestOptions,
    ): Promise<unknown>;
  };
  readonly actions: {
    get(
      actionId: string,
      params: { readonly wallet_id: string; readonly include: "steps" },
      options: PrivyRequestOptions,
    ): Promise<unknown>;
  };
}

const rawAmount = z.string().regex(/^[0-9]+$/);

const quoteResponseSchema = z.object({
  caip2: z.string().min(1),
  input_token: z.string().min(1),
  output_token: z.string().min(1),
  input_amount: rawAmount,
  est_output_amount: rawAmount,
  minimum_output_amount: rawAmount,
  gas_estimate: rawAmount,
  expires_at: z.number().int().positive().optional(),
});

const actionResponseSchema = z.object({
  id: z.string().min(1).max(128),
  status: z.enum(["pending", "succeeded", "rejected", "failed"]),
  input_amount: rawAmount.nullable().optional(),
  output_amount: rawAmount.nullable().optional(),
  failure_reason: z.object({ message: z.string() }).optional(),
  steps: z
    .array(
      z.object({
        status: z.string(),
        transaction_hash: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

const quoteTimeoutMs = 8_000;
const executeTimeoutMs = 10_000;
const statusTimeoutMs = 6_000;

function statusOf(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return null;
}

/**
 * Anything that is not a definitive 4xx is ambiguous. A 408 or 429 may have
 * been raised after the Provider accepted the body, so they are ambiguous too.
 */
export function classifyPrivyFailure(error: unknown): PrivySwapFailureKind {
  const status = statusOf(error);
  if (status !== null && status >= 400 && status < 500) {
    return status === 408 || status === 429 ? "ambiguous" : "rejected";
  }
  return "ambiguous";
}

/**
 * A 401/403 is the Provider refusing the app itself (missing credential or a
 * capability that is not enabled for the app, e.g. "Swaps are not enabled for
 * this app"), not a refusal of the caller's input. It is a configuration fact
 * and fails closed as a capability, never as a validation error (Decision
 * 0065).
 */
export function isProviderAuthorizationRefusal(error: unknown): boolean {
  const status = statusOf(error);
  return status === 401 || status === 403;
}

/** Bounded, non-sensitive projection of a Provider failure message. */
function failureReasonCode(message: string | undefined): string | null {
  if (message === undefined) {
    return null;
  }
  const normalized = message
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 63);
  return normalized.length === 0 || !/^[A-Z]/.test(normalized)
    ? "PRIVY_FAILURE"
    : `PRIVY_${normalized}`.slice(0, 64).replace(/_+$/, "");
}

function mapAction(response: unknown): PrivySwapAction {
  const parsed = actionResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new PrivySwapProviderError(
      "ambiguous",
      "PRIVY_SWAP_RESPONSE_MALFORMED",
    );
  }
  return Object.freeze({
    actionId: parsed.data.id,
    status: parsed.data.status,
    inputAmount: parsed.data.input_amount ?? null,
    outputAmount: parsed.data.output_amount ?? null,
    steps: Object.freeze(
      (parsed.data.steps ?? []).map((step) =>
        Object.freeze({
          status: step.status,
          transactionHash:
            typeof step.transaction_hash === "string" &&
            /^0x[0-9a-fA-F]{64}$/.test(step.transaction_hash)
              ? step.transaction_hash.toLowerCase()
              : null,
        }),
      ),
    ),
    failureReasonCode: failureReasonCode(parsed.data.failure_reason?.message),
  });
}

export function createPrivySwapAdapter(
  client: PrivySwapClient,
  options: { readonly now?: () => Date } = {},
): PrivySwapAdapter {
  const now = options.now ?? ((): Date => new Date());
  return Object.freeze({
    async quote(request: PrivySwapQuoteRequest): Promise<PrivySwapQuote> {
      let response: unknown;
      try {
        response = await client.swap.quote(
          request.providerWalletId,
          {
            base_amount: request.baseAmount,
            source: {
              asset_address: request.source.assetAddress,
              caip2: request.source.caip2,
            },
            destination: {
              asset_address: request.destination.assetAddress,
              caip2: request.destination.caip2,
            },
            amount_type: "exact_input",
            slippage_bps: request.slippageBps,
            ...(request.feeBps === null
              ? {}
              : {
                  fee_configuration: {
                    type: "total_fee_bps",
                    value: request.feeBps,
                  },
                }),
          },
          { signal: request.signal, timeout: quoteTimeoutMs, maxRetries: 0 },
        );
      } catch (error) {
        if (isProviderAuthorizationRefusal(error)) {
          throw new PrivySwapProviderError(
            "unavailable",
            "PRIVY_SWAP_NOT_AUTHORIZED",
          );
        }
        throw new PrivySwapProviderError(
          classifyPrivyFailure(error) === "rejected"
            ? "rejected"
            : "unavailable",
          classifyPrivyFailure(error) === "rejected"
            ? "PRIVY_SWAP_QUOTE_REJECTED"
            : "PRIVY_SWAP_QUOTE_UNAVAILABLE",
        );
      }
      const parsed = quoteResponseSchema.safeParse(response);
      if (!parsed.success) {
        throw new PrivySwapProviderError(
          "unavailable",
          "PRIVY_SWAP_RESPONSE_MALFORMED",
        );
      }
      return Object.freeze({
        caip2: parsed.data.caip2,
        inputToken: parsed.data.input_token.toLowerCase(),
        outputToken: parsed.data.output_token.toLowerCase(),
        inputAmount: parsed.data.input_amount,
        estimatedOutputAmount: parsed.data.est_output_amount,
        minimumOutputAmount: parsed.data.minimum_output_amount,
        gasEstimate: parsed.data.gas_estimate,
        providerExpiresAt:
          parsed.data.expires_at === undefined
            ? null
            : new Date(parsed.data.expires_at * 1000).toISOString(),
      });
    },

    async execute(request: PrivySwapExecuteRequest): Promise<PrivySwapAction> {
      if (Number(request.requestExpiryMs) <= now().getTime()) {
        throw new PrivySwapProviderError("rejected", "PRIVY_REQUEST_EXPIRED");
      }
      let response: unknown;
      try {
        response = await client.swap.execute(
          request.providerWalletId,
          {
            ...request.body,
            "privy-authorization-signature": request.authorizationSignature,
            "privy-idempotency-key": request.idempotencyKey,
            "privy-request-expiry": request.requestExpiryMs,
          },
          { signal: request.signal, timeout: executeTimeoutMs, maxRetries: 0 },
        );
      } catch (error) {
        const kind = classifyPrivyFailure(error);
        throw new PrivySwapProviderError(
          kind,
          kind === "rejected"
            ? "PRIVY_SWAP_REJECTED"
            : "PRIVY_SWAP_RESULT_AMBIGUOUS",
        );
      }
      return mapAction(response);
    },

    async getAction(input: {
      readonly providerWalletId: string;
      readonly actionId: string;
      readonly signal: AbortSignal;
    }): Promise<PrivySwapAction> {
      let response: unknown;
      try {
        response = await client.actions.get(
          input.actionId,
          { wallet_id: input.providerWalletId, include: "steps" },
          { signal: input.signal, timeout: statusTimeoutMs, maxRetries: 0 },
        );
      } catch (error) {
        throw new PrivySwapProviderError(
          classifyPrivyFailure(error) === "rejected"
            ? "rejected"
            : "unavailable",
          "PRIVY_ACTION_STATUS_UNAVAILABLE",
        );
      }
      return mapAction(response);
    },
  });
}

export function createUnavailablePrivySwapAdapter(): PrivySwapAdapter {
  const reject = (): Promise<never> =>
    Promise.reject(
      new PrivySwapProviderError("unavailable", "PRIVY_NOT_CONFIGURED"),
    );
  return Object.freeze({ quote: reject, execute: reject, getAction: reject });
}
