import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import type { AdminRole } from "../src/features/admin/admin-roles.js";
import type { ChainGuardRepository } from "../src/features/chain-guard/chain-guard-contract.js";
import { createInMemoryAdminRepository } from "./helpers/admin-fakes.js";
import {
  createFakeHooksReview,
  createInMemoryAdminAccounts,
  createInMemoryAdminLaunchReview,
} from "./helpers/admin-role-fakes.js";
import {
  createInMemoryChainGuardRepository,
  guardAddress,
  guardPoolId,
} from "./helpers/chain-guard-fakes.js";
import { s7Database, s7PrivyVerifier, s7TestConfig } from "./s7-route-fakes.js";

/**
 * Decision 0134 console contract: `GET /admin/v1/chain-guard/incidents`
 * needs a session with console.read (platform_admin, auditor); reviewer and
 * testnet_acceptor are 403, no session is 401; without the repository it is
 * 503, never an empty list.
 */

const accountPassword = "account-password-0123";
const sessionSecret = "s174-admin-session-secret-0123456789abcdef";
let passwordHash = "";
const url = "/admin/v1/chain-guard/incidents";

beforeAll(async () => {
  passwordHash = await hashAdminPassword("bootstrap-password-0123");
});

describe("Operator console chain guard (Decision 0134)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function harness(chainGuard: ChainGuardRepository | undefined) {
    const admin = createInMemoryAdminRepository();
    const accounts = createInMemoryAdminAccounts(admin);
    const app = await buildApp({
      config: s7TestConfig({
        ADMIN_USERNAME: "operator",
        ADMIN_PASSWORD_HASH: passwordHash,
        ADMIN_SESSION_SECRET: sessionSecret,
      }),
      database: {
        ...s7Database({}),
        admin,
        adminAccounts: accounts,
        adminLaunchReview: createInMemoryAdminLaunchReview([], new Map()),
        hooksLaunchReview: createFakeHooksReview({
          grants: new Map(),
          owners: new Map(),
        }),
        ...(chainGuard === undefined ? {} : { chainGuard }),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      memePauseSender: null,
      logger: false,
    });
    apps.push(app);
    const cookies = new Map<AdminRole, string>();
    const operatorUserId = randomUUID();
    for (const role of [
      "platform_admin",
      "reviewer",
      "auditor",
      "testnet_acceptor",
    ] as const) {
      const username = `${role.replaceAll("_", "-")}-${randomUUID().slice(0, 8)}`;
      await accounts.seed({
        username,
        password: accountPassword,
        role,
        operatorUserId:
          role === "reviewer" || role === "testnet_acceptor"
            ? operatorUserId
            : null,
      });
      const login = await app.inject({
        method: "POST",
        url: "/admin/v1/session",
        payload: { username, password: accountPassword },
      });
      expect(login.statusCode, login.body).toBe(200);
      cookies.set(
        role,
        (login.headers["set-cookie"] as string).split(";")[0] as string,
      );
    }
    const call = (role: AdminRole | null) =>
      app.inject({
        method: "GET",
        url,
        headers: role === null ? {} : { cookie: cookies.get(role) as string },
      });
    return { call };
  }

  it("lists unresolved incidents for console.read, holds flagged", async () => {
    const repository = createInMemoryChainGuardRepository();
    const now = new Date("2026-10-14T00:00:00.000Z");
    const chainId = "eip155:56";
    await repository.openOrTouch({
      incidentId: randomUUID(),
      chainId,
      kind: "usd1_paused",
      subject: guardAddress(0x05d1),
      details: { source: "state" },
      now,
    });
    await repository.openOrTouch({
      incidentId: randomUUID(),
      chainId,
      kind: "pool_protocol_fee_nonzero",
      subject: guardPoolId(7),
      details: { zeroForOnePips: 25, oneForZeroPips: 25 },
      now,
    });
    const resolved = await repository.openOrTouch({
      incidentId: randomUUID(),
      chainId,
      kind: "account_balance_low",
      subject: guardAddress(0xe1),
      details: {},
      now,
    });
    await repository.resolve({
      chainId,
      kinds: ["account_balance_low"],
      keep: [],
      eventsSeenBefore: now,
      now,
    });
    const { call } = await harness(repository);

    for (const role of ["platform_admin", "auditor"] as const) {
      const response = await call(role);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json<{
        chainId: string;
        holdActive: boolean;
        holdKinds: string[];
        items: { incidentId: string; kind: string; hold: boolean }[];
      }>();
      expect(body.chainId).toBe(chainId);
      expect(body.holdActive).toBe(true);
      expect(body.holdKinds).toEqual(["usd1_paused", "usd1_address_frozen"]);
      expect(body.items.map((item) => [item.kind, item.hold])).toEqual([
        ["usd1_paused", true],
        ["pool_protocol_fee_nonzero", false],
      ]);
      expect(body.items.map((item) => item.incidentId)).not.toContain(
        resolved.incident.incidentId,
      );
    }
  });

  it("refuses without a session or without console.read", async () => {
    const { call } = await harness(createInMemoryChainGuardRepository());
    const anonymous = await call(null);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: "ADMIN_SESSION_REQUIRED" });
    for (const role of ["reviewer", "testnet_acceptor"] as const) {
      const refused = await call(role);
      expect(refused.statusCode, role).toBe(403);
      expect(refused.json()).toMatchObject({ code: "PERMISSION_DENIED" });
    }
  });

  it("is 503 without the repository (never an empty all-clear)", async () => {
    const { call } = await harness(undefined);
    const response = await call("platform_admin");
    expect(response.statusCode).toBe(503);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "CHAIN_GUARD_REPOSITORY_UNAVAILABLE" },
    });
    expect(Object.keys(body).sort()).toEqual([
      "category",
      "code",
      "correlationId",
      "detailsSafe",
      "providerReferenceSafe",
      "retryable",
      "userMessageKey",
    ]);
  });
});
