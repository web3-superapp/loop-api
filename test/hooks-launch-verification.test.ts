import { describe, expect, it } from "vitest";

import {
  expectedGraduationSqrtPriceX96,
  hooksLaunchVerificationChecks,
  verifyHooksLaunchDeployment,
  type HooksLaunchOnChainFacts,
} from "../src/features/launch/hooks-launch-verification.js";
import {
  expectedDeployment,
  launchDeployedEvent,
  passingFacts,
} from "./helpers/hooks-launch-executor-fixtures.js";

/** Decision 0112: the read-back checks that gate activation. */

function verify(
  mutate: (facts: HooksLaunchOnChainFacts) => HooksLaunchOnChainFacts,
  event: ReturnType<typeof launchDeployedEvent> | null = launchDeployedEvent(),
) {
  return verifyHooksLaunchDeployment({
    expected: expectedDeployment(),
    event,
    facts: mutate(passingFacts()),
  });
}

describe("Hooks launch module verification (Decision 0112)", () => {
  it("passes every check for a faithful deployment", () => {
    const result = verify((facts) => facts);
    expect(result.failedChecks).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.passedChecks).toEqual(hooksLaunchVerificationChecks);
  });

  it.each([
    [
      "factory_code_hash",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        factoryCodeHash: `0x${"00".repeat(32)}`,
      }),
    ],
    [
      "deployer_code_hashes",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        factory: {
          ...f.factory,
          deployers: f.factory.deployers.map((d, i) =>
            i === 2 ? { ...d, actualCodeHash: null } : d,
          ),
        },
      }),
    ],
    [
      "meme_suffix_6666",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        modules: { ...f.modules!, meme: `0x${"ab".repeat(18)}6667` },
      }),
    ],
    [
      "hook_permission_bits",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        modules: { ...f.modules!, officialHook: `0x${"cd".repeat(18)}20cd` },
      }),
    ],
    [
      "meme_supply",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        meme: { ...f.meme!, totalSupply: 1n },
      }),
    ],
    [
      "meme_allocation",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        meme: { ...f.meme!, curveBalance: 0n },
      }),
    ],
    [
      "curve_taxes",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        curve: { ...f.curve!, sellTaxBps: 999n },
      }),
    ],
    [
      "curve_caps",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        curve: { ...f.curve!, maxCumulativeBuy: 1n },
      }),
    ],
    [
      "curve_untouched",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        curve: { ...f.curve!, soldSupply: 1n },
      }),
    ],
    [
      "graduation_reserve",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        hook: { ...f.hook!, expectedInitialSqrtPriceX96: 1n },
      }),
    ],
    [
      "hook_params",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        hook: { ...f.hook!, taxBps: 300n },
      }),
    ],
    [
      "pool_key",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        modules: {
          ...f.modules!,
          poolKey: { ...f.modules!.poolKey, fee: 3_000 },
        },
      }),
    ],
    [
      "gate_params",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        gate: { ...f.gate!, nftSaleStart: 1n },
      }),
    ],
    [
      "gate_unpublished",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        gate: { ...f.gate!, published: true },
      }),
    ],
    [
      "nft_params",
      (f: HooksLaunchOnChainFacts) => ({ ...f, nft: { ...f.nft!, price: 1n } }),
    ],
    [
      "escrow_bindings",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        escrow: { ...f.escrow!, projectNft: `0x${"99".repeat(20)}` },
      }),
    ],
    [
      "buyback_params",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        buyback: { ...f.buyback!, recipient: `0x${"99".repeat(20)}` },
      }),
    ],
    [
      "adapter_params",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        adapter: { ...f.adapter!, projectBound: false },
      }),
    ],
    [
      "snapshot_params",
      (f: HooksLaunchOnChainFacts) => ({
        ...f,
        snapshots: { ...f.snapshots!, nftSaleEnd: 1n },
      }),
    ],
  ] as const)("fails %s when that fact differs", (check, mutate) => {
    const result = verify(mutate);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain(check);
  });

  it("fails without the LaunchDeployed event or the registered launch", () => {
    expect(verify((f) => f, null).failedChecks).toEqual(["launch_event"]);
    const missing = verify((f) => ({ ...f, modules: null }));
    expect(missing.failedChecks).toEqual(
      expect.arrayContaining(["launch_registered", "modules_identity"]),
    );
  });

  it("derives the graduation price from the 133,333.332 USD1 reserve", () => {
    const template = expectedGraduationSqrtPriceX96({ memeIsCurrency0: false });
    expect(
      expectedGraduationSqrtPriceX96({
        memeIsCurrency0: false,
        graduationReserve: 133_333_333_000_000_000_000_000n,
      }),
    ).not.toBe(template);
    expect(expectedGraduationSqrtPriceX96({ memeIsCurrency0: true })).not.toBe(
      template,
    );
  });

  describe("Decision 0119: the sale period is the Factory's nftSaleDuration()", () => {
    const run = (facts: HooksLaunchOnChainFacts) =>
      verifyHooksLaunchDeployment({
        expected: expectedDeployment(),
        event: launchDeployedEvent(),
        facts,
      });
    const withNft = (
      facts: HooksLaunchOnChainFacts,
      nft: Partial<NonNullable<HooksLaunchOnChainFacts["nft"]>>,
      snapshotEnd?: bigint,
    ): HooksLaunchOnChainFacts => ({
      ...facts,
      nft: { ...facts.nft!, ...nft },
      snapshots:
        snapshotEnd === undefined
          ? facts.snapshots
          : { ...facts.snapshots!, nftSaleEnd: snapshotEnd },
    });
    const start = expectedDeployment().nftSaleStart;

    it.each([
      ["a 1-hour testnet Factory", 3_600n],
      ["the 7-day mainnet Factory", 604_800n],
    ] as const)("passes %s whose NFT matches it", (_label, saleDuration) => {
      const result = run(passingFacts({ saleDuration }));
      expect(result.failedChecks).toEqual([]);
      expect(result.passed).toBe(true);
    });

    it("fails a 7-day NFT under a 1-hour Factory (and the reverse)", () => {
      const hourly = passingFacts({ saleDuration: 3_600n });
      const sevenDayNft = run(
        withNft(
          hourly,
          { saleDuration: 604_800n, saleEnd: start + 604_800n },
          start + 604_800n,
        ),
      );
      expect(sevenDayNft.failedChecks).toEqual([
        "nft_params",
        "snapshot_params",
      ]);
      const weekly = passingFacts({ saleDuration: 604_800n });
      const hourNft = run(
        withNft(weekly, { saleDuration: 3_600n, saleEnd: start + 3_600n }),
      );
      expect(hourNft.failedChecks).toEqual(["nft_params"]);
    });

    it("checks saleEnd and the registry cutoff against start + the Factory period", () => {
      const hourly = passingFacts({ saleDuration: 3_600n });
      expect(
        run(withNft(hourly, { saleEnd: start + 3_601n })).failedChecks,
      ).toEqual(["nft_params"]);
      expect(run(withNft(hourly, {}, start + 604_800n)).failedChecks).toEqual([
        "snapshot_params",
      ]);
    });

    it("refuses a Factory period outside 3,600..604,800 s even if the NFT agrees", () => {
      for (const saleDuration of [3_599n, 604_801n, 0n]) {
        expect(run(passingFacts({ saleDuration })).failedChecks).toEqual([
          "nft_params",
          "snapshot_params",
        ]);
      }
    });

    it("treats a pre-S141 Factory (no nftSaleDuration()) as 7 days", () => {
      expect(
        run(passingFacts({ saleDuration: 604_800n, legacy: true })).passed,
      ).toBe(true);
      // A legacy flag with a non-7-day reading is incoherent: fail closed.
      expect(
        run(passingFacts({ saleDuration: 3_600n, legacy: true })).failedChecks,
      ).toEqual(["nft_params", "snapshot_params"]);
    });
  });
});
