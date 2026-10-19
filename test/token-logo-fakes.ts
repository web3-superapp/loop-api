import sharp from "sharp";
import { vi, type Mock } from "vitest";

import type {
  MarketFactCacheRecord,
  MarketFactCacheRepository,
} from "../src/database/market-fact-cache-repository.js";
import type {
  TokenLogoCacheRecord,
  TokenLogoCacheRepository,
} from "../src/database/token-logo-cache-repository.js";

/** Test doubles for the token logo proxy (Decision 0089). */

export const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
export const wbnbChecksum = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const trustWalletWbnb = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/${wbnbChecksum}/logo.png`;
export const trustWalletNative =
  "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/info/logo.png";
export const dexscreenerWbnb = `https://dd.dexscreener.com/ds-data/tokens/bsc/${wbnb}.png`;

/** A minimal valid PNG signature followed by `size - 8` filler bytes. */
export function png(size = 64, fill = 1): Buffer {
  const bytes = Buffer.alloc(size, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
}

/**
 * Decision 0161 test normaliser: a recognisable stand-in for the sharp
 * re-encode (the real one is covered by `token-logo-normalize.test.ts`).
 * Empty input and the literal `UNDECODABLE` body are "cannot decode".
 */
export function fakeNormalize(input: Buffer): Promise<Buffer | null> {
  if (input.length === 0 || input.includes(Buffer.from("UNDECODABLE"))) {
    return Promise.resolve(null);
  }
  return Promise.resolve(Buffer.concat([Buffer.from("WEBP:"), input]));
}

/** What `fakeNormalize` stores for `input`. */
export function normalized(input: Buffer): Buffer {
  return Buffer.concat([Buffer.from("WEBP:"), input]);
}

/**
 * A real, decodable PNG (Decision 0161: the proxy re-encodes what it
 * fetches, so route and integration tests need actual pictures).
 */
export function logoPng(
  options: {
    readonly width?: number;
    readonly height?: number;
    readonly red?: number;
    readonly alpha?: number;
  } = {},
): Promise<Buffer> {
  return sharp({
    create: {
      width: options.width ?? 64,
      height: options.height ?? 64,
      channels: 4,
      background: {
        r: options.red ?? 240,
        g: 185,
        b: 11,
        alpha: options.alpha ?? 1,
      },
    },
  })
    .png()
    .toBuffer();
}

export function memoryLogoCache(): {
  readonly rows: Map<string, TokenLogoCacheRecord>;
  readonly get: Mock<TokenLogoCacheRepository["get"]>;
  readonly put: Mock<TokenLogoCacheRepository["put"]>;
  readonly listStates: Mock<
    NonNullable<TokenLogoCacheRepository["listStates"]>
  >;
} {
  const rows = new Map<string, TokenLogoCacheRecord>();
  const get = vi.fn<TokenLogoCacheRepository["get"]>((chainId, address) =>
    Promise.resolve(rows.get(`${chainId}/${address}`) ?? null),
  );
  // Mirrors the repository's guard: an automatic write never replaces a
  // manual row (Decision 0161).
  const put = vi.fn<TokenLogoCacheRepository["put"]>((record) => {
    const key = `${record.chainId}/${record.address}`;
    if (rows.get(key)?.source !== "manual") {
      rows.set(key, record);
    }
    return Promise.resolve();
  });
  const listStates = vi.fn<NonNullable<TokenLogoCacheRepository["listStates"]>>(
    (chainId, addresses) =>
      Promise.resolve(
        new Map(
          addresses.flatMap((address) => {
            const row = rows.get(`${chainId}/${address}`);
            return row === undefined
              ? []
              : [[address, { ...row, bytes: null }] as const];
          }),
        ),
      ),
  );
  return { rows, get, put, listStates };
}

/** A pair-fact cache holding one `token_pairs` row whose base pair has `imageUrl`. */
export function pairFactsWithImage(
  imageUrl: string | null,
  subjectKey = `token:${wbnb}`,
): Pick<MarketFactCacheRepository, "getMany"> {
  const record: MarketFactCacheRecord = {
    subjectKey,
    factKind: "token_pairs",
    source: "dexscreener",
    value: {
      tokenAddress: wbnb,
      pairs: [
        {
          pairAddress: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
          dexId: "pancakeswap",
          labels: ["v2"],
          baseTokenAddress: wbnb,
          baseTokenSymbol: "WBNB",
          quoteTokenAddress: "0x55d398326f99059ff775485246999027b3197955",
          quoteTokenSymbol: "USDT",
          priceUsd: "746.63",
          liquidityUsd: "94854491.12",
          imageUrl,
        },
      ],
    },
    rawDigest: "a".repeat(64),
    fetchedAt: "2026-09-28T00:00:00.000Z",
    ttlSeconds: 30,
  };
  return {
    getMany: vi.fn((keys: readonly string[]) =>
      Promise.resolve(
        new Map(keys.includes(subjectKey) ? [[subjectKey, record]] : []),
      ),
    ),
  };
}

export type UpstreamBehaviour =
  | Readonly<{
      kind: "body";
      status?: number;
      body: Buffer;
      headers?: Record<string, string>;
    }>
  | Readonly<{
      kind: "status";
      status: number;
      headers?: Record<string, string>;
    }>
  | Readonly<{ kind: "hang" }>
  | Readonly<{ kind: "error" }>;

/**
 * A `fetch` double keyed by URL. `hang` waits until the request's signal
 * aborts (the proxy's timeout), then rejects like undici does.
 */
export function upstreamFetch(
  routes: Readonly<Record<string, UpstreamBehaviour>>,
  options: { readonly delayMs?: number } = {},
): typeof fetch & { readonly calls: string[] } {
  const calls: string[] = [];
  const implementation = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push(url);
    if (options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    const behaviour = routes[url];
    if (behaviour === undefined) {
      return new Response(null, { status: 404 });
    }
    switch (behaviour.kind) {
      case "body":
        return new Response(new Uint8Array(behaviour.body), {
          status: behaviour.status ?? 200,
          headers: behaviour.headers ?? { "content-type": "image/png" },
        });
      case "status":
        return new Response(null, {
          status: behaviour.status,
          headers: behaviour.headers ?? {},
        });
      case "error":
        throw new TypeError("fetch failed");
      case "hang":
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) {
            return;
          }
          signal.addEventListener("abort", () => {
            reject(signal.reason as Error);
          });
        });
    }
  };
  return Object.assign(implementation, { calls });
}
