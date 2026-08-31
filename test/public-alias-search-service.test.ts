import { describe, expect, it, vi } from "vitest";

import {
  createUnavailableAliasDirectoryRepository,
  type AliasDirectoryRepository,
} from "../src/database/alias-directory-repository.js";
import type { AliasSearchQuota } from "../src/features/identity/alias-search-quota.js";
import {
  InvalidPublicAliasSearchRequestError,
  PublicAliasSearchUnavailableError,
  createPublicAliasSearchService,
} from "../src/features/identity/public-alias-search-service.js";

const principal = Object.freeze({
  userId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
  privyUserId: "did:privy:alias-search-user",
  streamUserId: "loop_6d12a86e413447e69312c5ef75a30f55",
});

function dependencies() {
  const searchPublicAliases = vi.fn<
    AliasDirectoryRepository["searchPublicAliases"]
  >(() =>
    Promise.resolve([
      {
        publicProfileId: "28f34597-8bbd-4835-bff7-f7db654333b5",
        alias: "Alice",
        avatarRef: "avatar:alice/main",
      },
      {
        publicProfileId: "10a420b6-5812-4574-a914-a126417d55af",
        alias: "Alicia",
        avatarRef: null,
      },
    ]),
  );
  const repository = {
    ...createUnavailableAliasDirectoryRepository(),
    searchPublicAliases,
  } satisfies AliasDirectoryRepository;
  const consume = vi.fn<AliasSearchQuota["consume"]>(() => Promise.resolve());
  return {
    consume,
    repository,
    searchPublicAliases,
    service: createPublicAliasSearchService({
      repository,
      quota: { consume },
    }),
  };
}

describe("public alias search service", () => {
  it("consumes quota first and returns only opaque public presentation fields", async () => {
    const input = dependencies();
    await expect(
      input.service.search({
        principal,
        aliasPrefix: "Ali",
        limit: 1,
        canonicalClientIp: "127.0.0.1",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      items: [
        {
          public_profile_id: "28f34597-8bbd-4835-bff7-f7db654333b5",
          alias: "Alice",
          avatar_ref: "avatar:alice/main",
        },
      ],
      truncated: true,
    });
    expect(input.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "public",
        userId: principal.userId,
        canonicalClientIp: "127.0.0.1",
      }),
    );
    expect(input.searchPublicAliases).toHaveBeenCalledWith({
      requesterUserId: principal.userId,
      aliasPrefix: "Ali",
      limit: 2,
    });
    expect(input.consume.mock.invocationCallOrder[0]).toBeLessThan(
      input.searchPublicAliases.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      JSON.stringify(
        (
          await input.service.search({
            principal,
            aliasPrefix: "Ali",
            limit: 2,
            canonicalClientIp: "127.0.0.1",
            signal: new AbortController().signal,
          })
        ).items,
      ),
    ).not.toMatch(/owner|stream|privy|wallet|group/i);
  });

  it("rejects unsafe input before quota or persistence", async () => {
    const input = dependencies();
    await expect(
      input.service.search({
        principal,
        aliasPrefix: "A",
        limit: 20,
        canonicalClientIp: "127.0.0.1",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(InvalidPublicAliasSearchRequestError);
    expect(input.consume).not.toHaveBeenCalled();
    expect(input.searchPublicAliases).not.toHaveBeenCalled();
  });

  it("validates normalized length while preserving the raw prefix for one database canonicalizer", async () => {
    const input = dependencies();
    await input.service.search({
      principal,
      aliasPrefix: "ﬀ",
      limit: 20,
      canonicalClientIp: "127.0.0.1",
      signal: new AbortController().signal,
    });

    expect(input.searchPublicAliases).toHaveBeenCalledWith({
      requesterUserId: principal.userId,
      aliasPrefix: "ﬀ",
      limit: 21,
    });
  });

  it("fails closed when the directory repository is unavailable", async () => {
    const input = dependencies();
    input.searchPublicAliases.mockRejectedValueOnce(
      await createUnavailableAliasDirectoryRepository()
        .searchPublicAliases({
          requesterUserId: principal.userId,
          aliasPrefix: "Al",
          limit: 1,
        })
        .catch((error: unknown) => error),
    );
    await expect(
      input.service.search({
        principal,
        aliasPrefix: "Al",
        limit: 20,
        canonicalClientIp: "127.0.0.1",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(PublicAliasSearchUnavailableError);
  });
});
