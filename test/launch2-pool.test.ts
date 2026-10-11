import { describe, expect, it } from "vitest";

import {
  launch2PoolId,
  launch2PoolKey,
  launch2PoolMaxIn,
  launch2PoolMinOut,
  launch2PoolPriceE18,
  launch2PoolSwapFacts,
  launch2PoolTaxOfGross,
  launch2PoolTaxOfNet,
  launch2PoolZeroForOne,
} from "../src/features/launch2/launch2-pool.js";
import { launch2PoolErrorName } from "../src/integrations/launch2/launch2-pool-chain.js";
import { encodeErrorResult } from "viem";
import { officialPoolRouterAbi } from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";

/**
 * Decision 0124: the official-pool arithmetic — the PoolKey and its id, the
 * swap direction, the 2 % OfficialTaxHook tax (both roundings), slippage
 * bounds, the slot0 price, and the decoding of a PoolManager Swap log.
 */

const wad = 10n ** 18n;
const meme = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6666";
const usd1 = "0x3a1236e68ecf3225640367c84b6f50a51d0b0195";
const hook = "0x00000000000000000000000000000000000020cc";

describe("launch2 official pool (Decision 0124)", () => {
  it("sorts the currencies, keeps fee 2500 / tickSpacing 60, and hashes the key like PoolIdLibrary", () => {
    const key = launch2PoolKey({
      meme: meme.toUpperCase().replace("0X", "0x"),
      usd1,
      hook,
    });
    expect(key).toEqual({
      currency0: usd1,
      currency1: meme,
      fee: 2500,
      tickSpacing: 60,
      hooks: hook,
    });
    // keccak256(abi.encode(key)) — 5 × 32 bytes.
    expect(launch2PoolId(key)).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(launch2PoolId(key)).toBe(
      launch2PoolId(launch2PoolKey({ meme, usd1, hook })),
    );
    expect(launch2PoolId({ ...key, fee: 3000 })).not.toBe(launch2PoolId(key));
    // A buy pays USD1 = currency0 → zeroForOne; a sell pays MEME.
    expect(launch2PoolZeroForOne(key, "buy", meme)).toBe(true);
    expect(launch2PoolZeroForOne(key, "sell", meme)).toBe(false);
    const flipped = launch2PoolKey({
      meme: "0x0000000000000000000000000000000000016666",
      usd1,
      hook,
    });
    expect(flipped.currency0).toBe(
      "0x0000000000000000000000000000000000016666",
    );
    expect(launch2PoolZeroForOne(flipped, "buy", flipped.currency0)).toBe(
      false,
    );
  });

  it("taxes 2 % of the gross output: floor for exact input, the hook's ceiling for exact output", () => {
    expect(launch2PoolTaxOfGross(100n)).toBe(2n);
    expect(launch2PoolTaxOfGross(149n)).toBe(2n);
    // exactIn: net = gross − floor(gross / 50) → tax = floor(net / 49).
    for (const gross of [100n, 1_000n * wad + 7n, 12_345_678_901n]) {
      const tax = launch2PoolTaxOfGross(gross);
      const derived = launch2PoolTaxOfNet(gross - tax, "exactIn");
      expect(derived - tax <= 1n && derived >= tax).toBe(true);
    }
    expect(launch2PoolTaxOfNet(98n, "exactIn")).toBe(2n);
    // exactOut: ceil(net × 200 / 9800).
    expect(launch2PoolTaxOfNet(49n * wad, "exactOut")).toBe(wad);
    expect(launch2PoolTaxOfNet(50n, "exactOut")).toBe(2n);
  });

  it("bounds the slippage: minOut rounds down, maxIn rounds up", () => {
    expect(launch2PoolMinOut(15_680n, 100)).toBe(15_523n);
    expect(launch2PoolMinOut(15_680n, 0)).toBe(15_680n);
    expect(launch2PoolMaxIn(80_000n, 50)).toBe(80_400n);
    expect(launch2PoolMaxIn(3n, 1)).toBe(4n);
  });

  it("prices USD1 per MEME from sqrtPriceX96 on either currency order", () => {
    const q96 = 2n ** 96n;
    // currency0 = USD1, 1,600 MEME per USD1 → 0.000625 USD1.
    expect(launch2PoolPriceE18(40n * q96, false)).toBe(625_000_000_000_000n);
    // currency0 = MEME, 0.25 USD1 per MEME.
    expect(launch2PoolPriceE18(q96 / 2n, true)).toBe(wad / 4n);
    expect(launch2PoolPriceE18(0n, true)).toBe(0n);
  });

  it("reads a Swap log from the swapper's side and refuses a non one-in-one-out delta", () => {
    expect(
      launch2PoolSwapFacts({
        amount0: -50n,
        amount1: 80_000n,
        memeIsCurrency0: false,
      }),
    ).toEqual({
      side: "buy",
      usd1Amount: 50n,
      memeAmount: 80_000n,
      taxAmount: 1_600n,
      taxToken: "meme",
    });
    expect(
      launch2PoolSwapFacts({
        amount0: -80_000n,
        amount1: 50n,
        memeIsCurrency0: true,
      }),
    ).toEqual({
      side: "sell",
      usd1Amount: 50n,
      memeAmount: 80_000n,
      taxAmount: 1n,
      taxToken: "usd1",
    });
    expect(
      launch2PoolSwapFacts({ amount0: 5n, amount1: 5n, memeIsCurrency0: true }),
    ).toBeNull();
  });

  it("decodes router reverts by name (unknown data is null)", () => {
    const data = encodeErrorResult({
      abi: officialPoolRouterAbi,
      errorName: "InsufficientOutput",
      args: [1n, 2n],
    });
    expect(launch2PoolErrorName(data)).toBe("InsufficientOutput");
    expect(launch2PoolErrorName("0xdeadbeef")).toBeNull();
    expect(launch2PoolErrorName(null)).toBeNull();
  });
});
