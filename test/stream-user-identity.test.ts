import { describe, expect, it, vi } from "vitest";

import {
  createStreamUserIdentitySource,
  createStreamUserSync,
  loopUserIdFromStreamUserId,
  projectStreamUser,
  type StreamUserIdentityRepository,
} from "../src/features/communication/stream-user-identity.js";
import { deriveStreamUserId } from "../src/features/identity/loop-identifiers.js";

/**
 * Decision 0095: the Stream user projection
 * `{id, name, image, custom: {publicProfileId}}`.
 */

const userId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const otherUserId = "f7bf09f6-0171-46b9-9acd-5ad494f211bd";
const mediaId = "22222222-2222-4222-8222-222222222222";
const publicProfileId = "33333333-3333-4333-8333-333333333333";

function repository(
  records: Awaited<ReturnType<StreamUserIdentityRepository["listIdentities"]>>,
) {
  return {
    listIdentities: vi.fn<StreamUserIdentityRepository["listIdentities"]>(() =>
      Promise.resolve(records),
    ),
    listActivatedUserIds: vi.fn(() => Promise.resolve([])),
  } satisfies StreamUserIdentityRepository;
}

describe("Stream user identity (Decision 0095)", () => {
  it("inverts the Stream user ID derivation", () => {
    expect(loopUserIdFromStreamUserId(deriveStreamUserId(userId))).toBe(userId);
    expect(loopUserIdFromStreamUserId("loop_short")).toBeNull();
    expect(
      loopUserIdFromStreamUserId("other_6d12a86e413447e69312c5ef75a30f55"),
    ).toBeNull();
  });

  it("publishes the alias, an absolute uploaded-avatar URL and the public profile ID, omitting presets and nulls", () => {
    expect(
      projectStreamUser(
        {
          userId,
          alias: "Alice",
          avatarRef: `avatar:media/${mediaId}`,
          publicProfileId,
        },
        "https://api-dev.quant-dinger.cc/",
      ),
    ).toEqual({
      id: "loop_6d12a86e413447e69312c5ef75a30f55",
      name: "Alice",
      image: `https://api-dev.quant-dinger.cc/v2/media/${mediaId}.webp`,
      custom: { publicProfileId },
    });
    expect(
      projectStreamUser(
        {
          userId,
          alias: null,
          avatarRef: "avatar:preset/people-03",
          publicProfileId: null,
        },
        "https://api.test",
      ),
    ).toEqual({ id: "loop_6d12a86e413447e69312c5ef75a30f55" });
  });

  it("resolves every requested Stream user in order and keeps unknown users as {id}", async () => {
    const source = createStreamUserIdentitySource({
      repository: repository([
        { userId, alias: "Alice", avatarRef: null, publicProfileId },
      ]),
      publicBaseUrl: "https://api.test",
    });
    await expect(
      source.resolve([
        deriveStreamUserId(otherUserId),
        deriveStreamUserId(userId),
      ]),
    ).resolves.toEqual([
      { id: deriveStreamUserId(otherUserId) },
      {
        id: deriveStreamUserId(userId),
        name: "Alice",
        custom: { publicProfileId },
      },
    ]);
  });

  it("syncs one user and swallows a provider failure with a sanitized warning", async () => {
    const upsertUsers = vi.fn(() => Promise.reject(new Error("boom 0xabc")));
    const warn = vi.fn();
    const sync = createStreamUserSync({
      identities: createStreamUserIdentitySource({
        repository: repository([
          { userId, alias: "Alice", avatarRef: null, publicProfileId: null },
        ]),
        publicBaseUrl: "https://api.test",
      }),
      gateway: { upsertUsers },
      logger: { warn },
    });
    await expect(sync.syncUser(userId)).resolves.toBeUndefined();
    expect(upsertUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        users: [{ id: deriveStreamUserId(userId), name: "Alice" }],
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      { errorName: "Error" },
      expect.any(String),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("0xabc");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(userId);
  });
});
