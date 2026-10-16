import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  toEventSelector,
  toFunctionSelector,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  hooksLaunchFixedEconomicsFor,
  hooksLaunchLoopDynamicFixedEconomics,
  hooksLaunchLoopDynamicHookPermissionBits,
  hooksLaunchLoopDynamicTemplateHash,
  InvalidHooksLaunchDraftError,
} from "../src/features/launch/hooks-launch-config.js";
import {
  verifyHooksLaunchLoopDynamicDeployment,
  type HooksLaunchLoopDynamicOnChainFacts,
} from "../src/features/launch/hooks-launch-loop-dynamic-verification.js";
import {
  HooksLaunchManifestInvalidError,
  parseHooksLaunchLoopDynamicManifest,
} from "../src/features/launch/hooks-launch-manifest.js";
import {
  launch2DynamicBuyFeeTokenOfHook,
  launch2DynamicBuyFeeTokenOfLog,
  launch2DynamicUsd1BuySplit,
} from "../src/features/launch2/launch2-dynamic.js";
import { launch2TemplateProjection } from "../src/features/launch2/launch2-contract.js";
import { launch2QuoteMaxBuy } from "../src/features/launch2/launch2-curve-math.js";
import type { Launch2DecodedLog } from "../src/features/launch2/launch2-ports.js";
import {
  legacyS200CurveEngineAbi,
  legacyS200LoopDynamicHookAbi,
} from "../src/integrations/launch/hooks-launch-protocol-abi-legacy-s200.js";
import {
  curveEngineAbi,
  loopDynamicHookAbi,
} from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
import { launch2DynamicHookDecodeAbi } from "../src/integrations/launch2/launch2-chain.js";
import {
  pairLaunch2DynamicFeeFacts,
  pairLaunch2DynamicSenders,
} from "../src/launch2-indexer-worker.js";
import { expectedDeployment } from "./helpers/hooks-launch-executor-fixtures.js";
import {
  loopDynamicLaunchDeployedEvent,
  passingLoopDynamicFacts,
  s200LoopDynamicParams,
  s200TestnetManifestTemplateHash,
  s209ContractsVectorTemplateHash,
  s209LoopDynamicParams,
  testnetLoopDynamicParams,
} from "./helpers/hooks-launch-loop-dynamic-fixtures.js";

/**
 * Decision 0152 (loop-contracts Decision 0015, S209): the two LoopDynamic
 * generations side by side — events, permission bits, template hash,
 * quote, manifest — and the frozen pre-S209 ABI pins.
 */

const wad = 10n ** 18n;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("frozen pre-S209 ABI and the S209 build (Decision 0152)", () => {
  it("pins both BuyFeeCharged topics and the cap getters", () => {
    expect(toEventSelector(legacyS200LoopDynamicHookAbi[0])).toBe(
      "0x123655f50029142ebf99be50490d6e0fa8236057722dab625ba5b57d464f6dfc",
    );
    const current = loopDynamicHookAbi.find(
      (item) => item.type === "event" && item.name === "BuyFeeCharged",
    );
    expect(current).toBeDefined();
    expect(toEventSelector(current as never)).toBe(
      "0xfae2433f68f562a4156a7c988ed41ac110ba51ed16018b438a476b836444a13c",
    );
    expect(toFunctionSelector(legacyS200CurveEngineAbi[0])).toBe("0xe358ee7c");
    const cap = curveEngineAbi.find(
      (item) => item.type === "function" && item.name === "maxCumulativeBuy",
    );
    expect(toFunctionSelector(cap as never)).toBe("0x4c4d8734");
    expect(
      (curveEngineAbi as readonly { readonly name?: string }[]).some(
        (item) => item.name === "MAX_CUMULATIVE_BUY",
      ),
    ).toBe(false);
  });

  it("decodes an old and a new BuyFeeCharged with one Hook ABI", () => {
    const buyer: Hex = `0x${"a1".repeat(20)}`;
    const old = decodeEventLog({
      abi: launch2DynamicHookDecodeAbi,
      topics: encodeEventTopics({
        abi: legacyS200LoopDynamicHookAbi,
        eventName: "BuyFeeCharged",
        args: { buyer },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        [160_000n, 3_200n],
      ),
      strict: true,
    });
    expect(old.eventName).toBe("BuyFeeCharged");
    expect(old.args).toEqual({
      buyer: getAddress(buyer),
      grossMeme: 160_000n,
      fee: 3_200n,
    });
    const fresh = decodeEventLog({
      abi: launch2DynamicHookDecodeAbi,
      topics: encodeEventTopics({
        abi: loopDynamicHookAbi,
        eventName: "BuyFeeCharged",
        args: { round: 3n, buyer },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        [100n * wad, 2n * wad],
      ),
      strict: true,
    });
    expect(fresh.args).toEqual({
      round: 3n,
      buyer: getAddress(buyer),
      grossQuote: 100n * wad,
      fee: 2n * wad,
    });
    expect(launch2DynamicBuyFeeTokenOfLog({ grossMeme: "1", fee: "1" })).toBe(
      "meme",
    );
    expect(
      launch2DynamicBuyFeeTokenOfLog({ round: "0", grossQuote: "1", fee: "1" }),
    ).toBe("usd1");
  });
});

describe("Hook generation from the address (Decision 0152)", () => {
  it("reads 0x10C4 as MEME, 0x10CC as USD1, anything else as unknown", () => {
    expect(launch2DynamicBuyFeeTokenOfHook(`0x${"c".repeat(36)}10c4`)).toBe(
      "meme",
    );
    expect(launch2DynamicBuyFeeTokenOfHook(`0x${"c".repeat(36)}10CC`)).toBe(
      "usd1",
    );
    expect(launch2DynamicBuyFeeTokenOfHook(`0x${"c".repeat(36)}20cc`)).toBe(
      null,
    );
    expect(launch2DynamicBuyFeeTokenOfHook("0x1234")).toBe(null);
    // loop-contracts Decision 0015 §7 mined vector.
    expect(
      launch2DynamicBuyFeeTokenOfHook(
        "0x9443b0A16808f48B251B49752edb493C76BA10cc",
      ),
    ).toBe("usd1");
  });
});

describe("S209 buy quote (Decision 0152)", () => {
  it("keeps floor(amountIn × 2 %) USD1 and swaps the rest", () => {
    expect(launch2DynamicUsd1BuySplit(100n * wad, 20_000n)).toEqual({
      fee: 2n * wad,
      poolInput: 98n * wad,
    });
    // Floors: 49 wei → no fee (the Hook emits nothing below 50 wei).
    expect(launch2DynamicUsd1BuySplit(49n, 20_000n)).toEqual({
      fee: 0n,
      poolInput: 49n,
    });
    expect(launch2DynamicUsd1BuySplit(50n, 20_000n)).toEqual({
      fee: 1n,
      poolInput: 49n,
    });
    expect(launch2DynamicUsd1BuySplit(150n * wad, 20_000n).fee).toBe(3n * wad);
    expect(launch2DynamicUsd1BuySplit(100n * wad, 0n).fee).toBe(0n);
  });
});

describe("fee pairing and sender attribution by generation (Decision 0152)", () => {
  const poolManager = `0x${"8".repeat(40)}`;
  const hook = `0x${"c".repeat(36)}10cc`;
  const router = `0x${"7".repeat(40)}`;
  const wallet = `0x${"a".repeat(40)}`;
  const poolId = `0x${"42".repeat(32)}`;
  const tx = `0x${"a1".repeat(32)}`;
  const block = `0x${"b1".repeat(32)}`;
  const log = (
    contractAddress: string,
    eventName: Launch2DecodedLog["eventName"],
    args: Record<string, string>,
    logIndex: number,
  ): Launch2DecodedLog => ({
    contractAddress,
    eventName,
    args,
    transactionHash: tx,
    logIndex,
    blockNumber: 300n,
    blockHash: block,
  });
  // MEME is currency1 here: amount0 = USD1 (−98 paid into the pool).
  const swap = log(
    poolManager,
    "Swap",
    {
      id: poolId,
      sender: router,
      amount0: (-98n * wad).toString(),
      amount1: (97n * wad).toString(),
      sqrtPriceX96: "1",
    },
    1,
  );

  it("pairs an S209 fee as USD1 and a pre-S209 one as MEME", () => {
    const usd1 = pairLaunch2DynamicFeeFacts(
      [
        swap,
        log(
          hook,
          "BuyFeeCharged",
          {
            round: "0",
            buyer: wallet,
            grossQuote: (100n * wad).toString(),
            fee: (2n * wad).toString(),
          },
          3,
        ),
      ],
      new Map([[hook, poolId]]),
    );
    expect(usd1.get(`${tx}:1`)).toEqual({
      fee: (2n * wad).toString(),
      token: "usd1",
    });
    const meme = pairLaunch2DynamicFeeFacts(
      [
        swap,
        log(
          hook,
          "BuyFeeCharged",
          { buyer: wallet, grossMeme: "100", fee: "2" },
          3,
        ),
      ],
      new Map([[hook, poolId]]),
    );
    expect(meme.get(`${tx}:1`)).toEqual({ fee: "2", token: "meme" });
  });

  it("attributes the paid USD1 (pool input + fee) and the whole MEME output", () => {
    const pools = new Map([
      [
        poolId,
        {
          poolManager,
          memeIsCurrency0: false,
          dynamicHook: hook,
          dynamicRouter: router,
        },
      ],
    ]);
    const parties = new Map([[tx, { from: wallet, to: router }]]);
    const fees = new Map([[`${tx}:1`, (2n * wad).toString()]]);
    expect(
      pairLaunch2DynamicSenders({
        logs: [swap],
        pools,
        fees,
        feeTokens: new Map([[`${tx}:1`, "usd1" as const]]),
        parties,
      }).get(`${tx}:1`),
    ).toEqual({
      payer: wallet,
      recipient: wallet,
      amountIn: (100n * wad).toString(),
      amountOut: (97n * wad).toString(),
    });
    // The same numbers read as a pre-S209 MEME fee.
    expect(
      pairLaunch2DynamicSenders({ logs: [swap], pools, fees, parties }).get(
        `${tx}:1`,
      ),
    ).toMatchObject({
      amountIn: (98n * wad).toString(),
      amountOut: (95n * wad).toString(),
    });
  });
});

describe("template hash, economics and permission bits by generation (Decision 0152)", () => {
  it("reproduces the contracts' S209 vector and the S200 manifest hash", () => {
    expect(hooksLaunchLoopDynamicTemplateHash(s200LoopDynamicParams)).toBe(
      s200TestnetManifestTemplateHash,
    );
    expect(hooksLaunchLoopDynamicTemplateHash(s209LoopDynamicParams)).toBe(
      s209ContractsVectorTemplateHash,
    );
    expect(
      hooksLaunchLoopDynamicTemplateHash({
        ...s209LoopDynamicParams,
        maxCumulativeBuy: (1_000_000n * wad).toString(),
      }),
    ).not.toBe(s209ContractsVectorTemplateHash);
    expect(
      hooksLaunchLoopDynamicHookPermissionBits(s200LoopDynamicParams),
    ).toBe(0x10c4n);
    expect(
      hooksLaunchLoopDynamicHookPermissionBits(s209LoopDynamicParams),
    ).toBe(0x10ccn);
  });

  it("refuses a malformed cap or a cap without maxDynamicFeeWad", () => {
    for (const maxCumulativeBuy of ["0", "01", "1e24", `1${"0".repeat(27)}1`]) {
      expect(() =>
        hooksLaunchLoopDynamicTemplateHash({
          ...s209LoopDynamicParams,
          maxCumulativeBuy,
        }),
      ).toThrow(InvalidHooksLaunchDraftError);
    }
    // An S165 parameter set (no maxDynamicFeeWad) with a purchase cap.
    const noCap = {
      ...testnetLoopDynamicParams,
      maxCumulativeBuy: "5000000000000000000000000",
    };
    expect(() => hooksLaunchLoopDynamicTemplateHash(noCap)).toThrow(
      InvalidHooksLaunchDraftError,
    );
  });

  it("binds the cap and the USD1 buy fee in fixedEconomics; pre-S209 JSON is unchanged", () => {
    const base = hooksLaunchFixedEconomicsFor(3_600);
    const legacy = hooksLaunchLoopDynamicFixedEconomics(
      base,
      s200LoopDynamicParams,
    );
    expect(JSON.stringify(legacy)).not.toContain("maxCumulativeBuy");
    expect(JSON.stringify(legacy)).not.toContain("buyFeeToken");
    const lower = (1_000_000n * wad).toString();
    const s209 = hooksLaunchLoopDynamicFixedEconomics(base, {
      ...s209LoopDynamicParams,
      maxCumulativeBuy: lower,
    });
    expect(s209["perAddressLifetimeBuyCapRaw"]).toBe(lower);
    // Same key position as the OfficialTax object.
    expect(Object.keys(s209).slice(0, Object.keys(base).length)).toEqual(
      Object.keys(base),
    );
    expect(s209["loopDynamic"]).toMatchObject({
      maxCumulativeBuy: lower,
      buyFeeToken: "usd1",
    });
  });
});

describe("LoopDynamic verification by generation (Decision 0152)", () => {
  const s209Hook = `0x${"ce".repeat(18)}10cc`;
  const template = {
    params: s209LoopDynamicParams,
    templateHash: s209ContractsVectorTemplateHash,
  };
  function s209Facts(
    overrides: {
      readonly cap?: bigint;
      readonly factoryCap?: bigint | null;
      readonly mask?: bigint;
      readonly adapterBits?: bigint;
    } = {},
  ): HooksLaunchLoopDynamicOnChainFacts {
    const facts = passingLoopDynamicFacts();
    if (
      facts.hookFactory === null ||
      facts.adapter === null ||
      facts.curve === null
    ) {
      throw new Error("fixture");
    }
    return {
      ...facts,
      factory: {
        ...facts.factory,
        templateHash: template.templateHash,
        loopRouter: s209LoopDynamicParams.router,
        maxCumulativeBuy:
          overrides.factoryCap === undefined
            ? 5_000_000n * wad
            : overrides.factoryCap,
      },
      curve: {
        ...facts.curve,
        maxCumulativeBuy: overrides.cap ?? 5_000_000n * wad,
      },
      adapter: {
        ...facts.adapter,
        hookPermissions: overrides.adapterBits ?? 0x10ccn,
      },
      buybackAdapter:
        facts.buybackAdapter === null
          ? null
          : { ...facts.buybackAdapter, router: s209LoopDynamicParams.router },
      hookFactory: {
        ...facts.hookFactory,
        router: s209LoopDynamicParams.router,
        maxDynamicFeeWad: "200000000000000000",
        requiredPermissionMask: overrides.mask ?? 0x10ccn,
        predictedHook: s209Hook,
      },
    };
  }
  const run = (
    facts: HooksLaunchLoopDynamicOnChainFacts,
    predictedHookAddress = s209Hook,
  ) =>
    verifyHooksLaunchLoopDynamicDeployment({
      expected: { ...expectedDeployment(), predictedHookAddress },
      template,
      event: loopDynamicLaunchDeployedEvent(),
      facts,
    }).failedChecks;

  it("passes an S209 launch (0x10CC, cap from the Factory)", () => {
    expect(run(s209Facts())).toEqual([]);
  });

  it("refuses 0x10C4 bits under an S209 template", () => {
    expect(run(s209Facts({ mask: 0x10c4n }))).toEqual(["hook_permission_bits"]);
    expect(run(s209Facts({ adapterBits: 0x10c4n }))).toEqual([
      "adapter_params",
    ]);
    const legacyHook = `0x${"ce".repeat(18)}10c4`;
    const facts = s209Facts();
    expect(
      run(
        {
          ...facts,
          hookFactory:
            facts.hookFactory === null
              ? null
              : { ...facts.hookFactory, predictedHook: legacyHook },
        },
        legacyHook,
      ),
    ).toEqual(["hook_permission_bits"]);
  });

  it("refuses a curve cap that is not the template's", () => {
    expect(run(s209Facts({ cap: 1_000_000n * wad }))).toEqual(["curve_caps"]);
    expect(run(s209Facts({ factoryCap: null }))).toEqual(["curve_caps"]);
    expect(run(s209Facts({ factoryCap: 1n }))).toEqual(["curve_caps"]);
  });

  it("keeps a pre-S209 launch passing with 0x10C4 and no Factory cap", () => {
    const facts = passingLoopDynamicFacts();
    expect(facts.factory.maxCumulativeBuy).toBe(null);
    expect(facts.hookFactory?.requiredPermissionMask).toBe(0x10c4n);
  });
});

describe("deployment manifest (Decision 0152)", () => {
  const s200Manifest = (): Record<string, unknown> =>
    JSON.parse(
      readFileSync(
        path.resolve(
          repositoryRoot,
          "../../loop-contracts/protocol/deployments/bsc-testnet/factory-20261015T185535Z.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
  const manifestAvailable = (() => {
    try {
      s200Manifest();
      return true;
    } catch {
      return false;
    }
  })();
  // The committed shape of the S200 manifest's LoopDynamic part (the
  // fields this parser reads), so the suite also runs without the sibling
  // loop-contracts checkout.
  const s200Shape = (): Record<string, unknown> => ({
    loopDynamic: {
      loopRouter: "0x135C772b52Ec87c669f3aa1Fdf18a728ec7EA110",
      templateHash: s200TestnetManifestTemplateHash,
      params: {
        baseFeeRecipient: "0x0E2E2b52d5465f3e4576e71ee4Dd1DFF22557040",
        baseSellFeePpm: 20000,
        buyFeePpm: 20000,
        excludeBuybackFromRewards: true,
        maxDynamicFeeWad: 200000000000000000,
        priceTiming: "POST_SWAP",
        routerRegistryAdmin: "0x3E64c464E739e108D88C9B805157EeB2a8a11767",
        routingPolicy: "Open",
      },
    },
  });
  const s209Shape = (): Record<string, unknown> => {
    const base = s200Shape();
    const ld = base["loopDynamic"] as Record<string, unknown>;
    return {
      ...base,
      maxCumulativeBuy: "5000000000000000000000000",
      loopDynamic: {
        ...ld,
        templateHash: s209ContractsVectorTemplateHash,
        maxCumulativeBuy: "5000000000000000000000000",
        params: {
          ...(ld["params"] as Record<string, unknown>),
          buyFeeToken: "USD1",
          buyFeeAccrual: "baseFeesAccrued",
          hookPermissionFlags: "0x10cc",
        },
      },
    };
  };

  it.runIf(manifestAvailable)(
    "reads the real S200 testnet manifest as the pre-S209 generation",
    () => {
      const read = parseHooksLaunchLoopDynamicManifest(s200Manifest());
      expect(read.generation).toBe("legacy");
      expect(read.params).toEqual(s200LoopDynamicParams);
      expect(read.hookPermissionFlags).toBe(0x10c4n);
    },
  );

  it("reads an S209 manifest (new fields) and its 12-field hash", () => {
    expect(parseHooksLaunchLoopDynamicManifest(s200Shape()).generation).toBe(
      "legacy",
    );
    const read = parseHooksLaunchLoopDynamicManifest(s209Shape());
    expect(read).toMatchObject({
      generation: "s209",
      buyFeeToken: "usd1",
      hookPermissionFlags: 0x10ccn,
      templateHash: s209ContractsVectorTemplateHash,
    });
    expect(read.params).toEqual(s209LoopDynamicParams);
  });

  it.each([
    ["a missing top-level cap", { maxCumulativeBuy: undefined }],
    ["a JSON-number cap", { maxCumulativeBuy: 5e24 }],
    ["different caps", { maxCumulativeBuy: "1000000000000000000000000" }],
  ])("refuses %s", (_name, top) => {
    const manifest = { ...s209Shape(), ...top };
    expect(() => parseHooksLaunchLoopDynamicManifest(manifest)).toThrow(
      HooksLaunchManifestInvalidError,
    );
  });

  it.each([
    ["buyFeeToken", "MEME"],
    ["buyFeeAccrual", "vault"],
    ["hookPermissionFlags", "0x10c4"],
  ])("refuses params.%s = %s", (key, value) => {
    const manifest = s209Shape();
    const ld = manifest["loopDynamic"] as Record<string, unknown>;
    (ld["params"] as Record<string, unknown>)[key] = value;
    expect(() => parseHooksLaunchLoopDynamicManifest(manifest)).toThrow(
      HooksLaunchManifestInvalidError,
    );
  });

  it("refuses an S209 manifest whose hash is the old formula", () => {
    const manifest = s209Shape();
    (manifest["loopDynamic"] as Record<string, unknown>)["templateHash"] =
      s200TestnetManifestTemplateHash;
    expect(() => parseHooksLaunchLoopDynamicManifest(manifest)).toThrow(
      HooksLaunchManifestInvalidError,
    );
  });
});

describe("curve cap in quotes and the template card (Decision 0152)", () => {
  const curve = {
    published: true,
    graduated: false,
    earlyRoundEndsAt: 1n,
    soldSupply: 0n,
    accountedReserve: 0n,
    blockTimestamp: 2n,
  };
  it("limits a buy by the curve's own cap", () => {
    const legacy = launch2QuoteMaxBuy(curve, 0n);
    expect(legacy.quotaRemaining).toBe(5_000_000n * wad);
    const lower = launch2QuoteMaxBuy(
      { ...curve, maxCumulativeBuy: 1_000_000n * wad },
      400_000n * wad,
    );
    expect(lower.quotaRemaining).toBe(600_000n * wad);
    expect(lower.maxMemeOut).toBe(600_000n * wad);
    expect(lower.limitedBy).toBe("quota");
  });

  it("shows the instance cap and its bps of the supply", () => {
    expect(launch2TemplateProjection(3_600)).toMatchObject({
      perAddressCap: "5000000",
      perAddressCapBps: 50,
    });
    expect(launch2TemplateProjection(3_600, 1_000_000n * wad)).toMatchObject({
      perAddressCap: "1000000",
      perAddressCapBps: 10,
    });
  });
});
