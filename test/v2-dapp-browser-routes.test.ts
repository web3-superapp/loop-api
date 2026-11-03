import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { FastifyInstance } from "fastify";
import { encodeFunctionData, maxUint256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
import { dappRpcReadMethods } from "../src/features/dapp-browser/rpc-read-service.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import type { DappContractDirectory } from "../src/features/wallet-intents/intent-preparation.js";
import {
  BscReadUnavailableError,
  type BscChainCallClient,
  type BscRelayReadOutcome,
} from "../src/integrations/bsc/rpc-client.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import { dappBrowserErrorReasonCodes } from "../src/routes/v2/dapp-browser-schemas.js";
import {
  accountId,
  controlPlaneFake,
  embeddedWallet,
  externalWallet,
  indexerFake,
  intentRepositoryFake,
  marketFactsFake,
  readClientFake,
  registryFake,
  swapAdapterFake,
  usdtAssetId,
  walletId,
  walletsFake,
  wbnbAssetId,
} from "./wallet-intent-fakes.js";

/**
 * Decision 0197 (S342): the DApp browser routes through the real app —
 * `POST /v2/wallet-intents/dapp-tx`, `/dapp-sign`,
 * `/{intentId}/signature-report` and `POST /v2/chain/rpc-read` (headers,
 * schemas, status codes, the seven-field error envelope, the switch, the
 * capability, the opt-in list) plus the OpenAPI artifact.
 */

const validToken = "header.payload.signature";
const cursorSecret = "0123456789abcdef0123456789abcdef";
const token = "0x00000000000000000000000000000000000000d1";
const spender = "0x00000000000000000000000000000000000000c3";
const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const signer = account.address.toLowerCase();

const approveUnlimited = encodeFunctionData({
  abi: parseAbi(["function approve(address spender, uint256 amount)"]),
  functionName: "approve",
  args: [spender, maxUint256],
});

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

interface RelayControl {
  outcome: BscRelayReadOutcome | "throw";
  readonly calls: { method: string; params: readonly unknown[] }[];
}

function launchClient(relay: RelayControl | null): BscChainCallClient {
  const base = readClientFake({ code: { [token]: "0x60" } }).client;
  return {
    ...base,
    chainId: "eip155:97",
    chainReference: 97,
    confirmations: 5,
    ...(relay === null
      ? {}
      : {
          relayRead: (method: string, params: readonly unknown[]) => {
            relay.calls.push({ method, params });
            return relay.outcome === "throw"
              ? Promise.reject(
                  new BscReadUnavailableError("BSC_RPC_UNREACHABLE"),
                )
              : Promise.resolve(relay.outcome);
          },
        }),
  };
}

const directory: DappContractDirectory = {
  classify: () => Promise.resolve(null),
};

function database(
  walletIntents: ReturnType<
    typeof intentRepositoryFake
  > = intentRepositoryFake(),
): Database {
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
    accountWallets: walletsFake([
      { ...embeddedWallet, address: signer },
      externalWallet,
    ]),
    bscIndexer: indexerFake(),
    walletIntents,
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

const txBody = {
  walletId,
  chainId: "eip155:97",
  origin: "https://App.Example.org",
  tx: { to: token, data: approveUnlimited, value: "0x0" },
};

const signBody = {
  walletId,
  chainId: "eip155:97",
  origin: "https://app.example.org",
  method: "personal_sign",
  payload: "Sign in to example.org",
};

describe("DApp browser routes (Decision 0197)", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    overrides: Readonly<Record<string, string>> = {},
    relay: RelayControl | null = {
      outcome: { status: "result", result: "0x2a" },
      calls: [],
    },
    walletIntents = intentRepositoryFake(),
  ) {
    const privyAccessTokenVerifier = {
      verifyAccessToken: vi.fn(() =>
        Promise.resolve({ privyUserId: "did:privy:verified-user" }),
      ),
    } satisfies PrivyAccessTokenVerifier;
    const primary = readClientFake().client;
    const app = await buildApp({
      config: testConfig(overrides),
      contractSurface: "v2",
      database: database(walletIntents),
      privyAccessTokenVerifier,
      bscReadClient:
        relay === null
          ? primary
          : {
              ...primary,
              relayRead: (method: string, params: readonly unknown[]) => {
                relay.calls.push({ method, params });
                return relay.outcome === "throw"
                  ? Promise.reject(
                      new BscReadUnavailableError("BSC_RPC_UNREACHABLE"),
                    )
                  : Promise.resolve(relay.outcome);
              },
            },
      launchChainReadClient: launchClient(relay),
      dappContractDirectory: directory,
      privySwapAdapter: swapAdapterFake().adapter,
      marketFactService: marketFactsFake(),
      logger: false,
    });
    apps.push(app);
    return app;
  }

  async function capability(app: FastifyInstance) {
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    return response
      .json<{ capabilities: Record<string, unknown>[] }>()
      .capabilities.find((row) => row["capabilityId"] === "dappBrowser");
  }

  const reasonOf = (response: {
    statusCode: number;
    json: <T>() => T;
  }): string =>
    `${String(response.statusCode)}:${response.json<{ code: string }>().code}:${String(
      response.json<{ detailsSafe: { reasonCode?: string } | null }>()
        .detailsSafe?.reasonCode,
    )}`;

  it("answers 503 DAPP_BROWSER_DISABLED on all three routes while the switch is off (the default)", async () => {
    const app = await createApp();
    for (const [url, payload, command] of [
      ["/v2/wallet-intents/dapp-tx", txBody, true],
      ["/v2/wallet-intents/dapp-sign", signBody, true],
      [
        "/v2/chain/rpc-read",
        { chainId: "eip155:97", method: "eth_blockNumber" },
        false,
      ],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: headers(command),
        payload,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: "CAPABILITY_UNAVAILABLE",
        category: "availability",
        retryable: true,
        userMessageKey: expect.stringMatching(/^errors\./u) as unknown,
        correlationId: expect.any(String) as unknown,
        detailsSafe: { reasonCode: "DAPP_BROWSER_DISABLED" },
        providerReferenceSafe: null,
      });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(await capability(app)).toEqual({
      capabilityId: "dappBrowser",
      availability: "unavailable",
      reasonCode: "DAPP_BROWSER_DISABLED",
      evidence: { status: "notApplicable", reasonCode: null },
    });
  });

  it("reports the capability per missing piece", async () => {
    expect(
      await capability(await createApp({ DAPP_BROWSER_ENABLED: "on" })),
    ).toMatchObject({ availability: "available", reasonCode: null });
    expect(
      await capability(
        await createApp({
          DAPP_BROWSER_ENABLED: "on",
          BSC_WRITES_ENABLED: "false",
          BSC_WRITE_CANARY_ASSETS: "",
        }),
      ),
    ).toMatchObject({
      availability: "unavailable",
      reasonCode: "BSC_WRITES_DISABLED",
    });
    const mainnetSlot = await createApp({
      DAPP_BROWSER_ENABLED: "on",
      LAUNCH_CHAIN_ID: "56",
      LAUNCH_BSC_RPC_URLS: "",
    });
    expect(await capability(mainnetSlot)).toMatchObject({
      availability: "unavailable",
      reasonCode: "DAPP_BROWSER_CHAIN_UNAVAILABLE",
    });
    const refused = await mainnetSlot.inject({
      method: "POST",
      url: "/v2/wallet-intents/dapp-tx",
      headers: headers(true),
      payload: { ...txBody, chainId: "eip155:56" },
    });
    expect(reasonOf(refused)).toBe(
      "422:VALIDATION_FAILED:CHAIN_SIGNING_DISABLED",
    );
  });

  it("creates (201), replays (200), conflicts (409) a dapp_tx and refuses with the envelope", async () => {
    const app = await createApp({ DAPP_BROWSER_ENABLED: "on" });
    const key = randomUUID();
    const send = (payload: unknown, idempotencyKey = randomUUID()) =>
      app.inject({
        method: "POST",
        url: "/v2/wallet-intents/dapp-tx",
        headers: { ...headers(true), "idempotency-key": idempotencyKey },
        payload: payload as Record<string, unknown>,
      });
    const created = await send(txBody, key);
    expect(created.statusCode).toBe(201);
    const intent = created.json<Record<string, unknown>>();
    expect(intent).toMatchObject({
      kind: "dapp_tx",
      chainId: "eip155:97",
      state: "awaiting_signature",
      review: {
        kind: "dapp_tx",
        decodedCall: null,
        dapp: {
          origin: "https://app.example.org",
          method: "eth_sendTransaction",
          to: { address: token, isContract: true, isVerified: false },
          decodedCall: {
            functionName: "approve",
            standard: "erc20",
            args: { spender, amount: maxUint256.toString(10) },
          },
          counterparty: { address: spender, role: "spender" },
          riskFlags: [
            "UNLIMITED_APPROVAL",
            "EOA_SPENDER",
            "UNVERIFIED_CONTRACT",
          ],
        },
      },
      unsignedTransaction: { chainId: 97, to: token, data: approveUnlimited },
      contractVersion: "2.0",
    });
    expect(intent).not.toHaveProperty("signatureRequest");
    const replay = await send(txBody, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ intentId: string }>().intentId).toBe(
      intent["intentId"],
    );
    const conflict = await send(
      { ...txBody, tx: { ...txBody.tx, value: "0x1" } },
      key,
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ code: string }>().code).toBe("IDEMPOTENCY_CONFLICT");
    const mainnet = await send({ ...txBody, chainId: "eip155:56" });
    expect(reasonOf(mainnet)).toBe(
      "422:VALIDATION_FAILED:CHAIN_SIGNING_DISABLED",
    );
    expect(Object.keys(mainnet.json<Record<string, unknown>>()).sort()).toEqual(
      [
        "category",
        "code",
        "correlationId",
        "detailsSafe",
        "providerReferenceSafe",
        "retryable",
        "userMessageKey",
      ],
    );
    expect(
      reasonOf(await send({ ...txBody, origin: "http://app.example.org" })),
    ).toBe("422:VALIDATION_FAILED:ORIGIN_NOT_HTTPS");
    expect(reasonOf(await send({ ...txBody, chainId: "eip155:1" }))).toBe(
      "422:CHAIN_MISMATCH:undefined",
    );
    for (const payload of [
      { ...txBody, extra: true },
      { ...txBody, tx: { ...txBody.tx, value: 1 } },
      { ...txBody, tx: { ...txBody.tx, value: "1" } },
      { ...txBody, tx: { ...txBody.tx, data: "0x1" } },
      { ...txBody, tx: { ...txBody.tx, gas: "0x5208" } },
      { ...txBody, tx: { data: "0x" } },
      { walletId, chainId: "eip155:97", origin: txBody.origin },
    ]) {
      expect((await send(payload)).statusCode).toBe(400);
    }
    const noKey = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/dapp-tx",
      headers: headers(false),
      payload: txBody,
    });
    expect(noKey.statusCode).toBe(400);
    const noAuth = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/dapp-tx",
      headers: { ...headers(true), authorization: "" },
      payload: txBody,
    });
    expect(noAuth.statusCode).toBe(401);
  });

  it("prepares a dapp_sign, closes it with a verified signature report, and lists DApp kinds only on opt-in", async () => {
    const app = await createApp({ DAPP_BROWSER_ENABLED: "on" });
    const created = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/dapp-sign",
      headers: headers(true),
      payload: signBody,
    });
    expect(created.statusCode).toBe(201);
    const intent = created.json<{
      intentId: string;
      signatureRequest: unknown;
    }>();
    expect(intent).toMatchObject({
      kind: "dapp_sign",
      state: "awaiting_signature",
      signing: { mode: "device_personal_sign", allowed: true },
      simulation: { status: "unavailable", source: "not_applicable" },
      signatureRequest: {
        method: "personal_sign",
        params: ["Sign in to example.org", signer],
      },
      review: {
        dapp: {
          method: "personal_sign",
          message: { encoding: "utf8", text: "Sign in to example.org" },
          riskFlags: [],
        },
      },
    });
    const typed = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/dapp-sign",
      headers: headers(true),
      payload: {
        ...signBody,
        method: "eth_signTypedData_v4",
        payload: JSON.stringify({
          types: { Permit: [{ name: "value", type: "uint256" }] },
          primaryType: "Permit",
          domain: { name: "X", chainId: 56 },
          message: { value: "1" },
        }),
      },
    });
    expect(reasonOf(typed)).toBe(
      "422:VALIDATION_FAILED:TYPED_DATA_CHAIN_MISMATCH",
    );
    for (const payload of [
      { ...signBody, method: "eth_sign" },
      { ...signBody, method: "eth_signTransaction" },
      { ...signBody, payload: "" },
      { ...signBody, extra: 1 },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/v2/wallet-intents/dapp-sign",
        headers: headers(true),
        payload,
      });
      expect(response.statusCode).toBe(400);
    }

    const report = (signature: string) =>
      app.inject({
        method: "POST",
        url: `/v2/wallet-intents/${intent.intentId}/signature-report`,
        headers: headers(true),
        payload: { signature },
      });
    const wrong = await report(
      await account.signMessage({ message: "something else" }),
    );
    expect(reasonOf(wrong)).toBe("422:VALIDATION_FAILED:SIGNATURE_MISMATCH");
    expect((await report("0x1234")).statusCode).toBe(400);
    const confirmed = await report(
      await account.signMessage({ message: "Sign in to example.org" }),
    );
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      state: "confirmed",
      kind: "dapp_sign",
      result: { transactionHash: null },
    });

    const plain = await app.inject({
      method: "GET",
      url: "/v2/wallet-intents",
      headers: headers(false),
    });
    expect(plain.json<{ items: unknown[] }>().items).toEqual([]);
    const opted = await app.inject({
      method: "GET",
      url: "/v2/wallet-intents?includeKinds=dapp_tx,dapp_sign",
      headers: headers(false),
    });
    expect(opted.statusCode).toBe(200);
    expect(
      opted.json<{ items: { kind: string }[] }>().items.map((i) => i.kind),
    ).toEqual(["dapp_sign"]);
    const read = await app.inject({
      method: "GET",
      url: `/v2/wallet-intents/${intent.intentId}`,
      headers: headers(false),
    });
    expect(read.json<{ signatureRequest: unknown }>().signatureRequest).toEqual(
      intent.signatureRequest,
    );
  });

  it("proxies whitelisted reads on 56 and the slot with strict params, span ceiling and rate limit", async () => {
    const relay: RelayControl = {
      outcome: { status: "result", result: "0x2a" },
      calls: [],
    };
    const app = await createApp(
      { DAPP_BROWSER_ENABLED: "on", DAPP_RPC_READ_PER_MINUTE: "40" },
      relay,
    );
    const read = (payload: unknown, command = false) =>
      app.inject({
        method: "POST",
        url: "/v2/chain/rpc-read",
        headers: headers(command),
        payload: payload as Record<string, unknown>,
      });
    const chainId = await read({ chainId: "eip155:97", method: "eth_chainId" });
    expect(chainId.statusCode).toBe(200);
    expect(chainId.json()).toEqual({
      chainId: "eip155:97",
      method: "eth_chainId",
      result: "0x61",
      error: null,
      contractVersion: "2.0",
    });
    expect(chainId.headers["cache-control"]).toBe("no-store");
    const call = await read({
      chainId: "eip155:56",
      method: "eth_call",
      params: [{ to: token, data: "0x70a08231" }, "latest"],
    });
    expect(call.json()).toMatchObject({ result: "0x2a", error: null });
    expect(relay.calls.at(-1)).toEqual({
      method: "eth_call",
      params: [{ to: token, data: "0x70a08231" }, "latest"],
    });
    relay.outcome = {
      status: "error",
      error: { code: 3, message: "execution reverted", data: "0x08c379a0" },
    };
    const reverted = await read({
      chainId: "eip155:97",
      method: "eth_call",
      params: [{ to: token, data: "0x" }],
    });
    expect(reverted.statusCode).toBe(200);
    expect(reverted.json()).toMatchObject({
      result: null,
      error: { code: 3, message: "execution reverted", data: "0x08c379a0" },
    });
    relay.outcome = { status: "result", result: [] };
    expect(
      (
        await read({
          chainId: "eip155:97",
          method: "eth_getLogs",
          params: [{ fromBlock: "0x0", toBlock: "0x3e7", address: token }],
        })
      ).json(),
    ).toMatchObject({ result: [] });
    expect(
      reasonOf(
        await read({
          chainId: "eip155:97",
          method: "eth_getLogs",
          params: [{ fromBlock: "0x0", toBlock: "0x3e8", address: token }],
        }),
      ),
    ).toBe("422:VALIDATION_FAILED:RPC_LOG_RANGE_TOO_LARGE");
    expect(
      reasonOf(
        await read({
          chainId: "eip155:97",
          method: "eth_getLogs",
          params: [{ fromBlock: "earliest", address: [token] }],
        }),
      ),
    ).toBe("422:VALIDATION_FAILED:RPC_LOG_RANGE_TOO_LARGE");
    // S346 (A3): a filter must name at least one address.
    for (const filter of [
      { fromBlock: "0x0", toBlock: "0x1" },
      { fromBlock: "0x0", toBlock: "0x1", address: null },
      { fromBlock: "0x0", toBlock: "0x1", address: [] },
      { blockHash: `0x${"1".repeat(64)}` },
    ]) {
      expect(
        (
          await read({
            chainId: "eip155:97",
            method: "eth_getLogs",
            params: [filter],
          })
        ).statusCode,
      ).toBe(400);
    }
    // S346 (A6): tags are resolved against the head and forwarded as the
    // block numbers that were checked.
    const head = 44_000_000;
    await read({
      chainId: "eip155:97",
      method: "eth_getLogs",
      params: [
        {
          fromBlock: `0x${(head - 10).toString(16)}`,
          address: token,
          topics: [null],
        },
      ],
    });
    expect(relay.calls.at(-1)).toEqual({
      method: "eth_getLogs",
      params: [
        {
          fromBlock: `0x${(head - 10).toString(16)}`,
          toBlock: `0x${head.toString(16)}`,
          address: token,
          topics: [null],
        },
      ],
    });
    await read({
      chainId: "eip155:97",
      method: "eth_getLogs",
      params: [{ fromBlock: "latest", toBlock: "finalized", address: token }],
    });
    expect(relay.calls.at(-1)?.params).toEqual([
      {
        fromBlock: `0x${head.toString(16)}`,
        toBlock: `0x${head.toString(16)}`,
        address: token,
      },
    ]);
    await read({
      chainId: "eip155:97",
      method: "eth_getLogs",
      params: [{ blockHash: `0x${"1".repeat(64)}`, address: token }],
    });
    expect(relay.calls.at(-1)?.params).toEqual([
      { blockHash: `0x${"1".repeat(64)}`, address: token },
    ]);
    // S342 integration: block and fee-history reads for wallet libraries.
    relay.outcome = { status: "result", result: { number: "0x2a" } };
    expect(
      (
        await read({
          chainId: "eip155:56",
          method: "eth_getBlockByNumber",
          params: ["latest", false],
        })
      ).json(),
    ).toMatchObject({ result: { number: "0x2a" }, error: null });
    expect(relay.calls.at(-1)).toEqual({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    });
    // S346 (A3): the flag absent is forwarded as false; true is refused.
    await read({
      chainId: "eip155:97",
      method: "eth_getBlockByNumber",
      params: ["0x10"],
    });
    expect(relay.calls.at(-1)).toEqual({
      method: "eth_getBlockByNumber",
      params: ["0x10", false],
    });
    relay.outcome = { status: "result", result: { oldestBlock: "0x1" } };
    expect(
      (
        await read({
          chainId: "eip155:97",
          method: "eth_feeHistory",
          params: ["0x4", "latest", [25, 75]],
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await read({
          chainId: "eip155:97",
          method: "eth_feeHistory",
          params: [4, "0x10"],
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await read({
          chainId: "eip155:97",
          method: "eth_feeHistory",
          params: ["0x80", "latest"],
        })
      ).statusCode,
    ).toBe(200);
    for (const params of [
      [],
      ["latest", "yes"],
      ["latest", true],
      ["latest", false, 1],
      ["0xzz", false],
    ]) {
      expect(
        (
          await read({
            chainId: "eip155:97",
            method: "eth_getBlockByNumber",
            params,
          })
        ).statusCode,
      ).toBe(400);
    }
    for (const params of [
      ["0x0", "latest"],
      ["0x81", "latest"],
      [129, "latest"],
      ["0x400", "latest"],
      ["0x4", "pending"],
      ["0x4", "latest", [75, 25]],
      ["0x4", "latest", [101]],
      ["0x4", "latest", ["50"]],
      ["0x4"],
    ]) {
      expect(
        (
          await read({
            chainId: "eip155:97",
            method: "eth_feeHistory",
            params,
          })
        ).statusCode,
      ).toBe(400);
    }
    for (const method of [
      "eth_sendRawTransaction",
      "eth_sign",
      "eth_accounts",
      "debug_traceCall",
    ]) {
      expect(reasonOf(await read({ chainId: "eip155:97", method }))).toBe(
        "422:VALIDATION_FAILED:RPC_METHOD_NOT_ALLOWED",
      );
    }
    expect(
      reasonOf(await read({ chainId: "eip155:1", method: "eth_chainId" })),
    ).toBe("422:CHAIN_MISMATCH:undefined");
    expect(
      (
        await read({
          chainId: "eip155:97",
          method: "eth_call",
          params: [{ to: token }, "latest", { [token]: { balance: "0x1" } }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await read({ chainId: "eip155:97", method: "eth_chainId" }, true))
        .statusCode,
    ).toBe(400);
    // 40 per minute: the fortieth admitted request so far is the limit.
    let limited = null;
    for (let index = 0; index < 40 && limited === null; index += 1) {
      const response = await read({
        chainId: "eip155:97",
        method: "eth_blockNumber",
      });
      if (response.statusCode === 429) limited = response;
    }
    expect(limited?.json()).toMatchObject({
      code: "RATE_LIMITED",
      category: "rateLimit",
      retryable: true,
    });
  });

  it("is 503 when the endpoint is unreachable or the client cannot relay", async () => {
    const relay: RelayControl = { outcome: "throw", calls: [] };
    const app = await createApp({ DAPP_BROWSER_ENABLED: "on" }, relay);
    const down = await app.inject({
      method: "POST",
      url: "/v2/chain/rpc-read",
      headers: headers(false),
      payload: { chainId: "eip155:97", method: "eth_blockNumber" },
    });
    expect(reasonOf(down)).toBe("503:CAPABILITY_UNAVAILABLE:undefined");
    const noRelay = await createApp({ DAPP_BROWSER_ENABLED: "on" }, null);
    const missing = await noRelay.inject({
      method: "POST",
      url: "/v2/chain/rpc-read",
      headers: headers(false),
      payload: { chainId: "eip155:56", method: "eth_blockNumber" },
    });
    expect(reasonOf(missing)).toBe(
      "503:CAPABILITY_UNAVAILABLE:DAPP_BROWSER_CHAIN_UNAVAILABLE",
    );
  });

  it("S346: maps provider limits and oversized answers to 503 RPC_UPSTREAM_LIMITED and holds a process-wide budget", async () => {
    const relay: RelayControl = { outcome: { status: "limited" }, calls: [] };
    const app = await createApp(
      {
        DAPP_BROWSER_ENABLED: "on",
        DAPP_RPC_READ_GLOBAL_PER_MINUTE: "5",
      },
      relay,
    );
    const read = (method = "eth_blockNumber") =>
      app.inject({
        method: "POST",
        url: "/v2/chain/rpc-read",
        headers: headers(false),
        payload: { chainId: "eip155:97", method },
      });
    const limited = await read();
    expect(reasonOf(limited)).toBe(
      "503:CAPABILITY_UNAVAILABLE:RPC_UPSTREAM_LIMITED",
    );
    expect(limited.body).not.toContain("rate");
    relay.outcome = {
      status: "result",
      result: `0x${"0".repeat(1_048_576)}`,
    };
    expect(reasonOf(await read())).toBe(
      "503:CAPABILITY_UNAVAILABLE:RPC_UPSTREAM_LIMITED",
    );
    relay.outcome = { status: "result", result: "0x2a" };
    expect((await read()).statusCode).toBe(200);
    expect((await read()).statusCode).toBe(200);
    expect((await read()).statusCode).toBe(200);
    // Five tokens spent (eth_chainId is answered locally and costs none).
    expect((await read("eth_chainId")).statusCode).toBe(200);
    const exhausted = await read();
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(relay.calls).toHaveLength(5);
  });

  it("S346: a DApp prepare is 409 RESOURCE_CONFLICT / INTENT_BUSY while a send is open", async () => {
    const repository = intentRepositoryFake();
    const app = await createApp(
      { DAPP_BROWSER_ENABLED: "on" },
      undefined,
      repository,
    );
    const created = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/dapp-sign",
      headers: headers(true),
      payload: signBody,
    });
    expect(created.statusCode).toBe(201);
    const template = repository.records.get(
      created.json<{ intentId: string }>().intentId,
    )!;
    const sendId = randomUUID();
    repository.records.set(sendId, {
      ...template,
      intentId: sendId,
      kind: "send",
    });
    for (const [url, payload] of [
      ["/v2/wallet-intents/dapp-tx", txBody],
      ["/v2/wallet-intents/dapp-sign", signBody],
    ] as const) {
      const busy = await app.inject({
        method: "POST",
        url,
        headers: headers(true),
        payload,
      });
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toEqual({
        code: "RESOURCE_CONFLICT",
        category: "conflict",
        retryable: false,
        userMessageKey: expect.stringMatching(/^errors\./u) as unknown,
        correlationId: expect.any(String) as unknown,
        detailsSafe: { reasonCode: "INTENT_BUSY" },
        providerReferenceSafe: null,
      });
    }
    expect(repository.records.get(sendId)?.state).toBe("awaiting_signature");
  });

  it("publishes the routes, the opt-in kinds and the new enum values in the OpenAPI artifact", async () => {
    const document = JSON.parse(
      await readFile(openApiV2ArtifactPath, "utf8"),
    ) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const operations = {
      tx: document.paths["/v2/wallet-intents/dapp-tx"]?.["post"],
      sign: document.paths["/v2/wallet-intents/dapp-sign"]?.["post"],
      report:
        document.paths["/v2/wallet-intents/{intentId}/signature-report"]?.[
          "post"
        ],
      read: document.paths["/v2/chain/rpc-read"]?.["post"],
    };
    expect(operations.tx?.["operationId"]).toBe("prepareV2DappTxIntent");
    expect(operations.sign?.["operationId"]).toBe("prepareV2DappSignIntent");
    expect(operations.report?.["operationId"]).toBe(
      "reportV2WalletIntentSignature",
    );
    expect(operations.read?.["operationId"]).toBe("readV2ChainRpc");
    expect(Object.keys(operations.tx?.["responses"] ?? {}).sort()).toEqual([
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
    expect(Object.keys(operations.read?.["responses"] ?? {})).toContain("429");
    const created = JSON.stringify(
      (operations.sign?.["responses"] as Record<string, unknown>)["201"],
    );
    for (const value of [
      '"dapp_tx"',
      '"dapp_sign"',
      '"device_personal_sign"',
      '"device_sign_typed_data_v4"',
      '"not_applicable"',
      '"signatureRequest"',
      '"PERMIT_SIGNATURE"',
      '"UNLIMITED_APPROVAL"',
      '"APPROVAL_FOR_ALL"',
      '"UNVERIFIED_CONTRACT"',
      '"SIMULATION_FAILED"',
      '"EOA_SPENDER"',
      '"RAW_HASH_SIGNATURE"',
      '"UNRECOGNIZED_TYPED_DATA"',
    ]) {
      expect(created).toContain(value);
    }
    const list = document.paths["/v2/wallet-intents"]?.["get"];
    const includeKinds = (
      list?.["parameters"] as {
        name: string;
        schema: { pattern: string };
      }[]
    ).find((parameter) => parameter.name === "includeKinds");
    expect(includeKinds?.schema.pattern).toContain("dapp_sign");
    expect(dappRpcReadMethods).toHaveLength(12);
    expect(dappBrowserErrorReasonCodes).toEqual([
      "CHAIN_SIGNING_DISABLED",
      "TYPED_DATA_CHAIN_MISMATCH",
      "TYPED_DATA_INVALID",
      "ORIGIN_NOT_HTTPS",
      "SIGNATURE_MISMATCH",
      "RPC_METHOD_NOT_ALLOWED",
      "RPC_LOG_RANGE_TOO_LARGE",
      "DAPP_BROWSER_DISABLED",
      "DAPP_BROWSER_CHAIN_UNAVAILABLE",
      "RPC_UPSTREAM_LIMITED",
      "INTENT_BUSY",
    ]);
    const conflict = JSON.stringify(
      (operations.tx?.["responses"] as Record<string, unknown>)["409"],
    );
    expect(conflict).toContain('"RESOURCE_CONFLICT"');
  });
});
