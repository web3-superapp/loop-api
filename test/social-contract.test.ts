import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  defaultSocialPrivacyValues,
  digestFriendRequestDecision,
  digestFriendRequestSend,
  parseFriendRequestDecision,
  parseFriendRequestSend,
  parseSocialIdempotencyKey,
  parseSocialListLimit,
  parseSocialPrivacyReplacement,
} from "../src/features/social/social-contract.js";

const idempotencyKey = "d85b1407-351d-4694-9392-03acc5870eb1";
const targetPublicProfileId = "b0825ec2-a585-45c8-9e9f-5279c69d49b3";
const friendRequestId = "28f34597-8bbd-4835-bff7-f7db654333b5";

describe("social contract", () => {
  it("keeps missing social privacy fail closed", () => {
    expect(defaultSocialPrivacyValues).toEqual({
      friend_requests: "disabled",
      group_invites: "disabled",
      direct_messages: "disabled",
    });
    expect(Object.isFrozen(defaultSocialPrivacyValues)).toBe(true);
  });

  it("parses an exact CAS social privacy replacement", () => {
    expect(
      parseSocialPrivacyReplacement({
        expected_version: 0,
        social_privacy: {
          friend_requests: "enabled",
          group_invites: "friends",
          direct_messages: "friends",
        },
      }),
    ).toEqual({
      expected_version: 0,
      social_privacy: {
        friend_requests: "enabled",
        group_invites: "friends",
        direct_messages: "friends",
      },
    });
    expect(() =>
      parseSocialPrivacyReplacement({
        expected_version: 0,
        social_privacy: {
          friend_requests: "enabled",
          group_invites: "friends",
          direct_messages: "friends",
          discoverable: true,
        },
      }),
    ).toThrow();
  });

  it("accepts only exact target and decision command bodies", () => {
    expect(
      parseFriendRequestSend({
        target_public_profile_id: targetPublicProfileId,
      }),
    ).toEqual({ target_public_profile_id: targetPublicProfileId });
    expect(parseFriendRequestDecision({ decision: "accept" })).toEqual({
      decision: "accept",
    });
    expect(() =>
      parseFriendRequestSend({
        target_public_profile_id: targetPublicProfileId,
        owner_user_id: targetPublicProfileId,
      }),
    ).toThrow();
    expect(() => parseFriendRequestDecision({ decision: "block" })).toThrow();
  });

  it("requires exactly one lowercase canonical UUIDv4 idempotency header", () => {
    expect(
      parseSocialIdempotencyKey([
        "Authorization",
        "Bearer token",
        "Idempotency-Key",
        idempotencyKey,
      ]),
    ).toBe(idempotencyKey);

    for (const rawHeaders of [
      ["authorization", "Bearer token"],
      ["idempotency-key", idempotencyKey.toUpperCase()],
      ["idempotency-key", ` ${idempotencyKey}`],
      ["idempotency-key", "d85b1407-351d-1694-9392-03acc5870eb1"],
      ["idempotency-key", idempotencyKey, "Idempotency-Key", idempotencyKey],
    ]) {
      expect(() => parseSocialIdempotencyKey(rawHeaders)).toThrow();
    }
  });

  it("binds command digests to their kind and normalized semantic input", () => {
    const send = digestFriendRequestSend({
      target_public_profile_id: targetPublicProfileId,
    });
    const decision = digestFriendRequestDecision(friendRequestId, {
      decision: "accept",
    });

    expect(send).toMatch(/^[0-9a-f]{64}$/);
    expect(decision).toMatch(/^[0-9a-f]{64}$/);
    expect(send).not.toBe(decision);
    expect(send).toBe(
      createHash("sha256")
        .update("loop.social-command\0v1\0friend_request_send\0", "utf8")
        .update(targetPublicProfileId, "utf8")
        .digest("hex"),
    );
    expect(decision).toBe(
      createHash("sha256")
        .update("loop.social-command\0v1\0friend_request_decide\0", "utf8")
        .update(friendRequestId, "utf8")
        .update("\0accept", "utf8")
        .digest("hex"),
    );
  });

  it("uses a 20 item default and a strict 50 item list maximum", () => {
    expect(parseSocialListLimit(undefined)).toBe(20);
    expect(parseSocialListLimit(1)).toBe(1);
    expect(parseSocialListLimit(50)).toBe(50);
    expect(() => parseSocialListLimit(0)).toThrow();
    expect(() => parseSocialListLimit(51)).toThrow();
    expect(() => parseSocialListLimit("20")).toThrow();
  });
});
