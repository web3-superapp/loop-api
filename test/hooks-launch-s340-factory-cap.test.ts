import {
  ContractFunctionZeroDataError,
  encodeAbiParameters,
  encodeEventTopics,
  toEventSelector,
  toFunctionSelector,
  type Abi,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  createAdminLaunchReviewConsoleService,
  type AdminLaunchFactoryPurchaseCapSource,
  type AdminLaunchReviewRepository,
} from "../src/features/admin/admin-launch-review.js";
import {
  hooksLaunchLoopDynamicFixedEconomics,
  hooksLaunchLoopDynamicGeneration,
  hooksLaunchLoopDynamicHookPermissionBits,
  hooksLaunchLoopDynamicTemplateHash,
  hooksLaunchFixedEconomicsFor,
  InvalidHooksLaunchDraftError,
  type HooksLaunchLoopDynamicParams,
} from "../src/features/launch/hooks-launch-config.js";
import {
  createHooksLaunchExecutor,
  HooksLaunchFactoryTemplateMismatchError,
  type HooksLaunchExecutorChain,
  type HooksLaunchExecutorPolicy,
  type HooksLaunchExecutorStepEvent,
} from "../src/features/launch/hooks-launch-executor.js";
import {
  verifyHooksLaunchLoopDynamicDeployment,
  type HooksLaunchLoopDynamicOnChainFacts,
} from "../src/features/launch/hooks-launch-loop-dynamic-verification.js";
import { launch2QuoteMaxBuy } from "../src/features/launch2/launch2-curve-math.js";
import {
  hooksLaunchFactoryCapAbi,
  hooksLaunchLaunchMaxCumulativeBuyTopic,
  hooksLaunchMaxCumulativeBuyUpdatedTopic,
  parseHooksLaunchMaxCumulativeBuyLog,
  parseHooksLaunchMaxCumulativeBuyUpdatedLog,
} from "../src/integrations/launch/hooks-launch-factory-cap-abi.js";
import {
  readHooksLaunchLoopDynamicTemplate,
  refreshHooksLaunchLoopDynamicCap,
} from "../src/integrations/launch/hooks-launch-factory-reader.js";
import {
  configHash,
  expectedDeployment,
  factoryAddress,
  factoryCodeHash,
  fakeChain,
  fakeRepository,
  modules,
  nowSeconds,
} from "./helpers/hooks-launch-executor-fixtures.js";
import {
  loopDynamicBindingHash,
  loopDynamicLaunchDeployedEvent,
  loopDynamicSignedPayload,
  passingLoopDynamicFacts,
  s200LoopDynamicParams,
  s200TestnetManifestTemplateHash,
  s209ContractsVectorTemplateHash,
  s209LoopDynamicParams,
  testnetLoopDynamicParams,
} from "./helpers/hooks-launch-loop-dynamic-fixtures.js";

/**
 * Decision 0195 (LOOP Decision 0268, loop-contracts Decision 0018, S340):
 * the LoopDynamic Factory's `maxCumulativeBuy` is admin-settable and left
 * `TEMPLATE_HASH`; every launch keeps its curve's cap. S209 Factories (cap
 * in the twelve-field hash) still verify unchanged.
 */

const wad = 10n ** 18n;
const fiveMillion = (5_000_000n * wad).toString(10);
const oneMillion = (1_000_000n * wad).toString(10);

/** The contracts' S340 default vector: S200 manifest parameters, 50 % fee cap. */
const s340DefaultVector =
  "0xe07e185951099a5b237192f2061fc5532d9d4f5e9e02e81de5433366b01049db";

const s340Params = (
  cap: string = fiveMillion,
  feeCap = "500000000000000000",
): HooksLaunchLoopDynamicParams =>
  Object.freeze({
    ...s200LoopDynamicParams,
    maxDynamicFeeWad: feeCap,
    maxCumulativeBuy: cap,
    maxCumulativeBuyAdjustable: true,
  });

describe("S340 template hash (Decision 0195)", () => {
  it("reproduces the contracts' S340 vectors with the single-parameter formula", () => {
    expect(hooksLaunchLoopDynamicTemplateHash(s340Params()).toLowerCase()).toBe(
      s340DefaultVector,
    );
    // The S200 manifest (20 % fee cap) hash is the same eleven-field formula.
    expect(
      hooksLaunchLoopDynamicTemplateHash(
        s340Params(fiveMillion, "200000000000000000"),
      ).toLowerCase(),
    ).toBe(s200TestnetManifestTemplateHash);
  });

  it("does not depend on the cap (admin-settable, not a template field)", () => {
    expect(hooksLaunchLoopDynamicTemplateHash(s340Params(oneMillion))).toBe(
      hooksLaunchLoopDynamicTemplateHash(s340Params(fiveMillion)),
    );
  });

  it("keeps the S209 two-parameter (twelve-field) hash for an S209 Factory", () => {
    expect(
      hooksLaunchLoopDynamicTemplateHash(s209LoopDynamicParams).toLowerCase(),
    ).toBe(s209ContractsVectorTemplateHash);
    // An S209 cap change is another template.
    expect(
      hooksLaunchLoopDynamicTemplateHash({
        ...s209LoopDynamicParams,
        maxCumulativeBuy: oneMillion,
      }).toLowerCase(),
    ).not.toBe(s209ContractsVectorTemplateHash);
  });

  it("names the generation and keeps 0x10CC / the USD1 buy fee for S340", () => {
    expect(hooksLaunchLoopDynamicGeneration(testnetLoopDynamicParams)).toBe(
      "s165",
    );
    expect(hooksLaunchLoopDynamicGeneration(s200LoopDynamicParams)).toBe(
      "s193",
    );
    expect(hooksLaunchLoopDynamicGeneration(s209LoopDynamicParams)).toBe(
      "s209",
    );
    expect(hooksLaunchLoopDynamicGeneration(s340Params())).toBe("s340");
    expect(hooksLaunchLoopDynamicHookPermissionBits(s340Params())).toBe(
      0x10ccn,
    );
    // Same fixedEconomics keys as S209 (no new key reaches the App codecs).
    const economics = hooksLaunchLoopDynamicFixedEconomics(
      hooksLaunchFixedEconomicsFor(3_600),
      s340Params(oneMillion),
    );
    const s209Economics = hooksLaunchLoopDynamicFixedEconomics(
      hooksLaunchFixedEconomicsFor(3_600),
      s209LoopDynamicParams,
    );
    expect(Object.keys(economics)).toEqual(Object.keys(s209Economics));
    expect(
      Object.keys(economics["loopDynamic"] as Record<string, unknown>),
    ).toEqual(
      Object.keys(s209Economics["loopDynamic"] as Record<string, unknown>),
    );
    expect(economics["perAddressLifetimeBuyCapRaw"]).toBe(oneMillion);
  });

  it("refuses the adjustable flag without a cap", () => {
    expect(() =>
      hooksLaunchLoopDynamicTemplateHash({
        ...s200LoopDynamicParams,
        maxCumulativeBuyAdjustable: true,
      }),
    ).toThrow(InvalidHooksLaunchDraftError);
  });
});

describe("S340 ABI fragments and events (Decision 0195)", () => {
  it("pins the selectors and topics loop-contracts Decision 0018 publishes", () => {
    const fn = (name: string) =>
      hooksLaunchFactoryCapAbi.find(
        (item) => item.type === "function" && item.name === name,
      ) as Parameters<typeof toFunctionSelector>[0];
    const ev = (name: string) =>
      hooksLaunchFactoryCapAbi.find(
        (item) => item.type === "event" && item.name === name,
      ) as Parameters<typeof toEventSelector>[0];
    expect(toFunctionSelector(fn("maxCumulativeBuy"))).toBe("0x4c4d8734");
    expect(toFunctionSelector(fn("setMaxCumulativeBuy"))).toBe("0xcfc64a43");
    expect(toEventSelector(ev("MaxCumulativeBuyUpdated"))).toBe(
      hooksLaunchMaxCumulativeBuyUpdatedTopic,
    );
    expect(hooksLaunchMaxCumulativeBuyUpdatedTopic).toMatch(
      /^0x05779db6[0-9a-f]+56e4cc$/u,
    );
    expect(toEventSelector(ev("LaunchMaxCumulativeBuy"))).toBe(
      hooksLaunchLaunchMaxCumulativeBuyTopic,
    );
    expect(hooksLaunchLaunchMaxCumulativeBuyTopic).toMatch(
      /^0xc6080497[0-9a-f]+c5fc2d$/u,
    );
  });

  const launchId = expectedDeployment().launchId;
  const capLog = (cap: bigint, address = factoryAddress) => ({
    address,
    topics: encodeEventTopics({
      abi: hooksLaunchFactoryCapAbi,
      eventName: "LaunchMaxCumulativeBuy",
      args: {
        launchId: launchId as `0x${string}`,
        curve: modules.curve as `0x${string}`,
      },
    }) as string[],
    data: encodeAbiParameters([{ type: "uint256" }], [cap]),
  });

  it("reads LaunchMaxCumulativeBuy of the Factory from a receipt", () => {
    expect(
      parseHooksLaunchMaxCumulativeBuyLog(
        [capLog(1_000_000n * wad)],
        factoryAddress.toUpperCase().replace("0X", "0x"),
      ),
    ).toEqual({
      launchId,
      curve: modules.curve.toLowerCase(),
      maxCumulativeBuy: 1_000_000n * wad,
    });
    // Another contract's log, or none (an S209 Factory): null.
    expect(
      parseHooksLaunchMaxCumulativeBuyLog(
        [capLog(1n, "0x9999999999999999999999999999999999999999")],
        factoryAddress,
      ),
    ).toBe(null);
    expect(parseHooksLaunchMaxCumulativeBuyLog([], factoryAddress)).toBe(null);
  });

  it("decodes MaxCumulativeBuyUpdated (previous 0 at construction)", () => {
    const log = (previous: bigint, next: bigint) => ({
      address: factoryAddress,
      topics: encodeEventTopics({
        abi: hooksLaunchFactoryCapAbi,
        eventName: "MaxCumulativeBuyUpdated",
      }) as string[],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        [previous, next],
      ),
    });
    expect(
      parseHooksLaunchMaxCumulativeBuyUpdatedLog(log(0n, 5_000_000n * wad)),
    ).toEqual({ previousCap: 0n, newCap: 5_000_000n * wad });
    expect(
      parseHooksLaunchMaxCumulativeBuyUpdatedLog(
        log(5_000_000n * wad, 1_000_000n * wad),
      ),
    ).toEqual({ previousCap: 5_000_000n * wad, newCap: 1_000_000n * wad });
    expect(
      parseHooksLaunchMaxCumulativeBuyUpdatedLog(capLog(1n) as never),
    ).toBe(null);
  });
});

const factory = "0xaf077cab35385027592f959aca185f815c3c5a5a";
const hookFactory = "0x1536992cfd3f8996f9d573cece3e08dead284d3b";
const registry = "0xbed2c2e1f9341c1a821182d8f96df98d52dfabe5";

function factoryReads(input: {
  readonly templateHash: string;
  readonly cap: bigint | null;
}) {
  const p = s200LoopDynamicParams;
  const values: Record<string, unknown> = {
    [`${factory}.hookKind`]: 1,
    [`${factory}.TEMPLATE_HASH`]: input.templateHash,
    [`${factory}.loopRouter`]: p.router,
    [`${factory}.loopHookDeploymentFactory`]: hookFactory,
    [`${factory}.routerRegistry`]: registry,
    ...(input.cap === null
      ? {}
      : { [`${factory}.maxCumulativeBuy`]: input.cap }),
    [`${hookFactory}.router`]: p.router,
    [`${hookFactory}.baseSellFeePpm`]: p.baseSellFeePpm,
    [`${hookFactory}.baseFeeRecipient`]: p.baseFeeRecipient,
    [`${hookFactory}.priceTiming`]: p.priceTiming,
    [`${hookFactory}.routingPolicy`]: p.routingPolicy,
    [`${hookFactory}.routerRegistry`]: registry,
    [`${hookFactory}.excludeBuybackFromRewards`]: p.excludeBuybackFromRewards,
    [`${hookFactory}.buyFeePpm`]: p.buyFeePpm,
    [`${hookFactory}.launchFactory`]: factory,
    [`${hookFactory}.maxDynamicFeeWad`]: 500_000_000_000_000_000n,
    [`${hookFactory}.REQUIRED_PERMISSION_MASK`]:
      input.cap === null ? 0x10c4n : 0x10ccn,
    [`${registry}.admin`]: p.routerRegistryAdmin,
  };
  return (address: string, _abi: Abi, name: string) => {
    const key = `${address.toLowerCase()}.${name}`;
    if (!(key in values)) {
      return Promise.reject(
        new ContractFunctionZeroDataError({ functionName: name }),
      );
    }
    return Promise.resolve(values[key]);
  };
}

describe("Factory template read by generation (Decision 0195)", () => {
  const s209Params50 = {
    ...s200LoopDynamicParams,
    maxDynamicFeeWad: "500000000000000000",
    maxCumulativeBuy: fiveMillion,
  };

  it("reads an S340 Factory (eleven-field TEMPLATE_HASH + cap getter) as adjustable", async () => {
    const read = await readHooksLaunchLoopDynamicTemplate(
      factoryReads({ templateHash: s340DefaultVector, cap: 5_000_000n * wad }),
      factory,
    );
    expect(read.templateHash).toBe(s340DefaultVector);
    expect(read.params.maxCumulativeBuyAdjustable).toBe(true);
    expect(read.params.maxCumulativeBuy).toBe(fiveMillion);
    // After a multisig change the template is the same; only the cap moved.
    const changed = await readHooksLaunchLoopDynamicTemplate(
      factoryReads({ templateHash: s340DefaultVector, cap: 1_000_000n * wad }),
      factory,
    );
    expect(changed.templateHash).toBe(s340DefaultVector);
    expect(changed.params.maxCumulativeBuy).toBe(oneMillion);
  });

  it("still reads an S209 (legacy) Factory with its two-parameter hash as immutable", async () => {
    const s209Hash =
      hooksLaunchLoopDynamicTemplateHash(s209Params50).toLowerCase();
    const read = await readHooksLaunchLoopDynamicTemplate(
      factoryReads({ templateHash: s209Hash, cap: 5_000_000n * wad }),
      factory,
    );
    expect(read.params).toEqual(s209Params50);
    expect(read.params.maxCumulativeBuyAdjustable).toBeUndefined();
    expect(read.templateHash).toBe(s209Hash);
  });

  it("refuses a hash that neither formula reproduces", async () => {
    await expect(
      readHooksLaunchLoopDynamicTemplate(
        factoryReads({
          templateHash: `0x${"12".repeat(32)}`,
          cap: 5_000_000n * wad,
        }),
        factory,
      ),
    ).rejects.toBeInstanceOf(HooksLaunchFactoryTemplateMismatchError);
    // An S209 Factory whose cap no longer matches its hash is not S340.
    await expect(
      readHooksLaunchLoopDynamicTemplate(
        factoryReads({
          templateHash: hooksLaunchLoopDynamicTemplateHash(s209Params50),
          cap: 1_000_000n * wad,
        }),
        factory,
      ),
    ).rejects.toBeInstanceOf(HooksLaunchFactoryTemplateMismatchError);
  });

  it("refreshes only an S340 cap on a cached template", async () => {
    const s340 = { params: s340Params(), templateHash: s340DefaultVector };
    const refreshed = await refreshHooksLaunchLoopDynamicCap(s340, () =>
      Promise.resolve(1_000_000n * wad),
    );
    expect(refreshed.params.maxCumulativeBuy).toBe(oneMillion);
    expect(refreshed.templateHash).toBe(s340DefaultVector);
    let reads = 0;
    const s209 = {
      params: s209LoopDynamicParams,
      templateHash: s209ContractsVectorTemplateHash,
    };
    expect(
      await refreshHooksLaunchLoopDynamicCap(s209, () => {
        reads += 1;
        return Promise.resolve(1n);
      }),
    ).toBe(s209);
    expect(reads).toBe(0);
    await expect(
      refreshHooksLaunchLoopDynamicCap(s340, () => Promise.resolve(0n)),
    ).rejects.toBeInstanceOf(HooksLaunchFactoryTemplateMismatchError);
    await expect(
      refreshHooksLaunchLoopDynamicCap(s340, () =>
        Promise.reject(
          new ContractFunctionZeroDataError({ functionName: "x" }),
        ),
      ),
    ).rejects.toBeInstanceOf(HooksLaunchFactoryTemplateMismatchError);
    await expect(
      refreshHooksLaunchLoopDynamicCap(s340, () =>
        Promise.reject(new Error("rpc down")),
      ),
    ).rejects.toThrow("rpc down");
  });
});

/** An S340 LoopDynamic launch on the testnet fixture Factory. */
const s340Hook = `0x${"ce".repeat(18)}10cc`;
const testnetS340 = (cap: string): HooksLaunchLoopDynamicParams =>
  Object.freeze({
    ...testnetLoopDynamicParams,
    maxDynamicFeeWad: "500000000000000000",
    maxCumulativeBuy: cap,
    maxCumulativeBuyAdjustable: true,
  });
const s340TemplateHash = hooksLaunchLoopDynamicTemplateHash(
  testnetS340(fiveMillion),
).toLowerCase();

function s340Facts(input: {
  readonly factoryCap: bigint;
  readonly curveCap: bigint;
}): HooksLaunchLoopDynamicOnChainFacts {
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
      templateHash: s340TemplateHash,
      maxCumulativeBuy: input.factoryCap,
    },
    curve: { ...facts.curve, maxCumulativeBuy: input.curveCap },
    adapter: { ...facts.adapter, hookPermissions: 0x10ccn },
    hookFactory: {
      ...facts.hookFactory,
      maxDynamicFeeWad: "500000000000000000",
      requiredPermissionMask: 0x10ccn,
      predictedHook: s340Hook,
    },
  };
}

describe("S340 launch verification (Decision 0195)", () => {
  const expected = { ...expectedDeployment(), predictedHookAddress: s340Hook };
  const capEvent = (cap: bigint) => ({
    launchId: expected.launchId,
    curve: modules.curve.toLowerCase(),
    maxCumulativeBuy: cap,
  });
  const run = (
    facts: HooksLaunchLoopDynamicOnChainFacts,
    event: ReturnType<typeof capEvent> | null,
    factoryCapNow = fiveMillion,
  ) =>
    verifyHooksLaunchLoopDynamicDeployment({
      expected,
      template: {
        params: testnetS340(factoryCapNow),
        templateHash: s340TemplateHash,
      },
      event: loopDynamicLaunchDeployedEvent(),
      capEvent: event,
      facts,
    }).failedChecks;

  it("passes with the curve's own cap equal to the receipt's LaunchMaxCumulativeBuy", () => {
    expect(
      run(
        s340Facts({ factoryCap: 5_000_000n * wad, curveCap: 5_000_000n * wad }),
        capEvent(5_000_000n * wad),
      ),
    ).toEqual([]);
  });

  it("keeps an earlier launch valid after the multisig lowers the Factory default", () => {
    // Launch A deployed at 5,000,000 MEME; the Factory now says 1,000,000.
    expect(
      run(
        s340Facts({ factoryCap: 1_000_000n * wad, curveCap: 5_000_000n * wad }),
        capEvent(5_000_000n * wad),
        oneMillion,
      ),
    ).toEqual([]);
    // Launch B deployed after the change carries the new value.
    expect(
      run(
        s340Facts({ factoryCap: 1_000_000n * wad, curveCap: 1_000_000n * wad }),
        capEvent(1_000_000n * wad),
        oneMillion,
      ),
    ).toEqual([]);
  });

  it("refuses a missing, foreign or different LaunchMaxCumulativeBuy, and an out-of-range curve cap", () => {
    const facts = s340Facts({
      factoryCap: 5_000_000n * wad,
      curveCap: 5_000_000n * wad,
    });
    expect(run(facts, null)).toEqual(["curve_caps"]);
    expect(run(facts, capEvent(1_000_000n * wad))).toEqual(["curve_caps"]);
    expect(
      run(facts, {
        ...capEvent(5_000_000n * wad),
        launchId: `0x${"1".repeat(64)}`,
      }),
    ).toEqual(["curve_caps"]);
    expect(
      run(facts, {
        ...capEvent(5_000_000n * wad),
        curve: "0x9999999999999999999999999999999999999999",
      }),
    ).toEqual(["curve_caps"]);
    expect(
      run(
        s340Facts({ factoryCap: 5_000_000n * wad, curveCap: 0n }),
        capEvent(0n),
      ),
    ).toEqual(["curve_caps"]);
  });

  it("quotes each launch by its own curve cap, never the Factory's", () => {
    const curve = {
      published: true,
      graduated: false,
      earlyRoundEndsAt: 1n,
      soldSupply: 0n,
      accountedReserve: 0n,
      blockTimestamp: 2n,
    };
    expect(
      launch2QuoteMaxBuy({ ...curve, maxCumulativeBuy: 5_000_000n * wad }, 0n)
        .quotaRemaining,
    ).toBe(5_000_000n * wad);
    expect(
      launch2QuoteMaxBuy({ ...curve, maxCumulativeBuy: 1_000_000n * wad }, 0n)
        .quotaRemaining,
    ).toBe(1_000_000n * wad);
  });
});

describe("executor on an S340 Factory (Decision 0195)", () => {
  const policy: HooksLaunchExecutorPolicy = {
    hookKind: "loopDynamic",
    factoryCodeHash,
    confirmations: 3,
    maxAttempts: 3,
    retryDelaySeconds: 60,
    gasLimitCap: 16_000_000n,
    maxGasPriceWei: 20_000_000_000n,
    deadlineMarginSeconds: 60,
    activationMarginSeconds: 120,
    tasksPerTick: 8,
  };

  async function setup(input: {
    readonly signedCap: string;
    readonly factoryCap: { current: bigint };
    readonly emitCapEvent?: boolean;
  }) {
    const payload = await loopDynamicSignedPayload(
      nowSeconds + 900,
      s340TemplateHash,
    );
    const store = fakeRepository({
      payload,
      latestConfig: {
        version: 1,
        configHash,
        approvedHash: configHash,
        signedMaxCumulativeBuy: input.signedCap,
      },
    });
    store.task.hookAddress = s340Hook;
    store.task.bindingHash = loopDynamicBindingHash(payload, s340Hook);
    const fake = fakeChain();
    // The curve receives the Factory value of the deploy tick.
    let deployedCap: bigint | null = null;
    const verificationPatches: Record<string, unknown>[] = [];
    const repository = {
      ...store.repository,
      transition: (
        request: Parameters<typeof store.repository.transition>[0],
      ) => {
        if (request.patch.verification) {
          verificationPatches.push({ ...request.patch.verification });
        }
        return store.repository.transition(request);
      },
    };
    const steps: HooksLaunchExecutorStepEvent[] = [];
    const chain: HooksLaunchExecutorChain = {
      ...fake.chain,
      hookKind: "loopDynamic",
      loopDynamicTemplate: () =>
        Promise.resolve({
          params: testnetS340(input.factoryCap.current.toString(10)),
          templateHash: s340TemplateHash,
        }),
      async signDeploy(call, tx) {
        deployedCap = input.factoryCap.current;
        return fake.chain.signDeploy(call, tx);
      },
      async receipt(hash) {
        const receipt = await fake.chain.receipt(hash);
        if (receipt === null || receipt.launchDeployed === null) return receipt;
        return {
          ...receipt,
          launchDeployed: loopDynamicLaunchDeployedEvent(),
          launchMaxCumulativeBuy:
            input.emitCapEvent === false || deployedCap === null
              ? null
              : {
                  launchId: expectedDeployment().launchId,
                  curve: modules.curve.toLowerCase(),
                  maxCumulativeBuy: deployedCap,
                },
        };
      },
      readLaunch: () =>
        Promise.resolve(
          s340Facts({
            factoryCap: input.factoryCap.current,
            curveCap: deployedCap ?? 0n,
          }),
        ),
    };
    const executor = createHooksLaunchExecutor({
      repository,
      chain,
      policy,
      executorId: "hooks-executor:test:1",
      now: () => nowSeconds,
      onStep: (step) => steps.push(step),
    });
    return { store, fake, executor, steps, verificationPatches };
  }

  it("records the Factory cap before the deploy and verifies the curve's", async () => {
    const factoryCap = { current: 5_000_000n * wad };
    const { store, fake, executor, steps, verificationPatches } = await setup({
      signedCap: fiveMillion,
      factoryCap,
    });
    await executor.runOnce();
    expect(store.task.status).toBe("broadcast");
    const broadcast = store.events.find((event) => event.kind === "broadcast");
    expect(broadcast?.details).toEqual({
      factoryMaxCumulativeBuy: fiveMillion,
      signedMaxCumulativeBuy: fiveMillion,
      nonce: "0",
    });
    fake.mine(3);
    await executor.runOnce();
    expect(store.task.status).toBe("verified");
    expect(verificationPatches.at(-1)).toMatchObject({
      curveMaxCumulativeBuy: fiveMillion,
      maxCumulativeBuyAdjustable: true,
      signedMaxCumulativeBuy: fiveMillion,
    });
    expect(verificationPatches.at(-1)).not.toHaveProperty(
      "maxCumulativeBuyChanged",
    );
    expect(steps.some((step) => step.noticeCode !== undefined)).toBe(false);
  });

  it("deploys with the new Factory value after a multisig change, logs a notice and does not block", async () => {
    // The project saved its config at 5,000,000; the multisig then set 1,000,000.
    const factoryCap = { current: 1_000_000n * wad };
    const { store, fake, executor, steps, verificationPatches } = await setup({
      signedCap: fiveMillion,
      factoryCap,
    });
    await executor.runOnce();
    const broadcast = store.events.find((event) => event.kind === "broadcast");
    expect(broadcast?.details).toEqual({
      factoryMaxCumulativeBuy: oneMillion,
      signedMaxCumulativeBuy: fiveMillion,
      maxCumulativeBuyChanged: true,
      nonce: "0",
    });
    expect(steps.find((step) => step.kind === "broadcast")?.noticeCode).toBe(
      "HOOKS_MAX_CUMULATIVE_BUY_CHANGED",
    );
    fake.mine(3);
    await executor.runOnce();
    expect(store.task.status).toBe("verified");
    expect(verificationPatches.at(-1)).toMatchObject({
      curveMaxCumulativeBuy: oneMillion,
      signedMaxCumulativeBuy: fiveMillion,
      maxCumulativeBuyChanged: true,
    });
    const verified = store.events.find((event) => event.kind === "verified");
    expect(verified?.details).toMatchObject({
      curveMaxCumulativeBuy: oneMillion,
      maxCumulativeBuyChanged: true,
    });
    expect(steps.find((step) => step.kind === "verified")?.noticeCode).toBe(
      "HOOKS_MAX_CUMULATIVE_BUY_CHANGED",
    );
    fake.mine(3);
    await executor.runOnce();
    expect(store.task.status).toBe("activated");
  });

  it("fails verification closed when the S340 receipt lacks LaunchMaxCumulativeBuy", async () => {
    const { store, fake, executor } = await setup({
      signedCap: fiveMillion,
      factoryCap: { current: 5_000_000n * wad },
      emitCapEvent: false,
    });
    await executor.runOnce();
    fake.mine(3);
    await executor.runOnce();
    expect(store.task.status).toBe("failed");
    expect(store.task.failureCode).toBe("HOOKS_VERIFICATION_MISMATCH");
    const failed = store.events.find((event) => event.kind === "failed");
    expect(failed?.details).toMatchObject({ failedChecks: ["curve_caps"] });
  });
});

describe("admin console Factory purchase cap (Decision 0195)", () => {
  const repository: AdminLaunchReviewRepository = {
    launchReadScopes: () => Promise.resolve(["*"]),
    listProjects: () => Promise.resolve([]),
    getProject: () => Promise.resolve(null),
    releaseSnapshotPublication: () => Promise.reject(new Error("unused")),
  };
  const warnings: Record<string, unknown>[] = [];
  const service = (source: AdminLaunchFactoryPurchaseCapSource | null) =>
    createAdminLaunchReviewConsoleService({
      repository,
      factoryPurchaseCap: source,
      deploymentChainId: 97,
      review: {} as never,
      audit: { appendAudit: () => Promise.reject(new Error("unused")) },
      sessionSecret: "s".repeat(32),
      logger: { warn: (context) => warnings.push(context) },
    });
  const context = {
    principal: {
      kind: "account",
      accountId: "00000000-0000-4000-8000-000000000001",
      username: "ops",
      role: "administrator",
      permissions: ["launch.read"],
      operatorUserId: null,
    },
    requestId: "req-1",
  } as never;

  it("answers the live value and generation on the list", async () => {
    const page = await service({
      factoryAddress: factoryAddress.toUpperCase().replace("0X", "0x"),
      read: () =>
        Promise.resolve({ maxCumulativeBuy: oneMillion, adjustable: true }),
    }).listProjects(context, {});
    expect(page["factoryPurchaseCap"]).toEqual({
      status: "available",
      factoryAddress,
      maxCumulativeBuy: oneMillion,
      adjustable: true,
    });
  });

  it("is unavailable (never a default number) without a reader, on failure or out of range", async () => {
    const none = await service(null).listProjects(context, {});
    expect(none["factoryPurchaseCap"]).toEqual({
      status: "unavailable",
      factoryAddress: null,
      maxCumulativeBuy: null,
      adjustable: null,
    });
    const down = await service({
      factoryAddress,
      read: () => Promise.reject(new Error("rpc down")),
    }).listProjects(context, {});
    expect(down["factoryPurchaseCap"]).toEqual({
      status: "unavailable",
      factoryAddress,
      maxCumulativeBuy: null,
      adjustable: null,
    });
    expect(warnings.at(-1)).toMatchObject({
      reasonCode: "ADMIN_FACTORY_PURCHASE_CAP_UNAVAILABLE",
    });
    const odd = await service({
      factoryAddress,
      read: () => Promise.resolve({ maxCumulativeBuy: "0", adjustable: true }),
    }).listProjects(context, {});
    expect((odd["factoryPurchaseCap"] as { status: string }).status).toBe(
      "unavailable",
    );
  });
});
