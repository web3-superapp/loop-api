import { describe, expect, it, vi } from "vitest";

import {
  loadReconciliationWorkerConfig,
  type ReconciliationWorkerConfig,
} from "../src/config.js";
import type { PerpReconciliationRepository } from "../src/features/perp/perp-reconciliation-contract.js";
import type { SpotReconciliationRepository } from "../src/features/spot/spot-reconciliation-contract.js";
import {
  createReconciliationWorkerReaders,
  type ReconciliationWorkerReaderDatabase,
} from "../src/reconciliation-worker-readers.js";

interface WorkerConfigOptions {
  readonly perpEnabled?: boolean;
  readonly spotEnabled?: boolean;
}

function workerConfig(options: WorkerConfigOptions = {}) {
  const perpEnabled = options.perpEnabled ?? false;
  const spotEnabled = options.spotEnabled ?? false;
  const anyReadsEnabled = perpEnabled || spotEnabled;
  return loadReconciliationWorkerConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    HYPERLIQUID_RECONCILIATION_READS_ENABLED: perpEnabled ? "true" : "false",
    HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED: spotEnabled
      ? "true"
      : "false",
    ...(anyReadsEnabled
      ? { HYPERLIQUID_INFO_QUOTA_HMAC_SECRET: "q".repeat(32) }
      : {}),
  });
}

function perpRepository(): PerpReconciliationRepository {
  return {
    loadClaimedSubject: vi.fn(),
    finalizeOrderResolution: vi.fn(),
  } satisfies PerpReconciliationRepository;
}

function spotRepository(): SpotReconciliationRepository {
  return {
    quarantineExpiredSubmissions:
      vi.fn<SpotReconciliationRepository["quarantineExpiredSubmissions"]>(),
    leaseProviderOperationsForReconciliation:
      vi.fn<
        SpotReconciliationRepository["leaseProviderOperationsForReconciliation"]
      >(),
    completeProviderOperationReconciliation:
      vi.fn<
        SpotReconciliationRepository["completeProviderOperationReconciliation"]
      >(),
    rescheduleProviderOperationReconciliation:
      vi.fn<
        SpotReconciliationRepository["rescheduleProviderOperationReconciliation"]
      >(),
    holdProviderOperationForOperator:
      vi.fn<SpotReconciliationRepository["holdProviderOperationForOperator"]>(),
    loadClaimedSpotIntentSubject:
      vi.fn<SpotReconciliationRepository["loadClaimedSpotIntentSubject"]>(),
    finalizeSpotIntentResolution:
      vi.fn<SpotReconciliationRepository["finalizeSpotIntentResolution"]>(),
  } satisfies SpotReconciliationRepository;
}

function expectAtomicHandler(
  registry: ReturnType<typeof createReconciliationWorkerReaders>,
  operationKind: "perp_intent" | "spot_intent",
): void {
  const handler = registry.find("hyperliquid", operationKind);
  expect(handler?.mode).toBe("atomic_domain");
  expect(
    handler?.mode === "atomic_domain" ? typeof handler.run : "missing",
  ).toBe("function");
}

describe("reconciliation worker authoritative-reader composition", () => {
  it("constructs no provider capability or dependency when both switches are off", () => {
    const inaccessibleDatabase: ReconciliationWorkerReaderDatabase = {
      get controlPlane(): never {
        throw new Error("disabled composition accessed the control plane");
      },
      get perpReconciliation(): never {
        throw new Error("disabled composition accessed the Perp repository");
      },
      get spotReconciliation(): never {
        throw new Error("disabled composition accessed the Spot repository");
      },
    };

    const registry = createReconciliationWorkerReaders({
      config: workerConfig(),
      database: inaccessibleDatabase,
    });

    expect(registry.find("hyperliquid", "perp_intent")).toBeUndefined();
    expect(registry.find("hyperliquid", "spot_intent")).toBeUndefined();
  });

  it("registers only Perp and never accesses the disabled Spot repository", () => {
    const database: ReconciliationWorkerReaderDatabase = {
      controlPlane: { consumeIssuanceQuota: vi.fn() },
      perpReconciliation: perpRepository(),
      get spotReconciliation(): never {
        throw new Error("Perp-only composition accessed the Spot repository");
      },
    };

    const registry = createReconciliationWorkerReaders({
      config: workerConfig({ perpEnabled: true }),
      database,
    });

    expectAtomicHandler(registry, "perp_intent");
    expect(registry.find("hyperliquid", "spot_intent")).toBeUndefined();
  });

  it("registers only Spot and never accesses the disabled Perp repository", () => {
    const database: ReconciliationWorkerReaderDatabase = {
      controlPlane: { consumeIssuanceQuota: vi.fn() },
      get perpReconciliation(): never {
        throw new Error("Spot-only composition accessed the Perp repository");
      },
      spotReconciliation: spotRepository(),
    };

    const registry = createReconciliationWorkerReaders({
      config: workerConfig({ spotEnabled: true }),
      database,
    });

    expect(registry.find("hyperliquid", "perp_intent")).toBeUndefined();
    expectAtomicHandler(registry, "spot_intent");
  });

  it("registers both reviewed atomic handlers against one shared quota policy", () => {
    const config = workerConfig({ perpEnabled: true, spotEnabled: true });
    const database: ReconciliationWorkerReaderDatabase = {
      controlPlane: { consumeIssuanceQuota: vi.fn() },
      perpReconciliation: perpRepository(),
      spotReconciliation: spotRepository(),
    };

    expect(config.hyperliquidReconciliationReads).not.toBeNull();
    expect(config.hyperliquidSpotReconciliationReads).toBe(
      config.hyperliquidReconciliationReads,
    );

    const registry = createReconciliationWorkerReaders({ config, database });

    expectAtomicHandler(registry, "perp_intent");
    expectAtomicHandler(registry, "spot_intent");
    expect(
      registry.find("future_provider", "future_operation"),
    ).toBeUndefined();
  });

  it.each([
    ["secret", { quotaHmacSecret: "x".repeat(32) }],
    ["policy", { policyVersion: "hyperliquid_info_v2" }],
    ["window", { windowDurationSeconds: 30 }],
    ["capacity", { weightCapacity: 719 }],
  ] as const)(
    "fails before dependency access when enabled readers carry a conflicting quota %s",
    (_conflictKind, capabilityOverride) => {
      const validConfig = workerConfig({
        perpEnabled: true,
        spotEnabled: true,
      });
      const spotCapability = validConfig.hyperliquidSpotReconciliationReads;
      if (spotCapability === null) {
        throw new Error("test fixture failed to enable Spot reads");
      }
      const conflictingConfig = Object.freeze({
        ...validConfig,
        hyperliquidSpotReconciliationReads: Object.freeze({
          ...spotCapability,
          ...capabilityOverride,
        }),
      }) as unknown as ReconciliationWorkerConfig;
      const inaccessibleDatabase: ReconciliationWorkerReaderDatabase = {
        get controlPlane(): never {
          throw new Error("conflict validation accessed the control plane");
        },
        get perpReconciliation(): never {
          throw new Error("conflict validation accessed the Perp repository");
        },
        get spotReconciliation(): never {
          throw new Error("conflict validation accessed the Spot repository");
        },
      };

      expect(() =>
        createReconciliationWorkerReaders({
          config: conflictingConfig,
          database: inaccessibleDatabase,
        }),
      ).toThrowError(/quota capabilities conflict/);
    },
  );
});
