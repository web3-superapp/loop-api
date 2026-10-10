import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  stringToHex,
  toFunctionSelector,
  type Abi,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadReconciliationWorkerConfig,
} from "../src/config.js";
import {
  Launch2LegacyFactoriesInvalidError,
  launch2FactoryEntries,
  parseLaunch2LegacyFactories,
} from "../src/features/launch2/launch2-generation.js";
import { launch2NextOrderBlockedReason } from "../src/features/launch2/launch2-service.js";
import { deriveLaunch2Stage } from "../src/features/launch2/launch2-stage.js";
import type { Launch2BuybackChainState } from "../src/features/launch2/launch2-ports.js";
import { legacyV2BuybackExecutorAbi } from "../src/integrations/launch/hooks-launch-protocol-abi-legacy-v2.js";
import {
  buybackExecutorAbi,
  snapshotRegistryAbi,
} from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";

/**
 * Decision 0122: Factory generations — the frozen v2 executor ABI, the
 * current (v3) ABI, `LAUNCH2_LEGACY_FACTORIES`, the zero-holder opening in
 * the stage derivation, and `nextOrderBlockedReason` per generation.
 */

const v2Completed =
  "BuybackCompleted(uint256,uint256,uint256,uint192,uint192,uint64)";
const v3Completed = "BuybackCompleted(uint256,uint256,uint64)";

function topicOf(abi: Abi): string {
  return encodeEventTopics({ abi, eventName: "BuybackCompleted" })[0];
}

describe("Decision 0122 executor ABIs by generation", () => {
  it("pins the v2 and v3 BuybackCompleted topics and quoteNextOrder shapes", () => {
    expect(topicOf(legacyV2BuybackExecutorAbi as Abi)).toBe(
      keccak256(stringToHex(v2Completed)),
    );
    expect(topicOf(buybackExecutorAbi as Abi)).toBe(
      keccak256(stringToHex(v3Completed)),
    );
    const quote = (abi: readonly { type: string; name?: string }[]) =>
      abi.find((item) => item.name === "quoteNextOrder") as unknown as {
        outputs: { type: string }[];
      };
    expect(
      quote(legacyV2BuybackExecutorAbi).outputs.map((o) => o.type),
    ).toEqual(["uint256", "uint256", "uint256"]);
    expect(quote(buybackExecutorAbi).outputs.map((o) => o.type)).toEqual([
      "uint256",
      "bool",
    ]);
    // execute() is the same call in both generations.
    expect(toFunctionSelector("function execute()")).toBe("0x61461954");
  });

  it("keeps the protection errors only in the v2 ABI and NoOutput only in v3", () => {
    const errors = (abi: readonly { type: string; name?: string }[]) =>
      abi.filter((item) => item.type === "error").map((item) => item.name);
    expect(errors(legacyV2BuybackExecutorAbi)).toEqual(
      expect.arrayContaining([
        "ReferenceUnavailable",
        "SpotOutsideProtection",
        "OutputBelowProtection",
      ]),
    );
    expect(errors(buybackExecutorAbi)).not.toContain("ReferenceUnavailable");
    expect(errors(buybackExecutorAbi)).toContain("NoOutput");
    expect(errors(legacyV2BuybackExecutorAbi)).not.toContain("NoOutput");
  });

  it("carries the v3 zero-holder opening on SnapshotRegistry", () => {
    const names = snapshotRegistryAbi.map((item) => item.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "openPublicWithoutSnapshot",
        "openedWithoutHolders",
        "PublicRoundOpenedWithoutHolders",
        "HoldersExist",
      ]),
    );
    expect(
      encodeEventTopics({
        abi: snapshotRegistryAbi,
        eventName: "PublicRoundOpenedWithoutHolders",
      })[0],
    ).toBe(
      keccak256(
        stringToHex("PublicRoundOpenedWithoutHolders(bytes32,uint64,uint64)"),
      ),
    );
    // The data part decodes as (openedAt, openedBlock).
    expect(
      encodeAbiParameters([{ type: "uint64" }, { type: "uint64" }], [1n, 2n])
        .length,
    ).toBe(2 + 128);
  });
});

describe("Decision 0122 LAUNCH2_LEGACY_FACTORIES", () => {
  const legacy = "0x6A69bA7a5A71C114301E20eF95f62Cd83d07D9c0";
  const current = "0xc3acF98dBFDff8eD73dBe1F305DfDc688C81d1d2";

  it("parses generation:address entries, lower-cases, and orders current first", () => {
    expect(parseLaunch2LegacyFactories(undefined)).toEqual([]);
    expect(parseLaunch2LegacyFactories("  ")).toEqual([]);
    const parsed = parseLaunch2LegacyFactories(`v2:${legacy}`);
    expect(parsed).toEqual([
      { address: legacy.toLowerCase(), generation: "v2" },
    ]);
    expect(launch2FactoryEntries({ current, legacy: parsed })).toEqual([
      { address: current.toLowerCase(), generation: "v3", current: true },
      { address: legacy.toLowerCase(), generation: "v2", current: false },
    ]);
  });

  it("tags a configured current Factory with a known older code hash by that generation", () => {
    expect(
      launch2FactoryEntries({
        current,
        currentCodeHash:
          "0x6669C2AF1110EA253AF8A2EC26DA85D6E83103D5F84220A73535A16B077EACCA",
        legacy: [],
      })[0],
    ).toMatchObject({ generation: "v2", current: true });
    expect(
      launch2FactoryEntries({
        current,
        currentCodeHash:
          "0xf69d4f7256a6152e7e0f11810985cd488482b31efd8ab182b9c1ba468ad74748",
        legacy: [],
      })[0]?.generation,
    ).toBe("v3");
    // Unknown (e.g. a mainnet deployment): the build's generation.
    expect(
      launch2FactoryEntries({
        current,
        currentCodeHash: `0x${"12".repeat(32)}`,
        legacy: [],
      })[0]?.generation,
    ).toBe("v3");
  });

  it("refuses malformed, unknown, duplicate, or current entries", () => {
    for (const bad of [
      legacy,
      `v9:${legacy}`,
      `v2:0x1234`,
      `v2:${legacy},v2:${legacy.toLowerCase()}`,
    ]) {
      expect(() => parseLaunch2LegacyFactories(bad), bad).toThrow(
        Launch2LegacyFactoriesInvalidError,
      );
    }
    expect(() =>
      launch2FactoryEntries({
        current,
        legacy: parseLaunch2LegacyFactories(`v2:${current}`),
      }),
    ).toThrow(Launch2LegacyFactoriesInvalidError);
  });

  it("refuses worker boot on a bad value and exposes the list to the lane", () => {
    const base = {
      DATABASE_URL: "postgres://loop:loop@127.0.0.1:5432/loop",
      LAUNCH_CHAIN_ID: "97",
      LAUNCH2_INDEXER_ENABLED: "true",
      HOOKS_LAUNCH_FACTORY_ADDRESS: current,
      HOOKS_LAUNCH_FACTORY_CODE_HASH: `0x${"ab".repeat(32)}`,
    };
    expect(() =>
      loadReconciliationWorkerConfig({
        ...base,
        LAUNCH2_LEGACY_FACTORIES: `v2:${current}`,
      }),
    ).toThrow(ConfigurationError);
    const config = loadReconciliationWorkerConfig({
      ...base,
      LAUNCH2_LEGACY_FACTORIES: `v2:${legacy}`,
    });
    expect(config.launch2Indexer?.legacyFactories).toEqual([
      { address: legacy.toLowerCase(), generation: "v2" },
    ]);
  });
});

describe("Decision 0122 zero-holder opening stage", () => {
  it("is public from the indexed opening, never closed_no_holders", () => {
    expect(
      deriveLaunch2Stage({
        nowSeconds: 10_000n,
        nftSaleStart: 1_000n,
        nftSaleEnd: 4_600n,
        snapshotPublishedAt: null,
        graduated: false,
        holdReason: null,
        closedNoHolders: false,
        openedWithoutHoldersAt: 4_600n,
      }),
    ).toEqual({ stage: "public", nextChangeAt: null });
    // Graduation and holds still win.
    expect(
      deriveLaunch2Stage({
        nowSeconds: 10_000n,
        nftSaleStart: 1_000n,
        nftSaleEnd: 4_600n,
        snapshotPublishedAt: null,
        graduated: true,
        holdReason: null,
        openedWithoutHoldersAt: 4_600n,
      }).stage,
    ).toBe("graduated");
  });
});

describe("Decision 0122 nextOrderBlockedReason", () => {
  const ready: Launch2BuybackChainState = {
    blockTimestamp: 1_000n,
    paused: false,
    lastSuccessfulAt: 900n,
    availableBudget: 200n,
    totalRecorded: 200n,
    totalSpent: 0n,
    nextOrderAmountIn: 100n,
    nextOrderExecutable: true,
  };
  const v3 = (state: Partial<Launch2BuybackChainState>, graduated = true) =>
    launch2NextOrderBlockedReason({
      generation: "v3",
      graduated,
      state: { ...ready, ...state },
    });
  const v2 = (state: Partial<Launch2BuybackChainState>) =>
    launch2NextOrderBlockedReason({
      generation: "v2",
      graduated: true,
      state: { ...ready, ...state },
    });

  it("names the v3 executable=false cause", () => {
    expect(v3({})).toBeNull();
    expect(v3({ paused: true, nextOrderExecutable: false })).toBe(
      "BUYBACK_PAUSED",
    );
    expect(v3({ nextOrderExecutable: false }, false)).toBe(
      "BUYBACK_NOT_GRADUATED",
    );
    expect(v3({ nextOrderAmountIn: 0n, nextOrderExecutable: false })).toBe(
      "BUYBACK_NO_BUDGET",
    );
    expect(v3({ lastSuccessfulAt: 995n, nextOrderExecutable: false })).toBe(
      "BUYBACK_TOO_SOON",
    );
    expect(v3({ nextOrderExecutable: false })).toBe(
      "BUYBACK_PRINCIPAL_INSUFFICIENT",
    );
    expect(v3({ nextOrderAmountIn: null, nextOrderExecutable: null })).toBe(
      "BUYBACK_QUOTE_UNAVAILABLE",
    );
  });

  it("keeps the v2 protection as BUYBACK_LEGACY_PRICE_PROTECTION, never the retired codes", () => {
    expect(v2({})).toBeNull();
    expect(v2({ nextOrderAmountIn: null, nextOrderExecutable: null })).toBe(
      "BUYBACK_LEGACY_PRICE_PROTECTION",
    );
    expect(v2({ nextOrderExecutable: false })).toBe(
      "BUYBACK_LEGACY_PRICE_PROTECTION",
    );
    for (const state of [
      {},
      { nextOrderExecutable: false },
      { nextOrderAmountIn: null },
    ]) {
      expect([v2(state), v3(state)]).not.toContain(
        "BUYBACK_PROTECTION_BLOCKED",
      );
    }
  });
});
