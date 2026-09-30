import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { summarizeErrorForLog } from "../src/core/http/error-log.js";
import { projectV2Error, V2ApiError } from "../src/core/http/v2-error.js";
import { createPostgresLaunchChainRepository } from "../src/database/launch-chain-repository.js";
import {
  LaunchChainRepositoryUnavailableError,
  type LaunchChainRepository,
} from "../src/features/launch/launch-chain-repository.js";
import {
  createLaunchService,
  type LaunchService,
} from "../src/features/launch/launch-service.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import {
  createFakeLaunchAdapter,
  createFakeLaunchChainState,
  createFakeLaunchSlotClient,
  fakeNowSeconds,
  type FakeLaunchChainState,
} from "./helpers/launch-fake-adapter.js";
import { oneUsd1 } from "./helpers/launch-lane-fixtures.js";
import {
  accountId,
  chainRepositoryFake,
  launchId,
  launchRepositoryFor,
  registeredDetail,
  roundOneId,
  roundTwoId,
  walletId,
  walletsFake,
  writesConfig,
} from "./helpers/launch-service-fakes.js";

/**
 * S104: a refusal raised while the Launch Intent is being built (06 §4.1
 * DATA_STALE / VALIDATION_FAILED / POLICY_BLOCKED, or a 503 read failure)
 * runs inside the PostgreSQL repository's `createIntent`. It must reach the
 * route unchanged, never as `launch_chain_repository_unavailable` (500).
 * The service here writes through the real PostgreSQL `createIntent`; the
 * chain reads are fixtures.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

function connectionUrl(source: string, name: string): string {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (caught: unknown) => caught,
  );
}

const principal = Object.freeze({
  userId: accountId,
  privyUserId: "did:privy:verified-user",
}) as never;
const base = createFakeLaunchChainState();
const round1 = base.rounds[0]!;

const vesting: Partial<FakeLaunchChainState> = {
  tuple: {
    ...base.tuple,
    saleState: "SUCCEEDED",
    entitlementState: "VESTING",
    liquidityState: "LP_LOCKED",
  },
  position: {
    ...base.position,
    entitledTokens: 10_000n * oneUsd1,
    claimableTokens: 2_500n * oneUsd1,
    claimedTokens: 0n,
  },
};

const cases: readonly {
  readonly name: string;
  readonly chainState: Partial<FakeLaunchChainState>;
  readonly body: Record<string, unknown>;
  readonly statusCode: number;
  readonly code: string;
  readonly reasonCode: string;
}[] = [
  {
    name: "buy after the round window ended",
    chainState: { rounds: [{ ...round1, endAt: fakeNowSeconds }] },
    body: { walletId, roundId: roundOneId, payAmount: "10" },
    statusCode: 409,
    code: "DATA_STALE",
    reasonCode: "LAUNCH_ROUND_NOT_OPEN",
  },
  {
    name: "buy before the round opens",
    chainState: {},
    body: { walletId, roundId: roundTwoId, payAmount: "10" },
    statusCode: 409,
    code: "DATA_STALE",
    reasonCode: "LAUNCH_ROUND_NOT_OPEN",
  },
  {
    name: "buy while the sale is PAUSED",
    chainState: { tuple: { ...base.tuple, operationalState: "PAUSED" } },
    body: { walletId, roundId: roundOneId, payAmount: "10" },
    statusCode: 409,
    code: "DATA_STALE",
    reasonCode: "LAUNCH_SALE_PAUSED",
  },
  {
    name: "buy below minPurchase",
    chainState: {},
    body: { walletId, roundId: roundOneId, payAmount: "9.99" },
    statusCode: 422,
    code: "VALIDATION_FAILED",
    reasonCode: "LAUNCH_BELOW_MIN_PURCHASE",
  },
  {
    name: "claim while the entitlement is FROZEN",
    chainState: {
      ...vesting,
      tuple: { ...vesting.tuple!, entitlementState: "FROZEN" },
    },
    body: { kind: "claim", walletId },
    statusCode: 409,
    code: "DATA_STALE",
    reasonCode: "LAUNCH_CLAIM_NOT_OPEN",
  },
  {
    name: "claim in a refund state",
    chainState: {
      ...vesting,
      tuple: { ...vesting.tuple!, entitlementState: "REFUNDING" },
    },
    body: { kind: "claim", walletId },
    statusCode: 409,
    code: "DATA_STALE",
    reasonCode: "LAUNCH_CLAIM_NOT_OPEN",
  },
  {
    name: "claim while VESTING but PAUSED",
    chainState: {
      ...vesting,
      tuple: { ...vesting.tuple!, operationalState: "PAUSED" },
    },
    body: { kind: "claim", walletId },
    statusCode: 409,
    code: "DATA_STALE",
    reasonCode: "LAUNCH_SALE_PAUSED",
  },
  {
    name: "chain unreadable while building",
    chainState: { unavailable: "LAUNCH_CONTRACT_READ_FAILED" },
    body: { walletId, roundId: roundOneId, payAmount: "10" },
    statusCode: 503,
    code: "CAPABILITY_UNAVAILABLE",
    reasonCode: "LAUNCH_CONTRACT_READ_FAILED",
  },
];

describe("Launch Intent refusals through the PostgreSQL repository (S104)", () => {
  const databaseName = `loop_s104_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let postgresChain: LaunchChainRepository;

  beforeAll(async () => {
    const admin = new Client({
      connectionString: connectionUrl(databaseUrl, "postgres"),
    });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();
    const url = connectionUrl(databaseUrl, databaseName);
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    pool = new Pool({ connectionString: url });
    postgresChain = createPostgresLaunchChainRepository(pool);
    // The fixture principal must exist: createIntent locks its owner row.
    await pool.query({
      text: `insert into public.loop_users (id, privy_user_id) values ($1, $2)`,
      values: [accountId, `did:privy:${randomUUID()}`],
    });
  });

  afterAll(async () => {
    await pool.end();
    const admin = new Client({
      connectionString: connectionUrl(databaseUrl, "postgres"),
    });
    await admin.connect();
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.end();
  });

  function setup(chainState: Partial<FakeLaunchChainState>): LaunchService {
    const state = createFakeLaunchChainState(chainState);
    // Everything but createIntent stays a fixture; the Intent write path is
    // the real PostgreSQL repository (the path the in-memory fake skipped).
    const chain: LaunchChainRepository = {
      ...chainRepositoryFake(),
      createIntent: (input) => postgresChain.createIntent(input),
    };
    return createLaunchService({
      repository: launchRepositoryFor(registeredDetail()),
      cursorCodec: null,
      contract: createFakeLaunchAdapter(state),
      chain,
      wallets: walletsFake(),
      now: () => new Date(Number(fakeNowSeconds) * 1000),
      intentRuntime: {
        writes: writesConfig({}),
        readClient: createFakeLaunchSlotClient({
          usd1Balance: 1_000n * oneUsd1,
          allowance: 1_000n * oneUsd1,
          nativeBalance: 10n ** 17n,
          simulation: "passed",
        }),
        wallets: walletsFake(),
        walletIntentExposureUsd: () => Promise.resolve("0"),
        now: () => new Date(Number(fakeNowSeconds) * 1000),
        createUuid: () => randomUUID(),
      },
    });
  }

  async function storedIntents(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `select count(*)::text as count from public.launch_intents`,
    );
    return Number(result.rows[0]!.count);
  }

  for (const scenario of cases) {
    it(`answers ${scenario.statusCode.toString()} ${scenario.reasonCode}, not 500: ${scenario.name}`, async () => {
      const service = setup(scenario.chainState);
      const before = await storedIntents();
      const error = await rejectionOf(
        service.prepareIntent({
          principal,
          launchId,
          body: scenario.body,
          idempotencyKey: randomUUID(),
          requestId: randomUUID(),
        }),
      );
      expect(error).toBeInstanceOf(V2ApiError);
      const projection = projectV2Error(error, randomUUID());
      const response = projection.response as unknown as Record<
        string,
        unknown
      >;
      expect(projection.statusCode).toBe(scenario.statusCode);
      expect(response["code"]).toBe(scenario.code);
      expect(response["detailsSafe"]).toMatchObject({
        reasonCode: scenario.reasonCode,
      });
      // A refused build stores no Intent.
      expect(await storedIntents()).toBe(before);
    });
  }

  it("passes the exact error a build throws through createIntent", async () => {
    const refusal = V2ApiError.fromCode("DATA_STALE", {
      reasonCode: "LAUNCH_ROUND_NOT_OPEN",
    });
    const plain = new RangeError("caller bug");
    for (const thrown of [refusal, plain]) {
      const error = await rejectionOf(
        postgresChain.createIntent({
          ownerUserId: accountId,
          idempotencyKey: randomUUID(),
          requestSha256: "a".repeat(64),
          build: () => Promise.reject(thrown),
        }),
      );
      expect(error).toBe(thrown);
    }
  });

  it("still maps its own failures to the repository error, with the cause kept for the log", async () => {
    // An owner that does not exist fails inside the repository itself.
    const missingOwner = await rejectionOf(
      postgresChain.createIntent({
        ownerUserId: randomUUID(),
        idempotencyKey: randomUUID(),
        requestSha256: "b".repeat(64),
        build: () => Promise.reject(new Error("build must not run")),
      }),
    );
    expect(missingOwner).toBeInstanceOf(LaunchChainRepositoryUnavailableError);
    // Its response is unchanged: a bare 500 INTERNAL_ERROR.
    const projection = projectV2Error(missingOwner, randomUUID());
    expect(projection.statusCode).toBe(500);
    expect(projection.response.code).toBe("INTERNAL_ERROR");

    const malformed = await rejectionOf(
      postgresChain.createIntent({
        ownerUserId: "not-a-uuid",
        idempotencyKey: randomUUID(),
        requestSha256: "b".repeat(64),
        build: () => Promise.reject(new Error("build must not run")),
      }),
    );
    expect(malformed).toBeInstanceOf(LaunchChainRepositoryUnavailableError);
    expect((malformed as Error).cause).toBeInstanceOf(Error);
    expect(summarizeErrorForLog(malformed).errorCause?.[0]?.errorName).toBe(
      "ZodError",
    );
  });
});
