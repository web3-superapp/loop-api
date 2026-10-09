import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  adminPrincipalFromAccount,
  assertAdminPermission,
  requireAdminIdempotencyKey,
  type AdminAccountRecord,
} from "../src/features/admin/admin-accounts.js";
import { createAdminSessionCodec } from "../src/features/admin/admin-auth.js";
import { AdminApiError } from "../src/features/admin/admin-contract.js";
import { adminLaunchReviewErrorProjection } from "../src/features/admin/admin-launch-review.js";
import {
  adminPermissions,
  adminRoleHasPermission,
  adminRoleOpsGrants,
  adminRolePermissions,
  adminRoles,
  type AdminPermission,
  type AdminRole,
} from "../src/features/admin/admin-roles.js";
import { hooksLaunchReviewErrorCodes } from "../src/features/launch/hooks-launch-review.js";

/**
 * Decision 0109 unit rules: the role → permission table, the role →
 * ops_grants derivation, the v2 session cookie, the principal, and the
 * error projection of the Decision 0108 refusals.
 */

const expected: Readonly<Record<AdminRole, readonly AdminPermission[]>> = {
  platform_admin: [
    "accounts.manage",
    "accounts.read",
    "audit.read",
    "console.read",
    "console.write",
    "launch.read",
    "testnet.read",
  ],
  reviewer: ["audit.read", "formula.approve", "launch.approve", "launch.read"],
  testnet_acceptor: [
    "audit.read",
    "launch.read",
    "testnet.accept",
    "testnet.read",
  ],
  auditor: [
    "accounts.read",
    "audit.read",
    "console.read",
    "launch.read",
    "testnet.read",
  ],
};

function account(
  overrides: Partial<AdminAccountRecord> = {},
): AdminAccountRecord {
  return {
    accountId: randomUUID(),
    username: "someone",
    role: "reviewer",
    operatorUserId: randomUUID(),
    passwordMustChange: false,
    credentialsVersion: 1,
    credentialsChangedAt: "2026-10-10T00:00:00.000Z",
    createdAt: "2026-10-10T00:00:00.000Z",
    createdBy: "operator",
    disabledAt: null,
    disabledBy: null,
    ...overrides,
  };
}

describe("Decision 0109 role table", () => {
  it("derives exactly the documented permissions per role", () => {
    for (const role of adminRoles) {
      expect(adminRolePermissions(role), role).toEqual(expected[role]);
    }
  });

  it("separates editing, approving, and accepting", () => {
    // No role holds two of: console.write (edit), launch.approve, testnet.accept.
    for (const role of adminRoles) {
      const duties = (
        ["console.write", "launch.approve", "testnet.accept"] as const
      ).filter((permission) => adminRoleHasPermission(role, permission));
      expect(duties.length, role).toBeLessThanOrEqual(1);
    }
    expect(adminRoleHasPermission("platform_admin", "launch.approve")).toBe(
      false,
    );
    expect(adminRoleHasPermission("platform_admin", "testnet.accept")).toBe(
      false,
    );
    expect(adminRoleHasPermission("reviewer", "testnet.accept")).toBe(false);
    // Decision 0110: whoever edits the mining formula never approves it.
    for (const role of adminRoles) {
      expect(
        adminRoleHasPermission(role, "console.write") &&
          adminRoleHasPermission(role, "formula.approve"),
        role,
      ).toBe(false);
    }
    expect(adminRoleHasPermission("platform_admin", "formula.approve")).toBe(
      false,
    );
    expect(adminRoleHasPermission("reviewer", "formula.approve")).toBe(true);
    expect(adminRoleHasPermission("testnet_acceptor", "launch.approve")).toBe(
      false,
    );
    // Only the platform administrator manages accounts.
    for (const role of adminRoles) {
      expect(adminRoleHasPermission(role, "accounts.manage"), role).toBe(
        role === "platform_admin",
      );
    }
    // Every permission is held by some role.
    for (const permission of adminPermissions) {
      expect(
        adminRoles.some((role) => adminRoleHasPermission(role, permission)),
        permission,
      ).toBe(true);
    }
  });

  it("derives ops grants for bound roles only, scoped per project", () => {
    expect(adminRoleOpsGrants("platform_admin", null)).toEqual([]);
    expect(adminRoleOpsGrants("auditor", null)).toEqual([]);
    expect(adminRoleOpsGrants("reviewer", null)).toEqual([
      { permission: "audit.read", scope: "*" },
      { permission: "launch.approve", scope: "*" },
      { permission: "launch.read", scope: "*" },
    ]);
    const [a, b] = [
      "00000000-0000-4000-8000-00000000000a",
      "00000000-0000-4000-8000-00000000000b",
    ];
    expect(adminRoleOpsGrants("testnet_acceptor", [b, a])).toEqual([
      { permission: "audit.read", scope: "*" },
      { permission: "launch.read", scope: a },
      { permission: "launch.read", scope: b },
      { permission: "testnet.accept", scope: a },
      { permission: "testnet.accept", scope: b },
      { permission: "testnet.read", scope: a },
      { permission: "testnet.read", scope: b },
    ]);
    for (const grant of adminRoleOpsGrants("reviewer", [a])) {
      expect(grant.permission).not.toBe("launch.edit");
      expect(grant.permission).not.toBe("testnet.accept");
    }
  });
});

describe("Decision 0109 principal and cookie", () => {
  it("issues account sessions bound to the credentials version", () => {
    let now = Date.parse("2026-10-10T00:00:00.000Z");
    const codec = createAdminSessionCodec({
      secret: "a".repeat(40),
      username: "operator",
      now: () => new Date(now),
    });
    const accountId = randomUUID();
    const issued = codec.issue({
      actor: "rev-a",
      accountId,
      role: "reviewer",
      credentialsVersion: 3,
    });
    expect(codec.verify(issued.token)).toMatchObject({
      actor: "rev-a",
      accountId,
      role: "reviewer",
      credentialsVersion: 3,
    });
    const bootstrap = codec.issue("operator");
    expect(codec.verify(bootstrap.token)).toMatchObject({
      accountId: null,
      role: "platform_admin",
      credentialsVersion: null,
    });
    // A tampered payload (role swapped) fails the signature.
    const [payload, signature] = issued.token.split(".") as [string, string];
    const body = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const forged = Buffer.from(
      JSON.stringify({ ...body, rol: "platform_admin" }),
    ).toString("base64url");
    expect(codec.verify(`${forged}.${signature}`)).toBeNull();
    now += 12 * 3600 * 1000;
    expect(codec.verify(issued.token)).toBeNull();
  });

  it("empties the permissions while a password change is required", () => {
    const codec = createAdminSessionCodec({
      secret: "a".repeat(40),
      username: "operator",
    });
    const record = account({ role: "auditor", operatorUserId: null });
    const session = codec.issue({
      actor: record.username,
      accountId: record.accountId,
      role: record.role,
      credentialsVersion: 1,
    }).session;
    const pending = adminPrincipalFromAccount(session, {
      ...record,
      passwordMustChange: true,
    });
    expect(pending.permissions).toEqual([]);
    expect(() => {
      assertAdminPermission(pending, "audit.read");
    }).toThrow(AdminApiError);
    try {
      assertAdminPermission(pending, "audit.read");
    } catch (error) {
      expect((error as AdminApiError).detailsSafe).toMatchObject({
        reasonCode: "ADMIN_PASSWORD_CHANGE_REQUIRED",
      });
    }
    const active = adminPrincipalFromAccount(session, record);
    expect(() => {
      assertAdminPermission(active, "audit.read");
    }).not.toThrow();
    try {
      assertAdminPermission(active, "console.write");
      expect.unreachable();
    } catch (error) {
      expect((error as AdminApiError).code).toBe("PERMISSION_DENIED");
      expect((error as AdminApiError).statusCode).toBe(403);
      expect((error as AdminApiError).detailsSafe).toMatchObject({
        reasonCode: "ADMIN_ROLE_FORBIDDEN",
        permission: "console.write",
      });
    }
    const bootstrap = adminPrincipalFromAccount(
      codec.issue("operator").session,
      null,
    );
    expect(bootstrap.role).toBe("platform_admin");
    expect(() => {
      assertAdminPermission(bootstrap, "launch.approve");
    }).toThrow(AdminApiError);
  });

  it("accepts only canonical UUIDv4 idempotency keys", () => {
    const key = randomUUID();
    expect(requireAdminIdempotencyKey(key)).toBe(key);
    for (const bad of [
      undefined,
      "",
      key.toUpperCase(),
      "00000000-0000-1000-8000-000000000000",
      `${key},${key}`,
    ]) {
      expect(() => requireAdminIdempotencyKey(bad)).toThrow(AdminApiError);
    }
  });

  it("projects every Decision 0108 refusal onto the console catalog", () => {
    const statuses = new Map<string, number>();
    for (const code of hooksLaunchReviewErrorCodes) {
      const error = adminLaunchReviewErrorProjection(code);
      statuses.set(code, error.statusCode);
    }
    expect(statuses.get("OPS_SELF_APPROVAL")).toBe(403);
    expect(statuses.get("OPS_SELF_ACCEPTANCE")).toBe(403);
    expect(statuses.get("OPS_FORBIDDEN")).toBe(403);
    expect(statuses.get("OPS_NOT_FOUND")).toBe(404);
    expect(statuses.get("OPS_VERSION_CONFLICT")).toBe(409);
    expect(statuses.get("OPS_IDEMPOTENCY_CONFLICT")).toBe(409);
    expect(statuses.get("OPS_UNAVAILABLE")).toBe(503);
    expect(statuses.get("OPS_INVALID_COMMAND")).toBe(422);
  });
});
