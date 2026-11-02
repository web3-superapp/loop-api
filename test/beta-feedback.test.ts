import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import type { AdminRole } from "../src/features/admin/admin-roles.js";
import {
  checkFeedbackAdminNote,
  checkFeedbackBody,
  feedbackCreateDigest,
  feedbackLimits,
  feedbackReasonCodes,
  normalizeFeedbackContext,
  type FeedbackRecord,
  type FeedbackRepository,
} from "../src/features/feedback/feedback-contract.js";
import { processMediaUpload } from "../src/features/media/media-processor.js";
import { createMediaService } from "../src/features/media/media-service.js";
import {
  MediaIdempotencyConflictError,
  type MediaObject,
  type MediaStorage,
} from "../src/features/media/media-storage.js";
import { createInMemoryAdminRepository } from "./helpers/admin-fakes.js";
import {
  createFakeHooksReview,
  createInMemoryAdminAccounts,
  createInMemoryAdminLaunchReview,
} from "./helpers/admin-role-fakes.js";
import {
  s7AccountId,
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0193 (主代理决策 0262): beta feedback — pure rules, the
 * screenshot transcode, and the App / console routes over an in-memory
 * repository and media storage (upload → submit → mine, limits, ownership,
 * idempotency, switch, console filters / roles / audit).
 */

const now = new Date("2026-11-02T08:00:00.000Z");
const otherAccountId = "f7bf09f6-0171-46b9-9acd-5ad494f211bd";
const baseUrl = "https://api.loop.test";
const boundary = "----loopfeedbacktest";
const accountPassword = "account-password-0123";
let passwordHash = "";
let screenshot: Buffer;

beforeAll(async () => {
  passwordHash = await hashAdminPassword("bootstrap-password-0123");
  screenshot = await sharp({
    create: { width: 1170, height: 2532, channels: 3, background: "#203040" },
  })
    .png()
    .toBuffer();
});

function key(): string {
  return randomUUID();
}

function fileBody(bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

type StoredMedia = MediaObject & {
  idempotencyKey: string;
  requestSha256: string;
};

function memoryMedia(): MediaStorage & { readonly rows: StoredMedia[] } {
  const rows: StoredMedia[] = [];
  const byKey = (ownerUserId: string, idempotencyKey: string) =>
    rows.find(
      (row) =>
        row.ownerUserId === ownerUserId &&
        row.idempotencyKey === idempotencyKey,
    ) ?? null;
  return {
    rows,
    put(input) {
      const earlier = byKey(input.ownerUserId, input.idempotencyKey);
      if (earlier !== null) {
        return earlier.requestSha256 === input.requestSha256
          ? Promise.resolve(earlier)
          : Promise.reject(new MediaIdempotencyConflictError());
      }
      const row: StoredMedia = {
        mediaId: input.mediaId,
        ownerUserId: input.ownerUserId,
        kind: input.kind,
        contentType: "image/webp",
        width: input.width,
        height: input.height,
        sha256: input.sha256,
        createdAt: now.toISOString(),
        bytes: input.bytes,
        idempotencyKey: input.idempotencyKey,
        requestSha256: input.requestSha256,
        ipfsCid: null,
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    findByIdempotencyKey: (input) =>
      Promise.resolve(byKey(input.ownerUserId, input.idempotencyKey)),
    get: (mediaId) =>
      Promise.resolve(rows.find((row) => row.mediaId === mediaId) ?? null),
    getMetadata: (mediaId) =>
      Promise.resolve(rows.find((row) => row.mediaId === mediaId) ?? null),
    findProjectNftImageByCid: () => Promise.resolve(null),
  };
}

/** The repository contract in memory (mirrors the PostgreSQL semantics). */
function memoryFeedback(media: { readonly rows: StoredMedia[] }) {
  const rows: (FeedbackRecord & { key: string; digest: string })[] = [];
  const audits: { action: string; before: unknown; after: unknown }[] = [];
  const attached = new Set<string>();
  const sorted = () =>
    [...rows].sort((a, b) =>
      a.createdAt === b.createdAt
        ? b.id.localeCompare(a.id)
        : b.createdAt.localeCompare(a.createdAt),
    );
  const before = (
    row: FeedbackRecord,
    key: { createdAt: string; id: string } | null,
  ) =>
    key === null ||
    row.createdAt < key.createdAt ||
    (row.createdAt === key.createdAt && row.id < key.id);
  const strip = (
    row: FeedbackRecord & { key: string; digest: string },
  ): FeedbackRecord => {
    const record: Partial<typeof row> = { ...row };
    delete record.key;
    delete record.digest;
    return record as FeedbackRecord;
  };
  const repository: FeedbackRepository = {
    create(input) {
      const earlier = rows.find(
        (row) =>
          row.accountId === input.accountId &&
          row.key === input.idempotency.key,
      );
      if (earlier !== undefined) {
        return Promise.resolve(
          earlier.digest === input.idempotency.requestSha256
            ? { status: "replayed" as const, record: strip(earlier) }
            : { status: "conflict" as const },
        );
      }
      const windowStart = input.now.getTime() - input.windowMs;
      const recent = rows.filter(
        (row) =>
          row.accountId === input.accountId &&
          Date.parse(row.createdAt) > windowStart,
      ).length;
      if (recent >= input.dailyMax) {
        return Promise.resolve({ status: "rate_limited" as const });
      }
      for (const mediaId of input.mediaIds) {
        const object = media.rows.find((row) => row.mediaId === mediaId);
        if (
          object === undefined ||
          object.ownerUserId !== input.accountId ||
          object.kind !== "feedback_image" ||
          Date.parse(object.createdAt) < input.mediaFreshSince.getTime()
        ) {
          return Promise.resolve({
            status: "media_rejected" as const,
            reasonCode: feedbackReasonCodes.mediaNotOwned,
            mediaId,
          });
        }
        if (attached.has(mediaId)) {
          return Promise.resolve({
            status: "media_rejected" as const,
            reasonCode: feedbackReasonCodes.mediaInUse,
            mediaId,
          });
        }
      }
      input.mediaIds.forEach((mediaId) => attached.add(mediaId));
      const row = {
        id: input.id,
        accountId: input.accountId,
        loopId: input.accountId === s7AccountId ? "LOOP-EYMVEN8N" : null,
        displayName: input.accountId === s7AccountId ? "Dd" : null,
        category: input.category,
        body: input.body,
        context: input.context,
        status: "open" as const,
        adminNote: null,
        mediaIds: [...input.mediaIds],
        createdAt: input.now.toISOString(),
        updatedAt: input.now.toISOString(),
        key: input.idempotency.key,
        digest: input.idempotency.requestSha256,
      };
      rows.push(row);
      return Promise.resolve({
        status: "created" as const,
        record: strip(row),
      });
    },
    listMine: (input) =>
      Promise.resolve(
        sorted()
          .filter(
            (row) =>
              row.accountId === input.accountId && before(row, input.before),
          )
          .slice(0, input.limit)
          .map(strip),
      ),
    adminList: (input) =>
      Promise.resolve(
        sorted()
          .filter(
            (row) =>
              (input.status === null || row.status === input.status) &&
              (input.category === null || row.category === input.category) &&
              before(row, input.before),
          )
          .slice(0, input.limit)
          .map(strip),
      ),
    adminGet: (id) => {
      const row = rows.find((entry) => entry.id === id);
      return Promise.resolve(row === undefined ? null : strip(row));
    },
    adminUpdate(input) {
      const index = rows.findIndex((entry) => entry.id === input.id);
      const row = rows[index];
      if (row === undefined) {
        return Promise.resolve({ status: "not_found" as const });
      }
      const next = {
        ...row,
        status: input.status ?? row.status,
        adminNote:
          input.adminNote === undefined ? row.adminNote : input.adminNote,
        updatedAt: input.now.toISOString(),
      };
      rows[index] = next;
      audits.push({
        action: "beta_feedback.update",
        before: { status: row.status, adminNote: row.adminNote },
        after: { status: next.status, adminNote: next.adminNote },
      });
      return Promise.resolve({
        status: "written" as const,
        record: strip(next),
        audit: {
          auditId: randomUUID(),
          seq: audits.length,
          at: now.toISOString(),
        },
      });
    },
  };
  return { repository, rows, audits };
}

describe("beta feedback rules (Decision 0193)", () => {
  it("checks the body: CRLF to LF, trim, 1..2000 code points, no NUL", () => {
    expect(checkFeedbackBody("  闪退\r\n复现 ")).toEqual({
      ok: true,
      body: "闪退\n复现",
    });
    expect(checkFeedbackBody("   ")).toEqual({
      ok: false,
      reasonCode: feedbackReasonCodes.bodyEmpty,
    });
    expect(checkFeedbackBody(42)).toMatchObject({ ok: false });
    expect(checkFeedbackBody("😀".repeat(2_000))).toMatchObject({ ok: true });
    expect(checkFeedbackBody("x".repeat(2_001))).toEqual({
      ok: false,
      reasonCode: feedbackReasonCodes.bodyTooLong,
    });
    expect(checkFeedbackBody("a\u0000b")).toEqual({
      ok: false,
      reasonCode: feedbackReasonCodes.bodyInvalid,
    });
  });

  it("keeps only the seven context keys, as trimmed strings", () => {
    expect(
      normalizeFeedbackContext({
        appVersion: " 1.4.0 ",
        build: 57,
        platform: "ios",
        osVersion: "27.0",
        deviceModel: "iPhone17,1",
        route: "/wallet",
        locale: "zh-CN",
        walletAddress: "0xabc",
        token: "secret",
      }),
    ).toEqual({
      appVersion: "1.4.0",
      build: "57",
      platform: "ios",
      osVersion: "27.0",
      deviceModel: "iPhone17,1",
      route: "/wallet",
      locale: "zh-CN",
    });
    expect(
      normalizeFeedbackContext({
        route: "x".repeat(500),
        build: Number.NaN,
        locale: "",
        platform: { nested: true },
        osVersion: "a\nb",
      }),
    ).toEqual({ route: "x".repeat(200), osVersion: "ab" });
    for (const bad of [null, "ios", [1], undefined]) {
      expect(normalizeFeedbackContext(bad)).toEqual({});
    }
  });

  it("checks the console note and binds the digest to every field", () => {
    expect(checkFeedbackAdminNote(null)).toEqual({ ok: true, note: null });
    expect(checkFeedbackAdminNote("  ")).toEqual({ ok: true, note: null });
    expect(checkFeedbackAdminNote(" 已复现 ")).toEqual({
      ok: true,
      note: "已复现",
    });
    expect(checkFeedbackAdminNote("x".repeat(1_001))).toEqual({
      ok: false,
      reasonCode: feedbackReasonCodes.adminNoteTooLong,
    });
    expect(checkFeedbackAdminNote(3)).toMatchObject({ ok: false });
    const digest = (
      extra: Partial<Parameters<typeof feedbackCreateDigest>[0]>,
    ) =>
      feedbackCreateDigest({
        category: "bug",
        body: "a",
        mediaIds: [],
        context: {},
        ...extra,
      });
    const first = digest({});
    expect(digest({})).toBe(first);
    expect(digest({ category: "other" })).not.toBe(first);
    expect(digest({ body: "b" })).not.toBe(first);
    expect(digest({ mediaIds: [randomUUID()] })).not.toBe(first);
    expect(digest({ context: { build: "57" } })).not.toBe(first);
  });

  it("stores a screenshot with its aspect ratio inside 1440 px", async () => {
    const processed = await processMediaUpload(screenshot, "inside");
    expect(processed.height).toBe(1440);
    expect(processed.width).toBe(Math.round((1170 * 1440) / 2532));
    expect(processed.bytes.length).toBeLessThanOrEqual(1_048_576);
    const small = await sharp({
      create: { width: 300, height: 200, channels: 3, background: "#fff" },
    })
      .jpeg()
      .toBuffer();
    // Never enlarged.
    expect(await processMediaUpload(small, "inside")).toMatchObject({
      width: 300,
      height: 200,
    });
    // The square avatar path is unchanged.
    expect(await processMediaUpload(screenshot)).toMatchObject({
      width: 512,
      height: 512,
    });
  });
});

describe("beta feedback routes (Decision 0193)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function harness(
    options: {
      readonly enabled?: boolean;
      readonly withRepository?: boolean;
    } = {},
  ) {
    const media = memoryMedia();
    const feedback = memoryFeedback(media);
    const admin = createInMemoryAdminRepository();
    const accounts = createInMemoryAdminAccounts(admin);
    const app = await buildApp({
      config: s7TestConfig({
        PUBLIC_BASE_URL: baseUrl,
        ADMIN_USERNAME: "operator",
        ADMIN_PASSWORD_HASH: passwordHash,
        ADMIN_SESSION_SECRET: "s332-admin-session-secret-0123456789abcdef",
        BETA_FEEDBACK_ENABLED: options.enabled === false ? "off" : "on",
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
        ...(options.withRepository === false
          ? {}
          : { betaFeedback: feedback.repository }),
      },
      mediaService: createMediaService({
        storage: media,
        quota: { consume: () => Promise.resolve() },
        publicBaseUrl: baseUrl,
      }),
      privyAccessTokenVerifier: s7PrivyVerifier(),
      memePauseSender: null,
      walletIntentNow: () => now,
      adminNow: () => now,
      logger: false,
    });
    apps.push(app);
    const cookies = new Map<AdminRole, string>();
    for (const role of [
      "platform_admin",
      "auditor",
      "reviewer",
      "testnet_acceptor",
    ] as const) {
      const username = `${role.replaceAll("_", "-")}-${randomUUID().slice(0, 8)}`;
      await accounts.seed({
        username,
        password: accountPassword,
        role,
        operatorUserId:
          role === "reviewer" || role === "testnet_acceptor"
            ? randomUUID()
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
    const upload = (bytes: Buffer = screenshot, idempotencyKey = key()) =>
      app.inject({
        method: "POST",
        url: "/v2/media/feedback-images",
        headers: {
          ...s7CommandHeaders({ "idempotency-key": idempotencyKey }),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: fileBody(bytes),
      });
    const submit = (payload: Record<string, unknown>, idempotencyKey = key()) =>
      app.inject({
        method: "POST",
        url: "/v2/feedback",
        headers: s7CommandHeaders({ "idempotency-key": idempotencyKey }),
        payload,
      });
    const mine = (cursor?: string) =>
      app.inject({
        method: "GET",
        url:
          cursor === undefined
            ? "/v2/feedback/mine"
            : `/v2/feedback/mine?cursor=${encodeURIComponent(cursor)}`,
        headers: s7CommonHeaders(),
      });
    const console = (
      role: AdminRole | null,
      method: "GET" | "PATCH",
      url: string,
      payload?: Record<string, unknown>,
    ) =>
      app.inject({
        method,
        url,
        headers: role === null ? {} : { cookie: cookies.get(role) as string },
        ...(payload === undefined ? {} : { payload }),
      });
    return { app, media, feedback, upload, submit, mine, console };
  }

  it("uploads, submits and lists the caller's own report", async () => {
    const { media, feedback, upload, submit, mine } = await harness();
    const uploaded = await upload();
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const image = uploaded.json<{ mediaId: string; url: string }>();
    expect(Object.keys(image).sort()).toEqual(["mediaId", "url"]);
    expect(image.url).toBe(`${baseUrl}/v2/media/${image.mediaId}.webp`);
    expect(media.rows[0]).toMatchObject({
      kind: "feedback_image",
      ownerUserId: s7AccountId,
      height: 1440,
    });

    const idempotencyKey = key();
    const payload = {
      category: "bug",
      body: " 钱包页净值显示 $0 ",
      mediaIds: [image.mediaId],
      context: { appVersion: "1.4.0", build: 57, route: "/wallet", extra: "x" },
    };
    const created = await submit(payload, idempotencyKey);
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json<{
      feedback: { id: string; status: string; createdAt: string };
    }>();
    expect(body).toEqual({
      feedback: {
        id: expect.any(String) as string,
        status: "open",
        createdAt: now.toISOString(),
      },
    });
    expect(feedback.rows[0]).toMatchObject({
      body: "钱包页净值显示 $0",
      context: { appVersion: "1.4.0", build: "57", route: "/wallet" },
    });
    expect(feedback.rows[0]?.context).not.toHaveProperty("extra");

    // Replay: 200 with the same report; another body: 409.
    const replay = await submit(payload, idempotencyKey);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(body);
    const conflict = await submit(
      { ...payload, body: "different" },
      idempotencyKey,
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const listed = await mine();
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toEqual({
      items: [
        {
          id: body.feedback.id,
          category: "bug",
          body: "钱包页净值显示 $0",
          status: "open",
          createdAt: now.toISOString(),
          images: [image.url],
        },
      ],
      nextCursor: null,
    });

    // The same screenshot cannot be attached twice.
    const reused = await submit({
      category: "bug",
      body: "again",
      mediaIds: [image.mediaId],
    });
    expect(reused.statusCode).toBe(422);
    expect(reused.json()).toMatchObject({
      code: "VALIDATION_FAILED",
      detailsSafe: {
        reasonCode: feedbackReasonCodes.mediaInUse,
        field: "mediaIds",
      },
    });
  });

  it("refuses more than four images, foreign, unknown and repeated media", async () => {
    const { media, upload, submit } = await harness();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const uploaded = await upload();
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      ids.push(uploaded.json<{ mediaId: string }>().mediaId);
    }
    const tooMany = await submit({ category: "bug", body: "x", mediaIds: ids });
    expect(tooMany.statusCode).toBe(422);
    expect(tooMany.json()).toMatchObject({
      detailsSafe: { reasonCode: feedbackReasonCodes.tooManyImages },
    });

    // Another account's feedback image, and this account's avatar.
    const foreignId = randomUUID();
    const avatarId = randomUUID();
    const template = media.rows[0] as StoredMedia;
    media.rows.push(
      { ...template, mediaId: foreignId, ownerUserId: otherAccountId },
      { ...template, mediaId: avatarId, kind: "avatar" },
    );
    for (const mediaIds of [
      [foreignId],
      [avatarId],
      [randomUUID()],
      ["not-a-uuid"],
    ]) {
      const refused = await submit({ category: "bug", body: "x", mediaIds });
      expect(refused.statusCode, JSON.stringify(mediaIds)).toBe(422);
      expect(refused.json()).toMatchObject({
        detailsSafe: { reasonCode: "MEDIA_NOT_OWNED", field: "mediaIds" },
      });
    }
    const repeated = await submit({
      category: "bug",
      body: "x",
      mediaIds: [ids[0], ids[0]],
    });
    expect(repeated.json()).toMatchObject({
      detailsSafe: { reasonCode: feedbackReasonCodes.mediaDuplicate },
    });
    const four = await submit({
      category: "suggestion",
      body: "四张",
      mediaIds: ids.slice(0, 4),
    });
    expect(four.statusCode, four.body).toBe(201);
  });

  it("validates the body and category", async () => {
    const { submit } = await harness();
    const empty = await submit({ category: "bug", body: "  " });
    expect(empty.statusCode).toBe(422);
    expect(empty.json()).toMatchObject({
      detailsSafe: { reasonCode: feedbackReasonCodes.bodyEmpty, field: "body" },
    });
    const long = await submit({ category: "bug", body: "x".repeat(2_001) });
    expect(long.json()).toMatchObject({
      detailsSafe: { reasonCode: feedbackReasonCodes.bodyTooLong },
    });
    expect((await submit({ category: "crash", body: "x" })).statusCode).toBe(
      400,
    );
    expect(
      (await submit({ category: "bug", body: "x", extra: true })).statusCode,
    ).toBe(400);
    expect((await submit({ body: "x" })).statusCode).toBe(400);
  });

  it("allows twenty reports per rolling day", async () => {
    const { submit } = await harness();
    for (let index = 0; index < feedbackLimits.dailyMax; index += 1) {
      const created = await submit({ category: "other", body: `#${index}` });
      expect(created.statusCode, created.body).toBe(201);
    }
    const limited = await submit({ category: "other", body: "21" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      code: "RATE_LIMITED",
      detailsSafe: { reasonCode: feedbackReasonCodes.dailyLimit, limit: 20 },
    });
  });

  it("pages the caller's list with a bound cursor", async () => {
    const { feedback, mine, submit } = await harness();
    for (let index = 0; index < 20; index += 1) {
      expect(
        (await submit({ category: "bug", body: `#${index}` })).statusCode,
      ).toBe(201);
    }
    // One more, older, written directly (the daily limit is reached).
    const older = { ...(feedback.rows[0] as (typeof feedback.rows)[number]) };
    feedback.rows.push({
      ...older,
      id: randomUUID(),
      key: randomUUID(),
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const first = await mine();
    const page = first.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();
    const second = await mine(page.nextCursor as string);
    expect(second.statusCode, second.body).toBe(200);
    expect(
      second.json<{ items: { createdAt: string }[]; nextCursor: null }>(),
    ).toMatchObject({
      items: [{ createdAt: "2026-10-01T00:00:00.000Z" }],
      nextCursor: null,
    });
    expect((await mine("bogus.cursor")).statusCode).toBe(400);
  });

  it("fails closed when switched off or without the database", async () => {
    const off = await harness({ enabled: false });
    for (const response of [
      await off.upload(),
      await off.submit({ category: "bug", body: "x" }),
      await off.mine(),
    ]) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: { reasonCode: feedbackReasonCodes.disabled },
      });
      expect(Object.keys(response.json<object>()).sort()).toEqual([
        "category",
        "code",
        "correlationId",
        "detailsSafe",
        "providerReferenceSafe",
        "retryable",
        "userMessageKey",
      ]);
    }
    expect(off.media.rows).toHaveLength(0);
    // The console still reads.
    expect(
      (await off.console("platform_admin", "GET", "/admin/v1/feedback"))
        .statusCode,
    ).toBe(200);

    const bare = await harness({ withRepository: false });
    const submitted = await bare.submit({ category: "bug", body: "x" });
    expect(submitted.statusCode).toBe(503);
    expect(submitted.json()).toMatchObject({
      detailsSafe: { reasonCode: feedbackReasonCodes.repositoryUnavailable },
    });
    expect(
      (await bare.console("platform_admin", "GET", "/admin/v1/feedback"))
        .statusCode,
    ).toBe(503);
  });

  it("requires the LOOP headers and a bearer", async () => {
    const { app } = await harness();
    const anonymous = await app.inject({
      method: "POST",
      url: "/v2/feedback",
      headers: s7CommandHeaders({ authorization: undefined }),
      payload: { category: "bug", body: "x" },
    });
    expect(anonymous.statusCode).toBe(401);
    const noKey = await app.inject({
      method: "POST",
      url: "/v2/feedback",
      headers: s7CommandHeaders({ "idempotency-key": undefined }),
      payload: { category: "bug", body: "x" },
    });
    expect(noKey.statusCode).toBe(400);
  });

  it("lets the console filter, read and triage with role checks and audit", async () => {
    const { feedback, upload, submit, console } = await harness();
    const image = (await upload()).json<{ mediaId: string; url: string }>();
    const bug = (
      await submit({
        category: "bug",
        body: "闪退",
        mediaIds: [image.mediaId],
        context: { platform: "ios" },
      })
    ).json<{ feedback: { id: string } }>().feedback.id;
    await submit({ category: "suggestion", body: "加深色" });

    const base = "/admin/v1/feedback";
    expect((await console(null, "GET", base)).statusCode).toBe(401);
    expect((await console("testnet_acceptor", "GET", base)).statusCode).toBe(
      403,
    );
    for (const role of ["platform_admin", "auditor", "reviewer"] as const) {
      expect((await console(role, "GET", base)).statusCode, role).toBe(200);
    }
    const bugs = await console("auditor", "GET", `${base}?category=bug`);
    expect(bugs.json()).toEqual({
      items: [
        {
          id: bug,
          accountId: s7AccountId,
          account: { loopId: "LOOP-EYMVEN8N", displayName: "Dd" },
          category: "bug",
          body: "闪退",
          status: "open",
          adminNote: null,
          images: [image.url],
          context: { platform: "ios" },
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
      nextCursor: null,
    });
    expect(
      (await console("auditor", "GET", `${base}?status=resolved`)).json(),
    ).toEqual({ items: [], nextCursor: null });
    expect(
      (await console("auditor", "GET", `${base}?status=done`)).statusCode,
    ).toBe(400);

    // Paging: limit 1 then the cursor.
    const firstPage = (
      await console("auditor", "GET", `${base}?limit=1`)
    ).json<{ items: { id: string }[]; nextCursor: string }>();
    expect(firstPage.items).toHaveLength(1);
    const secondPage = (
      await console(
        "auditor",
        "GET",
        `${base}?cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      )
    ).json<{ items: { id: string }[]; nextCursor: null }>();
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    expect(
      (
        await console(
          "auditor",
          "GET",
          `${base}?category=bug&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
        )
      ).statusCode,
    ).toBe(400);

    const detail = await console("reviewer", "GET", `${base}/${bug}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ feedback: { id: bug } });
    expect(
      (await console("auditor", "GET", `${base}/${randomUUID()}`)).statusCode,
    ).toBe(404);
    expect(
      (await console("auditor", "GET", `${base}/not-a-uuid`)).statusCode,
    ).toBe(404);

    // Writes: auditor and testnet acceptor refused; admin and reviewer pass.
    expect(
      (
        await console("auditor", "PATCH", `${base}/${bug}`, {
          status: "triaged",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await console("testnet_acceptor", "PATCH", `${base}/${bug}`, {
          status: "triaged",
        })
      ).statusCode,
    ).toBe(403);
    const triaged = await console("platform_admin", "PATCH", `${base}/${bug}`, {
      status: "triaged",
      adminNote: " 已复现 ",
    });
    expect(triaged.statusCode, triaged.body).toBe(200);
    expect(triaged.json()).toMatchObject({
      feedback: { id: bug, status: "triaged", adminNote: "已复现" },
      audit: { seq: 1 },
    });
    const cleared = await console("reviewer", "PATCH", `${base}/${bug}`, {
      status: "resolved",
      adminNote: null,
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({
      feedback: { status: "resolved", adminNote: null },
      audit: { seq: 2 },
    });
    expect(feedback.audits).toEqual([
      {
        action: "beta_feedback.update",
        before: { status: "open", adminNote: null },
        after: { status: "triaged", adminNote: "已复现" },
      },
      {
        action: "beta_feedback.update",
        before: { status: "triaged", adminNote: "已复现" },
        after: { status: "resolved", adminNote: null },
      },
    ]);
    expect(
      (await console("platform_admin", "PATCH", `${base}/${bug}`, {}))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await console("platform_admin", "PATCH", `${base}/${bug}`, {
          status: "closed",
        })
      ).statusCode,
    ).toBe(400);
    const tooLong = await console("platform_admin", "PATCH", `${base}/${bug}`, {
      adminNote: "x".repeat(1_001),
    });
    expect(tooLong.statusCode).toBe(422);
    expect(tooLong.json()).toMatchObject({
      detailsSafe: {
        reasonCode: feedbackReasonCodes.adminNoteTooLong,
        field: "adminNote",
      },
    });
    expect(
      (
        await console("platform_admin", "PATCH", `${base}/${randomUUID()}`, {
          status: "open",
        })
      ).statusCode,
    ).toBe(404);
  });
});
