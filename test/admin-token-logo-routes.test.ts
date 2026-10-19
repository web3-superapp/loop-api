import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type {
  TokenLogoAuditInput,
  TokenLogoCacheRecord,
  TokenLogoCacheRepository,
  TokenLogoManualPicture,
} from "../src/database/token-logo-cache-repository.js";
import { tokenLogoNeverExpires } from "../src/database/token-logo-cache-repository.js";
import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import type { AdminRole } from "../src/features/admin/admin-roles.js";
import { createInMemoryAdminRepository } from "./helpers/admin-fakes.js";
import {
  createFakeHooksReview,
  createInMemoryAdminAccounts,
  createInMemoryAdminLaunchReview,
} from "./helpers/admin-role-fakes.js";
import { s7Database, s7PrivyVerifier, s7TestConfig } from "./s7-route-fakes.js";
import {
  logoPng,
  memoryLogoCache,
  trustWalletWbnb,
  upstreamFetch,
  wbnb,
} from "./token-logo-fakes.js";

/**
 * Decision 0161 §3: `/admin/v1/market/logos/{chainId}/{address}` — the
 * console's manual token logo, audited, served by the public proxy and
 * never overwritten by it.
 */

const boundary = "----looplogotest";
const accountPassword = "account-password-0123";
let passwordHash = "";
const now = new Date("2026-10-19T08:00:00.000Z");

beforeAll(async () => {
  passwordHash = await hashAdminPassword("bootstrap-password-0123");
});

function fileBody(bytes: Buffer, name = "file"): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="logo.png"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

/** In-memory repository with the manual methods and their audit rows. */
function manualCache() {
  const memory = memoryLogoCache();
  const audits: {
    action: string;
    targetId: string;
    audit: TokenLogoAuditInput;
  }[] = [];
  let seq = 0;
  const auditRef = () => {
    seq += 1;
    return { auditId: randomUUID(), seq, at: now.toISOString() };
  };
  const repository: TokenLogoCacheRepository = {
    get: memory.get,
    put: memory.put,
    listStates: memory.listStates,
    putManual: vi.fn(
      (picture: TokenLogoManualPicture, audit: TokenLogoAuditInput) => {
        const key = `${picture.chainId}/${picture.address}`;
        const before = memory.rows.get(key) ?? null;
        const record: TokenLogoCacheRecord = {
          chainId: picture.chainId,
          address: picture.address,
          status: "found",
          bytes: picture.bytes,
          contentType: picture.contentType,
          etag: picture.etag,
          source: "manual",
          sourceUrl: null,
          candidateUrl: null,
          fetchedAt: picture.at,
          expiresAt: tokenLogoNeverExpires,
        };
        memory.rows.set(key, record);
        audits.push({ action: "market.logo.override", targetId: key, audit });
        return Promise.resolve({ record, before, audit: auditRef() });
      },
    ),
    clearManual: vi.fn(
      (chainId: string, address: string, audit: TokenLogoAuditInput) => {
        const key = `${chainId}/${address}`;
        const before = memory.rows.get(key);
        if (before?.source !== "manual") {
          return Promise.resolve(null);
        }
        memory.rows.delete(key);
        audits.push({
          action: "market.logo.override_clear",
          targetId: key,
          audit,
        });
        return Promise.resolve({ before, audit: auditRef() });
      },
    ),
  };
  return { memory, repository, audits };
}

describe("admin token logo routes (Decision 0161)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function harness(
    cache: TokenLogoCacheRepository | undefined,
    fetch: typeof globalThis.fetch = upstreamFetch({}),
  ) {
    const admin = createInMemoryAdminRepository();
    const accounts = createInMemoryAdminAccounts(admin);
    const base = s7Database({});
    const app = await buildApp({
      config: s7TestConfig({
        PUBLIC_BASE_URL: "https://api.loop.test",
        V2_MODULES_ENABLED: "market",
        ADMIN_USERNAME: "operator",
        ADMIN_PASSWORD_HASH: passwordHash,
        ADMIN_SESSION_SECRET: "s238-admin-session-secret-0123456789abcdef",
      }),
      database: {
        ...base,
        admin,
        adminAccounts: accounts,
        adminLaunchReview: createInMemoryAdminLaunchReview([], new Map()),
        hooksLaunchReview: createFakeHooksReview({
          grants: new Map(),
          owners: new Map(),
        }),
        marketFacts: {
          get: () => Promise.resolve(null),
          put: () => Promise.reject(new Error("not used")),
          getMany: () => Promise.resolve(new Map()),
          findVerifiedCommunityByAssetId: () => Promise.resolve(null),
        },
        ...(cache === undefined ? {} : { tokenLogoCache: cache }),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      memePauseSender: null,
      tokenLogoFetch: fetch,
      tokenLogoUpstreamTimeoutMs: 50,
      adminNow: () => now,
      logger: false,
    });
    apps.push(app);
    const cookies = new Map<AdminRole, string>();
    for (const role of ["platform_admin", "auditor"] as const) {
      const username = `${role.replaceAll("_", "-")}-${randomUUID().slice(0, 8)}`;
      await accounts.seed({
        username,
        password: accountPassword,
        role,
        operatorUserId: null,
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
    return { app, cookies };
  }

  const path = `/admin/v1/market/logos/eip155:56/${wbnb}`;

  function upload(
    app: FastifyInstance,
    cookie: string | undefined,
    bytes: Buffer,
    url = path,
  ) {
    return app.inject({
      method: "POST",
      url,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: fileBody(bytes),
    });
  }

  it("uploads a manual logo as a 128 x 128 WebP, audits it, and the public proxy serves it without asking any upstream", async () => {
    const { repository, memory, audits } = manualCache();
    const fetch = upstreamFetch({
      [trustWalletWbnb]: { kind: "body", body: await logoPng() },
    });
    const { app, cookies } = await harness(repository, fetch);
    const picture = await logoPng({ width: 512, height: 256, alpha: 0.6 });

    const response = await upload(
      app,
      cookies.get("platform_admin"),
      picture,
      // Checksummed input is stored lowercase.
      "/admin/v1/market/logos/eip155:56/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<{
      logo: { etag: string; byteLength: number };
      audit: { seq: number };
    }>();
    expect(body.logo).toMatchObject({
      chainId: "eip155:56",
      address: wbnb,
      status: "found",
      source: "manual",
      contentType: "image/webp",
      expiresAt: null,
      url: `https://api.loop.test/v2/market/logos/eip155:56/${wbnb}.png`,
    });
    expect(body.audit).toMatchObject({ seq: 1 });
    expect(audits).toEqual([
      expect.objectContaining({
        action: "market.logo.override",
        targetId: `eip155:56/${wbnb}`,
      }),
    ]);
    const stored = memory.rows.get(`eip155:56/${wbnb}`);
    expect(stored?.bytes?.length).toBe(body.logo.byteLength);
    expect(
      await sharp(stored?.bytes ?? Buffer.alloc(0)).metadata(),
    ).toMatchObject({ format: "webp", width: 128, height: 128 });

    const served = await app.inject({
      method: "GET",
      url: `/v2/market/logos/eip155:56/${wbnb}.png`,
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/webp");
    expect(served.headers["etag"]).toBe(body.logo.etag);
    expect(fetch.calls).toEqual([]);

    const read = await app.inject({
      method: "GET",
      url: path,
      headers: { cookie: cookies.get("auditor") as string },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ logo: unknown }>().logo).toEqual(body.logo);

    // Clearing hands the token back to the upstreams.
    const cleared = await app.inject({
      method: "DELETE",
      url: path,
      headers: { cookie: cookies.get("platform_admin") as string },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<{ audit: unknown }>().audit).toMatchObject({
      seq: 2,
    });
    const again = await app.inject({
      method: "DELETE",
      url: path,
      headers: { cookie: cookies.get("platform_admin") as string },
    });
    expect(again.statusCode).toBe(404);
    expect(again.json<{ detailsSafe: unknown }>().detailsSafe).toMatchObject({
      reasonCode: "TOKEN_LOGO_OVERRIDE_NOT_FOUND",
    });
    const refetched = await app.inject({
      method: "GET",
      url: `/v2/market/logos/eip155:56/${wbnb}.png`,
    });
    expect(refetched.statusCode).toBe(200);
    expect(fetch.calls).toEqual([trustWalletWbnb]);
  });

  it("guards by session and permission, and refuses bad uploads with 422 and the reason", async () => {
    const { repository, audits } = manualCache();
    const { app, cookies } = await harness(repository);
    const picture = await logoPng();
    expect((await upload(app, undefined, picture)).statusCode).toBe(401);
    expect(
      (await upload(app, cookies.get("auditor"), picture)).statusCode,
    ).toBe(403);
    const admin = cookies.get("platform_admin");
    for (const [bytes, reason] of [
      [
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        "TOKEN_LOGO_TYPE_UNSUPPORTED",
      ],
      [Buffer.concat([picture.subarray(0, 60)]), "TOKEN_LOGO_DECODE_FAILED"],
      [Buffer.alloc(2 * 1024 * 1024 + 1, 1), "TOKEN_LOGO_TOO_LARGE"],
    ] as const) {
      const response = await upload(app, admin, bytes);
      expect(response.statusCode, reason).toBe(422);
      expect(response.json(), reason).toMatchObject({
        code: "VALIDATION_FAILED",
        detailsSafe: {
          reasonCode: "TOKEN_LOGO_UPLOAD_INVALID",
          field: "file",
          logoReasonCode: reason,
        },
      });
    }
    for (const url of [
      `/admin/v1/market/logos/eip155:97/${wbnb}`,
      "/admin/v1/market/logos/eip155:56/0x1234",
    ]) {
      expect((await upload(app, admin, picture, url)).statusCode, url).toBe(
        400,
      );
    }
    // A non-multipart body.
    const json = await app.inject({
      method: "POST",
      url: path,
      headers: { cookie: admin as string },
      payload: { file: "x" },
    });
    expect(json.statusCode).toBe(400);
    expect(audits).toEqual([]);

    const notCached = await app.inject({
      method: "GET",
      url: `/admin/v1/market/logos/eip155:1/native`,
      headers: { cookie: admin as string },
    });
    expect(notCached.statusCode).toBe(404);
    expect(
      notCached.json<{ detailsSafe: unknown }>().detailsSafe,
    ).toMatchObject({
      reasonCode: "TOKEN_LOGO_NOT_CACHED",
    });
  });

  it("answers 503 CAPABILITY_UNAVAILABLE without the logo cache", async () => {
    const { app, cookies } = await harness(undefined);
    const response = await upload(
      app,
      cookies.get("platform_admin"),
      await logoPng(),
    );
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "TOKEN_LOGO_CACHE_UNAVAILABLE" },
    });
  });
});
