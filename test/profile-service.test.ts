import { describe, expect, it, vi } from "vitest";

import {
  ProfileRepositoryUnavailableError,
  type ProfileRepository,
} from "../src/database/profile-repository.js";
import { createProfileService } from "../src/features/profile/profile-service.js";

const principal = {
  userId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
  privyUserId: "did:privy:profile-service",
  streamUserId: "loop_6d12a86e413447e69312c5ef75a30f55",
} as const;
const foreignOwnerUserId = "7d12a86e-4134-47e6-9312-c5ef75a30f55";

function repository(overrides: Partial<ProfileRepository>): ProfileRepository {
  return {
    getProfile: vi.fn(() => Promise.resolve(null)),
    replaceProfile: vi.fn(() => Promise.resolve(null)),
    getPrivacy: vi.fn(() => Promise.resolve(null)),
    replacePrivacy: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  };
}

describe("Profile service", () => {
  it("fails closed when a repository returns another owner's Profile", async () => {
    const service = createProfileService(
      repository({
        getProfile: vi.fn(() =>
          Promise.resolve({
            ownerUserId: foreignOwnerUserId,
            alias: "Foreign alias",
            avatarRef: null,
            version: 1,
            updatedAt: "2026-08-25T00:00:00.000Z",
          }),
        ),
      }),
    );

    await expect(service.getProfile({ principal })).rejects.toBeInstanceOf(
      ProfileRepositoryUnavailableError,
    );
  });

  it("fails closed when a repository returns another owner's privacy row", async () => {
    const service = createProfileService(
      repository({
        getPrivacy: vi.fn(() =>
          Promise.resolve({
            ownerUserId: foreignOwnerUserId,
            discoverable: true,
            copyTradeVisibility: "public" as const,
            version: 1,
            updatedAt: "2026-08-25T00:00:00.000Z",
          }),
        ),
      }),
    );

    await expect(service.getPrivacy({ principal })).rejects.toBeInstanceOf(
      ProfileRepositoryUnavailableError,
    );
  });
});
