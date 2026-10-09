import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/core/http/api-error.js";
import {
  createAuthenticationService,
  registerAuthenticationHooks,
} from "../src/core/http/authentication.js";
import {
  createPerpPrivateReadService,
  InvalidPerpReadRequestError,
  PerpReadUnavailableError,
  type PerpAccountResponse,
  type PerpConfigResponse,
  type PerpFillsResponse,
  type PerpFundingResponse,
  type PerpOrdersResponse,
  type PerpPositionsResponse,
  type PerpPrivateReadResponse,
  type PerpPrivateReadService,
} from "../src/features/perp/private-read-service.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import type { PerpPrivateReadCursorCodec } from "../src/features/perp/private-read-cursor.js";
import type { PerpWalletBindingResolver } from "../src/features/perp/wallet-binding-resolver.js";
import {
  createUnavailableHyperliquidPrivateReader,
  type HyperliquidPrivateReadKind,
} from "../src/integrations/hyperliquid/private-reader.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import { registerPerpPrivateReadRoutes } from "../src/routes/perp-private-reads.js";

const loopUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const privyUserId = "did:privy:perp-route-user";
const validAccessToken = "header.payload.signature";
const currentTime = "2026-08-24T12:00:00.000Z";
const validCursor = `${Buffer.from('{"v":1}', "utf8").toString("base64url")}.${"a".repeat(43)}`;
const transactionHash = `0x${"a".repeat(64)}`;
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function source<const Kind extends HyperliquidPrivateReadKind>(kind: Kind) {
  return {
    provider: "hyperliquid",
    network: "testnet",
    market: "core_perps",
    dex: "",
    dataset: kind,
    fetched_at: currentTime,
    expires_at:
      kind === "config"
        ? "2026-08-24T12:01:00.000Z"
        : "2026-08-24T12:00:02.000Z",
  } as const;
}

const configResponse: PerpConfigResponse = {
  scope: {
    network: "testnet",
    market: "core_perps",
    dex: "",
    coins: ["BTC", "ETH", "SOL"],
  },
  assets: [
    {
      coin: "BTC",
      size_decimals: 5,
      size_increment: "0.00001",
      max_leverage: "40",
      margin_mode: "cross_and_isolated",
      minimum_order_notional_usdc: { state: "available", value: "10" },
    },
    {
      coin: "ETH",
      size_decimals: 4,
      size_increment: "0.0001",
      max_leverage: "25",
      margin_mode: "cross_and_isolated",
      minimum_order_notional_usdc: { state: "available", value: "10" },
    },
    {
      coin: "SOL",
      size_decimals: 2,
      size_increment: "0.01",
      max_leverage: "20",
      margin_mode: "cross_and_isolated",
      minimum_order_notional_usdc: { state: "unavailable" },
    },
  ],
  fees: {
    maker_rate: { state: "available", value: "-0.0001" },
    taker_rate: { state: "available", value: "0.00035" },
  },
  capabilities: {
    private_reads: "available",
    trading_mutations: "disabled",
  },
  source: source("config"),
};

const marginSummary = {
  account_value: "1000.25",
  total_margin_used: "120",
  total_notional_position: "480",
  total_raw_usd: "1000.25",
};

const accountResponse: PerpAccountResponse = {
  margin_summary: marginSummary,
  cross_margin_summary: marginSummary,
  withdrawable: "880.25",
  cross_maintenance_margin_used: null,
  source: source("account"),
};

const positionsResponse: PerpPositionsResponse = {
  items: [
    {
      coin: "BTC",
      side: "long",
      size: "0.01",
      entry_price: "60000",
      leverage: { mode: "cross", value: "5", raw_usd: null },
      liquidation_price: null,
      margin_used: "120",
      position_value: "600",
      return_on_equity: "0.025",
      unrealized_pnl: "3",
      position_mode: "one_way",
    },
  ],
  source: source("positions"),
  next_cursor: null,
};

const ordersResponse: PerpOrdersResponse = {
  items: [
    {
      order_id: "18446744073709551615",
      client_order_id: `0x${"b".repeat(32)}`,
      coin: "ETH",
      side: "sell",
      order_type: "limit",
      time_in_force: "gtc",
      limit_price: "4200.5",
      original_size: "0.25",
      remaining_size: "0.1",
      reduce_only: true,
      status: "open",
      created_at: "2026-08-24T11:58:00.000Z",
      status_at: "2026-08-24T11:59:00.000Z",
    },
  ],
  source: source("orders"),
  next_cursor: validCursor,
};

const coverage = {
  kind: "recent_window" as const,
  started_at: "2026-08-17T12:00:00.000Z",
  ended_at: currentTime,
  truncated: true,
};

const fillsResponse: PerpFillsResponse = {
  items: [
    {
      trade_id: "2",
      order_id: "42",
      transaction_hash: transactionHash,
      coin: "SOL",
      side: "buy",
      price: "185.25",
      size: "2",
      start_position: "0",
      closed_pnl: "0",
      fee: "0.12",
      fee_asset: "USDC",
      crossed: true,
      filled_at: "2026-08-24T11:57:00.000Z",
    },
  ],
  coverage,
  source: source("fills"),
  next_cursor: null,
};

const fundingResponse: PerpFundingResponse = {
  items: [
    {
      transaction_hash: `0x${"c".repeat(64)}`,
      coin: "BTC",
      funding_rate: "-0.0000125",
      position_size: "0.01",
      payment_usdc: "-0.075",
      settled_at: "2026-08-24T11:55:00.000Z",
    },
  ],
  coverage,
  source: source("funding"),
  next_cursor: null,
};

const successByKind: Readonly<
  Record<HyperliquidPrivateReadKind, PerpPrivateReadResponse>
> = {
  config: configResponse,
  account: accountResponse,
  positions: positionsResponse,
  orders: ordersResponse,
  fills: fillsResponse,
  funding: fundingResponse,
};

interface RouteTestDependencies {
  readonly verifier: PrivyAccessTokenVerifier;
  readonly internalUsers: InternalUserRepository;
  readonly service: PerpPrivateReadService;
  readonly verifyAccessToken: ReturnType<
    typeof vi.fn<PrivyAccessTokenVerifier["verifyAccessToken"]>
  >;
  readonly findByPrivyUserId: ReturnType<
    typeof vi.fn<InternalUserRepository["findByPrivyUserId"]>
  >;
  readonly read: ReturnType<typeof vi.fn<PerpPrivateReadService["read"]>>;
}

function dependencies(
  serviceOverride?: PerpPrivateReadService,
): RouteTestDependencies {
  const verifyAccessToken = vi.fn<
    PrivyAccessTokenVerifier["verifyAccessToken"]
  >(() => Promise.resolve({ privyUserId }));
  const findByPrivyUserId = vi.fn<InternalUserRepository["findByPrivyUserId"]>(
    () => Promise.resolve({ id: loopUserId }),
  );
  const read = vi.fn<PerpPrivateReadService["read"]>((input) =>
    Promise.resolve(successByKind[input.kind]),
  );
  const internalUsers = {
    findByPrivyUserId,
    getOrCreateByPrivyUserId: vi.fn<
      InternalUserRepository["getOrCreateByPrivyUserId"]
    >(() => Promise.resolve({ id: loopUserId })),
  } satisfies InternalUserRepository;

  return {
    verifier: { verifyAccessToken },
    internalUsers,
    service: serviceOverride ?? { read },
    verifyAccessToken,
    findByPrivyUserId,
    read,
  };
}

function classifyError(error: unknown): {
  readonly hasValidation: boolean;
  readonly statusCode: number | undefined;
} {
  if (typeof error !== "object" || error === null) {
    return { hasValidation: false, statusCode: undefined };
  }

  return {
    hasValidation: "validation" in error && error.validation !== undefined,
    statusCode:
      "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : undefined,
  };
}

async function createTestApp(
  inputDependencies = dependencies(),
): Promise<FastifyInstance> {
  const app = Fastify({
    genReqId: () => randomUUID(),
    logger: false,
    requestIdHeader: false,
  });
  const auth = registerAuthenticationHooks(
    app,
    createAuthenticationService(
      inputDependencies.verifier,
      inputDependencies.internalUsers,
    ),
  );

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  registerPerpPrivateReadRoutes(
    app,
    auth.authenticateLoopBearer,
    inputDependencies.service,
  );
  app.setErrorHandler(async (error, request, reply) => {
    const details = classifyError(error);
    const apiError = error instanceof ApiError ? error : undefined;
    const inputError =
      details.hasValidation ||
      details.statusCode === 400 ||
      details.statusCode === 413 ||
      details.statusCode === 415;
    const statusCode = apiError?.statusCode ?? (inputError ? 400 : 500);
    const code =
      apiError?.code ?? (inputError ? "invalid_request" : "internal_error");
    const message =
      apiError?.safeMessage ??
      (inputError
        ? "The request is invalid."
        : "The request could not be completed.");

    reply.header("cache-control", "no-store");
    if (apiError?.includeBearerChallenge === true) {
      reply.header("www-authenticate", 'Bearer realm="loop-api"');
    }
    return reply.code(statusCode).send({
      code,
      message,
      request_id: request.id,
    });
  });

  await app.ready();
  return app;
}

function expectOperationalHeaders(response: {
  readonly headers: Record<string, string | string[] | number | undefined>;
}): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-request-id"]).toMatch(requestIdPattern);
}

function expectErrorRequestId(response: {
  json<T>(): T;
  readonly headers: Record<string, string | string[] | number | undefined>;
}): void {
  const payload = response.json<{ request_id: string }>();
  expect(payload.request_id).toBe(response.headers["x-request-id"]);
  expect(payload.request_id).toMatch(requestIdPattern);
}

describe("Perp private read routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(inputDependencies = dependencies()) {
    const app = await createTestApp(inputDependencies);
    apps.push(app);
    return { app, ...inputDependencies };
  }

  it("authenticates every route and returns the six exact no-store projections", async () => {
    const inputs = await createApp();
    const routes = [
      ["config", configResponse],
      ["account", accountResponse],
      ["positions", positionsResponse],
      ["orders", ordersResponse],
      ["fills", fillsResponse],
      ["funding", fundingResponse],
    ] as const;

    for (const [kind, expected] of routes) {
      const response = await inputs.app.inject({
        method: "GET",
        url: `/v1/perp/${kind}`,
        headers: { authorization: `Bearer ${validAccessToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expected);
      expectOperationalHeaders(response);
    }

    expect(inputs.verifyAccessToken).toHaveBeenCalledTimes(6);
    expect(inputs.findByPrivyUserId).toHaveBeenCalledTimes(6);
    expect(inputs.read).toHaveBeenCalledTimes(6);
    expect(
      inputs.verifyAccessToken.mock.calls.every(
        ([token]) => token === validAccessToken,
      ),
    ).toBe(true);
  });

  it("passes only the server-derived principal and route-owned read selection", async () => {
    const inputs = await createApp();
    const response = await inputs.app.inject({
      method: "GET",
      url: "/v1/perp/account",
      headers: { authorization: `Bearer ${validAccessToken}` },
      remoteAddress: "198.51.100.90",
    });

    expect(response.statusCode).toBe(200);
    const serviceRequest = inputs.read.mock.calls[0]?.[0];
    expect(serviceRequest).toBeDefined();
    if (serviceRequest === undefined) {
      throw new Error("Expected the Perp service request");
    }
    expect(serviceRequest.principal).toEqual({
      userId: loopUserId,
      privyUserId,
      streamUserId,
    });
    expect(serviceRequest.kind).toBe("account");
    expect(serviceRequest.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(serviceRequest).sort()).toEqual([
      "kind",
      "principal",
      "signal",
    ]);
    expect(JSON.stringify(serviceRequest)).not.toContain("198.51.100.90");
    expect(JSON.stringify(serviceRequest)).not.toContain("accountAddress");
    expect(JSON.stringify(serviceRequest)).not.toContain("wallet");
    expect(JSON.stringify(serviceRequest)).not.toContain("agent");
  });

  it.each([
    ["config body", "/v1/perp/config", { account: "forged" }],
    ["positions body", "/v1/perp/positions", { limit: 2 }],
  ] as const)(
    "rejects a %s before authentication or feature work",
    async (_name, url, payload) => {
      const inputs = await createApp();
      const response = await inputs.app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${validAccessToken}` },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expectOperationalHeaders(response);
      expectErrorRequestId(response);
      expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
      expect(inputs.findByPrivyUserId).not.toHaveBeenCalled();
      expect(inputs.read).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["user", "/v1/perp/config?user=forged"],
    ["account", "/v1/perp/account?account=0xforged"],
    ["address", "/v1/perp/positions?address=0xforged"],
    ["wallet", "/v1/perp/orders?wallet=forged"],
    ["agent", "/v1/perp/fills?agent=0xforged"],
    ["network", "/v1/perp/funding?network=mainnet"],
    ["dex", "/v1/perp/positions?dex=hip3"],
    ["coin", "/v1/perp/orders?coin=BTC"],
    ["startTime", "/v1/perp/fills?startTime=1"],
    ["endTime", "/v1/perp/funding?endTime=2"],
  ] as const)(
    "rejects forged %s authority before authentication or resolution",
    async (_field, url) => {
      const inputs = await createApp();
      const response = await inputs.app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${validAccessToken}` },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
      expect(inputs.findByPrivyUserId).not.toHaveBeenCalled();
      expect(inputs.read).not.toHaveBeenCalled();
    },
  );

  it("coerces bounded limits and forwards only one opaque cursor", async () => {
    const inputs = await createApp();

    const positions = await inputs.app.inject({
      method: "GET",
      url: "/v1/perp/positions?limit=2",
      headers: { authorization: `Bearer ${validAccessToken}` },
    });
    const orders = await inputs.app.inject({
      method: "GET",
      url: "/v1/perp/orders?limit=50",
      headers: { authorization: `Bearer ${validAccessToken}` },
    });
    const fills = await inputs.app.inject({
      method: "GET",
      url: `/v1/perp/fills?cursor=${validCursor}`,
      headers: { authorization: `Bearer ${validAccessToken}` },
    });

    expect(positions.statusCode).toBe(200);
    expect(orders.statusCode).toBe(200);
    expect(fills.statusCode).toBe(200);
    expect(inputs.read.mock.calls[0]?.[0]).toMatchObject({
      kind: "positions",
      limit: 2,
    });
    expect(inputs.read.mock.calls[1]?.[0]).toMatchObject({
      kind: "orders",
      limit: 50,
    });
    expect(inputs.read.mock.calls[2]?.[0]).toMatchObject({
      kind: "fills",
      cursor: validCursor,
    });
    expect(typeof inputs.read.mock.calls[0]?.[0].limit).toBe("number");
  });

  it.each([
    ["positions below range", "/v1/perp/positions?limit=0"],
    ["positions above range", "/v1/perp/positions?limit=4"],
    ["private list below range", "/v1/perp/orders?limit=0"],
    ["private list above range", "/v1/perp/funding?limit=51"],
    ["malformed cursor", "/v1/perp/fills?cursor=not-a-token"],
    ["limit with cursor", `/v1/perp/orders?limit=20&cursor=${validCursor}`],
  ] as const)("rejects %s before authentication", async (_name, url) => {
    const inputs = await createApp();
    const response = await inputs.app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${validAccessToken}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
    expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
    expect(inputs.findByPrivyUserId).not.toHaveBeenCalled();
    expect(inputs.read).not.toHaveBeenCalled();
  });

  it("requires a current Privy Bearer token", async () => {
    const inputs = await createApp();
    const response = await inputs.app.inject({
      method: "GET",
      url: "/v1/perp/account",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: "authentication_required",
      message: "Authentication is required.",
    });
    expect(response.headers["www-authenticate"]).toBe(
      'Bearer realm="loop-api"',
    );
    expectOperationalHeaders(response);
    expectErrorRequestId(response);
    expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
    expect(inputs.read).not.toHaveBeenCalled();
  });

  it("requires an existing bootstrap mapping after current-token verification", async () => {
    const inputDependencies = dependencies();
    inputDependencies.findByPrivyUserId.mockResolvedValueOnce(null);
    const inputs = await createApp(inputDependencies);
    const response = await inputs.app.inject({
      method: "GET",
      url: "/v1/perp/config",
      headers: { authorization: `Bearer ${validAccessToken}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "bootstrap_required",
      message: "Bootstrap is required.",
    });
    expectOperationalHeaders(response);
    expectErrorRequestId(response);
    expect(inputs.verifyAccessToken).toHaveBeenCalledOnce();
    expect(inputs.findByPrivyUserId).toHaveBeenCalledOnce();
    expect(inputs.read).not.toHaveBeenCalled();
  });

  it("maps a missing verified wallet binding to 409 before reader work", async () => {
    const readerRead = vi.fn(() => Promise.resolve(accountResponse));
    const bindingResolver = {
      resolve: vi.fn(() => Promise.resolve(null)),
    } satisfies PerpWalletBindingResolver;
    const service = createPerpPrivateReadService({
      bindingResolver,
      cursorCodec: createCursorCodec(),
      reader: { read: readerRead },
      now: () => new Date(currentTime),
    });
    const inputs = await createApp(dependencies(service));
    const response = await inputs.app.inject({
      method: "GET",
      url: "/v1/perp/account",
      headers: { authorization: `Bearer ${validAccessToken}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "wallet_binding_required",
      message: "A verified wallet binding is required.",
    });
    expectOperationalHeaders(response);
    expectErrorRequestId(response);
    expect(bindingResolver.resolve).toHaveBeenCalledOnce();
    expect(readerRead).not.toHaveBeenCalled();
  });

  it("maps the unavailable Hyperliquid reader to a sanitized 503", async () => {
    const service = createPerpPrivateReadService({
      bindingResolver: createVerifiedBindingResolver(),
      cursorCodec: createCursorCodec(),
      reader: createUnavailableHyperliquidPrivateReader(),
      now: () => new Date(currentTime),
    });
    const inputs = await createApp(dependencies(service));
    const response = await inputs.app.inject({
      method: "GET",
      url: "/v1/perp/account",
      headers: { authorization: `Bearer ${validAccessToken}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "perp_unavailable",
      message: "Perpetual account data is unavailable.",
    });
    expectOperationalHeaders(response);
    expectErrorRequestId(response);
  });

  it("maps service input failures to invalid_request", async () => {
    const read = vi.fn<PerpPrivateReadService["read"]>(() =>
      Promise.reject(new InvalidPerpReadRequestError()),
    );
    const inputs = await createApp(dependencies({ read }));
    const response = await inputs.app.inject({
      method: "GET",
      url: "/v1/perp/orders",
      headers: { authorization: `Bearer ${validAccessToken}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
    expectOperationalHeaders(response);
    expectErrorRequestId(response);
  });

  it("sanitizes known-unavailable and unexpected provider failures", async () => {
    const unavailableRead = vi.fn<PerpPrivateReadService["read"]>(() =>
      Promise.reject(new PerpReadUnavailableError()),
    );
    const unavailableInputs = await createApp(
      dependencies({ read: unavailableRead }),
    );
    const unavailable = await unavailableInputs.app.inject({
      method: "GET",
      url: "/v1/perp/positions",
      headers: { authorization: `Bearer ${validAccessToken}` },
    });

    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ code: "perp_unavailable" });
    expectOperationalHeaders(unavailable);

    const secret = "provider-wallet-secret-and-raw-response";
    const failingRead = vi.fn<PerpPrivateReadService["read"]>(() =>
      Promise.reject(new Error(secret)),
    );
    const failingInputs = await createApp(dependencies({ read: failingRead }));
    const failed = await failingInputs.app.inject({
      method: "GET",
      url: "/v1/perp/funding",
      headers: { authorization: `Bearer ${validAccessToken}` },
    });

    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain(secret);
    expect(failed.body).not.toContain("wallet");
    expect(failed.json()).toMatchObject({
      code: "internal_error",
      message: "The request could not be completed.",
    });
    expectOperationalHeaders(failed);
    expectErrorRequestId(failed);
  });
});

function createCursorCodec(): PerpPrivateReadCursorCodec {
  return {
    encode: vi.fn(() => validCursor),
    decode: vi.fn(() => ({ limit: 20, providerCursorState: "c3RhdGU" })),
  };
}

function createVerifiedBindingResolver(): PerpWalletBindingResolver {
  return {
    resolve: vi.fn(() =>
      Promise.resolve({
        ownerUserId: loopUserId,
        privyUserId,
        accountAddress: `0x${"1".repeat(40)}`,
        accountKind: "master",
        bindingVersion: "1",
        verifiedAt: "2026-08-24T11:59:00.000Z",
        expiresAt: "2026-08-24T12:10:00.000Z",
      }),
    ),
  };
}
