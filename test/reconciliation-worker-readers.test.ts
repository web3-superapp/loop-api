import { describe, expect, it, vi } from "vitest";

import { loadReconciliationWorkerConfig } from "../src/config.js";
import type { PerpReconciliationRepository } from "../src/features/perp/perp-reconciliation-contract.js";
import { createReconciliationWorkerReaders } from "../src/reconciliation-worker-readers.js";

function workerConfig(enabled: boolean) {
  return loadReconciliationWorkerConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    HYPERLIQUID_RECONCILIATION_READS_ENABLED: enabled ? "true" : "false",
    ...(enabled ? { HYPERLIQUID_INFO_QUOTA_HMAC_SECRET: "q".repeat(32) } : {}),
  });
}

describe("reconciliation worker authoritative-reader composition", () => {
  it("constructs no provider capability or dependency while disabled", () => {
    const inaccessibleDatabase = Object.defineProperties(
      {},
      {
        controlPlane: {
          get(): never {
            throw new Error("disabled composition accessed the control plane");
          },
        },
        perpReconciliation: {
          get(): never {
            throw new Error(
              "disabled composition accessed the Perp repository",
            );
          },
        },
      },
    );

    const registry = createReconciliationWorkerReaders({
      config: workerConfig(false),
      database: inaccessibleDatabase as never,
    });

    expect(registry.find("hyperliquid")).toBeUndefined();
  });

  it("registers only the reviewed atomic Hyperliquid handler when enabled", () => {
    const repository = {
      loadClaimedSubject: vi.fn(),
      finalizeOrderResolution: vi.fn(),
    } satisfies PerpReconciliationRepository;
    const registry = createReconciliationWorkerReaders({
      config: workerConfig(true),
      database: {
        controlPlane: { consumeIssuanceQuota: vi.fn() },
        perpReconciliation: repository,
      },
    });

    const handler = registry.find("hyperliquid");
    expect(handler?.mode).toBe("atomic_domain");
    expect(
      handler?.mode === "atomic_domain" ? typeof handler.run : "missing",
    ).toBe("function");
    expect(registry.find("future_provider")).toBeUndefined();
  });
});
