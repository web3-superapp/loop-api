import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import type { AdminRole } from "../src/features/admin/admin-roles.js";
import { selectPublicLaunch2Campaigns } from "../src/features/launch2/launch2-campaigns.js";
import { processCampaignCoverUpload } from "../src/features/media/media-processor.js";
import { createInMemoryAdminRepository } from "./helpers/admin-fakes.js";
import {
  createFakeHooksReview,
  createInMemoryAdminAccounts,
  createInMemoryAdminLaunchReview,
} from "./helpers/admin-role-fakes.js";
import {
  createInMemoryLaunch2CampaignRepository,
  type InMemoryLaunch2CampaignRepository,
} from "./helpers/launch2-campaign-fakes.js";
import { launch2Env } from "./helpers/launch2-fakes.js";
import {
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0140: the public campaign read (filter, state, order, cap) and
 * the console routes (roles, validation reason codes, state machine,
 * audit rows, idempotent create / cover, cover processing).
 */

const now = new Date("2026-10-14T12:00:00.000Z");
const day = 86_400_000;
const at = (offsetMs: number) =>
  new Date(now.getTime() + offsetMs).toISOString();
const accountPassword = "account-password-0123";
const sessionSecret = "s183-admin-session-secret-0123456789abcdef";
const base = "/admin/v1/launch2/campaigns";
let passwordHash = "";

beforeAll(async () => {
  passwordHash = await hashAdminPassword("bootstrap-password-0123");
});

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: "#7fd13b" },
  })
    .png()
    .toBuffer();
}

function multipartBody(
  bytes: Buffer,
  field = "file",
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----s183boundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="cover.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    payload,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

const validBody = () => ({
  title: "交易赛第一周",
  subtitle: "前 100 名分 1 万 USD1",
  startsAt: at(-day),
  endsAt: at(3 * day),
  link: { kind: "route", value: "/launch2/instance?id=abc" },
});

describe("Launch desk campaigns (Decision 0140)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function harness(
    repository: InMemoryLaunch2CampaignRepository | undefined,
  ) {
    const admin = createInMemoryAdminRepository();
    const accounts = createInMemoryAdminAccounts(admin);
    const app = await buildApp({
      config: s7TestConfig({
        ...launch2Env,
        PUBLIC_BASE_URL: "https://api.loop.test",
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
        ...(repository === undefined ? {} : { launch2Campaigns: repository }),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      memePauseSender: null,
      walletIntentNow: () => now,
      adminNow: () => now,
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
    const call = (
      role: AdminRole | null,
      method: "GET" | "POST" | "PATCH",
      url: string,
      payload?: unknown,
      headers: Record<string, string> = {},
    ) =>
      app.inject({
        method,
        url,
        headers: {
          ...headers,
          ...(role === null ? {} : { cookie: cookies.get(role) as string }),
        },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
    const publicList = () =>
      app.inject({
        method: "GET",
        url: "/v2/launch2/campaigns",
        headers: s7CommonHeaders(),
      });
    return { app, call, publicList, cookies };
  }

  describe("GET /v2/launch2/campaigns", () => {
    it("shows only published, not ended, starting within 7 days, with state", async () => {
      const repository = createInMemoryLaunch2CampaignRepository();
      const live = repository.seed({ title: "live", startsAt: at(-day) });
      const soon = repository.seed({
        title: "soon",
        startsAt: at(6 * day),
        endsAt: at(8 * day),
      });
      repository.seed({ title: "draft", status: "draft" });
      repository.seed({ title: "archived", status: "archived" });
      repository.seed({
        title: "ended",
        startsAt: at(-3 * day),
        endsAt: at(-1),
      });
      repository.seed({ title: "ends now", endsAt: now.toISOString() });
      repository.seed({
        title: "far",
        startsAt: at(7 * day + 1),
        endsAt: at(9 * day),
      });
      const edge = repository.seed({
        title: "edge",
        startsAt: at(7 * day),
        endsAt: at(9 * day),
        coverMediaId: "11111111-1111-4111-8111-111111111111",
      });
      const { publicList } = await harness(repository);
      const response = await publicList();
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json<{
        items: Array<Record<string, unknown>>;
        observedAt: string;
      }>();
      expect(body.observedAt).toBe(now.toISOString());
      expect(body.items.map((item) => item["title"])).toEqual([
        "live",
        "soon",
        "edge",
      ]);
      expect(body.items.map((item) => item["state"])).toEqual([
        "live",
        "upcoming",
        "upcoming",
      ]);
      expect(body.items[0]).toEqual({
        campaignId: live.campaignId,
        title: "live",
        subtitle: null,
        coverUrl: null,
        startsAt: live.startsAt,
        endsAt: live.endsAt,
        ctaLabel: "查看",
        link: { kind: "route", value: "/launch2" },
        pinned: false,
        sortOrder: 0,
        state: "live",
      });
      expect(body.items[1]?.["campaignId"]).toBe(soon.campaignId);
      expect(body.items[2]?.["coverUrl"]).toBe(
        `https://api.loop.test/v2/media/${edge.coverMediaId as string}.webp`,
      );
    });

    it("orders pinned first, then sortOrder, then startsAt, at most 10", () => {
      const repository = createInMemoryLaunch2CampaignRepository();
      for (let index = 0; index < 12; index += 1) {
        repository.seed({
          title: `n${index}`,
          sortOrder: 12 - index,
          startsAt: at(-day + index),
        });
      }
      repository.seed({
        title: "pinned-late",
        pinned: true,
        sortOrder: 50,
        startsAt: at(-day),
      });
      repository.seed({
        title: "pinned-early",
        pinned: true,
        sortOrder: 50,
        startsAt: at(-2 * day),
      });
      repository.seed({ title: "tie-a", sortOrder: 0, startsAt: at(-5) });
      const selected = selectPublicLaunch2Campaigns(repository.rows, now);
      expect(selected).toHaveLength(10);
      expect(selected.map((record) => record.title)).toEqual([
        "pinned-early",
        "pinned-late",
        "tie-a",
        "n11",
        "n10",
        "n9",
        "n8",
        "n7",
        "n6",
        "n5",
      ]);
    });

    it("is 503 without the repository or when it fails, never empty", async () => {
      const { publicList } = await harness(undefined);
      const response = await publicList();
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: { reasonCode: "LAUNCH2_REPOSITORY_UNAVAILABLE" },
      });
      const repository = createInMemoryLaunch2CampaignRepository();
      repository.failing = true;
      const second = await harness(repository);
      expect((await second.publicList()).statusCode).toBe(503);
    });

    it("needs the bearer", async () => {
      const { app } = await harness(createInMemoryLaunch2CampaignRepository());
      const response = await app.inject({
        method: "GET",
        url: "/v2/launch2/campaigns",
        headers: s7CommonHeaders({ authorization: undefined }),
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("console routes", () => {
    it("refuses every write without a session (401) and for auditor / reviewer / testnet_acceptor (403)", async () => {
      const repository = createInMemoryLaunch2CampaignRepository();
      const existing = repository.seed({ status: "draft" });
      const { call } = await harness(repository);
      const cover = multipartBody(await png(1200, 600));
      const writes: Array<
        [
          method: "POST" | "PATCH",
          url: string,
          payload: unknown,
          headers?: Record<string, string>,
        ]
      > = [
        ["POST", base, validBody()],
        ["PATCH", `${base}/${existing.campaignId}`, { title: "x" }],
        ["POST", `${base}/${existing.campaignId}/publish`, undefined],
        ["POST", `${base}/${existing.campaignId}/archive`, undefined],
        ["POST", `${base}/cover`, cover.payload, cover.headers],
      ];
      for (const [method, url, payload, headers] of writes) {
        const anonymous = await call(null, method, url, payload, headers);
        expect(anonymous.statusCode, `${method} ${url}`).toBe(401);
        expect(anonymous.json()).toMatchObject({
          code: "ADMIN_SESSION_REQUIRED",
        });
        for (const role of [
          "auditor",
          "reviewer",
          "testnet_acceptor",
        ] as const) {
          const refused = await call(role, method, url, payload, headers);
          expect(refused.statusCode, `${role} ${method} ${url}`).toBe(403);
          expect(refused.json()).toMatchObject({ code: "PERMISSION_DENIED" });
        }
      }
      expect(repository.audits).toEqual([]);
      expect(repository.rows[0]?.status).toBe("draft");
      expect(repository.covers.size).toBe(0);
      // Reads: console.read (platform_admin, auditor); reviewer 403.
      expect((await call("auditor", "GET", base)).statusCode).toBe(200);
      expect(
        (await call("auditor", "GET", `${base}/${existing.campaignId}`))
          .statusCode,
      ).toBe(200);
      expect((await call("reviewer", "GET", base)).statusCode).toBe(403);
      expect((await call(null, "GET", base)).statusCode).toBe(401);
    });

    it("creates a draft, publishes, archives, with one audit row each", async () => {
      const repository = createInMemoryLaunch2CampaignRepository();
      const { call, publicList } = await harness(repository);
      const created = await call("platform_admin", "POST", base, validBody());
      expect(created.statusCode, created.body).toBe(201);
      const createdBody = created.json<{
        campaign: Record<string, unknown>;
        audit: { auditId: string; seq: number; at: string };
        replayed: boolean;
      }>();
      expect(createdBody.replayed).toBe(false);
      expect(createdBody.campaign).toMatchObject({
        title: "交易赛第一周",
        subtitle: "前 100 名分 1 万 USD1",
        coverMediaId: null,
        coverUrl: null,
        ctaLabel: "查看",
        pinned: false,
        sortOrder: 0,
        status: "draft",
        link: { kind: "route", value: "/launch2/instance?id=abc" },
      });
      expect(createdBody.campaign["createdBy"]).toEqual(expect.any(String));
      const id = createdBody.campaign["campaignId"] as string;
      expect((await publicList()).json<{ items: unknown[] }>().items).toEqual(
        [],
      );

      const published = await call(
        "platform_admin",
        "POST",
        `${base}/${id}/publish`,
      );
      expect(published.statusCode, published.body).toBe(200);
      expect(published.json()).toMatchObject({
        campaign: { status: "published" },
        audit: { seq: 2 },
      });
      expect(
        (await publicList()).json<{ items: Array<{ campaignId: string }> }>()
          .items[0]?.campaignId,
      ).toBe(id);

      const again = await call(
        "platform_admin",
        "POST",
        `${base}/${id}/publish`,
      );
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({
        code: "ADMIN_CONFLICT",
        detailsSafe: {
          reasonCode: "CAMPAIGN_STATUS_CONFLICT",
          status: "published",
        },
      });

      const patched = await call("platform_admin", "PATCH", `${base}/${id}`, {
        ...validBody(),
        title: "交易赛第二周",
        coverMediaId: null,
        ctaLabel: "去参加",
        pinned: true,
        sortOrder: 3,
      });
      expect(patched.statusCode, patched.body).toBe(200);
      expect(patched.json()).toMatchObject({
        campaign: {
          title: "交易赛第二周",
          status: "published",
          ctaLabel: "去参加",
          pinned: true,
          sortOrder: 3,
        },
      });

      const archived = await call(
        "platform_admin",
        "POST",
        `${base}/${id}/archive`,
      );
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toMatchObject({
        campaign: { status: "archived" },
      });
      expect((await publicList()).json<{ items: unknown[] }>().items).toEqual(
        [],
      );
      for (const url of [`${base}/${id}/publish`, `${base}/${id}/archive`]) {
        const refused = await call("platform_admin", "POST", url);
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toMatchObject({
          detailsSafe: {
            reasonCode: "CAMPAIGN_STATUS_CONFLICT",
            status: "archived",
          },
        });
      }
      const editArchived = await call(
        "platform_admin",
        "PATCH",
        `${base}/${id}`,
        {
          title: "x",
        },
      );
      expect(editArchived.statusCode).toBe(409);

      expect(repository.audits.map((audit) => audit.action)).toEqual([
        "launch2.campaign.create",
        "launch2.campaign.publish",
        "launch2.campaign.update",
        "launch2.campaign.archive",
      ]);
      expect(repository.audits[0]?.before).toBeNull();
      expect(repository.audits[2]?.before).toMatchObject({
        title: "交易赛第一周",
      });
      expect(repository.audits.every((audit) => audit.targetId === id)).toBe(
        true,
      );

      // Lists: all statuses, or one.
      const all = await call("platform_admin", "GET", base);
      expect(all.json<{ items: unknown[] }>().items).toHaveLength(1);
      const drafts = await call(
        "platform_admin",
        "GET",
        `${base}?status=draft`,
      );
      expect(drafts.json<{ items: unknown[] }>().items).toHaveLength(0);
      const one = await call("platform_admin", "GET", `${base}/${id}`);
      expect(one.json()).toMatchObject({
        campaign: { campaignId: id, status: "archived" },
      });
    });

    it("draft can be archived; unknown ids are 404", async () => {
      const repository = createInMemoryLaunch2CampaignRepository();
      const draft = repository.seed({ status: "draft" });
      const { call } = await harness(repository);
      expect(
        (
          await call(
            "platform_admin",
            "POST",
            `${base}/${draft.campaignId}/archive`,
          )
        ).statusCode,
      ).toBe(200);
      for (const id of [randomUUID(), "not-a-uuid"]) {
        for (const [method, url] of [
          ["GET", `${base}/${id}`],
          ["PATCH", `${base}/${id}`],
          ["POST", `${base}/${id}/publish`],
          ["POST", `${base}/${id}/archive`],
        ] as const) {
          const response = await call(
            "platform_admin",
            method,
            url,
            method === "PATCH" ? { title: "x" } : undefined,
          );
          expect(response.statusCode, `${method} ${url}`).toBe(404);
          expect(response.json()).toMatchObject({
            code: "NOT_FOUND",
            detailsSafe: { reasonCode: "CAMPAIGN_NOT_FOUND" },
          });
        }
      }
    });

    it("refuses publishing an ended campaign with CAMPAIGN_WINDOW_INVALID", async () => {
      const repository = createInMemoryLaunch2CampaignRepository();
      const ended = repository.seed({
        status: "draft",
        startsAt: at(-3 * day),
        endsAt: at(-day),
      });
      const { call } = await harness(repository);
      const response = await call(
        "platform_admin",
        "POST",
        `${base}/${ended.campaignId}/publish`,
      );
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        detailsSafe: { reasonCode: "CAMPAIGN_WINDOW_INVALID" },
      });
      expect(repository.audits).toEqual([]);
    });

    it("answers the four validation reason codes, nothing written", async () => {
      const repository = createInMemoryLaunch2CampaignRepository();
      const existing = repository.seed({
        status: "draft",
        startsAt: at(-day),
        endsAt: at(day),
      });
      const { call } = await harness(repository);
      const cases: Array<
        [payload: Record<string, unknown>, reason: string, field: string]
      > = [
        [{ ...validBody(), title: "   " }, "CAMPAIGN_TITLE_INVALID", "title"],
        [
          { ...validBody(), title: "一".repeat(25) },
          "CAMPAIGN_TITLE_INVALID",
          "title",
        ],
        [
          { ...validBody(), subtitle: "长".repeat(61) },
          "CAMPAIGN_TITLE_INVALID",
          "subtitle",
        ],
        [
          { ...validBody(), ctaLabel: "一二三四五六七八九" },
          "CAMPAIGN_TITLE_INVALID",
          "ctaLabel",
        ],
        [
          { ...validBody(), title: "bad\u0007bell" },
          "CAMPAIGN_TITLE_INVALID",
          "title",
        ],
        [
          { ...validBody(), endsAt: validBody().startsAt },
          "CAMPAIGN_WINDOW_INVALID",
          "endsAt",
        ],
        [
          { ...validBody(), startsAt: "yesterday" },
          "CAMPAIGN_WINDOW_INVALID",
          "startsAt",
        ],
        [
          { ...validBody(), link: { kind: "url", value: "http://x.test/" } },
          "CAMPAIGN_LINK_INVALID",
          "link",
        ],
        [
          {
            ...validBody(),
            link: { kind: "url", value: "https://u:p@x.test/" },
          },
          "CAMPAIGN_LINK_INVALID",
          "link",
        ],
        [
          { ...validBody(), link: { kind: "route", value: "//evil.test" } },
          "CAMPAIGN_LINK_INVALID",
          "link",
        ],
        [
          { ...validBody(), link: { kind: "route", value: "launch2" } },
          "CAMPAIGN_LINK_INVALID",
          "link",
        ],
        [
          { ...validBody(), link: { kind: "route", value: "/a b" } },
          "CAMPAIGN_LINK_INVALID",
          "link",
        ],
        [
          { ...validBody(), link: { kind: "app", value: "/a" } },
          "CAMPAIGN_LINK_INVALID",
          "link",
        ],
        [
          { ...validBody(), coverMediaId: randomUUID() },
          "CAMPAIGN_COVER_INVALID",
          "coverMediaId",
        ],
        [
          { ...validBody(), coverMediaId: "nope" },
          "CAMPAIGN_COVER_INVALID",
          "coverMediaId",
        ],
      ];
      for (const [payload, reasonCode, field] of cases) {
        const response = await call("platform_admin", "POST", base, payload);
        expect(response.statusCode, JSON.stringify(payload)).toBe(422);
        expect(response.json()).toMatchObject({
          code: "VALIDATION_FAILED",
          detailsSafe: { reasonCode, field },
        });
      }
      // PATCH: the window is checked on the merged values.
      const patch = await call(
        "platform_admin",
        "PATCH",
        `${base}/${existing.campaignId}`,
        { endsAt: at(-2 * day) },
      );
      expect(patch.statusCode).toBe(422);
      expect(patch.json()).toMatchObject({
        detailsSafe: { reasonCode: "CAMPAIGN_WINDOW_INVALID" },
      });
      expect(repository.rows).toHaveLength(1);
      expect(repository.audits).toEqual([]);
      // Shape errors stay 400.
      expect(
        (
          await call("platform_admin", "POST", base, {
            ...validBody(),
            extra: 1,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await call(
            "platform_admin",
            "PATCH",
            `${base}/${existing.campaignId}`,
            {},
          )
        ).statusCode,
      ).toBe(400);
    });

    it("replays a create under the same Idempotency-Key, conflicts on another body", async () => {
      const repository = createInMemoryLaunch2CampaignRepository();
      const { call } = await harness(repository);
      const headers = {
        "idempotency-key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      };
      const first = await call(
        "platform_admin",
        "POST",
        base,
        validBody(),
        headers,
      );
      expect(first.statusCode).toBe(201);
      const second = await call(
        "platform_admin",
        "POST",
        base,
        validBody(),
        headers,
      );
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        replayed: true,
        campaign: {
          campaignId: first.json<{ campaign: { campaignId: string } }>()
            .campaign.campaignId,
        },
        audit: first.json<{ audit: unknown }>().audit,
      });
      const other = await call(
        "platform_admin",
        "POST",
        base,
        { ...validBody(), title: "另一个" },
        headers,
      );
      expect(other.statusCode).toBe(409);
      expect(other.json()).toMatchObject({
        detailsSafe: { reasonCode: "ADMIN_IDEMPOTENCY_CONFLICT" },
      });
      expect(repository.rows).toHaveLength(1);
      expect(repository.audits).toHaveLength(1);
      // A malformed key is refused; publish accepts a key.
      expect(
        (
          await call("platform_admin", "POST", base, validBody(), {
            "idempotency-key": "nope",
          })
        ).statusCode,
      ).toBe(400);
      const id = repository.rows[0]?.campaignId as string;
      expect(
        (
          await call(
            "platform_admin",
            "POST",
            `${base}/${id}/publish`,
            undefined,
            {
              "idempotency-key": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            },
          )
        ).statusCode,
      ).toBe(200);
    });

    it("uploads a cover as 1200x600 WebP and accepts it as coverMediaId", async () => {
      const repository = createInMemoryLaunch2CampaignRepository();
      const { call, publicList } = await harness(repository);
      const upload = multipartBody(await png(1600, 900));
      const key = { "idempotency-key": "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
      const response = await call(
        "platform_admin",
        "POST",
        `${base}/cover`,
        upload.payload,
        { ...upload.headers, ...key },
      );
      expect(response.statusCode, response.body).toBe(201);
      const body = response.json<{ mediaId: string; coverUrl: string }>();
      expect(body.coverUrl).toBe(
        `https://api.loop.test/v2/media/${body.mediaId}.webp`,
      );
      const replay = await call(
        "platform_admin",
        "POST",
        `${base}/cover`,
        upload.payload,
        { ...upload.headers, ...key },
      );
      expect(replay.statusCode).toBe(201);
      expect(replay.json<{ mediaId: string }>().mediaId).toBe(body.mediaId);
      const otherBytes = multipartBody(await png(1200, 700));
      const conflict = await call(
        "platform_admin",
        "POST",
        `${base}/cover`,
        otherBytes.payload,
        { ...otherBytes.headers, ...key },
      );
      expect(conflict.statusCode).toBe(409);

      const created = await call("platform_admin", "POST", base, {
        ...validBody(),
        coverMediaId: body.mediaId,
      });
      expect(created.statusCode, created.body).toBe(201);
      const campaign = created.json<{
        campaign: { campaignId: string; coverUrl: string };
      }>().campaign;
      expect(campaign.coverUrl).toBe(body.coverUrl);
      await call(
        "platform_admin",
        "POST",
        `${base}/${campaign.campaignId}/publish`,
      );
      expect(
        (await publicList()).json<{ items: Array<{ coverUrl: string }> }>()
          .items[0]?.coverUrl,
      ).toBe(body.coverUrl);
    });

    it("refuses bad covers with CAMPAIGN_COVER_INVALID and the media reason", async () => {
      const repository = createInMemoryLaunch2CampaignRepository();
      const { call } = await harness(repository);
      const heic = Buffer.concat([
        Buffer.from([0, 0, 0, 24]),
        Buffer.from("ftypheic"),
        Buffer.alloc(64),
      ]);
      const cases: Array<[Buffer, string]> = [
        [Buffer.from("not an image at all"), "MEDIA_TYPE_UNSUPPORTED"],
        [heic, "MEDIA_TYPE_UNSUPPORTED"],
        [await png(400, 200), "MEDIA_DIMENSIONS_TOO_SMALL"],
        [
          Buffer.concat([await png(1200, 600), Buffer.alloc(2 * 1024 * 1024)]),
          "MEDIA_TOO_LARGE",
        ],
      ];
      for (const [bytes, mediaReasonCode] of cases) {
        const upload = multipartBody(bytes);
        const response = await call(
          "platform_admin",
          "POST",
          `${base}/cover`,
          upload.payload,
          upload.headers,
        );
        expect(response.statusCode, mediaReasonCode).toBe(422);
        expect(response.json()).toMatchObject({
          code: "VALIDATION_FAILED",
          detailsSafe: {
            reasonCode: "CAMPAIGN_COVER_INVALID",
            mediaReasonCode,
          },
        });
      }
      const wrongField = multipartBody(await png(1200, 600), "image");
      expect(
        (
          await call(
            "platform_admin",
            "POST",
            `${base}/cover`,
            wrongField.payload,
            wrongField.headers,
          )
        ).statusCode,
      ).toBe(400);
      expect(repository.covers.size).toBe(0);
    });

    it("is 503 without the repository", async () => {
      const { call } = await harness(undefined);
      const response = await call("platform_admin", "GET", base);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        detailsSafe: { reasonCode: "CAMPAIGN_REPOSITORY_UNAVAILABLE" },
      });
      expect(
        (await call("platform_admin", "POST", base, validBody())).statusCode,
      ).toBe(503);
    });
  });

  it("stores a cover as a 1200x600 WebP (2:1 centre crop)", async () => {
    for (const [width, height] of [
      [1200, 600],
      [3000, 1000],
      [800, 800],
    ] as const) {
      const processed = await processCampaignCoverUpload(
        await png(width, height),
      );
      expect([processed.width, processed.height]).toEqual([1200, 600]);
      expect(processed.bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
      expect(processed.bytes.length).toBeLessThan(1024 * 1024);
    }
  });
});
