import { describe, expect, it } from "vitest";

import {
  createV2CursorCodec,
  InvalidV2CursorError,
} from "../src/core/http/v2-cursor.js";

const secret = Buffer.from(
  "018ad7733fc31db538419fd44cf4b27fc68c09f626fc7a2d6be6a7de17c26c59",
  "hex",
);
const observedAt = new Date("2026-09-07T08:00:00.000Z");
const ownerId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const otherOwnerId = "b0825ec2-a585-45c8-9e9f-5279c69d49b3";
const lastId = "28f34597-8bbd-4835-bff7-f7db654333b5";
const context = {
  ownerId,
  route: "communityMembers",
  filter: "role=member&sort=joinedAt",
} as const;
const continuation = { lastAt: "2026-09-06T10:00:00.000Z", lastId, limit: 20 };

function codec(now: () => Date = () => observedAt) {
  return createV2CursorCodec({ secret, now });
}

describe("V2 opaque cursor codec", () => {
  it("round trips a canonical continuation without exposing it", () => {
    const cursorCodec = codec();
    const cursor = cursorCodec.encode({ ...context, continuation });

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(ownerId);
    expect(cursor).not.toContain(lastId);
    expect(cursorCodec.decode({ ...context, cursor })).toEqual(continuation);
  });

  it("binds the cursor to owner, route, and filter", () => {
    const cursorCodec = codec();
    const cursor = cursorCodec.encode({ ...context, continuation });

    expect(() =>
      cursorCodec.decode({ ...context, ownerId: otherOwnerId, cursor }),
    ).toThrow(InvalidV2CursorError);
    expect(() =>
      cursorCodec.decode({ ...context, route: "communityPosts", cursor }),
    ).toThrow(InvalidV2CursorError);
    expect(() =>
      cursorCodec.decode({ ...context, filter: "role=admin", cursor }),
    ).toThrow(InvalidV2CursorError);
  });

  it("rejects tampering, foreign secrets, and expiry", () => {
    const cursorCodec = codec();
    const cursor = cursorCodec.encode({ ...context, continuation });
    const [payload, mac] = cursor.split(".") as [string, string];
    const flipped = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
    const foreign = createV2CursorCodec({
      secret: Buffer.alloc(32, 7),
      now: () => observedAt,
    });

    expect(() =>
      cursorCodec.decode({ ...context, cursor: `${flipped}.${mac}` }),
    ).toThrow(InvalidV2CursorError);
    expect(() =>
      cursorCodec.decode({ ...context, cursor: `${payload}.${mac.slice(1)}` }),
    ).toThrow(InvalidV2CursorError);
    expect(() => foreign.decode({ ...context, cursor })).toThrow(
      InvalidV2CursorError,
    );
    expect(() =>
      codec(() => new Date(observedAt.getTime() + 601_000)).decode({
        ...context,
        cursor,
      }),
    ).toThrow(InvalidV2CursorError);
    expect(
      codec(() => new Date(observedAt.getTime() + 599_000)).decode({
        ...context,
        cursor,
      }),
    ).toEqual(continuation);
  });

  it("fails closed on malformed context or continuation input", () => {
    const cursorCodec = codec();

    expect(() =>
      cursorCodec.encode({ ...context, ownerId: "not-a-uuid", continuation }),
    ).toThrow(InvalidV2CursorError);
    expect(() =>
      cursorCodec.encode({ ...context, route: "Bad Route", continuation }),
    ).toThrow(InvalidV2CursorError);
    expect(() =>
      cursorCodec.encode({ ...context, filter: "has space", continuation }),
    ).toThrow(InvalidV2CursorError);
    expect(() => cursorCodec.encode({ ...context, continuation: {} })).toThrow(
      InvalidV2CursorError,
    );
    expect(() =>
      cursorCodec.encode({
        ...context,
        continuation: { limit: 1.5 },
      }),
    ).toThrow(InvalidV2CursorError);
    expect(() =>
      cursorCodec.encode({
        ...context,
        continuation: { lastAt: "x".repeat(257) },
      }),
    ).toThrow(InvalidV2CursorError);
    expect(() => cursorCodec.decode({ ...context, cursor: "" })).toThrow(
      InvalidV2CursorError,
    );
    expect(() => cursorCodec.decode({ ...context, cursor: "a.b.c" })).toThrow(
      InvalidV2CursorError,
    );
    expect(() => createV2CursorCodec({ secret: Buffer.alloc(16) })).toThrow(
      TypeError,
    );
  });
});
