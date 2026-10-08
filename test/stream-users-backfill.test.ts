import { describe, expect, it, vi } from "vitest";

import {
  parseStreamUsersBackfillRequest,
  runStreamUsersBackfill,
  StreamUsersBackfillError,
  STREAM_USERS_BACKFILL_BATCH_SIZE,
} from "../scripts/stream-users-backfill.js";
import type { StreamUserIdentityRepository } from "../src/features/communication/stream-user-identity.js";

/** Decision 0095: `pnpm stream:users-backfill [--apply]`. */

const environment = {
  DATABASE_URL: "postgres://u:p@127.0.0.1:5433/loop",
  STREAM_API_KEY: "key",
  STREAM_API_SECRET: "secret",
  PUBLIC_BASE_URL: "https://api.test",
};

function userId(index: number): string {
  return `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function repository(total: number) {
  const ids = Array.from({ length: total }, (_, index) => userId(index + 1));
  return {
    listActivatedUserIds: vi.fn<
      StreamUserIdentityRepository["listActivatedUserIds"]
    >(({ afterUserId, limit }) => {
      const start = afterUserId === null ? 0 : ids.indexOf(afterUserId) + 1;
      return Promise.resolve(ids.slice(start, start + limit));
    }),
    listIdentities: vi.fn<StreamUserIdentityRepository["listIdentities"]>(
      (userIds) =>
        Promise.resolve(
          userIds.map((id, index) => ({
            userId: id,
            alias: index % 2 === 0 ? "Alice" : null,
            avatarRef:
              index % 3 === 0
                ? "avatar:media/22222222-2222-4222-8222-222222222222"
                : "avatar:preset/monogram",
            publicProfileId:
              index % 4 === 0 ? null : "33333333-3333-4333-8333-333333333333",
          })),
        ),
    ),
  } satisfies StreamUserIdentityRepository;
}

describe("stream:users-backfill (Decision 0095)", () => {
  it("parses dry-run by default, --apply, and refuses anything else", () => {
    expect(
      parseStreamUsersBackfillRequest(["node", "s"], environment).mode,
    ).toBe("dry-run");
    expect(
      parseStreamUsersBackfillRequest(["node", "s", "--apply"], environment)
        .mode,
    ).toBe("apply");
    expect(() =>
      parseStreamUsersBackfillRequest(["node", "s", "--force"], environment),
    ).toThrow(StreamUsersBackfillError);
    expect(() =>
      parseStreamUsersBackfillRequest(["node", "s"], {
        ...environment,
        STREAM_API_SECRET: " ",
      }),
    ).toThrow(StreamUsersBackfillError);
    expect(() =>
      parseStreamUsersBackfillRequest(["node", "s"], {
        ...environment,
        PUBLIC_BASE_URL: undefined,
      }),
    ).toThrow(StreamUsersBackfillError);
  });

  it("counts without writing in a dry run", async () => {
    const upsertUsers = vi.fn(() => Promise.resolve());
    const result = await runStreamUsersBackfill(
      parseStreamUsersBackfillRequest(["node", "s"], environment),
      {
        repository: repository(5),
        gateway: { upsertUsers },
        close: () => Promise.resolve(),
      },
    );
    expect(result).toEqual({
      examined: 5,
      withName: 3,
      withImage: 2,
      withPublicProfileId: 3,
      upserted: 0,
    });
    expect(upsertUsers).not.toHaveBeenCalled();
  });

  it("upserts every activated account in batches of 100 with --apply", async () => {
    const upsertUsers = vi.fn(() => Promise.resolve());
    const pause = vi.fn(() => Promise.resolve());
    const result = await runStreamUsersBackfill(
      parseStreamUsersBackfillRequest(["node", "s", "--apply"], environment),
      {
        repository: repository(STREAM_USERS_BACKFILL_BATCH_SIZE + 20),
        gateway: { upsertUsers },
        close: () => Promise.resolve(),
        pause,
      },
    );
    expect(result.upserted).toBe(120);
    expect(upsertUsers).toHaveBeenCalledTimes(2);
    const firstBatch = (
      upsertUsers.mock.calls[0] as unknown as [
        {
          users: {
            id: string;
            name?: string;
            image?: string;
            custom?: { publicProfileId: string };
          }[];
        },
      ]
    )[0].users;
    expect(firstBatch).toHaveLength(100);
    expect(firstBatch[0]).toEqual({
      id: "loop_00000001000040008000000000000000",
      name: "Alice",
      image:
        "https://api.test/v2/media/22222222-2222-4222-8222-222222222222.webp",
    });
    expect(firstBatch[1]).toEqual({
      id: "loop_00000002000040008000000000000000",
      custom: { publicProfileId: "33333333-3333-4333-8333-333333333333" },
    });
    expect(pause).toHaveBeenCalledTimes(2);
  });
});
