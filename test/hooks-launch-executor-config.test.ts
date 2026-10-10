import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadReconciliationWorkerConfig,
} from "../src/config.js";

/** Decision 0112: the executor switch, its key, and boot refusal. */

const base = {
  DATABASE_URL: "postgres://loop:loop@127.0.0.1:5432/loop_test",
  LAUNCH_CHAIN_ID: "97",
  LAUNCH_BSC_RPC_URLS: "https://bsc-testnet.example/rpc",
  HOOKS_LAUNCH_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
  HOOKS_LAUNCH_FACTORY_CODE_HASH: `0x${"ab".repeat(32)}`,
};
const key = `0x${"42".repeat(32)}`;

describe("HOOKS_LAUNCH_EXECUTOR_* configuration", () => {
  it("is off by default", () => {
    expect(loadReconciliationWorkerConfig(base).hooksLaunchExecutor).toBeNull();
    expect(
      loadReconciliationWorkerConfig({ DATABASE_URL: base.DATABASE_URL })
        .hooksLaunchExecutor,
    ).toBeNull();
  });

  it("applies the documented defaults when enabled", () => {
    const config = loadReconciliationWorkerConfig({
      ...base,
      HOOKS_LAUNCH_EXECUTOR_ENABLED: "on",
      HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: key,
    }).hooksLaunchExecutor;
    expect(config).toMatchObject({
      factoryAddress: base.HOOKS_LAUNCH_FACTORY_ADDRESS,
      factoryCodeHash: base.HOOKS_LAUNCH_FACTORY_CODE_HASH,
      confirmations: 3,
      pollIntervalMs: 5_000,
      leaseSeconds: 120,
      maxAttempts: 3,
      retryDelaySeconds: 60,
      gasLimitCap: 16_000_000,
      maxGasPriceGwei: 20,
    });
  });

  it.each([
    ["without a key", {}, "HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY"],
    [
      "with a malformed key",
      { HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: "0x1234" },
      "HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY",
    ],
    [
      "without the Factory pair",
      {
        HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: key,
        HOOKS_LAUNCH_FACTORY_ADDRESS: "",
        HOOKS_LAUNCH_FACTORY_CODE_HASH: "",
      },
      "HOOKS_LAUNCH_FACTORY_ADDRESS",
    ],
    [
      "on BSC Mainnet",
      {
        HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: key,
        LAUNCH_CHAIN_ID: "56",
        LAUNCH_BSC_RPC_URLS: "",
        HOOKS_LAUNCH_FACTORY_ADDRESS: "",
        HOOKS_LAUNCH_FACTORY_CODE_HASH: "",
      },
      "LAUNCH_CHAIN_ID=97",
    ],
  ] as const)("refuses boot when enabled %s", (_name, overrides, message) => {
    let thrown: unknown;
    try {
      loadReconciliationWorkerConfig({
        ...base,
        HOOKS_LAUNCH_EXECUTOR_ENABLED: "on",
        ...overrides,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect(
      String((thrown as Error).message) + JSON.stringify(thrown),
    ).toContain(message);
    expect(JSON.stringify(thrown)).not.toContain("42".repeat(32));
  });

  it("refuses an unknown switch value", () => {
    expect(() =>
      loadReconciliationWorkerConfig({
        ...base,
        HOOKS_LAUNCH_EXECUTOR_ENABLED: "true",
      }),
    ).toThrow(ConfigurationError);
  });
});
