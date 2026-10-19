import { createHash } from "node:crypto";

import type { MarketFactCacheRepository } from "../../database/market-fact-cache-repository.js";
import type {
  TokenLogoCacheAutomaticRecord,
  TokenLogoCacheRecord,
  TokenLogoCacheRepository,
  TokenLogoContentType,
} from "../../database/token-logo-cache-repository.js";
import type { TokenPairsSnapshot } from "../../integrations/market/market-data-provider.js";
import {
  marketFactKinds,
  selectPrimaryPair,
  tokenPairsBatchSubjectPrefix,
} from "./market-fact-service.js";
import {
  normalizeTokenLogo,
  tokenLogoNormalizedContentType,
  type TokenLogoNormalizer,
} from "./token-logo-normalize.js";
import {
  acceptTokenLogoUrl,
  providerImageUrlFromPairs,
  trustWalletUpstreamLogoUrl,
  type TokenLogoSource,
} from "./token-logo.js";
import { bscChainId } from "../chain/chain-contract.js";

/**
 * The token logo proxy (Decisions 0089, 0161).
 *
 * Mainland-China clients cannot reach raw.githubusercontent.com (tester
 * network check, 2026-09-28), so every logo URL a client is given points at
 * this API. The proxy picks the picture by the Decision 0072 origin rules —
 * the DexScreener image already cached with the token's pair fact first
 * (BSC only), then the Trust Wallet rule URL of the chain — fetches it once,
 * re-encodes it into a 128 x 128 WebP (Decision 0161 §1) and keeps it in
 * `token_logo_cache`:
 *
 * | upstream answer                            | row                        | route |
 * | ------------------------------------------ | -------------------------- | ----- |
 * | a raster image (<= 4 MiB) that decodes     | `found` (WebP), 7 days     | 200   |
 * | larger than 4 MiB                          | `oversize`, 24 h, no bytes | 404   |
 * | every origin "no such file" / undecodable  | `missing`, 24 h            | 404   |
 * | timeout / network / 5xx / 408 / 429        | nothing written            | 502   |
 *
 * A `found` row past its 7 days is refetched; if that refetch fails the old
 * bytes are still served. A row is also refetched early when the
 * highest-priority origin changed (a Provider image appeared after the Trust
 * Wallet file was cached), and when it predates normalisation (any type but
 * WebP). A picture served from a lower origin because a higher one failed is
 * served but not stored, and the CDN may keep it for five minutes only.
 *
 * Decision 0161 §3: a `manual` row (an operator's upload) is always served
 * and never refetched or overwritten by the proxy.
 *
 * `warm` is the pre-warm entry (Decision 0161 §2): the same fetch and store
 * rules, refreshing a row a day before it expires, reporting what it did
 * instead of returning the bytes.
 *
 * Upstream requests: only allow-listed hosts (0072 gate), redirects followed
 * by hand and re-gated at every hop (at most three), 5 s per origin, the
 * process-wide keep-alive dispatcher of Decision 0088 (global `fetch`),
 * one in-flight resolution per token shared by concurrent requests, and at
 * most eight resolutions fetching at once.
 */

/** Largest upstream body read; a larger picture is not decoded (0161 §1). */
export const tokenLogoMaximumUpstreamBytes = 4 * 1024 * 1024;
export const tokenLogoUpstreamTimeoutMs = 5_000;
export const tokenLogoFoundTtlMs = 7 * 24 * 60 * 60 * 1_000;
export const tokenLogoMissingTtlMs = 24 * 60 * 60 * 1_000;
export const tokenLogoOversizeTtlMs = 24 * 60 * 60 * 1_000;
/** Pre-warm refreshes a row this long before it expires (0161 §2). */
export const tokenLogoWarmRefreshAheadMs = 24 * 60 * 60 * 1_000;
export const tokenLogoUpstreamConcurrency = 8;
export const tokenLogoMaximumRedirects = 3;

export type TokenLogoProxyResult =
  | Readonly<{
      kind: "image";
      bytes: Buffer;
      contentType: TokenLogoContentType;
      etag: string;
      /** `false` when a higher-priority origin failed: short CDN lifetime. */
      durable: boolean;
    }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unreachable" }>;

/**
 * What one pre-warm of a token did (Decision 0161 §2):
 * `fresh` nothing to do; `manual` an operator picture, never refetched;
 * `stored` a picture fetched and stored; `missing` no origin has one (24 h
 * marker); `kept` the refetch failed and the stored picture stays;
 * `failed` the refetch failed and nothing is stored; `degraded` only a
 * lower origin answered (served on demand, not stored);
 * `unsupported` the chain has no origin.
 */
export type TokenLogoWarmOutcome =
  | "fresh"
  | "manual"
  | "stored"
  | "missing"
  | "kept"
  | "failed"
  | "degraded"
  | "unsupported";

export interface TokenLogoProxyService {
  /** `address` is a lowercase `0x` address, or `null` for the native coin. */
  resolve(input: {
    readonly chainId: string;
    readonly address: string | null;
  }): Promise<TokenLogoProxyResult>;
  /**
   * Fetches and stores the token's picture when its row is absent, due
   * within a day, stale by origin or format; `state` is the row already
   * read by the caller (bytes not needed), `undefined` to read it here.
   */
  warm(input: {
    readonly chainId: string;
    readonly address: string | null;
    readonly state?: TokenLogoCacheRecord | null;
  }): Promise<TokenLogoWarmOutcome>;
}

export interface TokenLogoProxyLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface CreateTokenLogoProxyServiceInput {
  /** `null` when no database is composed: pictures are served, not stored. */
  readonly cache: TokenLogoCacheRepository | null;
  /** The market fact cache the Provider image is read from; `null` skips it. */
  readonly facts: Pick<MarketFactCacheRepository, "getMany"> | null;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly upstreamTimeoutMs?: number;
  /** Test seam; defaults to the sharp 128 x 128 WebP normaliser. */
  readonly normalize?: TokenLogoNormalizer;
  readonly logger?: TokenLogoProxyLogger;
}

interface Candidate {
  readonly source: TokenLogoSource;
  readonly url: string;
}

type UpstreamOutcome =
  | Readonly<{
      kind: "image";
      bytes: Buffer;
      url: string;
    }>
  | Readonly<{ kind: "oversize"; url: string }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "failed" }>;

type OriginsOutcome =
  | Readonly<{
      kind: "image";
      bytes: Buffer;
      url: string;
      source: TokenLogoSource;
      degraded: boolean;
    }>
  | Readonly<{
      kind: "oversize";
      url: string;
      source: TokenLogoSource;
      degraded: boolean;
    }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "failed" }>;

const redirectStatuses: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/**
 * The raster type of `bytes` from its signature, or `null`. The upstream's
 * `Content-Type` is not trusted: only PNG, JPEG, GIF and WebP are served,
 * never SVG or anything a browser could execute.
 */
export function sniffTokenLogoContentType(
  bytes: Buffer,
): TokenLogoContentType | null {
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") {
      return "image/gif";
    }
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Strong ETag: the SHA-256 of the bytes, base64url, quoted. */
export function tokenLogoEtag(bytes: Buffer): string {
  return `"${createHash("sha256").update(bytes).digest("base64url")}"`;
}

/** Whether an `If-None-Match` header value matches `etag` (weak comparison). */
export function ifNoneMatchSatisfied(
  header: string | undefined,
  etag: string,
): boolean {
  if (header === undefined) {
    return false;
  }
  const bare = etag.replace(/^W\//, "");
  return header
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value.replace(/^W\//, "") === bare);
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

/** The body, or `null` once it passes `limit` bytes (the read is cancelled). */
async function readLimited(
  response: Response,
  limit: number,
): Promise<Buffer | null> {
  const body = response.body;
  if (body === null) {
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  // Leaving the loop early cancels the stream (async iterator `return`).
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) {
      return null;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      // A finishing task hands its slot straight to the next waiter.
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = queue.shift();
      if (next === undefined) {
        active -= 1;
      } else {
        next();
      }
    }
  };
}

export function createTokenLogoProxyService(
  input: CreateTokenLogoProxyServiceInput,
): TokenLogoProxyService {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const now = input.now ?? ((): Date => new Date());
  const timeoutMs = input.upstreamTimeoutMs ?? tokenLogoUpstreamTimeoutMs;
  const normalize = input.normalize ?? normalizeTokenLogo;
  const limit = createLimiter(tokenLogoUpstreamConcurrency);
  const inFlight = new Map<string, Promise<unknown>>();

  function warn(fields: Record<string, unknown>, message: string): void {
    input.logger?.warn(fields, message);
  }

  /** The Provider image already cached with the token's pair fact, if any. */
  async function providerImageUrl(address: string): Promise<string | null> {
    if (input.facts === null) {
      return null;
    }
    const singleKey = `token:${address}`;
    const batchKey = `${tokenPairsBatchSubjectPrefix}${address}`;
    let rows;
    try {
      rows = await input.facts.getMany(
        [singleKey, batchKey],
        marketFactKinds.tokenPairs,
        "dexscreener",
      );
    } catch {
      return null;
    }
    for (const key of [singleKey, batchKey]) {
      const value = rows.get(key)?.value as TokenPairsSnapshot | undefined;
      if (value === undefined || !Array.isArray(value.pairs)) {
        continue;
      }
      try {
        const url = providerImageUrlFromPairs({
          tokenAddress: address,
          pairs: value.pairs,
          preferredPair: selectPrimaryPair({
            tokenAddress: address,
            pairs: value.pairs,
          }),
        });
        if (url !== null) {
          return url;
        }
      } catch {
        // A malformed cached row names no picture.
      }
    }
    return null;
  }

  async function candidates(
    chainId: string,
    address: string | null,
  ): Promise<readonly Candidate[]> {
    const list: Candidate[] = [];
    // The pair facts are DexScreener BSC facts keyed by address alone: they
    // describe nothing on another chain.
    if (address !== null && chainId === bscChainId) {
      const provider = await providerImageUrl(address);
      if (provider !== null) {
        list.push({ source: "dexscreener", url: provider });
      }
    }
    const rule = trustWalletUpstreamLogoUrl(chainId, address);
    const gated = acceptTokenLogoUrl(rule);
    if (gated !== null) {
      list.push({ source: "trustwallet", url: gated });
    }
    return list;
  }

  async function fetchOne(url: string): Promise<UpstreamOutcome> {
    const signal = AbortSignal.timeout(timeoutMs);
    let current = url;
    try {
      for (let hop = 0; hop <= tokenLogoMaximumRedirects; hop += 1) {
        const response = await fetchImpl(current, {
          redirect: "manual",
          signal,
          headers: {
            accept: "image/png,image/jpeg,image/gif,image/webp",
          },
        });
        if (redirectStatuses.has(response.status)) {
          const location = response.headers.get("location");
          await discard(response);
          if (location === null) {
            return { kind: "missing" };
          }
          let next: string | null;
          try {
            next = acceptTokenLogoUrl(new URL(location, current).href);
          } catch {
            next = null;
          }
          if (next === null) {
            // A redirect off the allow-list is not followed (SSRF gate).
            return { kind: "missing" };
          }
          current = next;
          continue;
        }
        if (response.status === 200) {
          const declared = Number(response.headers.get("content-length"));
          if (
            Number.isFinite(declared) &&
            declared > tokenLogoMaximumUpstreamBytes
          ) {
            await discard(response);
            return { kind: "oversize", url: current };
          }
          const bytes = await readLimited(
            response,
            tokenLogoMaximumUpstreamBytes,
          );
          if (bytes === null) {
            return { kind: "oversize", url: current };
          }
          // Only a sniffed raster type reaches the decoder (never SVG).
          if (sniffTokenLogoContentType(bytes) === null) {
            return { kind: "missing" };
          }
          return { kind: "image", bytes, url: current };
        }
        await discard(response);
        if (
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500
        ) {
          return { kind: "failed" };
        }
        if (response.status >= 400) {
          return { kind: "missing" };
        }
        return { kind: "failed" };
      }
      return { kind: "failed" };
    } catch {
      return { kind: "failed" };
    }
  }

  async function fetchOrigins(
    list: readonly Candidate[],
  ): Promise<OriginsOutcome> {
    let degraded = false;
    for (const candidate of list) {
      const outcome = await fetchOne(candidate.url);
      if (outcome.kind === "image") {
        const normalized = await normalize(outcome.bytes);
        if (normalized === null) {
          // Undecodable bytes are "no picture" at this origin.
          warn(
            {
              source: candidate.source,
              reasonCode: "TOKEN_LOGO_DECODE_FAILED",
            },
            "Token logo upstream picture could not be decoded",
          );
          continue;
        }
        return {
          kind: "image",
          bytes: normalized,
          url: outcome.url,
          source: candidate.source,
          degraded,
        };
      }
      if (outcome.kind === "oversize") {
        return { ...outcome, source: candidate.source, degraded };
      }
      if (outcome.kind === "failed") {
        degraded = true;
        warn(
          {
            source: candidate.source,
            reasonCode: "TOKEN_LOGO_UPSTREAM_FAILED",
          },
          "Token logo upstream failed",
        );
      }
    }
    return degraded ? { kind: "failed" } : { kind: "missing" };
  }

  async function store(record: TokenLogoCacheAutomaticRecord): Promise<void> {
    if (input.cache === null) {
      return;
    }
    try {
      await input.cache.put(record);
    } catch {
      warn(
        { reasonCode: "TOKEN_LOGO_CACHE_WRITE_FAILED" },
        "Token logo cache write failed",
      );
    }
  }

  async function readRow(
    chainId: string,
    key: string,
  ): Promise<TokenLogoCacheRecord | null> {
    if (input.cache === null) {
      return null;
    }
    try {
      return await input.cache.get(chainId, key);
    } catch {
      warn(
        { reasonCode: "TOKEN_LOGO_CACHE_READ_FAILED" },
        "Token logo cache read failed",
      );
      return null;
    }
  }

  function fromRow(row: TokenLogoCacheRecord): TokenLogoProxyResult {
    if (
      row.status === "found" &&
      row.bytes !== null &&
      row.contentType !== null &&
      row.etag !== null
    ) {
      return {
        kind: "image",
        bytes: row.bytes,
        contentType: row.contentType,
        etag: row.etag,
        durable: true,
      };
    }
    // `missing`, and `oversize` (no 302 since Decision 0161).
    return { kind: "missing" };
  }

  function isManual(row: TokenLogoCacheRecord | null): boolean {
    return row !== null && row.source === "manual" && row.status === "found";
  }

  /** Whether `row` may be served without asking the upstreams. */
  function isCurrent(
    row: TokenLogoCacheRecord | null,
    top: Candidate,
    nowMs: number,
    aheadMs: number,
  ): boolean {
    if (row === null || row.candidateUrl !== top.url) {
      return false;
    }
    // A picture stored before normalisation is refetched (Decision 0161).
    if (
      row.status === "found" &&
      row.contentType !== tokenLogoNormalizedContentType
    ) {
      return false;
    }
    return Date.parse(row.expiresAt) - aheadMs > nowMs;
  }

  type Refreshed = Readonly<{
    result: TokenLogoProxyResult;
    warm: TokenLogoWarmOutcome;
  }>;

  async function refresh(
    chainId: string,
    key: string,
    list: readonly Candidate[],
    row: TokenLogoCacheRecord | null,
  ): Promise<Refreshed> {
    const top = list[0];
    if (top === undefined) {
      return { result: { kind: "missing" }, warm: "unsupported" };
    }
    const outcome = await limit(() => fetchOrigins(list));
    const nowMs = now().getTime();
    const fetchedAt = new Date(nowMs).toISOString();
    const expires = (ttl: number) => new Date(nowMs + ttl).toISOString();
    switch (outcome.kind) {
      case "failed":
        // Never cached; an older picture is better than none.
        if (row?.status === "found" && row.bytes !== null) {
          return { result: fromRow(row), warm: "kept" };
        }
        return {
          result: { kind: "unreachable" },
          warm: row?.status === "found" ? "kept" : "failed",
        };
      case "missing":
        await store({
          chainId,
          address: key,
          status: "missing",
          bytes: null,
          contentType: null,
          etag: null,
          source: null,
          sourceUrl: null,
          candidateUrl: top.url,
          fetchedAt,
          expiresAt: expires(tokenLogoMissingTtlMs),
        });
        return { result: { kind: "missing" }, warm: "missing" };
      case "oversize":
        if (!outcome.degraded) {
          await store({
            chainId,
            address: key,
            status: "oversize",
            bytes: null,
            contentType: null,
            etag: null,
            source: outcome.source,
            sourceUrl: outcome.url,
            candidateUrl: top.url,
            fetchedAt,
            expiresAt: expires(tokenLogoOversizeTtlMs),
          });
        }
        warn(
          {
            source: outcome.source,
            reasonCode: "TOKEN_LOGO_UPSTREAM_TOO_LARGE",
          },
          "Token logo upstream picture exceeds the read limit",
        );
        return {
          result: { kind: "missing" },
          warm: outcome.degraded ? "degraded" : "missing",
        };
      case "image": {
        const etag = tokenLogoEtag(outcome.bytes);
        if (!outcome.degraded) {
          await store({
            chainId,
            address: key,
            status: "found",
            bytes: outcome.bytes,
            contentType: tokenLogoNormalizedContentType,
            etag,
            source: outcome.source,
            sourceUrl: outcome.url,
            candidateUrl: top.url,
            fetchedAt,
            expiresAt: expires(tokenLogoFoundTtlMs),
          });
        }
        return {
          result: {
            kind: "image",
            bytes: outcome.bytes,
            contentType: tokenLogoNormalizedContentType,
            etag,
            durable: !outcome.degraded,
          },
          warm: outcome.degraded ? "degraded" : "stored",
        };
      }
    }
  }

  async function resolveUncached(
    chainId: string,
    address: string | null,
  ): Promise<TokenLogoProxyResult> {
    const key = address ?? "native";
    const row = await readRow(chainId, key);
    if (isManual(row) && row !== null) {
      return fromRow(row);
    }
    const list = await candidates(chainId, address);
    const top = list[0];
    if (top === undefined) {
      return { kind: "missing" };
    }
    if (isCurrent(row, top, now().getTime(), 0) && row !== null) {
      return fromRow(row);
    }
    return (await refresh(chainId, key, list, row)).result;
  }

  async function warmUncached(
    chainId: string,
    address: string | null,
    state: TokenLogoCacheRecord | null | undefined,
  ): Promise<TokenLogoWarmOutcome> {
    const key = address ?? "native";
    const known = state === undefined ? await readRow(chainId, key) : state;
    if (isManual(known)) {
      return "manual";
    }
    const list = await candidates(chainId, address);
    const top = list[0];
    if (top === undefined) {
      return "unsupported";
    }
    if (isCurrent(known, top, now().getTime(), tokenLogoWarmRefreshAheadMs)) {
      return "fresh";
    }
    // Due: the bytes of the stored row are needed only to keep serving them
    // when the refetch fails, which `refresh` reports as `kept` either way.
    return (await refresh(chainId, key, list, known)).warm;
  }

  function shared<T>(key: string, task: () => Promise<T>): Promise<T> {
    const pending = inFlight.get(key);
    if (pending !== undefined) {
      return pending as Promise<T>;
    }
    const tracked = task().finally(() => {
      if (inFlight.get(key) === tracked) {
        inFlight.delete(key);
      }
    });
    inFlight.set(key, tracked);
    return tracked;
  }

  return Object.freeze({
    resolve({
      chainId,
      address,
    }: {
      readonly chainId: string;
      readonly address: string | null;
    }): Promise<TokenLogoProxyResult> {
      return shared(`resolve:${chainId}/${address ?? "native"}`, () =>
        resolveUncached(chainId, address),
      );
    },
    warm({
      chainId,
      address,
      state,
    }: {
      readonly chainId: string;
      readonly address: string | null;
      readonly state?: TokenLogoCacheRecord | null;
    }): Promise<TokenLogoWarmOutcome> {
      return shared(`warm:${chainId}/${address ?? "native"}`, () =>
        warmUncached(chainId, address, state),
      );
    },
  });
}
