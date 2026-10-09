import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createBscIndexerWorker } from "../src/bsc-indexer-worker.js";
import { createPostgresAccountWalletRepository } from "../src/database/account-wallet-repository.js";
import {
  createPostgresBscIndexerRepository,
  createPostgresBscIndexerWalletSetRepository,
} from "../src/database/bsc-indexer-repository.js";
import { createPostgresChainRegistryRepository } from "../src/database/chain-registry-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import {
  BscReadUnavailableError,
  type BscReadClient,
  type BscTransferLogQuery,
} from "../src/integrations/bsc/rpc-client.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0075: per-wallet coverage rows commit in the checkpoint's
 * transaction and are never rewritten.
 */

const { Pool } = pg;
const pool = new Pool({ connectionString: requireIntegrationDatabaseUrl() });
const testPrivyPrefix = "indexer-wallet-coverage-test:";
const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const wbnbAssetId = `eip155:56:${wbnb}`;
const walletA = "0x00000000000000000000000000000000000075a1";
const walletB = "0x00000000000000000000000000000000000075b2";
const walletC = "0x00000000000000000000000000000000000075c3";
const counterparty = "0x00000000000000000000000000000000000075ee";

const indexer = createPostgresBscIndexerRepository(pool);
const walletSet = createPostgresBscIndexerWalletSetRepository(pool);
const registry = createPostgresChainRegistryRepository(pool);
const accountWallets = createPostgresAccountWalletRepository(pool);

function hash(fill: string): string {
  return `0x${fill.repeat(64)}`;
}

interface CoverageRow {
  readonly address: string;
  readonly from_block_number: string;
  readonly first_covered_at: Date;
}

async function coverageRows(): Promise<CoverageRow[]> {
  const result = await pool.query<CoverageRow>(`
    select address, from_block_number::text as from_block_number, first_covered_at
    from public.indexer_wallet_coverage
    where chain_id = 'eip155:56' and lane = 'erc20_transfer'
    order by address
  `);
  return result.rows;
}

async function cleanFixtures(): Promise<void> {
  await pool.query(
    `delete from public.indexer_wallet_coverage where chain_id = 'eip155:56'`,
  );
  await pool.query(
    `delete from public.indexer_checkpoints where chain_id = 'eip155:56'`,
  );
  await pool.query(
    `delete from public.indexed_approvals where chain_id = 'eip155:56'`,
  );
  await pool.query(
    `delete from public.indexed_transfers where chain_id = 'eip155:56'`,
  );
  await pool.query({
    text: `
      delete from public.account_wallets
      where owner_user_id in (
        select id from public.loop_users where privy_user_id like $1
      )
    `,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `delete from public.loop_users where privy_user_id like $1`,
    values: [`${testPrivyPrefix}%`],
  });
}

async function createOwner(): Promise<string> {
  const result = await pool.query<{ id: string }>({
    text: `insert into public.loop_users (privy_user_id) values ($1) returning id`,
    values: [`${testPrivyPrefix}${randomUUID()}`],
  });
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("owner setup failed");
  }
  return id;
}

function readClientFake(
  head: bigint,
  queries: BscTransferLogQuery[],
): BscReadClient {
  const blockHash = (blockNumber: bigint): string =>
    `0x${blockNumber.toString(16).padStart(64, "0")}`;
  return {
    chainId: "eip155:56",
    chainReference: 56,
    confirmations: 15,
    reorgDepthBlocks: 64,
    endpointRefs: ["rpc-000000000000"],
    verifyChain: () => Promise.resolve("verified"),
    currentVerification: () => "verified",
    getHead: () =>
      Promise.resolve({
        blockNumber: head,
        blockHash: blockHash(head),
        observedAt: "2026-09-25T00:00:00.000Z",
      }),
    getBlockHash: (blockNumber) => Promise.resolve(blockHash(blockNumber)),
    readTokenIdentity: () => Promise.reject(new Error("not used")),
    readPoolIdentity: () => Promise.reject(new Error("not used")),
    readBalances: () => Promise.reject(new Error("not used")),
    readTransferLogs: (query) => {
      queries.push(query);
      return Promise.resolve(
        query.fromBlock <= 1_010n && query.toBlock >= 1_010n
          ? [
              {
                transactionHash: hash("9"),
                logIndex: 0,
                blockNumber: 1_010n,
                blockHash: blockHash(1_010n),
                address: wbnb,
                from: counterparty,
                to: walletA,
                value: 5n,
                removed: false,
              },
            ]
          : [],
      );
    },
    readPoolEventLogs: () => Promise.resolve([]),
    readApprovalLogs: () => Promise.resolve([]),
    probeEndpoints: () => Promise.resolve([]),
  };
}

describe("PostgreSQL indexer wallet coverage (Decision 0075)", () => {
  beforeAll(async () => {
    await registry.upsertAsset({
      assetId: wbnbAssetId,
      chainId: bscChainId,
      address: wbnb,
      symbol: "WBNB",
      name: "Wrapped BNB",
      decimals: 18,
      status: "pending",
      sourceBlockNumber: "43000000",
    });
  });

  beforeEach(async () => {
    await cleanFixtures();
  });

  afterAll(async () => {
    await cleanFixtures();
    await pool.end();
  });

  it("writes coverage rows in the checkpoint's transaction and never rewrites an existing from_block_number", async () => {
    const first = await indexer.commitTransferSegment({
      chainId: bscChainId,
      transfers: [],
      checkpoint: {
        lastBlockNumber: "1999",
        lastBlockHash: hash("a"),
        startedFromBlockNumber: "1000",
      },
      walletCoverage: {
        addresses: [walletA, walletB],
        fromBlockNumber: "1000",
      },
    });
    expect(first.lastBlockNumber).toBe("1999");
    const initial = await coverageRows();
    expect(initial.map((row) => [row.address, row.from_block_number])).toEqual([
      [walletA, "1000"],
      [walletB, "1000"],
    ]);

    await indexer.commitTransferSegment({
      chainId: bscChainId,
      transfers: [],
      checkpoint: {
        lastBlockNumber: "3999",
        lastBlockHash: hash("b"),
        startedFromBlockNumber: "1000",
      },
      walletCoverage: {
        addresses: [walletA, walletB, walletC],
        fromBlockNumber: "2000",
      },
    });
    const after = await coverageRows();
    expect(after.map((row) => [row.address, row.from_block_number])).toEqual([
      [walletA, "1000"],
      [walletB, "1000"],
      [walletC, "2000"],
    ]);
    expect(after[0]?.first_covered_at.toISOString()).toBe(
      initial[0]?.first_covered_at.toISOString(),
    );

    // A reorg replay below an existing row does not move it either.
    await indexer.commitTransferSegment({
      chainId: bscChainId,
      transfers: [],
      checkpoint: {
        lastBlockNumber: "3999",
        lastBlockHash: hash("c"),
        startedFromBlockNumber: "1000",
      },
      rewindFromBlockNumber: "1500",
      walletCoverage: {
        addresses: [walletA, walletB, walletC],
        fromBlockNumber: "1500",
      },
    });
    expect(
      (await coverageRows()).map((row) => [row.address, row.from_block_number]),
    ).toEqual([
      [walletA, "1000"],
      [walletB, "1000"],
      [walletC, "2000"],
    ]);
  });

  it("rolls the coverage rows back with a checkpoint advance that fails", async () => {
    await indexer.commitTransferSegment({
      chainId: bscChainId,
      transfers: [],
      checkpoint: {
        lastBlockNumber: "1999",
        lastBlockHash: hash("a"),
        startedFromBlockNumber: "1000",
      },
      walletCoverage: { addresses: [walletA], fromBlockNumber: "1000" },
    });

    // The checkpoint write is the last statement of the transaction; a hash
    // the table refuses makes it fail after the coverage insert ran.
    await expect(
      indexer.commitTransferSegment({
        chainId: bscChainId,
        transfers: [],
        checkpoint: {
          lastBlockNumber: "3999",
          lastBlockHash: "0xnot-a-hash",
          startedFromBlockNumber: "1000",
        },
        walletCoverage: {
          addresses: [walletA, walletB],
          fromBlockNumber: "2000",
        },
      }),
    ).rejects.toThrow();

    expect(
      (await coverageRows()).map((row) => [row.address, row.from_block_number]),
    ).toEqual([[walletA, "1000"]]);
    await expect(
      indexer.getCheckpoint("erc20_transfer", bscChainId),
    ).resolves.toMatchObject({ lastBlockNumber: "1999" });
  });

  it("lists each active wallet address once, of any kind and owner, and leaves archived ones out", async () => {
    const firstOwner = await createOwner();
    const secondOwner = await createOwner();
    await accountWallets.sync({
      ownerUserId: firstOwner,
      observed: [
        {
          address: walletA,
          kind: "embedded",
          providerWalletId: "s82_wallet_1",
        },
        { address: walletB, kind: "external", providerWalletId: null },
      ],
    });
    // walletB is also linked by a second account; walletC is archived there.
    await accountWallets.sync({
      ownerUserId: secondOwner,
      observed: [
        { address: walletB, kind: "external", providerWalletId: null },
        { address: walletC, kind: "external", providerWalletId: null },
      ],
    });
    await accountWallets.sync({
      ownerUserId: secondOwner,
      observed: [
        { address: walletB, kind: "external", providerWalletId: null },
      ],
    });

    const addresses = await walletSet.listActiveWalletAddresses();
    const fixtures = addresses.filter((address) =>
      [walletA, walletB, walletC].includes(address),
    );
    expect(fixtures).toEqual([walletA, walletB]);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it("covers a wallet from the tick it first appears in through the real lane and repository", async () => {
    const owner = await createOwner();
    await accountWallets.sync({
      ownerUserId: owner,
      observed: [
        {
          address: walletA,
          kind: "embedded",
          providerWalletId: "s82_wallet_2",
        },
      ],
    });
    const queries: BscTransferLogQuery[] = [];
    const worker = createBscIndexerWorker({
      repository: indexer,
      registry,
      walletSet,
      readClient: readClientFake(5_000n, queries),
      chainId: bscChainId,
      startBlockNumber: 1_000,
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "seeded",
      fromBlockNumber: "1000",
      toBlockNumber: "2999",
      transferCount: 1,
    });
    expect(queries[0]?.walletFilter?.walletAddresses).toContain(walletA);

    await accountWallets.sync({
      ownerUserId: owner,
      observed: [
        {
          address: walletA,
          kind: "embedded",
          providerWalletId: "s82_wallet_2",
        },
        { address: walletC, kind: "external", providerWalletId: null },
      ],
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "advanced",
      fromBlockNumber: "3000",
    });

    const rows = (await coverageRows()).filter((row) =>
      [walletA, walletC].includes(row.address),
    );
    expect(rows.map((row) => [row.address, row.from_block_number])).toEqual([
      [walletA, "1000"],
      [walletC, "3000"],
    ]);
    await expect(
      indexer.getCheckpoint("erc20_transfer", bscChainId),
    ).resolves.toMatchObject({ lastBlockNumber: "4999" });
    const stored = await indexer.listWalletTransfers({
      chainId: bscChainId,
      address: walletA,
      assetIds: [wbnbAssetId],
      limit: 10,
    });
    expect(stored.items).toHaveLength(1);
  });

  it("leaves checkpoint and coverage untouched when a wallet-scoped read is refused", async () => {
    const owner = await createOwner();
    await accountWallets.sync({
      ownerUserId: owner,
      observed: [
        {
          address: walletA,
          kind: "embedded",
          providerWalletId: "s82_wallet_3",
        },
      ],
    });
    const worker = createBscIndexerWorker({
      repository: indexer,
      registry,
      walletSet,
      readClient: {
        ...readClientFake(5_000n, []),
        readTransferLogs: () =>
          Promise.reject(new BscReadUnavailableError("BSC_LOG_QUERY_REJECTED")),
      },
      chainId: bscChainId,
      startBlockNumber: 1_000,
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "unavailable",
      reasonCode: "BSC_LOG_QUERY_REJECTED",
    });
    await expect(coverageRows()).resolves.toEqual([]);
    await expect(
      indexer.getCheckpoint("erc20_transfer", bscChainId),
    ).resolves.toBeNull();
  });
});
