import { describe, expect, it } from "vitest";

import {
  assetIdForAddress,
  parseDecimalAmount,
  decomposeAssetId,
  eip681Uri,
  formatDecimalAmount,
  InvalidChainIdentityError,
  isAssetId,
  nativeAssetId,
  normalizeEvmAddress,
  parseAssetId,
  subtractFloorZero,
} from "../src/features/chain/chain-contract.js";

describe("chain identity and amount contract", () => {
  it("accepts only canonical lowercase CAIP asset IDs", () => {
    expect(isAssetId("eip155:56:native")).toBe(true);
    expect(
      isAssetId("eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"),
    ).toBe(true);
    expect(
      isAssetId("eip155:56:0xBB4CDB9CBD36B01BD1CBAEBF2DE08D9173BC095C"),
    ).toBe(false);
    expect(isAssetId("WBNB")).toBe(false);
    expect(isAssetId("eip155:0:native")).toBe(false);
    expect(() => parseAssetId("WBNB")).toThrow(InvalidChainIdentityError);
  });

  it("normalises a checksummed address and refuses anything else", () => {
    expect(
      normalizeEvmAddress("0xBB4CDB9CBD36B01BD1CBAEBF2DE08D9173BC095C"),
    ).toBe("0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c");
    expect(() => normalizeEvmAddress("0x1234")).toThrow(
      InvalidChainIdentityError,
    );
    expect(() => normalizeEvmAddress(undefined)).toThrow(
      InvalidChainIdentityError,
    );
  });

  it("builds and decomposes asset IDs", () => {
    expect(
      assetIdForAddress(
        "eip155:56",
        "0xBB4CDB9CBD36B01BD1CBAEBF2DE08D9173BC095C",
      ),
    ).toBe("eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c");
    expect(nativeAssetId("eip155:56")).toBe("eip155:56:native");
    expect(decomposeAssetId("eip155:56:native")).toEqual({
      chainId: "eip155:56",
      reference: 56,
      address: null,
    });
    expect(
      decomposeAssetId("eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"),
    ).toEqual({
      chainId: "eip155:56",
      reference: 56,
      address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    });
  });

  it("formats smallest-unit integers as exact decimal strings", () => {
    expect(formatDecimalAmount(0n, 18)).toBe("0");
    expect(formatDecimalAmount(1n, 18)).toBe("0.000000000000000001");
    expect(formatDecimalAmount(7_000_000_000_000_000_000n, 18)).toBe("7");
    expect(formatDecimalAmount(6_995_000_000_000_000_000n, 18)).toBe("6.995");
    expect(formatDecimalAmount(123_456n, 0)).toBe("123456");
    // A value far beyond IEEE-754 exact integers keeps every digit.
    expect(
      formatDecimalAmount(123_456_789_012_345_678_901_234_567_890n, 18),
    ).toBe("123456789012.34567890123456789");
    expect(() => formatDecimalAmount(-1n, 18)).toThrow(
      InvalidChainIdentityError,
    );
    expect(() => formatDecimalAmount(1n, 37)).toThrow(
      InvalidChainIdentityError,
    );
  });

  it("parses an exact decimal into a smallest-unit integer", () => {
    expect(parseDecimalAmount("0.005", 18)).toBe(5_000_000_000_000_000n);
    expect(parseDecimalAmount("0", 18)).toBe(0n);
    expect(parseDecimalAmount("1", 18)).toBe(1_000_000_000_000_000_000n);
    expect(parseDecimalAmount("0.000000000000000001", 18)).toBe(1n);
    // More fraction digits than the asset has decimals would silently round.
    expect(() => parseDecimalAmount("0.0000000000000000001", 18)).toThrow(
      InvalidChainIdentityError,
    );
    expect(() => parseDecimalAmount("-1", 18)).toThrow(
      InvalidChainIdentityError,
    );
    expect(() => parseDecimalAmount("1e18", 18)).toThrow(
      InvalidChainIdentityError,
    );
  });

  it("floors a reserve subtraction at zero", () => {
    expect(subtractFloorZero(10n, 3n)).toBe(7n);
    expect(subtractFloorZero(2n, 3n)).toBe(0n);
  });

  it("builds an EIP-681 request without amount or calldata", () => {
    expect(eip681Uri("0xBB4CDB9CBD36B01BD1CBAEBF2DE08D9173BC095C", 56)).toBe(
      "ethereum:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c@56",
    );
    expect(() =>
      eip681Uri("0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", 0),
    ).toThrow(InvalidChainIdentityError);
  });
});
