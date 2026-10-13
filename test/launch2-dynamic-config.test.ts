import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadReconciliationWorkerConfig,
} from "../src/config.js";

/**
 * Decision 0131: the worker's LoopDynamic keys — the indexed LoopDynamic
 * Factory, the poke() keeper (default off), and the executor's refusal of
 * HOOKS_LAUNCH_HOOK_KIND=loopDynamic.
 */

const base = {
  DATABASE_URL: "postgres://loop:loop@127.0.0.1:5432/loop_test",
  LAUNCH_CHAIN_ID: "97",
  LAUNCH_BSC_RPC_URLS: "https://bsc-testnet.example/rpc",
  HOOKS_LAUNCH_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
  HOOKS_LAUNCH_FACTORY_CODE_HASH: `0x${"ab".repeat(32)}`,
};
const key = `0x${"42".repeat(32)}`;

function refusal(overrides: Record<string, string>): string {
  try {
    loadReconciliationWorkerConfig({ ...base, ...overrides });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    const text = String((error as Error).message) + JSON.stringify(error);
    expect(text).not.toContain("42".repeat(32));
    return text;
  }
  throw new Error("expected a refusal");
}

describe("LoopDynamic worker configuration (Decision 0131)", () => {
  it("is off by default", () => {
    const config = loadReconciliationWorkerConfig({
      ...base,
      LAUNCH2_INDEXER_ENABLED: "true",
    });
    expect(config.launch2DynamicPoke).toBeNull();
    expect(config.launch2Indexer?.dynamicFactoryAddress).toBeNull();
  });

  it("indexes the LoopDynamic Factory pair and enables the poke keeper with a key", () => {
    const config = loadReconciliationWorkerConfig({
      ...base,
      LAUNCH2_INDEXER_ENABLED: "true",
      LAUNCH2_DYNAMIC_FACTORY_ADDRESS:
        "0x6666666666666666666666666666666666666666",
      LAUNCH2_DYNAMIC_FACTORY_CODE_HASH: `0x${"cd".repeat(32)}`,
      LAUNCH2_DYNAMIC_POKE_ENABLED: "true",
      LAUNCH2_DYNAMIC_POKE_PRIVATE_KEY: key,
    });
    expect(config.launch2Indexer?.dynamicFactoryAddress).toBe(
      "0x6666666666666666666666666666666666666666",
    );
    expect(config.launch2DynamicPoke).toEqual({
      privateKey: key,
      intervalSeconds: 60,
    });
  });

  it("refuses a half pair, a poke keeper without a key or off testnet, and the executor with loopDynamic", () => {
    expect(
      refusal({
        LAUNCH2_DYNAMIC_FACTORY_ADDRESS:
          "0x6666666666666666666666666666666666666666",
      }),
    ).toContain("LAUNCH2_DYNAMIC_FACTORY_CODE_HASH");
    expect(refusal({ LAUNCH2_DYNAMIC_POKE_ENABLED: "true" })).toContain(
      "LAUNCH2_DYNAMIC_POKE_PRIVATE_KEY",
    );
    expect(
      refusal({
        LAUNCH2_DYNAMIC_POKE_ENABLED: "true",
        LAUNCH2_DYNAMIC_POKE_PRIVATE_KEY: key,
        LAUNCH_CHAIN_ID: "56",
        LAUNCH_BSC_RPC_URLS: "",
        HOOKS_LAUNCH_FACTORY_ADDRESS: "",
        HOOKS_LAUNCH_FACTORY_CODE_HASH: "",
      }),
    ).toContain("LAUNCH_CHAIN_ID=97");
    expect(
      refusal({
        HOOKS_LAUNCH_EXECUTOR_ENABLED: "on",
        HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: key,
        HOOKS_LAUNCH_HOOK_KIND: "loopDynamic",
      }),
    ).toContain("HOOKS_LAUNCH_HOOK_KIND=loopDynamic");
    expect(
      loadReconciliationWorkerConfig({
        ...base,
        HOOKS_LAUNCH_EXECUTOR_ENABLED: "on",
        HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: key,
      }).hooksLaunchExecutor,
    ).not.toBeNull();
  });
});
