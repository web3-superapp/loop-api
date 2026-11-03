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
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedLoopPrincipal } from "../src/core/http/authentication.js";
import { createPostgresAccountWalletRepository } from "../src/database/account-wallet-repository.js";
import { createPostgresBscIndexerRepository } from "../src/database/bsc-indexer-repository.js";
import { createPostgresChainRegistryRepository } from "../src/database/chain-registry-repository.js";
import { createPostgresControlPlaneRepository } from "../src/database/control-plane-repository.js";
import { createPostgresWalletIntentRepository } from "../src/database/wallet-intent-repository.js";
import { createDappContractDirectory } from "../src/features/dapp-browser/contract-directory.js";
import { createDappIntentService } from "../src/features/wallet-intents/dapp-intent-service.js";
import type { WalletIntentRuntime } from "../src/features/wallet-intents/intent-preparation.js";
import { createWalletIntentReconciler } from "../src/features/wallet-intents/intent-reconciliation.js";
import { createWalletIntentService } from "../src/features/wallet-intents/wallet-intent-service.js";
import {
  asChainCallClient,
  createUnavailableBscReadClient,
  type BscChainCallClient,
} from "../src/integrations/bsc/rpc-client.js";
import { createUnavailablePrivySwapAdapter } from "../src/integrations/privy/swap-adapter.js";
import {
  anvilAccount,
  anvilPrivateKey,
  deployTestnetBase,
  locateFoundry,
  startAnvil,
  stopAnvilChains,
  type AnvilChain,
} from "./helpers/anvil.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0197 (S342) end to end on a local `anvil --chain-id 97` and a
 * fresh migrated database: a DApp page asks for an unlimited USD1
 * `approve`; the dapp_tx intent decodes it and flags UNLIMITED_APPROVAL +
 * UNVERIFIED_CONTRACT; a wallet (standing in for the Privy device) signs
 * and broadcasts the exact unsigned transaction; broadcast-report and the
 * reconciliation lane confirm it and the chain shows the allowance. A
 * call that reverts is created not signable with SIMULATION_FAILED, and a
 * personal_sign dapp_sign is confirmed by ecrecover. Skips when anvil /
 * forge / loop-contracts are absent.
 */

const foundry = locateFoundry();
const skipReason = typeof foundry === "string" ? foundry : null;
if (skipReason !== null) {
  process.stderr.write(`[skip] DApp browser anvil suite: ${skipReason}\n`);
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

/** The launch-slot call client the intent flows need, over anvil. */
function anvilIntentClient(rpcUrl: string): BscChainCallClient {
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
    verifyChain: () => Promise.resolve("verified" as const),
    currentVerification: () => "verified" as const,
    getHead: head,
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
    call: async (request) => {
      try {
        const result = await client.call({
          account: request.from as Address,
          to: request.to as Address,
          data: request.data,
          value: request.value,
        });
        return { status: "passed" as const, returnData: result.data ?? "0x" };
      } catch {
        return {
          status: "reverted" as const,
          reasonCode: "BSC_CALL_REVERTED",
        };
      }
    },
    estimateGas: (request) =>
      client
        .estimateGas({
          account: request.from as Address,
          to: request.to as Address,
          data: request.data,
          value: request.value,
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
    getCode: async (address) =>
      (await client.getCode({ address: address as Address })) ?? "0x",
    getTransaction: async (hash) => {
      const tx = await client
        .getTransaction({ hash: hash as Hex })
        .catch(() => null);
      return tx === null
        ? null
        : {
            hash: tx.hash.toLowerCase(),
            from: tx.from.toLowerCase(),
            to: tx.to === null ? null : tx.to.toLowerCase(),
            input: tx.input,
            value: tx.value,
            nonce: tx.nonce,
            chainId: tx.chainId ?? null,
            blockNumber: tx.blockNumber,
          };
    },
    getTransactionReceipt: async (hash) => {
      const receipt = await client
        .getTransactionReceipt({ hash: hash as Hex })
        .catch(() => null);
      return receipt === null
        ? null
        : {
            hash: receipt.transactionHash.toLowerCase(),
            status: receipt.status,
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash.toLowerCase(),
            gasUsed: receipt.gasUsed,
            effectiveGasPrice: receipt.effectiveGasPrice,
          };
    },
  };
}

describe.skipIf(skipReason !== null)(
  "Decision 0197 DApp browser signing exit on anvil (chain 97)",
  () => {
    const databaseName = `loop_s342_dapp_${randomUUID().replaceAll("-", "")}`;
    let pool: InstanceType<typeof Pool>;
    let chain: AnvilChain;
    let usd1: `0x${string}`;

    beforeAll(async () => {
      if (typeof foundry === "string") return;
      chain = await startAnvil(foundry);
      usd1 = deployTestnetBase(foundry, chain.rpcUrl).usd1;
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

    it("approve unlimited → risk flags → device signs and broadcasts → report → reconciled; revert and personal_sign too", async () => {
      const key = anvilPrivateKey(3);
      const owner = privateKeyToAccount(key);
      const ownerAddress = owner.address.toLowerCase();
      const spenderAddress = anvilAccount(4).address.toLowerCase();
      const user = await pool.query<{ id: string }>(
        "insert into public.loop_users (privy_user_id) values ($1) returning id",
        [`did:privy:s342:${randomUUID()}`],
      );
      const userId = user.rows[0]!.id;
      const walletId = randomUUID();
      await pool.query(
        `insert into public.account_wallets
           (wallet_id, owner_user_id, provider_wallet_id, address, kind, is_active)
         values ($1, $2, $3, $4, 'embedded', true)`,
        [walletId, userId, `privy-${userId}`, ownerAddress],
      );
      const principal = {
        userId,
        privyUserId: "did:privy:s342",
        streamUserId: "loop_s342",
      } as AuthenticatedLoopPrincipal;
      const slotClient = anvilIntentClient(chain.rpcUrl);
      const runtime: WalletIntentRuntime = {
        config: {
          bscWrites: {
            configVersion: "bscWriteCanaryV1",
            canaryAssetIds: [],
            canaryMaxUsd: "100000",
            canaryDailyMaxUsd: null,
            canaryCounterpartyAddresses: [],
            swapFeeBps: null,
          },
          privyAppId: null,
          gasReserveRawWei: 0n,
        },
        repository: createPostgresWalletIntentRepository(pool),
        wallets: createPostgresAccountWalletRepository(pool),
        registry: createPostgresChainRegistryRepository(pool),
        indexer: createPostgresBscIndexerRepository(pool),
        readClient: asChainCallClient(
          createUnavailableBscReadClient({
            chainId: "eip155:56",
            chainReference: 56,
            confirmations: 15,
            reorgDepthBlocks: 64,
          }),
        ),
        dapp: {
          enabled: true,
          signingChainId: "eip155:97",
          signingClient: slotClient,
          directory: createDappContractDirectory({
            statics: {
              chainId: "eip155:97",
              loopRouter: null,
              poolRouter: null,
              routerRegistry: null,
              factories: [],
              launchContract: null,
              usd1: null,
            },
            registry: createPostgresChainRegistryRepository(pool),
          }),
        },
        controlPlane: createPostgresControlPlaneRepository(pool),
        marketFacts: null,
        swapAdapter: createUnavailablePrivySwapAdapter(),
        cursorCodec: null,
        now: () => new Date(),
        createUuid: randomUUID,
      };
      const dapp = createDappIntentService(runtime);
      const intents = createWalletIntentService(runtime);
      const signal = new AbortController().signal;
      const approve = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spenderAddress as Address, maxUint256],
      });

      // 1. The page asks for an unlimited approve on tUSD1.
      const { resource: intent } = await dapp.prepareTransaction({
        principal,
        idempotencyKey: randomUUID(),
        body: {
          walletId,
          chainId: "eip155:97",
          origin: "https://dapp.example.org",
          tx: { to: usd1, data: approve, value: "0x0" },
        },
        signal,
      });
      expect(intent).toMatchObject({
        kind: "dapp_tx",
        state: "awaiting_signature",
        simulation: { status: "passed" },
        signing: { allowed: true },
        review: {
          dapp: {
            to: { address: usd1, isContract: true, isVerified: false },
            decodedCall: {
              functionName: "approve",
              standard: "erc20",
              args: {
                spender: spenderAddress,
                amount: maxUint256.toString(10),
              },
            },
            counterparty: {
              address: spenderAddress,
              role: "spender",
              isContract: false,
            },
            // S346 (A5): the spender is an anvil EOA.
            riskFlags: [
              "UNLIMITED_APPROVAL",
              "EOA_SPENDER",
              "UNVERIFIED_CONTRACT",
            ],
          },
        },
      });

      // 2. The device signs and broadcasts the exact unsigned transaction.
      const unsigned = intent.unsignedTransaction!;
      const wallet = createWalletClient({
        account: owner,
        chain: bscTestnet,
        transport: http(chain.rpcUrl),
      });
      const hash = await wallet.sendTransaction({
        to: unsigned.to as Address,
        data: unsigned.data,
        value: BigInt(unsigned.value),
        gas: BigInt(unsigned.gas),
        nonce: Number(BigInt(unsigned.nonce)),
        gasPrice: BigInt(unsigned.gasPrice!),
      });
      const publicClient = createPublicClient({
        chain: bscTestnet,
        transport: http(chain.rpcUrl),
      });
      expect(
        (await publicClient.waitForTransactionReceipt({ hash })).status,
      ).toBe("success");
      const reported = await intents.reportBroadcast({
        principal,
        intentId: intent.intentId,
        body: { txHash: hash },
      });
      expect(reported).toMatchObject({ state: "submitted", kind: "dapp_tx" });

      // 3. The reconciliation lane confirms it on the slot.
      await chain.mine(2);
      await pool.query(
        "update public.wallet_intents set reconcile_after = now() - interval '1 minute' where intent_id = $1",
        [intent.intentId],
      );
      const reconciled = await createWalletIntentReconciler({
        repository: runtime.repository,
        wallets: runtime.wallets,
        readClient: runtime.readClient,
        launchReadClient: slotClient,
        swapAdapter: runtime.swapAdapter,
        createUuid: randomUUID,
      }).reconcileOnce();
      expect(reconciled.transitions).toEqual([
        { intentId: intent.intentId, toState: "confirmed", reasonCode: null },
      ]);
      expect(
        await publicClient.readContract({
          address: usd1,
          abi: erc20Abi,
          functionName: "allowance",
          args: [ownerAddress as Address, spenderAddress as Address],
        }),
      ).toBe(maxUint256);

      // 4. A transfer beyond the balance reverts: created, not signable.
      const { resource: reverting } = await dapp.prepareTransaction({
        principal,
        idempotencyKey: randomUUID(),
        body: {
          walletId,
          chainId: "eip155:97",
          origin: "https://dapp.example.org",
          tx: {
            to: usd1,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [spenderAddress as Address, 10n ** 30n],
            }),
          },
        },
        signal,
      });
      expect(reverting).toMatchObject({
        state: "prepared",
        simulation: { status: "reverted" },
        signing: { allowed: false },
      });
      expect(reverting.review.dapp?.riskFlags).toContain("SIMULATION_FAILED");

      // 5. personal_sign: the signature report ecrecovers to the wallet.
      const { resource: sign } = await dapp.prepareSignature({
        principal,
        idempotencyKey: randomUUID(),
        body: {
          walletId,
          chainId: "eip155:97",
          origin: "https://dapp.example.org",
          method: "personal_sign",
          payload: "Sign in to dapp.example.org",
        },
        signal,
      });
      const confirmed = await dapp.reportSignature({
        principal,
        intentId: sign.intentId,
        body: {
          signature: await owner.signMessage({
            message: "Sign in to dapp.example.org",
          }),
        },
      });
      expect(confirmed.state).toBe("confirmed");
      const events = await pool.query<{ event_type: string }>(
        "select event_type from public.wallet_intent_events where intent_id = $1 order by created_at",
        [sign.intentId],
      );
      expect(events.rows.map((row) => row.event_type)).toContain(
        "signature_reported",
      );
      // The dapp_sign superseded the reverting dapp_tx (DApp ↔ DApp).
      expect(
        await runtime.repository.get(userId, reverting.intentId),
      ).toMatchObject({ state: "expired", reasonCode: "INTENT_SUPERSEDED" });

      // 6. S346 (A4): an open send on the wallet (the user is reviewing
      // it) is never superseded by a DApp prepare — 409 INTENT_BUSY.
      const template = (await runtime.repository.get(
        userId,
        reverting.intentId,
      ))!;
      const sendId = randomUUID();
      await runtime.repository.create({
        intentId: sendId,
        ownerUserId: userId,
        walletId,
        providerOperationId: null,
        kind: "send",
        state: "awaiting_signature",
        chainId: "eip155:97",
        canonicalPayload: { ...template.canonicalPayload, intentId: sendId },
        publicReview: template.publicReview,
        reviewSha256: template.reviewSha256,
        policyConfigVersion: template.policyConfigVersion,
        factsObservedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        simulationStatus: "passed",
        requestId: randomUUID(),
      });
      const openDappSign = await dapp
        .prepareSignature({
          principal,
          idempotencyKey: randomUUID(),
          body: {
            walletId,
            chainId: "eip155:97",
            origin: "https://dapp.example.org",
            method: "personal_sign",
            payload: "busy?",
          },
          signal,
        })
        .then(
          () => "created",
          (error: unknown) => error,
        );
      expect(openDappSign).toMatchObject({
        statusCode: 409,
        code: "RESOURCE_CONFLICT",
        detailsSafe: { reasonCode: "INTENT_BUSY" },
      });
      const busy = await dapp
        .prepareTransaction({
          principal,
          idempotencyKey: randomUUID(),
          body: {
            walletId,
            chainId: "eip155:97",
            origin: "https://dapp.example.org",
            tx: { to: usd1, data: approve, value: "0x0" },
          },
          signal,
        })
        .then(
          () => "created",
          (error: unknown) => error,
        );
      expect(busy).toMatchObject({
        statusCode: 409,
        code: "RESOURCE_CONFLICT",
        detailsSafe: { reasonCode: "INTENT_BUSY" },
      });
      expect(await runtime.repository.get(userId, sendId)).toMatchObject({
        kind: "send",
        state: "awaiting_signature",
      });
      const open = await pool.query<{ count: string }>(
        "select count(*)::text as count from public.wallet_intents where wallet_id = $1 and state in ('prepared', 'awaiting_signature')",
        [walletId],
      );
      expect(open.rows[0]!.count).toBe("1");
      // Once the send is cancelled, the DApp prepare goes through.
      await intents.cancel({ principal, intentId: sendId });
      const after = await dapp.prepareTransaction({
        principal,
        idempotencyKey: randomUUID(),
        body: {
          walletId,
          chainId: "eip155:97",
          origin: "https://dapp.example.org",
          tx: { to: usd1, data: approve, value: "0x0" },
        },
        signal,
      });
      expect(after.created).toBe(true);
    }, 300_000);
  },
);
