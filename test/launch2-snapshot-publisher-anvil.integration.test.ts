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
  recoverTypedDataAddress,
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
import { createPostgresAdminLaunchReviewRepository } from "../src/database/admin-launch-repository.js";
import { createPostgresLaunch2Repository } from "../src/database/launch2-repository.js";
import { createPostgresLaunch2PublicationRepository } from "../src/database/launch2-snapshot-publication-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { createHooksLaunchDeploymentService } from "../src/features/launch/hooks-launch-deployment.js";
import { createHooksLaunchExecutor } from "../src/features/launch/hooks-launch-executor.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { createHooksLaunchSubmissionService } from "../src/features/launch/hooks-launch-submission.js";
import { createLaunch2Service } from "../src/features/launch2/launch2-service.js";
import {
  createLaunch2SnapshotPublisher,
  launch2SnapshotDataHash,
  type Launch2PublisherPolicy,
} from "../src/features/launch2/launch2-snapshot-publisher.js";
import { parseLaunch2SnapshotPublisher } from "../src/config.js";
import type { BscChainCallClient } from "../src/integrations/bsc/rpc-client.js";
import { createUnavailableBscReadClient } from "../src/integrations/bsc/rpc-client.js";
import { createHooksLaunchExecutorChain } from "../src/integrations/launch/hooks-launch-executor-chain.js";
import { createHooksLaunchFactoryReader } from "../src/integrations/launch/hooks-launch-factory-reader.js";
import { snapshotRegistryAbi } from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
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
 * Decision 0118 end to end on a local `anvil --chain-id 97`: the real
 * loop-contracts Foundry scripts deploy the base and the Factory; a Hooks
 * launch is activated through S125 + S132; two wallets mint the project
 * NFT; the chain is moved past the NFT sale end; the
 * `launch2_snapshot_publisher` lane waits for the cutoff confirmations,
 * builds the holder list from the `launch2_event` lane's transfers, signs
 * with two registered signer keys (anvil 9 / 10), submits from the Hooks
 * executor account and follows the receipt to `confirmed`; the lane then
 * verifies the snapshot and the priority-hour quote opens. Negative: one
 * key refuses boot, an unconfirmed cutoff publishes nothing, repeated ticks
 * publish once, an unregistered signer is refused by the contract
 * (`failed`, no retry). Skips when anvil / forge / loop-contracts are absent.
 */

const foundry = locateFoundry();
/**
 * S141: the Factory's NFT sale length (`LOOP_NFT_SALE_DURATION_SECONDS`,
 * 3,600 on the testnet Factory). The publisher only reads
 * `SnapshotRegistry.nftSaleEnd()`. The default stays 604,800 until the
 * S141-api batch lets the S132 executor verification and the launch2 stage
 * machine accept a Factory-defined duration (today both pin 604,800, so a
 * 1-hour Factory never reaches `activated` here); then set
 * `LOOP_TEST_NFT_SALE_DURATION_SECONDS=3600` or flip this default.
 */
const nftSaleDurationSeconds = Number(
  process.env["LOOP_TEST_NFT_SALE_DURATION_SECONDS"] ?? "604800",
);
const skipReason = typeof foundry === "string" ? foundry : null;
if (skipReason !== null) {
  process.stderr.write(
    `[skip] launch2 snapshot publisher anvil suite: ${skipReason}\n`,
  );
}

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const wad = 10n ** 18n;

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

/** A minimal launch-slot call client over anvil (no Multicall3 there). */
function anvilCallClient(rpcUrl: string): BscChainCallClient {
  const client = createPublicClient({
    chain: bscTestnet,
    transport: http(rpcUrl),
  });
  const head = async () => {
    const block = await client.getBlock({ blockTag: "latest" });
    return {
      blockNumber: block.number,
      blockHash: block.hash.toLowerCase(),
      observedAt: new Date().toISOString(),
    };
  };
  return {
    ...createUnavailableBscReadClient({
      chainId: "eip155:97",
      chainReference: 97,
      confirmations: 1,
      reorgDepthBlocks: 15,
    }),
    readBalances: async (owner, items) => ({
      head: await head(),
      balances: await Promise.all(
        items.map(async (item) => ({
          assetId: item.assetId,
          rawValue:
            item.address === null
              ? await client.getBalance({ address: owner as Address })
              : await client.readContract({
                  address: item.address as Address,
                  abi: erc20Abi,
                  functionName: "balanceOf",
                  args: [owner as Address],
                }),
          reasonCode: null,
        })),
      ),
    }),
    readAllowances: async (owner, items) => ({
      head: await head(),
      allowances: await Promise.all(
        items.map(async (item) => ({
          assetId: item.assetId,
          spender: item.spender,
          rawValue: await client.readContract({
            address: item.token as Address,
            abi: erc20Abi,
            functionName: "allowance",
            args: [owner as Address, item.spender as Address],
          }),
          reasonCode: null,
        })),
      ),
    }),
    call: async (request) => {
      try {
        const result = await client.call({
          account: request.from as Address,
          to: request.to as Address,
          data: request.data,
        });
        return { status: "passed" as const, returnData: result.data ?? "0x" };
      } catch {
        return {
          status: "reverted" as const,
          reasonCode: "EXECUTION_REVERTED",
        };
      }
    },
    estimateGas: (request) =>
      client
        .estimateGas({
          account: request.from as Address,
          to: request.to as Address,
          data: request.data,
        })
        .catch(() => null),
    getFeeData: async () => ({
      type: "legacy" as const,
      gasPrice: await client.getGasPrice(),
    }),
    getTransactionCount: (address) =>
      client.getTransactionCount({
        address: address as Address,
        blockTag: "pending",
      }),
  };
}

describe.skipIf(skipReason !== null)(
  "Decision 0118 launch2 snapshot publisher on anvil (chain 97)",
  () => {
    const databaseName = `loop_s140_${randomUUID().replaceAll("-", "")}`;
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
        nftSaleDurationSeconds,
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
        [`did:privy:launch2-s140:${randomUUID()}`],
      );
      const id = result.rows[0]!.id;
      if (key !== undefined) owners.set(id, key);
      return id;
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

    function walletIdOf(ownerUserId: string): string {
      // A stable opaque wallet ID per test user.
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

    function principal(userId: string): AuthenticatedLoopPrincipal {
      return { userId } as unknown as AuthenticatedLoopPrincipal;
    }

    /** S125 + S132: draft → approval → signature → executor → activated. */
    async function activatedLaunch(ticker: string): Promise<{
      readonly ownerUserId: string;
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
          description: "S140 snapshot publisher",
          links: [],
          nftSaleStartAt: saleStart.toString(10),
          buybackRecipient: "0x28816c4c4792467390c90e5b426f198570e29307",
        },
        {
          nowUnixSeconds: nowSeconds.toString(10),
          minimumLeadSeconds: 86_400,
          nftSaleDurationSeconds: 604_800,
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
      }).prepareSigningRequest({
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
        executorId: `hooks-executor:s140:${randomUUID().slice(0, 8)}`,
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
        if (current?.status === "activated") {
          return { ownerUserId, projectId, saleStart };
        }
        await chain.mine(1);
      }
      throw new Error("the launch never reached activated");
    }

    const policy: Launch2PublisherPolicy = {
      chainId: "eip155:97",
      confirmations: 3,
      maxGasPriceWei: 100n * 10n ** 9n,
      gasLimitCap: 1_000_000n,
      maxAttempts: 3,
      retryDelaySeconds: 60,
    };

    async function mintNft(key: `0x${string}`, nft: string): Promise<void> {
      await send(
        anvilPrivateKey(0),
        deployed.usd1,
        encode(usd1MintAbi, "mint", [
          privateKeyToAccount(key).address,
          1_000n * wad,
        ]),
      );
      await send(
        key,
        deployed.usd1,
        encode(erc20Abi, "approve", [nft, 100n * wad]),
      );
      await send(key, nft, encode(nftMintAbi, "mint", []));
    }

    async function registrySaleEnd(snapshots: string): Promise<bigint> {
      return publicClient().readContract({
        address: snapshots as Address,
        abi: snapshotRegistryAbi,
        functionName: "nftSaleEnd",
      });
    }

    async function submitterNonce(): Promise<number> {
      return publicClient().getTransactionCount({
        address: privateKeyToAccount(deployed.executorKey).address,
        blockTag: "latest",
      });
    }

    async function instanceOf(projectId: string): Promise<string> {
      const rows = await pool.query<{ instance_id: string }>(
        "select instance_id::text from public.launch2_instances where project_id = $1",
        [projectId],
      );
      expect(rows.rows).toHaveLength(1);
      return rows.rows[0]!.instance_id;
    }

    async function publicationRows(instanceId: string) {
      const rows = await pool.query<{
        status: string;
        cutoff_block: string;
        cutoff_block_hash: string;
        member_count: number;
        members: string[];
        root: string;
        data_hash: string;
        signer_addresses: string[];
        submitter_address: string;
        tx_hash: string | null;
        confirmations: number | null;
        failure_code: string | null;
        failure_detail: string | null;
        failure_retryable: boolean | null;
      }>(
        `select status, cutoff_block::text, cutoff_block_hash, member_count,
           members, root, data_hash, signer_addresses, submitter_address,
           tx_hash, confirmations, failure_code, failure_detail,
           failure_retryable
         from public.launch2_snapshot_publications
         where instance_id = $1 order by attempt`,
        [instanceId],
      );
      return rows.rows;
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

    function publisherWith(
      repository: ReturnType<typeof createPostgresLaunch2Repository>,
      signerKeys: readonly `0x${string}`[],
    ) {
      return createLaunch2SnapshotPublisher({
        repository: createPostgresLaunch2PublicationRepository(pool),
        launch2: repository,
        chain: createLaunch2PublisherChain({
          privateKey: deployed.executorKey,
          rpcUrls: [chain.rpcUrl],
        }),
        signers: createLaunch2SnapshotSigners({
          privateKeys: signerKeys,
          chainId: 97,
        }),
        policy,
      });
    }

    it("refuses to enable the publisher with a single signer key", () => {
      expect(() =>
        parseLaunch2SnapshotPublisher({
          LAUNCH_CHAIN_ID: "97",
          LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED: true,
          LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: anvilPrivateKey(9),
          HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: anvilPrivateKey(2),
          LAUNCH2_SNAPSHOT_PUBLISHER_POLL_INTERVAL_MS: 5_000,
          LAUNCH2_SNAPSHOT_PUBLISHER_CONFIRMATIONS: 3,
          LAUNCH2_SNAPSHOT_PUBLISHER_MAX_GAS_PRICE_GWEI: 20,
        }),
      ).toThrow(/LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS/u);
    });

    it("publishes the 2-of-3 snapshot once the cutoff is final; the lane verifies it and the priority quote opens", async () => {
      const launch = await activatedLaunch("SNAP");
      const repository = createPostgresLaunch2Repository(pool);
      const lane = laneFor(repository);
      const service = createLaunch2Service({
        repository,
        chain: createLaunch2Chain({ rpcUrls: [chain.rpcUrl] }),
        readClient: anvilCallClient(chain.rpcUrl),
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
      const instanceId = await instanceOf(launch.projectId);
      const record = (await repository.getInstance(instanceId))!;
      const nft = record.addresses.nft;
      const holderKey = anvilPrivateKey(12);
      const secondKey = anvilPrivateKey(13);
      const holderUser = await user(holderKey);
      const publisher = publisherWith(repository, [
        anvilPrivateKey(9),
        anvilPrivateKey(10),
      ]);

      // NFT sale: two holders.
      await warpTo(launch.saleStart + 10n);
      await mintNft(holderKey, nft);
      await mintNft(secondKey, nft);
      await lane.runOnce();
      expect(
        (await publisher.runOnce()).waiting[instanceId],
        "the sale is still open",
      ).toBe("LAUNCH2_SNAPSHOT_SALE_OPEN");

      // Sale end: the cutoff is the last block before it.
      const saleEnd = await registrySaleEnd(record.addresses.snapshots);
      expect(saleEnd).toBe(launch.saleStart + BigInt(nftSaleDurationSeconds));
      await warpTo(saleEnd - 1n);
      const cutoff = await publicClient().getBlock({ blockTag: "latest" });
      await warpTo(saleEnd);
      await lane.runOnce();
      expect((await repository.getInstance(instanceId))?.stage).toBe(
        "snapshot_pending",
      );
      expect((await publisher.runOnce()).waiting[instanceId]).toBe(
        "LAUNCH2_SNAPSHOT_CUTOFF_UNCONFIRMED",
      );
      expect(await publicationRows(instanceId)).toEqual([]);

      // Confirmed on chain, but the indexer has not reached cutoff + 3.
      await chain.mine(3);
      expect((await publisher.runOnce()).waiting[instanceId]).toBe(
        "LAUNCH2_SNAPSHOT_INDEXER_BEHIND",
      );
      expect(await publicationRows(instanceId)).toEqual([]);

      // Indexed: the publisher signs, records, and broadcasts.
      await lane.runOnce();
      const nonceBefore = await submitterNonce();
      const ran = await publisher.runOnce();
      expect(ran.waiting[instanceId]).toBeUndefined();
      const holders = [holderKey, secondKey]
        .map((key) => privateKeyToAccount(key).address.toLowerCase())
        .sort();
      let rows = await publicationRows(instanceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "broadcast",
        cutoff_block: cutoff.number.toString(10),
        cutoff_block_hash: cutoff.hash.toLowerCase(),
        member_count: 2,
        members: holders,
        data_hash: launch2SnapshotDataHash(holders),
        signer_addresses: [9, 10].map((index) =>
          anvilAccount(index).address.toLowerCase(),
        ),
        submitter_address: privateKeyToAccount(
          deployed.executorKey,
        ).address.toLowerCase(),
        failure_code: null,
      });
      expect(rows[0]!.data_hash).toBe(
        keccak256(toHex(JSON.stringify(holders))),
      );
      expect(await submitterNonce()).toBe(nonceBefore + 1);

      // Repeated ticks never publish twice; confirmations finish it.
      await publisher.runOnce();
      expect(await publicationRows(instanceId)).toHaveLength(1);
      await chain.mine(3);
      await publisher.runOnce();
      await publisher.runOnce();
      rows = await publicationRows(instanceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("confirmed");
      expect(rows[0]?.confirmations).toBeGreaterThanOrEqual(3);
      expect(await submitterNonce()).toBe(nonceBefore + 1);
      const onChainRoot = await publicClient().readContract({
        address: record.addresses.snapshots as Address,
        abi: snapshotRegistryAbi,
        functionName: "root",
      });
      expect(onChainRoot.toLowerCase()).toBe(rows[0]!.root);

      // The signatures in the calldata recover to the two registered signers.
      const transaction = await publicClient().getTransaction({
        hash: rows[0]!.tx_hash as Hex,
      });
      expect(transaction.input.slice(0, 10)).toBe(
        encode(snapshotRegistryAbi, "publishSnapshot", [
          cutoff.number,
          cutoff.hash,
          rows[0]!.data_hash,
          rows[0]!.root,
          "0x",
          "0x",
        ]).slice(0, 10),
      );

      // The read lane verifies it; the stage opens the priority hour.
      await refreshNow();
      await lane.runOnce();
      const detail = (
        await service.getInstance({
          principal: principal(holderUser),
          instanceId,
        })
      )["instance"] as Record<string, Record<string, unknown>>;
      expect(detail["stage"]).toBe("priority");
      expect(detail["snapshot"]).toMatchObject({
        status: "published",
        verification: "verified",
        root: rows[0]!.root,
        dataHash: rows[0]!.data_hash,
        cutoffBlockNumber: cutoff.number.toString(10),
        memberCount: 2,
        signers: [9, 10].map((index) =>
          anvilAccount(index).address.toLowerCase(),
        ),
        publication: {
          status: "confirmed",
          txHash: rows[0]!.tx_hash,
          cutoffBlock: cutoff.number.toString(10),
          memberCount: 2,
        },
      });
      const signer = await recoverTypedDataAddress({
        domain: {
          name: "LOOP NFT Snapshot",
          version: "1",
          chainId: 97,
          verifyingContract: record.addresses.snapshots as Address,
        },
        types: {
          Snapshot: [
            { name: "launchId", type: "bytes32" },
            { name: "nft", type: "address" },
            { name: "cutoffBlock", type: "uint256" },
            { name: "cutoffBlockHash", type: "bytes32" },
            { name: "dataHash", type: "bytes32" },
            { name: "root", type: "bytes32" },
          ],
        },
        primaryType: "Snapshot",
        message: {
          launchId: record.launchId as Hex,
          nft: nft as Address,
          cutoffBlock: cutoff.number,
          cutoffBlockHash: cutoff.hash,
          dataHash: rows[0]!.data_hash as Hex,
          root: rows[0]!.root as Hex,
        },
        signature: (
          await pool.query<{ signatures: string[] }>(
            "select signatures from public.launch2_snapshot_publications where instance_id = $1",
            [instanceId],
          )
        ).rows[0]!.signatures[0] as Hex,
      });
      expect(signer.toLowerCase()).toBe(anvilAccount(9).address.toLowerCase());

      // Priority-hour quote for a holder: no longer 409.
      const quote = (
        await service.quote({
          principal: principal(holderUser),
          instanceId,
          side: "buy",
          amount: "50",
          walletId: walletIdOf(holderUser),
        })
      )["quote"] as Record<string, unknown>;
      expect(quote).toMatchObject({ stage: "priority", side: "buy" });

      // The console shows the attempt next to the lane's verdict.
      const admin = await createPostgresAdminLaunchReviewRepository(
        pool,
      ).getProject({ projectId: launch.projectId, scope: "*" });
      expect(admin?.snapshotPublications).toEqual([
        expect.objectContaining({
          instanceId,
          attempt: 1,
          status: "confirmed",
          memberCount: 2,
          txHash: rows[0]!.tx_hash,
          verification: "verified",
          failure: null,
        }),
      ]);

      // Verified: the publisher has nothing left to do.
      const idle = await publisher.runOnce();
      expect(idle.candidates).toBe(0);
      expect(await publicationRows(instanceId)).toHaveLength(1);
      await expect(
        pool.query(
          "update public.launch2_snapshot_publications set root = $1",
          [`0x${"00".repeat(32)}`],
        ),
      ).rejects.toThrow(/invalid snapshot publication mutation/u);
      await expect(
        pool.query("delete from public.launch2_snapshot_publications"),
      ).rejects.toThrow(/retain audit history/u);
    }, 900_000);

    it("an unregistered signer key: the contract refuses, the attempt is failed and not retried", async () => {
      const launch = await activatedLaunch("SNAPB");
      const repository = createPostgresLaunch2Repository(pool);
      const lane = laneFor(repository);
      await refreshNow();
      await lane.runOnce();
      const instanceId = await instanceOf(launch.projectId);
      const record = (await repository.getInstance(instanceId))!;
      await warpTo(launch.saleStart + 10n);
      await mintNft(anvilPrivateKey(14), record.addresses.nft);
      const saleEnd = await registrySaleEnd(record.addresses.snapshots);
      await warpTo(saleEnd - 1n);
      await warpTo(saleEnd);
      await chain.mine(3);
      await lane.runOnce();
      const outsiderKey = generatePrivateKey();
      const publisher = publisherWith(repository, [
        anvilPrivateKey(9),
        outsiderKey,
      ]);
      const nonceBefore = await submitterNonce();
      await publisher.runOnce();
      const rows = await publicationRows(instanceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "failed",
        failure_code: "LAUNCH2_SNAPSHOT_CONTRACT_REVERTED",
        failure_detail: "InvalidSnapshotSignatures",
        failure_retryable: false,
        tx_hash: null,
        member_count: 1,
        signer_addresses: [
          anvilAccount(9).address.toLowerCase(),
          privateKeyToAccount(outsiderKey).address.toLowerCase(),
        ],
      });
      expect(await submitterNonce()).toBe(nonceBefore);
      const again = await publisher.runOnce();
      expect(again.waiting[instanceId]).toBe(
        "LAUNCH2_SNAPSHOT_PUBLICATION_BLOCKED",
      );
      expect(await publicationRows(instanceId)).toHaveLength(1);
      const onChainRoot = await publicClient().readContract({
        address: record.addresses.snapshots as Address,
        abi: snapshotRegistryAbi,
        functionName: "root",
      });
      expect(onChainRoot).toBe(`0x${"00".repeat(32)}`);
      expect(
        (await repository.getInstance(instanceId))?.snapshotPublication,
      ).toEqual({
        status: "failed",
        txHash: null,
        cutoffBlock: rows[0]!.cutoff_block,
        memberCount: 1,
      });
    }, 900_000);
  },
);

function encode(
  abi: Abi | readonly unknown[],
  functionName: string,
  args: readonly unknown[],
): Hex {
  return encodeFunctionData({ abi: abi as Abi, functionName, args });
}
