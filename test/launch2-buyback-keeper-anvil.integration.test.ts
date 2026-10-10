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
import { createPostgresAdminLaunchReviewRepository } from "../src/database/admin-launch-repository.js";
import { createPostgresHooksLaunchExecutorRepository } from "../src/database/hooks-launch-executor-repository.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresLaunch2BuybackAttemptRepository } from "../src/database/launch2-buyback-attempt-repository.js";
import { createPostgresLaunch2Repository } from "../src/database/launch2-repository.js";
import { createPostgresLaunch2PublicationRepository } from "../src/database/launch2-snapshot-publication-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { createHooksLaunchDeploymentService } from "../src/features/launch/hooks-launch-deployment.js";
import { createHooksLaunchExecutor } from "../src/features/launch/hooks-launch-executor.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { createHooksLaunchSubmissionService } from "../src/features/launch/hooks-launch-submission.js";
import {
  createLaunch2BuybackKeeper,
  type Launch2BuybackKeeperPolicy,
} from "../src/features/launch2/launch2-buyback-keeper.js";
import { createLaunch2Service } from "../src/features/launch2/launch2-service.js";
import { createLaunch2SnapshotPublisher } from "../src/features/launch2/launch2-snapshot-publisher.js";
import { createUnavailableBscReadClient } from "../src/integrations/bsc/rpc-client.js";
import { createHooksLaunchExecutorChain } from "../src/integrations/launch/hooks-launch-executor-chain.js";
import { createHooksLaunchFactoryReader } from "../src/integrations/launch/hooks-launch-factory-reader.js";
import {
  buybackExecutorAbi,
  curveEngineAbi,
  snapshotRegistryAbi,
} from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
import { createLaunch2BuybackKeeperChain } from "../src/integrations/launch2/launch2-buyback-keeper-chain.js";
import { createLaunch2Chain } from "../src/integrations/launch2/launch2-chain.js";
import {
  createLaunch2PublisherChain,
  createLaunch2SnapshotSigners,
} from "../src/integrations/launch2/launch2-snapshot-publisher-chain.js";
import { createLaunch2Lane } from "../src/launch2-indexer-worker.js";
import {
  anvilAccount,
  anvilPrivateKey,
  deployProtocol,
  locateFoundry,
  startAnvil,
  type AnvilChain,
  type DeployedProtocol,
} from "./helpers/anvil.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0121 end to end on a local `anvil --chain-id 97`: the real
 * loop-contracts Foundry scripts deploy the base and the Factory; a Hooks
 * launch is activated through S125 + S132; five wallets mint the NFT
 * (500 USD1 in escrow); the snapshot is published by the Decision 0118
 * publisher; after the priority hour 160 generated wallets buy their full
 * 0.5 % quota until the last buy graduates the curve into the official v4
 * pool. Then the `launch2_buyback_keeper`:
 *
 * - simulates before the price recorder has a 30-minute window → the
 *   contract refuses (`ReferenceUnavailable`): one `rejected` row, nothing
 *   sent, refreshed (not duplicated) while it persists;
 * - with a fresh reference executes three orders, each ≥ 10 s after the
 *   previous success, each followed to `confirmed` and aligned with the
 *   `launch2_event` lane's ledger row of the same transaction;
 * - after `pause()` sends nothing (chain pre-check, then the read model);
 * - a key that is not a Factory keeper is refused, the fallback keeper is
 *   accepted.
 *
 * Skips when anvil / forge / loop-contracts are absent.
 */

const foundry = locateFoundry();
const skipReason = typeof foundry === "string" ? foundry : null;
if (skipReason !== null) {
  process.stderr.write(
    `[skip] launch2 buyback keeper anvil suite: ${skipReason}\n`,
  );
}

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const wad = 10n ** 18n;
const nftSaleDurationSeconds = 604_800n;

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
const recorderAbi = parseAbi(["function record() returns (uint192)"]);

function encode(
  abi: Abi | readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): Hex {
  return encodeFunctionData({ abi: abi as Abi, functionName, args });
}

describe.skipIf(skipReason !== null)(
  "Decision 0121 launch2 buyback keeper on anvil (chain 97)",
  () => {
    const databaseName = `loop_s143_${randomUUID().replaceAll("-", "")}_test`;
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
        nftSaleDurationSeconds: Number(nftSaleDurationSeconds),
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
      await pool.end();
      await chain.stop();
      await admin((client) =>
        client.query(`drop database if exists "${databaseName}" with (force)`),
      );
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
      gas = 6_000_000n,
    ): Promise<void> {
      const wallet = createWalletClient({
        account: privateKeyToAccount(key),
        chain: bscTestnet,
        transport: http(chain.rpcUrl),
      });
      const hash = await wallet.sendTransaction({
        to: to as Address,
        data,
        gas,
      });
      const receipt = await publicClient().waitForTransactionReceipt({ hash });
      expect(receipt.status, `tx to ${to}`).toBe("success");
    }

    async function user(key?: `0x${string}`): Promise<string> {
      const result = await pool.query<{ id: string }>(
        "insert into public.loop_users (privy_user_id) values ($1) returning id",
        [`did:privy:launch2-s143:${randomUUID()}`],
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

    /** S125 + S132: draft → approval → signature → executor → activated. */
    async function activatedLaunch(ticker: string): Promise<{
      readonly projectId: string;
      readonly saleStart: bigint;
    }> {
      const ownerKey = generatePrivateKey();
      const ownerUserId = await user(ownerKey);
      const projectId = randomUUID();
      await pool.query(
        "insert into public.launch_projects (project_id, owner_user_id, name, ticker, review_status, submitted_at, reviewed_at) values ($1, $2, $3, $4, 'approved', now(), now())",
        [projectId, ownerUserId, `Project ${ticker}`, ticker],
      );
      const nowSeconds = await refreshNow();
      const saleStart = nowSeconds + 2n * 86_400n;
      const draft = parseHooksLaunchDraft(
        {
          name: `Project ${ticker}`,
          ticker,
          logoAssetUrl: "https://example.com/logo.png",
          description: "S143 buyback keeper",
          links: [],
          nftSaleStartAt: saleStart.toString(10),
          buybackRecipient: "0x28816c4c4792467390c90e5b426f198570e29307",
        },
        {
          nowUnixSeconds: nowSeconds.toString(10),
          minimumLeadSeconds: 86_400,
          nftSaleDurationSeconds: Number(nftSaleDurationSeconds),
        },
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
        now: () => Number(chainNow),
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
      const reader = createHooksLaunchFactoryReader({
        factoryAddress: deployed.factory,
        expectedRuntimeCodeHash: factoryCodeHash,
        rpcUrls: [chain.rpcUrl],
      });
      const walletId = walletIdOf(ownerUserId);
      const prepared = await createHooksLaunchDeploymentService({
        configs,
        wallets,
        reader,
        signatureLifetimeSeconds: 900,
        maxSaltAttempts: 2_000_000,
        now: () => Number(chainNow),
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
        reader,
        repository: createPostgresHooksLaunchSubmissionRepository(pool),
        now: () => Number(chainNow),
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
        executorId: `hooks-executor:s143:${randomUUID().slice(0, 8)}`,
        now: () => Number(chainNow),
      });
      const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
      for (let tick = 0; tick < 20; tick += 1) {
        await refreshNow();
        await executor.runOnce();
        const current = await submissions.getOwned(
          ownerUserId,
          projectId,
          job.jobId,
        );
        if (current?.status === "activated") return { projectId, saleStart };
        await chain.mine(1);
      }
      throw new Error("the launch never reached activated");
    }

    async function mintUsd1(to: string, amount: bigint): Promise<void> {
      await send(
        anvilPrivateKey(0),
        deployed.usd1,
        encode(usd1MintAbi, "mint", [to, amount]),
      );
    }

    async function fund(key: `0x${string}`): Promise<string> {
      const address = privateKeyToAccount(key).address;
      await chain.request("anvil_setBalance", [address, toHex(10n ** 20n)]);
      return address;
    }

    async function mintNft(key: `0x${string}`, nft: string): Promise<void> {
      const address = await fund(key);
      await mintUsd1(address, 1_000n * wad);
      await send(
        key,
        deployed.usd1,
        encode(erc20Abi, "approve", [nft, 100n * wad]),
      );
      await send(key, nft, encode(nftMintAbi, "mint"));
    }

    function laneFor(
      repository: ReturnType<typeof createPostgresLaunch2Repository>,
    ) {
      return createLaunch2Lane({
        repository,
        chain: createLaunch2Chain({ rpcUrls: [chain.rpcUrl] }),
        chainId: "eip155:97",
        factoryAddress: deployed.factory,
        reorgDepthBlocks: 15,
        pollIntervalMs: 1_000,
        now: () => new Date(Number(chainNow) * 1000),
      });
    }

    async function catchUp(lane: ReturnType<typeof laneFor>): Promise<void> {
      await refreshNow();
      for (let round = 0; round < 10; round += 1) {
        await lane.runOnce();
        const checkpoint = await pool.query<{ last: string }>(
          "select last_block_number::text as last from public.indexer_checkpoints where lane = 'launch2_event'",
        );
        const head = await publicClient().getBlockNumber();
        if (BigInt(checkpoint.rows[0]?.last ?? "0") >= head) return;
      }
      throw new Error("the launch2_event lane did not catch up");
    }

    /** The keeper compares backoffs with the wall clock (+ this skew). */
    let skewMs = 0;
    const keeperPolicy: Launch2BuybackKeeperPolicy = {
      chainId: "eip155:97",
      factoryAddress: "",
      confirmations: 3,
      intervalSeconds: 15,
      maxGasPriceWei: 100n * 10n ** 9n,
      gasLimitCap: 2_000_000n,
      retryDelaySeconds: 60,
      maxBackoffSeconds: 600,
    };
    function keeperWith(key: `0x${string}`) {
      return createLaunch2BuybackKeeper({
        repository: createPostgresLaunch2BuybackAttemptRepository(pool),
        chain: createLaunch2BuybackKeeperChain({
          privateKey: key,
          rpcUrls: [chain.rpcUrl],
        }),
        policy: { ...keeperPolicy, factoryAddress: deployed.factory },
        now: () => new Date(Date.now() + skewMs),
      });
    }

    async function keeperNonce(): Promise<number> {
      return publicClient().getTransactionCount({
        address: anvilAccount(5).address,
        blockTag: "latest",
      });
    }

    async function attemptRows(instanceId: string) {
      const rows = await pool.query<{
        attempt: number;
        status: string;
        simulation: string;
        reason_code: string | null;
        reason_detail: string | null;
        rejection_count: number | null;
        tx_hash: string | null;
        tx_nonce: string | null;
        order_usd1: string | null;
        buyback_id: string | null;
        keeper_address: string;
      }>(
        `select attempt, status, simulation, reason_code, reason_detail,
           rejection_count, tx_hash, tx_nonce::text, order_usd1::text,
           buyback_id::text, keeper_address
         from public.launch2_buyback_attempts
         where instance_id = $1 order by attempt`,
        [instanceId],
      );
      return rows.rows;
    }

    it("refuses a key that is not a Factory keeper and accepts the fallback keeper", async () => {
      const outsider = keeperWith(anvilPrivateKey(0));
      expect(await outsider.verifyKeeper()).toBe("not_keeper");
      expect(await outsider.runOnce()).toMatchObject({
        kind: "unavailable",
        reasonCode: "LAUNCH2_BUYBACK_KEEPER_NOT_AUTHORIZED",
      });
      expect(await keeperWith(anvilPrivateKey(6)).verifyKeeper()).toBe("ok");
      expect(await keeperWith(anvilPrivateKey(5)).verifyKeeper()).toBe("ok");
    });

    it("graduates a launch, refuses without a reference, executes three orders ≥ 10 s apart aligned with the ledger, and sends nothing once paused", async () => {
      const launch = await activatedLaunch("BUYB");
      const repository = createPostgresLaunch2Repository(pool);
      const lane = laneFor(repository);
      await refreshNow();
      expect((await lane.runOnce()).registered).toBe(1);
      const instanceRows = await pool.query<{ instance_id: string }>(
        "select instance_id::text from public.launch2_instances where project_id = $1",
        [launch.projectId],
      );
      const instanceId = instanceRows.rows[0]!.instance_id;
      const record = (await repository.getInstance(instanceId))!;
      const { nft, curve, buybackExecutor, priceRecorder, snapshots } =
        record.addresses;

      // NFT sale: five holders → 500 USD1 in escrow.
      await warpTo(launch.saleStart + 10n);
      for (const index of [12, 13, 14]) {
        await mintNft(anvilPrivateKey(index), nft);
      }
      for (let extra = 0; extra < 2; extra += 1) {
        await mintNft(generatePrivateKey(), nft);
      }

      // Sale end → the Decision 0118 publisher publishes the snapshot.
      const saleEnd = await publicClient().readContract({
        address: snapshots as Address,
        abi: snapshotRegistryAbi,
        functionName: "nftSaleEnd",
      });
      await warpTo(saleEnd - 1n);
      await warpTo(saleEnd);
      await chain.mine(3);
      await catchUp(lane);
      const publisher = createLaunch2SnapshotPublisher({
        repository: createPostgresLaunch2PublicationRepository(pool),
        launch2: repository,
        chain: createLaunch2PublisherChain({
          privateKey: deployed.executorKey,
          rpcUrls: [chain.rpcUrl],
        }),
        signers: createLaunch2SnapshotSigners({
          privateKeys: [anvilPrivateKey(9), anvilPrivateKey(10)],
          chainId: 97,
        }),
        policy: {
          chainId: "eip155:97",
          confirmations: 3,
          maxGasPriceWei: 100n * 10n ** 9n,
          gasLimitCap: 1_000_000n,
          maxAttempts: 3,
          retryDelaySeconds: 60,
        },
      });
      await publisher.runOnce();
      await chain.mine(3);
      await publisher.runOnce();
      await catchUp(lane);
      expect(
        (await repository.getInstance(instanceId))?.snapshot,
      ).toMatchObject({ verification: "verified" });

      // Not graduated yet: the keeper has nothing to do.
      const keeper = keeperWith(anvilPrivateKey(5));
      expect((await keeper.runOnce()).candidates).toBe(0);

      // Public round: 160 wallets buy their quota until the curve graduates.
      const earlyEnds = await publicClient().readContract({
        address: curve as Address,
        abi: curveEngineAbi,
        functionName: "earlyRoundEndsAt",
      });
      await warpTo(BigInt(earlyEnds) + 1n);
      let graduated = false;
      for (let buyer = 0; buyer < 200 && !graduated; buyer += 1) {
        const key = generatePrivateKey();
        const address = await fund(key);
        const [maxIn] = await publicClient().readContract({
          address: curve as Address,
          abi: curveEngineAbi,
          functionName: "quoteMaxBuy",
          args: [address as Address],
        });
        await mintUsd1(address, maxIn);
        await send(
          key,
          deployed.usd1,
          encode(erc20Abi, "approve", [curve, maxIn]),
        );
        const now = await refreshNow();
        await send(
          key,
          curve,
          encode(curveEngineAbi, "buy", [maxIn, 0n, now + 600n, []]),
          30_000_000n,
        );
        graduated = await publicClient().readContract({
          address: curve as Address,
          abi: curveEngineAbi,
          functionName: "graduated",
        });
      }
      expect(graduated).toBe(true);
      await chain.mine(3);
      await catchUp(lane);
      expect((await repository.getInstance(instanceId))?.stage).toBe(
        "graduated",
      );

      // No reference window yet: the contract refuses the simulation.
      const nonceBefore = await keeperNonce();
      const refused = await keeper.runOnce();
      expect(refused.waiting[instanceId]).toBe(
        "LAUNCH2_BUYBACK_REFERENCE_UNAVAILABLE",
      );
      let rows = await attemptRows(instanceId);
      expect(rows).toEqual([
        expect.objectContaining({
          attempt: 1,
          status: "rejected",
          simulation: "reverted",
          reason_code: "LAUNCH2_BUYBACK_REFERENCE_UNAVAILABLE",
          reason_detail: "ReferenceUnavailable",
          rejection_count: 1,
          tx_hash: null,
          order_usd1: (100n * wad).toString(),
        }),
      ]);
      // Inside the backoff nothing is simulated; after it the same row counts.
      await keeper.runOnce();
      expect(await attemptRows(instanceId)).toEqual(rows);
      skewMs += 20_000;
      await keeper.runOnce();
      rows = await attemptRows(instanceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.rejection_count).toBe(2);
      expect(await keeperNonce()).toBe(nonceBefore);

      // PriceRecorder: a sample every 60 s for 31 minutes (permissionless).
      let lastSample = await refreshNow();
      const sample = async (at: bigint) => {
        await chain.request("evm_setNextBlockTimestamp", [toHex(at)]);
        await send(
          anvilPrivateKey(1),
          priceRecorder,
          encode(recorderAbi, "record"),
        );
        lastSample = at;
        await refreshNow();
      };
      for (let index = 0; index < 33; index += 1) {
        await sample(lastSample + 60n);
      }
      const keepFresh = async () => {
        const now = await refreshNow();
        if (now - lastSample > 45n)
          await sample(
            now + 1n > lastSample + 60n ? now + 1n : lastSample + 60n,
          );
      };

      // Three orders, each ≥ 10 s after the previous success.
      skewMs += 3_600_000; // past the refusal backoff
      const executed: string[] = [];
      for (let order = 0; order < 3; order += 1) {
        await keepFresh();
        const tick = await keeper.runOnce();
        expect(tick.waiting[instanceId], `order ${order + 1}`).toBeUndefined();
        rows = await attemptRows(instanceId);
        const sent = rows.at(-1)!;
        expect(sent).toMatchObject({
          attempt: 2 + order,
          status: "broadcast",
          simulation: "passed",
          keeper_address: anvilAccount(5).address.toLowerCase(),
          tx_nonce: String(nonceBefore + order),
          order_usd1: (100n * wad).toString(),
        });
        // Repeated ticks before confirmations never send a second order.
        await keeper.runOnce();
        expect(await attemptRows(instanceId)).toHaveLength(rows.length);
        await chain.mine(3);
        await keeper.runOnce();
        expect((await attemptRows(instanceId)).at(-1)?.status).toBe(
          "confirmed",
        );
        // The ledger row comes from the event lane; the keeper only aligns.
        expect((await keeper.runOnce()).waiting[instanceId]).toBe(
          "LAUNCH2_BUYBACK_LEDGER_PENDING",
        );
        await catchUp(lane);
        await keeper.runOnce();
        const aligned = (await attemptRows(instanceId)).at(-1)!;
        expect(aligned.buyback_id).not.toBeNull();
        executed.push(aligned.tx_hash!);
        // Within MIN_SUCCESS_INTERVAL: the pre-check waits, no row.
        expect((await keeper.runOnce()).waiting[instanceId]).toBe(
          "LAUNCH2_BUYBACK_TOO_SOON",
        );
        const last = await publicClient().readContract({
          address: buybackExecutor as Address,
          abi: buybackExecutorAbi,
          functionName: "lastSuccessfulAt",
        });
        await warpTo(BigInt(last) + 10n);
      }
      expect(await keeperNonce()).toBe(nonceBefore + 3);

      // The lane's ledger equals the chain: three executions, ≥ 10 s apart.
      const ledger = await pool.query<{
        buyback_id: string;
        transaction_hash: string;
        usd1_spent: string;
        executed_at: Date;
      }>(
        `select buyback_id::text, transaction_hash, usd1_spent::text, executed_at
         from public.launch2_buybacks
         where instance_id = $1 and not removed and outcome = 'executed'
         order by executed_at`,
        [instanceId],
      );
      expect(ledger.rows.map((row) => row.transaction_hash)).toEqual(executed);
      expect(
        ledger.rows.every((row) => row.usd1_spent === (100n * wad).toString()),
      ).toBe(true);
      for (let index = 1; index < ledger.rows.length; index += 1) {
        expect(
          ledger.rows[index]!.executed_at.getTime() -
            ledger.rows[index - 1]!.executed_at.getTime(),
        ).toBeGreaterThanOrEqual(10_000);
      }
      rows = await attemptRows(instanceId);
      expect(rows.slice(1).map((row) => row.buyback_id)).toEqual(
        ledger.rows.map((row) => row.buyback_id),
      );
      const afterOrders = (await repository.getInstance(instanceId))!;
      expect(afterOrders.buyback).toMatchObject({
        count: "3",
        usd1: (300n * wad).toString(),
      });

      // Read models: the App summary and the console list.
      const viewer = await user();
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
        writes: null,
        cursorCodec: createV2CursorCodec({
          secret: new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
        }),
        chainId: "eip155:97",
        unavailableReason: null,
        quoteTtlSeconds: 60,
        defaultSlippageBps: 100,
        now: () => new Date(Number(chainNow) * 1000),
      });
      const detail = (
        await service.getInstance({ principal: principal(viewer), instanceId })
      )["instance"] as { buyback: Record<string, unknown> };
      expect(detail.buyback).toMatchObject({
        executedCount: "3",
        totalUsd1: "300",
        keeper: { lastResult: "confirmed", reasonCode: null },
      });
      expect(
        (detail.buyback["keeper"] as Record<string, unknown>)["nextEligibleAt"],
      ).toBe(
        new Date(
          Date.parse(afterOrders.buyback.lastAt!) + 10_000,
        ).toISOString(),
      );
      const consoleDetail = await createPostgresAdminLaunchReviewRepository(
        pool,
      ).getProject({ projectId: launch.projectId, scope: "*" });
      expect(consoleDetail?.buybackAttempts.map((row) => row.status)).toEqual([
        "confirmed",
        "confirmed",
        "confirmed",
        "rejected",
      ]);
      expect(consoleDetail?.buybackAttempts[3]).toMatchObject({
        reason: {
          code: "LAUNCH2_BUYBACK_REFERENCE_UNAVAILABLE",
          detail: "ReferenceUnavailable",
        },
        rejectionCount: 2,
        txHash: null,
      });
      expect(JSON.stringify(consoleDetail?.buybackAttempts)).not.toContain(
        "rawTx",
      );

      // Pause: the chain pre-check stops it before the lane knows…
      await send(
        anvilPrivateKey(7),
        buybackExecutor,
        encode(buybackExecutorAbi, "pause"),
      );
      await keepFresh();
      expect((await keeper.runOnce()).waiting[instanceId]).toBe(
        "LAUNCH2_BUYBACK_PAUSED",
      );
      // …and the read model after it does.
      await catchUp(lane);
      expect((await repository.getInstance(instanceId))?.buyback.paused).toBe(
        true,
      );
      await warpTo((await refreshNow()) + 30n);
      expect((await keeper.runOnce()).waiting[instanceId]).toBe(
        "LAUNCH2_BUYBACK_PAUSED",
      );
      expect(await attemptRows(instanceId)).toHaveLength(4);
      expect(await keeperNonce()).toBe(nonceBefore + 3);

      // Evidence is append-only.
      await expect(
        pool.query(
          "update public.launch2_buyback_attempts set keeper_address = $1",
          [`0x${"00".repeat(20)}`],
        ),
      ).rejects.toThrow(/invalid buyback attempt mutation/u);
      await expect(
        pool.query("delete from public.launch2_buyback_attempts"),
      ).rejects.toThrow(/retain audit history/u);
    }, 1_800_000);
  },
);
