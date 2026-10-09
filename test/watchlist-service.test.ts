import { describe, expect, it, vi } from "vitest";

import type { WatchlistRepository } from "../src/database/watchlist-repository.js";
import { InvalidWatchlistContractError } from "../src/features/watchlist/watchlist-contract.js";
import {
  InvalidWatchlistRequestError,
  createWatchlistService,
} from "../src/features/watchlist/watchlist-service.js";

const principal = {
  userId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
  privyUserId: "did:privy:watchlist-service",
  streamUserId: "loop_6d12a86e413447e69312c5ef75a30f55",
} as const;

function repository(
  replace: WatchlistRepository["replace"],
): WatchlistRepository {
  return {
    get: vi.fn(() =>
      Promise.resolve({ version: 0, groups: [], updated_at: null }),
    ),
    replace,
  };
}

describe("Watchlist service", () => {
  it("maps only malformed client replacement input to invalid request", async () => {
    const replace = vi.fn<WatchlistRepository["replace"]>();
    const service = createWatchlistService({ repository: repository(replace) });

    await expect(
      service.replace({
        principal,
        body: { expected_version: 0, groups: [], owner_user_id: "forbidden" },
      }),
    ).rejects.toBeInstanceOf(InvalidWatchlistRequestError);
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps a malformed repository response as a sanitized server failure", async () => {
    const replace = vi.fn<WatchlistRepository["replace"]>(() =>
      Promise.resolve({
        version: 1,
        groups: [],
        updated_at: null,
      }),
    );
    const service = createWatchlistService({ repository: repository(replace) });

    await expect(
      service.replace({
        principal,
        body: { expected_version: 0, groups: [] },
      }),
    ).rejects.toBeInstanceOf(InvalidWatchlistContractError);
  });
});
