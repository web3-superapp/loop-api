import { describe, expect, it } from "vitest";

import { hooksLaunchLoopDynamicTemplateHash } from "../src/features/launch/hooks-launch-config.js";
import {
  HooksLaunchFactoryTemplateMismatchError,
  createHooksLaunchExecutor,
  type HooksLaunchExecutorChain,
  type HooksLaunchExecutorPolicy,
} from "../src/features/launch/hooks-launch-executor.js";
import {
  hooksLaunchLoopDynamicVerificationChecks,
  verifyHooksLaunchLoopDynamicDeployment,
} from "../src/features/launch/hooks-launch-loop-dynamic-verification.js";
import { verifyHooksLaunchDeployment } from "../src/features/launch/hooks-launch-verification.js";
import {
  loopDynamicLaunchFactoryAbi,
  loopLaunchFactoryAbi,
} from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
import { toEventSelector, toFunctionSelector, type AbiFunction } from "viem";
import {
  expectedDeployment,
  factoryCodeHash,
  fakeChain,
  fakeRepository,
  nowSeconds,
  passingFacts,
  signedPayload,
} from "./helpers/hooks-launch-executor-fixtures.js";
import {
  loopDynamicBindingHash,
  loopDynamicHookAddress,
  loopDynamicLaunchDeployedEvent,
  loopDynamicSignedPayload,
  loopDynamicTemplate,
  passingLoopDynamicFacts,
  s193LoopDynamicParams,
  s193TestnetManifestTemplateHash,
  testnetLoopDynamicParams,
  testnetLoopDynamicTemplateHash,
} from "./helpers/hooks-launch-loop-dynamic-fixtures.js";

/**
 * Decision 0132: the deployment executor on a LoopDynamic Factory — the
 * template preflight, the signature over the Factory's TEMPLATE_HASH, the
 * LoopDynamic read-back verification — and the OfficialTax path unchanged.
 */

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

async function setup(
  options: {
    readonly template?: () => Promise<{
      readonly params: typeof testnetLoopDynamicParams;
      readonly templateHash: string;
    }>;
    readonly officialSignature?: boolean;
    readonly chainKind?: "officialTax" | "loopDynamic";
  } = {},
) {
  const payload =
    options.officialSignature === true
      ? await signedPayload(nowSeconds + 900)
      : await loopDynamicSignedPayload(nowSeconds + 900);
  const store = fakeRepository({ payload });
  store.task.hookAddress = loopDynamicHookAddress;
  store.task.bindingHash = loopDynamicBindingHash(payload);
  const fake = fakeChain();
  const facts = { current: passingLoopDynamicFacts() };
  const chain: HooksLaunchExecutorChain = {
    ...fake.chain,
    hookKind: options.chainKind ?? "loopDynamic",
    loopDynamicTemplate:
      options.template ?? (() => Promise.resolve(loopDynamicTemplate)),
    async receipt(hash) {
      const receipt = await fake.chain.receipt(hash);
      return receipt === null || receipt.launchDeployed === null
        ? receipt
        : { ...receipt, launchDeployed: loopDynamicLaunchDeployedEvent() };
    },
    readLaunch: () => Promise.resolve(facts.current),
  };
  const executor = createHooksLaunchExecutor({
    repository: store.repository,
    chain,
    policy,
    executorId: "hooks-executor:test:1",
    now: () => nowSeconds,
  });
  return { store, fake, executor, facts };
}

describe("LoopDynamic template (Decision 0132)", () => {
  it("reproduces the testnet Factory's TEMPLATE_HASH from its manifest parameters", () => {
    expect(
      hooksLaunchLoopDynamicTemplateHash(
        testnetLoopDynamicParams,
      ).toLowerCase(),
    ).toBe(testnetLoopDynamicTemplateHash);
  });

  it("reproduces the S193 testnet Factory's TEMPLATE_HASH (11 fields, cap 0.2e18) from its manifest parameters (Decision 0144)", () => {
    expect(
      hooksLaunchLoopDynamicTemplateHash(s193LoopDynamicParams).toLowerCase(),
    ).toBe(s193TestnetManifestTemplateHash);
    // The cap is bound: the same parameters uncapped / without it differ.
    expect(
      hooksLaunchLoopDynamicTemplateHash({
        ...s193LoopDynamicParams,
        maxDynamicFeeWad: "0",
      }).toLowerCase(),
    ).not.toBe(s193TestnetManifestTemplateHash);
  });

  it("shares deployLaunch / activateLaunch / launchModules / LaunchDeployed bytes with the OfficialTax Factory", () => {
    for (const name of [
      "deployLaunch",
      "activateLaunch",
      "launchModules",
      "launchIdByOwnerVersion",
      "nonces",
      "deploymentExecutor",
      "activationBufferSeconds",
    ]) {
      const official = loopLaunchFactoryAbi.find(
        (item) => item.type === "function" && item.name === name,
      ) as AbiFunction;
      const dynamic = loopDynamicLaunchFactoryAbi.find(
        (item) => item.type === "function" && item.name === name,
      ) as AbiFunction;
      expect(toFunctionSelector(dynamic), name).toBe(
        toFunctionSelector(official),
      );
      expect(JSON.stringify(dynamic.outputs), name).toBe(
        JSON.stringify(official.outputs),
      );
    }
    const event = (abi: readonly { type: string; name?: string }[]) =>
      abi.find(
        (item) => item.type === "event" && item.name === "LaunchDeployed",
      ) as Parameters<typeof toEventSelector>[0];
    expect(toEventSelector(event(loopDynamicLaunchFactoryAbi))).toBe(
      toEventSelector(event(loopLaunchFactoryAbi)),
    );
  });
});

describe("Hooks deployment executor on a LoopDynamic Factory (Decision 0132)", () => {
  it("deploys, verifies the LoopDynamic modules and activates", async () => {
    const { store, fake, executor } = await setup();
    await executor.runOnce();
    expect(store.task.status).toBe("broadcast");
    fake.mine(3);
    await executor.runOnce();
    expect(store.task.status).toBe("verified");
    fake.mine(3);
    await executor.runOnce();
    expect(store.task.status).toBe("activated");
    const verified = store.events.find((event) => event.kind === "verified");
    expect(verified?.details).toMatchObject({
      checks: hooksLaunchLoopDynamicVerificationChecks.length,
      nftSaleDurationSeconds: 3_600,
    });
  });

  it("stays idle when the Factory template does not reproduce, and backs off on a transport failure", async () => {
    const mismatch = await setup({
      template: () =>
        Promise.reject(new HooksLaunchFactoryTemplateMismatchError()),
    });
    const idle = await mismatch.executor.runOnce();
    expect(idle.idleReason).toBe("HOOKS_FACTORY_TEMPLATE_MISMATCH");
    expect(mismatch.store.task.status).toBe("awaiting_executor");
    const malformed = await setup({
      template: () =>
        Promise.resolve({
          params: testnetLoopDynamicParams,
          templateHash: "0x",
        }),
    });
    expect((await malformed.executor.runOnce()).idleReason).toBe(
      "HOOKS_FACTORY_TEMPLATE_MISMATCH",
    );
    const down = await setup({
      template: () => Promise.reject(new Error("rpc down")),
    });
    await expect(down.executor.runOnce()).rejects.toThrow("rpc down");
    expect(down.store.task.status).toBe("awaiting_executor");
  });

  it("stays idle when the chain client and the policy name different Hook kinds", async () => {
    const { store, executor } = await setup({ chainKind: "officialTax" });
    const result = await executor.runOnce();
    expect(result.idleReason).toBe("HOOKS_FACTORY_TEMPLATE_MISMATCH");
    expect(store.events).toHaveLength(0);
  });

  it("refuses a signature over the OfficialTax template (wrong TEMPLATE_HASH)", async () => {
    const { store, fake, executor } = await setup({ officialSignature: true });
    await executor.runOnce();
    expect(store.task).toMatchObject({
      status: "failed",
      failureCode: "HOOKS_AUTHORIZATION_INVALID",
    });
    expect(fake.state.sent).toHaveLength(0);
  });

  it("never activates a launch whose read-back fails a LoopDynamic check", async () => {
    const { store, fake, executor, facts } = await setup();
    const passing = passingLoopDynamicFacts();
    facts.current = {
      ...passing,
      hookFactory:
        passing.hookFactory === null
          ? null
          : { ...passing.hookFactory, buyFeePpm: 30_000 },
    };
    await executor.runOnce();
    fake.mine(3);
    await executor.runOnce();
    expect(store.task).toMatchObject({
      status: "failed",
      failureCode: "HOOKS_VERIFICATION_MISMATCH",
    });
    const failed = store.events.find((event) => event.kind === "failed");
    expect(failed?.details).toMatchObject({
      failedChecks: ["hook_factory_params"],
    });
  });

  it("fails verification when OfficialTax facts come back for a LoopDynamic task", async () => {
    const { store, fake, executor, facts } = await setup();
    (facts as { current: unknown }).current = passingFacts();
    await executor.runOnce();
    fake.mine(3);
    await executor.runOnce();
    expect(store.task.failureCode).toBe("HOOKS_VERIFICATION_MISMATCH");
  });
});

describe("LoopDynamic read-back verification (Decision 0132)", () => {
  const expected = () => ({
    ...expectedDeployment(),
    predictedHookAddress: loopDynamicHookAddress,
  });

  it("binds an S193 Factory's cap: the Hook factory's maxDynamicFeeWad must be the signed one (Decision 0144)", () => {
    // The fixture's facts (S165 router) with the S193 cap added.
    const params = {
      ...testnetLoopDynamicParams,
      maxDynamicFeeWad: "200000000000000000",
    };
    const template = {
      params,
      templateHash: hooksLaunchLoopDynamicTemplateHash(params).toLowerCase(),
    };
    const s193Facts = (maxDynamicFeeWad: string | null) => {
      const facts = passingLoopDynamicFacts();
      return {
        ...facts,
        factory: { ...facts.factory, templateHash: template.templateHash },
        hookFactory:
          facts.hookFactory === null
            ? null
            : { ...facts.hookFactory, maxDynamicFeeWad },
      };
    };
    const run = (maxDynamicFeeWad: string | null) =>
      verifyHooksLaunchLoopDynamicDeployment({
        expected: expected(),
        template,
        event: loopDynamicLaunchDeployedEvent(),
        facts: s193Facts(maxDynamicFeeWad),
      }).failedChecks;
    expect(run("200000000000000000")).toEqual([]);
    expect(run("100000000000000000")).toEqual(["hook_factory_params"]);
    expect(run("0")).toEqual(["hook_factory_params"]);
    // A Hook factory without the getter (S165) under an S193 template.
    expect(run(null)).toEqual(["hook_factory_params"]);
    // And an S165 template whose Hook factory answers a cap.
    const facts = passingLoopDynamicFacts();
    expect(
      verifyHooksLaunchLoopDynamicDeployment({
        expected: expected(),
        template: loopDynamicTemplate,
        event: loopDynamicLaunchDeployedEvent(),
        facts: {
          ...facts,
          hookFactory:
            facts.hookFactory === null
              ? null
              : { ...facts.hookFactory, maxDynamicFeeWad: "0" },
        },
      }).failedChecks,
    ).toEqual(["hook_factory_params"]);
  });

  it("passes every check for the fixture", () => {
    const result = verifyHooksLaunchLoopDynamicDeployment({
      expected: expected(),
      template: loopDynamicTemplate,
      event: loopDynamicLaunchDeployedEvent(),
      facts: passingLoopDynamicFacts(),
    });
    expect(result.failedChecks).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it.each([
    [
      "a Hook in the event",
      { event: { hook: loopDynamicHookAddress } },
      "launch_event",
    ],
    [
      "a Hook address with OfficialTax bits",
      { expected: { predictedHookAddress: `0x${"ce".repeat(18)}20cc` } },
      "hook_permission_bits",
    ],
    [
      "an unregistered salt",
      { launch: { saltRegistered: false } },
      "hook_salt_registered",
    ],
    [
      "a Factory with another template",
      { factory: { templateHash: `0x${"11".repeat(32)}` } },
      "factory_template",
    ],
    [
      "a pool key with a Hook",
      { poolHooks: loopDynamicHookAddress },
      "pool_key",
    ],
    [
      "a buyback adapter on another router",
      { buybackRouter: "0x9999999999999999999999999999999999999999" },
      "buyback_adapter_params",
    ],
    [
      "a price recorder",
      { priceRecorder: "0x9999999999999999999999999999999999999999" },
      "module_code_present",
    ],
  ] as const)("fails on %s", (_name, patch, check) => {
    const facts = passingLoopDynamicFacts();
    const p = patch as Record<string, unknown>;
    const modified = {
      ...facts,
      factory: { ...facts.factory, ...(p["factory"] as object) },
      modules:
        facts.modules === null
          ? null
          : {
              ...facts.modules,
              ...(p["priceRecorder"] === undefined
                ? {}
                : { priceRecorder: p["priceRecorder"] as string }),
              poolKey: {
                ...facts.modules.poolKey,
                ...(p["poolHooks"] === undefined
                  ? {}
                  : { hooks: p["poolHooks"] as string }),
              },
            },
      buybackAdapter:
        facts.buybackAdapter === null
          ? null
          : {
              ...facts.buybackAdapter,
              ...(p["buybackRouter"] === undefined
                ? {}
                : { router: p["buybackRouter"] as string }),
            },
      hookFactory:
        facts.hookFactory === null
          ? null
          : {
              ...facts.hookFactory,
              launch: {
                ...facts.hookFactory.launch,
                ...(p["launch"] as object),
              },
            },
    };
    const result = verifyHooksLaunchLoopDynamicDeployment({
      expected: { ...expected(), ...(p["expected"] as object) },
      template: loopDynamicTemplate,
      event: { ...loopDynamicLaunchDeployedEvent(), ...(p["event"] as object) },
      facts: modified,
    });
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain(check);
  });

  it("leaves the OfficialTax verifier byte-identical on its fixture", () => {
    const result = verifyHooksLaunchDeployment({
      expected: expectedDeployment(),
      event: {
        ...loopDynamicLaunchDeployedEvent(),
        hook: expectedDeployment().predictedHookAddress,
      },
      facts: passingFacts(),
    });
    expect(result.passed).toBe(true);
  });
});
