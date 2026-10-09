import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ControlPlaneUnavailableError,
  IssuanceQuotaExceededError,
  type ControlPlaneRepository,
} from "../src/database/control-plane-repository.js";
import {
  AliasSearchQuotaUnavailableError,
  AliasSearchRateLimitedError,
  createAliasSearchQuota,
  type AliasSearchScope,
} from "../src/features/identity/alias-search-quota.js";

const userId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const canonicalClientIp = "2001:db8::1";
const quotaHmacSecret = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 1,
);

function expectedSubjectHmac(
  capability: string,
  subjectKind: string,
  subject: string,
): string {
  return createHmac("sha256", quotaHmacSecret)
    .update("loop.alias-search-quota\0v1", "utf8")
    .update("\0", "utf8")
    .update(capability, "utf8")
    .update("\0", "utf8")
    .update("alias_search_v1", "utf8")
    .update("\0", "utf8")
    .update(subjectKind, "utf8")
    .update("\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");
}

function dependencies() {
  const consumeIssuanceQuota = vi.fn<
    ControlPlaneRepository["consumeIssuanceQuota"]
  >(() => Promise.resolve([]));
  const quota = createAliasSearchQuota({
    repository: { consumeIssuanceQuota },
    hmacSecret: quotaHmacSecret,
  });
  return { consumeIssuanceQuota, quota };
}

function request(scope: AliasSearchScope = "public") {
  return {
    scope,
    userId,
    canonicalClientIp,
    signal: new AbortController().signal,
  } as const;
}

describe("alias search quota", () => {
  it.each([
    ["public", "public_alias_search", 30, 60, 300],
    ["group", "group_alias_search", 60, 120, 600],
  ] as const)(
    "atomically reserves domain-separated %s search quotas",
    async (
      scope,
      capability,
      userMinuteCapacity,
      ipMinuteCapacity,
      userDayCapacity,
    ) => {
      const input = dependencies();

      await expect(
        input.quota.consume(request(scope)),
      ).resolves.toBeUndefined();

      expect(input.consumeIssuanceQuota).toHaveBeenCalledOnce();
      expect(input.consumeIssuanceQuota).toHaveBeenCalledWith({
        capability,
        policyVersion: "alias_search_v1",
        buckets: [
          {
            subjectKind: "user_minute",
            subjectHmac: expectedSubjectHmac(capability, "user_minute", userId),
            windowDurationSeconds: 60,
            capacity: userMinuteCapacity,
          },
          {
            subjectKind: "ip_minute",
            subjectHmac: expectedSubjectHmac(
              capability,
              "ip_minute",
              canonicalClientIp,
            ),
            windowDurationSeconds: 60,
            capacity: ipMinuteCapacity,
          },
          {
            subjectKind: "user_day",
            subjectHmac: expectedSubjectHmac(capability, "user_day", userId),
            windowDurationSeconds: 86_400,
            capacity: userDayCapacity,
          },
        ],
      });
      const serialized = JSON.stringify(
        input.consumeIssuanceQuota.mock.calls[0]?.[0],
      );
      expect(serialized).not.toContain(userId);
      expect(serialized).not.toContain(canonicalClientIp);
      expect(serialized).not.toContain(Array.from(quotaHmacSecret).join(","));
    },
  );

  it("copies the HMAC secret at construction", async () => {
    const mutableSecret = Uint8Array.from(quotaHmacSecret);
    const consumeIssuanceQuota = vi.fn<
      ControlPlaneRepository["consumeIssuanceQuota"]
    >(() => Promise.resolve([]));
    const quota = createAliasSearchQuota({
      repository: { consumeIssuanceQuota },
      hmacSecret: mutableSecret,
    });
    mutableSecret.fill(0);

    await quota.consume(request());

    expect(
      consumeIssuanceQuota.mock.calls[0]?.[0].buckets[0]?.subjectHmac,
    ).toBe(expectedSubjectHmac("public_alias_search", "user_minute", userId));
  });

  it("maps persistent quota exhaustion to a rate limit", async () => {
    const input = dependencies();
    input.consumeIssuanceQuota.mockRejectedValueOnce(
      new IssuanceQuotaExceededError(),
    );

    await expect(input.quota.consume(request())).rejects.toBeInstanceOf(
      AliasSearchRateLimitedError,
    );
  });

  it.each([
    new ControlPlaneUnavailableError(),
    new Error("database-secret-detail"),
  ])(
    "sanitizes unavailable or unexpected control-plane failures",
    async (failure) => {
      const input = dependencies();
      input.consumeIssuanceQuota.mockRejectedValueOnce(failure);

      const result = input.quota.consume(request());
      await expect(result).rejects.toBeInstanceOf(
        AliasSearchQuotaUnavailableError,
      );
      await expect(result).rejects.not.toThrow("database-secret-detail");
    },
  );

  it.each([
    ["invalid user ID", { userId: "not-a-uuid" }],
    ["noncanonical IPv6", { canonicalClientIp: "2001:0db8::1" }],
    ["invalid IP", { canonicalClientIp: "not-an-ip" }],
  ])(
    "fails closed on %s before touching persistence",
    async (_name, override) => {
      const input = dependencies();

      await expect(
        input.quota.consume({ ...request(), ...override }),
      ).rejects.toBeInstanceOf(AliasSearchQuotaUnavailableError);
      expect(input.consumeIssuanceQuota).not.toHaveBeenCalled();
    },
  );

  it("rejects weak HMAC secrets at construction", () => {
    expect(() =>
      createAliasSearchQuota({
        repository: dependencies(),
        hmacSecret: new Uint8Array(31),
      }),
    ).toThrow(TypeError);
  });

  it("preserves aborts before and after persistent quota reservation", async () => {
    const before = dependencies();
    const beforeController = new AbortController();
    const beforeReason = new Error("aborted-before-alias-search-quota");
    beforeController.abort(beforeReason);
    await expect(
      before.quota.consume({
        ...request(),
        signal: beforeController.signal,
      }),
    ).rejects.toBe(beforeReason);
    expect(before.consumeIssuanceQuota).not.toHaveBeenCalled();

    const after = dependencies();
    const afterController = new AbortController();
    const afterReason = new Error("aborted-after-alias-search-quota");
    after.consumeIssuanceQuota.mockImplementationOnce(() => {
      afterController.abort(afterReason);
      return Promise.resolve([]);
    });
    await expect(
      after.quota.consume({
        ...request(),
        signal: afterController.signal,
      }),
    ).rejects.toBe(afterReason);
    expect(after.consumeIssuanceQuota).toHaveBeenCalledOnce();
  });
});
