import type { FastifyInstance } from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AccountWalletRepository } from "../src/database/account-wallet-repository.js";
import type { Database } from "../src/database/database.js";
import type { HooksLaunchFactoryReader } from "../src/features/launch/hooks-launch-deployment.js";
import {
  HooksLaunchProjectNotFoundError,
  HooksLaunchProjectVersionConflictError,
  type HooksLaunchProjectConfigRecord,
  type HooksLaunchProjectConfigRepository,
} from "../src/features/launch/hooks-launch-project-config.js";
import {
  HooksLaunchSubmissionError,
  type HooksLaunchDeploymentJob,
  type HooksLaunchSubmissionRepository,
} from "../src/features/launch/hooks-launch-submission.js";
import { createUnavailableLaunchRepository } from "../src/features/launch/launch-repository.js";
import {
  s7AccountId,
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0108: route contract for the Hooks launch port (requirer branch
 * original Decisions 0090 / 0095 / 0097). Every route is 503
 * HOOKS_LAUNCH_DISABLED until HOOKS_LAUNCH_ENABLED=on.
 */

const projectId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const foreignProjectId = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
const walletId = "00000000-0000-4000-8000-000000000099";
const jobId = "00000000-0000-4000-8000-000000000011";
const createdAt = "2026-10-09T00:00:00.000Z";
const signer = privateKeyToAccount(`0x${"01".repeat(32)}`);
const enabled = { HOOKS_LAUNCH_ENABLED: "on" } as const;

const draftBody = {
  name: "MoonCat",
  ticker: "MCAT",
  logoAssetUrl: "https://cdn.example.com/logo.png",
  description: "A launch project",
  links: ["https://mooncat.example"],
  nftSaleStartAt: "4000000000",
  buybackRecipient: "0x1234567890123456789012345678901234567890",
};

function configRepositoryFake(): HooksLaunchProjectConfigRepository {
  let record: HooksLaunchProjectConfigRecord | null = null;
  return {
    getOwnedDraft(input) {
      return Promise.resolve(
        input.projectId === projectId && input.ownerUserId === s7AccountId
          ? record
          : null,
      );
    },
    saveOwnedDraft(input) {
      if (input.projectId !== projectId || input.ownerUserId !== s7AccountId) {
        return Promise.reject(new HooksLaunchProjectNotFoundError());
      }
      if ((record?.version ?? 0) !== input.expectedVersion) {
        return Promise.reject(new HooksLaunchProjectVersionConflictError());
      }
      record = Object.freeze({
        projectId,
        ownerUserId: s7AccountId,
        version: input.expectedVersion + 1,
        templateVersion: input.templateVersion,
        config: input.config,
        updatedAt: createdAt,
      });
      return Promise.resolve(record);
    },
  };
}

const wallets = {
  get: (ownerUserId: string, requestedWalletId: string) =>
    Promise.resolve(
      ownerUserId === s7AccountId && requestedWalletId === walletId
        ? {
            walletId,
            providerWalletId: "privy-wallet-1",
            address: signer.address,
            kind: "embedded" as const,
            status: "active" as const,
            isActive: true,
            firstSeenAt: createdAt,
            lastSeenAt: createdAt,
          }
        : null,
    ),
} as unknown as AccountWalletRepository;

const factoryReader: HooksLaunchFactoryReader = {
  factoryAddress: "0x1111111111111111111111111111111111111111",
  chainId: 97,
  nonce: () => Promise.resolve(9n),
  nftSaleDuration: () => Promise.resolve({ seconds: 604_800, legacy: false }),
  tokenDeployment: () =>
    Promise.resolve({
      deployer: "0x5555555555555555555555555555555555555555",
      initCodeHash: `0x${"ef".repeat(32)}`,
    }),
  hookDeployment: () =>
    Promise.resolve({
      deployer: "0x4444444444444444444444444444444444444444",
      initCodeHash: `0x${"ab".repeat(32)}`,
    }),
};

const job: HooksLaunchDeploymentJob = Object.freeze({
  jobId,
  projectId,
  configVersion: 1,
  chainId: 97,
  factoryAddress: factoryReader.factoryAddress,
  status: "awaiting_executor",
  memeAddress: `0x${"ab".repeat(18)}6666`,
  hookAddress: `0x${"ab".repeat(18)}20cc`,
  txHash: null,
  confirmations: null,
  activationTxHash: null,
  addresses: {
    predicted: {
      meme: `0x${"ab".repeat(18)}6666`,
      hook: `0x${"ab".repeat(18)}20cc`,
    },
    deployed: null,
  },
  failure: null,
  attemptCount: 0,
  events: [
    {
      sequence: 1,
      fromStatus: null,
      toStatus: "awaiting_executor" as const,
      kind: "created",
      txHash: null,
      blockNumber: null,
      blockHash: null,
      confirmations: null,
      errorCode: null,
      createdAt,
    },
  ],
  createdAt,
  updatedAt: createdAt,
});

function submissionsFake(
  overrides: Partial<HooksLaunchSubmissionRepository> = {},
): HooksLaunchSubmissionRepository {
  return {
    getOwned: (owner, pid, id) =>
      Promise.resolve(
        owner === s7AccountId && pid === projectId && id === jobId ? job : null,
      ),
    cancelOwned: (owner, pid, id) =>
      Promise.resolve(
        owner === s7AccountId && pid === projectId && id === jobId
          ? { ...job, status: "cancelled" as const }
          : null,
      ),
    findReplay: () => Promise.resolve(null),
    accept: (input) =>
      Promise.resolve({
        ...job,
        memeAddress: input.memeAddress,
        hookAddress: input.hookAddress,
      }),
    ...overrides,
  };
}

describe("LOOP API V2 Hooks launch routes (Decision 0108)", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    options: {
      readonly overrides?: Readonly<Record<string, string>>;
      readonly configs?: HooksLaunchProjectConfigRepository;
      readonly submissions?: HooksLaunchSubmissionRepository;
      readonly reader?: HooksLaunchFactoryReader;
    } = {},
  ) {
    const database: Database = {
      ...s7Database({ launch: createUnavailableLaunchRepository() }),
      accountWallets: wallets,
      ...(options.configs === undefined
        ? {}
        : { hooksLaunchProjectConfigs: options.configs }),
      ...(options.submissions === undefined
        ? {}
        : { hooksLaunchSubmissions: options.submissions }),
    };
    const app = await buildApp({
      config: s7TestConfig(options.overrides ?? enabled),
      contractSurface: "v2",
      database,
      ...(options.reader === undefined
        ? {}
        : { hooksLaunchFactoryReader: options.reader }),
      privyAccessTokenVerifier: s7PrivyVerifier(),
      logger: false,
    });
    apps.push(app);
    return app;
  }

  async function saveDraft(app: FastifyInstance) {
    const saved = await app.inject({
      method: "PUT",
      url: `/v2/launch/projects/${projectId}/hooks-config`,
      headers: s7CommonHeaders(),
      payload: { expectedVersion: 0, config: draftBody },
    });
    expect(saved.statusCode).toBe(200);
    return saved;
  }

  async function signedSubmission(app: FastifyInstance) {
    const prepared = await app.inject({
      url: `/v2/launch/projects/${projectId}/hooks-config/signing-request?walletId=${walletId}`,
      headers: s7CommonHeaders(),
    });
    expect(prepared.statusCode).toBe(200);
    const body = prepared.json<{
      readonly request: Record<string, unknown> & {
        readonly nftSaleStart: string;
        readonly deadline: string;
        readonly nonce: string;
      };
      readonly typedData: {
        readonly domain: Record<string, unknown>;
        readonly types: Record<string, unknown>;
        readonly primaryType: "LaunchRequest";
        readonly message: Record<string, unknown> & {
          readonly nftSaleStart: string;
          readonly deadline: string;
          readonly nonce: string;
        };
      };
      readonly hookSalt: string;
    }>();
    const message = body.typedData.message;
    const signature = await signer.signTypedData({
      domain: body.typedData.domain,
      types: body.typedData.types,
      primaryType: body.typedData.primaryType,
      message: {
        ...message,
        nftSaleStart: BigInt(message.nftSaleStart),
        deadline: BigInt(message.deadline),
        nonce: BigInt(message.nonce),
      },
    });
    return {
      walletId,
      request: body.request,
      hookSalt: body.hookSalt,
      signature,
    };
  }

  it("answers 503 HOOKS_LAUNCH_DISABLED on every hooks route while the switch is off", async () => {
    const app = await createApp({
      overrides: {},
      configs: configRepositoryFake(),
      submissions: submissionsFake(),
      reader: factoryReader,
    });
    const base = `/v2/launch/projects/${projectId}`;
    const requests = [
      { method: "GET" as const, url: `${base}/hooks-config` },
      {
        method: "PUT" as const,
        url: `${base}/hooks-config`,
        payload: { expectedVersion: 0, config: draftBody },
      },
      {
        method: "GET" as const,
        url: `${base}/hooks-config/signing-request?walletId=${walletId}`,
      },
      {
        method: "POST" as const,
        url: `${base}/hooks-deployments`,
        command: true,
        payload: {
          walletId,
          request: {
            projectOwner: signer.address,
            configVersion: 1,
            configHash: `0x${"cd".repeat(32)}`,
            name: "MoonCat",
            ticker: "MCAT",
            nftSaleStart: "4000000000",
            buybackRecipient: draftBody.buybackRecipient,
            deadline: "1",
            memeSalt: `0x${"00".repeat(32)}`,
            nonce: "0",
          },
          hookSalt: `0x${"00".repeat(32)}`,
          signature: `0x${"11".repeat(65)}`,
        },
      },
      { method: "GET" as const, url: `${base}/hooks-deployments/${jobId}` },
      {
        method: "DELETE" as const,
        url: `${base}/hooks-deployments/${jobId}`,
        command: true,
      },
    ];
    for (const request of requests) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: "command" in request ? s7CommandHeaders() : s7CommonHeaders(),
        ...("payload" in request ? { payload: request.payload } : {}),
      });
      expect(response.statusCode, request.url).toBe(503);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: { reasonCode: "HOOKS_LAUNCH_DISABLED" },
      });
      expect(
        Object.keys(response.json<Record<string, unknown>>()).sort(),
      ).toEqual([
        "category",
        "code",
        "correlationId",
        "detailsSafe",
        "providerReferenceSafe",
        "retryable",
        "userMessageKey",
      ]);
    }
  });

  it("fails closed when enabled without a database repository", async () => {
    const app = await createApp();
    const response = await app.inject({
      url: `/v2/launch/projects/${projectId}/hooks-config`,
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "HOOKS_LAUNCH_DISABLED" },
    });
  });

  it("saves and reads an owner-scoped draft with server-derived economics", async () => {
    const app = await createApp({
      configs: configRepositoryFake(),
      reader: factoryReader,
    });
    const empty = await app.inject({
      url: `/v2/launch/projects/${projectId}/hooks-config`,
      headers: s7CommonHeaders(),
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ draft: null, contractVersion: "2.0" });

    const saved = await saveDraft(app);
    expect(saved.headers["cache-control"]).toBe("no-store");
    const savedBody = saved.json<{
      readonly config: {
        readonly configHash: string;
        readonly buybackRecipient: string;
        readonly fixedEconomics: Record<string, unknown>;
      };
    }>();
    expect(savedBody).toMatchObject({
      projectId,
      version: 1,
      templateVersion: "hooks_launch_v1",
      config: {
        fixedEconomics: {
          curveBuyTaxBps: 1_000,
          memeTotalSupplyRaw: "1000000000000000000000000000",
          graduationReserveUsd1Raw: "133333332000000000000000",
        },
      },
    });
    expect(savedBody.config.configHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(savedBody.config.buybackRecipient).toBe(
      draftBody.buybackRecipient.toLowerCase(),
    );

    const read = await app.inject({
      url: `/v2/launch/projects/${projectId}/hooks-config`,
      headers: s7CommonHeaders(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ draft: { version: number } }>().draft.version).toBe(1);
  });

  it("maps stale CAS, foreign projects, overrides and Idempotency-Key to the V2 error family", async () => {
    const app = await createApp({
      configs: configRepositoryFake(),
      reader: factoryReader,
    });
    await saveDraft(app);
    const stale = await app.inject({
      method: "PUT",
      url: `/v2/launch/projects/${projectId}/hooks-config`,
      headers: s7CommonHeaders(),
      payload: { expectedVersion: 0, config: draftBody },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT" });

    const foreign = await app.inject({
      method: "PUT",
      url: `/v2/launch/projects/${foreignProjectId}/hooks-config`,
      headers: s7CommonHeaders(),
      payload: { expectedVersion: 0, config: draftBody },
    });
    expect(foreign.statusCode).toBe(404);

    const override = await app.inject({
      method: "PUT",
      url: `/v2/launch/projects/${projectId}/hooks-config`,
      headers: s7CommonHeaders(),
      payload: {
        expectedVersion: 1,
        config: { ...draftBody, curveBuyTaxBps: 0 },
      },
    });
    expect(override.statusCode).toBe(400);
    expect(override.json()).toMatchObject({ code: "INVALID_REQUEST" });

    const tooSoon = await app.inject({
      method: "PUT",
      url: `/v2/launch/projects/${projectId}/hooks-config`,
      headers: s7CommonHeaders(),
      payload: {
        expectedVersion: 1,
        config: { ...draftBody, nftSaleStartAt: "1" },
      },
    });
    expect(tooSoon.statusCode).toBe(400);

    const keyed = await app.inject({
      method: "PUT",
      url: `/v2/launch/projects/${projectId}/hooks-config`,
      headers: s7CommandHeaders(),
      payload: { expectedVersion: 1, config: draftBody },
    });
    expect(keyed.statusCode).toBe(400);

    const unsigned = await app.inject({
      url: `/v2/launch/projects/${projectId}/hooks-config`,
      headers: s7CommonHeaders({ authorization: undefined }),
    });
    expect(unsigned.statusCode).toBe(401);
  });

  it("returns owner-wallet EIP-712 data and CREATE2 salts without signing", async () => {
    const app = await createApp({
      configs: configRepositoryFake(),
      reader: factoryReader,
    });
    await saveDraft(app);
    const response = await app.inject({
      url: `/v2/launch/projects/${projectId}/hooks-config/signing-request?walletId=${walletId}`,
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      request: {
        projectOwner: signer.address.toLowerCase(),
        configVersion: 1,
        nonce: "9",
      },
      typedData: {
        domain: {
          name: "LOOP Launch Factory",
          version: "1",
          chainId: 97,
          verifyingContract: factoryReader.factoryAddress,
        },
        primaryType: "LaunchRequest",
      },
    });
    const result = response.json<{
      readonly hookAddress: string;
      readonly hookSalt: string;
      readonly memeAddress: string;
    }>();
    expect(BigInt(result.hookAddress) & 0x3fffn).toBe(0x20ccn);
    expect(result.hookAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(result.memeAddress.endsWith("6666")).toBe(true);
    expect(result.hookSalt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(response.body).not.toContain("signature");

    const foreignWallet = await app.inject({
      url: `/v2/launch/projects/${projectId}/hooks-config/signing-request?walletId=00000000-0000-4000-8000-000000000098`,
      headers: s7CommonHeaders(),
    });
    expect(foreignWallet.statusCode).toBe(400);

    const foreignProject = await app.inject({
      url: `/v2/launch/projects/${foreignProjectId}/hooks-config/signing-request?walletId=${walletId}`,
      headers: s7CommonHeaders(),
    });
    expect(foreignProject.statusCode).toBe(404);
  }, 60_000);

  it("answers HOOKS_LAUNCH_FACTORY_UNAVAILABLE without a configured Factory or on a failed read", async () => {
    // Decision 0119: without a Factory the configHash cannot bind the sale
    // period, so the draft save is unavailable too (never a constant).
    const missing = await createApp({ configs: configRepositoryFake() });
    const unsaved = await missing.inject({
      method: "PUT",
      url: `/v2/launch/projects/${projectId}/hooks-config`,
      headers: s7CommonHeaders(),
      payload: { expectedVersion: 0, config: draftBody },
    });
    expect(unsaved.statusCode).toBe(503);
    expect(unsaved.json()).toMatchObject({
      detailsSafe: { reasonCode: "HOOKS_LAUNCH_FACTORY_UNAVAILABLE" },
    });
    const response = await missing.inject({
      url: `/v2/launch/projects/${projectId}/hooks-config/signing-request?walletId=${walletId}`,
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      detailsSafe: { reasonCode: "HOOKS_LAUNCH_FACTORY_UNAVAILABLE" },
    });

    const failing = await createApp({
      configs: configRepositoryFake(),
      reader: {
        ...factoryReader,
        nonce: () =>
          Promise.reject(new Error("Hooks launch factory read unavailable")),
      },
    });
    await saveDraft(failing);
    const failed = await failing.inject({
      url: `/v2/launch/projects/${projectId}/hooks-config/signing-request?walletId=${walletId}`,
      headers: s7CommonHeaders(),
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("rpc");
  });

  it("binds the draft to the Factory sale period and refuses a config hashed for another Factory (Decision 0119)", async () => {
    const configs = configRepositoryFake();
    const hourly: HooksLaunchFactoryReader = {
      ...factoryReader,
      nftSaleDuration: () => Promise.resolve({ seconds: 3_600, legacy: false }),
    };
    // Saved against the 7-day Factory: the mainnet template, unchanged.
    const weekly = await createApp({ configs, reader: factoryReader });
    const saved = (await saveDraft(weekly)).json<{
      config: { fixedEconomics: { nftSaleDurationSeconds: number } };
    }>();
    expect(saved.config.fixedEconomics.nftSaleDurationSeconds).toBe(604_800);

    // The target Factory now runs a 1-hour sale: prepare fails closed.
    const swapped = await createApp({ configs, reader: hourly });
    const refused = await swapped.inject({
      url: `/v2/launch/projects/${projectId}/hooks-config/signing-request?walletId=${walletId}`,
      headers: s7CommonHeaders(),
    });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "HOOKS_FACTORY_TEMPLATE_MISMATCH" },
    });
  });

  it("records a verified project-signed task and requires an Idempotency-Key", async () => {
    const fake = submissionsFake();
    const accept = vi.fn((input: Parameters<typeof fake.accept>[0]) =>
      fake.accept(input),
    );
    const app = await createApp({
      configs: configRepositoryFake(),
      reader: factoryReader,
      submissions: submissionsFake({ accept }),
    });
    await saveDraft(app);
    const payload = await signedSubmission(app);

    const unkeyed = await app.inject({
      method: "POST",
      url: `/v2/launch/projects/${projectId}/hooks-deployments`,
      headers: s7CommonHeaders(),
      payload,
    });
    expect(unkeyed.statusCode).toBe(400);
    expect(accept).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: `/v2/launch/projects/${projectId}/hooks-deployments`,
      headers: s7CommandHeaders(),
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      jobId,
      status: "awaiting_executor",
      chainId: 97,
    });
    expect(response.body).not.toContain(payload.signature.slice(2));
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept.mock.calls[0]![0]).toMatchObject({
      ownerUserId: s7AccountId,
      projectId,
      factoryAddress: factoryReader.factoryAddress,
    });

    const tampered = await app.inject({
      method: "POST",
      url: `/v2/launch/projects/${projectId}/hooks-deployments`,
      headers: s7CommandHeaders(),
      payload: {
        ...payload,
        request: { ...payload.request, name: "Other" },
      },
    });
    expect(tampered.statusCode).toBe(409);
    expect(accept).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("maps an unapproved config to POLICY_BLOCKED", async () => {
    const notApproved = await createApp({
      configs: configRepositoryFake(),
      reader: factoryReader,
      submissions: submissionsFake({
        accept: () =>
          Promise.reject(new HooksLaunchSubmissionError("not_approved")),
      }),
    });
    await saveDraft(notApproved);
    const payload = await signedSubmission(notApproved);
    const blocked = await notApproved.inject({
      method: "POST",
      url: `/v2/launch/projects/${projectId}/hooks-deployments`,
      headers: s7CommandHeaders(),
      payload,
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({
      code: "POLICY_BLOCKED",
      detailsSafe: { reasonCode: "HOOKS_CONFIG_NOT_APPROVED" },
    });
  }, 60_000);

  it("maps a reused Idempotency-Key with another body to IDEMPOTENCY_CONFLICT", async () => {
    const replayed = await createApp({
      configs: configRepositoryFake(),
      reader: factoryReader,
      submissions: submissionsFake({
        findReplay: () =>
          Promise.resolve({ fingerprint: `0x${"99".repeat(32)}`, job }),
      }),
    });
    await saveDraft(replayed);
    const replayPayload = await signedSubmission(replayed);
    const conflict = await replayed.inject({
      method: "POST",
      url: `/v2/launch/projects/${projectId}/hooks-deployments`,
      headers: s7CommandHeaders(),
      payload: replayPayload,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  }, 60_000);

  it("returns executor progress and refuses to cancel a claimed task (Decision 0112)", async () => {
    const txHash = `0x${"cd".repeat(32)}`;
    const deployedJob: HooksLaunchDeploymentJob = {
      ...job,
      status: "activated",
      txHash,
      confirmations: 3,
      activationTxHash: `0x${"ef".repeat(32)}`,
      addresses: {
        predicted: job.addresses.predicted,
        deployed: {
          launchId: `0x${"12".repeat(32)}`,
          meme: job.memeAddress,
          hook: job.hookAddress,
          nft: `0x${"01".repeat(20)}`,
          curve: `0x${"02".repeat(20)}`,
          gate: `0x${"03".repeat(20)}`,
          escrow: `0x${"04".repeat(20)}`,
          snapshots: `0x${"05".repeat(20)}`,
          graduationAdapter: `0x${"06".repeat(20)}`,
          buybackAdapter: `0x${"07".repeat(20)}`,
          priceRecorder: `0x${"08".repeat(20)}`,
          buybackExecutor: `0x${"09".repeat(20)}`,
        },
      },
      attemptCount: 1,
      events: [
        ...job.events,
        {
          sequence: 2,
          fromStatus: "claimed",
          toStatus: "broadcast",
          kind: "broadcast",
          txHash,
          blockNumber: null,
          blockHash: null,
          confirmations: null,
          errorCode: null,
          createdAt,
        },
        {
          sequence: 3,
          fromStatus: "broadcast",
          toStatus: "confirmed",
          kind: "confirmed",
          txHash,
          blockNumber: "123456",
          blockHash: `0x${"aa".repeat(32)}`,
          confirmations: 3,
          errorCode: null,
          createdAt,
        },
      ],
    };
    const app = await createApp({
      submissions: submissionsFake({
        getOwned: () => Promise.resolve(deployedJob),
        cancelOwned: () =>
          Promise.reject(new HooksLaunchSubmissionError("not_cancellable")),
      }),
    });
    const url = `/v2/launch/projects/${projectId}/hooks-deployments/${jobId}`;
    const read = await app.inject({ url, headers: s7CommonHeaders() });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(deployedJob);
    expect(read.body).not.toMatch(/signature|raw/iu);

    const cancel = await app.inject({
      method: "DELETE",
      url,
      headers: s7CommandHeaders(),
    });
    expect(cancel.statusCode).toBe(409);
    expect(Object.keys(cancel.json()).sort()).toEqual([
      "category",
      "code",
      "correlationId",
      "detailsSafe",
      "providerReferenceSafe",
      "retryable",
      "userMessageKey",
    ]);
    expect(cancel.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      detailsSafe: { reasonCode: "HOOKS_DEPLOYMENT_NOT_CANCELLABLE" },
    });
  });

  it("keeps task reads owner-scoped and cancellation distinct from broadcast", async () => {
    const app = await createApp({ submissions: submissionsFake() });
    const url = `/v2/launch/projects/${projectId}/hooks-deployments/${jobId}`;
    const read = await app.inject({ url, headers: s7CommonHeaders() });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(job);
    expect(read.body).not.toContain("signature");

    const cancelled = await app.inject({
      method: "DELETE",
      url,
      headers: s7CommandHeaders(),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<{ status: string }>().status).toBe("cancelled");

    const unkeyedCancel = await app.inject({
      method: "DELETE",
      url,
      headers: s7CommonHeaders(),
    });
    expect(unkeyedCancel.statusCode).toBe(400);

    const foreign = await app.inject({
      url: url.replace(jobId, "00000000-0000-4000-8000-000000000012"),
      headers: s7CommonHeaders(),
    });
    expect(foreign.statusCode).toBe(404);

    const unsigned = await app.inject({
      url,
      headers: s7CommonHeaders({ authorization: undefined }),
    });
    expect(unsigned.statusCode).toBe(401);
  });
});
