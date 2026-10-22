import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";

import { buildApp } from "../src/app.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import {
  createHooksLaunchProjectConfigService,
  type HooksLaunchProjectConfigRecord,
  type HooksLaunchProjectConfigRepository,
} from "../src/features/launch/hooks-launch-project-config.js";
import {
  launch2NftFallbackDescription,
  launch2NftMetadataOf,
} from "../src/features/launch2/launch2-nft-metadata.js";
import type { Launch2PositionRecord } from "../src/features/launch2/launch2-ports.js";
import { launch2NftMetadataCacheControl } from "../src/routes/v2/launch2.js";
import {
  createFakeLaunch2Chain,
  createInMemoryLaunch2Repository,
  defaultChainState,
  instanceFixture,
  launch2Env,
  launch2NowSeconds,
} from "./helpers/launch2-fakes.js";
import { walletAddress, walletsFake } from "./helpers/launch-service-fakes.js";
import {
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0173 (S274): the project NFT picture — the optional
 * `nftImageAssetUrl` on the Hooks launch draft, the gated `nftImageUrl`
 * projection, and the public ERC-721 metadata route.
 */

const draft = {
  name: "LOOP 项目示例",
  ticker: "MEME",
  logoAssetUrl: "https://cdn.example.com/logo.png",
  description: "Project description",
  links: ["https://example.com", "https://x.com/loop"],
  nftSaleStartAt: "1800000000",
  buybackRecipient: "0x1234567890123456789012345678901234567890",
};

const policy = {
  nowUnixSeconds: "1790000000",
  minimumLeadSeconds: 86_400,
  nftSaleDurationSeconds: 604_800,
};

// The pre-S141 golden value of this fixture (test/hooks-launch-config.test.ts).
const goldenConfigHash =
  "0x9b16d09ef2d8725d7061d4876d80cbad80054d771b1a483810f232f53b3ab948";

const nftCid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const nftImage = `https://ipfs.filebase.io/ipfs/${nftCid}`;

describe("Hooks launch draft nftImageAssetUrl (Decision 0173)", () => {
  it("keeps a draft without the key byte-identical: no key, the golden configHash", () => {
    const parsed = parseHooksLaunchDraft(draft, policy);
    expect(parsed.configHash).toBe(goldenConfigHash);
    expect(Object.keys(parsed)).not.toContain("nftImageAssetUrl");
  });

  it("stores the normalized picture and appends it to the signed tuple", () => {
    const parsed = parseHooksLaunchDraft(
      { ...draft, nftImageAssetUrl: nftImage },
      policy,
    );
    expect(parsed.nftImageAssetUrl).toBe(nftImage);
    expect(parsed).not.toHaveProperty("nftImageCid");
    // The resolved CID rides along, outside the hash.
    const withCid = parseHooksLaunchDraft(
      { ...draft, nftImageAssetUrl: nftImage },
      { ...policy, nftImageCid: nftCid },
    );
    expect(withCid.nftImageCid).toBe(nftCid);
    expect(withCid.configHash).toBe(parsed.configHash);
    // A client cannot send the CID itself.
    expect(() =>
      parseHooksLaunchDraft(
        { ...draft, nftImageAssetUrl: nftImage, nftImageCid: nftCid } as never,
        policy,
      ),
    ).toThrow("Invalid Hooks launch draft");
    expect(parsed.logoAssetUrl).toBe(draft.logoAssetUrl);
    expect(parsed.configHash).not.toBe(goldenConfigHash);
    const expected = keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          "bytes32 templateHash, string name, string ticker, string logoAssetUrl, string description, bytes32 linksHash, uint64 nftSaleStartAt, address buybackRecipient, bytes32 fixedEconomicsHash, string nftImageAssetUrl",
        ),
        [
          parsed.templateHash as `0x${string}`,
          parsed.name,
          parsed.ticker,
          parsed.logoAssetUrl,
          parsed.description,
          keccak256(new TextEncoder().encode(JSON.stringify(parsed.links))),
          BigInt(parsed.nftSaleStartAt),
          parsed.buybackRecipient as `0x${string}`,
          keccak256(
            new TextEncoder().encode(JSON.stringify(parsed.fixedEconomics)),
          ),
          nftImage,
        ],
      ),
    );
    expect(parsed.configHash).toBe(expected);
    // A different picture is a different signed config.
    expect(
      parseHooksLaunchDraft(
        { ...draft, nftImageAssetUrl: `${nftImage}?v=2` },
        policy,
      ).configHash,
    ).not.toBe(parsed.configHash);
  });

  it("applies the logo rule: https only, no credentials, a string, at most 2048", () => {
    for (const value of [
      "http://cdn.example.com/nft.png",
      "https://user:pass@cdn.example.com/nft.png",
      "javascript:alert(1)",
      "",
      "not a url",
      `https://cdn.example.com/${"a".repeat(2_048)}`,
      42,
      null,
    ]) {
      expect(
        () =>
          parseHooksLaunchDraft(
            {
              ...draft,
              nftImageAssetUrl: value as unknown as string,
            },
            policy,
          ),
        String(value),
      ).toThrow("Invalid Hooks launch draft");
    }
  });
});

describe("launch2NftMetadataOf (Decision 0173)", () => {
  const base = instanceFixture({ name: "Frog Launch", ticker: "FROG" });

  it("prefers ipfs:// of the pinned picture, then its URL, then the logo, then null", () => {
    expect(
      launch2NftMetadataOf(
        { ...base, nftImageUrl: nftImage, nftImageCid: nftCid },
        2,
        "nft_sale",
      ),
    ).toEqual({
      name: "Frog Launch #2",
      description: "A frog launch.",
      image: `ipfs://${nftCid}`,
      image_gateway: nftImage,
      attributes: [
        { trait_type: "Project", value: "FROG" },
        { trait_type: "Token ID", value: 2 },
        { trait_type: "Stage", value: "nft_sale" },
      ],
    });
    const local = "https://api.example.com/v2/media/x.webp";
    expect(
      launch2NftMetadataOf({ ...base, nftImageUrl: local }, 1, "public"),
    ).toMatchObject({ image: local, image_gateway: local });
    expect(launch2NftMetadataOf(base, 1, "public")).toMatchObject({
      image: "https://example.com/frog.png",
      image_gateway: "https://example.com/frog.png",
    });
    expect(
      launch2NftMetadataOf({ ...base, logoUrl: null }, 1, "public"),
    ).toMatchObject({ image: null, image_gateway: null });
  });

  it("falls back to the fixed sentence without a description", () => {
    for (const projectProfile of [
      null,
      { description: null, links: [] },
      { description: "   ", links: [] },
    ]) {
      expect(
        launch2NftMetadataOf({ ...base, projectProfile }, 1, "public")
          .description,
      ).toBe(launch2NftFallbackDescription);
    }
  });
});

describe("launch2 nftImageUrl projection and NFT metadata route (Decision 0173)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    repository: ReturnType<typeof createInMemoryLaunch2Repository>,
    emit: "on" | "off" | "unset",
  ) {
    const app = await buildApp({
      config: s7TestConfig({
        ...launch2Env,
        ...(emit === "unset" ? {} : { LAUNCH2_NFT_IMAGE_EMIT: emit }),
      }),
      contractSurface: "v2",
      database: {
        ...s7Database({}),
        launch2: repository,
        accountWallets: walletsFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      launch2Chain: createFakeLaunch2Chain(defaultChainState()),
      walletIntentNow: () => new Date(Number(launch2NowSeconds) * 1000),
      logger: false,
    });
    apps.push(app);
    return app;
  }

  function position(instanceId: string): Launch2PositionRecord {
    return {
      instanceId,
      holderAddress: walletAddress,
      nftMintedTokenId: "1",
      nftHeld: 1,
      curveBought: "0",
      curveSold: "0",
      cumulativeBought: "0",
      usd1Spent: "0",
      usd1Received: "0",
      taxUsd1: "0",
      buyCount: 0,
      sellCount: 0,
      snapshotMember: false,
      lastActivityAt: null,
    };
  }

  function seeded() {
    const repository = createInMemoryLaunch2Repository();
    const withImage = instanceFixture({
      nftImageUrl: nftImage,
      nftImageCid: nftCid,
      launchId: `0x${"ab".repeat(32)}`,
      nftMintedCount: "3",
    });
    const without = instanceFixture({
      launchId: `0x${"cd".repeat(32)}`,
      nftMintedCount: "1",
    });
    for (const row of [withImage, without]) {
      repository.instances.set(row.instanceId, row);
      repository.positions.push(position(row.instanceId));
    }
    return { repository, withImage, without };
  }

  const get = (app: FastifyInstance, url: string) =>
    app.inject({ method: "GET", url, headers: s7CommonHeaders() });

  for (const emit of ["unset", "off"] as const) {
    it(`omits the nftImageUrl key everywhere while LAUNCH2_NFT_IMAGE_EMIT is ${emit}`, async () => {
      const { repository, withImage } = seeded();
      const app = await createApp(repository, emit);
      const list = await get(app, "/v2/launch2/instances");
      expect(list.statusCode).toBe(200);
      const items = list.json<{ instances: Record<string, unknown>[] }>()
        .instances;
      expect(items).toHaveLength(2);
      for (const item of items) expect(item).not.toHaveProperty("nftImageUrl");
      const detail = await get(
        app,
        `/v2/launch2/instances/${withImage.instanceId}`,
      );
      expect(detail.statusCode).toBe(200);
      expect(
        detail.json<{ instance: Record<string, unknown> }>().instance,
      ).not.toHaveProperty("nftImageUrl");
      const positions = await get(app, "/v2/launch2/me/positions");
      expect(positions.statusCode).toBe(200);
      const rows = positions.json<{ positions: Record<string, unknown>[] }>()
        .positions;
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row).not.toHaveProperty("nftImageUrl");
    });
  }

  it("emits nftImageUrl (string or null) on the summary, detail and positions when on", async () => {
    const { repository, withImage, without } = seeded();
    const app = await createApp(repository, "on");
    const list = await get(app, "/v2/launch2/instances");
    const byId = new Map(
      list
        .json<{ instances: { instanceId: string; nftImageUrl?: unknown }[] }>()
        .instances.map((row) => [row.instanceId, row]),
    );
    expect(byId.get(withImage.instanceId)?.nftImageUrl).toBe(nftImage);
    expect(byId.get(without.instanceId)).toHaveProperty("nftImageUrl", null);
    const detail = await get(
      app,
      `/v2/launch2/instances/${withImage.instanceId}`,
    );
    expect(
      detail.json<{ instance: { nftImageUrl?: unknown; logoUrl: unknown } }>()
        .instance,
    ).toMatchObject({
      nftImageUrl: nftImage,
      logoUrl: "https://example.com/frog.png",
    });
    const positions = await get(app, "/v2/launch2/me/positions");
    const rows = new Map(
      positions
        .json<{ positions: { instanceId: string; nftImageUrl?: unknown }[] }>()
        .positions.map((row) => [row.instanceId, row]),
    );
    expect(rows.get(withImage.instanceId)?.nftImageUrl).toBe(nftImage);
    expect(rows.get(without.instanceId)).toHaveProperty("nftImageUrl", null);
  });

  it("serves the public ERC-721 metadata without auth or LOOP headers, CDN-cacheable", async () => {
    const { repository, withImage, without } = seeded();
    const app = await createApp(repository, "unset");
    const response = await app.inject({
      method: "GET",
      url: `/v2/launch2/nft/${withImage.launchId.toUpperCase().replace("0X", "0x")}/3`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(
      launch2NftMetadataCacheControl,
    );
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.json()).toEqual({
      name: "Frog Launch #3",
      description: "A frog launch.",
      image: `ipfs://${nftCid}`,
      image_gateway: nftImage,
      attributes: [
        { trait_type: "Project", value: "FROG" },
        { trait_type: "Token ID", value: 3 },
        { trait_type: "Stage", value: withImage.stage },
      ],
    });
    // Without a picture the logo stands in.
    const fallback = await app.inject({
      method: "GET",
      url: `/v2/launch2/nft/${without.launchId}/1`,
    });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json<{ image: unknown }>().image).toBe(
      "https://example.com/frog.png",
    );
  });

  it("answers 404 for an unknown launch id or an unminted token, 400 for a malformed path", async () => {
    const { repository, withImage } = seeded();
    const app = await createApp(repository, "unset");
    const unknown = await app.inject({
      method: "GET",
      url: `/v2/launch2/nft/0x${"ef".repeat(32)}/1`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({
      code: "NOT_FOUND",
      detailsSafe: { reasonCode: "LAUNCH2_INSTANCE_NOT_FOUND" },
    });
    expect(unknown.headers["cache-control"]).toBe("no-store");
    const unminted = await app.inject({
      method: "GET",
      url: `/v2/launch2/nft/${withImage.launchId}/4`,
    });
    expect(unminted.statusCode).toBe(404);
    expect(unminted.json()).toMatchObject({
      code: "NOT_FOUND",
      detailsSafe: { reasonCode: "LAUNCH2_NFT_NOT_MINTED" },
    });
    for (const path of [
      `${withImage.launchId}/0`,
      `${withImage.launchId}/01`,
      `${withImage.launchId}/abc`,
      `0x1234/1`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/v2/launch2/nft/${path}`,
      });
      expect(response.statusCode, path).toBe(400);
    }
    const query = await app.inject({
      method: "GET",
      url: `/v2/launch2/nft/${withImage.launchId}/1?x=1`,
    });
    expect(query.statusCode).toBe(400);
  });
});

describe("Hooks config save resolves nftImageAssetUrl (Decision 0173)", () => {
  const projectId = "00000000-0000-4000-8000-000000000001";
  const ownerUserId = "user-1";

  function harness(
    nftImages: Parameters<
      typeof createHooksLaunchProjectConfigService
    >[0]["nftImages"],
  ) {
    let record: HooksLaunchProjectConfigRecord | null = null;
    const repository: HooksLaunchProjectConfigRepository = {
      getOwnedDraft: () => Promise.resolve(record),
      saveOwnedDraft(input) {
        record = Object.freeze({
          ...input,
          version: (record?.version ?? 0) + 1,
          updatedAt: "2026-10-22T00:00:00.000Z",
        });
        return Promise.resolve(record);
      },
      getOwnedProgress: () =>
        Promise.resolve({
          approvedAt: null,
          rejection: null,
          latestJobId: null,
        }),
    };
    return createHooksLaunchProjectConfigService({
      fixedBuybackRecipient: draft.buybackRecipient,
      repository,
      factory: {
        nftSaleDuration: () =>
          Promise.resolve({ seconds: 604_800, legacy: false }),
      },
      minimumLeadSeconds: 86_400,
      now: () => 1_790_000_000,
      ...(nftImages === undefined ? {} : { nftImages }),
    });
  }

  it("stores the canonical gateway URL and the CID for the owner's upload", async () => {
    const resolveProjectNftImage = vi.fn(() =>
      Promise.resolve({ url: nftImage, cid: nftCid }),
    );
    const saved = await harness({ resolveProjectNftImage }).saveDraft({
      ownerUserId,
      projectId,
      expectedVersion: 0,
      body: {
        ...draft,
        nftImageAssetUrl: "https://api.example/v2/media/x.webp",
      },
    });
    expect(resolveProjectNftImage).toHaveBeenCalledWith({
      ownerUserId,
      url: "https://api.example/v2/media/x.webp",
    });
    expect(saved.config.nftImageAssetUrl).toBe(nftImage);
    expect(saved.config.nftImageCid).toBe(nftCid);
    expect(saved.config.configHash).toBe(
      parseHooksLaunchDraft({ ...draft, nftImageAssetUrl: nftImage }, policy)
        .configHash,
    );
  });

  it("does not resolve anything for a draft without the key, and keeps the golden hash", async () => {
    const resolveProjectNftImage = vi.fn();
    const saved = await harness({ resolveProjectNftImage }).saveDraft({
      ownerUserId,
      projectId,
      expectedVersion: 0,
      body: draft,
    });
    expect(resolveProjectNftImage).not.toHaveBeenCalled();
    expect(saved.config.configHash).toBe(goldenConfigHash);
    expect(saved.config).not.toHaveProperty("nftImageAssetUrl");
  });

  it("passes a foreign upload's refusal through and fails closed without media", async () => {
    const refusal = new Error("MEDIA_NOT_OWNED");
    await expect(
      harness({
        resolveProjectNftImage: () => Promise.reject(refusal),
      }).saveDraft({
        ownerUserId,
        projectId,
        expectedVersion: 0,
        body: { ...draft, nftImageAssetUrl: nftImage },
      }),
    ).rejects.toBe(refusal);
    await expect(
      harness(null).saveDraft({
        ownerUserId,
        projectId,
        expectedVersion: 0,
        body: { ...draft, nftImageAssetUrl: nftImage },
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });
});
