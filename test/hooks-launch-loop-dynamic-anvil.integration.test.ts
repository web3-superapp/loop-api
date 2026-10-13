import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import {
  createPublicClient,
  http,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AccountWalletRepository } from "../src/database/account-wallet-repository.js";
import { createPostgresHooksLaunchExecutorRepository } from "../src/database/hooks-launch-executor-repository.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresLaunch2Repository } from "../src/database/launch2-repository.js";
import { hooksLaunchLoopDynamicTemplateHash } from "../src/features/launch/hooks-launch-config.js";
import { createHooksLaunchDeploymentService } from "../src/features/launch/hooks-launch-deployment.js";
import {
  createHooksLaunchExecutor,
  type HooksLaunchExecutor,
} from "../src/features/launch/hooks-launch-executor.js";
import { hooksLaunchLoopDynamicVerificationChecks } from "../src/features/launch/hooks-launch-loop-dynamic-verification.js";
import { createHooksLaunchProjectConfigService } from "../src/features/launch/hooks-launch-project-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { createHooksLaunchSubmissionService } from "../src/features/launch/hooks-launch-submission.js";
import { createHooksLaunchExecutorChain } from "../src/integrations/launch/hooks-launch-executor-chain.js";
import { createHooksLaunchFactoryReader } from "../src/integrations/launch/hooks-launch-factory-reader.js";
import {
  launchPublicationGateAbi,
  loopHookDeploymentFactoryAbi,
} from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
import {
  deployLoopDynamicProtocol,
  locateFoundry,
  startAnvil,
  type AnvilChain,
  type DeployedLoopDynamicProtocol,
} from "./helpers/anvil.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0132 end to end on a local `anvil --chain-id 97`: the real
 * loop-contracts `DeployLoopProtocol` LoopDynamic component (LoopRouter,
 * LoopDynamicLaunchFactory with `LoopDynamicDefaults`, LoopHookDeployment
 * Factory, LoopRouterRegistry); the API services read the Factory's
 * template from chain, save (configHash over the Hook parameters), approve,
 * prepare (TEMPLATE_HASH in the typed data, Hook salt for 0x10C4), sign and
 * submit; the executor (LoopDynamic preflight) deploys, verifies every
 * LoopDynamic check and activates; the salt is registered at the Hook
 * deployment factory for the predicted Hook address, and the launch2 lane
 * registry reads the instance as `loopDynamic`. Skips with the reason when
 * anvil/forge/loop-contracts are absent.
 */

const foundry = locateFoundry();
const skipReason = typeof foundry === "string" ? foundry : null;
if (skipReason !== null) {
  process.stderr.write(
    `[skip] LoopDynamic executor anvil suite: ${skipReason}\n`,
  );
}

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const recipient = "0x3333333333333333333333333333333333333333";

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

describe.skipIf(skipReason !== null)(
  "Decision 0132 LoopDynamic Hooks launch on anvil (chain 97)",
  () => {
    const databaseName = `loop_s170_${randomUUID().replaceAll("-", "")}`;
    let pool: InstanceType<typeof Pool>;
    let chain: AnvilChain;
    let deployed: DeployedLoopDynamicProtocol;
    let factoryCodeHash: string;
    const owners = new Map<string, `0x${string}`>();

    beforeAll(async () => {
      if (typeof foundry === "string") return;
      chain = await startAnvil(foundry);
      deployed = deployLoopDynamicProtocol(foundry, chain.rpcUrl);
      const code = await chain.request<string>("eth_getCode", [
        deployed.factory,
        "latest",
      ]);
      factoryCodeHash = keccak256(code as Hex).toLowerCase();
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
        hookKind: "loopDynamic",
      });
    }

    async function user(): Promise<string> {
      const result = await pool.query<{ id: string }>(
        "insert into public.loop_users (privy_user_id) values ($1) returning id",
        [`did:privy:hooks-s170:${randomUUID()}`],
      );
      return result.rows[0]!.id;
    }

    function executor(): HooksLaunchExecutor {
      return createHooksLaunchExecutor({
        repository: createPostgresHooksLaunchExecutorRepository(pool, {
          leaseSeconds: 60,
        }),
        chain: createHooksLaunchExecutorChain({
          privateKey: deployed.executorKey,
          factoryAddress: deployed.factory,
          rpcUrls: [chain.rpcUrl],
          hookKind: "loopDynamic",
        }),
        policy: {
          hookKind: "loopDynamic",
          factoryCodeHash,
          confirmations: 3,
          maxAttempts: 3,
          retryDelaySeconds: 10,
          gasLimitCap: 30_000_000n,
          maxGasPriceWei: 100n * 10n ** 9n,
          deadlineMarginSeconds: 60,
          activationMarginSeconds: 120,
          tasksPerTick: 8,
        },
        executorId: `hooks-executor:test:${randomUUID().slice(0, 8)}`,
      });
    }

    it("reads the Factory template, signs it, deploys, verifies and activates a LoopDynamic launch", async () => {
      const template = await reader().loopDynamicTemplate!();
      expect(template.params).toMatchObject({
        router: deployed.loopRouter,
        baseSellFeePpm: 20_000,
        buyFeePpm: 20_000,
        baseFeeRecipient: deployed.roles["LOOP_ROLE_FEE_VAULT"],
        priceTiming: 1,
        routingPolicy: 1,
        routerRegistryAdmin: deployed.roles["LOOP_ROLE_ADMIN"],
        excludeBuybackFromRewards: true,
      });
      expect(template.templateHash).toBe(
        hooksLaunchLoopDynamicTemplateHash(template.params).toLowerCase(),
      );

      const ownerUserId = await user();
      const ownerKey = generatePrivateKey();
      owners.set(ownerUserId, ownerKey);
      const projectId = randomUUID();
      await pool.query(
        "insert into public.launch_projects (project_id, owner_user_id, name, ticker, review_status, submitted_at, reviewed_at) values ($1, $2, 'Project LDYN', 'LDYN', 'approved', now(), now())",
        [projectId, ownerUserId],
      );
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
      // The owner save path: hashed against the template read from chain.
      const saved = await createHooksLaunchProjectConfigService({
        repository: configs,
        factory: reader(),
        minimumLeadSeconds: 86_400,
        fixedBuybackRecipient: recipient,
      }).saveDraft({
        ownerUserId,
        projectId,
        expectedVersion: 0,
        body: {
          name: "Project LDYN",
          ticker: "LDYN",
          logoAssetUrl: "https://example.com/logo.png",
          description: "S170 LoopDynamic executor",
          links: [],
          nftSaleStartAt: String(nowSeconds + 2 * 86_400),
          buybackRecipient: recipient,
        },
      });
      expect(saved.config.templateHash).toBe(template.templateHash);
      expect(saved.config.poolHookKind).toBe("loopDynamic");
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
          payload: {
            configVersion: saved.version,
            configHash: saved.config.configHash,
          },
        }),
      );
      const walletId = `wallet-${ownerUserId}`;
      const prepared = await createHooksLaunchDeploymentService({
        fixedBuybackRecipient: recipient,
        configs,
        wallets,
        reader: reader(),
        signatureLifetimeSeconds: 900,
        maxSaltAttempts: 2_000_000,
      }).prepareSigningRequest({ ownerUserId, projectId, walletId });
      expect(prepared.typedData.message.templateHash).toBe(
        template.templateHash,
      );
      expect(prepared.hookDeployer).toBe(deployed.hookDeploymentFactory);
      expect(BigInt(prepared.hookAddress) & 0x3fffn).toBe(0x10c4n);
      const message = prepared.typedData.message;
      const signature = await privateKeyToAccount(ownerKey).signTypedData({
        domain: {
          ...prepared.typedData.domain,
          chainId: BigInt(prepared.typedData.domain.chainId),
        },
        types: prepared.typedData.types,
        primaryType: prepared.typedData.primaryType,
        message: {
          ...message,
          nftSaleStart: BigInt(message.nftSaleStart),
          deadline: BigInt(message.deadline),
          nonce: BigInt(message.nonce),
        },
      });
      const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
      const job = await createHooksLaunchSubmissionService({
        fixedBuybackRecipient: recipient,
        configs,
        wallets,
        reader: reader(),
        repository: submissions,
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
      expect(job.factoryAddress).toBe(deployed.factory);

      const run = executor();
      const read = async () => {
        const found = await submissions.getOwned(
          ownerUserId,
          projectId,
          job.jobId,
        );
        if (found === null) throw new Error("task missing");
        return found;
      };
      for (let tick = 0; tick < 16; tick += 1) {
        const result = await run.runOnce();
        expect(result.idleReason).toBeNull();
        const current = await read();
        expect(current.failure).toBeNull();
        if (current.status === "activated") break;
        await chain.mine(1);
      }
      const done = await read();
      expect(done.status).toBe("activated");
      const zero = "0x0000000000000000000000000000000000000000";
      expect(done.addresses.deployed?.hook).toBe(zero);
      expect(done.addresses.deployed?.priceRecorder).toBe(zero);
      expect(done.addresses.deployed?.meme).toBe(prepared.memeAddress);
      expect(done.addresses.predicted.hook).toBe(prepared.hookAddress);

      const verification = await pool.query<{
        verification: { checks: string[]; hookKind?: string };
      }>(
        "select verification from public.hooks_launch_deployment_tasks where job_id = $1",
        [job.jobId],
      );
      expect(verification.rows[0]?.verification.checks).toEqual([
        ...hooksLaunchLoopDynamicVerificationChecks,
      ]);
      expect(verification.rows[0]?.verification.hookKind).toBe("loopDynamic");

      // The project-signed salt is registered for the predicted Hook.
      const client = createPublicClient({
        chain: bscTestnet,
        transport: http(chain.rpcUrl),
      });
      const launchId = done.addresses.deployed!.launchId as Hex;
      const launch = await client.readContract({
        address: deployed.hookDeploymentFactory,
        abi: loopHookDeploymentFactoryAbi,
        functionName: "launchHook",
        args: [launchId],
      });
      expect(launch.saltRegistered).toBe(true);
      expect(launch.salt.toLowerCase()).toBe(prepared.hookSalt);
      const initCodeHash = await client.readContract({
        address: deployed.hookDeploymentFactory,
        abi: loopHookDeploymentFactoryAbi,
        functionName: "hookInitCodeHash",
        args: [launchId],
      });
      expect(
        (
          await client.readContract({
            address: deployed.hookDeploymentFactory,
            abi: loopHookDeploymentFactoryAbi,
            functionName: "computeAddress",
            args: [launch.salt, initCodeHash],
          })
        ).toLowerCase(),
      ).toBe(prepared.hookAddress);
      expect(
        await client.readContract({
          address: done.addresses.deployed!.gate as Address,
          abi: launchPublicationGateAbi,
          functionName: "published",
        }),
      ).toBe(true);

      // The launch2 lane registers the instance from the task: LoopDynamic.
      const launch2 = createPostgresLaunch2Repository(pool);
      const registered = await launch2.registerActivatedInstances({
        chainId: "eip155:97",
        factories: [{ address: deployed.factory, generation: "v3" }],
      });
      expect(registered).toHaveLength(1);
      const kind = await pool.query<{ pool_hook_kind: string }>(
        "select pool_hook_kind from public.launch2_instances where instance_id = $1",
        [registered[0]],
      );
      expect(kind.rows[0]?.pool_hook_kind).toBe("loopDynamic");
    }, 600_000);
  },
);
