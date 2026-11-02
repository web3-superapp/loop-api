import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { FastifyInstance } from "fastify";
import { encodeAbiParameters } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openApiV2ArtifactPath } from "../scripts/generate-openapi.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import type { ProjectNftDirectory } from "../src/features/wallet-intents/intent-preparation.js";
import { nftSendErrorReasonCodes } from "../src/routes/v2/wallet-intents-schemas.js";
import type { BscChainCallClient } from "../src/integrations/bsc/rpc-client.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import {
  accountId,
  controlPlaneFake,
  indexerFake,
  intentRepositoryFake,
  marketFactsFake,
  readClientFake,
  recipientAddress,
  registryFake,
  swapAdapterFake,
  usdtAssetId,
  walletAddress,
  walletId,
  walletsFake,
  wbnbAssetId,
} from "./wallet-intent-fakes.js";

/**
 * Decision 0194 (S339): `POST /v2/wallet-intents/send-nft` and the
 * `includeKinds` opt-in of `GET /v2/wallet-intents` through the real app
 * (headers, schemas, status codes, error envelope), plus the OpenAPI
 * contract the mobile codec is generated against.
 */

const validToken = "header.payload.signature";
const cursorSecret = "0123456789abcdef0123456789abcdef";
const nftAddress = "0x00000000000000000000000000000000000000e7";
const otherOwner = "0x00000000000000000000000000000000000000f1";
const ownerOfSelector = "0x6352211e";

function testConfig(overrides: Readonly<Record<string, string>> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    LOG_LEVEL: "silent",
    V2_MODULES_ENABLED: "chain,wallet,market,swap,sendApprovals",
    V2_CURSOR_HMAC_SECRET: cursorSecret,
    PRIVY_APP_ID: "app_test",
    PRIVY_APP_SECRET: "secret_test",
    BSC_RPC_URLS: "https://rpc-a.example/",
    BSC_WRITES_ENABLED: "true",
    BSC_WRITE_CANARY_ASSETS: `${usdtAssetId},${wbnbAssetId},eip155:56:native`,
    BSC_WRITE_CANARY_MAX_USD: "20",
    LAUNCH_CHAIN_ID: "97",
    LAUNCH_BSC_RPC_URLS: "https://rpc-testnet.example/",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    ...overrides,
  });
}

function headers(command: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${validToken}`,
    "x-loop-client-version": "1.2.3",
    "x-loop-contract-version": "2.0",
    ...(command ? { "idempotency-key": randomUUID() } : {}),
  };
}

function launchClient(owner: { value: string }): BscChainCallClient {
  const base = readClientFake().client;
  return {
    ...base,
    chainId: "eip155:97",
    chainReference: 97,
    confirmations: 5,
    call: (request) =>
      Promise.resolve(
        request.data.startsWith(ownerOfSelector)
          ? {
              status: "passed" as const,
              returnData: encodeAbiParameters(
                [{ type: "address" }],
                [owner.value as `0x${string}`],
              ),
            }
          : { status: "passed" as const, returnData: "0x" as const },
      ),
  };
}

const directory: ProjectNftDirectory = {
  findByContract: ({ chainId, contractAddress }) =>
    Promise.resolve(
      contractAddress === nftAddress
        ? {
            instanceId: "5f1a2b3c-4d5e-4f60-8a71-b2c3d4e5f607",
            chainId,
            nftAddress,
            name: "Loop Cat Project",
            ticker: "LCAT",
          }
        : null,
    ),
};

function database(): Database {
  return {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: controlPlaneFake(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    chainRegistry: registryFake(),
    accountWallets: walletsFake(),
    bscIndexer: indexerFake(),
    walletIntents: intentRepositoryFake(),
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
}

async function nftSendCapability(
  app: FastifyInstance,
): Promise<Record<string, unknown> | undefined> {
  const response = await app.inject({
    method: "GET",
    url: "/v2/meta/capabilities",
  });
  return response
    .json<{ capabilities: Record<string, unknown>[] }>()
    .capabilities.find((row) => row["capabilityId"] === "nftSend");
}

const nftBody = {
  walletId,
  chainId: "eip155:97",
  contractAddress: nftAddress,
  tokenId: "7",
  recipientAddress,
};

describe("POST /v2/wallet-intents/send-nft (Decision 0194)", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(overrides: Readonly<Record<string, string>> = {}) {
    const owner = { value: walletAddress };
    const privyAccessTokenVerifier = {
      verifyAccessToken: vi.fn(() =>
        Promise.resolve({ privyUserId: "did:privy:verified-user" }),
      ),
    } satisfies PrivyAccessTokenVerifier;
    const app = await buildApp({
      config: testConfig(overrides),
      contractSurface: "v2",
      database: database(),
      privyAccessTokenVerifier,
      bscReadClient: readClientFake().client,
      launchChainReadClient: launchClient(owner),
      projectNftDirectory: directory,
      privySwapAdapter: swapAdapterFake().adapter,
      marketFactService: marketFactsFake(),
      logger: false,
    });
    apps.push(app);
    return { app, owner };
  }

  it("is 503 CAPABILITY_UNAVAILABLE / NFT_SEND_DISABLED while NFT_SEND_ENABLED is off (the default)", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send-nft",
      headers: headers(true),
      payload: nftBody,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "CAPABILITY_UNAVAILABLE",
      category: "availability",
      retryable: true,
      userMessageKey: expect.stringMatching(/^errors\./u) as unknown,
      correlationId: expect.any(String) as unknown,
      detailsSafe: { reasonCode: "NFT_SEND_DISABLED" },
      providerReferenceSafe: null,
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(await nftSendCapability(app)).toEqual({
      capabilityId: "nftSend",
      availability: "unavailable",
      reasonCode: "NFT_SEND_DISABLED",
      evidence: { status: "notApplicable", reasonCode: null },
    });
    // The preflight keeps its primary-chain rule.
    const preflight = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send/preflight",
      headers: headers(false),
      payload: { walletId, address: recipientAddress, chainId: "eip155:97" },
    });
    expect(preflight.statusCode).toBe(422);
    expect(preflight.json<{ code: string }>().code).toBe("CHAIN_MISMATCH");
  });

  it("creates (201), replays (200), conflicts (409), and refuses with the reason codes", async () => {
    const { app, owner } = await createApp({ NFT_SEND_ENABLED: "on" });
    expect(await nftSendCapability(app)).toMatchObject({
      availability: "available",
      reasonCode: null,
    });
    const { app: noWrites } = await createApp({
      NFT_SEND_ENABLED: "on",
      BSC_WRITES_ENABLED: "false",
      BSC_WRITE_CANARY_ASSETS: "",
    });
    expect(await nftSendCapability(noWrites)).toMatchObject({
      availability: "unavailable",
      reasonCode: "BSC_WRITES_DISABLED",
    });
    const key = randomUUID();
    const send = (payload: unknown, idempotencyKey = randomUUID()) =>
      app.inject({
        method: "POST",
        url: "/v2/wallet-intents/send-nft",
        headers: { ...headers(true), "idempotency-key": idempotencyKey },
        payload: payload as Record<string, unknown>,
      });
    const created = await send(nftBody, key);
    expect(created.statusCode).toBe(201);
    const intent = created.json<Record<string, unknown>>();
    expect(intent).toMatchObject({
      kind: "send_nft",
      chainId: "eip155:97",
      state: "awaiting_signature",
      review: {
        kind: "send_nft",
        asset: { assetId: `eip155:97:${nftAddress}`, decimals: 0 },
        decodedCall: {
          functionName: "safeTransferFrom",
          selector: "0x42842e0e",
          args: {
            from: walletAddress,
            to: recipientAddress,
            tokenId: "7",
          },
        },
        nft: {
          contractAddress: nftAddress,
          tokenId: "7",
          projectName: "Loop Cat Project",
        },
      },
      unsignedTransaction: { chainId: 97, to: nftAddress },
      contractVersion: "2.0",
    });
    const replay = await send(nftBody, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ intentId: string }>().intentId).toBe(
      intent["intentId"],
    );
    const conflict = await send({ ...nftBody, tokenId: "8" }, key);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ code: string }>().code).toBe("IDEMPOTENCY_CONFLICT");

    const reasonOf = async (payload: unknown) => {
      const response = await send(payload);
      return `${response.statusCode}:${response.json<{ code: string }>().code}:${String(
        response.json<{ detailsSafe: { reasonCode?: string } | null }>()
          .detailsSafe?.reasonCode,
      )}`;
    };
    expect(
      await reasonOf({
        ...nftBody,
        contractAddress: "0x00000000000000000000000000000000000000e8",
      }),
    ).toBe("422:VALIDATION_FAILED:NFT_CONTRACT_UNSUPPORTED");
    expect(
      await reasonOf({ ...nftBody, recipientAddress: walletAddress }),
    ).toBe("422:VALIDATION_FAILED:RECIPIENT_SELF");
    expect(await reasonOf({ ...nftBody, chainId: "eip155:56" })).toBe(
      "422:CHAIN_MISMATCH:undefined",
    );
    owner.value = otherOwner;
    expect(await reasonOf(nftBody)).toBe("422:VALIDATION_FAILED:NFT_NOT_OWNED");
    // Schema: tokenId is a decimal string, every field required, nothing extra.
    for (const payload of [
      { ...nftBody, tokenId: 7 },
      { ...nftBody, tokenId: "0x7" },
      { ...nftBody, extra: true },
      { walletId, chainId: "eip155:97", contractAddress: nftAddress },
    ]) {
      expect((await send(payload)).statusCode).toBe(400);
    }
    // The command headers are enforced like every other prepare.
    const noKey = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send-nft",
      headers: headers(false),
      payload: nftBody,
    });
    expect(noKey.statusCode).toBe(400);
  });

  it("lists send_nft only for a client that opts in with includeKinds", async () => {
    const { app } = await createApp({ NFT_SEND_ENABLED: "on" });
    const created = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send-nft",
      headers: headers(true),
      payload: nftBody,
    });
    expect(created.statusCode).toBe(201);
    const plain = await app.inject({
      method: "GET",
      url: "/v2/wallet-intents",
      headers: headers(false),
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.json<{ items: unknown[] }>().items).toEqual([]);
    const opted = await app.inject({
      method: "GET",
      url: "/v2/wallet-intents?includeKinds=send_nft",
      headers: headers(false),
    });
    expect(opted.statusCode).toBe(200);
    expect(
      opted.json<{ items: { kind: string }[] }>().items.map((i) => i.kind),
    ).toEqual(["send_nft"]);
    const bad = await app.inject({
      method: "GET",
      url: "/v2/wallet-intents?includeKinds=swap",
      headers: headers(false),
    });
    expect(bad.statusCode).toBe(400);
    // The intent itself reads back by ID.
    const read = await app.inject({
      method: "GET",
      url: `/v2/wallet-intents/${String(created.json<{ intentId: string }>().intentId)}`,
      headers: headers(false),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ kind: string }>().kind).toBe("send_nft");
  });

  it("publishes the route, the opt-in, and the new enum values in the OpenAPI artifact", async () => {
    const document = JSON.parse(
      await readFile(openApiV2ArtifactPath, "utf8"),
    ) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const operation = document.paths["/v2/wallet-intents/send-nft"]?.["post"];
    expect(operation?.["operationId"]).toBe("prepareV2SendNftIntent");
    const requestSchema = (
      operation?.["requestBody"] as {
        content: Record<string, { schema: Record<string, unknown> }>;
      }
    ).content["application/json"]?.schema;
    expect(requestSchema?.["required"]).toEqual([
      "walletId",
      "chainId",
      "contractAddress",
      "tokenId",
      "recipientAddress",
    ]);
    expect(requestSchema?.["additionalProperties"]).toBe(false);
    expect(Object.keys(operation?.["responses"] ?? {}).sort()).toEqual([
      "200",
      "201",
      "400",
      "401",
      "403",
      "404",
      "409",
      "422",
      "500",
      "503",
    ]);
    const created = JSON.stringify(
      (operation?.["responses"] as Record<string, unknown>)["201"],
    );
    expect(created).toContain('"send_nft"');
    expect(created).toContain('"safeTransferFrom"');
    const list = document.paths["/v2/wallet-intents"]?.["get"];
    expect(
      (list?.["parameters"] as { name: string; in: string }[]).some(
        (parameter) =>
          parameter.name === "includeKinds" && parameter.in === "query",
      ),
    ).toBe(true);
    expect(nftSendErrorReasonCodes).toEqual([
      "NFT_NOT_OWNED",
      "NFT_CONTRACT_UNSUPPORTED",
      "NFT_RECIPIENT_REJECTS",
      "RECIPIENT_SELF",
      "NFT_SEND_DISABLED",
      "NFT_SEND_CHAIN_UNAVAILABLE",
    ]);
  });
});
