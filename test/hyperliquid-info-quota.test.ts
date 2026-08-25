import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ControlPlaneRepository } from "../src/database/control-plane-repository.js";
import {
  createPostgresHyperliquidInfoQuota,
  HYPERLIQUID_INFO_QUOTA_CAPABILITY,
  type HyperliquidInfoQuotaPolicy,
} from "../src/integrations/hyperliquid/info-quota.js";

const quotaHmacSecret = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 1,
);
const policy = Object.freeze({
  policyVersion: "hyperliquid_info_v1",
  windowDurationSeconds: 60,
  weightCapacity: 960,
}) satisfies HyperliquidInfoQuotaPolicy;

function dependencies() {
  const consumeIssuanceQuota = vi.fn<
    ControlPlaneRepository["consumeIssuanceQuota"]
  >(() => Promise.resolve([]));
  const quota = createPostgresHyperliquidInfoQuota({
    repository: { consumeIssuanceQuota },
    quotaHmacSecret,
    policy,
  });

  return { consumeIssuanceQuota, quota };
}

describe("PostgreSQL-backed Hyperliquid Info quota", () => {
  it("reserves the exact request weight in one domain-separated global bucket", async () => {
    const inputs = dependencies();

    await expect(
      inputs.quota.reserveWeight(120, new AbortController().signal),
    ).resolves.toBeUndefined();

    const expectedSubjectHmac = createHmac("sha256", quotaHmacSecret)
      .update("loop.hyperliquid.info.quota.v1\0global", "utf8")
      .digest("hex");
    expect(inputs.consumeIssuanceQuota).toHaveBeenCalledOnce();
    expect(inputs.consumeIssuanceQuota).toHaveBeenCalledWith({
      capability: HYPERLIQUID_INFO_QUOTA_CAPABILITY,
      policyVersion: "hyperliquid_info_v1",
      cost: 120,
      buckets: [
        {
          subjectKind: "global",
          subjectHmac: expectedSubjectHmac,
          windowDurationSeconds: 60,
          capacity: 960,
        },
      ],
    });
    expect(
      JSON.stringify(inputs.consumeIssuanceQuota.mock.calls[0]?.[0]),
    ).not.toContain(Array.from(quotaHmacSecret).join(","));
  });

  it("derives the bucket once so later caller mutation cannot change it", async () => {
    const mutableSecret = Uint8Array.from(quotaHmacSecret);
    const consumeIssuanceQuota = vi.fn<
      ControlPlaneRepository["consumeIssuanceQuota"]
    >(() => Promise.resolve([]));
    const quota = createPostgresHyperliquidInfoQuota({
      repository: { consumeIssuanceQuota },
      quotaHmacSecret: mutableSecret,
      policy,
    });
    mutableSecret.fill(0);

    await quota.reserveWeight(2, new AbortController().signal);

    expect(
      consumeIssuanceQuota.mock.calls[0]?.[0].buckets[0]?.subjectHmac,
    ).toBe(
      createHmac("sha256", quotaHmacSecret)
        .update("loop.hyperliquid.info.quota.v1\0global", "utf8")
        .digest("hex"),
    );
  });

  it("rejects an already-aborted request without consuming quota", async () => {
    const inputs = dependencies();
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      inputs.quota.reserveWeight(20, abortController.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(inputs.consumeIssuanceQuota).not.toHaveBeenCalled();
  });

  it("preserves an abort that occurs while PostgreSQL is reserving weight", async () => {
    const abortController = new AbortController();
    const consumeIssuanceQuota = vi.fn<
      ControlPlaneRepository["consumeIssuanceQuota"]
    >(() => {
      abortController.abort();
      return Promise.resolve([]);
    });
    const quota = createPostgresHyperliquidInfoQuota({
      repository: { consumeIssuanceQuota },
      quotaHmacSecret,
      policy,
    });

    await expect(
      quota.reserveWeight(20, abortController.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(consumeIssuanceQuota).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, 100_001, Number.NaN])(
    "rejects invalid cost %s before touching PostgreSQL",
    async (cost) => {
      const inputs = dependencies();

      await expect(
        inputs.quota.reserveWeight(cost, new AbortController().signal),
      ).rejects.toThrow(TypeError);
      expect(inputs.consumeIssuanceQuota).not.toHaveBeenCalled();
    },
  );

  it("rejects weak secrets and out-of-policy capacities at construction", () => {
    expect(() =>
      createPostgresHyperliquidInfoQuota({
        repository: dependencies(),
        quotaHmacSecret: new Uint8Array(31),
        policy,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createPostgresHyperliquidInfoQuota({
        repository: dependencies(),
        quotaHmacSecret,
        policy: { ...policy, weightCapacity: 0 },
      }),
    ).toThrow(TypeError);
  });
});
