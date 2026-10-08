import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import {
  createUnavailableControlPlaneRepository,
  IssuanceQuotaExceededError,
  type ControlPlaneRepository,
} from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import type {
  StreamUserGateway,
  StreamUserIdentityRepository,
} from "../src/features/communication/stream-user-identity.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import {
  MediaIdempotencyConflictError,
  type MediaObject,
  type MediaStorage,
  type PutMediaObjectInput,
} from "../src/features/media/media-storage.js";
import type {
  ProfileV2Record,
  ProfileV2Repository,
} from "../src/features/profile/profile-v2-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

/** Decision 0095: media upload/read routes and the avatarRef media rule. */

const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const otherAccountId = "f7bf09f6-0171-46b9-9acd-5ad494f211bd";
const idempotencyKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const quotaSecret = "q".repeat(48);
const boundary = "----loopmediatest";
const errorKeys = [
  "category",
  "code",
  "correlationId",
  "detailsSafe",
  "providerReferenceSafe",
  "retryable",
  "userMessageKey",
];

let jpeg: Buffer;
let png: Buffer;
let tiny: Buffer;

beforeAll(async () => {
  jpeg = await sharp({
    create: { width: 800, height: 600, channels: 3, background: "#c6f432" },
  })
    .jpeg()
    .toBuffer();
  png = await sharp({
    create: { width: 300, height: 900, channels: 4, background: "#102030" },
  })
    .png()
    .toBuffer();
  tiny = await sharp({
    create: { width: 32, height: 200, channels: 3, background: "#000000" },
  })
    .png()
    .toBuffer();
});

function multipartBody(
  parts: readonly { name: string; bytes: Buffer; filename?: string }[],
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${
          part.filename === undefined ? "" : `; filename="${part.filename}"`
        }\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      part.bytes,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function fileBody(bytes: Buffer): Buffer {
  return multipartBody([{ name: "file", bytes, filename: "a.bin" }]);
}

function headers(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const result: Record<string, string> = {
    authorization: "Bearer header.payload.signature",
    "x-loop-client-version": "1.2.3",
    "x-loop-contract-version": "2.0",
    "idempotency-key": idempotencyKey,
    "content-type": `multipart/form-data; boundary=${boundary}`,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete result[name];
    } else {
      result[name] = value;
    }
  }
  return result;
}

function memoryStorage(): MediaStorage & { readonly rows: MediaObject[] } {
  const rows: (MediaObject & {
    idempotencyKey: string;
    requestSha256: string;
  })[] = [];
  return {
    rows,
    put: vi.fn((input: PutMediaObjectInput) => {
      const earlier = rows.find(
        (row) =>
          row.ownerUserId === input.ownerUserId &&
          row.idempotencyKey === input.idempotencyKey,
      );
      if (earlier !== undefined) {
        if (earlier.requestSha256 !== input.requestSha256) {
          return Promise.reject(new MediaIdempotencyConflictError());
        }
        return Promise.resolve(earlier);
      }
      const row = {
        mediaId: input.mediaId,
        ownerUserId: input.ownerUserId,
        kind: input.kind,
        contentType: "image/webp" as const,
        width: input.width,
        height: input.height,
        sha256: input.sha256,
        createdAt: "2026-10-08T00:00:00.000Z",
        bytes: input.bytes,
        idempotencyKey: input.idempotencyKey,
        requestSha256: input.requestSha256,
      };
      rows.push(row);
      return Promise.resolve(row);
    }),
    findByIdempotencyKey: vi.fn(
      (input: { ownerUserId: string; idempotencyKey: string }) =>
        Promise.resolve(
          rows.find(
            (row) =>
              row.ownerUserId === input.ownerUserId &&
              row.idempotencyKey === input.idempotencyKey,
          ) ?? null,
        ),
    ),
    get: vi.fn((mediaId: string) =>
      Promise.resolve(rows.find((row) => row.mediaId === mediaId) ?? null),
    ),
    getMetadata: vi.fn((mediaId: string) =>
      Promise.resolve(rows.find((row) => row.mediaId === mediaId) ?? null),
    ),
  };
}

const activeRecord: ProfileV2Record = Object.freeze({
  ownerUserId: accountId,
  loopId: "LOOP-7HJKMNPQ",
  alias: "Alice",
  avatarRef: null,
  bio: null,
  interests: Object.freeze([]),
  profileStatus: "active",
  activatedAt: "2026-09-07T01:00:00.000Z",
  version: 1,
  updatedAt: "2026-09-07T01:00:00.000Z",
});

function fakes(options: { readonly quotaExceeded?: boolean } = {}) {
  const storage = memoryStorage();
  const consumeIssuanceQuota = vi.fn<
    ControlPlaneRepository["consumeIssuanceQuota"]
  >(() =>
    options.quotaExceeded === true
      ? Promise.reject(new IssuanceQuotaExceededError())
      : Promise.resolve([]),
  );
  const profilesV2 = {
    getProfile: vi.fn(() => Promise.resolve(activeRecord)),
    replaceProfile: vi.fn<ProfileV2Repository["replaceProfile"]>((input) =>
      Promise.resolve({
        ...activeRecord,
        ...input.profile,
        version: input.expectedVersion + 1,
      }),
    ),
    activateProfile: vi.fn(() => Promise.resolve(activeRecord)),
    getPrivacy: vi.fn(() => Promise.resolve(null)),
    replacePrivacy: vi.fn(() => Promise.resolve(null)),
  } satisfies ProfileV2Repository;
  const streamUserIdentities = {
    listIdentities: vi.fn<StreamUserIdentityRepository["listIdentities"]>(() =>
      Promise.resolve([
        {
          userId: accountId,
          alias: "Alice",
          avatarRef: `avatar:media/${storage.rows[0]?.mediaId ?? "x"}`,
          publicProfileId: "33333333-3333-4333-8333-333333333333",
        },
      ]),
    ),
    listActivatedUserIds: vi.fn(() => Promise.resolve([])),
  } satisfies StreamUserIdentityRepository;
  const upsertUsers = vi.fn<StreamUserGateway["upsertUsers"]>(() =>
    Promise.resolve(),
  );
  const database = {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: {
      ...createUnavailableControlPlaneRepository(),
      consumeIssuanceQuota,
    },
    deviceSessions: createUnavailableDeviceSessionRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    profilesV2,
    media: storage,
    streamUserIdentities,
    watchlists: createUnavailableWatchlistRepository(),
    internalUsers: {
      findByPrivyUserId: vi.fn<InternalUserRepository["findByPrivyUserId"]>(
        () => Promise.resolve({ id: accountId }),
      ),
      getOrCreateByPrivyUserId: vi.fn<
        InternalUserRepository["getOrCreateByPrivyUserId"]
      >(() => Promise.resolve({ id: accountId })),
    },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  } satisfies Database;
  const privyAccessTokenVerifier = {
    verifyAccessToken: vi.fn(() =>
      Promise.resolve({ privyUserId: "did:privy:verified-user" }),
    ),
  } satisfies PrivyAccessTokenVerifier;
  return {
    database,
    storage,
    consumeIssuanceQuota,
    profilesV2,
    privyAccessTokenVerifier,
    upsertUsers,
  };
}

function expectEnvelope(
  response: { statusCode: number; json: <T>() => T },
  status: number,
  code: string,
): Record<string, unknown> {
  expect(response.statusCode).toBe(status);
  const body = response.json<Record<string, unknown>>();
  expect(Object.keys(body).sort()).toEqual(errorKeys);
  expect(body["code"]).toBe(code);
  return body;
}

describe("LOOP API V2 media (Decision 0095)", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    dependencies: Omit<ReturnType<typeof fakes>, "database"> & {
      readonly database: Database;
    } = fakes(),
    overrides: Readonly<Record<string, string>> = {},
  ) {
    const app = await buildApp({
      config: loadConfig({
        NODE_ENV: "test",
        API_DOCS_ENABLED: "false",
        LOG_LEVEL: "silent",
        V2_MODULES_ENABLED: "profile",
        PRIVY_APP_ID: "app_test",
        PRIVY_APP_SECRET: "secret_test",
        PUBLIC_BASE_URL: "https://api-dev.example.test",
        STREAM_TOKEN_QUOTA_HMAC_SECRET: quotaSecret,
        DATABASE_URL:
          "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
        ...overrides,
      }),
      contractSurface: "v2",
      database: dependencies.database,
      privyAccessTokenVerifier: dependencies.privyAccessTokenVerifier,
      streamUserGateway: { upsertUsers: dependencies.upsertUsers },
      logger: false,
    });
    apps.push(app);
    return { app, ...dependencies };
  }

  it("uploads an avatar as a 512x512 WebP and serves it publicly with immutable caching", async () => {
    const { app, consumeIssuanceQuota } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v2/media/avatars",
      headers: headers(),
      payload: fileBody(jpeg),
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<{
      mediaId: string;
      ref: string;
      url: string;
      width: number;
      height: number;
      contractVersion: string;
    }>();
    expect(body).toEqual({
      mediaId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ) as unknown,
      ref: `avatar:media/${body.mediaId}`,
      url: `/v2/media/${body.mediaId}.webp`,
      width: 512,
      height: 512,
      contractVersion: "2.0",
    });
    expect(consumeIssuanceQuota).toHaveBeenCalledTimes(1);
    expect(consumeIssuanceQuota.mock.calls[0]?.[0]).toMatchObject({
      capability: "media_upload",
      buckets: [
        { subjectKind: "user_minute", windowDurationSeconds: 60, capacity: 6 },
      ],
    });

    const image = await app.inject({ method: "GET", url: body.url });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/webp");
    expect(image.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    const etag = image.headers["etag"];
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    const meta = await sharp(image.rawPayload).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 512, height: 512 });

    const revalidated = await app.inject({
      method: "GET",
      url: body.url,
      headers: { "if-none-match": String(etag) },
    });
    expect(revalidated.statusCode).toBe(304);
  });

  it("uploads a community logo with a logo ref", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v2/media/community-logos",
      headers: headers(),
      payload: fileBody(png),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ mediaId: string; ref: string }>();
    expect(body.ref).toBe(`logo:media/${body.mediaId}`);
  });

  it("replays an Idempotency-Key with the same bytes and conflicts with different bytes", async () => {
    const { app, storage } = await createApp();
    const first = await app.inject({
      method: "POST",
      url: "/v2/media/avatars",
      headers: headers(),
      payload: fileBody(jpeg),
    });
    const replay = await app.inject({
      method: "POST",
      url: "/v2/media/avatars",
      headers: headers(),
      payload: fileBody(jpeg),
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(storage.rows).toHaveLength(1);
    const conflict = await app.inject({
      method: "POST",
      url: "/v2/media/avatars",
      headers: headers(),
      payload: fileBody(png),
    });
    expectEnvelope(conflict, 409, "IDEMPOTENCY_CONFLICT");
    const otherKind = await app.inject({
      method: "POST",
      url: "/v2/media/community-logos",
      headers: headers(),
      payload: fileBody(jpeg),
    });
    expectEnvelope(otherKind, 409, "IDEMPOTENCY_CONFLICT");
  });

  it("rejects unsupported, too small, undecodable, and oversized pictures with reason codes", async () => {
    const { app, storage } = await createApp();
    const cases: readonly [Buffer, string][] = [
      [Buffer.from("GIF89a not allowed"), "MEDIA_TYPE_UNSUPPORTED"],
      [tiny, "MEDIA_DIMENSIONS_TOO_SMALL"],
      [
        Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 1)]),
        "MEDIA_DECODE_FAILED",
      ],
      [
        Buffer.concat([
          Buffer.from([0xff, 0xd8, 0xff]),
          Buffer.alloc(5 * 1024 * 1024 + 1, 0),
        ]),
        "MEDIA_TOO_LARGE",
      ],
    ];
    for (const [bytes, reasonCode] of cases) {
      const response = await app.inject({
        method: "POST",
        url: "/v2/media/avatars",
        headers: headers({ "idempotency-key": crypto.randomUUID() }),
        payload: fileBody(bytes),
      });
      const body = expectEnvelope(response, 422, "VALIDATION_FAILED");
      expect(body["detailsSafe"]).toEqual({ reasonCode });
    }
    expect(storage.rows).toHaveLength(0);
  });

  it("requires multipart with exactly one file part, the write headers, and a bearer", async () => {
    const { app, privyAccessTokenVerifier } = await createApp();
    const json = await app.inject({
      method: "POST",
      url: "/v2/media/avatars",
      headers: headers({ "content-type": "application/json" }),
      payload: { file: "x" },
    });
    expectEnvelope(json, 400, "INVALID_REQUEST");
    const wrongName = await app.inject({
      method: "POST",
      url: "/v2/media/avatars",
      headers: headers(),
      payload: multipartBody([{ name: "image", bytes: jpeg, filename: "a" }]),
    });
    expectEnvelope(wrongName, 400, "INVALID_REQUEST");
    const extraField = await app.inject({
      method: "POST",
      url: "/v2/media/avatars",
      headers: headers(),
      payload: multipartBody([
        { name: "note", bytes: Buffer.from("x") },
        { name: "file", bytes: jpeg, filename: "a" },
      ]),
    });
    expectEnvelope(extraField, 400, "INVALID_REQUEST");
    const noKey = await app.inject({
      method: "POST",
      url: "/v2/media/avatars",
      headers: headers({ "idempotency-key": undefined }),
      payload: fileBody(jpeg),
    });
    expectEnvelope(noKey, 400, "INVALID_REQUEST");
    const noVersion = await app.inject({
      method: "POST",
      url: "/v2/media/avatars",
      headers: headers({ "x-loop-contract-version": undefined }),
      payload: fileBody(jpeg),
    });
    expect(noVersion.statusCode).toBe(400);
    privyAccessTokenVerifier.verifyAccessToken.mockClear();
    const anonymous = await app.inject({
      method: "POST",
      url: "/v2/media/avatars",
      headers: headers({ authorization: undefined }),
      payload: fileBody(jpeg),
    });
    expectEnvelope(anonymous, 401, "AUTH_REQUIRED");
  });

  it("rate limits uploads with RATE_LIMITED and stores nothing", async () => {
    const { app, storage } = await createApp(fakes({ quotaExceeded: true }));
    const response = await app.inject({
      method: "POST",
      url: "/v2/media/avatars",
      headers: headers(),
      payload: fileBody(jpeg),
    });
    expectEnvelope(response, 429, "RATE_LIMITED");
    expect(storage.rows).toHaveLength(0);
  });

  it("answers 404 for an unknown media ID and 400 for a malformed one", async () => {
    const { app } = await createApp();
    const missing = await app.inject({
      method: "GET",
      url: "/v2/media/11111111-1111-4111-8111-111111111111.webp",
    });
    expectEnvelope(missing, 404, "NOT_FOUND");
    const malformed = await app.inject({
      method: "GET",
      url: "/v2/media/not-a-uuid.webp",
    });
    expectEnvelope(malformed, 400, "INVALID_REQUEST");
  });

  it("publishes avatarUpload available only with media storage and the quota secret", async () => {
    const { app } = await createApp();
    const capabilities = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const avatarUpload = capabilities
      .json<{ capabilities: { capabilityId: string }[] }>()
      .capabilities.find((entry) => entry.capabilityId === "avatarUpload");
    expect(avatarUpload).toEqual({
      capabilityId: "avatarUpload",
      availability: "available",
      reasonCode: null,
      evidence: { status: "notApplicable", reasonCode: null },
    });

    const withoutStorage = fakes();
    const database: Database = { ...withoutStorage.database };
    delete (database as { media?: unknown }).media;
    const closed = await createApp({ ...withoutStorage, database });
    const closedCapabilities = await closed.app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    expect(
      closedCapabilities
        .json<{ capabilities: { capabilityId: string }[] }>()
        .capabilities.find((entry) => entry.capabilityId === "avatarUpload"),
    ).toMatchObject({
      availability: "unavailable",
      reasonCode: "AVATAR_STORAGE_UNAVAILABLE",
    });
    const upload = await closed.app.inject({
      method: "POST",
      url: "/v2/media/avatars",
      headers: headers(),
      payload: fileBody(jpeg),
    });
    expectEnvelope(upload, 503, "CAPABILITY_UNAVAILABLE");
  });

  it("accepts only the caller's own uploaded avatar and syncs the Stream user", async () => {
    const dependencies = fakes();
    const { app, storage, profilesV2, upsertUsers } =
      await createApp(dependencies);
    const uploaded = await app.inject({
      method: "POST",
      url: "/v2/media/avatars",
      headers: headers(),
      payload: fileBody(jpeg),
    });
    const { ref, mediaId } = uploaded.json<{ ref: string; mediaId: string }>();
    const putHeaders = {
      authorization: "Bearer header.payload.signature",
      "x-loop-client-version": "1.2.3",
      "x-loop-contract-version": "2.0",
    };
    const profile = (avatarRef: string) => ({
      expectedVersion: 1,
      profile: { alias: "Alice", avatarRef, bio: null, interests: [] },
    });
    const accepted = await app.inject({
      method: "PUT",
      url: "/v2/profile",
      headers: putHeaders,
      payload: profile(ref),
    });
    expect(accepted.statusCode).toBe(200);
    expect(
      accepted.json<{ profile: { avatarRef: string } }>().profile.avatarRef,
    ).toBe(ref);
    expect(upsertUsers).toHaveBeenCalledTimes(1);
    expect(upsertUsers.mock.calls[0]?.[0].users).toEqual([
      {
        id: "loop_6d12a86e413447e69312c5ef75a30f55",
        name: "Alice",
        image: `https://api-dev.example.test/v2/media/${mediaId}.webp`,
        custom: { publicProfileId: "33333333-3333-4333-8333-333333333333" },
      },
    ]);

    // Someone else's upload, a logo, and a nonexistent media are refused.
    const row = storage.rows[0];
    if (row === undefined) {
      throw new Error("expected an uploaded row");
    }
    storage.rows.push(
      {
        ...row,
        mediaId: "22222222-2222-4222-8222-222222222222",
        ownerUserId: otherAccountId,
      },
      {
        ...row,
        mediaId: "33333333-3333-4333-8333-333333333333",
        kind: "community_logo",
      },
    );
    for (const foreign of [
      "avatar:media/22222222-2222-4222-8222-222222222222",
      "avatar:media/33333333-3333-4333-8333-333333333333",
      "avatar:media/44444444-4444-4444-8444-444444444444",
    ]) {
      const refused = await app.inject({
        method: "PUT",
        url: "/v2/profile",
        headers: putHeaders,
        payload: profile(foreign),
      });
      const body = expectEnvelope(refused, 422, "VALIDATION_FAILED");
      expect(body["detailsSafe"]).toEqual({ reasonCode: "MEDIA_NOT_OWNED" });
    }
    expect(profilesV2.replaceProfile).toHaveBeenCalledTimes(1);

    // A preset stays valid and never touches media storage.
    const preset = await app.inject({
      method: "PUT",
      url: "/v2/profile",
      headers: putHeaders,
      payload: profile("avatar:preset/monogram"),
    });
    expect(preset.statusCode).toBe(200);
  });

  it("keeps the profile write when the Stream sync fails", async () => {
    const dependencies = fakes();
    dependencies.upsertUsers.mockRejectedValue(new Error("stream down"));
    const { app } = await createApp(dependencies);
    const response = await app.inject({
      method: "PUT",
      url: "/v2/profile",
      headers: {
        authorization: "Bearer header.payload.signature",
        "x-loop-client-version": "1.2.3",
        "x-loop-contract-version": "2.0",
      },
      payload: {
        expectedVersion: 1,
        profile: {
          alias: "Alice",
          avatarRef: "avatar:preset/monogram",
          bio: null,
          interests: [],
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(dependencies.upsertUsers).toHaveBeenCalledTimes(1);
  });

  it("does not accept multipart on any other route", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "PUT",
      url: "/v2/profile",
      headers: {
        authorization: "Bearer header.payload.signature",
        "x-loop-client-version": "1.2.3",
        "x-loop-contract-version": "2.0",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: fileBody(jpeg),
    });
    expectEnvelope(response, 400, "INVALID_REQUEST");
  });
});
