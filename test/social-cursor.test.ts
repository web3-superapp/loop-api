import { describe, expect, it } from "vitest";

import {
  createSocialCursorCodec,
  InvalidSocialCursorError,
} from "../src/features/social/social-cursor.js";

const secret = Buffer.from(
  "018ad7733fc31db538419fd44cf4b27fc68c09f626fc7a2d6be6a7de17c26c59",
  "hex",
);
const observedAt = new Date("2026-08-31T08:00:00.000Z");
const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const otherOwnerUserId = "b0825ec2-a585-45c8-9e9f-5279c69d49b3";
const lastId = "28f34597-8bbd-4835-bff7-f7db654333b5";
const lastAt = "2026-08-30T10:00:00.000Z";

function codec(now: () => Date = () => observedAt) {
  return createSocialCursorCodec({ secret, now });
}

describe("social cursor codec", () => {
  it("round trips only the encrypted keyset continuation", () => {
    const cursorCodec = codec();
    const cursor = cursorCodec.encode({
      ownerUserId,
      route: "friends",
      filter: "accepted",
      limit: 20,
      lastAt,
      lastId,
    });

    expect(
      cursorCodec.decode({
        cursor,
        ownerUserId,
        route: "friends",
        filter: "accepted",
      }),
    ).toEqual({ limit: 20, lastAt, lastId });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(ownerUserId);
    expect(cursor).not.toContain(lastId);
    expect(cursor).not.toContain(Buffer.from(lastAt).toString("base64url"));
  });

  it("rejects tampering, cross-owner, cross-route, and filter replay", () => {
    const cursorCodec = codec();
    const context = {
      ownerUserId,
      route: "friend_requests" as const,
      filter: "direction=incoming&status=pending",
    };
    const cursor = cursorCodec.encode({
      ...context,
      limit: 50,
      lastAt,
      lastId,
    });
    const [payload, mac] = cursor.split(".") as [string, string];
    const tampered = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${mac}`;

    for (const action of [
      () => cursorCodec.decode({ ...context, cursor: tampered }),
      () =>
        cursorCodec.decode({
          ...context,
          cursor,
          ownerUserId: otherOwnerUserId,
        }),
      () => cursorCodec.decode({ ...context, cursor, route: "friends" }),
      () =>
        cursorCodec.decode({
          ...context,
          cursor,
          filter: "direction=outgoing&status=pending",
        }),
    ]) {
      expect(action).toThrow(InvalidSocialCursorError);
    }
  });

  it("rejects expired, malformed, and non-canonical cursors", () => {
    const cursor = codec().encode({
      ownerUserId,
      route: "friends",
      filter: "accepted",
      limit: 20,
      lastAt,
      lastId,
    });
    const expired = codec(() => new Date(observedAt.getTime() + 600_000));

    expect(() =>
      expired.decode({
        cursor,
        ownerUserId,
        route: "friends",
        filter: "accepted",
      }),
    ).toThrow(InvalidSocialCursorError);
    expect(() =>
      codec().decode({
        cursor: `${cursor}=`,
        ownerUserId,
        route: "friends",
        filter: "accepted",
      }),
    ).toThrow(InvalidSocialCursorError);
    expect(() =>
      codec().decode({
        cursor: "not-a-cursor",
        ownerUserId,
        route: "friends",
        filter: "accepted",
      }),
    ).toThrow(InvalidSocialCursorError);
  });

  it("rejects weak secrets and invalid keyset state", () => {
    expect(() => createSocialCursorCodec({ secret: Buffer.alloc(31) })).toThrow(
      "Social cursor HMAC secret is invalid",
    );
    expect(() =>
      codec().encode({
        ownerUserId,
        route: "friends",
        filter: "accepted",
        limit: 0,
        lastAt,
        lastId,
      }),
    ).toThrow(InvalidSocialCursorError);
    expect(() =>
      codec().encode({
        ownerUserId,
        route: "friends",
        filter: "accepted",
        limit: 20,
        lastAt: "not-a-date",
        lastId,
      }),
    ).toThrow(InvalidSocialCursorError);
  });
});
