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
});
