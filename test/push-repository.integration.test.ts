import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPostgresDeviceSessionRepository } from "../src/database/device-session-repository.js";
import { createPostgresNotificationRepository } from "../src/database/notification-repository.js";
import { createPostgresPushRepository } from "../src/database/push-repository.js";
import {
  PushIdempotencyConflictError,
  PushSessionInvalidError,
} from "../src/features/push/push-repository.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0067 persistence: token binding, session invalidation, at-most-once
 * delivery, the hourly budget, and the preference gate, all against the real
 * constraints of migration 000037.
 */

const { Pool } = pg;
const pool = new Pool({ connectionString: requireIntegrationDatabaseUrl() });
const testPrivyPrefix = "push-repository-test:";

const deviceSessions = createPostgresDeviceSessionRepository(pool);
const notifications = createPostgresNotificationRepository(pool);
const push = createPostgresPushRepository(pool);

const sha = (seed: string): string =>
  createHash("sha256").update(seed, "utf8").digest("hex");

async function cleanFixtures(): Promise<void> {
  const owners = `select id from public.loop_users where privy_user_id like $1`;
  const values = [`${testPrivyPrefix}%`];
  await pool.query(
    `alter table public.push_deliveries disable trigger push_deliveries_guard`,
  );
  await pool.query(
    `alter table public.device_session_events disable trigger device_session_events_immutable`,
  );
  await pool.query(
    `alter table public.device_session_commands disable trigger device_session_commands_guard_mutation`,
  );
  try {
    for (const table of [
      "push_deliveries",
      "device_push_token_commands",
      "device_push_tokens",
      "notifications",
      "notification_preferences_v2",
      "notification_preference_v2_versions",
      "community_memberships",
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
      text: `delete from public.communities where created_by_user_id in (${owners})`,
      values,
    });
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
      `alter table public.push_deliveries enable trigger push_deliveries_guard`,
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

async function createSession(
  ownerUserId: string,
  deviceId = randomUUID(),
): Promise<{ readonly sessionId: string; readonly deviceId: string }> {
  const session = await deviceSessions.create({
    ownerUserId,
    idempotencyKey: randomUUID(),
    requestSha256: sha(randomUUID()),
    requestId: randomUUID(),
    deviceId,
    clientPlatform: "ios",
    clientVersion: "1.0.0",
  });
  return { sessionId: session.sessionId, deviceId };
}

function token(seed = randomUUID()): string {
  return `fcm-${seed.replaceAll("-", "")}${"a".repeat(32)}`;
}

async function register(
  ownerUserId: string,
  session: { readonly sessionId: string; readonly deviceId: string },
  value = token(),
) {
  return push.registerToken({
    ownerUserId,
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    platform: "ios",
    token: value,
    appVersion: "1.2.3",
    idempotencyKey: randomUUID(),
    requestSha256: sha(value),
    requestId: randomUUID(),
  });
}

describe("push repository (migration 000037)", () => {
  beforeAll(cleanFixtures);
  afterEach(cleanFixtures);
  afterAll(async () => {
    await pool.end();
  });

  it("binds one active token to the caller's session", async () => {
    const owner = await createOwner();
    const session = await createSession(owner);
    const registered = await register(owner, session);
    expect(registered.created).toBe(true);
    expect(registered.token).toMatchObject({
      ownerUserId: owner,
      sessionId: session.sessionId,
      platform: "ios",
      status: "active",
      appVersion: "1.2.3",
    });
    // The record never carries the registration token itself.
    expect(JSON.stringify(registered.token)).not.toContain("fcm-");
    await expect(
      push.findActiveTokenBySession({
        ownerUserId: owner,
        sessionId: session.sessionId,
      }),
    ).resolves.toMatchObject({ pushTokenId: registered.token.pushTokenId });
  });

  it("refuses a session that is not the owner's own active session", async () => {
    const owner = await createOwner();
    const stranger = await createOwner();
    const session = await createSession(owner);
    await expect(register(stranger, session)).rejects.toBeInstanceOf(
      PushSessionInvalidError,
    );
    await deviceSessions.revoke({
      ownerUserId: owner,
      sessionId: session.sessionId,
      idempotencyKey: randomUUID(),
      requestSha256: sha("logout"),
      requestId: randomUUID(),
      commandKind: "logout",
    });
    await expect(register(owner, session)).rejects.toBeInstanceOf(
      PushSessionInvalidError,
    );
  });

  it("keeps the same pushTokenId when a session re-sends its token", async () => {
    const owner = await createOwner();
    const session = await createSession(owner);
    const value = token();
    const first = await register(owner, session, value);
    const second = await register(owner, session, value);
    expect(second.created).toBe(false);
    expect(second.token.pushTokenId).toBe(first.token.pushTokenId);
  });

  it("replaces a session's previous token and a token moving between sessions", async () => {
    const owner = await createOwner();
    const first = await createSession(owner);
    const second = await createSession(owner);
    const original = await register(owner, first);
    const rotated = await register(owner, first);
    expect(rotated.token.pushTokenId).not.toBe(original.token.pushTokenId);

    const shared = token();
    await register(owner, first, shared);
    const moved = await register(owner, second, shared);
    const active = await pool.query<{ count: string }>({
      text: `select count(*)::text as count from public.device_push_tokens where owner_user_id = $1 and status = 'active'`,
      values: [owner],
    });
    expect(active.rows[0]?.count).toBe("1");
    expect(moved.token.sessionId).toBe(second.sessionId);
  });

  it("replays a register idempotency key and refuses a changed request under it", async () => {
    const owner = await createOwner();
    const session = await createSession(owner);
    const key = randomUUID();
    const value = token();
    const first = await push.registerToken({
      ownerUserId: owner,
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      platform: "ios",
      token: value,
      appVersion: "1.2.3",
      idempotencyKey: key,
      requestSha256: sha(value),
      requestId: randomUUID(),
    });
    const replay = await push.registerToken({
      ownerUserId: owner,
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      platform: "ios",
      token: value,
      appVersion: "1.2.3",
      idempotencyKey: key,
      requestSha256: sha(value),
      requestId: randomUUID(),
    });
    expect(replay.created).toBe(false);
    expect(replay.token.pushTokenId).toBe(first.token.pushTokenId);
    await expect(
      push.registerToken({
        ownerUserId: owner,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        platform: "ios",
        token: token(),
        appVersion: "1.2.3",
        idempotencyKey: key,
        requestSha256: sha("other"),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(PushIdempotencyConflictError);
  });

  it("unregisters idempotently, including for a session that never had a token", async () => {
    const owner = await createOwner();
    const session = await createSession(owner);
    await register(owner, session);
    const key = randomUUID();
    const first = await push.unregisterToken({
      ownerUserId: owner,
      sessionId: session.sessionId,
      idempotencyKey: key,
      requestSha256: sha("unregister"),
      requestId: randomUUID(),
    });
    expect(first.unregistered).toBe(true);
    expect(first.revokedAt).not.toBeNull();
    const replay = await push.unregisterToken({
      ownerUserId: owner,
      sessionId: session.sessionId,
      idempotencyKey: key,
      requestSha256: sha("unregister"),
      requestId: randomUUID(),
    });
    expect(replay).toEqual(first);

    const empty = await createSession(owner);
    await expect(
      push.unregisterToken({
        ownerUserId: owner,
        sessionId: empty.sessionId,
        idempotencyKey: randomUUID(),
        requestSha256: sha("unregister"),
        requestId: randomUUID(),
      }),
    ).resolves.toEqual({ unregistered: false, revokedAt: null });
  });

  it("retires the token in the same transaction as a logout and a remote revoke", async () => {
    const owner = await createOwner();
    const loggedOut = await createSession(owner);
    const revoked = await createSession(owner);
    const caller = await createSession(owner);
    await register(owner, loggedOut);
    await register(owner, revoked);

    await deviceSessions.revoke({
      ownerUserId: owner,
      sessionId: loggedOut.sessionId,
      idempotencyKey: randomUUID(),
      requestSha256: sha("logout"),
      requestId: randomUUID(),
      commandKind: "logout",
    });
    await deviceSessions.revoke({
      ownerUserId: owner,
      sessionId: revoked.sessionId,
      idempotencyKey: randomUUID(),
      requestSha256: sha("revoke"),
      requestId: randomUUID(),
      commandKind: "revoke",
      callerSessionId: caller.sessionId,
    });

    const rows = await pool.query<{
      session_id: string;
      status: string;
      revoke_reason: string;
    }>({
      text: `select session_id, status, revoke_reason from public.device_push_tokens where owner_user_id = $1`,
      values: [owner],
    });
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.status).toBe("revoked");
      expect(row.revoke_reason).toBe("session_revoked");
    }
    await expect(
      push.listOwnerTargets({
        ownerUserId: owner,
        categoryGate: null,
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it("delivers one event to one device once and stops at the hourly budget", async () => {
    const owner = await createOwner();
    const session = await createSession(owner);
    const registered = await register(owner, session);
    const reservation = await push.reserveDelivery({
      ownerUserId: owner,
      pushTokenId: registered.token.pushTokenId,
      eventType: "security_event",
      eventKey: "security_event:session:revoked",
      mandatory: true,
      windowSeconds: 3_600,
      limit: 2,
    });
    expect(reservation.outcome).toBe("reserved");
    await expect(
      push.reserveDelivery({
        ownerUserId: owner,
        pushTokenId: registered.token.pushTokenId,
        eventType: "security_event",
        eventKey: "security_event:session:revoked",
        mandatory: true,
        windowSeconds: 3_600,
        limit: 2,
      }),
    ).resolves.toEqual({ outcome: "duplicate" });

    await push.reserveDelivery({
      ownerUserId: owner,
      pushTokenId: registered.token.pushTokenId,
      eventType: "security_event",
      eventKey: "security_event:session:new_device",
      mandatory: true,
      windowSeconds: 3_600,
      limit: 2,
    });
    await expect(
      push.reserveDelivery({
        ownerUserId: owner,
        pushTokenId: registered.token.pushTokenId,
        eventType: "security_event",
        eventKey: "security_event:session:third",
        mandatory: true,
        windowSeconds: 3_600,
        limit: 2,
      }),
    ).resolves.toEqual({ outcome: "rateLimited" });

    // The optional budget is counted separately and still has room.
    await expect(
      push.reserveDelivery({
        ownerUserId: owner,
        pushTokenId: registered.token.pushTokenId,
        eventType: "price_alert_triggered",
        eventKey: "trade.priceAlert:alert:0",
        mandatory: false,
        windowSeconds: 3_600,
        limit: 2,
      }),
    ).resolves.toMatchObject({ outcome: "reserved" });

    if (reservation.outcome !== "reserved") {
      throw new Error("reservation did not take the slot");
    }
    await push.completeDelivery({
      deliveryId: reservation.deliveryId,
      status: "sent",
      reasonCode: null,
      providerMessageRef: "projects/loop/messages/1",
    });
    const stored = await pool.query<{ status: string; completed_at: Date }>({
      text: `select status, completed_at from public.push_deliveries where delivery_id = $1`,
      values: [reservation.deliveryId],
    });
    expect(stored.rows[0]?.status).toBe("sent");
    expect(stored.rows[0]?.completed_at).not.toBeNull();
  });

  it("applies the owner's category preference to an optional event only", async () => {
    const owner = await createOwner();
    const session = await createSession(owner);
    await register(owner, session);
    const gate = {
      category: "trade.priceAlert" as const,
      defaultEnabled: true,
    };
    await expect(
      push.listOwnerTargets({
        ownerUserId: owner,
        categoryGate: gate,
        limit: 10,
      }),
    ).resolves.toHaveLength(1);

    const current = await notifications.getPreferences(owner);
    await notifications.replacePreferences({
      ownerUserId: owner,
      expectedVersion: current.recordVersion,
      values: { ...current.values, "trade.priceAlert": false },
    });
    await expect(
      push.listOwnerTargets({
        ownerUserId: owner,
        categoryGate: gate,
        limit: 10,
      }),
    ).resolves.toEqual([]);
    // A mandatory event ignores preferences entirely.
    await expect(
      push.listOwnerTargets({
        ownerUserId: owner,
        categoryGate: null,
        limit: 10,
      }),
    ).resolves.toHaveLength(1);
  });

  it("fans out to a community's members, never to the excluded actor", async () => {
    const host = await createOwner();
    const member = await createOwner();
    const outsider = await createOwner();
    const community = await pool.query<{ community_id: string }>({
      text: `insert into public.communities (created_by_user_id, name, slug)
             values ($1, 'Push Fixture', $2) returning community_id`,
      values: [host, `push-fixture-${Date.now().toString(36)}`],
    });
    const communityId = community.rows[0]?.community_id;
    if (communityId === undefined) {
      throw new Error("community insert returned no id");
    }
    for (const [owner, role] of [
      [host, "owner"],
      [member, "member"],
    ] as const) {
      await pool.query({
        text: `insert into public.community_memberships (community_id, owner_user_id, role)
               values ($1, $2, $3)`,
        values: [communityId, owner, role],
      });
    }
    for (const owner of [host, member, outsider]) {
      await register(owner, await createSession(owner));
    }

    const targets = await push.listCommunityTargets({
      communityId,
      excludeOwnerUserId: host,
      categoryGate: {
        category: "community.announcement",
        defaultEnabled: true,
      },
      limit: 50,
    });
    expect(targets.map((target) => target.ownerUserId)).toEqual([member]);
  });

  it("retires a token the Provider reported as unregistered", async () => {
    const owner = await createOwner();
    const session = await createSession(owner);
    const registered = await register(owner, session);
    await push.revokeToken({
      pushTokenId: registered.token.pushTokenId,
      reason: "provider_unregistered",
    });
    await expect(
      push.findActiveTokenBySession({
        ownerUserId: owner,
        sessionId: session.sessionId,
      }),
    ).resolves.toBeNull();
  });
});
