import { describe, expect, it } from "vitest";

import type { SpotIntentTerminalResolution } from "../src/features/spot/spot-reconciliation-contract.js";
import {
  parseSpotIntentTerminalResolution,
  spotIntentTerminalResolutionMatchesAuthority,
  type SpotIntentTerminalAuthority,
} from "../src/features/spot/spot-reconciliation-terminal.js";

const baseTokenId = `0x${"1".repeat(32)}`;
const quoteTokenId = `0x${"2".repeat(32)}`;
const clientOrderId = `0x${"3".repeat(32)}`;
const authority: SpotIntentTerminalAuthority = Object.freeze({
  clientOrderId,
  side: "buy",
  computedBaseSize: "0.2",
  worstIocLimitPrice: "50",
  baseTokenIndex: 1,
  baseTokenId,
  baseDisplayIdentity: "kPurr+",
  quoteTokenIndex: 0,
  quoteTokenId,
  quoteDisplayIdentity: "USDC",
});

function filledResolution(
  overrides: Partial<
    Extract<SpotIntentTerminalResolution, { readonly state: "filled" }>
  > = {},
): Record<string, unknown> {
  return {
    state: "filled",
    providerOrderId: "18446744073709551615",
    clientOrderId,
    filledBaseSize: "0.2000",
    quoteAmount: "10",
    averageFillPrice: "50",
    fee: {
      amount: "0.01",
      tokenIndex: 1,
      tokenId: baseTokenId,
      assetDisplayIdentity: "kPurr+",
    },
    observedAt: "2026-08-27T08:00:00+08:00",
    reasonCode: null,
    ...overrides,
  };
}

describe("Spot terminal reconciliation contract", () => {
  it("normalizes strict terminal evidence and preserves broad display identities", () => {
    const resolution = parseSpotIntentTerminalResolution(filledResolution());

    expect(resolution).toMatchObject({
      state: "filled",
      observedAt: "2026-08-27T00:00:00.000Z",
      filledBaseSize: "0.2000",
      fee: { assetDisplayIdentity: "kPurr+" },
    });
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(
      spotIntentTerminalResolutionMatchesAuthority(authority, resolution),
    ).toBe(true);
  });

  it("keeps ambiguous states, invalid reasons, rebates, and authority mismatches out", () => {
    for (const value of [
      { ...filledResolution(), state: "partially_filled" },
      {
        ...filledResolution(),
        state: "rejected",
        filledBaseSize: null,
        quoteAmount: null,
        averageFillPrice: null,
        fee: null,
        reasonCode: "authoritative_result_pending",
      },
      {
        ...filledResolution(),
        fee: {
          amount: "-0.01",
          tokenIndex: 1,
          tokenId: baseTokenId,
          assetDisplayIdentity: "kPurr+",
        },
      },
    ]) {
      expect(() => parseSpotIntentTerminalResolution(value)).toThrow();
    }

    for (const value of [
      filledResolution({ clientOrderId: `0x${"4".repeat(32)}` }),
      filledResolution({ quoteAmount: "9.99" }),
      filledResolution({ averageFillPrice: "50.1", quoteAmount: "10.02" }),
      filledResolution({
        fee: {
          amount: "0.2001",
          tokenIndex: 1,
          tokenId: baseTokenId,
          assetDisplayIdentity: "kPurr+",
        },
      }),
    ]) {
      expect(
        spotIntentTerminalResolutionMatchesAuthority(
          authority,
          parseSpotIntentTerminalResolution(value),
        ),
      ).toBe(false);
    }
  });
});
