import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ControlPlaneUnavailableError,
  IssuanceQuotaExceededError,
  type ControlPlaneRepository,
} from "../src/database/control-plane-repository.js";
import {
  createSocialMutationQuota,
  SocialMutationQuotaUnavailableError,
  SocialMutationRateLimitedError,
} from "../src/features/social/social-mutation-quota.js";

const userId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const targetRef = "b0825ec2-a585-45c8-9e9f-5279c69d49b3";
const canonicalClientIp = "2001:db8::1";
const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

function subjectHmac(
  capability: string,
  subjectKind: string,
  subject: string,
): string {
  return createHmac("sha256", secret)
    .update("loop.social-mutation-quota\0v1", "utf8")
    .update("\0", "utf8")
    .update(capability, "utf8")
    .update("\0social_mutation_v1\0", "utf8")
    .update(subjectKind, "utf8")
    .update("\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");
}

function dependencies() {
  const consumeIssuanceQuota = vi.fn<
    ControlPlaneRepository["consumeIssuanceQuota"]
  >(() => Promise.resolve([]));
  return {
    consumeIssuanceQuota,
    quota: createSocialMutationQuota({
      repository: { consumeIssuanceQuota },
      hmacSecret: secret,
    }),
  };
}

describe("social mutation quota", () => {
  it("atomically reserves caller, IP, and target friend-request buckets", async () => {
    const input = dependencies();
    await input.quota.consume({
      capability: "friend_request_send",
      userId,
      canonicalClientIp,
      targetRef,
      signal: new AbortController().signal,
    });

    expect(input.consumeIssuanceQuota).toHaveBeenCalledWith({
      capability: "social_friend_request_send",
      policyVersion: "social_mutation_v1",
      buckets: [
        {
          subjectKind: "user_minute",
          subjectHmac: subjectHmac(
            "social_friend_request_send",
            "user_minute",
            userId,
          ),
          windowDurationSeconds: 60,
          capacity: 10,
        },
        {
          subjectKind: "ip_minute",
          subjectHmac: subjectHmac(
            "social_friend_request_send",
            "ip_minute",
            canonicalClientIp,
          ),
          windowDurationSeconds: 60,
          capacity: 30,
        },
        {
          subjectKind: "target_day",
          subjectHmac: subjectHmac(
            "social_friend_request_send",
            "target_day",
            targetRef,
          ),
          windowDurationSeconds: 86_400,
          capacity: 20,
        },
      ],
    });
    const serialized = JSON.stringify(
      input.consumeIssuanceQuota.mock.calls[0]?.[0],
    );
    expect(serialized).not.toContain(userId);
    expect(serialized).not.toContain(targetRef);
    expect(serialized).not.toContain(canonicalClientIp);
  });

  it("uses independent decision buckets and maps quota failures", async () => {
    const input = dependencies();
    input.consumeIssuanceQuota.mockRejectedValueOnce(
      new IssuanceQuotaExceededError(),
    );
    await expect(
      input.quota.consume({
        capability: "friend_request_decide",
        userId,
        canonicalClientIp,
        targetRef,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(SocialMutationRateLimitedError);

    input.consumeIssuanceQuota.mockRejectedValueOnce(
      new ControlPlaneUnavailableError(),
    );
    await expect(
      input.quota.consume({
        capability: "friend_request_decide",
        userId,
        canonicalClientIp,
        targetRef,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(SocialMutationQuotaUnavailableError);
  });

  it("fails closed before persistence for invalid subjects or weak secrets", async () => {
    const input = dependencies();
    await expect(
      input.quota.consume({
        capability: "friend_request_send",
        userId: "not-a-user",
        canonicalClientIp,
        targetRef,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(SocialMutationQuotaUnavailableError);
    expect(input.consumeIssuanceQuota).not.toHaveBeenCalled();
    expect(() =>
      createSocialMutationQuota({
        repository: { consumeIssuanceQuota: input.consumeIssuanceQuota },
        hmacSecret: Buffer.alloc(31),
      }),
    ).toThrow(TypeError);
  });
});
