import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPostgresAccountSettingsRepository } from "../src/database/account-settings-repository.js";
import { createPostgresDeviceSessionRepository } from "../src/database/device-session-repository.js";
import { createPostgresNotificationRepository } from "../src/database/notification-repository.js";
import { createPostgresSupportTicketRepository } from "../src/database/support-ticket-repository.js";
import { deviceRevokedNotification } from "../src/features/security/device-service.js";
import { DeviceSessionIdempotencyConflictError } from "../src/features/session/device-session-repository.js";
import { AccountSettingsVersionConflictError } from "../src/features/settings/account-settings-repository.js";
import { supportTicketCreateDigest } from "../src/features/support/support-contract.js";
import {
  SupportTicketIdempotencyConflictError,
  SupportTicketNotFoundError,
  SupportTicketStateError,
} from "../src/features/support/support-ticket-repository.js";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

const pool = new Pool({ connectionString: databaseUrl });
const testPrivyPrefix = "security-settings-support-test:";
const sha = (seed: string): string =>
  supportTicketCreateDigest({ category: "other", body: seed });

const deviceSessions = createPostgresDeviceSessionRepository(pool);
const settings = createPostgresAccountSettingsRepository(pool);
const tickets = createPostgresSupportTicketRepository(pool);
const notifications = createPostgresNotificationRepository(pool);

async function cleanFixtures(): Promise<void> {
  const owners = `select id from public.loop_users where privy_user_id like $1`;
  const values = [`${testPrivyPrefix}%`];
  await pool.query(
    `alter table public.support_ticket_events disable trigger support_ticket_events_immutable`,
  );
  await pool.query(
    `alter table public.support_tickets disable trigger support_tickets_guard_mutation`,
  );
  await pool.query(
    `alter table public.device_session_events disable trigger device_session_events_immutable`,
  );
  await pool.query(
    `alter table public.device_session_commands disable trigger device_session_commands_guard_mutation`,
  );
  try {
    for (const table of [
      "support_ticket_events",
      "support_tickets",
      "notifications",
      "idempotency_records",
      "account_settings",
      "device_session_events",
      "device_session_commands",
      "device_sessions",
    ]) {
      await pool.query({
        text: `delete from public.${table} where owner_user_id in (${owners})`,
        values,
      });
    }
    await pool.query({
      text: `delete from public.loop_users where privy_user_id like $1`,
      values,
    });
  } finally {
    await pool.query(
      `alter table public.device_session_commands enable trigger device_session_commands_guard_mutation`,
    );
    await pool.query(
      `alter table public.device_session_events enable trigger device_session_events_immutable`,
    );
    await pool.query(
      `alter table public.support_tickets enable trigger support_tickets_guard_mutation`,
    );
    await pool.query(
      `alter table public.support_ticket_events enable trigger support_ticket_events_immutable`,
    );
  }
}

async function createOwner(): Promise<string> {
  const result = await pool.query<{ id: string }>({
    text: `insert into public.loop_users (privy_user_id) values ($1) returning id`,
    values: [`${testPrivyPrefix}${randomUUID()}`],
  });
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("owner insert returned no id");
  }
  return id;
}

async function createSession(ownerUserId: string, deviceId = randomUUID()) {
  return deviceSessions.create({
    ownerUserId,
    idempotencyKey: randomUUID(),
    requestSha256: "a".repeat(64),
    requestId: randomUUID(),
    deviceId,
    clientPlatform: "ios",
    clientVersion: "1.0.0",
  });
}

describe("security, settings, and support repositories (migration 000024)", () => {
  beforeAll(cleanFixtures);
  afterEach(cleanFixtures);
  afterAll(async () => {
    await pool.end();
  });

  describe("device sessions", () => {
    it("lists an owner's sessions newest first with active rows before revoked ones", async () => {
      const owner = await createOwner();
      const first = await createSession(owner);
      const second = await createSession(owner);
      const third = await createSession(owner);
      const stranger = await createOwner();
      await createSession(stranger);

      const revoke = await deviceSessions.revoke({
        ownerUserId: owner,
        sessionId: third.sessionId,
        idempotencyKey: randomUUID(),
        requestSha256: "b".repeat(64),
        requestId: randomUUID(),
        commandKind: "revoke",
      });
      expect(revoke?.status).toBe("revoked");

      const listed = await deviceSessions.listByOwner(owner, 100);
      expect(listed.map((session) => session.sessionId)).toEqual([
        second.sessionId,
        first.sessionId,
        third.sessionId,
      ]);
      expect(listed.every((session) => session.ownerUserId === owner)).toBe(
        true,
      );
      expect(await deviceSessions.listByOwner(owner, 2)).toHaveLength(2);
    });

    it("records a remote revoke as its own command kind with a session_revoked event", async () => {
      const owner = await createOwner();
      const target = await createSession(owner);
      const key = randomUUID();
      const input = {
        ownerUserId: owner,
        sessionId: target.sessionId,
        idempotencyKey: key,
        requestSha256: "c".repeat(64),
        requestId: randomUUID(),
        commandKind: "revoke" as const,
      };

      const revoked = await deviceSessions.revoke(input);
      expect(revoked).toMatchObject({
        sessionId: target.sessionId,
        status: "revoked",
      });
      expect(revoked?.revokedAt).not.toBeNull();

      const command = await pool.query<Record<string, unknown>>({
        text: `
          select command_kind, request_digest_version, result_status, resolved_session_id
          from public.device_session_commands
          where idempotency_key = $1
        `,
        values: [key],
      });
      expect(command.rows).toEqual([
        {
          command_kind: "revoke",
          request_digest_version: "device_session_revoke_v1",
          result_status: "revoked",
          resolved_session_id: target.sessionId,
        },
      ]);
      const events = await pool.query<{ event_type: string }>({
        text: `
          select event_type from public.device_session_events
          where session_id = $1 order by event_version
        `,
        values: [target.sessionId],
      });
      expect(events.rows.map((row) => row.event_type)).toEqual([
        "session_created",
        "session_revoked",
      ]);

      const replay = await deviceSessions.revoke(input);
      expect(replay?.revokedAt).toBe(revoked?.revokedAt);
      await expect(
        deviceSessions.revoke({ ...input, requestSha256: "d".repeat(64) }),
      ).rejects.toBeInstanceOf(DeviceSessionIdempotencyConflictError);
      // The same key under the logout kind is a different idempotency domain.
      await expect(
        deviceSessions.revoke({ ...input, commandKind: "logout" }),
      ).resolves.toMatchObject({ status: "revoked" });

      const notFound = await deviceSessions.revoke({
        ownerUserId: owner,
        sessionId: randomUUID(),
        idempotencyKey: randomUUID(),
        requestSha256: "e".repeat(64),
        requestId: randomUUID(),
        commandKind: "revoke",
      });
      expect(notFound).toBeNull();
    });
  });

  describe("account settings", () => {
    it("reads the version-0 default without writing and replaces through the CAS version", async () => {
      const owner = await createOwner();
      const fixed = { displayCurrency: "USD", language: "zh-CN" } as const;
      expect(await settings.get(owner)).toEqual({
        version: 0,
        updatedAt: null,
        settings: fixed,
      });
      const rows = await pool.query({
        text: `select 1 from public.account_settings where owner_user_id = $1`,
        values: [owner],
      });
      expect(rows.rowCount).toBe(0);

      const first = await settings.replace({
        ownerUserId: owner,
        expectedVersion: 0,
        settings: fixed,
      });
      expect(first.version).toBe(1);
      expect(first.updatedAt).not.toBeNull();

      const retry = await settings.replace({
        ownerUserId: owner,
        expectedVersion: 0,
        settings: fixed,
      });
      expect(retry).toEqual(first);

      const second = await settings.replace({
        ownerUserId: owner,
        expectedVersion: 1,
        settings: fixed,
      });
      expect(second.version).toBe(2);

      await expect(
        settings.replace({
          ownerUserId: owner,
          expectedVersion: 0,
          settings: fixed,
        }),
      ).rejects.toBeInstanceOf(AccountSettingsVersionConflictError);
      await expect(
        settings.replace({
          ownerUserId: owner,
          expectedVersion: 9,
          settings: fixed,
        }),
      ).rejects.toBeInstanceOf(AccountSettingsVersionConflictError);
      expect((await settings.get(owner)).version).toBe(2);
    });

    it("refuses any value other than the fixed constants at the database", async () => {
      const owner = await createOwner();
      await expect(
        pool.query({
          text: `insert into public.account_settings (owner_user_id, display_currency) values ($1, 'EUR')`,
          values: [owner],
        }),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("support tickets", () => {
    it("creates a ticket once per key, replays it, and conflicts on a different digest", async () => {
      const owner = await createOwner();
      const key = randomUUID();
      const input = {
        ownerUserId: owner,
        idempotencyKey: key,
        requestSha256: sha("first"),
        requestId: randomUUID(),
        category: "other" as const,
        body: "first",
      };
      const created = await tickets.create(input);
      expect(created.created).toBe(true);
      expect(created.ticket).toMatchObject({
        ownerUserId: owner,
        category: "other",
        body: "first",
        status: "open",
      });
      expect(created.ticket.events).toEqual([
        expect.objectContaining({
          eventVersion: 0,
          eventType: "created",
          actor: "user",
          note: null,
        }),
      ]);

      const replay = await tickets.create(input);
      expect(replay.created).toBe(false);
      expect(replay.ticket.ticketId).toBe(created.ticket.ticketId);

      await expect(
        tickets.create({
          ...input,
          requestSha256: sha("second"),
          body: "second",
        }),
      ).rejects.toBeInstanceOf(SupportTicketIdempotencyConflictError);

      const stranger = await createOwner();
      await expect(
        tickets.create({ ...input, ownerUserId: stranger }),
      ).rejects.toBeInstanceOf(SupportTicketIdempotencyConflictError);
    });

    it("lists newest first with a keyset continuation and advances only through the operator path", async () => {
      const owner = await createOwner();
      const ids: string[] = [];
      for (const body of ["one", "two", "three"]) {
        const result = await tickets.create({
          ownerUserId: owner,
          idempotencyKey: randomUUID(),
          requestSha256: sha(body),
          requestId: randomUUID(),
          category: "mining",
          body,
        });
        ids.push(result.ticket.ticketId);
      }
      const page = await tickets.list({ ownerUserId: owner, limit: 2 });
      expect(page.hasMore).toBe(true);
      expect(page.items.map((ticket) => ticket.body)).toEqual(["three", "two"]);
      const last = page.items.at(-1);
      const rest = await tickets.list({
        ownerUserId: owner,
        limit: 2,
        before: {
          createdAt: last?.createdAt ?? "",
          ticketId: last?.ticketId ?? "",
        },
      });
      expect(rest.hasMore).toBe(false);
      expect(rest.items.map((ticket) => ticket.body)).toEqual(["one"]);

      const target = ids[0] ?? "";
      const answered = await tickets.advance({
        ticketId: target,
        eventType: "answered",
        note: "已处理",
        requestId: randomUUID(),
      });
      expect(answered.status).toBe("answered");
      expect(answered.events.map((event) => event.eventType)).toEqual([
        "created",
        "answered",
      ]);
      expect(answered.events[1]).toMatchObject({
        actor: "operator",
        note: "已处理",
      });
      await expect(
        tickets.advance({
          ticketId: target,
          eventType: "answered",
          note: null,
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(SupportTicketStateError);
      const closed = await tickets.advance({
        ticketId: target,
        eventType: "closed",
        note: null,
        requestId: randomUUID(),
      });
      expect(closed.status).toBe("closed");
      await expect(
        tickets.advance({
          ticketId: target,
          eventType: "closed",
          note: null,
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(SupportTicketStateError);
      await expect(
        tickets.advance({
          ticketId: randomUUID(),
          eventType: "answered",
          note: null,
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(SupportTicketNotFoundError);

      // Direct status writes that skip the lifecycle are refused by trigger.
      await expect(
        pool.query({
          text: `update public.support_tickets set status = 'open' where ticket_id = $1`,
          values: [target],
        }),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        pool.query({
          text: `delete from public.support_ticket_events where ticket_id = $1`,
          values: [target],
        }),
      ).rejects.toMatchObject({ code: "55000" });
    });
  });

  describe("security event notifications", () => {
    it("records the device-revoked security.event once per session and day", async () => {
      const owner = await createOwner();
      const session = await createSession(owner);
      const revoked = await deviceSessions.revoke({
        ownerUserId: owner,
        sessionId: session.sessionId,
        idempotencyKey: randomUUID(),
        requestSha256: "f".repeat(64),
        requestId: randomUUID(),
        commandKind: "revoke",
      });
      const notification = deviceRevokedNotification({
        ownerUserId: owner,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        platform: session.clientPlatform,
        revokedAt: revoked?.revokedAt ?? "",
        revokedFromSessionId: randomUUID(),
      });
      const first = await notifications.record(notification);
      expect(first).toMatchObject({
        ownerUserId: owner,
        type: "security.event",
        entityRef: `deviceSession:${session.sessionId}`,
        contextRoute: "devices",
      });
      expect(first?.payload["event"]).toBe("session_revoked");
      expect(await notifications.record(notification)).toBeNull();
      const listed = await notifications.listRecentByType({
        ownerUserId: owner,
        type: "security.event",
        limit: 10,
      });
      expect(listed.map((row) => row.notificationId)).toEqual([
        first?.notificationId,
      ]);
    });

    it("lists only the requested category, newest first, bounded by limit", async () => {
      const owner = await createOwner();
      for (const [index, type] of [
        "security.event",
        "trade.result",
        "security.event",
      ].entries()) {
        await pool.query({
          text: `
            insert into public.notifications (
              owner_user_id, type, entity_ref, context_route, context_params,
              payload, dedupe_key, created_at
            )
            values ($1, $2, $3, 'devices', '{}'::jsonb, '{"event":"session_revoked"}'::jsonb, $4, $5)
          `,
          values: [
            owner,
            type,
            `deviceSession:${randomUUID()}`,
            randomUUID(),
            new Date(Date.UTC(2026, 8, 9, 0, index)).toISOString(),
          ],
        });
      }
      const listed = await notifications.listRecentByType({
        ownerUserId: owner,
        type: "security.event",
        limit: 10,
      });
      expect(listed).toHaveLength(2);
      expect(listed.every((row) => row.type === "security.event")).toBe(true);
      expect((listed[0]?.createdAt ?? "") > (listed[1]?.createdAt ?? "")).toBe(
        true,
      );
      expect(
        await notifications.listRecentByType({
          ownerUserId: owner,
          type: "security.event",
          limit: 1,
        }),
      ).toHaveLength(1);
    });
  });
});
