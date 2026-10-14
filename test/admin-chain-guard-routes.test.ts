import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import type { AdminRole } from "../src/features/admin/admin-roles.js";
import { createAdminChainGuardService } from "../src/features/admin/admin-chain-guard.js";
import type { AdminSession } from "../src/features/admin/admin-auth.js";
import type { ChainGuardRepository } from "../src/features/chain-guard/chain-guard-contract.js";
import type { ChainGuardAlertEvent } from "../src/integrations/chain-guard/chain-guard-alerts.js";
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
    const bootstrap = await app.inject({
      method: "POST",
      url: "/admin/v1/session",
      payload: { username: "operator", password: "bootstrap-password-0123" },
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    const bootstrapCookie = (bootstrap.headers["set-cookie"] as string).split(
      ";",
    )[0] as string;
    /** Decision 0135: POST …/incidents/{id}/resolve. */
    const resolve = (
      role: AdminRole | "bootstrap" | null,
      incidentId: string,
      payload: unknown,
    ) =>
      app.inject({
        method: "POST",
        url: `${url}/${incidentId}/resolve`,
        headers:
          role === null
            ? {}
            : {
                cookie:
                  role === "bootstrap" ? bootstrapCookie : cookies.get(role),
              },
        payload: payload as Record<string, unknown>,
      });
    return { call, resolve, admin };
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

  describe("manual resolve (Decision 0135)", () => {
    const chainId = "eip155:56";
    const now = new Date("2026-10-14T00:00:00.000Z");

    async function seeded() {
      const repository = createInMemoryChainGuardRepository();
      const paused = await repository.openOrTouch({
        incidentId: randomUUID(),
        chainId,
        kind: "usd1_paused",
        subject: guardAddress(0x05d1),
        details: { source: "state" },
        now,
      });
      const upgraded = await repository.openOrTouch({
        incidentId: randomUUID(),
        chainId,
        kind: "usd1_upgraded",
        subject: guardAddress(0x3333),
        details: { source: "event" },
        now,
      });
      return {
        repository,
        paused: paused.incident.incidentId,
        upgraded: upgraded.incident.incidentId,
      };
    }

    it("resolves with a note for console.write, audited, and leaves the list", async () => {
      const { repository, paused, upgraded } = await seeded();
      const { call, resolve } = await harness(repository);
      const response = await resolve("platform_admin", paused, {
        note: "  Issuer confirmed the pause was a drill  ",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json<{
        incident: Record<string, unknown>;
        audit: Record<string, unknown>;
      }>();
      expect(body.incident).toMatchObject({
        incidentId: paused,
        kind: "usd1_paused",
        hold: true,
        resolution: "manual",
        resolutionNote: "Issuer confirmed the pause was a drill",
        reopensIfStillTrue: true,
      });
      expect(typeof body.incident["resolvedBy"]).toBe("string");
      expect(body.audit).toMatchObject({ seq: 1 });
      expect(repository.audits).toHaveLength(1);
      expect(repository.audits[0]).toMatchObject({ incidentId: paused });
      const listed = (await call("auditor")).json<{
        holdActive: boolean;
        items: { incidentId: string }[];
      }>();
      expect(listed.holdActive).toBe(false);
      expect(listed.items.map((item) => item.incidentId)).toEqual([upgraded]);

      // An event kind stays closed; the bootstrap admin has no account id.
      const event = await resolve("bootstrap", upgraded, { note: "reviewed" });
      expect(event.statusCode, event.body).toBe(200);
      expect(event.json()).toMatchObject({
        incident: { resolvedBy: null, reopensIfStillTrue: false },
      });
    });

    it("is 409 when already resolved and 404 for an unknown incident", async () => {
      const { repository, paused } = await seeded();
      const { resolve } = await harness(repository);
      expect(
        (await resolve("platform_admin", paused, { note: "a" })).statusCode,
      ).toBe(200);
      const again = await resolve("platform_admin", paused, { note: "b" });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({
        code: "ADMIN_CONFLICT",
        detailsSafe: { reasonCode: "CHAIN_GUARD_INCIDENT_ALREADY_RESOLVED" },
      });
      expect(repository.audits).toHaveLength(1);
      for (const id of [randomUUID(), "not-a-uuid"]) {
        const missing = await resolve("platform_admin", id, { note: "a" });
        expect(missing.statusCode, id).toBe(404);
        expect(missing.json()).toMatchObject({
          code: "NOT_FOUND",
          detailsSafe: { reasonCode: "CHAIN_GUARD_INCIDENT_NOT_FOUND" },
        });
      }
    });

    it("validates the note", async () => {
      const { repository, paused } = await seeded();
      const { resolve } = await harness(repository);
      for (const payload of [
        {},
        { note: "" },
        { note: "x".repeat(501) },
        { note: "a", extra: 1 },
      ]) {
        const refused = await resolve("platform_admin", paused, payload);
        expect(
          refused.statusCode,
          JSON.stringify(payload),
        ).toBeGreaterThanOrEqual(400);
        expect(refused.statusCode).toBeLessThan(500);
      }
      for (const note of ["   ", "bell\u0007", "zero\u200bwidth"]) {
        const refused = await resolve("platform_admin", paused, { note });
        expect(refused.statusCode, note).toBe(422);
        expect(refused.json()).toMatchObject({
          code: "VALIDATION_FAILED",
          detailsSafe: { reasonCode: "CHAIN_GUARD_RESOLUTION_NOTE_INVALID" },
        });
      }
      expect(repository.rows.every((row) => row.resolvedAt === null)).toBe(
        true,
      );
      const multiline = await resolve("platform_admin", paused, {
        note: "line one\n\tline two",
      });
      expect(multiline.statusCode).toBe(200);
    });

    it("refuses without console.write, without a session, and without the repository", async () => {
      const { repository, paused } = await seeded();
      const { resolve } = await harness(repository);
      expect((await resolve(null, paused, { note: "a" })).statusCode).toBe(401);
      for (const role of ["auditor", "reviewer", "testnet_acceptor"] as const) {
        const refused = await resolve(role, paused, { note: "a" });
        expect(refused.statusCode, role).toBe(403);
        expect(refused.json()).toMatchObject({ code: "PERMISSION_DENIED" });
      }
      expect(repository.audits).toHaveLength(0);
      const missing = await harness(undefined);
      const unavailable = await missing.resolve("platform_admin", paused, {
        note: "a",
      });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: { reasonCode: "CHAIN_GUARD_REPOSITORY_UNAVAILABLE" },
      });
    });

    it("announces a manual resolve on the alert outlets (service)", async () => {
      const { repository, paused } = await seeded();
      const sent: ChainGuardAlertEvent[] = [];
      const service = createAdminChainGuardService({
        repository,
        chainId,
        now: () => now,
        alerts: {
          notify: (event) => {
            sent.push(event);
            return Promise.resolve();
          },
        },
      });
      const session = {
        actor: "operator",
        accountId: null,
      } as unknown as AdminSession;
      await service.resolveIncident(
        { session, requestId: randomUUID() },
        paused,
        { note: "drill" },
      );
      expect(sent).toEqual([
        expect.objectContaining({
          type: "incident_resolved",
          resolution: "manual",
          kind: "usd1_paused",
          chainId,
        }),
      ]);
    });
  });
});
