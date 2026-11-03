import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPostgresAccountWalletRepository,
  type AccountWalletRepository,
} from "../src/database/account-wallet-repository.js";
import {
  createPostgresBscIndexerRepository,
  type BscIndexerRepository,
} from "../src/database/bsc-indexer-repository.js";
import {
  createPostgresChainRegistryRepository,
  type ChainRegistryRepository,
} from "../src/database/chain-registry-repository.js";
import {
  createPostgresControlPlaneRepository,
  type ControlPlaneRepository,
} from "../src/database/control-plane-repository.js";
import {
  createPostgresWalletIntentRepository,
  WalletIntentStateConflictError,
  type CreateWalletIntentInput,
  type WalletIntentRepository,
} from "../src/database/wallet-intent-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import {
  sealIntent,
  type IntentSource,
} from "../src/features/wallet-intents/intent-contract.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

const { Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();

const pool = new Pool({ connectionString: databaseUrl });
const testPrivyPrefix = "wallet-intent-repository-test:";
const usdt = "0x55d398326f99059ff775485246999027b3197955";
const usdtAssetId = `eip155:56:${usdt}`;
const walletAddress = "0x00000000000000000000000000000000000000a1";
const recipient = "0x00000000000000000000000000000000000000b2";
const spender = "0x00000000000000000000000000000000000000c3";
const blockHash = `0x${"a".repeat(64)}`;

let registry: ChainRegistryRepository;
let wallets: AccountWalletRepository;
let indexer: BscIndexerRepository;
let controlPlane: ControlPlaneRepository;
let intents: WalletIntentRepository;

async function cleanFixtures(): Promise<void> {
  const owners = `select id from public.loop_users where privy_user_id like $1`;
  // Both histories are append-only by trigger; the fixture is the only
  // writer allowed to unwind its own rows.
  await pool.query(
    `alter table public.wallet_intent_events disable trigger wallet_intent_events_append_only`,
  );
  await pool.query({
    text: `delete from public.wallet_intent_events where owner_user_id in (${owners})`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query(
    `alter table public.wallet_intent_events enable trigger wallet_intent_events_append_only`,
  );
  await pool.query({
    text: `delete from public.swap_quotes where owner_user_id in (${owners})`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `delete from public.wallet_intents where owner_user_id in (${owners})`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `delete from public.approval_observations where wallet_id in (
      select wallet_id from public.account_wallets where owner_user_id in (${owners})
    )`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query(
    `alter table public.audit_events disable trigger audit_events_append_only`,
  );
  await pool.query({
    text: `delete from public.audit_events where owner_user_id in (${owners})`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query(
    `alter table public.audit_events enable trigger audit_events_append_only`,
  );
  await pool.query({
    text: `delete from public.provider_operations where owner_user_id in (${owners})`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `delete from public.idempotency_records where owner_user_id in (${owners})`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `delete from public.account_wallets where owner_user_id in (${owners})`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `delete from public.loop_users where privy_user_id like $1`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query(
    `delete from public.indexed_approvals where chain_id = 'eip155:56'`,
  );
  await pool.query(
    `delete from public.indexed_transfers where chain_id = 'eip155:56'`,
  );
  await pool.query(
    `delete from public.indexer_checkpoints where chain_id = 'eip155:56'`,
  );
  await pool.query(
    `delete from public.indexed_pool_events where chain_id = 'eip155:56'`,
  );
  await pool.query(`delete from public.pools where chain_id = 'eip155:56'`);
  await pool.query({
    text: `delete from public.assets where asset_id = $1`,
    values: [usdtAssetId],
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

async function seedAsset(): Promise<void> {
  await registry.upsertAsset({
    assetId: usdtAssetId,
    chainId: bscChainId,
    address: usdt,
    symbol: "USDT",
    name: "Tether USD",
    decimals: 18,
    status: "pending",
    sourceBlockNumber: "43000000",
  });
}

async function seedWallet(ownerUserId: string): Promise<string> {
  const records = await wallets.sync({
    ownerUserId,
    observed: [
      { address: walletAddress, kind: "embedded", providerWalletId: "w_1" },
    ],
  });
  const wallet = records[0];
  if (wallet === undefined) {
    throw new Error("wallet setup failed");
  }
  return wallet.walletId;
}

function source(intentId: string, walletId: string): IntentSource {
  const now = new Date();
  return {
    version: "walletIntentSendV1",
    intentId,
    kind: "send",
    chainId: "eip155:56",
    walletId,
    from: walletAddress,
    asset: {
      assetId: usdtAssetId,
      address: usdt,
      symbol: "USDT",
      decimals: 18,
    },
    amount: { raw: "1000000000000000000", display: "1" },
    recipient: {
      address: recipient,
      checksumAddress: recipient,
      isContract: false,
      isFirstRecipient: true,
      basis: "indexed_erc20_transfers",
      screening: {
        status: "unavailable",
        reasonCode: "GOPLUS_ADDRESS_SCREENING_NOT_CONFIGURED",
      },
    },
    spender: null,
    decodedCall: null,
    transaction: {
      chainId: 56,
      from: walletAddress,
      to: usdt,
      data: "0xa9059cbb",
      value: "0x0",
      gas: "0xcb20",
      nonce: "0x7",
      type: "eip1559",
      maxFeePerGas: "0xb2d05e00",
      maxPriorityFeePerGas: "0x3b9aca00",
      gasPrice: null,
    },
    fee: null,
    balance: {
      blockNumber: "44000000",
      blockHash,
      observedAt: now.toISOString(),
      rawBalance: "5000000000000000000",
      displayBalance: "5",
      rawNativeBalance: "2000000000000000000",
      gasReserveRaw: "5000000000000000",
    },
    simulation: {
      status: "passed",
      source: "rpc_call",
      observedAt: now.toISOString(),
      reasonCode: null,
    },
    policy: {
      configVersion: "bscWriteCanaryV1",
      canaryMaxUsd: "20",
      exposureBasis: "amount",
      exposureRaw: "1000000000000000000",
      exposureBlockNumber: "44000000",
      valueUsd: "1",
      priceSource: "dexscreener",
      priceFetchedAt: now.toISOString(),
    },
    swap: null,
    signingMode: "device_eth_send_transaction",
    factsObservedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 120_000).toISOString(),
  };
}

async function createInput(
  ownerUserId: string,
  walletId: string,
  overrides: Partial<CreateWalletIntentInput> = {},
): Promise<CreateWalletIntentInput> {
  const intentId = randomUUID();
  const sealed = sealIntent(source(intentId, walletId));
  const operation = await controlPlane.prepareProviderOperation({
    ownerUserId,
    scope: "wallet_intent_prepare",
    idempotencyKey: randomUUID(),
    keySource: "client",
    requestSha256: sealed.reviewSha256,
    domain: "bsc",
    operationKind: "wallet_intent_send",
    requestId: randomUUID(),
  });
  return {
    intentId,
    ownerUserId,
    walletId,
    providerOperationId: operation.operation.id,
    kind: "send",
    state: "awaiting_signature",
    chainId: bscChainId,
    canonicalPayload: sealed.canonicalPayload,
    publicReview: sealed.publicReview,
    reviewSha256: sealed.reviewSha256,
    policyConfigVersion: "bscWriteCanaryV1",
    factsObservedAt: sealed.canonicalPayload.factsObservedAt,
    expiresAt: sealed.canonicalPayload.expiresAt,
    simulationStatus: "passed",
    requestId: randomUUID(),
    ...overrides,
  };
}

describe("PostgreSQL wallet intents, approvals, and migration 000021", () => {
  beforeAll(() => {
    registry = createPostgresChainRegistryRepository(pool);
    wallets = createPostgresAccountWalletRepository(pool);
    indexer = createPostgresBscIndexerRepository(pool);
    controlPlane = createPostgresControlPlaneRepository(pool);
    intents = createPostgresWalletIntentRepository(pool);
  });

  beforeEach(async () => {
    await cleanFixtures();
    await seedAsset();
  });

  afterAll(async () => {
    await cleanFixtures();
    await pool.end();
  });

  it("sums only the exposure that may still spend, inside the window (Decision 0065)", async () => {
    const owner = await createOwner();
    const walletId = await seedWallet(owner);
    const since = new Date(Date.now() - 60_000).toISOString();
    expect(
      await intents.sumRecentExposureUsd({ ownerUserId: owner, since }),
    ).toBe("0");

    const first = await intents.create(await createInput(owner, walletId));
    expect(
      await intents.sumRecentExposureUsd({ ownerUserId: owner, since }),
    ).toBe("1");

    // The second preparation supersedes the first: an expired intent never
    // reached a signer, so the day's exposure stays at one intent.
    const second = await intents.create(await createInput(owner, walletId));
    expect(
      await intents.sumRecentExposureUsd({ ownerUserId: owner, since }),
    ).toBe("1");

    const submitted = await intents.transition({
      ownerUserId: owner,
      intentId: second.intentId,
      expectedVersion: second.recordVersion,
      fromStates: ["awaiting_signature"],
      toState: "submitted",
      eventType: "broadcast_reported",
      actorType: "api",
      requestId: randomUUID(),
      transactionHash: `0x${"5".repeat(64)}`,
      reconcileAfter: new Date().toISOString(),
    });
    expect(
      await intents.sumRecentExposureUsd({ ownerUserId: owner, since }),
    ).toBe("1");

    await intents.transition({
      ownerUserId: owner,
      intentId: submitted.intentId,
      expectedVersion: submitted.recordVersion,
      fromStates: ["submitted"],
      toState: "failed",
      eventType: "provider_rejected",
      actorType: "api",
      requestId: randomUUID(),
      reasonCode: "PRIVY_SWAP_NOT_SENT",
    });
    // Nothing was sent and the first intent is expired: the day is clear.
    expect(
      await intents.sumRecentExposureUsd({ ownerUserId: owner, since }),
    ).toBe("0");
    expect(first.state).toBe("awaiting_signature");

    // A window that starts after the rows were written sees nothing.
    expect(
      await intents.sumRecentExposureUsd({
        ownerUserId: owner,
        since: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toBe("0");

    // Another account's exposure is never counted.
    const stranger = await createOwner();
    expect(
      await intents.sumRecentExposureUsd({ ownerUserId: stranger, since }),
    ).toBe("0");
  });

  it("creates an intent, supersedes the wallet's open intent, and appends events", async () => {
    const owner = await createOwner();
    const walletId = await seedWallet(owner);
    const first = await intents.create(await createInput(owner, walletId));
    expect(first).toMatchObject({
      state: "awaiting_signature",
      recordVersion: "1",
      reasonCode: null,
    });
    expect(first.canonicalPayload.transaction?.nonce).toBe("0x7");
    const found = await intents.findByOperationId(
      owner,
      first.providerOperationId as string,
    );
    expect(found?.intentId).toBe(first.intentId);

    const second = await intents.create(await createInput(owner, walletId));
    const superseded = await intents.get(owner, first.intentId);
    expect(superseded).toMatchObject({
      state: "expired",
      reasonCode: "INTENT_SUPERSEDED",
      recordVersion: "2",
    });
    expect(second.state).toBe("awaiting_signature");

    const events = await pool.query<{
      intent_id: string;
      event_type: string;
      to_state: string;
    }>({
      text: `select intent_id, event_type, to_state from public.wallet_intent_events
             where owner_user_id = $1 order by event_id`,
      values: [owner],
    });
    expect(events.rows.map((row) => [row.event_type, row.to_state])).toEqual([
      ["intent_prepared", "awaiting_signature"],
      ["intent_superseded", "expired"],
      ["intent_prepared", "awaiting_signature"],
    ]);
    await expect(
      pool.query(
        `delete from public.wallet_intent_events where owner_user_id = '${owner}'`,
      ),
    ).rejects.toMatchObject({ code: "23001" });

    // A foreign owner never sees the intent.
    expect(await intents.get(await createOwner(), first.intentId)).toBeNull();
  });

  it("freezes the payload columns and enforces from-state and version on transitions", async () => {
    const owner = await createOwner();
    const walletId = await seedWallet(owner);
    const record = await intents.create(await createInput(owner, walletId));

    await expect(
      pool.query({
        text: `update public.wallet_intents set review_sha256 = $2 where intent_id = $1`,
        values: [record.intentId, "0".repeat(64)],
      }),
    ).rejects.toMatchObject({ code: "23001" });
    await expect(
      pool.query({
        text: `update public.wallet_intents set canonical_payload = '{}'::jsonb where intent_id = $1`,
        values: [record.intentId],
      }),
    ).rejects.toMatchObject({ code: "23001" });

    const txHash = `0x${"7".repeat(64)}`;
    const submitted = await intents.transition({
      ownerUserId: owner,
      intentId: record.intentId,
      expectedVersion: record.recordVersion,
      fromStates: ["awaiting_signature"],
      toState: "submitted",
      eventType: "broadcast_reported",
      actorType: "api",
      requestId: randomUUID(),
      transactionHash: txHash,
      reconcileAfter: new Date().toISOString(),
    });
    expect(submitted).toMatchObject({
      state: "submitted",
      transactionHash: txHash,
      recordVersion: "2",
    });
    await expect(
      intents.transition({
        ownerUserId: owner,
        intentId: record.intentId,
        expectedVersion: "1",
        fromStates: ["submitted"],
        toState: "confirmed",
        eventType: "stale",
        actorType: "worker",
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WalletIntentStateConflictError);
    await expect(
      intents.transition({
        ownerUserId: owner,
        intentId: record.intentId,
        expectedVersion: submitted.recordVersion,
        fromStates: ["awaiting_signature"],
        toState: "cancelled",
        eventType: "intent_cancelled",
        actorType: "api",
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WalletIntentStateConflictError);

    const confirmed = await intents.transition({
      ownerUserId: owner,
      intentId: record.intentId,
      expectedVersion: submitted.recordVersion,
      fromStates: ["submitted", "unknown"],
      toState: "confirmed",
      eventType: "receipt_finalized",
      actorType: "worker",
      requestId: randomUUID(),
      receipt: {
        status: "success",
        blockNumber: "44000010",
        blockHash,
        gasUsed: "51000",
        effectiveGasPrice: "1000000000",
        observedAt: new Date().toISOString(),
      },
      reconcileAfter: null,
    });
    expect(confirmed.receipt?.blockNumber).toBe("44000010");
    expect(confirmed.recordVersion).toBe("3");
  });

  it("leases reconcilable intents once per lease window and expires elapsed ones", async () => {
    const owner = await createOwner();
    const walletId = await seedWallet(owner);
    const record = await intents.create(await createInput(owner, walletId));
    await intents.transition({
      ownerUserId: owner,
      intentId: record.intentId,
      expectedVersion: record.recordVersion,
      fromStates: ["awaiting_signature"],
      toState: "submitted",
      eventType: "broadcast_reported",
      actorType: "api",
      requestId: randomUUID(),
      transactionHash: `0x${"7".repeat(64)}`,
      reconcileAfter: null,
    });
    const leased = await intents.leaseReconcilable({
      limit: 10,
      leaseMs: 60_000,
    });
    expect(leased.map((item) => item.intentId)).toEqual([record.intentId]);
    expect(leased[0]?.reconcileAttemptCount).toBe(1);
    const again = await intents.leaseReconcilable({
      limit: 10,
      leaseMs: 60_000,
    });
    expect(again).toEqual([]);

    const otherWallet = await wallets.sync({
      ownerUserId: owner,
      observed: [
        { address: walletAddress, kind: "embedded", providerWalletId: "w_1" },
        {
          address: "0x00000000000000000000000000000000000000a9",
          kind: "embedded",
          providerWalletId: "w_2",
        },
      ],
    });
    const secondWalletId = otherWallet.find(
      (wallet) => wallet.providerWalletId === "w_2",
    )?.walletId as string;
    const elapsedInput = await createInput(owner, secondWalletId);
    const elapsed = await intents.create({
      ...elapsedInput,
      canonicalPayload: {
        ...elapsedInput.canonicalPayload,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      factsObservedAt: new Date(Date.now() - 130_000).toISOString(),
    });
    const expiredCount = await intents.expireElapsed({
      requestId: randomUUID(),
      limit: 10,
    });
    expect(expiredCount).toBe(1);
    expect(await intents.get(owner, elapsed.intentId)).toMatchObject({
      state: "expired",
      reasonCode: "INTENT_EXPIRED",
    });

    const page = await intents.list({ ownerUserId: owner, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    const next = await intents.list({
      ownerUserId: owner,
      limit: 1,
      before: {
        createdAt: page.items[0]?.createdAt as string,
        intentId: page.items[0]?.intentId as string,
      },
    });
    expect(next.items).toHaveLength(1);
    expect(next.hasMore).toBe(false);
    expect(next.items[0]?.intentId).not.toBe(page.items[0]?.intentId);
  });

  it("commits approvals with the transfer segment, rewinds them together, and records observations", async () => {
    const owner = await createOwner();
    const walletId = await seedWallet(owner);
    const approval = {
      transactionHash: `0x${"5".repeat(64)}`,
      logIndex: 2,
      blockNumber: "1000",
      blockHash,
      assetId: usdtAssetId,
      ownerAddress: walletAddress,
      spenderAddress: spender,
      rawValue: "3000000000000000000",
    };
    const newer = {
      ...approval,
      transactionHash: `0x${"6".repeat(64)}`,
      blockNumber: "1001",
      rawValue: "0",
    };
    await indexer.commitTransferSegment({
      chainId: bscChainId,
      transfers: [],
      approvals: [approval, approval, newer],
      checkpoint: {
        lastBlockNumber: "1001",
        lastBlockHash: blockHash,
        startedFromBlockNumber: "900",
      },
    });
    const latest = await indexer.listLatestApprovals({
      chainId: bscChainId,
      ownerAddress: walletAddress,
      assetIds: [usdtAssetId],
    });
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({
      transactionHash: newer.transactionHash,
      rawValue: "0",
      removed: false,
    });
    expect(
      await indexer.hasOutgoingTransferTo({
        chainId: bscChainId,
        fromAddress: walletAddress,
        toAddress: recipient,
      }),
    ).toBe(false);

    await indexer.commitTransferSegment({
      chainId: bscChainId,
      transfers: [],
      approvals: [],
      checkpoint: {
        lastBlockNumber: "1001",
        lastBlockHash: `0x${"b".repeat(64)}`,
        startedFromBlockNumber: "900",
      },
      rewindFromBlockNumber: "1001",
    });
    const afterRewind = await indexer.listLatestApprovals({
      chainId: bscChainId,
      ownerAddress: walletAddress,
      assetIds: [usdtAssetId],
    });
    expect(afterRewind.map((row) => row.transactionHash)).toEqual([
      approval.transactionHash,
    ]);
    const removed = await pool.query<{ removed: boolean }>({
      text: `select removed from public.indexed_approvals where transaction_hash = $1`,
      values: [newer.transactionHash],
    });
    expect(removed.rows[0]?.removed).toBe(true);

    await intents.recordApprovalObservation({
      walletId,
      assetId: usdtAssetId,
      spenderAddress: spender,
      rawValue: "3000000000000000000",
      blockNumber: "44000000",
      blockHash,
    });
    const observations = await pool.query<{ raw_value: string }>({
      text: `select raw_value::text as raw_value from public.approval_observations where wallet_id = $1`,
      values: [walletId],
    });
    expect(observations.rows).toEqual([{ raw_value: "3000000000000000000" }]);
  });

  it("stores a swap quote, consumes it exactly once, and tracks payload verification", async () => {
    const owner = await createOwner();
    const walletId = await seedWallet(owner);
    const quoteId = randomUUID();
    await intents.storeSwapQuote({
      quoteId,
      ownerUserId: owner,
      walletId,
      snapshot: { slippageBps: 50 },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    expect(await intents.getSwapQuote(owner, quoteId)).toMatchObject({
      quoteId,
      walletId,
      snapshot: { slippageBps: 50 },
      consumedByIntentId: null,
    });
    expect(await intents.getSwapQuote(await createOwner(), quoteId)).toBeNull();
    const intentId = randomUUID();
    const consumed = await intents.consumeSwapQuote({
      ownerUserId: owner,
      quoteId,
      intentId,
    });
    expect(consumed?.consumedByIntentId).toBe(intentId);
    expect(
      await intents.consumeSwapQuote({
        ownerUserId: owner,
        quoteId,
        intentId: randomUUID(),
      }),
    ).toBeNull();

    const record = await intents.create(await createInput(owner, walletId));
    expect(record.payloadVerified).toBe(false);
    const verified = await intents.transition({
      ownerUserId: owner,
      intentId: record.intentId,
      expectedVersion: record.recordVersion,
      fromStates: ["awaiting_signature"],
      toState: "submitted",
      eventType: "broadcast_reported",
      actorType: "api",
      requestId: randomUUID(),
      transactionHash: `0x${"7".repeat(64)}`,
      payloadVerified: true,
    });
    expect(verified.payloadVerified).toBe(true);
  });

  it("refuses non-canonical states, kinds, and hashes at the schema", async () => {
    const owner = await createOwner();
    const walletId = await seedWallet(owner);
    const input = await createInput(owner, walletId);
    await expect(
      intents.create({ ...input, state: "signed" as "prepared" }),
    ).rejects.toMatchObject({ code: "23514" });
    const record = await intents.create(input);
    await expect(
      pool.query({
        text: `update public.wallet_intents set transaction_hash = 'not-a-hash' where intent_id = $1`,
        values: [record.intentId],
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("stores a send_nft intent on the launch slot and lists it only when not excluded (Decision 0194, 000106)", async () => {
    const owner = await createOwner();
    const walletId = await seedWallet(owner);
    const send = await intents.create(await createInput(owner, walletId));
    const nftContract = "0x00000000000000000000000000000000000000e7";
    const base = source(randomUUID(), walletId);
    const nftSource: IntentSource = {
      ...base,
      version: "walletIntentSendNftV1",
      kind: "send_nft",
      chainId: "eip155:97",
      asset: {
        assetId: `eip155:97:${nftContract}`,
        address: nftContract,
        symbol: "LCAT",
        decimals: 0,
      },
      amount: { raw: "1", display: "1" },
      decodedCall: {
        functionName: "safeTransferFrom",
        selector: "0x42842e0e",
        args: {
          from: walletAddress,
          to: recipient,
          tokenId: "7",
        },
      },
      nft: {
        contractAddress: nftContract,
        tokenId: "7",
        projectName: "Loop Cat Project",
      },
      transaction: {
        ...(base.transaction as NonNullable<IntentSource["transaction"]>),
        chainId: 97,
        to: nftContract,
        data: "0x42842e0e",
      },
      policy: {
        ...base.policy,
        exposureBasis: "none",
        exposureRaw: null,
        exposureBlockNumber: null,
        valueUsd: null,
        priceSource: null,
        priceFetchedAt: null,
      },
    };
    const sealed = sealIntent(nftSource);
    const operation = await controlPlane.prepareProviderOperation({
      ownerUserId: owner,
      scope: "wallet_intent_prepare",
      idempotencyKey: randomUUID(),
      keySource: "client",
      requestSha256: sealed.reviewSha256,
      domain: "bsc",
      operationKind: "wallet_intent_send_nft",
      requestId: randomUUID(),
    });
    const nft = await intents.create({
      intentId: nftSource.intentId,
      ownerUserId: owner,
      walletId,
      providerOperationId: operation.operation.id,
      kind: "send_nft",
      state: "awaiting_signature",
      chainId: "eip155:97",
      canonicalPayload: sealed.canonicalPayload,
      publicReview: sealed.publicReview,
      reviewSha256: sealed.reviewSha256,
      policyConfigVersion: "bscWriteCanaryV1",
      factsObservedAt: nftSource.factsObservedAt,
      expiresAt: nftSource.expiresAt,
      simulationStatus: "passed",
      requestId: randomUUID(),
    });
    expect(nft).toMatchObject({
      kind: "send_nft",
      chainId: "eip155:97",
      publicReview: { nft: { tokenId: "7", contractAddress: nftContract } },
    });
    const all = await intents.list({ ownerUserId: owner, limit: 10 });
    expect(all.items.map((item) => item.intentId).sort()).toEqual(
      [send.intentId, nft.intentId].sort(),
    );
    const visible = await intents.list({
      ownerUserId: owner,
      limit: 10,
      excludeKinds: ["send_nft"],
    });
    expect(visible.items.map((item) => item.intentId)).toEqual([send.intentId]);
    // No USD exposure: the daily canary window ignores it.
    expect(
      await intents.sumRecentExposureUsd({
        ownerUserId: owner,
        since: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).toBe("0");
    await expect(
      pool.query({
        text: `update public.wallet_intents set kind = 'send_erc1155' where intent_id = $1`,
        values: [nft.intentId],
      }),
    ).rejects.toThrow();
    const index = await pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public' and indexname = 'launch2_instances_nft_address_idx'`,
    );
    expect(index.rows).toHaveLength(1);
  });
  it("stores dapp_tx / dapp_sign intents, hides them unless named, and confirms a signature with only its digest (Decision 0197, 000107)", async () => {
    const owner = await createOwner();
    const walletId = await seedWallet(owner);
    const base = source(randomUUID(), walletId);
    const policy = {
      ...base.policy,
      exposureBasis: "none" as const,
      exposureRaw: null,
      exposureBlockNumber: null,
      valueUsd: null,
      priceSource: null,
      priceFetchedAt: null,
    };
    const native = {
      assetId: "eip155:97:native",
      address: null,
      symbol: "tBNB",
      decimals: 18,
    };
    const dappReview = {
      origin: "https://app.example.org",
      method: "eth_sendTransaction" as const,
      to: {
        address: spender,
        checksumAddress: spender,
        isContract: true,
        isVerified: false,
        knownContract: null,
      },
      value: { raw: "0", display: "0" },
      decodedCall: {
        functionName: "approve",
        selector: "0x095ea7b3",
        standard: "erc20" as const,
        args: { spender: recipient, amount: "1" },
        dataLength: 68,
      },
      counterparty: null,
      message: null,
      typedData: null,
      riskFlags: ["UNVERIFIED_CONTRACT" as const],
    };
    const txSource: IntentSource = {
      ...base,
      version: "walletIntentDappTxV1",
      kind: "dapp_tx",
      chainId: "eip155:97",
      asset: native,
      amount: { raw: "0", display: "0" },
      recipient: null,
      decodedCall: null,
      transaction: {
        ...(base.transaction as NonNullable<IntentSource["transaction"]>),
        chainId: 97,
        to: spender,
        data: "0x095ea7b3",
      },
      policy,
      dapp: dappReview,
    };
    const signSource: IntentSource = {
      ...base,
      intentId: randomUUID(),
      version: "walletIntentDappSignV1",
      kind: "dapp_sign",
      chainId: "eip155:97",
      asset: native,
      amount: { raw: "0", display: "0" },
      recipient: null,
      decodedCall: null,
      transaction: null,
      fee: null,
      simulation: {
        status: "unavailable",
        source: "not_applicable",
        observedAt: base.factsObservedAt,
        reasonCode: "SIGNATURE_NOT_SIMULATED",
      },
      policy,
      signingMode: "device_personal_sign",
      dapp: {
        ...dappReview,
        method: "personal_sign",
        to: null,
        value: null,
        decodedCall: null,
        message: {
          encoding: "utf8",
          text: "hello",
          hex: "0x68656c6c6f",
          byteLength: 5,
        },
        riskFlags: [],
      },
      signatureRequest: {
        method: "personal_sign",
        params: ["hello", walletAddress],
      },
    };
    const created = [];
    for (const [entry, state] of [
      [txSource, "awaiting_signature"],
      [signSource, "awaiting_signature"],
    ] as const) {
      const sealed = sealIntent(entry);
      const operation = await controlPlane.prepareProviderOperation({
        ownerUserId: owner,
        scope: "wallet_intent_prepare",
        idempotencyKey: randomUUID(),
        keySource: "client",
        requestSha256: sealed.reviewSha256,
        domain: "bsc",
        operationKind: `wallet_intent_${entry.kind}`,
        requestId: randomUUID(),
      });
      created.push(
        await intents.create({
          intentId: entry.intentId,
          ownerUserId: owner,
          walletId,
          providerOperationId: operation.operation.id,
          kind: entry.kind,
          state,
          chainId: "eip155:97",
          canonicalPayload: sealed.canonicalPayload,
          publicReview: sealed.publicReview,
          reviewSha256: sealed.reviewSha256,
          policyConfigVersion: "bscWriteCanaryV1",
          factsObservedAt: entry.factsObservedAt,
          expiresAt: entry.expiresAt,
          simulationStatus: entry.simulation.status,
          requestId: randomUUID(),
        }),
      );
    }
    const [tx, sign] = created as [
      Awaited<ReturnType<typeof intents.create>>,
      Awaited<ReturnType<typeof intents.create>>,
    ];
    // The second prepare superseded the first (one open intent per wallet).
    expect((await intents.get(owner, tx.intentId))?.state).toBe("expired");
    expect(sign).toMatchObject({
      kind: "dapp_sign",
      publicReview: { dapp: { method: "personal_sign" } },
      canonicalPayload: {
        signatureRequest: { method: "personal_sign" },
      },
    });
    expect(
      (
        await intents.list({
          ownerUserId: owner,
          limit: 10,
          excludeKinds: ["send_nft", "dapp_tx", "dapp_sign"],
        })
      ).items,
    ).toEqual([]);
    expect(
      (await intents.list({ ownerUserId: owner, limit: 10 })).items.map(
        (item) => item.kind,
      ),
    ).toEqual(["dapp_sign", "dapp_tx"]);
    const digest = "f".repeat(64);
    const confirmed = await intents.transition({
      ownerUserId: owner,
      intentId: sign.intentId,
      expectedVersion: sign.recordVersion,
      fromStates: ["awaiting_signature"],
      toState: "confirmed",
      eventType: "signature_reported",
      actorType: "api",
      requestId: randomUUID(),
      reasonCode: null,
      details: { signatureSha256: digest },
    });
    expect(confirmed).toMatchObject({
      state: "confirmed",
      transactionHash: null,
      receipt: null,
    });
    const event = await pool.query<{
      event_type: string;
      details: Record<string, unknown>;
    }>({
      text: `select event_type, details from public.wallet_intent_events
             where intent_id = $1 and event_type = 'signature_reported'`,
      values: [sign.intentId],
    });
    expect(event.rows).toEqual([
      {
        event_type: "signature_reported",
        details: { signatureSha256: digest },
      },
    ]);
    // The payload stays frozen; an unknown kind stays refused.
    await expect(
      pool.query({
        text: `update public.wallet_intents set canonical_payload = '{}'::jsonb where intent_id = $1`,
        values: [sign.intentId],
      }),
    ).rejects.toThrow();
    await expect(
      pool.query({
        text: `update public.wallet_intents set kind = 'dapp_other' where intent_id = $1`,
        values: [sign.intentId],
      }),
    ).rejects.toThrow();
  });
});
