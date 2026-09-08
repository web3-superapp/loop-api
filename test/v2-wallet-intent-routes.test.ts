import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import type { BscTransactionObservation } from "../src/integrations/bsc/rpc-client.js";
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
  spenderAddress,
  swapAdapterFake,
  usdtAssetId,
  walletId,
  walletsFake,
  wbnbAssetId,
  type ReadClientFakeOptions,
} from "./wallet-intent-fakes.js";

const validToken = "header.payload.signature";
const cursorSecret = "0123456789abcdef0123456789abcdef";
const txHash = `0x${"7".repeat(64)}`;

interface ErrorBody {
  readonly code: string;
}

interface IntentBody {
  readonly intentId: string;
  readonly state: string;
}

interface CapabilityRow {
  readonly capabilityId: string;
  readonly availability: string;
  readonly reasonCode: string | null;
  readonly evidence: {
    readonly status: string;
    readonly reasonCode: string | null;
  };
}

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
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    ...overrides,
  });
}

function headers(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const base: Record<string, string> = {
    authorization: `Bearer ${validToken}`,
    "x-loop-client-version": "1.2.3",
    "x-loop-contract-version": "2.0",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete base[name];
    } else {
      base[name] = value;
    }
  }
  return base;
}

function commandHeaders(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  return headers({ "idempotency-key": randomUUID(), ...overrides });
}

function fakes(options: { readonly readClient?: ReadClientFakeOptions } = {}) {
  const walletIntents = intentRepositoryFake();
  const database = {
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
  const privyAccessTokenVerifier = {
    verifyAccessToken: vi.fn(() =>
      Promise.resolve({ privyUserId: "did:privy:verified-user" }),
    ),
  } satisfies PrivyAccessTokenVerifier;
  return {
    database,
    walletIntents,
    privyAccessTokenVerifier,
    readClient: readClientFake(options.readClient),
    swap: swapAdapterFake({
      quote: { estimatedOutputAmount: "6650000000000000" },
    }),
  };
}

describe("V2 wallet-intent, swap, and approvals routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    dependencies = fakes(),
    overrides: Readonly<Record<string, string>> = {},
  ) {
    const app = await buildApp({
      config: testConfig(overrides),
      contractSurface: "v2",
      database: dependencies.database,
      privyAccessTokenVerifier: dependencies.privyAccessTokenVerifier,
      bscReadClient: dependencies.readClient.client,
      privySwapAdapter: dependencies.swap.adapter,
      marketFactService: marketFactsFake(),
      logger: false,
    });
    apps.push(app);
    return { app, ...dependencies };
  }

  const sendBody = {
    walletId,
    assetId: usdtAssetId,
    amount: "1.5",
    recipientAddress,
  };

  function capabilities(app: FastifyInstance) {
    return app
      .inject({ method: "GET", url: "/v2/meta/capabilities" })
      .then((response) =>
        Object.fromEntries(
          response
            .json<{ readonly capabilities: readonly CapabilityRow[] }>()
            .capabilities.map((row) => [row.capabilityId, row]),
        ),
      );
  }

  it("registers no route and reports deferred when the modules are disabled", async () => {
    const { app } = await createApp(fakes(), {
      V2_MODULES_ENABLED: "chain,wallet",
      BSC_WRITES_ENABLED: "false",
      BSC_WRITE_CANARY_ASSETS: "",
    });
    const response = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send",
      headers: commandHeaders(),
      payload: sendBody,
    });
    expect(response.statusCode).toBe(404);
    const projected = await capabilities(app);
    expect(projected["sendApprovals"]).toMatchObject({
      availability: "deferred",
      reasonCode: "SEND_APPROVALS_RUNTIME_DEFERRED",
    });
    expect(projected["privySwap"]).toMatchObject({
      availability: "deferred",
      reasonCode: "PRIVY_SWAP_GO_NO_GO_PENDING",
      evidence: {
        status: "pending",
        reasonCode: "PRIVY_BSC_SWAP_DEVICE_EVIDENCE_PENDING",
      },
    });
  });

  it("keeps every write closed with CAPABILITY_UNAVAILABLE while BSC_WRITES_ENABLED is false", async () => {
    const { app } = await createApp(fakes(), {
      BSC_WRITES_ENABLED: "false",
      BSC_WRITE_CANARY_ASSETS: "",
    });
    const projected = await capabilities(app);
    expect(projected["sendApprovals"]).toMatchObject({
      availability: "unavailable",
      reasonCode: "BSC_WRITES_DISABLED",
    });
    expect(projected["privySwap"]).toMatchObject({
      availability: "unavailable",
      reasonCode: "BSC_WRITES_DISABLED",
      evidence: { status: "pending" },
    });
    for (const [url, payload] of [
      ["/v2/wallet-intents/send", sendBody],
      [
        "/v2/wallet-intents/approve",
        {
          walletId,
          assetId: usdtAssetId,
          spenderAddress,
          allowance: { mode: "exact", amount: "1" },
        },
      ],
      [
        "/v2/wallet-intents/revoke",
        { walletId, assetId: usdtAssetId, spenderAddress },
      ],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: commandHeaders(),
        payload,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        category: "availability",
        retryable: true,
        detailsSafe: null,
        providerReferenceSafe: null,
      });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    const quote = await app.inject({
      method: "POST",
      url: "/v2/swap/quote",
      headers: headers(),
      payload: {
        walletId,
        sourceAssetId: usdtAssetId,
        destinationAssetId: wbnbAssetId,
        amount: "4",
      },
    });
    expect(quote.statusCode).toBe(503);
    expect(quote.json<ErrorBody>().code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("reports both capabilities available with the canary configuration and a verified chain", async () => {
    const { app } = await createApp();
    const projected = await capabilities(app);
    expect(projected["sendApprovals"]).toEqual({
      capabilityId: "sendApprovals",
      availability: "available",
      reasonCode: null,
      evidence: { status: "notApplicable", reasonCode: null },
    });
    expect(projected["privySwap"]).toEqual({
      capabilityId: "privySwap",
      availability: "available",
      reasonCode: null,
      evidence: {
        status: "pending",
        reasonCode: "PRIVY_BSC_SWAP_DEVICE_EVIDENCE_PENDING",
      },
    });
    const { app: unverified } = await createApp(
      fakes({ readClient: { verified: false } }),
    );
    expect((await capabilities(unverified))["sendApprovals"]).toMatchObject({
      availability: "unavailable",
      reasonCode: "BSC_RPC_UNREACHABLE",
    });
  });

  it("enforces write headers: Idempotency-Key required on commands and rejected on reads and quotes", async () => {
    const { app } = await createApp();
    const missingKey = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send",
      headers: headers(),
      payload: sendBody,
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json<ErrorBody>().code).toBe("INVALID_REQUEST");

    const readWithKey = await app.inject({
      method: "GET",
      url: "/v2/wallet-intents",
      headers: commandHeaders(),
    });
    expect(readWithKey.statusCode).toBe(400);

    const quoteWithKey = await app.inject({
      method: "POST",
      url: "/v2/swap/quote",
      headers: commandHeaders(),
      payload: {
        walletId,
        sourceAssetId: usdtAssetId,
        destinationAssetId: wbnbAssetId,
        amount: "4",
      },
    });
    expect(quoteWithKey.statusCode).toBe(400);

    const numberAmount = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send",
      headers: commandHeaders(),
      payload: { ...sendBody, amount: 1.5 },
    });
    expect(numberAmount.statusCode).toBe(400);

    const unknownField = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send",
      headers: commandHeaders(),
      payload: { ...sendBody, data: "0xdeadbeef" },
    });
    expect(unknownField.statusCode).toBe(400);

    const noAuth = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send",
      headers: commandHeaders({ authorization: undefined }),
      payload: sendBody,
    });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.headers["www-authenticate"]).toBe('Bearer realm="loop-api"');
  });

  it("walks a send intent from preflight through prepare, report, get, and list", async () => {
    const transactions = new Map<string, BscTransactionObservation | null>();
    const { app, walletIntents } = await createApp(
      fakes({ readClient: { transactions } }),
    );
    const preflight = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send/preflight",
      headers: headers(),
      payload: { walletId, address: recipientAddress },
    });
    expect(preflight.statusCode).toBe(200);
    expect(preflight.json()).toMatchObject({
      walletId,
      chainId: "eip155:56",
      basis: "indexed_erc20_transfers",
      recipient: { address: recipientAddress, isFirstRecipient: true },
      warnings: [
        "send.recipient.firstTime",
        "send.recipient.screeningUnavailable",
      ],
      contractVersion: "2.0",
    });

    const key = randomUUID();
    const prepared = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send",
      headers: commandHeaders({ "idempotency-key": key }),
      payload: sendBody,
    });
    expect(prepared.statusCode).toBe(201);
    const resource = prepared.json<{
      readonly intentId: string;
      readonly state: string;
      readonly reviewSha256: string;
      readonly expiresAt: string;
      readonly signing: { readonly allowed: boolean };
      readonly simulation: { readonly status: string };
      readonly unsignedTransaction: Record<string, unknown>;
      readonly review: Record<string, unknown>;
    }>();
    expect(resource).toMatchObject({
      kind: "send",
      state: "awaiting_signature",
      walletId,
      chainId: "eip155:56",
      simulation: { status: "passed", source: "rpc_call" },
      signing: { mode: "device_eth_send_transaction", allowed: true },
      authorizationPayload: null,
      contractVersion: "2.0",
    });
    expect(resource.reviewSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(resource.unsignedTransaction).toMatchObject({
      chainId: 56,
      type: "eip1559",
      nonce: "0x7",
    });
    expect(resource.review).toMatchObject({
      amount: { raw: "1500000000000000000", display: "1.5" },
      decodedCall: { functionName: "transfer" },
    });

    const replay = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send",
      headers: commandHeaders({ "idempotency-key": key }),
      payload: sendBody,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<IntentBody>().intentId).toBe(resource.intentId);

    const conflict = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send",
      headers: commandHeaders({ "idempotency-key": key }),
      payload: { ...sendBody, amount: "2" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<ErrorBody>().code).toBe("IDEMPOTENCY_CONFLICT");

    const transaction = resource.unsignedTransaction;
    transactions.set(txHash, {
      hash: txHash,
      from: String(transaction["from"]),
      to: String(transaction["to"]),
      input: transaction["data"] as `0x${string}`,
      value: 0n,
      nonce: 7,
      chainId: 56,
      blockNumber: null,
    });
    const reported = await app.inject({
      method: "POST",
      url: `/v2/wallet-intents/${resource.intentId}/broadcast-report`,
      headers: commandHeaders(),
      payload: { txHash },
    });
    expect(reported.statusCode).toBe(200);
    expect(reported.json()).toMatchObject({
      state: "submitted",
      result: { transactionHash: txHash, reasonCode: null },
      signing: { allowed: false },
    });

    const fetched = await app.inject({
      method: "GET",
      url: `/v2/wallet-intents/${resource.intentId}`,
      headers: headers(),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<IntentBody>().state).toBe("submitted");

    const listed = await app.inject({
      method: "GET",
      url: "/v2/wallet-intents?limit=10",
      headers: headers(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      items: [{ intentId: resource.intentId }],
      nextCursor: null,
      contractVersion: "2.0",
    });
    expect(walletIntents.events.map((event) => event.eventType)).toEqual([
      "intent_prepared",
      "broadcast_reported",
    ]);

    const cancel = await app.inject({
      method: "POST",
      url: `/v2/wallet-intents/${resource.intentId}/cancel`,
      headers: commandHeaders(),
    });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json<ErrorBody>().code).toBe("DATA_STALE");

    const missing = await app.inject({
      method: "GET",
      url: `/v2/wallet-intents/${randomUUID()}`,
      headers: headers(),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("maps policy and balance refusals to the catalog codes", async () => {
    const { app } = await createApp(fakes(), { BSC_WRITE_CANARY_MAX_USD: "1" });
    const tooLarge = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send",
      headers: commandHeaders(),
      payload: sendBody,
    });
    expect(tooLarge.statusCode).toBe(403);
    expect(tooLarge.json()).toMatchObject({
      code: "POLICY_BLOCKED",
      category: "authorization",
      retryable: false,
      detailsSafe: {
        reasonCode: "CANARY_CEILING_EXCEEDED",
        ceilingUsd: "1",
      },
    });
    expect(
      typeof tooLarge.json<{ detailsSafe: { exposureUsd: unknown } }>()
        .detailsSafe.exposureUsd,
    ).toBe("string");

    const { app: allowlisted } = await createApp(fakes(), {
      BSC_WRITE_CANARY_ASSETS: wbnbAssetId,
    });
    const notAllowed = await allowlisted.inject({
      method: "POST",
      url: "/v2/wallet-intents/send",
      headers: commandHeaders(),
      payload: sendBody,
    });
    expect(notAllowed.statusCode).toBe(403);
    expect(notAllowed.json()).toMatchObject({
      code: "POLICY_BLOCKED",
      detailsSafe: { reasonCode: "ASSET_NOT_IN_CANARY_ALLOWLIST" },
    });

    const { app: poor } = await createApp(
      fakes({ readClient: { tokenBalance: 1n } }),
    );
    const insufficient = await poor.inject({
      method: "POST",
      url: "/v2/wallet-intents/send",
      headers: commandHeaders(),
      payload: sendBody,
    });
    expect(insufficient.statusCode).toBe(409);
    expect(insufficient.json<ErrorBody>().code).toBe("INSUFFICIENT_BALANCE");

    const { app: reverting } = await createApp(
      fakes({
        readClient: {
          callOutcome: { status: "reverted", reasonCode: "BSC_CALL_REVERTED" },
        },
      }),
    );
    const prepared = await reverting.inject({
      method: "POST",
      url: "/v2/wallet-intents/send",
      headers: commandHeaders(),
      payload: sendBody,
    });
    expect(prepared.statusCode).toBe(201);
    expect(prepared.json()).toMatchObject({
      state: "prepared",
      simulation: { status: "reverted" },
      signing: { allowed: false, reasonCode: "BSC_CALL_REVERTED" },
    });
    const report = await reverting.inject({
      method: "POST",
      url: `/v2/wallet-intents/${prepared.json<IntentBody>().intentId}/broadcast-report`,
      headers: commandHeaders(),
      payload: { txHash },
    });
    expect(report.statusCode).toBe(409);
    expect(report.json<ErrorBody>().code).toBe("SIMULATION_FAILED");
  });

  it("prepares an exact approve and revoke and lists allowances", async () => {
    const { app } = await createApp(
      fakes({
        readClient: {
          allowances: {
            [`${usdtAssetId}:${spenderAddress}`]: 3_000_000_000_000_000_000n,
          },
        },
      }),
    );
    const approve = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/approve",
      headers: commandHeaders(),
      payload: {
        walletId,
        assetId: usdtAssetId,
        spenderAddress,
        allowance: { mode: "exact", amount: "3" },
      },
    });
    expect(approve.statusCode).toBe(201);
    expect(approve.json()).toMatchObject({
      kind: "approve",
      state: "awaiting_signature",
      review: {
        spender: { address: spenderAddress, isUnlimited: false },
        decodedCall: { functionName: "approve", selector: "0x095ea7b3" },
      },
    });

    const unlimited = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/approve",
      headers: commandHeaders(),
      payload: {
        walletId,
        assetId: usdtAssetId,
        spenderAddress,
        allowance: { mode: "unlimited" },
      },
    });
    expect(unlimited.statusCode).toBe(422);
    expect(unlimited.json<ErrorBody>().code).toBe("VALIDATION_FAILED");
    const numberAllowance = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/approve",
      headers: commandHeaders(),
      payload: {
        walletId,
        assetId: usdtAssetId,
        spenderAddress,
        allowance: { mode: "exact", amount: 3 },
      },
    });
    expect(numberAllowance.statusCode).toBe(400);

    const revoke = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/revoke",
      headers: commandHeaders(),
      payload: { walletId, assetId: usdtAssetId, spenderAddress },
    });
    expect(revoke.statusCode).toBe(201);
    expect(revoke.json()).toMatchObject({
      kind: "revoke",
      review: { amount: { raw: "0" } },
      policy: { valueUsd: null },
    });

    const list = await app.inject({
      method: "GET",
      url: `/v2/approvals?walletId=${walletId}`,
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      walletId,
      items: [],
      summary: { activeCount: 0, unlimitedCount: 0 },
      contractVersion: "2.0",
    });

    const detail = await app.inject({
      method: "GET",
      url: `/v2/approvals/${usdtAssetId}/${spenderAddress}?walletId=${walletId}`,
      headers: headers(),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      item: {
        assetId: usdtAssetId,
        spender: { address: spenderAddress },
        allowance: {
          status: "available",
          rawValue: "3000000000000000000",
          displayValue: "3",
        },
        riskFacts: { status: "unavailable" },
      },
    });

    const missingWallet = await app.inject({
      method: "GET",
      url: "/v2/approvals",
      headers: headers(),
    });
    expect(missingWallet.statusCode).toBe(400);
  });

  it("quotes and prepares a swap through the routes and refuses execute without a simulation", async () => {
    const { app, swap } = await createApp();
    const quote = await app.inject({
      method: "POST",
      url: "/v2/swap/quote",
      headers: headers(),
      payload: {
        walletId,
        sourceAssetId: usdtAssetId,
        destinationAssetId: wbnbAssetId,
        amount: "4",
        slippageBps: 100,
      },
    });
    expect(quote.statusCode).toBe(200);
    const quoted = quote.json<{
      readonly quote: {
        readonly quoteId: string;
        readonly slippageBps: number;
        readonly priceImpact: { readonly decision: string };
      };
      readonly policy: { readonly configVersion: string };
    }>();
    expect(quoted.quote.slippageBps).toBe(100);
    expect(quoted.quote.priceImpact.decision).toBe("allowed");
    expect(quoted.policy.configVersion).toBe("swapPolicyV1");

    const prepared = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/swap",
      headers: commandHeaders(),
      payload: { walletId, quoteId: quoted.quote.quoteId },
    });
    expect(prepared.statusCode).toBe(201);
    const intent = prepared.json<{
      readonly intentId: string;
      readonly authorizationPayload: {
        readonly headers: Record<string, string>;
      };
    }>();
    expect(prepared.json()).toMatchObject({
      kind: "swap",
      state: "prepared",
      signing: {
        mode: "privy_authorization_signature",
        allowed: false,
        reasonCode: "SWAP_SIMULATION_PROVIDER_PENDING",
      },
      unsignedTransaction: null,
      simulation: {
        status: "unavailable",
        source: "provider_quote",
        reasonCode: "SWAP_SIMULATION_PROVIDER_PENDING",
      },
    });
    expect(intent.authorizationPayload.headers["privy-idempotency-key"]).toBe(
      intent.intentId,
    );

    // No Provider-side simulation exists: execute is refused and nothing is
    // sent. The single-attempt execute path is covered at the service level.
    const executed = await app.inject({
      method: "POST",
      url: `/v2/wallet-intents/${intent.intentId}/execute`,
      headers: commandHeaders(),
      payload: { authorizationSignature: "device-signature" },
    });
    expect(executed.statusCode).toBe(409);
    expect(executed.json<ErrorBody>().code).toBe("SIMULATION_FAILED");
    expect(swap.executeCalls).toHaveLength(0);

    const reuse = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/swap",
      headers: commandHeaders(),
      payload: { walletId, quoteId: quoted.quote.quoteId },
    });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json<ErrorBody>().code).toBe("QUOTE_EXPIRED");

    const staleQuote = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/swap",
      headers: commandHeaders(),
      payload: { walletId, quoteId: randomUUID() },
    });
    expect(staleQuote.statusCode).toBe(409);
    expect(staleQuote.json<ErrorBody>().code).toBe("QUOTE_EXPIRED");

    const badSlippage = await app.inject({
      method: "POST",
      url: "/v2/swap/quote",
      headers: headers(),
      payload: {
        walletId,
        sourceAssetId: usdtAssetId,
        destinationAssetId: wbnbAssetId,
        amount: "4",
        slippageBps: 301,
      },
    });
    expect(badSlippage.statusCode).toBe(400);
  });

  it("registers the shared lifecycle routes once when only swap is enabled", async () => {
    const { app } = await createApp(fakes(), {
      V2_MODULES_ENABLED: "chain,wallet,market,swap",
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v2/wallet-intents",
      headers: headers(),
    });
    expect(listed.statusCode).toBe(200);
    const send = await app.inject({
      method: "POST",
      url: "/v2/wallet-intents/send",
      headers: commandHeaders(),
      payload: sendBody,
    });
    expect(send.statusCode).toBe(404);
    const projected = await capabilities(app);
    expect(projected["sendApprovals"]?.availability).toBe("deferred");
    expect(projected["privySwap"]?.availability).toBe("available");
  });
});
