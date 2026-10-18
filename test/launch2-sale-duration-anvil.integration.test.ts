import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedLoopPrincipal } from "../src/core/http/authentication.js";
import { createV2CursorCodec } from "../src/core/http/v2-cursor.js";
import type { AccountWalletRepository } from "../src/database/account-wallet-repository.js";
import { createPostgresHooksLaunchExecutorRepository } from "../src/database/hooks-launch-executor-repository.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresLaunch2Repository } from "../src/database/launch2-repository.js";
import {
  hooksLaunchFixedEconomics,
  parseHooksLaunchDraft,
} from "../src/features/launch/hooks-launch-config.js";
import {
  createHooksLaunchDeploymentService,
  HooksLaunchDeploymentError,
} from "../src/features/launch/hooks-launch-deployment.js";
import { createHooksLaunchExecutor } from "../src/features/launch/hooks-launch-executor.js";
import { createHooksLaunchProjectConfigService } from "../src/features/launch/hooks-launch-project-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { createHooksLaunchSubmissionService } from "../src/features/launch/hooks-launch-submission.js";
import { createLaunch2Service } from "../src/features/launch2/launch2-service.js";
import { createUnavailableBscReadClient } from "../src/integrations/bsc/rpc-client.js";
import { createHooksLaunchExecutorChain } from "../src/integrations/launch/hooks-launch-executor-chain.js";
import { createHooksLaunchFactoryReader } from "../src/integrations/launch/hooks-launch-factory-reader.js";
import {
  loopLaunchFactoryAbi,
  projectNFTAbi,
} from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
import { createLaunch2Chain } from "../src/integrations/launch2/launch2-chain.js";
import { createLaunch2Lane } from "../src/launch2-indexer-worker.js";
import {
  anvilPrivateKey,
  deployProtocol,
  locateFoundry,
  startAnvil,
  stopAnvilChains,
  type AnvilChain,
  type DeployedProtocol,
} from "./helpers/anvil.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0119 end to end on a local `anvil --chain-id 97`: the real
 * `DeployLoopFactoryBscTestnet` script deploys a Factory with
 * `LOOP_NFT_SALE_DURATION_SECONDS=3600`. The draft is saved through the
 * project config service, which hashes the Factory's `nftSaleDuration()`
 * (a 7-day config is refused at prepare with HOOKS_FACTORY_TEMPLATE_MISMATCH);
 * the S132 executor verifies the 1-hour NFT against the Factory and records
 * the verified `saleEnd`; the launch2 lane registers the instance and moves
 * it upcoming → nft_sale (ends start + 3,600 s) → snapshot_pending at
 * exactly the NFT's `saleEnd()`, about a week before a 7-day sale would.
 * No snapshot is published. Skips when anvil / forge / loop-contracts are
 * absent.
 */

const foundry = locateFoundry();
const skipReason = typeof foundry === "string" ? foundry : null;
if (skipReason !== null) {
  process.stderr.write(`[skip] launch2 sale-duration suite: ${skipReason}\n`);
}

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const wad = 10n ** 18n;
const hour = 3_600n;

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

const usd1MintAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const nftMintAbi = parseAbi(["function mint() returns (uint256)"]);

function encode(abi: Abi, functionName: string, args: readonly unknown[]) {
  return encodeFunctionData({ abi, functionName, args });
}

describe.skipIf(skipReason !== null)(
  "Decision 0119 one-hour NFT sale on anvil (chain 97)",
  () => {
    const databaseName = `loop_s141_${randomUUID().replaceAll("-", "")}`;
    let pool: InstanceType<typeof Pool>;
    let chain: AnvilChain;
    let deployed: DeployedProtocol;
    let factoryCodeHash: string;
    let chainNow = 0n;
    const owners = new Map<string, `0x${string}`>();

    beforeAll(async () => {
      if (typeof foundry === "string") return;
      chain = await startAnvil(foundry);
      deployed = deployProtocol(foundry, chain.rpcUrl, {
        nftSaleDurationSeconds: 3_600,
      });
      const code = await chain.request<string>("eth_getCode", [
        deployed.factory,
        "latest",
      ]);
      factoryCodeHash = keccak256(code as `0x${string}`).toLowerCase();
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
      try {
        await pool.end();
      } finally {
        await stopAnvilChains();
        await admin((client) =>
          client.query(
            `drop database if exists "${databaseName}" with (force)`,
          ),
        );
      }
    });

    const publicClient = () =>
      createPublicClient({ chain: bscTestnet, transport: http(chain.rpcUrl) });

    async function refreshNow(): Promise<bigint> {
      const block = await publicClient().getBlock({ blockTag: "latest" });
      chainNow = block.timestamp;
      return chainNow;
    }

    async function warpTo(timestamp: bigint): Promise<void> {
      await chain.request("evm_setNextBlockTimestamp", [toHex(timestamp)]);
      await chain.mine(1);
      await refreshNow();
    }

    async function send(
      key: `0x${string}`,
      to: string,
      data: Hex,
    ): Promise<void> {
      const wallet = createWalletClient({
        account: privateKeyToAccount(key),
        chain: bscTestnet,
        transport: http(chain.rpcUrl),
      });
      const hash = await wallet.sendTransaction({
        to: to as Address,
        data,
        gas: 6_000_000n,
      });
      const receipt = await publicClient().waitForTransactionReceipt({ hash });
      expect(receipt.status, `tx to ${to}`).toBe("success");
    }

    async function user(key?: `0x${string}`): Promise<string> {
      const result = await pool.query<{ id: string }>(
        "insert into public.loop_users (privy_user_id) values ($1) returning id",
        [`did:privy:launch2-s141:${randomUUID()}`],
      );
      const id = result.rows[0]!.id;
      if (key !== undefined) owners.set(id, key);
      return id;
    }

    function walletIdOf(ownerUserId: string): string {
      return `${ownerUserId.slice(0, 24)}aaaaaaaaaaaa`;
    }

    function walletRecord(ownerUserId: string, key: `0x${string}`) {
      return {
        walletId: walletIdOf(ownerUserId),
        providerWalletId: `privy-${ownerUserId}`,
        address: privateKeyToAccount(key).address.toLowerCase(),
        kind: "embedded" as const,
        status: "active" as const,
        isActive: true,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      };
    }

    const wallets = {
      get: (ownerUserId: string, walletId: string) => {
        const key = owners.get(ownerUserId);
        return Promise.resolve(
          key === undefined || walletId !== walletIdOf(ownerUserId)
            ? null
            : walletRecord(ownerUserId, key),
        );
      },
      list: (ownerUserId: string) => {
        const key = owners.get(ownerUserId);
        return Promise.resolve(
          key === undefined ? [] : [walletRecord(ownerUserId, key)],
        );
      },
    } as unknown as AccountWalletRepository;

    function principal(userId: string): AuthenticatedLoopPrincipal {
      return { userId } as unknown as AuthenticatedLoopPrincipal;
    }

    const draftBody = (ticker: string, saleStart: bigint) => ({
      name: `Project ${ticker}`,
      ticker,
      logoAssetUrl: "https://example.com/logo.png",
      description: "S141 one-hour sale",
      links: [],
      nftSaleStartAt: saleStart.toString(10),
      buybackRecipient: "0x28816c4c4792467390c90e5b426f198570e29307",
    });

    async function approvedProject(ticker: string) {
      const ownerKey = generatePrivateKey();
      const ownerUserId = await user(ownerKey);
      const projectId = randomUUID();
      await pool.query(
        "insert into public.launch_projects (project_id, owner_user_id, name, ticker, review_status, submitted_at, reviewed_at) values ($1, $2, $3, $4, 'approved', now(), now())",
        [projectId, ownerUserId, `Project ${ticker}`, ticker],
      );
      return { ownerKey, ownerUserId, projectId };
    }

    async function approve(projectId: string, configHash: string) {
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
        now: () => Number(chainNow),
      }).execute(
        approver,
        hooksLaunchReviewCommandSchema.parse({
          operationId: randomUUID(),
          action: "launch.config.approve",
          target: projectId,
          reason: "Independent hash review",
          payload: { configVersion: 1, configHash },
        }),
      );
    }

    const reader = () =>
      createHooksLaunchFactoryReader({
        factoryAddress: deployed.factory,
        expectedRuntimeCodeHash: factoryCodeHash,
        rpcUrls: [chain.rpcUrl],
      });

    const deploymentService = () =>
      createHooksLaunchDeploymentService({
        fixedBuybackRecipient: "0x28816c4c4792467390c90e5b426f198570e29307",
        configs: createPostgresHooksLaunchProjectConfigRepository(pool),
        wallets,
        reader: reader(),
        signatureLifetimeSeconds: 900,
        maxSaltAttempts: 2_000_000,
        now: () => Number(chainNow),
      });

    it("reads nftSaleDuration() from the Factory and the legacy 7 days from a contract without it", async () => {
      const factory = await publicClient().readContract({
        address: deployed.factory,
        abi: loopLaunchFactoryAbi,
        functionName: "nftSaleDuration",
      });
      expect(factory).toBe(hour);
      expect(await reader().nftSaleDuration()).toEqual({
        seconds: 3_600,
        legacy: false,
      });
      // A deployed contract without the selector (the tUSD1 token) reverts
      // the call: the reader treats exactly that as a pre-S141 Factory.
      const usd1Code = await chain.request<string>("eth_getCode", [
        deployed.usd1,
        "latest",
      ]);
      const legacy = createHooksLaunchFactoryReader({
        factoryAddress: deployed.usd1,
        expectedRuntimeCodeHash: keccak256(usd1Code as Hex),
        rpcUrls: [chain.rpcUrl],
      });
      expect(await legacy.nftSaleDuration()).toEqual({
        seconds: 604_800,
        legacy: true,
      });
    });

    it("refuses to prepare a 7-day config against the 1-hour Factory", async () => {
      const { ownerUserId, projectId } = await approvedProject("WEEK");
      const nowSeconds = await refreshNow();
      const weekly = parseHooksLaunchDraft(
        draftBody("WEEK", nowSeconds + 2n * 86_400n),
        {
          nowUnixSeconds: nowSeconds.toString(10),
          minimumLeadSeconds: 86_400,
          nftSaleDurationSeconds: 604_800,
        },
      );
      expect(weekly.fixedEconomics).toBe(hooksLaunchFixedEconomics);
      await createPostgresHooksLaunchProjectConfigRepository(
        pool,
      ).saveOwnedDraft({
        projectId,
        ownerUserId,
        expectedVersion: 0,
        templateVersion: weekly.templateVersion,
        configHash: weekly.configHash,
        config: weekly,
        updatedByUserId: ownerUserId,
      });
      await approve(projectId, weekly.configHash);
      const refused = await deploymentService()
        .prepareSigningRequest({
          ownerUserId,
          projectId,
          walletId: walletIdOf(ownerUserId),
        })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(HooksLaunchDeploymentError);
      expect(refused).toMatchObject({ kind: "template_mismatch" });
    });

    it("runs a 1-hour NFT sale into snapshot_pending at the NFT's saleEnd()", async () => {
      // 1. Draft through the service: the configHash binds the Factory's 3,600 s.
      const { ownerKey, ownerUserId, projectId } =
        await approvedProject("HOUR");
      const nowSeconds = await refreshNow();
      const saleStart = nowSeconds + 2n * 86_400n;
      const saved = await createHooksLaunchProjectConfigService({
        fixedBuybackRecipient: "0x28816c4c4792467390c90e5b426f198570e29307",
        repository: createPostgresHooksLaunchProjectConfigRepository(pool),
        factory: reader(),
        minimumLeadSeconds: 86_400,
        now: () => Number(chainNow),
      }).saveDraft({
        ownerUserId,
        projectId,
        expectedVersion: 0,
        body: draftBody("HOUR", saleStart),
      });
      expect(saved.config.fixedEconomics.nftSaleDurationSeconds).toBe(3_600);
      await approve(projectId, saved.config.configHash);

      // 2. Signature → submission → S132 executor deploy, verify, activate.
      const walletId = walletIdOf(ownerUserId);
      const prepared = await deploymentService().prepareSigningRequest({
        ownerUserId,
        projectId,
        walletId,
      });
      const message = prepared.typedData.message;
      const signature = await privateKeyToAccount(ownerKey).signTypedData({
        // Decision 0120: types carry EIP712Domain (uint256 chainId).
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
        fixedBuybackRecipient: "0x28816c4c4792467390c90e5b426f198570e29307",
        configs: createPostgresHooksLaunchProjectConfigRepository(pool),
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
      const executor = createHooksLaunchExecutor({
        repository: createPostgresHooksLaunchExecutorRepository(pool, {
          leaseSeconds: 60,
        }),
        chain: createHooksLaunchExecutorChain({
          privateKey: deployed.executorKey,
          factoryAddress: deployed.factory,
          rpcUrls: [chain.rpcUrl],
        }),
        policy: {
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
        executorId: `hooks-executor:s141:${randomUUID().slice(0, 8)}`,
        now: () => Number(chainNow),
      });
      let activated = false;
      for (let tick = 0; tick < 20 && !activated; tick += 1) {
        await refreshNow();
        await executor.runOnce();
        const current = await submissions.getOwned(
          ownerUserId,
          projectId,
          job.jobId,
        );
        expect(current?.failure ?? null).toBeNull();
        activated = current?.status === "activated";
        if (!activated) await chain.mine(1);
      }
      expect(activated).toBe(true);
      const task = await pool.query<{
        verification: Record<string, unknown>;
        nft: string;
      }>(
        "select verification, deployed_addresses ->> 'nft' as nft from public.hooks_launch_deployment_tasks where job_id = $1",
        [job.jobId],
      );
      const saleEnd = saleStart + hour;
      expect(task.rows[0]?.verification).toMatchObject({
        nftSaleDurationSeconds: "3600",
        nftSaleEnd: saleEnd.toString(10),
      });
      expect(task.rows[0]?.verification).not.toHaveProperty("legacyFactory");
      const events = await pool.query<{ details: Record<string, unknown> }>(
        "select details from public.hooks_launch_deployment_events where job_id = $1 and kind = 'verified'",
        [job.jobId],
      );
      expect(events.rows[0]?.details).toMatchObject({
        nftSaleDurationSeconds: 3_600,
      });
      const nft = task.rows[0]!.nft as Address;
      const [duration, onChainEnd] = await Promise.all([
        publicClient().readContract({
          address: nft,
          abi: projectNFTAbi,
          functionName: "SALE_DURATION",
        }),
        publicClient().readContract({
          address: nft,
          abi: projectNFTAbi,
          functionName: "saleEnd",
        }),
      ]);
      expect(duration).toBe(hour);
      expect(onChainEnd).toBe(saleEnd);

      // 3. The lane registers the instance; the read model uses its saleEnd.
      const repository = createPostgresLaunch2Repository(pool);
      const lane = createLaunch2Lane({
        repository,
        chain: createLaunch2Chain({ rpcUrls: [chain.rpcUrl] }),
        chainId: "eip155:97",
        factories: [
          { address: deployed.factory, generation: "v3", current: true },
        ],
        reorgDepthBlocks: 15,
        pollIntervalMs: 1_000,
        now: () => new Date(Number(chainNow) * 1000),
      });
      const service = createLaunch2Service({
        repository,
        chain: createLaunch2Chain({ rpcUrls: [chain.rpcUrl] }),
        readClient: createUnavailableBscReadClient({
          chainId: "eip155:97",
          chainReference: 97,
          confirmations: 1,
          reorgDepthBlocks: 15,
        }),
        wallets,
        writes: {
          configVersion: "bscWriteCanaryV1",
          canaryAssetIds: [`eip155:97:${deployed.usd1}`],
          canaryMaxUsd: "100000",
          canaryDailyMaxUsd: null,
          canaryCounterpartyAddresses: [],
          swapFeeBps: null,
        },
        cursorCodec: createV2CursorCodec({
          secret: new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
        }),
        chainId: "eip155:97",
        unavailableReason: null,
        quoteTtlSeconds: 60,
        defaultSlippageBps: 100,
        now: () => new Date(Number(chainNow) * 1000),
      });
      await refreshNow();
      expect((await lane.runOnce()).registered).toBe(1);
      const viewer = await user();
      const summary = async () =>
        (
          (await service.listInstances({ principal: principal(viewer) }))[
            "instances"
          ] as Record<string, unknown>[]
        ).find((row) => row["ticker"] === "HOUR")!;
      const iso = (seconds: bigint) =>
        new Date(Number(seconds) * 1000).toISOString();
      expect(await summary()).toMatchObject({
        stage: "upcoming",
        nextChangeAt: iso(saleStart),
        nftSale: { startAt: iso(saleStart), endAt: iso(saleEnd) },
      });
      const instanceId = (await summary())["instanceId"] as string;
      const detail = (
        await service.getInstance({
          principal: principal(viewer),
          instanceId,
        })
      )["instance"] as { template: Record<string, unknown> };
      expect(detail.template["nftSaleSeconds"]).toBe(3_600);

      // 4. Inside the hour: one wallet mints; the lane projects nft_sale.
      const holderKey = anvilPrivateKey(12);
      await send(
        anvilPrivateKey(0),
        deployed.usd1,
        encode(usd1MintAbi, "mint", [
          privateKeyToAccount(holderKey).address,
          1_000n * wad,
        ]),
      );
      await warpTo(saleStart + 10n);
      await send(
        holderKey,
        deployed.usd1,
        encode(erc20Abi, "approve", [nft, 100n * wad]),
      );
      await send(holderKey, nft, encode(nftMintAbi, "mint", []));
      await lane.runOnce();
      expect(await summary()).toMatchObject({
        stage: "nft_sale",
        nextChangeAt: iso(saleEnd),
        nftSale: { soldCount: "1", endAt: iso(saleEnd) },
      });

      // 5. One second before saleEnd: still selling.
      await warpTo(saleEnd - 1n);
      await lane.runOnce();
      expect(await summary()).toMatchObject({ stage: "nft_sale" });

      // 6. At saleEnd (start + 3,600 s, not + 604,800 s): the contract
      //    refuses a mint and the lane moves the instance to snapshot_pending.
      await warpTo(saleEnd);
      await expect(
        publicClient().simulateContract({
          account: privateKeyToAccount(holderKey).address,
          address: nft,
          abi: nftMintAbi,
          functionName: "mint",
        }),
      ).rejects.toThrow();
      const result = await lane.runOnce();
      expect(result.stagesChanged).toBeGreaterThanOrEqual(1);
      const stored = await pool.query<{
        stage: string;
        next_change_at: Date | null;
      }>(
        "select stage, next_change_at from public.launch2_instances where instance_id = $1",
        [instanceId],
      );
      expect(stored.rows[0]).toEqual({
        stage: "snapshot_pending",
        next_change_at: null,
      });
      expect(await summary()).toMatchObject({
        stage: "snapshot_pending",
        nextChangeAt: null,
        nftSale: { soldCount: "1", endAt: iso(saleEnd) },
      });
      expect(saleEnd - saleStart).toBe(hour);
    });
  },
);
