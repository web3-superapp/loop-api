import { describe, expect, it, vi } from "vitest";

import { formatE18, memeE18 } from "../src/features/meme/meme-curve-math.js";
import {
  createMemePoolPriceReader,
  createMemePoolPriceReaders,
  memePoolMarketCapRaw,
  memePoolPriceKey,
  memePoolPriceE18,
} from "../src/features/meme/meme-pool-price.js";

/** Decision 0103: slot0 → USD1 price, by token0/token1 order, cached 1.5 s. */

const q96 = 1n << 96n;
const low = "0x1111111111111111111111111111111111111111";
const usd1 = "0x2222222222222222222222222222222222222222";
const high = "0xac42e9101f379437f3cce49a5b58609dd9a0ca94";
const pool = "0x7777777777777777777777777777777777777777";

describe("memePoolPriceE18", () => {
  it("reads token1/token0 when the token is token0", () => {
    // sqrtP = 2 × 2^96 → token1/token0 = 4 USD1 per token.
    expect(
      memePoolPriceE18({
        sqrtPriceX96: 2n * q96,
        tokenAddress: low,
        usd1Address: usd1,
      }),
    ).toBe(4n * memeE18);
  });

  it("inverts when the token is token1, whatever the address case", () => {
    // sqrtP = 100 × 2^96 → token1/token0 = 1e4 tokens per USD1.
    const price = memePoolPriceE18({
      sqrtPriceX96: 100n * q96,
      tokenAddress: high.toUpperCase().replace("0X", "0x"),
      usd1Address: usd1,
    });
    expect(price).toBe(memeE18 / 10_000n);
    expect(formatE18(price ?? 0n)).toBe("0.0001");
    expect(formatE18(memePoolMarketCapRaw(price ?? 0n))).toBe("100000");
  });

  it("matches the S118 testnet pool (≈ 0.0000849 USD1)", () => {
    // 16,982.42 USD1 against 200,000,000 tokens, token is token1.
    const ratio =
      (200_000_000n * memeE18 * memeE18) / 16_982_420_000_000_000_000_000n;
    // sqrt(token1/token0) × 2^96 with token1/token0 = tokens per USD1.
    const sqrtPriceX96 = sqrt((ratio * q96 * q96) / memeE18);
    const price = memePoolPriceE18({
      sqrtPriceX96,
      tokenAddress: high,
      usd1Address: usd1,
    });
    expect(formatE18(price ?? 0n).slice(0, 9)).toBe("0.0000849");
  });

  it("is null for a zero price", () => {
    expect(
      memePoolPriceE18({
        sqrtPriceX96: 0n,
        tokenAddress: low,
        usd1Address: usd1,
      }),
    ).toBeNull();
  });
});

describe("createMemePoolPriceReader", () => {
  it("reuses a successful read for the cache window and never caches a failure", async () => {
    let at = Date.parse("2026-10-08T00:00:00.000Z");
    const readSqrtPriceX96 = vi
      .fn<(pool: string) => Promise<bigint>>()
      .mockRejectedValueOnce(new Error("unreachable"))
      .mockResolvedValue(2n * q96);
    const reader = createMemePoolPriceReader({
      usd1Address: () => usd1,
      readSqrtPriceX96,
      cacheMs: 1_500,
      now: () => new Date(at),
    });
    expect(await reader({ tokenAddress: low, poolAddress: pool })).toBeNull();
    const first = await reader({ tokenAddress: low, poolAddress: pool });
    expect(first).toEqual({
      priceE18: 4n * memeE18,
      observedAt: "2026-10-08T00:00:00.000Z",
    });
    at += 1_000;
    expect(await reader({ tokenAddress: low, poolAddress: pool })).toEqual(
      first,
    );
    expect(readSqrtPriceX96).toHaveBeenCalledTimes(2);
    at += 600;
    await reader({ tokenAddress: low, poolAddress: pool });
    expect(readSqrtPriceX96).toHaveBeenCalledTimes(3);
  });

  it("returns null without USD1 or for a zero price", async () => {
    const readSqrtPriceX96 = vi.fn(() => Promise.resolve(0n));
    expect(
      await createMemePoolPriceReader({
        usd1Address: () => null,
        readSqrtPriceX96,
        cacheMs: 1_500,
      })({ tokenAddress: low, poolAddress: pool }),
    ).toBeNull();
    expect(readSqrtPriceX96).not.toHaveBeenCalled();
    expect(
      await createMemePoolPriceReader({
        usd1Address: () => usd1,
        readSqrtPriceX96,
        cacheMs: 1_500,
      })({ tokenAddress: low, poolAddress: pool }),
    ).toBeNull();
  });
});

describe("createMemePoolPriceReaders.readMany (Decision 0105)", () => {
  const otherPool = "0x8888888888888888888888888888888888888888";

  it("reads every uncached pool in one multicall and caches the hits", async () => {
    let at = Date.parse("2026-10-08T00:00:00.000Z");
    const readSqrtPriceX96 = vi.fn(() => Promise.resolve(2n * q96));
    const readSqrtPriceX96Many = vi.fn((pools: readonly string[]) =>
      Promise.resolve(
        new Map(pools.filter((p) => p === pool).map((p) => [p, 2n * q96])),
      ),
    );
    const readers = createMemePoolPriceReaders({
      usd1Address: () => usd1,
      readSqrtPriceX96,
      readSqrtPriceX96Many,
      cacheMs: 1_500,
      now: () => new Date(at),
    });
    const inputs = [
      {
        tokenAddress: low,
        poolAddress: pool.toUpperCase().replace("0X", "0x"),
      },
      { tokenAddress: low, poolAddress: otherPool },
    ];
    const first = await readers.readMany(inputs);
    expect(readSqrtPriceX96Many).toHaveBeenCalledTimes(1);
    expect(readSqrtPriceX96Many.mock.calls[0]?.[0]).toEqual([pool, otherPool]);
    expect(
      first.get(memePoolPriceKey({ tokenAddress: low, poolAddress: pool })),
    ).toEqual({
      priceE18: 4n * memeE18,
      observedAt: "2026-10-08T00:00:00.000Z",
    });
    // A pool whose call failed is null and is not cached.
    expect(
      first.get(
        memePoolPriceKey({ tokenAddress: low, poolAddress: otherPool }),
      ),
    ).toBeNull();
    at += 1_000;
    await readers.readMany(inputs);
    expect(readSqrtPriceX96Many).toHaveBeenCalledTimes(2);
    expect(readSqrtPriceX96Many.mock.calls[1]?.[0]).toEqual([otherPool]);
    expect(readSqrtPriceX96).not.toHaveBeenCalled();
  });

  it("answers null for every pool when the multicall fails or USD1 is unknown", async () => {
    const failing = createMemePoolPriceReaders({
      usd1Address: () => usd1,
      readSqrtPriceX96: () => Promise.resolve(q96),
      readSqrtPriceX96Many: () => Promise.reject(new Error("rpc down")),
      cacheMs: 1_500,
    });
    const result = await failing.readMany([
      { tokenAddress: low, poolAddress: pool },
    ]);
    expect([...result.values()]).toEqual([null]);
    const noUsd1 = createMemePoolPriceReaders({
      usd1Address: () => null,
      readSqrtPriceX96: () => Promise.resolve(q96),
      cacheMs: 1_500,
    });
    expect([
      ...(
        await noUsd1.readMany([{ tokenAddress: low, poolAddress: pool }])
      ).values(),
    ]).toEqual([null]);
  });
});

function sqrt(value: bigint): bigint {
  if (value < 2n) {
    return value;
  }
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}
