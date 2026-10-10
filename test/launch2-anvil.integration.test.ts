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
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { createHooksLaunchDeploymentService } from "../src/features/launch/hooks-launch-deployment.js";
import { createHooksLaunchExecutor } from "../src/features/launch/hooks-launch-executor.js";
import { buildLaunchMerkleTree } from "../src/features/launch/launch-merkle.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { createHooksLaunchSubmissionService } from "../src/features/launch/hooks-launch-submission.js";
import { parseLaunch2Amount } from "../src/features/launch2/launch2-contract.js";
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
 * Decision 0114 end to end on a local `anvil --chain-id 97`: the real
 * loop-contracts Foundry scripts deploy the base and the LoopLaunchFactory;
 * a Hooks launch goes owner draft → independent approval → signature →
 * S132 executor deploy + activation; the launch2_event lane registers the
 * instance from the activated task; two wallets mint the project NFT (one
 * through the launch2 NFT prepare); a 2-of-3 snapshot of the cutoff holders
 * is published; a holder buys in the priority hour through the launch2
 * quote + trade prepare (MAX and quote equal the contract's views); a
 * non-holder is refused; after indexing, instances / positions / trades /
 * snapshot members are what the chain says. Skips when anvil / forge /
 * loop-contracts are absent.
 */

const foundry = locateFoundry();
const skipReason = typeof foundry === "string" ? foundry : null;
if (skipReason !== null) {
  process.stderr.write(`[skip] launch2 anvil suite: ${skipReason}\n`);
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
  "Decision 0114 launch2 read model on anvil (chain 97)",
  () => {
    const databaseName = `loop_s134_${randomUUID().replaceAll("-", "")}`;
    let pool: InstanceType<typeof Pool>;
    let chain: AnvilChain;
    let deployed: DeployedProtocol;
    let factoryCodeHash: string;
    let chainNow = 0n;
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
        [`did:privy:launch2-s134:${randomUUID()}`],
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
          description: "S134 launch2",
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
        executorId: `hooks-executor:s134:${randomUUID().slice(0, 8)}`,
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
          return { ownerUserId, saleStart };
        }
        await chain.mine(1);
      }
      throw new Error("the launch never reached activated");
    }

    it("indexes an activated launch: NFT sale, snapshot, priority buy → instances / positions / trades", async () => {
      const launch = await activatedLaunch("LTWO");
      const repository = createPostgresLaunch2Repository(pool);
      const launch2Chain = createLaunch2Chain({ rpcUrls: [chain.rpcUrl] });
      const lane = createLaunch2Lane({
        repository,
        chain: launch2Chain,
        chainId: "eip155:97",
        factoryAddress: deployed.factory,
        reorgDepthBlocks: 15,
        pollIntervalMs: 1_000,
        now: () => new Date(Number(chainNow) * 1000),
      });
      const service = createLaunch2Service({
        repository,
        chain: launch2Chain,
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

      // 1. The lane registers the activated task and sees the activation.
      await refreshNow();
      const first = await lane.runOnce();
      expect(first.registered).toBe(1);
      expect(first.kind).toBe("seeded");
      const holderKey = anvilPrivateKey(12);
      const secondKey = anvilPrivateKey(13);
      const outsiderKey = anvilPrivateKey(14);
      const holderUser = await user(holderKey);
      const outsiderUser = await user(outsiderKey);
      let list = await service.listInstances({
        principal: principal(holderUser),
      });
      const instances = list["instances"] as Record<string, unknown>[];
      expect(instances).toHaveLength(1);
      const instanceId = instances[0]!["instanceId"] as string;
      expect(instances[0]).toMatchObject({ stage: "upcoming", ticker: "LTWO" });
      const detail = (
        await service.getInstance({
          principal: principal(launch.ownerUserId),
          instanceId,
        })
      )["instance"] as Record<string, Record<string, string>>;
      expect(detail["viewerIsProjectOwner"]).toBe(true);
      const contracts = detail["contracts"] as Record<string, string>;
      expect(contracts["meme"]!.endsWith("6666")).toBe(true);

      // 2. Fund the wallets with tUSD1 (deployer = owner) and gas.
      for (const key of [holderKey, secondKey, outsiderKey]) {
        await send(
          anvilPrivateKey(0),
          deployed.usd1,
          encode(usd1MintAbi, "mint", [
            privateKeyToAccount(key).address,
            10_000n * wad,
          ]),
        );
      }

      // 3. NFT sale: the holder mints through the prepare, the second directly.
      await warpTo(launch.saleStart + 10n);
      const nftIntent = (
        await service.prepareNftMint({
          principal: principal(holderUser),
          instanceId,
          body: { walletId: walletIdOf(holderUser) },
          idempotencyKey: randomUUID(),
        })
      )["launch2Intent"] as Record<string, Record<string, string>>;
      expect(nftIntent["approval"]).toMatchObject({
        spender: contracts["nft"],
        amount: "100",
      });
      await send(
        holderKey,
        nftIntent["approval"]!["token"]!,
        (nftIntent["approval"] as unknown as { calldata: { data: Hex } })
          .calldata.data,
      );
      await send(
        holderKey,
        nftIntent["calldata"]!["to"]!,
        nftIntent["calldata"]!["data"] as Hex,
      );
      await send(
        secondKey,
        deployed.usd1,
        encode(erc20Abi, "approve", [contracts["nft"], 100n * wad]),
      );
      await send(secondKey, contracts["nft"]!, encode(nftMintAbi, "mint", []));
      await lane.runOnce();
      list = await service.listInstances({ principal: principal(holderUser) });
      expect((list["instances"] as Record<string, unknown>[])[0]).toMatchObject(
        {
          stage: "nft_sale",
          nftSale: { soldCount: "2" },
        },
      );

      // 4. Cutoff: the last block before the sale end, then the 2-of-3 list.
      const saleEnd = launch.saleStart + 604_800n;
      await warpTo(saleEnd - 1n);
      const cutoff = await publicClient().getBlock({ blockTag: "latest" });
      await warpTo(saleEnd);
      const holders = [holderKey, secondKey].map((key) =>
        privateKeyToAccount(key).address.toLowerCase(),
      );
      const tree = buildLaunchMerkleTree(holders);
      const dataHash = keccak256(toHex(holders.slice().sort().join(",")));
      const domain = {
        name: "LOOP NFT Snapshot",
        version: "1",
        chainId: 97,
        verifyingContract: contracts["snapshots"] as Address,
      } as const;
      const types = {
        Snapshot: [
          { name: "launchId", type: "bytes32" },
          { name: "nft", type: "address" },
          { name: "cutoffBlock", type: "uint256" },
          { name: "cutoffBlockHash", type: "bytes32" },
          { name: "dataHash", type: "bytes32" },
          { name: "root", type: "bytes32" },
        ],
      } as const;
      const message = {
        launchId: detail["launchId"] as unknown as Hex,
        nft: contracts["nft"] as Address,
        cutoffBlock: cutoff.number,
        cutoffBlockHash: cutoff.hash,
        dataHash,
        root: tree.root as Hex,
      };
      const [sig0, sig1] = await Promise.all(
        [9, 10].map((index) =>
          privateKeyToAccount(anvilPrivateKey(index)).signTypedData({
            domain,
            types,
            primaryType: "Snapshot",
            message,
          }),
        ),
      );
      await send(
        anvilPrivateKey(0),
        contracts["snapshots"]!,
        encode(snapshotRegistryAbi, "publishSnapshot", [
          cutoff.number,
          cutoff.hash,
          dataHash,
          tree.root,
          sig0,
          sig1,
        ]),
      );
      await refreshNow();
      await lane.runOnce();
      const published = (
        await service.getInstance({
          principal: principal(holderUser),
          instanceId,
        })
      )["instance"] as Record<string, Record<string, unknown>>;
      expect(published["stage"]).toBe("priority");
      expect(published["snapshot"]).toMatchObject({
        status: "published",
        verification: "verified",
        root: tree.root,
        memberCount: 2,
        signers: [9, 10].map((index) =>
          anvilAccount(index).address.toLowerCase(),
        ),
      });
      expect(published["viewer"]).toMatchObject({
        snapshot: { member: true, eligibleNow: true },
        nft: { mintedTokenId: "1", held: 1 },
      });

      // 5. Priority buy through quote + prepare; the numbers equal the contract's.
      const holderAddress = privateKeyToAccount(holderKey).address;
      const quote = (
        await service.quote({
          principal: principal(holderUser),
          instanceId,
          side: "buy",
          amount: "50",
          walletId: walletIdOf(holderUser),
        })
      )["quote"] as {
        readonly max: {
          amountIn: string;
          amountOut: string;
          limitedBy: string;
        };
        readonly expectedOut: string;
        readonly taxUsd1: string;
        readonly minOut: string;
        readonly deadline: string;
      };
      const curve = contracts["curve"] as Address;
      const [chainMaxIn, chainMaxOut] = await publicClient().readContract({
        address: curve,
        abi: curveEngineAbi,
        functionName: "quoteMaxBuy",
        args: [holderAddress],
      });
      expect(parseLaunch2Amount(quote.max.amountIn)).toBe(chainMaxIn);
      expect(parseLaunch2Amount(quote.max.amountOut)).toBe(chainMaxOut);
      expect(quote.max.limitedBy).toBe("quota");
      const chainQuote = await publicClient().readContract({
        address: curve,
        abi: curveEngineAbi,
        functionName: "quoteBuy",
        args: [holderAddress, 50n * wad],
      });
      expect(parseLaunch2Amount(quote.expectedOut)).toBe(chainQuote[0]);
      expect(parseLaunch2Amount(quote.taxUsd1)).toBe(chainQuote[2]);
      const tradeIntent = (
        await service.prepareTrade({
          principal: principal(holderUser),
          instanceId,
          body: {
            walletId: walletIdOf(holderUser),
            side: "buy",
            amount: "50",
            minOut: quote.minOut,
            deadline: quote.deadline,
          },
          idempotencyKey: randomUUID(),
        })
      )["launch2Intent"] as Record<string, Record<string, unknown>>;
      expect(tradeIntent["unsignedTransaction"]).toMatchObject({
        chainId: 97,
        from: holderAddress.toLowerCase(),
        to: curve,
      });
      const approval = tradeIntent["approval"] as {
        token: string;
        calldata: { data: Hex };
      };
      await send(holderKey, approval.token, approval.calldata.data);
      await send(
        holderKey,
        curve,
        (tradeIntent["calldata"] as { data: Hex }).data,
      );
      // A wallet outside the snapshot is refused in the priority hour.
      await expect(
        service.prepareTrade({
          principal: principal(outsiderUser),
          instanceId,
          body: {
            walletId: walletIdOf(outsiderUser),
            side: "buy",
            amount: "5",
            minOut: "1",
            deadline: quote.deadline,
          },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: "POLICY_BLOCKED",
        detailsSafe: { reasonCode: "LAUNCH2_NOT_IN_SNAPSHOT" },
      });

      // 6. Index and compare with the chain.
      await refreshNow();
      await lane.runOnce();
      const onChainCumulative = await publicClient().readContract({
        address: curve,
        abi: curveEngineAbi,
        functionName: "cumulativeBought",
        args: [holderAddress],
      });
      const onChainSold = await publicClient().readContract({
        address: curve,
        abi: curveEngineAbi,
        functionName: "soldSupply",
        args: [],
      });
      expect(onChainCumulative).toBe(chainQuote[0]);
      const trades = await repository.listTrades({ instanceId, limit: 10 });
      expect(trades).toHaveLength(1);
      expect(trades[0]).toMatchObject({
        side: "buy",
        traderAddress: holderAddress.toLowerCase(),
        memeAmount: onChainCumulative.toString(10),
        cumulativeBought: onChainCumulative.toString(10),
        taxUsd1: chainQuote[2].toString(10),
      });
      const record = await repository.getInstance(instanceId);
      expect(record).toMatchObject({
        stage: "priority",
        nftMintedCount: "2",
        soldSupply: onChainSold.toString(10),
        tradeCount: "1",
        holdReason: null,
        deployedEventSeen: true,
      });
      const positions = (
        await service.listMyPositions({
          principal: principal(holderUser),
        })
      )["positions"] as Record<string, Record<string, unknown>>[];
      expect(positions).toEqual([
        expect.objectContaining({
          instanceId,
          stage: "priority",
          snapshotMember: true,
          nft: { mintedTokenId: "1", held: 1 },
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          curve: expect.objectContaining({
            bought: quote.expectedOut,
            cumulativeBought: quote.expectedOut,
          }),
        }),
      ]);
      const second = await repository.listPositions({
        holderAddresses: [privateKeyToAccount(secondKey).address.toLowerCase()],
        instanceId,
      });
      expect(second).toEqual([
        expect.objectContaining({
          nftMintedTokenId: "2",
          nftHeld: 1,
          curveBought: "0",
          snapshotMember: true,
        }),
      ]);
      // Re-running over the same blocks changes nothing (idempotent upserts).
      const again = await lane.runOnce();
      expect(again.kind === "idle" || again.kind === "advanced").toBe(true);
      expect(
        await repository.listTrades({ instanceId, limit: 10 }),
      ).toHaveLength(1);

      // 7. Reorg convergence: a rewind marks the buy removed and the
      //    projection forgets it; a checkpoint hash mismatch makes the lane
      //    rewind by the reorg depth and re-read it.
      const buyBlock = trades[0]!.blockNumber;
      const checkpoint = await repository.getCheckpoint("eip155:97");
      await repository.commitSegment({
        chainId: "eip155:97",
        events: [],
        checkpoint: {
          lastBlockNumber: checkpoint!.lastBlockNumber,
          lastBlockHash: checkpoint!.lastBlockHash,
          startedFromBlockNumber: checkpoint!.startedFromBlockNumber,
        },
        rewindFromBlockNumber: buyBlock,
        activationGraceBlocks: 15,
      });
      expect(await repository.listTrades({ instanceId, limit: 10 })).toEqual(
        [],
      );
      expect(await repository.getInstance(instanceId)).toMatchObject({
        soldSupply: "0",
        tradeCount: "0",
      });
      await pool.query(
        "update public.indexer_checkpoints set last_block_hash = $1 where lane = 'launch2_event'",
        [`0x${"0".repeat(64)}`],
      );
      const reorged = await lane.runOnce();
      expect(reorged.kind).toBe("reorged");
      expect(
        await repository.listTrades({ instanceId, limit: 10 }),
      ).toHaveLength(1);
      expect(await repository.getInstance(instanceId)).toMatchObject({
        soldSupply: onChainSold.toString(10),
        tradeCount: "1",
      });

      // 8. Signing requests are append-only and count in the canary window.
      await expect(
        pool.query("update public.launch2_intents set min_out = 0"),
      ).rejects.toThrow(/append-only/u);
      const exposure = await pool.query<{ total: string }>(
        `select coalesce(sum((policy ->> 'valueUsd')::numeric), 0)::text as total
         from public.launch2_intents where owner_user_id = $1`,
        [holderUser],
      );
      expect(exposure.rows[0]?.total).toBe("150");
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
