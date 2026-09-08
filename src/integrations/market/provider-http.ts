import { createHash } from "node:crypto";

import { parse as parseLossless } from "lossless-json";

import { MarketProviderError } from "./market-data-provider.js";

/**
 * Shared transport kernel for the market adapters.
 *
 * - `fetch` is injected so tests never touch the network.
 * - Every request goes through a per-Provider sliding-window throttle sized to
 *   the Provider's published limit; when the window is exhausted the request
 *   is refused locally with `market_provider_rate_limited` instead of being
 *   sent, so LOOP never exceeds the documented allowance.
 * - The raw body is parsed with a lossless JSON parser in which every JSON
 *   number stays a digit string, and its SHA-256 digest is returned for the
 *   fact-cache audit trail. The body itself is never logged or stored.
 */

export type ProviderFetch = (
  input: string,
  init: {
    readonly method: "GET" | "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface RateLimiter {
  /** Returns true and records the request when the window has room. */
  tryAcquire(): boolean;
  readonly capacityPerMinute: number;
}

export function createRateLimiter(input: {
  readonly capacityPerMinute: number;
  readonly now?: () => number;
}): RateLimiter {
  const now = input.now ?? ((): number => Date.now());
  const windowMs = 60_000;
  const stamps: number[] = [];
  return Object.freeze({
    capacityPerMinute: input.capacityPerMinute,
    tryAcquire(): boolean {
      const current = now();
      while (
        stamps.length > 0 &&
        current - (stamps[0] ?? current) >= windowMs
      ) {
        stamps.shift();
      }
      if (stamps.length >= input.capacityPerMinute) {
        return false;
      }
      stamps.push(current);
      return true;
    },
  });
}

export interface ProviderHttpKernel {
  requestJson(input: {
    readonly url: string;
    readonly method?: "GET" | "POST";
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly json: unknown; readonly rawDigest: string }>;
}

export interface CreateProviderHttpKernelInput {
  readonly fetch: ProviderFetch;
  readonly rateLimiter: RateLimiter;
  readonly timeoutMs?: number;
  readonly maximumBodyBytes?: number;
}

const defaultTimeoutMs = 8_000;
const defaultMaximumBodyBytes = 2_000_000;

function combineSignals(
  timeoutMs: number,
  external: AbortSignal | undefined,
): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const clear = (): void => {
    clearTimeout(timer);
  };
  controller.signal.addEventListener("abort", clear, { once: true });
  if (external !== undefined) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener(
        "abort",
        () => {
          controller.abort();
        },
        { once: true },
      );
    }
  }
  return controller.signal;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Lossless parse: JSON numbers stay as their exact digit strings. */
export function parseJsonLossless(text: string): unknown {
  return parseLossless(text, null, (value: string): unknown => value);
}

export function createProviderHttpKernel(
  input: CreateProviderHttpKernelInput,
): ProviderHttpKernel {
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  const maximumBodyBytes = input.maximumBodyBytes ?? defaultMaximumBodyBytes;
  return Object.freeze({
    async requestJson(request: {
      readonly url: string;
      readonly method?: "GET" | "POST";
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
      readonly signal?: AbortSignal;
    }) {
      if (!input.rateLimiter.tryAcquire()) {
        throw new MarketProviderError(
          "market_provider_rate_limited",
          "MARKET_PROVIDER_RATE_LIMITED",
        );
      }
      let response;
      try {
        response = await input.fetch(request.url, {
          method: request.method ?? "GET",
          headers: {
            accept: "application/json",
            ...(request.headers ?? {}),
          },
          ...(request.body === undefined ? {} : { body: request.body }),
          signal: combineSignals(timeoutMs, request.signal),
        });
      } catch {
        throw new MarketProviderError(
          "market_provider_unreachable",
          "MARKET_PROVIDER_UNREACHABLE",
        );
      }
      if (response.status === 429) {
        throw new MarketProviderError(
          "market_provider_rate_limited",
          "MARKET_PROVIDER_RATE_LIMITED",
        );
      }
      if (!response.ok) {
        throw new MarketProviderError(
          "market_provider_rejected",
          "MARKET_PROVIDER_REQUEST_REJECTED",
          response.status,
        );
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new MarketProviderError(
          "market_provider_unreachable",
          "MARKET_PROVIDER_UNREACHABLE",
        );
      }
      if (Buffer.byteLength(text, "utf8") > maximumBodyBytes) {
        throw new MarketProviderError(
          "market_provider_malformed",
          "MARKET_PROVIDER_RESPONSE_MALFORMED",
        );
      }
      let json: unknown;
      try {
        json = parseJsonLossless(text);
      } catch {
        throw new MarketProviderError(
          "market_provider_malformed",
          "MARKET_PROVIDER_RESPONSE_MALFORMED",
        );
      }
      return Object.freeze({ json, rawDigest: sha256Hex(text) });
    },
  });
}

export function malformed(): never {
  throw new MarketProviderError(
    "market_provider_malformed",
    "MARKET_PROVIDER_RESPONSE_MALFORMED",
  );
}

/** Default transport: Node's built-in fetch. */
export const nodeProviderFetch: ProviderFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    signal: init.signal,
    redirect: "error",
  });
  return response;
};
