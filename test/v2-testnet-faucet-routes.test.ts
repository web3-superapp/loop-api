import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { parseTestnetFaucet, type TestnetFaucetConfig } from "../src/config.js";
import { createUnavailableMiningRepository } from "../src/features/mining/mining-repository.js";
import {
  createTestnetFaucetService,
  type TestnetFaucetLogger,
  type TestnetFaucetServiceDependencies,
} from "../src/features/testnet-faucet/testnet-faucet-service.js";
import {
  testnetFaucetGrantResourceSchema,
  testnetFaucetStatusResourceSchema,
} from "../src/routes/v2/testnet-faucet-schemas.js";
import {
  archivedWalletId,
  bnbHash,
  createFakeFaucetChain,
  createInMemoryFaucetRepository,
  defaultFaucetChainState,
  embeddedAddress,
  embeddedWalletId,
  externalWalletId,
  faucetUsd1,
  faucetWallets,
  hooksFactory,
  legacyLaunchUsd1,
  secondWalletId,
  usd1Hash,
  type FakeFaucetChainState,
  type InMemoryFaucetRepository,
} from "./helpers/testnet-faucet-fakes.js";
import {
  s7AccountId,
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7IdempotencyKey,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0128 route contract: GET / POST /v2/testnet/faucet and the
 * `testnetFaucet` capability — every reason code, the cooldown, the
 * idempotent replay, the partial / unknown / failed outcomes, and the
 * in-process lock.
 */

const errorKeys = [
  "category",
  "code",
  "correlationId",
  "detailsSafe",
  "providerReferenceSafe",
  "retryable",
  "userMessageKey",
];
const NOW = new Date("2026-10-12T08:00:00.000Z");
const operatorKey = `0x${"ab".repeat(32)}` as const;
const enabledFaucet: TestnetFaucetConfig = parseTestnetFaucet({
  TESTNET_FAUCET_ENABLED: true,
  TESTNET_FAUCET_BNB_AMOUNT: "0.02",
  TESTNET_FAUCET_USD1_AMOUNT: "500",
  TESTNET_FAUCET_COOLDOWN_SECONDS: 86_400,
  TESTNET_FAUCET_OPERATOR_PRIVATE_KEY: operatorKey,
  // S156b: the old IDO USD1 is configured too; the Factory's wins.
  LAUNCH_USD1_ADDRESS: legacyLaunchUsd1,
  HOOKS_LAUNCH_FACTORY_ADDRESS: hooksFactory,
});
const launchContractUnit = {
  LAUNCH_CONTRACT_ADDRESS: "0x0000000000000000000000000000000000000c0c",
  LAUNCH_CONTRACT_VERSION: "1.0.0",
  LAUNCH_CONTRACT_START_BLOCK: "1",
  LAUNCH_USD1_ADDRESS: faucetUsd1,
};

function requiredOf(schema: unknown): string[] {
  return [...(schema as { required: string[] }).required];
}

describe("V2 testnet faucet (Decision 0128)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    options: {
      readonly chain?: FakeFaucetChainState;
      readonly repository?: InMemoryFaucetRepository;
      readonly deps?: Partial<TestnetFaucetServiceDependencies>;
      readonly composeFromConfig?: Readonly<Record<string, string>>;
    } = {},
  ) {
    const chain = options.chain ?? defaultFaucetChainState();
    const repository = options.repository ?? createInMemoryFaucetRepository();
    let clock = NOW;
    const info = vi.fn<TestnetFaucetLogger["info"]>();
    const logger: TestnetFaucetLogger = { info, warn: vi.fn() };
    const service =
      options.composeFromConfig !== undefined
        ? undefined
        : createTestnetFaucetService({
            config: enabledFaucet,
            launchChainId: "eip155:97",
            rpcConfigured: true,
            repository,
            wallets: faucetWallets(),
            chain: createFakeFaucetChain(chain),
            logger,
            now: () => clock,
            createUuid: (() => {
              let next = 0;
              return () =>
                `00000000-0000-4000-8000-${(next++).toString().padStart(12, "0")}`;
            })(),
            ...options.deps,
          });
    const app = await buildApp({
      config: s7TestConfig(options.composeFromConfig ?? {}),
      contractSurface: "v2",
      database: {
        ...s7Database({ mining: createUnavailableMiningRepository() }),
        accountWallets: faucetWallets(),
        testnetFaucet: repository,
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      ...(service === undefined ? {} : { testnetFaucetService: service }),
      ...(options.composeFromConfig !== undefined
        ? { testnetFaucetChain: createFakeFaucetChain(chain) }
        : {}),
      logger: false,
    });
    apps.push(app);
    return {
      app,
      chain,
      repository,
      info,
      advance: (seconds: number) => {
        clock = new Date(clock.getTime() + seconds * 1_000);
      },
    };
  }

  const status = (app: FastifyInstance, walletId = embeddedWalletId) =>
    app.inject({
      method: "GET",
      url: `/v2/testnet/faucet?walletId=${walletId}`,
      headers: s7CommonHeaders(),
    });
  const claim = (
    app: FastifyInstance,
    key = s7IdempotencyKey(),
    walletId = embeddedWalletId,
  ) =>
    app.inject({
      method: "POST",
      url: "/v2/testnet/faucet",
      headers: s7CommandHeaders({ "idempotency-key": key }),
      payload: { walletId },
    });
  async function capability(app: FastifyInstance) {
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const body = response.json<{
      capabilities: { capabilityId: string; reasonCode: string | null }[];
    }>();
    return body.capabilities.find(
      (entry) => entry.capabilityId === "testnetFaucet",
    );
  }
  function expectError(
    response: { statusCode: number; json: () => unknown },
    statusCode: number,
    code: string,
    reasonCode?: string,
  ) {
    expect(response.statusCode).toBe(statusCode);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(errorKeys);
    expect(body["code"]).toBe(code);
    if (reasonCode !== undefined) {
      expect(body).toMatchObject({ detailsSafe: { reasonCode } });
    }
    return body as { detailsSafe: Record<string, unknown> };
  }

  describe("capability and fail-closed configuration", () => {
    it("is unavailable with TESTNET_FAUCET_DISABLED by default and both routes answer 503", async () => {
      const { app, chain } = await createApp({ composeFromConfig: {} });
      expect(await capability(app)).toEqual({
        capabilityId: "testnetFaucet",
        availability: "unavailable",
        reasonCode: "TESTNET_FAUCET_DISABLED",
        evidence: { status: "notApplicable", reasonCode: null },
      });
      expectError(
        await status(app),
        503,
        "CAPABILITY_UNAVAILABLE",
        "TESTNET_FAUCET_DISABLED",
      );
      expectError(
        await claim(app),
        503,
        "CAPABILITY_UNAVAILABLE",
        "TESTNET_FAUCET_DISABLED",
      );
      expect(chain.calls).toEqual([]);
    });

    it("names the operator key, then USD1, as the missing piece", async () => {
      const noKey = await createApp({
        composeFromConfig: {
          LAUNCH_CHAIN_ID: "97",
          TESTNET_FAUCET_ENABLED: "true",
          ...launchContractUnit,
        },
      });
      expect((await capability(noKey.app))?.reasonCode).toBe(
        "TESTNET_FAUCET_OPERATOR_NOT_CONFIGURED",
      );
      const noUsd1 = await createApp({
        composeFromConfig: {
          LAUNCH_CHAIN_ID: "97",
          TESTNET_FAUCET_ENABLED: "true",
          MEME_OPERATOR_PRIVATE_KEY: "cd".repeat(32),
        },
      });
      expect((await capability(noUsd1.app))?.reasonCode).toBe(
        "TESTNET_FAUCET_USD1_NOT_CONFIGURED",
      );
      expectError(
        await claim(noUsd1.app),
        503,
        "CAPABILITY_UNAVAILABLE",
        "TESTNET_FAUCET_USD1_NOT_CONFIGURED",
      );
    });

    it("is available once composed from configuration on chain 97", async () => {
      const { app } = await createApp({
        composeFromConfig: {
          LAUNCH_CHAIN_ID: "97",
          TESTNET_FAUCET_ENABLED: "true",
          MEME_OPERATOR_PRIVATE_KEY: "cd".repeat(32),
          ...launchContractUnit,
        },
      });
      expect(await capability(app)).toMatchObject({
        availability: "available",
        reasonCode: null,
      });
      const response = await status(app);
      expect(response.statusCode).toBe(200);
    });

    it("reports RPC, wrong chain, and runtime reasons from the service", () => {
      const base = {
        config: enabledFaucet,
        launchChainId: "eip155:97" as const,
        rpcConfigured: true,
        repository: createInMemoryFaucetRepository(),
        wallets: faucetWallets(),
        chain: createFakeFaucetChain(defaultFaucetChainState()),
        logger: { info: vi.fn(), warn: vi.fn() },
      };
      expect(createTestnetFaucetService(base).unavailableReason()).toBeNull();
      expect(
        createTestnetFaucetService({
          ...base,
          launchChainId: "eip155:56",
        }).unavailableReason(),
      ).toBe("TESTNET_FAUCET_WRONG_CHAIN");
      expect(
        createTestnetFaucetService({
          ...base,
          rpcConfigured: false,
        }).unavailableReason(),
      ).toBe("TESTNET_FAUCET_RPC_NOT_CONFIGURED");
      expect(
        createTestnetFaucetService({
          ...base,
          repository: null,
        }).unavailableReason(),
      ).toBe("TESTNET_FAUCET_RUNTIME_UNAVAILABLE");
      expect(
        createTestnetFaucetService({
          ...base,
          config: { ...enabledFaucet, enabled: false },
        }).unavailableReason(),
      ).toBe("TESTNET_FAUCET_DISABLED");
    });
  });

  describe("GET /v2/testnet/faucet", () => {
    it("answers the amounts, cooldown, and no grant for a fresh wallet", async () => {
      const { app } = await createApp();
      const response = await status(app);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json<Record<string, unknown>>();
      expect(Object.keys(body).sort()).toEqual(
        requiredOf(testnetFaucetStatusResourceSchema).sort(),
      );
      expect(body).toEqual({
        walletId: embeddedWalletId,
        address: embeddedAddress,
        bnbAmount: "0.02",
        usd1Amount: "500",
        cooldownSeconds: 86_400,
        available: true,
        nextAvailableAt: null,
        lastGrant: null,
      });
    });

    it("refuses a wallet that is not the caller's active embedded wallet with one code", async () => {
      const { app } = await createApp();
      for (const walletId of [
        "99999999-9999-4999-8999-999999999999",
        externalWalletId,
        archivedWalletId,
      ]) {
        expectError(
          await status(app, walletId),
          403,
          "PERMISSION_DENIED",
          "TESTNET_FAUCET_WALLET_NOT_OWNED",
        );
      }
    });

    it("rejects a malformed or missing walletId and an unknown query key", async () => {
      const { app } = await createApp();
      for (const url of [
        "/v2/testnet/faucet",
        "/v2/testnet/faucet?walletId=0xabc",
        `/v2/testnet/faucet?walletId=${embeddedWalletId}&address=${embeddedAddress}`,
      ]) {
        expectError(
          await app.inject({ method: "GET", url, headers: s7CommonHeaders() }),
          400,
          "INVALID_REQUEST",
        );
      }
    });

    it("requires a session", async () => {
      const { app } = await createApp();
      const response = await app.inject({
        method: "GET",
        url: `/v2/testnet/faucet?walletId=${embeddedWalletId}`,
        headers: s7CommonHeaders({ authorization: undefined }),
      });
      expectError(response, 401, "AUTH_REQUIRED");
    });
  });

  describe("POST /v2/testnet/faucet", () => {
    it("sends tBNB first, then mints USD1, and answers 201", async () => {
      const { app, chain, repository, info } = await createApp();
      const response = await claim(app);
      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json<Record<string, unknown>>();
      expect(Object.keys(body).sort()).toEqual(
        requiredOf(testnetFaucetGrantResourceSchema).sort(),
      );
      expect(body).toEqual({
        walletId: embeddedWalletId,
        address: embeddedAddress,
        bnb: { amount: "0.02", transactionHash: bnbHash },
        usd1: { amount: "500", transactionHash: usd1Hash },
        grantedAt: NOW.toISOString(),
        nextAvailableAt: "2026-10-13T08:00:00.000Z",
      });
      expect(chain.calls).toEqual([
        `native:${embeddedAddress}:20000000000000000`,
        `mint:${embeddedAddress}:${500n * 10n ** 18n}:${faucetUsd1}`,
      ]);
      expect(repository.grants[0]?.record).toMatchObject({
        ownerUserId: s7AccountId,
        status: "granted",
        usd1AmountRaw: (500n * 10n ** 18n).toString(),
      });
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "testnet_faucet.grant",
          address: embeddedAddress,
          bnbTransactionHash: bnbHash,
          usd1TransactionHash: usd1Hash,
          status: "granted",
        }),
        "Testnet faucet grant",
      );
      const logged = JSON.stringify(info.mock.calls);
      expect(logged).not.toContain("ab".repeat(32));

      const after = (await status(app)).json<Record<string, unknown>>();
      expect(after).toMatchObject({
        available: false,
        nextAvailableAt: "2026-10-13T08:00:00.000Z",
        lastGrant: {
          grantedAt: NOW.toISOString(),
          bnbTransactionHash: bnbHash,
          usd1TransactionHash: usd1Hash,
        },
      });
    });

    it("mints the MEME v2 USD1 read from the Hooks Factory, never LAUNCH_USD1_ADDRESS, and reads the Factory once", async () => {
      const { app, chain, repository } = await createApp();
      expect((await claim(app, s7IdempotencyKey("1"))).statusCode).toBe(201);
      expect(
        (await claim(app, s7IdempotencyKey("2"), secondWalletId)).statusCode,
      ).toBe(201);
      const mints = chain.calls.filter((call) => call.startsWith("mint:"));
      expect(mints).toHaveLength(2);
      for (const mint of mints) {
        expect(mint.endsWith(`:${faucetUsd1}`)).toBe(true);
        expect(mint).not.toContain(legacyLaunchUsd1);
      }
      expect(chain.factoryReads).toEqual([hooksFactory]);
      expect(repository.usd1Tokens).toEqual([faucetUsd1, faucetUsd1]);
    });

    it("mints the explicit TESTNET_FAUCET_USD1_ADDRESS without reading the Factory", async () => {
      const explicit = "0x00000000000000000000000000000000000e0e01";
      const { app, chain } = await createApp({
        deps: {
          config: {
            ...enabledFaucet,
            usd1Source: { kind: "explicit", address: explicit },
          },
        },
      });
      expect((await claim(app)).statusCode).toBe(201);
      expect(chain.calls[1]?.endsWith(`:${explicit}`)).toBe(true);
      expect(chain.factoryReads).toEqual([]);
    });

    it("fails closed when the Factory's usd1() cannot be read", async () => {
      const { app, chain } = await createApp({
        chain: defaultFaucetChainState({ factoryUsd1: "throws" }),
      });
      expectError(
        await claim(app),
        503,
        "CAPABILITY_UNAVAILABLE",
        "TESTNET_FAUCET_CHAIN_READ_FAILED",
      );
      expect(chain.calls).toEqual([]);
    });

    it("scales the USD1 amount by the token's decimals()", async () => {
      const { app, chain } = await createApp({
        chain: defaultFaucetChainState({ decimals: 6 }),
      });
      expect((await claim(app)).statusCode).toBe(201);
      expect(chain.calls[1]).toBe(
        `mint:${embeddedAddress}:500000000:${faucetUsd1}`,
      );
    });

    it("replays the same Idempotency-Key with the same 201 and signs nothing again", async () => {
      const { app, chain } = await createApp();
      const first = await claim(app, s7IdempotencyKey("1"));
      const again = await claim(app, s7IdempotencyKey("1"));
      expect(again.statusCode).toBe(201);
      expect(again.body).toBe(first.body);
      expect(chain.calls).toHaveLength(2);
    });

    it("answers 429 with nextAvailableAt during the cooldown, per address, and opens after it", async () => {
      const { app, chain, advance } = await createApp();
      expect((await claim(app, s7IdempotencyKey("1"))).statusCode).toBe(201);
      advance(3_600);
      const cooling = expectError(
        await claim(app, s7IdempotencyKey("2")),
        429,
        "RATE_LIMITED",
        "TESTNET_FAUCET_COOLDOWN",
      );
      expect(cooling.detailsSafe["nextAvailableAt"]).toBe(
        "2026-10-13T08:00:00.000Z",
      );
      // Another wallet (another address) of the same user is not blocked.
      expect(
        (await claim(app, s7IdempotencyKey("3"), secondWalletId)).statusCode,
      ).toBe(201);
      advance(86_400 - 3_600);
      expect((await claim(app, s7IdempotencyKey("4"))).statusCode).toBe(201);
      expect(chain.calls).toHaveLength(6);
    });

    it("refuses the same key with another wallet as IDEMPOTENCY_CONFLICT", async () => {
      const { app } = await createApp();
      expect((await claim(app, s7IdempotencyKey("1"))).statusCode).toBe(201);
      expectError(
        await claim(app, s7IdempotencyKey("1"), secondWalletId),
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    });

    it("refuses a non-owned, external, or archived wallet with 403", async () => {
      const { app, chain } = await createApp();
      for (const walletId of [
        "99999999-9999-4999-8999-999999999999",
        externalWalletId,
        archivedWalletId,
      ]) {
        expectError(
          await claim(app, s7IdempotencyKey(), walletId),
          403,
          "PERMISSION_DENIED",
          "TESTNET_FAUCET_WALLET_NOT_OWNED",
        );
      }
      expect(chain.calls).toEqual([]);
    });

    it("requires the Idempotency-Key and the contract version, and a strict body", async () => {
      const { app } = await createApp();
      expectError(
        await app.inject({
          method: "POST",
          url: "/v2/testnet/faucet",
          headers: s7CommandHeaders({ "idempotency-key": undefined }),
          payload: { walletId: embeddedWalletId },
        }),
        400,
        "INVALID_REQUEST",
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v2/testnet/faucet",
            headers: s7CommandHeaders({ "x-loop-contract-version": undefined }),
            payload: { walletId: embeddedWalletId },
          })
        ).statusCode,
      ).toBeGreaterThanOrEqual(400);
      expectError(
        await app.inject({
          method: "POST",
          url: "/v2/testnet/faucet",
          headers: s7CommandHeaders(),
          payload: { walletId: embeddedWalletId, address: embeddedAddress },
        }),
        400,
        "INVALID_REQUEST",
      );
    });

    it("refuses an underfunded operator with TESTNET_FAUCET_OPERATOR_LOW and writes nothing", async () => {
      // 0.02 + 1 gwei × (21 000 + 72 000) × 2 = 0.020186 tBNB needed.
      const { app, chain, repository } = await createApp({
        chain: defaultFaucetChainState({ balanceWei: 20_100_000_000_000_000n }),
      });
      expectError(
        await claim(app),
        503,
        "CAPABILITY_UNAVAILABLE",
        "TESTNET_FAUCET_OPERATOR_LOW",
      );
      expect(chain.calls).toEqual([]);
      expect(repository.grants).toEqual([]);
      expect(repository.records.size).toBe(0);
    });

    it("refuses a USD1 whose mint reverts and a chain that cannot be read", async () => {
      const reverting = await createApp({
        chain: defaultFaucetChainState({ mintEstimate: "reverted" }),
      });
      expectError(
        await claim(reverting.app),
        503,
        "CAPABILITY_UNAVAILABLE",
        "TESTNET_FAUCET_USD1_UNAVAILABLE",
      );
      const down = await createApp({
        chain: defaultFaucetChainState({ readsThrow: true }),
      });
      expectError(
        await claim(down.app),
        503,
        "CAPABILITY_UNAVAILABLE",
        "TESTNET_FAUCET_CHAIN_READ_FAILED",
      );
      expect(reverting.chain.calls).toEqual([]);
      expect(down.chain.calls).toEqual([]);
    });

    it("records a partial grant when the mint fails: 503 with the tBNB hash, cooldown counts, replay repeats it", async () => {
      const { app, repository } = await createApp({
        chain: defaultFaucetChainState({ mint: "reverted" }),
      });
      const partial = expectError(
        await claim(app, s7IdempotencyKey("1")),
        503,
        "CAPABILITY_UNAVAILABLE",
        "TESTNET_FAUCET_PARTIAL",
      );
      expect(partial.detailsSafe).toEqual({
        reasonCode: "TESTNET_FAUCET_PARTIAL",
        bnbTransactionHash: bnbHash,
        usd1TransactionHash: usd1Hash,
        nextAvailableAt: "2026-10-13T08:00:00.000Z",
      });
      expect(repository.grants[0]?.record.status).toBe("partial");
      const replay = expectError(
        await claim(app, s7IdempotencyKey("1")),
        503,
        "CAPABILITY_UNAVAILABLE",
        "TESTNET_FAUCET_PARTIAL",
      );
      expect(replay.detailsSafe).toEqual(partial.detailsSafe);
      expectError(
        await claim(app, s7IdempotencyKey("2")),
        429,
        "RATE_LIMITED",
        "TESTNET_FAUCET_COOLDOWN",
      );
      expect((await status(app)).json()).toMatchObject({
        available: false,
        lastGrant: {
          bnbTransactionHash: bnbHash,
          usd1TransactionHash: usd1Hash,
        },
      });
    });

    it("reports a mint that never left as a partial grant without a USD1 hash", async () => {
      const { app } = await createApp({
        chain: defaultFaucetChainState({ mint: "not_sent" }),
      });
      const body = expectError(
        await claim(app),
        503,
        "CAPABILITY_UNAVAILABLE",
        "TESTNET_FAUCET_PARTIAL",
      );
      expect(body.detailsSafe).toEqual({
        reasonCode: "TESTNET_FAUCET_PARTIAL",
        bnbTransactionHash: bnbHash,
        nextAvailableAt: "2026-10-13T08:00:00.000Z",
      });
    });

    it("treats a tBNB transfer that never left as failed: 502, no cooldown, a new key retries", async () => {
      const state = defaultFaucetChainState({ native: "not_sent" });
      const { app, chain } = await createApp({ chain: state });
      expectError(
        await claim(app, s7IdempotencyKey("1")),
        502,
        "PROVIDER_UNREACHABLE",
        "TESTNET_FAUCET_TRANSFER_FAILED",
      );
      expect(chain.calls).toEqual([
        `native:${embeddedAddress}:20000000000000000`,
      ]);
      expect((await status(app)).json()).toMatchObject({
        available: true,
        lastGrant: null,
      });
      state.native = "confirmed";
      expect((await claim(app, s7IdempotencyKey("2"))).statusCode).toBe(201);
    });

    it("answers 503 TESTNET_FAUCET_SUBMISSION_UNKNOWN when the tBNB receipt does not arrive, and holds the cooldown", async () => {
      const { app, chain } = await createApp({
        chain: defaultFaucetChainState({ native: "unconfirmed" }),
      });
      const body = expectError(
        await claim(app, s7IdempotencyKey("1")),
        503,
        "CAPABILITY_UNAVAILABLE",
        "TESTNET_FAUCET_SUBMISSION_UNKNOWN",
      );
      expect(body.detailsSafe).toEqual({
        reasonCode: "TESTNET_FAUCET_SUBMISSION_UNKNOWN",
        bnbTransactionHash: bnbHash,
        nextAvailableAt: "2026-10-13T08:00:00.000Z",
      });
      expect(chain.calls).toHaveLength(1);
      expectError(
        await claim(app, s7IdempotencyKey("2")),
        429,
        "RATE_LIMITED",
        "TESTNET_FAUCET_COOLDOWN",
      );
    });

    it("serialises grants: a second request waiting past the lock is TESTNET_FAUCET_BUSY, the same key in flight is TESTNET_FAUCET_IN_FLIGHT", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { app } = await createApp({
        chain: defaultFaucetChainState({ nativeGate: gate }),
        deps: { lockTimeoutMs: 50 },
      });
      // light-my-request dispatches on then(); start the first one now.
      const first = claim(app, s7IdempotencyKey("1")).then(
        (response) => response,
      );
      await vi.waitFor(async () => {
        expectError(
          await claim(app, s7IdempotencyKey("1")),
          409,
          "RESOURCE_CONFLICT",
          "TESTNET_FAUCET_IN_FLIGHT",
        );
      });
      // A different address waits for the lock and gives up.
      expectError(
        await claim(app, s7IdempotencyKey("2"), secondWalletId),
        503,
        "CAPABILITY_UNAVAILABLE",
        "TESTNET_FAUCET_BUSY",
      );
      release();
      expect((await first).statusCode).toBe(201);
      expect(
        (await claim(app, s7IdempotencyKey("3"), secondWalletId)).statusCode,
      ).toBe(201);
    });
  });
});
