import { describe, expect, it, vi } from "vitest";

import { parseAdminConsoleConfig } from "../src/config.js";
import {
  createAdminLoginThrottle,
  createAdminSessionCodec,
  hashAdminPassword,
  readCookie,
  verifyAdminPassword,
} from "../src/features/admin/admin-auth.js";
import {
  adminErrorCodes,
  isAdminRequestPath,
  projectAdminError,
  AdminApiError,
} from "../src/features/admin/admin-contract.js";
import type {
  AdminRepository,
  AdminSettingRecord,
} from "../src/features/admin/admin-repository.js";
import {
  createAdminSettingsReader,
  databaseIntelPromotionsConfigVersion,
  resolveIntelPromotions,
} from "../src/features/admin/admin-settings-reader.js";
import { intelPromotions } from "../src/features/market/intel-promotions.js";
import { createPublicProfileService } from "../src/features/profile/public-profile-service.js";
import type { PublicProfileRepository } from "../src/features/profile/public-profile-repository.js";
import { runAdminHashPassword } from "../scripts/admin-hash-password.js";

/**
 * Decision 0102 units: password hashing, the session cookie, the login
 * lock, and the "database first, constant second" read priority.
 */

describe("admin password and session", () => {
  it("hashes to an argon2id PHC string and verifies only the right password", async () => {
    const hash = await hashAdminPassword("correct-horse-battery");
    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/u,
    );
    expect(await verifyAdminPassword("correct-horse-battery", hash)).toBe(true);
    expect(await verifyAdminPassword("correct-horse-batterz", hash)).toBe(
      false,
    );
    expect(await verifyAdminPassword("x", "not-a-phc")).toBe(false);
    await expect(hashAdminPassword("short")).rejects.toThrow();
    expect(
      parseAdminConsoleConfig({
        ADMIN_USERNAME: "operator",
        ADMIN_PASSWORD_HASH: hash,
        ADMIN_SESSION_SECRET: "s".repeat(32),
        PUBLIC_BASE_URL: "https://api-dev.example.com",
      }),
    ).toMatchObject({ username: "operator", cookieSecure: true });
  });

  it("prints a quoted env line from piped input and never the password", async () => {
    const chunks: string[] = [];
    const listeners: Record<string, (chunk?: string) => void> = {};
    const input = {
      isTTY: false,
      setEncoding: vi.fn(),
      on: (event: string, listener: (chunk?: string) => void) => {
        listeners[event] = listener;
      },
      removeAllListeners: vi.fn(),
      pause: vi.fn(),
      resume: () => {
        listeners["data"]?.("correct-horse-battery\n");
        listeners["end"]?.();
      },
    };
    const code = await runAdminHashPassword({
      input: input as unknown as Parameters<
        typeof runAdminHashPassword
      >[0]["input"],
      stdout: { write: (text: string) => chunks.push(text) },
      stderr: { write: (text: string) => chunks.push(text) },
    });
    expect(code).toBe(0);
    const output = chunks.join("");
    expect(output).toMatch(/^ADMIN_PASSWORD_HASH='\$argon2id\$[^']+'\n$/u);
    expect(output).not.toContain("correct-horse-battery");
  });

  it("signs, expires, and revokes session cookies", () => {
    let now = Date.parse("2026-10-08T00:00:00.000Z");
    const codec = createAdminSessionCodec({
      secret: "a".repeat(40),
      username: "operator",
      now: () => new Date(now),
    });
    const issued = codec.issue("operator");
    expect(codec.verify(issued.token)?.actor).toBe("operator");
    const other = createAdminSessionCodec({
      secret: "b".repeat(40),
      username: "operator",
      now: () => new Date(now),
    });
    expect(other.verify(issued.token)).toBeNull();
    const renamed = createAdminSessionCodec({
      secret: "a".repeat(40),
      username: "someone-else",
      now: () => new Date(now),
    });
    expect(renamed.verify(issued.token)).toBeNull();
    expect(codec.verify(`${issued.token}x`)).toBeNull();
    expect(codec.verify(undefined)).toBeNull();
    const second = codec.issue("operator");
    codec.revoke(second.session);
    expect(codec.verify(second.token)).toBeNull();
    expect(codec.verify(issued.token)).not.toBeNull();
    now += 12 * 3600 * 1000;
    expect(codec.verify(issued.token)).toBeNull();
  });

  it("locks after five failures for fifteen minutes", () => {
    let now = 0;
    const throttle = createAdminLoginThrottle({ now: () => new Date(now) });
    for (let index = 0; index < 4; index += 1) {
      throttle.recordFailure();
      expect(throttle.lockedForSeconds()).toBe(0);
    }
    throttle.recordFailure();
    expect(throttle.lockedForSeconds()).toBe(900);
    now += 899_000;
    expect(throttle.lockedForSeconds()).toBe(1);
    now += 1_000;
    expect(throttle.lockedForSeconds()).toBe(0);
    throttle.recordFailure();
    expect(throttle.lockedForSeconds()).toBe(0);
  });

  it("parses cookies and projects the seven-field envelope", () => {
    expect(
      readCookie("a=1; loop_admin_session=x.y; b=2", "loop_admin_session"),
    ).toBe("x.y");
    expect(readCookie(undefined, "loop_admin_session")).toBeUndefined();
    expect(isAdminRequestPath("/admin/v1/overview?x=1")).toBe(true);
    expect(isAdminRequestPath("/admin/v10")).toBe(false);
    expect(isAdminRequestPath("/v2/admin/v1")).toBe(false);
    const projection = projectAdminError(
      new AdminApiError("ADMIN_LOGIN_LOCKED", { retryAfterSeconds: 10 }),
      "0f1e2d3c-4b5a-4968-8776-655443322110",
    );
    expect(projection.statusCode).toBe(423);
    expect(Object.keys(projection.response).sort()).toEqual([
      "category",
      "code",
      "correlationId",
      "detailsSafe",
      "providerReferenceSafe",
      "retryable",
      "userMessageKey",
    ]);
    expect(projectAdminError(new Error("boom"), "x").response.code).toBe(
      "INTERNAL_ERROR",
    );
    expect(adminErrorCodes).toContain("ADMIN_CONFLICT");
  });
});

function settingRepository(
  rows: Partial<Record<string, AdminSettingRecord>>,
): Pick<AdminRepository, "getSetting"> & { calls: number } {
  const repository = {
    calls: 0,
    getSetting(key: string) {
      repository.calls += 1;
      return Promise.resolve(rows[key] ?? null);
    },
  };
  return repository;
}

const silent = { warn: vi.fn() };

describe("read priority: database first, constant second", () => {
  const card = {
    id: "5b0f8a2e-6d1c-4e7a-9b3f-2c8d4e6f1aff",
    title: "运营活动",
    subtitle: "",
    imageUrl: null,
    deeplink: "/square",
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: "2099-01-01T00:00:00.000Z",
    order: 0,
  };

  it("serves the shipped promotions when no row exists", async () => {
    const reader = createAdminSettingsReader({
      repository: settingRepository({}),
      logger: silent,
    });
    const resource = await resolveIntelPromotions(
      reader,
      new Date("2026-10-09T00:00:00.000Z"),
    );
    expect(resource.configVersion).toBe("intelPromotionsV1");
    expect(resource.items.map((item) => item.id)).toEqual(
      intelPromotions.map((item) => item.id),
    );
    expect(await resolveIntelPromotions(null, new Date())).toMatchObject({
      configVersion: "intelPromotionsV1",
    });
  });

  it("serves the database promotions with a db configVersion", async () => {
    const updatedAt = "2026-10-08T12:00:00.123Z";
    const reader = createAdminSettingsReader({
      repository: settingRepository({
        intel_promotions: {
          key: "intel_promotions",
          value: [card],
          updatedAt,
          updatedBy: "operator",
        },
      }),
      logger: silent,
    });
    const resource = await resolveIntelPromotions(
      reader,
      new Date("2026-10-09T00:00:00.000Z"),
    );
    expect(resource).toMatchObject({
      items: [card],
      configVersion: `intelPromotionsV1+db.${Date.parse(updatedAt)}`,
      effectiveAt: updatedAt,
    });
    expect(databaseIntelPromotionsConfigVersion(updatedAt)).toBe(
      "intelPromotionsV1+db.1791460800123",
    );
  });

  it("falls back to the constant when the stored value does not validate", async () => {
    const warn = vi.fn();
    const reader = createAdminSettingsReader({
      repository: settingRepository({
        intel_promotions: {
          key: "intel_promotions",
          value: [{ ...card, deeplink: "https://example.com" }],
          updatedAt: "2026-10-08T00:00:00.000Z",
          updatedBy: "operator",
        },
      }),
      logger: { warn },
    });
    expect(await reader.intelPromotions()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("caches for the TTL and refreshes after invalidate", async () => {
    let now = 0;
    const rows: Partial<Record<string, AdminSettingRecord>> = {};
    const repository = settingRepository(rows);
    const reader = createAdminSettingsReader({
      repository,
      logger: silent,
      now: () => now,
    });
    expect(await reader.recommendedCommunityIds()).toBeNull();
    rows["recommended_community_ids"] = {
      key: "recommended_community_ids",
      value: ["22222222-2222-4222-8222-222222222222"],
      updatedAt: "2026-10-08T00:00:00.000Z",
      updatedBy: "operator",
    };
    expect(await reader.recommendedCommunityIds()).toBeNull();
    now += 60_000;
    expect(await reader.recommendedCommunityIds()).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
    delete rows["recommended_community_ids"];
    reader.invalidate("recommended_community_ids");
    expect(await reader.recommendedCommunityIds()).toBeNull();
    expect(repository.calls).toBe(3);
  });

  it("keeps the last known value when the database read fails", async () => {
    let fail = false;
    const reader = createAdminSettingsReader({
      repository: {
        getSetting: () =>
          fail
            ? Promise.reject(new Error("down"))
            : Promise.resolve({
                key: "recommended_community_ids",
                value: ["33333333-3333-4333-8333-333333333333"],
                updatedAt: "2026-10-08T00:00:00.000Z",
                updatedBy: "operator",
              }),
      },
      logger: silent,
      ttlMs: 0,
    });
    expect(await reader.recommendedCommunityIds()).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
    fail = true;
    expect(await reader.recommendedCommunityIds()).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
  });

  it("recommends the database list over RECOMMENDED_COMMUNITY_IDS", async () => {
    const asked: (readonly string[])[] = [];
    const repository = {
      listVerifiedCommunitiesByIds: (ids: readonly string[]) => {
        asked.push(ids);
        return Promise.resolve([]);
      },
    } as unknown as PublicProfileRepository;
    const base = {
      repository,
      walletReadService: null,
      assets: { getAsset: () => Promise.resolve(null) },
      cursorCodec: null,
      chainId: "eip155:56",
      usd1Address: null,
      recommendedCommunityIds: ["44444444-4444-4444-8444-444444444444"],
    };
    const principal = {
      userId: "55555555-5555-4555-8555-555555555555",
    } as never;
    await createPublicProfileService(base).listRecommendedCommunities({
      principal,
    });
    await createPublicProfileService({
      ...base,
      recommendedCommunityIdsOverride: () => Promise.resolve(null),
    }).listRecommendedCommunities({ principal });
    await createPublicProfileService({
      ...base,
      recommendedCommunityIdsOverride: () =>
        Promise.resolve(["66666666-6666-4666-8666-666666666666"]),
    }).listRecommendedCommunities({ principal });
    expect(asked).toEqual([
      ["44444444-4444-4444-8444-444444444444"],
      ["44444444-4444-4444-8444-444444444444"],
      ["66666666-6666-4666-8666-666666666666"],
    ]);
  });
});
