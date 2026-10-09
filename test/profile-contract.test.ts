import { describe, expect, it, vi } from "vitest";

import {
  ProfileRepositoryVersionConflictError,
  type ProfileRepository,
} from "../src/database/profile-repository.js";
import {
  defaultPrivacyValues,
  defaultProfileValues,
  parseProfileResource,
  parseReplacePrivacyRequest,
  parseReplaceProfileRequest,
} from "../src/features/profile/profile-contract.js";
import {
  ProfileVersionConflictError,
  createProfileService,
} from "../src/features/profile/profile-service.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const principal = Object.freeze({
  userId: ownerUserId,
  privyUserId: "did:privy:profile-contract-user",
  streamUserId: "loop_6d12a86e413447e69312c5ef75a30f55",
});

function repository() {
  const getProfile = vi.fn<ProfileRepository["getProfile"]>(() =>
    Promise.resolve(null),
  );
  const replaceProfile = vi.fn<ProfileRepository["replaceProfile"]>((input) =>
    Promise.resolve({
      ownerUserId: input.ownerUserId,
      alias: input.profile.alias,
      avatarRef: input.profile.avatar_ref,
      version: 1,
      updatedAt: "2026-08-25T00:00:00.000Z",
    }),
  );
  const getPrivacy = vi.fn<ProfileRepository["getPrivacy"]>(() =>
    Promise.resolve(null),
  );
  const replacePrivacy = vi.fn<ProfileRepository["replacePrivacy"]>((input) =>
    Promise.resolve({
      ownerUserId: input.ownerUserId,
      discoverable: input.privacy.discoverable,
      copyTradeVisibility: input.privacy.copy_trade_visibility,
      version: 1,
      updatedAt: "2026-08-25T00:00:00.000Z",
    }),
  );

  return {
    getPrivacy,
    getProfile,
    replacePrivacy,
    replaceProfile,
    value: {
      getProfile,
      replaceProfile,
      getPrivacy,
      replacePrivacy,
    } satisfies ProfileRepository,
  };
}

describe("Profile and privacy contract", () => {
  it("normalizes an alias without treating it as identity", () => {
    expect(
      parseReplaceProfileRequest({
        expected_version: 0,
        profile: {
          alias: "  LOOP 昵称 😀  ",
          avatar_ref: "avatar:users/example/profile-1.png",
        },
      }),
    ).toEqual({
      expected_version: 0,
      profile: {
        alias: "LOOP 昵称 😀",
        avatar_ref: "avatar:users/example/profile-1.png",
      },
    });

    expect(
      parseReplaceProfileRequest({
        expected_version: 0,
        profile: { alias: "😀".repeat(40), avatar_ref: null },
      }).profile.alias,
    ).toBe("😀".repeat(40));
  });

  it.each([
    ["empty after trim", "   "],
    ["more than 40 Unicode code points", "😀".repeat(41)],
    ["C0 control", "bad\nname"],
    ["C1 control", "bad\u0085name"],
    ["unpaired surrogate", "bad\ud800name"],
    ["bidirectional override", "safe\u202ename"],
    ["bidirectional isolate", "safe\u2066name"],
    ["zero-width separator", "safe\u200bname"],
    ["soft hyphen", "safe\u00adname"],
    ["deprecated bidi format control", "safe\u206aname"],
    ["line separator", "safe\u2028name"],
  ])("rejects an alias containing %s", (_label, alias) => {
    expect(() =>
      parseReplaceProfileRequest({
        expected_version: 0,
        profile: { alias, avatar_ref: null },
      }),
    ).toThrow();
  });

  it.each([
    "https://cdn.example/avatar.png",
    "data:image/png;base64,secret",
    "avatar:",
    "avatar:/leading-slash",
    "avatar:user?signature=secret",
    `avatar:${"a".repeat(128)}`,
  ])("rejects non-opaque avatar reference %s", (avatarRef) => {
    expect(() =>
      parseReplaceProfileRequest({
        expected_version: 0,
        profile: { alias: null, avatar_ref: avatarRef },
      }),
    ).toThrow();
  });

  it("requires exact full-replacement request objects", () => {
    expect(() =>
      parseReplaceProfileRequest({
        expected_version: 0,
        profile: { alias: null },
      }),
    ).toThrow();
    expect(() =>
      parseReplaceProfileRequest({
        expected_version: 0,
        profile: { alias: null, avatar_ref: null, owner_user_id: ownerUserId },
      }),
    ).toThrow();
    expect(() =>
      parseReplacePrivacyRequest({
        expected_version: 0,
        privacy: {
          discoverable: false,
          copy_trade_visibility: "private",
          copy_trade_authorized: true,
        },
      }),
    ).toThrow();
    expect(() =>
      parseReplacePrivacyRequest({
        expected_version: 0,
        privacy: {
          discoverable: false,
          copy_trade_visibility: "friends",
        },
      }),
    ).toThrow();
  });

  it("enforces the version-0 timestamp invariant", () => {
    expect(() =>
      parseProfileResource({
        version: 0,
        profile: defaultProfileValues,
        updated_at: "2026-08-25T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      parseProfileResource({
        version: 1,
        profile: defaultProfileValues,
        updated_at: null,
      }),
    ).toThrow();
  });

  it("returns explicit fail-closed defaults without writing", async () => {
    const input = repository();
    const service = createProfileService(input.value);

    await expect(service.getProfile({ principal })).resolves.toEqual({
      version: 0,
      profile: defaultProfileValues,
      updated_at: null,
    });
    await expect(service.getPrivacy({ principal })).resolves.toEqual({
      version: 0,
      privacy: defaultPrivacyValues,
      updated_at: null,
    });

    expect(input.getProfile).toHaveBeenCalledWith(ownerUserId);
    expect(input.getPrivacy).toHaveBeenCalledWith(ownerUserId);
    expect(input.replaceProfile).not.toHaveBeenCalled();
    expect(input.replacePrivacy).not.toHaveBeenCalled();
  });

  it("passes only the authenticated owner and normalized replacement", async () => {
    const input = repository();
    const service = createProfileService(input.value);

    await expect(
      service.replaceProfile({
        principal,
        body: {
          expected_version: 0,
          profile: {
            alias: "  Alice  ",
            avatar_ref: "avatar:alice/main",
          },
        },
      }),
    ).resolves.toMatchObject({
      version: 1,
      profile: { alias: "Alice", avatar_ref: "avatar:alice/main" },
    });
    expect(input.replaceProfile).toHaveBeenCalledWith({
      ownerUserId,
      expectedVersion: 0,
      profile: { alias: "Alice", avatar_ref: "avatar:alice/main" },
    });
  });

  it("maps repository version conflicts to the public domain error", async () => {
    const input = repository();
    input.replacePrivacy.mockRejectedValueOnce(
      new ProfileRepositoryVersionConflictError(),
    );
    const service = createProfileService(input.value);

    await expect(
      service.replacePrivacy({
        principal,
        body: {
          expected_version: 0,
          privacy: {
            discoverable: true,
            copy_trade_visibility: "followers",
          },
        },
      }),
    ).rejects.toBeInstanceOf(ProfileVersionConflictError);
  });
});
