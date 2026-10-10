import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  type Address,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadReconciliationWorkerConfig } from "../src/config.js";
import { createPostgresAdminLaunchReviewRepository } from "../src/database/admin-launch-repository.js";
import type { AccountWalletRepository } from "../src/database/account-wallet-repository.js";
import { createPostgresHooksLaunchExecutorRepository } from "../src/database/hooks-launch-executor-repository.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { createHooksLaunchDeploymentService } from "../src/features/launch/hooks-launch-deployment.js";
import {
  createHooksLaunchExecutor,
  type HooksLaunchExecutor,
  type HooksLaunchExecutorChain,
  type HooksLaunchExecutorPolicy,
} from "../src/features/launch/hooks-launch-executor.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { createHooksLaunchSubmissionService } from "../src/features/launch/hooks-launch-submission.js";
import { createHooksLaunchExecutorChain } from "../src/integrations/launch/hooks-launch-executor-chain.js";
import { createHooksLaunchFactoryReader } from "../src/integrations/launch/hooks-launch-factory-reader.js";
import { launchPublicationGateAbi } from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
import {
  anvilPrivateKey,
  deployProtocol,
  locateFoundry,
  startAnvil,
  type AnvilChain,
  type DeployedProtocol,
} from "./helpers/anvil.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0112 end to end on a local `anvil --chain-id 97`: the real
 * loop-contracts Foundry scripts deploy PoolManager + tUSD1 and the
 * LoopLaunchFactory (roles = anvil default accounts); the API services
 * save, approve, prepare, sign, and submit a Hooks launch into a throwaway
 * PostgreSQL database; the executor deploys, follows confirmations,
 * verifies every module, and activates. Also: a receipt reorg (re-send of
 * the same transaction), a verification mismatch (failed, never
 * activated), an expired signature (failed, never broadcast), an
 * unauthorized executor key (idle), and a missing executor key (boot
 * refused). Skips with the reason when anvil/forge/loop-contracts are
 * absent.
 */

const foundry = locateFoundry();
const skipReason = typeof foundry === "string" ? foundry : null;
if (skipReason !== null) {
  process.stderr.write(`[skip] Hooks executor anvil suite: ${skipReason}\n`);
}

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

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: connectionUrl(databaseUrl, "postgres"),
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

const policy: HooksLaunchExecutorPolicy = {
  factoryCodeHash: "",
  confirmations: 3,
  maxAttempts: 3,
  retryDelaySeconds: 10,
  gasLimitCap: 30_000_000n,
  maxGasPriceWei: 100n * 10n ** 9n,
  deadlineMarginSeconds: 60,
  activationMarginSeconds: 120,
  tasksPerTick: 8,
};

describe.skipIf(skipReason !== null)(
  "Decision 0112 Hooks deployment executor on anvil (chain 97)",
  () => {
    const databaseName = `loop_s132_${randomUUID().replaceAll("-", "")}`;
    let pool: InstanceType<typeof Pool>;
    let chain: AnvilChain;
    let deployed: DeployedProtocol;
    let factoryCodeHash: string;
    let executorPolicy: HooksLaunchExecutorPolicy;
    const owners = new Map<string, `0x${string}`>();

    beforeAll(async () => {
      if (typeof foundry === "string") return;
      chain = await startAnvil(foundry);
      deployed = deployProtocol(foundry, chain.rpcUrl);
      const code = await chain.request<string>("eth_getCode", [
        deployed.factory,
        "latest",
      ]);
      factoryCodeHash = keccak256(code as `0x${string}`).toLowerCase();
      executorPolicy = { ...policy, factoryCodeHash };
      await admin((client) =>
        client.query(`create database "${databaseName}"`),
      );
      const url = connectionUrl(databaseUrl, databaseName);
      await runner({
        databaseUrl: url,
        dir: migrationsDirectory,
        direction: "up",
        migrationsTable: "pgmigrations",
        log: () => undefined,
      });
      pool = new Pool({ connectionString: url });
    }, 900_000);

    afterAll(async () => {
      if (typeof foundry === "string") return;
      await pool.end();
      await chain.stop();
      await admin((client) =>
        client.query(`drop database if exists "${databaseName}" with (force)`),
      );
    });

    const wallets = {
      get: (ownerUserId: string, walletId: string) => {
        const key = owners.get(ownerUserId);
        return Promise.resolve(
          key === undefined || walletId !== `wallet-${ownerUserId}`
            ? null
            : {
                walletId,
                providerWalletId: null,
                address: privateKeyToAccount(key).address,
                kind: "embedded" as const,
                status: "active" as const,
                isActive: true,
                firstSeenAt: new Date().toISOString(),
                lastSeenAt: new Date().toISOString(),
              },
        );
      },
    } as unknown as AccountWalletRepository;

    function reader() {
      return createHooksLaunchFactoryReader({
        factoryAddress: deployed.factory,
        expectedRuntimeCodeHash: factoryCodeHash,
        rpcUrls: [chain.rpcUrl],
      });
    }

    async function user(): Promise<string> {
      const result = await pool.query<{ id: string }>(
        "insert into public.loop_users (privy_user_id) values ($1) returning id",
        [`did:privy:hooks-s132:${randomUUID()}`],
      );
      return result.rows[0]!.id;
    }

    /** Owner draft → independent approval → EIP-712 signature → task. */
    async function submittedTask(ticker: string): Promise<{
      readonly ownerUserId: string;
      readonly projectId: string;
      readonly jobId: string;
      readonly deadline: bigint;
    }> {
      const ownerUserId = await user();
      const ownerKey = generatePrivateKey();
      owners.set(ownerUserId, ownerKey);
      const projectId = randomUUID();
      await pool.query(
        "insert into public.launch_projects (project_id, owner_user_id, name, ticker, review_status, submitted_at, reviewed_at) values ($1, $2, $3, $4, 'approved', now(), now())",
        [projectId, ownerUserId, `Project ${ticker}`, ticker],
      );
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const draft = parseHooksLaunchDraft(
        {
          name: `Project ${ticker}`,
          ticker,
          logoAssetUrl: "https://example.com/logo.png",
          description: "S132 executor",
          links: [],
          nftSaleStartAt: String(nowSeconds + 2 * 86_400),
          buybackRecipient: "0x3333333333333333333333333333333333333333",
        },
        { nowUnixSeconds: String(nowSeconds), minimumLeadSeconds: 86_400 },
      );
      const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
      await configs.saveOwnedDraft({
        projectId,
        ownerUserId,
        expectedVersion: 0,
        templateVersion: draft.templateVersion,
        configHash: draft.configHash,
        config: draft,
        updatedByUserId: ownerUserId,
      });
      const approver = await user();
      await pool.query(
        "insert into public.ops_operators (user_id, label, enabled) values ($1, 'Reviewer', true)",
        [approver],
      );
      await pool.query(
        "insert into public.ops_grants (user_id, permission, scope) values ($1, 'launch.approve', '*')",
        [approver],
      );
      await createPostgresHooksLaunchReviewRepository(pool, {
        now: () => Math.floor(Date.now() / 1_000),
      }).execute(
        approver,
        hooksLaunchReviewCommandSchema.parse({
          operationId: randomUUID(),
          action: "launch.config.approve",
          target: projectId,
          reason: "Independent hash review",
          payload: { configVersion: 1, configHash: draft.configHash },
        }),
      );
      const walletId = `wallet-${ownerUserId}`;
      const prepared = await createHooksLaunchDeploymentService({
        configs,
        wallets,
        reader: reader(),
        signatureLifetimeSeconds: 900,
        maxSaltAttempts: 2_000_000,
      }).prepareSigningRequest({ ownerUserId, projectId, walletId });
      const message = prepared.typedData.message;
      const signature = await privateKeyToAccount(ownerKey).signTypedData({
        domain: prepared.typedData.domain,
        types: prepared.typedData.types,
        primaryType: prepared.typedData.primaryType,
        message: {
          ...message,
          nftSaleStart: BigInt(message.nftSaleStart),
          deadline: BigInt(message.deadline),
          nonce: BigInt(message.nonce),
        },
      });
      const job = await createHooksLaunchSubmissionService({
        configs,
        wallets,
        reader: reader(),
        repository: createPostgresHooksLaunchSubmissionRepository(pool),
      }).submit({
        ownerUserId,
        projectId,
        idempotencyKey: randomUUID(),
        body: {
          walletId,
          request: prepared.request,
          hookSalt: prepared.hookSalt,
          signature,
        },
      });
      expect(job.status).toBe("awaiting_executor");
      return {
        ownerUserId,
        projectId,
        jobId: job.jobId,
        deadline: BigInt(prepared.request.deadline),
      };
    }

    function executor(
      options: {
        readonly chainClient?: HooksLaunchExecutorChain;
        readonly now?: () => number;
        readonly key?: `0x${string}`;
      } = {},
    ): HooksLaunchExecutor {
      return createHooksLaunchExecutor({
        repository: createPostgresHooksLaunchExecutorRepository(pool, {
          leaseSeconds: 60,
        }),
        chain:
          options.chainClient ??
          createHooksLaunchExecutorChain({
            privateKey: options.key ?? deployed.executorKey,
            factoryAddress: deployed.factory,
            rpcUrls: [chain.rpcUrl],
          }),
        policy: executorPolicy,
        executorId: `hooks-executor:test:${randomUUID().slice(0, 8)}`,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    }

    async function job(ownerUserId: string, projectId: string, id: string) {
      const found = await createPostgresHooksLaunchSubmissionRepository(
        pool,
      ).getOwned(ownerUserId, projectId, id);
      if (found === null) throw new Error("task missing");
      return found;
    }

    async function executorNonce(): Promise<bigint> {
      const count = await chain.request<string>("eth_getTransactionCount", [
        privateKeyToAccount(deployed.executorKey).address,
        "latest",
      ]);
      return BigInt(count);
    }

    async function published(gate: string): Promise<boolean> {
      const client = createPublicClient({
        chain: bscTestnet,
        transport: http(chain.rpcUrl),
      });
      return client.readContract({
        address: gate as Address,
        abi: launchPublicationGateAbi,
        functionName: "published",
      });
    }

    /** Ticks until the task reaches `status` or the tick budget runs out. */
    async function drive(
      runner_: HooksLaunchExecutor,
      read: () => Promise<{ readonly status: string }>,
      status: string,
      budget = 12,
    ): Promise<void> {
      for (let tick = 0; tick < budget; tick += 1) {
        const result = await runner_.runOnce();
        expect(result.idleReason).toBeNull();
        if ((await read()).status === status) return;
        await chain.mine(1);
      }
      throw new Error(`task did not reach ${status}: ${(await read()).status}`);
    }

    it("deploys, confirms, verifies every module, and activates a signed launch", async () => {
      const task = await submittedTask("HAPPY");
      const read = () => job(task.ownerUserId, task.projectId, task.jobId);
      const run = executor();

      const first = await run.runOnce();
      expect(first.idleReason).toBeNull();
      let current = await read();
      expect(current.status).toBe("broadcast");
      expect(current.txHash).toMatch(/^0x[0-9a-f]{64}$/u);
      const deployTx = current.txHash;
      // The hash was persisted before sending; the next tick sees the block.
      await run.runOnce();
      current = await read();
      expect(current.status).toBe("broadcast");
      expect(current.confirmations).toBe(1);
      expect(current.events.at(-1)?.kind).toBe("included");

      await chain.mine(2);
      await run.runOnce();
      current = await read();
      // confirmed → verified → activation broadcast in one tick.
      expect(current.status).toBe("verified");
      expect(current.activationTxHash).toMatch(/^0x[0-9a-f]{64}$/u);
      expect(current.addresses.deployed?.meme).toBe(
        current.addresses.predicted.meme,
      );
      expect(current.addresses.deployed?.hook).toBe(
        current.addresses.predicted.hook,
      );
      expect(current.addresses.deployed?.meme.endsWith("6666")).toBe(true);
      const gate = current.addresses.deployed!.gate;
      expect(await published(gate)).toBe(true); // mined, not yet confirmed

      await drive(run, read, "activated");
      current = await read();
      expect(current.status).toBe("activated");
      expect(current.txHash).toBe(deployTx);
      expect(await published(gate)).toBe(true);
      expect(current.events.map((event) => event.kind)).toEqual([
        "created",
        "claimed",
        "broadcast",
        "included",
        "confirmed",
        "verified",
        "activation_broadcast",
        "activation_included",
        "activated",
      ]);
      expect(JSON.stringify(current)).not.toMatch(/raw|signature/iu);

      const detail = await createPostgresAdminLaunchReviewRepository(
        pool,
      ).getProject({ projectId: task.projectId, scope: "*" });
      expect(detail?.project.stage).toBe("activated");
      expect(detail?.project.activeDeploymentJobId).toBeNull();
      const adminTask = detail?.deploymentTasks[0];
      expect(adminTask?.status).toBe("activated");
      expect(adminTask?.verifiedChecks.length).toBe(28);
      expect(adminTask?.activatedAt).not.toBeNull();
    }, 300_000);

    it("re-sends the same transaction after its receipt block is reorged out", async () => {
      const task = await submittedTask("REORG");
      const read = () => job(task.ownerUserId, task.projectId, task.jobId);
      const run = executor();
      await run.runOnce();
      await run.runOnce();
      const before = await read();
      expect(before.status).toBe("broadcast");
      expect(before.events.at(-1)?.kind).toBe("included");
      const nonceBefore = await executorNonce();

      await chain.request("anvil_reorg", [1, []]);
      expect(await executorNonce()).toBe(nonceBefore - 1n);
      await run.runOnce();
      expect((await read()).events.map((event) => event.kind)).toContain(
        "reorg_detected",
      );

      await drive(run, read, "activated");
      const after = await read();
      expect(after.txHash).toBe(before.txHash);
      const kinds = after.events.map((event) => event.kind);
      expect(kinds).toEqual(
        expect.arrayContaining([
          "reorg_detected",
          "reclaimed_after_reorg",
          "rebroadcast",
          "activated",
        ]),
      );
      expect(await published(after.addresses.deployed!.gate)).toBe(true);
    }, 300_000);

    it("fails a deployment whose read-back differs and never activates it", async () => {
      const task = await submittedTask("BADMOD");
      const read = () => job(task.ownerUserId, task.projectId, task.jobId);
      const real = createHooksLaunchExecutorChain({
        privateKey: deployed.executorKey,
        factoryAddress: deployed.factory,
        rpcUrls: [chain.rpcUrl],
      });
      // Fault injection on the read layer only: the Hook reports a 3 % tax.
      const tampered: HooksLaunchExecutorChain = {
        ...real,
        async readLaunch(launchId) {
          const facts = await real.readLaunch(launchId);
          return {
            ...facts,
            hook: facts.hook === null ? null : { ...facts.hook, taxBps: 300n },
          };
        },
      };
      const run = executor({ chainClient: tampered });
      await run.runOnce();
      await chain.mine(2);
      const nonceBefore = await executorNonce();
      await run.runOnce();
      const failed = await read();
      expect(failed.status).toBe("failed");
      expect(failed.failure).toEqual({
        code: "HOOKS_VERIFICATION_MISMATCH",
        retryable: false,
      });
      expect(failed.activationTxHash).toBeNull();
      expect(failed.addresses.deployed).toBeNull();
      expect(await executorNonce()).toBe(nonceBefore);
      const audit = await pool.query<{ details: { failedChecks: string[] } }>(
        "select details from public.hooks_launch_deployment_events where job_id = $1 and kind = 'failed'",
        [task.jobId],
      );
      expect(audit.rows[0]?.details.failedChecks).toEqual(["hook_params"]);
      const gateAddress = await launchGate(await launchIdOf(task.jobId));
      expect(await published(gateAddress)).toBe(false);
      // A non-retryable failure is never claimed again.
      await run.runOnce();
      expect((await read()).status).toBe("failed");
    }, 300_000);

    async function launchGate(launchId: string): Promise<string> {
      return createPublicClient({
        chain: bscTestnet,
        transport: http(chain.rpcUrl),
      }).readContract({
        address: deployed.factory,
        abi: [
          {
            type: "function",
            name: "launchGate",
            stateMutability: "view",
            inputs: [{ name: "launchId", type: "bytes32" }],
            outputs: [{ name: "", type: "address" }],
          },
        ],
        functionName: "launchGate",
        args: [launchId as `0x${string}`],
      });
    }

    async function launchIdOf(jobId: string): Promise<string> {
      const row = await pool.query<{
        project_owner: string;
        config_version: number;
      }>(
        "select project_owner, config_version from public.hooks_launch_deployment_tasks where job_id = $1",
        [jobId],
      );
      const key = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "uint32" }],
          [row.rows[0]!.project_owner as Address, row.rows[0]!.config_version],
        ),
      );
      return createPublicClient({
        chain: bscTestnet,
        transport: http(chain.rpcUrl),
      }).readContract({
        address: deployed.factory,
        abi: [
          {
            type: "function",
            name: "launchIdByOwnerVersion",
            stateMutability: "view",
            inputs: [{ name: "", type: "bytes32" }],
            outputs: [{ name: "", type: "bytes32" }],
          },
        ],
        functionName: "launchIdByOwnerVersion",
        args: [key],
      });
    }

    it("fails an expired signature without broadcasting anything", async () => {
      const task = await submittedTask("LATE");
      const read = () => job(task.ownerUserId, task.projectId, task.jobId);
      const nonceBefore = await executorNonce();
      const run = executor({ now: () => Number(task.deadline) + 1 });
      await run.runOnce();
      const failed = await read();
      expect(failed.status).toBe("failed");
      expect(failed.failure).toEqual({
        code: "HOOKS_SIGNATURE_EXPIRED",
        retryable: false,
      });
      expect(failed.txHash).toBeNull();
      expect(failed.events.map((event) => event.kind)).toEqual([
        "created",
        "claimed",
        "failed",
      ]);
      expect(await executorNonce()).toBe(nonceBefore);
      const reservations = await pool.query(
        "select 1 from public.hooks_launch_executor_nonces where job_id = $1",
        [task.jobId],
      );
      expect(reservations.rowCount).toBe(0);
    }, 300_000);

    it("stays idle with a key the Factory does not authorize", async () => {
      const task = await submittedTask("NOAUTH");
      const result = await executor({ key: anvilPrivateKey(13) }).runOnce();
      expect(result).toMatchObject({
        idleReason: "HOOKS_EXECUTOR_NOT_AUTHORIZED",
        processed: 0,
      });
      expect(
        (await job(task.ownerUserId, task.projectId, task.jobId)).status,
      ).toBe("awaiting_executor");
    }, 300_000);

    it("refuses to boot the executor without its private key", () => {
      expect(() =>
        loadReconciliationWorkerConfig({
          DATABASE_URL: "postgres://loop:loop@127.0.0.1:5432/loop_test",
          LAUNCH_CHAIN_ID: "97",
          HOOKS_LAUNCH_FACTORY_ADDRESS: deployed.factory,
          HOOKS_LAUNCH_FACTORY_CODE_HASH: factoryCodeHash,
          HOOKS_LAUNCH_EXECUTOR_ENABLED: "on",
        }),
      ).toThrow(/HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY/u);
    });
  },
);
