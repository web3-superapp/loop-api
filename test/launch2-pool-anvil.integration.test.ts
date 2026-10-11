import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { createHooksLaunchDeploymentService } from "../src/features/launch/hooks-launch-deployment.js";
import { createHooksLaunchExecutor } from "../src/features/launch/hooks-launch-executor.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { createHooksLaunchSubmissionService } from "../src/features/launch/hooks-launch-submission.js";
import { parseLaunch2Amount } from "../src/features/launch2/launch2-contract.js";
import type { Launch2ServiceDependencies } from "../src/features/launch2/launch2-service.js";
import { createLaunch2Service } from "../src/features/launch2/launch2-service.js";
import type { BscChainCallClient } from "../src/integrations/bsc/rpc-client.js";
import { createUnavailableBscReadClient } from "../src/integrations/bsc/rpc-client.js";
import { createHooksLaunchExecutorChain } from "../src/integrations/launch/hooks-launch-executor-chain.js";
import { createHooksLaunchFactoryReader } from "../src/integrations/launch/hooks-launch-factory-reader.js";
import {
  curveEngineAbi,
  snapshotRegistryAbi,
} from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
import { createLaunch2Chain } from "../src/integrations/launch2/launch2-chain.js";
import { createLaunch2PoolChain } from "../src/integrations/launch2/launch2-pool-chain.js";
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
 * Decision 0124 end to end on a local `anvil --chain-id 97`: the real
 * loop-contracts Foundry scripts deploy the base and the Factory; a Hooks
 * launch is activated through S125 + S132; the NFT sale ends with no mint
 * and the v3 registry opens the public round without a snapshot; 160
 * generated wallets buy their 0.5 % quota until the last buy graduates the
 * curve into the official v4 pool. The OfficialPoolRouter is deployed from
 * the same Foundry build. Then, through the launch2 service:
 *
 * - an exact-input buy and an exact-output sell are quoted (eth_call of the
 *   router with the input token's balance / allowance overridden) and
 *   prepared (router calldata + exact approve, simulation passed under an
 *   allowance override); the script account executes the approve and the
 *   router call on anvil, and the balances move exactly as quoted (the
 *   2 % tax lands in the hook's feeVault);
 * - a router whose code hash differs is 503 POOL_ROUTER_CODE_MISMATCH;
 * - the `launch2_event` lane indexes the two PoolManager `Swap` logs of the
 *   official pool id into `launch2_pool_swaps` and the instance `pool`
 *   projection (counts, USD1 volumes, taxes, last price); a reorg rewind
 *   forgets the sell and the lane re-reads it.
 *
 * Skips when anvil / forge / loop-contracts are absent.
 */

const foundry = locateFoundry();
const skipReason = typeof foundry === "string" ? foundry : null;
if (skipReason !== null) {
  process.stderr.write(
    `[skip] launch2 official-pool anvil suite: ${skipReason}\n`,
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

function encode(
  abi: Abi | readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): Hex {
  return encodeFunctionData({ abi: abi as Abi, functionName, args });
}

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
  "Decision 0124 launch2 official-pool trading on anvil (chain 97)",
  () => {
    const databaseName = `loop_s146_${randomUUID().replaceAll("-", "")}_test`;
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
        [`did:privy:launch2-s146:${randomUUID()}`],
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
          description: "S146 official pool",
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
        fixedBuybackRecipient: "0x28816c4c4792467390c90e5b426f198570e29307",
        configs,
        wallets,
        reader,
        signatureLifetimeSeconds: 900,
        maxSaltAttempts: 2_000_000,
        now: () => Number(chainNow),
      }).prepareSigningRequest({ ownerUserId, projectId, walletId });
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
        fixedBuybackRecipient: "0x28816c4c4792467390c90e5b426f198570e29307",
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
        executorId: `hooks-executor:s146:${randomUUID().slice(0, 8)}`,
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

    function laneFor(
      repository: ReturnType<typeof createPostgresLaunch2Repository>,
    ) {
      return createLaunch2Lane({
        repository,
        chain: createLaunch2Chain({ rpcUrls: [chain.rpcUrl] }),
        chainId: "eip155:97",
        factories: [
          { address: deployed.factory, generation: "v3", current: true },
          // Decision 0122: a read-only legacy Factory registers nothing here
          // and never changes the generation of the current one's launches.
          {
            address: "0x6a69ba7a5a71c114301e20ef95f62cd83d07d9c0",
            generation: "v2",
            current: false,
          },
        ],
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

    /** The router from the Foundry build the helper just compiled. */
    function routerArtifact(): { abi: Abi; bytecode: Hex } {
      const tools = foundry as Exclude<typeof foundry, string>;
      const candidates = [
        join(
          tmpdir(),
          "loop-hooks-executor-forge",
          "out",
          "OfficialPoolRouter.sol",
          "OfficialPoolRouter.json",
        ),
        join(
          tools.protocolDir,
          "out",
          "OfficialPoolRouter.sol",
          "OfficialPoolRouter.json",
        ),
      ];
      const file = candidates.find((candidate) => existsSync(candidate));
      if (file === undefined) throw new Error("OfficialPoolRouter not built");
      const artifact = JSON.parse(readFileSync(file, "utf8")) as {
        abi: Abi;
        bytecode: { object: Hex };
      };
      return { abi: artifact.abi, bytecode: artifact.bytecode.object };
    }

    async function balanceOf(token: string, owner: string): Promise<bigint> {
      return publicClient().readContract({
        address: token as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner as Address],
      });
    }

    async function sendIntentCall(
      key: `0x${string}`,
      call: { readonly to: string; readonly data: string },
      gasHex: string,
    ): Promise<bigint> {
      const wallet = createWalletClient({
        account: privateKeyToAccount(key),
        chain: bscTestnet,
        transport: http(chain.rpcUrl),
      });
      const hash = await wallet.sendTransaction({
        to: call.to as Address,
        data: call.data as Hex,
        gas: BigInt(gasHex),
      });
      const receipt = await publicClient().waitForTransactionReceipt({ hash });
      expect(receipt.status, `tx to ${call.to}`).toBe("success");
      return receipt.blockNumber;
    }

    it("quotes, prepares and executes official-pool buys and sells after graduation, and indexes them", async () => {
      const launch = await activatedLaunch("POOL");
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
      const { curve, snapshots, meme, hook } = record.addresses;

      // No NFT minted: after the sale the v3 registry opens public at once.
      const saleEnd = await publicClient().readContract({
        address: snapshots as Address,
        abi: snapshotRegistryAbi,
        functionName: "nftSaleEnd",
      });
      await warpTo(saleEnd + 1n);
      await send(
        anvilPrivateKey(0),
        snapshots,
        encode(snapshotRegistryAbi, "openPublicWithoutSnapshot", []),
      );
      await chain.mine(3);
      await catchUp(lane);
      expect((await repository.getInstance(instanceId))?.stage).toBe("public");

      // The router (its own code hash: immutables differ from testnet).
      const artifact = routerArtifact();
      const deployer = createWalletClient({
        account: privateKeyToAccount(anvilPrivateKey(0)),
        chain: bscTestnet,
        transport: http(chain.rpcUrl),
      });
      const deployHash = await deployer.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode,
        args: [deployed.poolManager],
      });
      const deployReceipt = await publicClient().waitForTransactionReceipt({
        hash: deployHash,
      });
      const router = deployReceipt.contractAddress!.toLowerCase();
      const routerCode = await chain.request<string>("eth_getCode", [
        router,
        "latest",
      ]);
      const routerCodeHash = keccak256(routerCode as Hex).toLowerCase();

      const writes = {
        configVersion: "bscWriteCanaryV1",
        canaryAssetIds: [`eip155:97:${deployed.usd1}`],
        canaryMaxUsd: "100000",
        canaryDailyMaxUsd: null,
        canaryCounterpartyAddresses: [],
        swapFeeBps: null,
      };
      const serviceWith = (codeHash: string) =>
        createLaunch2Service({
          repository,
          chain: createLaunch2Chain({ rpcUrls: [chain.rpcUrl] }),
          readClient: anvilCallClient(chain.rpcUrl),
          wallets,
          writes: writes as unknown as Launch2ServiceDependencies["writes"],
          cursorCodec: createV2CursorCodec({
            secret: new TextEncoder().encode(
              "0123456789abcdef0123456789abcdef",
            ),
          }),
          chainId: "eip155:97",
          unavailableReason: null,
          quoteTtlSeconds: 60,
          defaultSlippageBps: 100,
          poolChain: createLaunch2PoolChain({
            rpcUrls: [chain.rpcUrl],
            router,
            expectedRuntimeCodeHash: codeHash,
          }),
          now: () => new Date(Number(chainNow) * 1000),
        });
      const service = serviceWith(routerCodeHash);
      const traderKey = anvilPrivateKey(12);
      const trader = privateKeyToAccount(traderKey).address.toLowerCase();
      const traderUser = await user(traderKey);
      const walletId = walletIdOf(traderUser);
      await mintUsd1(trader, 1_000n * wad);

      // Before graduation the pool routes refuse.
      await refreshNow();
      await expect(
        service.poolQuote({
          principal: principal(traderUser),
          instanceId,
          side: "buy",
          mode: "exactIn",
          amount: "50",
          walletId,
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        detailsSafe: { reasonCode: "POOL_NOT_GRADUATED", stage: "public" },
      });

      // Public round: generated wallets buy their quota until graduation.
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
      const graduatedRecord = (await repository.getInstance(instanceId))!;
      expect(graduatedRecord.stage).toBe("graduated");
      const poolId = graduatedRecord.graduation!.poolId;
      expect(graduatedRecord.pool.tradeCount).toBe("0");
      await fund(traderKey);
      await refreshNow();

      // A router with another code hash fails closed.
      await expect(
        serviceWith(`0x${"00".repeat(32)}`).poolQuote({
          principal: principal(traderUser),
          instanceId,
          side: "buy",
          mode: "exactIn",
          amount: "50",
          walletId,
        }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: { reasonCode: "POOL_ROUTER_CODE_MISMATCH" },
      });

      // 1. Exact-input buy of 50 USD1.
      const buyQuote = (
        await service.poolQuote({
          principal: principal(traderUser),
          instanceId,
          side: "buy",
          mode: "exactIn",
          amount: "50",
          walletId,
          slippageBps: "100",
        })
      )["quote"] as Record<string, unknown>;
      expect(buyQuote).toMatchObject({
        venue: "official_pool",
        router,
        poolId,
        amountIn: "50",
        taxToken: "meme",
        exceedsBalance: false,
      });
      const key = buyQuote["poolKey"] as Record<string, unknown>;
      expect(key["hooks"]).toBe(hook);
      expect([key["currency0"], key["currency1"]].sort()).toEqual(
        [deployed.usd1.toLowerCase(), meme].sort(),
      );
      const buyPrepared = await service.preparePoolTrade({
        principal: principal(traderUser),
        instanceId,
        body: {
          walletId,
          side: "buy",
          mode: "exactIn",
          amount: "50",
          slippageBps: 100,
        },
        idempotencyKey: randomUUID(),
      });
      const buyIntent = buyPrepared["launch2Intent"] as Record<string, unknown>;
      expect(buyIntent).toMatchObject({
        kind: "pool_buy",
        contractAddress: router,
        simulation: { status: "passed", reasonCode: null },
        approval: { spender: router, amount: "50" },
      });
      expect(
        (buyPrepared["quote"] as Record<string, unknown>)["expectedOut"],
      ).toBe(buyQuote["expectedOut"]);
      const feeVault = deployed.roles["LOOP_FEE_VAULT"] as string;
      const memeBefore = await balanceOf(meme, trader);
      const vaultMemeBefore = await balanceOf(meme, feeVault);
      const usd1Before = await balanceOf(deployed.usd1, trader);
      const approval = buyIntent["approval"] as {
        calldata: { to: string; data: string };
        unsignedTransaction: { gas: string };
      };
      await sendIntentCall(
        traderKey,
        approval.calldata,
        approval.unsignedTransaction.gas,
      );
      await sendIntentCall(
        traderKey,
        buyIntent["calldata"] as { to: string; data: string },
        (buyIntent["unsignedTransaction"] as { gas: string }).gas,
      );
      const memeBought = (await balanceOf(meme, trader)) - memeBefore;
      expect(memeBought).toBe(
        parseLaunch2Amount(buyQuote["expectedOut"] as string),
      );
      expect(usd1Before - (await balanceOf(deployed.usd1, trader))).toBe(
        50n * wad,
      );
      const buyTax = (await balanceOf(meme, feeVault)) - vaultMemeBefore;
      const quotedBuyTax = parseLaunch2Amount(buyQuote["taxAmount"])!;
      expect(quotedBuyTax - buyTax >= 0n && quotedBuyTax - buyTax <= 1n).toBe(
        true,
      );
      expect(buyTax).toBe(((memeBought + buyTax) * 200n) / 10_000n);

      // 2. Exact-output sell for 10 USD1 net.
      await refreshNow();
      const sellQuote = (
        await service.poolQuote({
          principal: principal(traderUser),
          instanceId,
          side: "sell",
          mode: "exactOut",
          amount: "10",
          walletId,
          slippageBps: "50",
        })
      )["quote"] as Record<string, string>;
      expect(sellQuote).toMatchObject({
        expectedOut: "10",
        minOut: "10",
        taxToken: "usd1",
        zeroForOne: key["currency0"] === meme,
      });
      const sellPrepared = await service.preparePoolTrade({
        principal: principal(traderUser),
        instanceId,
        body: {
          walletId,
          side: "sell",
          mode: "exactOut",
          amount: "10",
          slippageBps: 50,
        },
        idempotencyKey: randomUUID(),
      });
      const sellIntent = sellPrepared["launch2Intent"] as Record<
        string,
        unknown
      >;
      expect(sellIntent).toMatchObject({
        kind: "pool_sell",
        simulation: { status: "passed" },
        approval: { token: meme, spender: router, amount: sellQuote["maxIn"] },
      });
      const usd1BeforeSell = await balanceOf(deployed.usd1, trader);
      const memeBeforeSell = await balanceOf(meme, trader);
      const vaultUsd1Before = await balanceOf(deployed.usd1, feeVault);
      const sellApproval = sellIntent["approval"] as {
        calldata: { to: string; data: string };
        unsignedTransaction: { gas: string };
      };
      await sendIntentCall(
        traderKey,
        sellApproval.calldata,
        sellApproval.unsignedTransaction.gas,
      );
      const sellBlock = await sendIntentCall(
        traderKey,
        sellIntent["calldata"] as { to: string; data: string },
        (sellIntent["unsignedTransaction"] as { gas: string }).gas,
      );
      expect((await balanceOf(deployed.usd1, trader)) - usd1BeforeSell).toBe(
        10n * wad,
      );
      expect(memeBeforeSell - (await balanceOf(meme, trader))).toBe(
        parseLaunch2Amount(sellQuote["amountIn"]),
      );
      const sellTax =
        (await balanceOf(deployed.usd1, feeVault)) - vaultUsd1Before;
      expect(sellTax).toBe(parseLaunch2Amount(sellQuote["taxAmount"]));

      // 3. The lane indexes both PoolManager Swap logs of the pool id.
      await chain.mine(3);
      await catchUp(lane);
      const swaps = await pool.query<{
        side: string;
        caller_address: string;
        usd1_amount: string;
        meme_amount: string;
        tax_amount: string;
        tax_token: string;
        pool_id: string;
      }>(
        `select side, caller_address, usd1_amount::text, meme_amount::text,
           tax_amount::text, tax_token, pool_id
         from public.launch2_pool_swaps
         where instance_id = $1 and not removed
         order by block_number, log_index`,
        [instanceId],
      );
      expect(swaps.rows).toEqual([
        {
          side: "buy",
          caller_address: router,
          usd1_amount: (50n * wad).toString(10),
          meme_amount: (memeBought + buyTax).toString(10),
          tax_amount: buyTax.toString(10),
          tax_token: "meme",
          pool_id: poolId,
        },
        {
          side: "sell",
          caller_address: router,
          usd1_amount: (10n * wad + sellTax).toString(10),
          meme_amount: parseLaunch2Amount(sellQuote["amountIn"])!.toString(10),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          tax_amount: expect.any(String),
          tax_token: "usd1",
          pool_id: poolId,
        },
      ]);
      const sellRowTax = BigInt(swaps.rows[1]!.tax_amount);
      expect(sellRowTax === sellTax || sellRowTax + 1n === sellTax).toBe(true);
      const detail = (
        await service.getInstance({
          principal: principal(traderUser),
          instanceId,
        })
      )["instance"] as Record<string, Record<string, unknown>>;
      expect(detail["pool"]).toMatchObject({
        poolId,
        router,
        tradeCount: "2",
        buyCount: "1",
        sellCount: "1",
        buyVolumeUsd1: "50",
        volume24hUsd1: expect.any(String) as unknown,
      });
      expect(detail["pool"]?.["lastPriceUsd1"]).not.toBeNull();
      expect(detail["pool"]?.["lastTradeAt"]).not.toBeNull();
      expect(
        parseLaunch2Amount(detail["pool"]?.["sellVolumeUsd1"] as string),
      ).toBe(10n * wad + sellTax);

      // 4. A rewind forgets the sell; the lane re-reads it.
      const checkpoint = await repository.getCheckpoint("eip155:97");
      await repository.commitSegment({
        chainId: "eip155:97",
        events: [],
        checkpoint: {
          lastBlockNumber: checkpoint!.lastBlockNumber,
          lastBlockHash: checkpoint!.lastBlockHash,
          startedFromBlockNumber: checkpoint!.startedFromBlockNumber,
        },
        rewindFromBlockNumber: sellBlock.toString(10),
        activationGraceBlocks: 15,
      });
      expect((await repository.getInstance(instanceId))?.pool).toMatchObject({
        tradeCount: "1",
        sellCount: "0",
      });
      await pool.query(
        "update public.indexer_checkpoints set last_block_hash = $1 where lane = 'launch2_event'",
        [`0x${"0".repeat(64)}`],
      );
      expect((await lane.runOnce()).kind).toBe("reorged");
      expect((await repository.getInstance(instanceId))?.pool).toMatchObject({
        tradeCount: "2",
        sellCount: "1",
      });
      expect(anvilAccount(0).address).toBeDefined();
    }, 1_800_000);
  },
);
