import type { MigrationBuilder } from "node-pg-migrate";
import { decodeFunctionData } from "viem";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000076_launch2_loop_dynamic.js";
import {
  down as down86,
  up as up86,
} from "../migrations/000086_launch2_dynamic_delivery_attribution.js";
import {
  hooksLaunchLoopDynamicTemplateHash,
  hooksLaunchTemplateHash,
  InvalidHooksLaunchDraftError,
  parseHooksLaunchDraft,
} from "../src/features/launch/hooks-launch-config.js";
import {
  classifyLaunch2DynamicRevert,
  encodeLaunch2DynamicClaim,
  encodeLaunch2DynamicPoke,
  launch2DynamicBps,
  launch2DynamicClaimable,
  launch2DynamicCrashOverTenPercent,
  launch2DynamicDropWad,
  launch2DynamicGrossOfNet,
  launch2DynamicClosesRound,
  launch2DynamicEffectiveRateWad,
  launch2DynamicIsGreen,
  launch2DynamicIsRed,
  launch2DynamicRealizedRateWad,
  launch2DynamicReasonCodes,
  launch2DynamicReasonMessagesZh,
  launch2DynamicRoll,
  launch2DynamicSellExtraFee,
  launch2DynamicSellSplit,
  launch2DynamicWadBps,
  launch2HookKindOf,
} from "../src/features/launch2/launch2-dynamic.js";
import {
  createLaunch2DynamicPokeLane,
  launch2DynamicPokeDue,
  type Launch2DynamicPokeChain,
} from "../src/features/launch2/launch2-dynamic-poke.js";
import { classifyLaunch2BuybackRevert } from "../src/features/launch2/launch2-buyback-keeper.js";
import { launch2FactoryEntries } from "../src/features/launch2/launch2-generation.js";
import type { Launch2LaneInstance } from "../src/features/launch2/launch2-ports.js";
import { loopDynamicHookAbi } from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";

const q96 = 2n ** 96n;
const wad = 10n ** 18n;

/**
 * Decision 0131: the pure LoopDynamic pieces — the PriceMath / roll port,
 * the fee split, the error map, calldata, the template hash (S165
 * buyFeePpm), the migration contract, the Factory list, and the poke lane.
 */
describe("LoopDynamic arithmetic (Decision 0131)", () => {
  it("classifies the registry hook: zero = loopDynamic", () => {
    expect(launch2HookKindOf(`0x${"0".repeat(40)}`)).toBe("loopDynamic");
    expect(launch2HookKindOf(`0x${"b".repeat(40)}`)).toBe("officialTax");
  });

  it("ports PriceMath: green, the strict -10 % crash and the drop rate", () => {
    // memeIs0: price = sqrt²; a 10 % drop on price is sqrt × √0.9.
    const open = 1_000_000n * q96;
    expect(launch2DynamicIsGreen(open, open + 1n, true)).toBe(true);
    expect(launch2DynamicIsGreen(open, open + 1n, false)).toBe(false);
    // close² × 10 < open² × 9 ⇔ strictly more than 10 % down.
    // √0.9 × 1e6 ≈ 948,683.3: 948,684 is not quite 10 % down, 948,683 is.
    expect(launch2DynamicCrashOverTenPercent(open, 948_684n * q96, true)).toBe(
      false,
    );
    expect(launch2DynamicCrashOverTenPercent(open, 948_683n * q96, true)).toBe(
      true,
    );
    // Half the sqrt price = 75 % below on price.
    expect(launch2DynamicDropWad(open, open / 2n, true)).toBe(
      (75n * wad) / 100n,
    );
    // MEME as currency1: the price is the inverse, so a higher sqrt is a drop.
    expect(launch2DynamicDropWad(open, open * 2n, false)).toBe(
      (75n * wad) / 100n,
    );
    expect(launch2DynamicDropWad(open, open, true)).toBe(0n);
    expect(launch2DynamicDropWad(open, open * 2n, true)).toBe(0n);
  });

  it("rolls the candle like _rollCandle: activation, closing, nothing pending", () => {
    const base = {
      initialized: true,
      armed: false,
      candleId: 100n,
      candleOpenSqrtPriceX96: 1_000n * q96,
      lastSqrtPriceX96: 900n * q96,
      currentRoundId: 4n,
      memeIsCurrency0: true,
      roundCloseRule: "closeAtOrAboveOpen" as const,
    };
    expect(launch2DynamicRoll(base, 100n * 300n + 299n)).toMatchObject({
      rollPending: false,
      armed: false,
      roundId: 4n,
    });
    expect(launch2DynamicRoll(base, 101n * 300n)).toMatchObject({
      rollPending: true,
      armed: true,
      activates: true,
      roundId: 5n,
      candleOpenSqrtPriceX96: 900n * q96,
    });
    const armedGreen = {
      ...base,
      armed: true,
      lastSqrtPriceX96: 1_001n * q96,
    };
    expect(launch2DynamicRoll(armedGreen, 105n * 300n)).toMatchObject({
      armed: false,
      closes: true,
      roundId: 4n,
    });
    expect(launch2DynamicPokeDue({ ...base, armed: true }, 101n * 300n)).toBe(
      true,
    );
    expect(launch2DynamicPokeDue(base, 101n * 300n)).toBe(false);
  });

  it("closes an armed round on a candle that no longer falls (Decision 0144)", () => {
    const open = 1_000n * q96;
    // S193: close ≥ open closes (a flat candle included); a red one keeps it.
    for (const memeIsCurrency0 of [true, false]) {
      const up = memeIsCurrency0 ? open + 1n : open - 1n;
      const down = memeIsCurrency0 ? open - 1n : open + 1n;
      expect(launch2DynamicIsRed(open, down, memeIsCurrency0)).toBe(true);
      expect(launch2DynamicIsRed(open, open, memeIsCurrency0)).toBe(false);
      expect(launch2DynamicIsRed(open, up, memeIsCurrency0)).toBe(false);
      for (const [close, s193, legacy] of [
        [up, true, true],
        [open, true, false],
        [down, false, false],
      ] as const) {
        expect(
          launch2DynamicClosesRound(
            open,
            close,
            memeIsCurrency0,
            "closeAtOrAboveOpen",
          ),
        ).toBe(s193);
        expect(
          launch2DynamicClosesRound(
            open,
            close,
            memeIsCurrency0,
            "closeAboveOpen",
          ),
        ).toBe(legacy);
      }
    }
    // The roll: an armed round over a flat (e.g. empty) candle.
    const armedFlat = {
      initialized: true,
      armed: true,
      candleId: 100n,
      candleOpenSqrtPriceX96: open,
      lastSqrtPriceX96: open,
      currentRoundId: 4n,
      memeIsCurrency0: true,
      roundCloseRule: "closeAtOrAboveOpen" as const,
    };
    expect(launch2DynamicRoll(armedFlat, 101n * 300n)).toMatchObject({
      rollPending: true,
      armed: false,
      closes: true,
      roundId: 4n,
    });
    // A pre-S193 Hook keeps the round armed on the same flat candle.
    expect(
      launch2DynamicRoll(
        { ...armedFlat, roundCloseRule: "closeAboveOpen" },
        101n * 300n,
      ),
    ).toMatchObject({ rollPending: true, armed: true, closes: false });
    // Decision 0144 / loop-contracts 0013 §2: a red candle followed by
    // skipped empty ones ends at the first empty candle (S193 only).
    const armedRed = { ...armedFlat, lastSqrtPriceX96: open - 1n };
    expect(launch2DynamicRoll(armedRed, 103n * 300n)).toMatchObject({
      armed: false,
      closes: true,
      roundId: 4n,
    });
    expect(
      launch2DynamicRoll(
        { ...armedRed, roundCloseRule: "closeAboveOpen" },
        103n * 300n,
      ),
    ).toMatchObject({ armed: true, closes: false });
    // A crash followed by an empty candle: activated and closed in one roll.
    const crash = {
      ...armedFlat,
      armed: false,
      lastSqrtPriceX96: (open * 9n) / 10n,
    };
    expect(launch2DynamicRoll(crash, 102n * 300n)).toMatchObject({
      activates: true,
      closes: true,
      armed: false,
      roundId: 5n,
    });
    expect(launch2DynamicRoll(crash, 101n * 300n)).toMatchObject({
      activates: true,
      closes: false,
      armed: true,
      roundId: 5n,
    });
    // A red candle keeps it armed under both rules (no new activation).
    expect(
      launch2DynamicRoll(
        { ...armedFlat, lastSqrtPriceX96: open - 1n },
        101n * 300n,
      ),
    ).toMatchObject({ armed: true, closes: false, activates: false });
  });

  it("caps the dynamic sell rate at min(drop, cap) (Decision 0144)", () => {
    const cap = (2n * wad) / 10n;
    const gross = 100n * wad;
    const baseFee = 2n * wad;
    const cases = [
      // [drop, cap, charged rate]
      [(13n * wad) / 100n, cap, (13n * wad) / 100n],
      [(6n * wad) / 10n, cap, cap],
      [(6n * wad) / 10n, 0n, (6n * wad) / 10n],
      [cap, cap, cap],
      [0n, cap, 0n],
    ] as const;
    for (const [drop, maxDynamicFeeWad, rate] of cases) {
      expect(launch2DynamicEffectiveRateWad(drop, maxDynamicFeeWad)).toBe(rate);
      const extraFee = launch2DynamicSellExtraFee({
        gross,
        baseFee,
        dropWad: drop,
        maxDynamicFeeWad,
      });
      expect(extraFee).toBe(((gross - baseFee) * rate) / wad);
      // The realized rate from the SellFeeCharged amounts is the charged
      // rate, not the event's dropWad.
      expect(
        launch2DynamicRealizedRateWad({
          grossQuote: gross,
          baseFee,
          extraFee,
        }),
      ).toBe(rate);
    }
    expect(launch2DynamicWadBps((13n * wad) / 100n)).toBe(1300);
    expect(
      launch2DynamicWadBps(
        launch2DynamicEffectiveRateWad((6n * wad) / 10n, cap),
      ),
    ).toBe(2000);
    expect(
      launch2DynamicWadBps(
        launch2DynamicEffectiveRateWad((6n * wad) / 10n, 0n),
      ),
    ).toBe(6000);
    // Rounding: the Hook floors extra, so the realized rate is at most one
    // wei of rate below min(drop, cap).
    const oddGross = 123_456_789_123n;
    const oddBase = 2_469_135_782n;
    const drop = 333_333_333_333_333_333n;
    const extraFee = launch2DynamicSellExtraFee({
      gross: oddGross,
      baseFee: oddBase,
      dropWad: drop,
      maxDynamicFeeWad: 0n,
    });
    const realized = launch2DynamicRealizedRateWad({
      grossQuote: oddGross,
      baseFee: oddBase,
      extraFee,
    });
    expect(realized <= drop).toBe(true);
    expect(drop - realized <= wad / (oddGross - oddBase) + 1n).toBe(true);
    expect(
      launch2DynamicSellExtraFee({
        gross: 1n,
        baseFee: 1n,
        dropWad: drop,
        maxDynamicFeeWad: 0n,
      }),
    ).toBe(0n);
    expect(
      launch2DynamicRealizedRateWad({
        grossQuote: 1n,
        baseFee: 1n,
        extraFee: 0n,
      }),
    ).toBe(0n);
  });

  it("inverts the output fee and splits a sell from two simulations", () => {
    const ppm = 20_000n;
    for (const gross of [1n, 49n, 50n, 16_000n * wad, 123_456_789n]) {
      const net = gross - (gross * ppm) / 1_000_000n;
      const recovered = launch2DynamicGrossOfNet(net, ppm);
      expect(recovered - (recovered * ppm) / 1_000_000n).toBe(net);
      expect(recovered >= gross).toBe(true);
    }
    expect(launch2DynamicBps(20_000n)).toBe(200);
    expect(
      launch2DynamicSellSplit({
        netActual: (686n * wad) / 10n,
        netNeutral: 98n * wad,
        baseSellFeePpm: ppm,
      }),
    ).toEqual({
      gross: 100n * wad,
      baseFee: 2n * wad,
      dynamicFee: (294n * wad) / 10n,
      dynamicTaxBps: 3000,
    });
    expect(
      launch2DynamicClaimable({
        allocation: 30n * wad,
        weight: 100n * wad,
        totalBuyWeight: 300n * wad,
      }),
    ).toBe(10n * wad);
    expect(
      launch2DynamicClaimable({
        allocation: 1n,
        weight: 1n,
        totalBuyWeight: 0n,
      }),
    ).toBe(0n);
  });

  it("maps contract errors to reason codes with zh-CN copy for each", () => {
    expect(classifyLaunch2DynamicRevert("UnauthorizedRouter")).toEqual({
      code: "VALIDATION_FAILED",
      reasonCode: "LAUNCH2_DYNAMIC_ROUTER_UNAUTHORIZED",
    });
    expect(classifyLaunch2DynamicRevert("Busy")?.code).toBe("DATA_STALE");
    expect(classifyLaunch2DynamicRevert("RoundNotClosed")?.reasonCode).toBe(
      "LAUNCH2_DYNAMIC_ROUND_NOT_CLOSED",
    );
    expect(classifyLaunch2DynamicRevert("AlreadyClaimed")?.code).toBe(
      "RESOURCE_CONFLICT",
    );
    expect(classifyLaunch2DynamicRevert("Whatever")).toBeNull();
    for (const code of Object.values(launch2DynamicReasonCodes)) {
      expect(launch2DynamicReasonMessagesZh[code]).toMatch(/[一-鿿]/u);
    }
  });

  it("names LoopDynamic buyback refusals for the keeper", () => {
    expect(classifyLaunch2BuybackRevert("NotGraduated")).toMatchObject({
      code: "LAUNCH2_BUYBACK_NOT_GRADUATED",
      category: "not_graduated",
    });
    expect(classifyLaunch2BuybackRevert("Busy").code).toBe(
      "LAUNCH2_BUYBACK_HOOK_BUSY",
    );
    expect(classifyLaunch2BuybackRevert("UnauthorizedRouter").code).toBe(
      "LAUNCH2_BUYBACK_ROUTER_UNAUTHORIZED",
    );
    expect(classifyLaunch2BuybackRevert("PartialFill")).toMatchObject({
      code: "LAUNCH2_BUYBACK_CONTRACT_REVERTED",
      detail: "PartialFill",
    });
  });

  it("encodes claim(roundId) and poke()", () => {
    expect(
      decodeFunctionData({
        abi: loopDynamicHookAbi,
        data: encodeLaunch2DynamicClaim(7n),
      }),
    ).toMatchObject({ functionName: "claim", args: [7n] });
    expect(
      decodeFunctionData({
        abi: loopDynamicHookAbi,
        data: encodeLaunch2DynamicPoke(),
      }).functionName,
    ).toBe("poke");
  });
});

describe("LoopDynamic template hash (loop-contracts S165, Decision 0009 §13)", () => {
  const params = {
    router: "0x1111111111111111111111111111111111111111",
    baseSellFeePpm: 20_000,
    baseFeeRecipient: "0x2222222222222222222222222222222222222222",
    priceTiming: 1,
    routingPolicy: 1,
    routerRegistryAdmin: "0x3333333333333333333333333333333333333333",
    excludeBuybackFromRewards: true,
    buyFeePpm: 20_000,
  } as const;

  it("equals the Factory formula (vector computed with cast abi-encode + keccak)", () => {
    expect(hooksLaunchTemplateHash).toBe(
      "0x4c5eeccd13cb2cc9f25a99513883917517a4516665e6caed4abe9af70bc351ca",
    );
    expect(hooksLaunchLoopDynamicTemplateHash(params)).toBe(
      "0x32ceb3c3fbed16119dd0219a72b43205c5b9a5c88722819a3b80861217d23fd9",
    );
    expect(
      hooksLaunchLoopDynamicTemplateHash({ ...params, buyFeePpm: 10_000 }),
    ).not.toBe(hooksLaunchLoopDynamicTemplateHash(params));
  });

  it("appends uint256 maxDynamicFeeWad for an S193 Factory (Decision 0144, loop-contracts 0012 §3)", () => {
    // Vectors: cast keccak $(cast abi-encode "f(bytes32,uint8,address,
    // uint24,address,uint8,uint8,address,bool,uint24,uint256)" …).
    expect(
      hooksLaunchLoopDynamicTemplateHash({ ...params, maxDynamicFeeWad: "0" }),
    ).toBe(
      "0xa0dce14c6763911f2bda8e2cd2e22ab8dd97ea6f9ca73c1d15b68abaea23a2d1",
    );
    expect(
      hooksLaunchLoopDynamicTemplateHash({
        ...params,
        maxDynamicFeeWad: "200000000000000000",
      }),
    ).toBe(
      "0x79099800919dff67131a5082465c35cd4e589a581825e65084a8fa2eb26b102e",
    );
    // A cap of 0 still adds the zero word: not the S165 hash.
    expect(
      hooksLaunchLoopDynamicTemplateHash({ ...params, maxDynamicFeeWad: "0" }),
    ).not.toBe(hooksLaunchLoopDynamicTemplateHash(params));
    for (const bad of ["1000000000000000000", "-1", "01", "0.2", ""]) {
      expect(() =>
        hooksLaunchLoopDynamicTemplateHash({
          ...params,
          maxDynamicFeeWad: bad,
        }),
      ).toThrow(InvalidHooksLaunchDraftError);
    }
  });

  it("binds the Hook parameters into the configHash only for loopDynamic", () => {
    const draft = {
      name: "Project",
      ticker: "MEME",
      logoAssetUrl: "https://example.com/logo.png",
      description: "Test",
      links: [],
      nftSaleStartAt: "1900000000",
      buybackRecipient: "0x3333333333333333333333333333333333333333",
    };
    const policy = {
      nowUnixSeconds: "1800000000",
      minimumLeadSeconds: 86_400,
      nftSaleDurationSeconds: 604_800,
    };
    const official = parseHooksLaunchDraft(draft, policy);
    const dynamic = parseHooksLaunchDraft(draft, {
      ...policy,
      loopDynamic: params,
    });
    expect(official.templateHash).toBe(hooksLaunchTemplateHash);
    expect("poolHookKind" in official).toBe(false);
    expect(dynamic.templateHash).toBe(
      hooksLaunchLoopDynamicTemplateHash(params),
    );
    expect(dynamic.poolHookKind).toBe("loopDynamic");
    expect(dynamic.fixedEconomics).toMatchObject({
      officialPoolBuyTaxBps: 200,
      officialPoolSellTaxBps: 200,
      officialPoolHookKind: "loopDynamic",
      loopDynamic: { buyFeePpm: 20_000, priceTiming: "POST_SWAP" },
    });
    expect(dynamic.configHash).not.toBe(official.configHash);
    const cheaper = parseHooksLaunchDraft(draft, {
      ...policy,
      loopDynamic: { ...params, buyFeePpm: 10_000 },
    });
    expect(cheaper.configHash).not.toBe(dynamic.configHash);
    // Decision 0144: an S165 template's JSON has no cap key (its configHash
    // is unchanged); an S193 one carries it, and the cap is signed.
    expect(
      "maxDynamicFeeWad" in
        ((dynamic.fixedEconomics as Record<string, unknown>)[
          "loopDynamic"
        ] as object),
    ).toBe(false);
    const capped = parseHooksLaunchDraft(draft, {
      ...policy,
      loopDynamic: { ...params, maxDynamicFeeWad: "200000000000000000" },
    });
    expect(capped.templateHash).toBe(
      "0x79099800919dff67131a5082465c35cd4e589a581825e65084a8fa2eb26b102e",
    );
    expect(capped.fixedEconomics).toMatchObject({
      loopDynamic: { maxDynamicFeeWad: "200000000000000000" },
    });
    expect(capped.configHash).not.toBe(dynamic.configHash);
    const uncapped = parseHooksLaunchDraft(draft, {
      ...policy,
      loopDynamic: { ...params, maxDynamicFeeWad: "0" },
    });
    expect(uncapped.configHash).not.toBe(capped.configHash);
    expect(uncapped.configHash).not.toBe(dynamic.configHash);
  });
});

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000076 LoopDynamic migration contract (Decision 0131)", () => {
  it("adds the LoopDynamic events, facts, projections and the claim intent kind without rewriting rows", () => {
    const statement = captureSql(up);
    for (const name of [
      "LoopHookBound",
      "SellFeeCharged",
      "BuyFeeCharged",
      "CandleClosed",
      "EmptyCandlesSkipped",
      "RoundActivated",
      "RoundClosed",
      "BuyCredited",
      "BuyNotCredited",
      "RewardClaimed",
    ]) {
      expect(statement).toContain(`'${name}'`);
    }
    for (const table of [
      "launch2_dynamic_hook_bindings",
      "launch2_dynamic_fees",
      "launch2_dynamic_candles",
      "launch2_dynamic_claims",
      "launch2_dynamic_rounds",
      "launch2_dynamic_buy_weights",
      "launch2_dynamic_claim_reports",
    ]) {
      expect(statement).toContain(`create table public.${table} (`);
    }
    expect(statement).toContain(
      "add column pool_hook_kind text generated always as",
    );
    expect(statement).toContain(
      "check (kind in ('nft_mint', 'buy', 'sell', 'pool_buy', 'pool_sell', 'dynamic_claim'))",
    );
    expect(statement).not.toContain("update public.");
    expect(statement).not.toContain("delete from");
  });

  it("refuses to roll back over LoopDynamic evidence", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "raise exception 'refusing to remove LoopDynamic evidence'",
    );
    expect(statement).toContain(
      "check (kind in ('nft_mint', 'buy', 'sell', 'pool_buy', 'pool_sell'))",
    );
  });
});

describe("000086 LoopDynamic delivery attribution migration (Decision 0146)", () => {
  it("admits CreditMoved, adds the entry projection and the merged weight columns", () => {
    const statement = captureSql(up86);
    expect(statement).toContain(
      "'BuyFeeCharged', 'RewardClaimed',\n        'CreditMoved'))",
    );
    expect(statement).toContain(
      "create table public.launch2_dynamic_credit_entries (",
    );
    expect(statement).toContain(
      "'loopRouter', 'registryRouter', 'delivery', 'moved', 'unknown'",
    );
    expect(statement).toContain(
      "update public.launch2_dynamic_buy_weights set credited_usd1 = weight_usd1;",
    );
    expect(statement).toContain(
      "weight_usd1 = credited_usd1 + moved_in_usd1 - moved_out_usd1",
    );
    expect(statement).not.toContain("delete from");
  });

  it("refuses to roll back over an indexed CreditMoved", () => {
    const statement = captureSql(down86);
    expect(statement).toContain(
      "raise exception 'refusing to remove LoopDynamic CreditMoved evidence'",
    );
    expect(statement).toContain(
      "drop table public.launch2_dynamic_credit_entries;",
    );
    expect(statement).not.toContain("'CreditMoved'))");
  });
});

describe("LoopDynamic Factory list and poke lane (Decision 0131)", () => {
  it("indexes the LoopDynamic Factory after the others and refuses a duplicate", () => {
    const current = "0x5555555555555555555555555555555555555555";
    const dynamic = "0x6666666666666666666666666666666666666666";
    expect(
      launch2FactoryEntries({ current, legacy: [], dynamic }).map((entry) => [
        entry.address,
        entry.generation,
      ]),
    ).toEqual([
      [current, "v3"],
      [dynamic, "v3"],
    ]);
    expect(() =>
      launch2FactoryEntries({ current, legacy: [], dynamic: current }),
    ).toThrow(/LAUNCH2_DYNAMIC_FACTORY_ADDRESS/u);
  });

  it("pokes only an armed Hook whose candle ended, after a passing simulation", async () => {
    const hookA = `0x${"a".repeat(40)}`;
    const hookB = `0x${"b".repeat(40)}`;
    const instance = (id: string, hook: string | null) =>
      ({
        instanceId: id,
        holdReason: null,
        dynamicHook: hook,
      }) as unknown as Launch2LaneInstance;
    const sent: string[] = [];
    const chain: Launch2DynamicPokeChain = {
      pokerAddress: `0x${"9".repeat(40)}`,
      chainId: () => Promise.resolve(97),
      readPokeState: (hook) =>
        Promise.resolve({
          armed: hook === hookA,
          initialized: true,
          candleId: 100n,
          blockTimestamp: 101n * 300n,
        }),
      simulatePoke: () => Promise.resolve(null),
      sendPoke: (hook) => {
        sent.push(hook);
        return Promise.resolve({
          transactionHash: `0x${"1".repeat(64)}`,
          status: "success",
        });
      },
    };
    const steps: unknown[] = [];
    const lane = createLaunch2DynamicPokeLane({
      repository: {
        listLaneInstances: () =>
          Promise.resolve([
            instance("a", hookA),
            instance("b", hookB),
            instance("c", null),
          ]),
      },
      chain,
      chainId: "eip155:97",
      intervalSeconds: 60,
      onStep: (step) => steps.push(step),
    });
    expect(await lane.runOnce()).toEqual({
      kind: "advanced",
      checked: 2,
      poked: 1,
    });
    expect(sent).toEqual([hookA]);
    expect(steps).toEqual([
      expect.objectContaining({ instanceId: "a", outcome: "poked" }),
    ]);
    const wrongChain = createLaunch2DynamicPokeLane({
      repository: { listLaneInstances: () => Promise.resolve([]) },
      chain: { ...chain, chainId: () => Promise.resolve(56) },
      chainId: "eip155:97",
      intervalSeconds: 60,
    });
    expect(await wrongChain.runOnce()).toMatchObject({
      reasonCode: "LAUNCH2_CHAIN_MISMATCH",
    });
  });
});
