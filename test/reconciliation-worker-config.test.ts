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
  it("keeps authoritative provider reads disabled by default", () => {
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
      hyperliquidReconciliationReads: null,
      hyperliquidSpotReconciliationReads: null,
      spotAgentLifecycleMaintenanceEnabled: true,
      issuanceRateRecordCleanupEnabled: true,
      serviceName: "loop-reconciliation-worker",
      serviceVersion: "0.1.0",
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("loads the explicit Testnet reconciliation read capability", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_RECONCILIATION_READS_ENABLED"] = "true";
    environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"] = "q".repeat(32);
    environment["HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE"] = "720";

    expect(loadReconciliationWorkerConfig(environment)).toMatchObject({
      hyperliquidReconciliationReads: {
        quotaHmacSecret: "q".repeat(32),
        policyVersion: "hyperliquid_info_v1",
        windowDurationSeconds: 60,
        weightCapacity: 720,
      },
      hyperliquidSpotReconciliationReads: null,
    });
  });

  it("keeps the independent Perp capability off when only Spot reads are enabled", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED"] = "true";
    environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"] = "s".repeat(32);
    environment["HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE"] = "840";

    expect(loadReconciliationWorkerConfig(environment)).toMatchObject({
      hyperliquidReconciliationReads: null,
      hyperliquidSpotReconciliationReads: {
        quotaHmacSecret: "s".repeat(32),
        policyVersion: "hyperliquid_info_v1",
        windowDurationSeconds: 60,
        weightCapacity: 840,
      },
    });
  });

  it("binds enabled Perp and Spot readers to the same quota capability", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_RECONCILIATION_READS_ENABLED"] = "true";
    environment["HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED"] = "true";
    environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"] = "b".repeat(32);
    environment["HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE"] = "900";

    const config = loadReconciliationWorkerConfig(environment);

    expect(config.hyperliquidReconciliationReads).not.toBeNull();
    expect(config.hyperliquidSpotReconciliationReads).toBe(
      config.hyperliquidReconciliationReads,
    );
    expect(config.hyperliquidSpotReconciliationReads).toEqual({
      quotaHmacSecret: "b".repeat(32),
      policyVersion: "hyperliquid_info_v1",
      windowDurationSeconds: 60,
      weightCapacity: 900,
    });
  });

  it("fails closed when reconciliation reads lack a strong quota secret", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_RECONCILIATION_READS_ENABLED"] = "true";

    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      /Hyperliquid reconciliation reads require HYPERLIQUID_INFO_QUOTA_HMAC_SECRET/,
    );

    environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"] = "too-short";
    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      /HYPERLIQUID_INFO_QUOTA_HMAC_SECRET/,
    );
  });

  it("fails closed when Spot reconciliation reads lack a strong quota secret", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED"] = "true";

    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      /Hyperliquid Spot reconciliation reads require HYPERLIQUID_INFO_QUOTA_HMAC_SECRET/,
    );

    environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"] = "too-short";
    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      /HYPERLIQUID_INFO_QUOTA_HMAC_SECRET/,
    );
  });

  it("rejects a malformed reconciliation switch independently of the API flag", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_RECONCILIATION_READS_ENABLED"] = "malformed";

    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      ConfigurationError,
    );
  });

  it("rejects a malformed Spot reconciliation switch independently of the Perp switch", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_RECONCILIATION_READS_ENABLED"] = "false";
    environment["HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED"] = "malformed";

    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      ConfigurationError,
    );
  });

  it("allows the database-only Agent lifecycle maintenance to be disabled", () => {
    const environment = validEnvironment();
    environment["SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED"] = "false";

    expect(loadReconciliationWorkerConfig(environment)).toMatchObject({
      spotAgentLifecycleMaintenanceEnabled: false,
    });

    environment["SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED"] = "malformed";
    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      ConfigurationError,
    );
  });

  it("allows issuance quota cleanup to be paused without changing retention", () => {
    const environment = validEnvironment();
    environment["ISSUANCE_RATE_RECORD_CLEANUP_ENABLED"] = "false";

    expect(loadReconciliationWorkerConfig(environment)).toMatchObject({
      issuanceRateRecordCleanupEnabled: false,
    });

    environment["ISSUANCE_RATE_RECORD_CLEANUP_ENABLED"] = "malformed";
    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      ConfigurationError,
    );
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
