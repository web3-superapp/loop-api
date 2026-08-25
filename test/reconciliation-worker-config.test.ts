import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadReconciliationWorkerConfig,
} from "../src/config.js";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
  };
}

describe("loadReconciliationWorkerConfig", () => {
  it("loads only database and logging configuration", () => {
    const environment = validEnvironment();
    environment["PRIVY_APP_ID"] = "partial-provider-configuration";
    environment["STREAM_API_SECRET"] = "not-for-this-process";
    environment["HYPERLIQUID_PRIVATE_READS_ENABLED"] = "malformed";

    const config = loadReconciliationWorkerConfig(environment);

    expect(config).toEqual({
      nodeEnv: "test",
      logLevel: "silent",
      databaseUrl:
        "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
      databasePoolMax: 10,
      databaseConnectionTimeoutMs: 3_000,
      databaseStatementTimeoutMs: 5_000,
      serviceName: "loop-reconciliation-worker",
      serviceVersion: "0.1.0",
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("validates worker database pool and timeout overrides", () => {
    const environment = validEnvironment();
    environment["DATABASE_POOL_MAX"] = "4";
    environment["DATABASE_CONNECTION_TIMEOUT_MS"] = "750";
    environment["DATABASE_STATEMENT_TIMEOUT_MS"] = "1200";

    expect(loadReconciliationWorkerConfig(environment)).toMatchObject({
      databasePoolMax: 4,
      databaseConnectionTimeoutMs: 750,
      databaseStatementTimeoutMs: 1_200,
    });
  });

  it("fails closed without leaking a rejected database password", () => {
    const environment = validEnvironment();
    environment["DATABASE_URL"] =
      "https://loop_api:do-not-log-me@example.com/private";

    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      /DATABASE_URL: protocol must be postgres or postgresql/,
    );

    try {
      loadReconciliationWorkerConfig(environment);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).not.toContain("do-not-log-me");
    }
  });
});
