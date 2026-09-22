import { randomUUID } from "node:crypto";

import { vi } from "vitest";

import type {
  AccountWalletRecord,
  AccountWalletRepository,
} from "../src/database/account-wallet-repository.js";
import type {
  BscIndexerRepository,
  IndexedApprovalRecord,
} from "../src/database/bsc-indexer-repository.js";
import type {
  AssetRecord,
  ChainRegistryRepository,
} from "../src/database/chain-registry-repository.js";
import {
  IdempotencyConflictError,
  InvalidProviderOperationStateError,
  type ControlPlaneRepository,
  type ProviderOperation,
} from "../src/database/control-plane-repository.js";
import {
  WalletIntentStateConflictError,
  type CreateWalletIntentInput,
  type StoredSwapQuote,
  type WalletIntentRecord,
  type WalletIntentRepository,
} from "../src/database/wallet-intent-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import { addDecimalStrings } from "../src/features/market/market-contract.js";
import type {
  AssetPriceFact,
  MarketFactService,
} from "../src/features/market/market-fact-service.js";
import { openWalletIntentStates } from "../src/features/wallet-intents/intent-contract.js";
import type { WalletIntentRuntime } from "../src/features/wallet-intents/intent-preparation.js";
import type {
  BscCallOutcome,
  BscChainCallClient,
  BscFeeData,
  BscTransactionObservation,
  BscTransactionReceiptObservation,
} from "../src/integrations/bsc/rpc-client.js";
import type {
  PrivySwapAction,
  PrivySwapAdapter,
} from "../src/integrations/privy/swap-adapter.js";

/**
 * In-memory doubles for the wallet-intent runtime. They keep the real
 * invariants that matter to the state machine (record versions, from-state
 * checks, append-only events, idempotency binding) so a test observes the
 * same refusals the PostgreSQL repository would produce.
 */

export const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
export const walletId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
export const externalWalletId = "1c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
export const walletAddress = "0x00000000000000000000000000000000000000a1";
export const externalWalletAddress =
  "0x00000000000000000000000000000000000000a2";
export const recipientAddress = "0x00000000000000000000000000000000000000b2";
export const spenderAddress = "0x00000000000000000000000000000000000000c3";
export const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
export const usdt = "0x55d398326f99059ff775485246999027b3197955";
export const wbnbAssetId = `eip155:56:${wbnb}`;
export const usdtAssetId = `eip155:56:${usdt}`;
export const nativeAssetId = "eip155:56:native";
export const headNumber = 44_000_000n;
export const headHash = `0x${"1".repeat(64)}`;
export const observedAt = "2026-09-08T00:00:00.000Z";

export const principal = Object.freeze({
  userId: accountId,
  privyUserId: "did:privy:verified-user",
  streamUserId: "loop_6d12a86e413447e69312c5ef75a30f55",
});

export const nativeAsset: AssetRecord = Object.freeze({
  assetId: nativeAssetId,
  chainId: bscChainId,
  address: null,
  symbol: "BNB",
  name: "BNB",
  decimals: 18,
  status: "verified",
  sourceKind: "chain_native",
  sourceBlockNumber: null,
  sourceVerifiedAt: null,
  updatedAt: observedAt,
});

export const wbnbAsset: AssetRecord = Object.freeze({
  assetId: wbnbAssetId,
  chainId: bscChainId,
  address: wbnb,
  symbol: "WBNB",
  name: "Wrapped BNB",
  decimals: 18,
  status: "pending",
  sourceKind: "chain_call",
  sourceBlockNumber: "43000000",
  sourceVerifiedAt: observedAt,
  updatedAt: observedAt,
});

export const usdtAsset: AssetRecord = Object.freeze({
  assetId: usdtAssetId,
  chainId: bscChainId,
  address: usdt,
  symbol: "USDT",
  name: "Tether USD",
  decimals: 18,
  status: "pending",
  sourceKind: "chain_call",
  sourceBlockNumber: "43000000",
  sourceVerifiedAt: observedAt,
  updatedAt: observedAt,
});

export const embeddedWallet: AccountWalletRecord = Object.freeze({
  walletId,
  providerWalletId: "wallet_privy_1",
  address: walletAddress,
  kind: "embedded",
  status: "active",
  isActive: true,
  firstSeenAt: observedAt,
  lastSeenAt: observedAt,
});

export const externalWallet: AccountWalletRecord = Object.freeze({
  walletId: externalWalletId,
  providerWalletId: null,
  address: externalWalletAddress,
  kind: "external",
  status: "active",
  isActive: false,
  firstSeenAt: observedAt,
  lastSeenAt: observedAt,
});

export function registryFake(
  assets: readonly AssetRecord[] = [nativeAsset, wbnbAsset, usdtAsset],
): ChainRegistryRepository {
  return {
    getChain: vi.fn(() => Promise.resolve(null)),
    getAsset: vi.fn((assetId: string) =>
      Promise.resolve(
        assets.find((asset) => asset.assetId === assetId) ?? null,
      ),
    ),
    listAssets: vi.fn((assetIds: readonly string[]) =>
      Promise.resolve(
        assets.filter((asset) => assetIds.includes(asset.assetId)),
      ),
    ),
    listReadableAssets: vi.fn(() =>
      Promise.resolve(assets.filter((asset) => asset.status !== "blocked")),
    ),
    upsertAsset: vi.fn(() => Promise.reject(new Error("not used"))),
    listPools: vi.fn(() => Promise.resolve([])),
    upsertPool: vi.fn(() => Promise.reject(new Error("not used"))),
  };
}

export function walletsFake(
  records: readonly AccountWalletRecord[] = [embeddedWallet, externalWallet],
): AccountWalletRepository {
  return {
    sync: vi.fn(() => Promise.resolve(records)),
    list: vi.fn(() => Promise.resolve(records)),
    get: vi.fn((ownerUserId: string, requested: string) =>
      Promise.resolve(
        ownerUserId === accountId
          ? (records.find((record) => record.walletId === requested) ?? null)
          : null,
      ),
    ),
    setActive: vi.fn(() => Promise.resolve(records)),
    recordBalanceSnapshot: vi.fn(() => Promise.resolve()),
  };
}

export function indexerFake(
  options: {
    readonly checkpoint?: boolean;
    /** Approval coverage start; `null` models a lane indexed before 000021. */
    readonly approvalCoverageFromBlockNumber?: string | null;
    /** Earliest indexed transfer block of the wallet (`null` = never seen). */
    readonly earliestActivityBlockNumber?: string | null;
    readonly approvals?: readonly IndexedApprovalRecord[];
    readonly sentBefore?: boolean;
  } = {},
): BscIndexerRepository {
  return {
    getCheckpoint: vi.fn(() =>
      Promise.resolve(
        options.checkpoint === false
          ? null
          : {
              lastBlockNumber: (headNumber - 5n).toString(10),
              lastBlockHash: `0x${"3".repeat(64)}`,
              startedFromBlockNumber: "43000000",
              approvalCoverageFromBlockNumber:
                options.approvalCoverageFromBlockNumber === undefined
                  ? "43000000"
                  : options.approvalCoverageFromBlockNumber,
              reorgCount: 0,
              updatedAt: observedAt,
            },
      ),
    ),
    commitTransferSegment: vi.fn(() => Promise.reject(new Error("not used"))),
    commitApprovalCoverageSegment: vi.fn(() =>
      Promise.reject(new Error("not used")),
    ),
    earliestWalletActivityBlockNumber: vi.fn(() =>
      Promise.resolve(options.earliestActivityBlockNumber ?? null),
    ),
    listLatestApprovals: vi.fn(() => Promise.resolve(options.approvals ?? [])),
    hasOutgoingTransferTo: vi.fn(() =>
      Promise.resolve(options.sentBefore === true),
    ),
    listWalletTransfers: vi.fn(() =>
      Promise.resolve({ items: [], hasMore: false }),
    ),
    sumPendingIncoming: vi.fn(() => Promise.resolve([])),
    commitPoolEventSegment: vi.fn(() => Promise.reject(new Error("not used"))),
    listPoolSwaps: vi.fn(() => Promise.resolve({ items: [], hasMore: false })),
    aggregateSwapCandles: vi.fn(() => Promise.resolve([])),
  };
}

export interface ReadClientFakeOptions {
  readonly verified?: boolean;
  readonly nativeBalance?: bigint;
  readonly tokenBalance?: bigint;
  readonly callOutcome?: BscCallOutcome;
  readonly callThrows?: Error;
  readonly gasEstimate?: bigint | null;
  readonly feeData?: BscFeeData;
  readonly nonce?: number;
  readonly code?: Record<string, `0x${string}`>;
  readonly transactions?: Map<string, BscTransactionObservation | null>;
  readonly receipts?: Map<string, BscTransactionReceiptObservation | null>;
  readonly allowances?: Record<string, bigint | null>;
}

export function readClientFake(options: ReadClientFakeOptions = {}) {
  const verified = options.verified !== false;
  const calls: unknown[] = [];
  const client: BscChainCallClient = {
    chainId: "eip155:56",
    chainReference: 56,
    confirmations: 15,
    reorgDepthBlocks: 64,
    endpointRefs: ["rpc-abcdefabcdef"],
    verifyChain: () => Promise.resolve(verified ? "verified" : "unreachable"),
    currentVerification: () => (verified ? "verified" : "unreachable"),
    getHead: () =>
      Promise.resolve({
        blockNumber: headNumber,
        blockHash: headHash,
        observedAt,
      }),
    getBlockHash: () => Promise.resolve(headHash),
    readTokenIdentity: () => Promise.reject(new Error("not used")),
    readPoolIdentity: () => Promise.reject(new Error("not used")),
    readBalances: (_owner, items) =>
      Promise.resolve({
        head: { blockNumber: headNumber, blockHash: headHash, observedAt },
        balances: items.map((item) => ({
          assetId: item.assetId,
          rawValue:
            item.address === null
              ? (options.nativeBalance ?? 2_000_000_000_000_000_000n)
              : (options.tokenBalance ?? 5_000_000_000_000_000_000n),
          reasonCode: null,
        })),
      }),
    readTransferLogs: () => Promise.resolve([]),
    readPoolEventLogs: () => Promise.resolve([]),
    readApprovalLogs: () => Promise.resolve([]),
    call: (request) => {
      calls.push(request);
      if (options.callThrows !== undefined) {
        return Promise.reject(options.callThrows);
      }
      return Promise.resolve(
        options.callOutcome ?? { status: "passed", returnData: "0x" },
      );
    },
    estimateGas: () =>
      Promise.resolve(
        options.gasEstimate === undefined ? 52_000n : options.gasEstimate,
      ),
    getFeeData: () =>
      Promise.resolve(
        options.feeData ?? {
          type: "eip1559",
          maxFeePerGas: 3_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        },
      ),
    getTransactionCount: () => Promise.resolve(options.nonce ?? 7),
    getCode: (address) => Promise.resolve(options.code?.[address] ?? "0x"),
    getTransaction: (hash) =>
      Promise.resolve(options.transactions?.get(hash) ?? null),
    getTransactionReceipt: (hash) =>
      Promise.resolve(options.receipts?.get(hash) ?? null),
    readAllowances: (_owner, items) =>
      Promise.resolve({
        head: { blockNumber: headNumber, blockHash: headHash, observedAt },
        allowances: items.map((item) => {
          const value = options.allowances?.[`${item.assetId}:${item.spender}`];
          return value === undefined || value === null
            ? {
                assetId: item.assetId,
                spender: item.spender,
                rawValue: value === null ? null : 0n,
                reasonCode: value === null ? "BSC_ALLOWANCE_CALL_FAILED" : null,
              }
            : {
                assetId: item.assetId,
                spender: item.spender,
                rawValue: value,
                reasonCode: null,
              };
        }),
      }),
    probeEndpoints: () => Promise.resolve([]),
  };
  return { client, calls };
}

export function marketFactsFake(
  prices: Record<string, string | null> = {
    [wbnb]: "600",
    [usdt]: "1",
  },
): MarketFactService {
  const readAssetPrice = (asset: { readonly address: string | null }) => {
    const address = asset.address ?? wbnb;
    const price = prices[address] ?? null;
    const result: AssetPriceFact = {
      fact: {
        value: null,
        source: "dexscreener",
        fetchedAt: price === null ? null : observedAt,
        ttlSeconds: 30,
        quality: price === null ? "unavailable" : "fresh",
        reasonCode: price === null ? "MARKET_PAIR_NOT_FOUND" : null,
        rawDigest: null,
      },
      pair:
        price === null
          ? null
          : {
              pairAddress: "0x172fcd41e0913e95784454622d1c3724f546f849",
              dexId: "pancakeswap",
              labels: [],
              baseTokenAddress: address,
              baseTokenSymbol: "X",
              quoteTokenAddress: usdt,
              quoteTokenSymbol: "USDT",
              priceUsd: price,
              priceNative: null,
              liquidityUsd: "1",
              volumeH24: null,
              priceChangeH24: null,
              fdv: null,
              marketCap: null,
              buysH24: null,
              sellsH24: null,
              pairCreatedAt: null,
            },
      proxyAsset: asset.address === null ? wbnbAssetId : null,
    };
    return Promise.resolve(result);
  };
  return {
    readTokenPairs: vi.fn(() => Promise.reject(new Error("not used"))),
    readTokenPairsBatch: vi.fn(() => Promise.reject(new Error("not used"))),
    readPair: vi.fn(() => Promise.reject(new Error("not used"))),
    readAssetPrice: vi.fn(readAssetPrice),
    readAssetPrices: vi.fn(
      (assets: readonly { readonly address: string | null }[]) =>
        Promise.all(assets.map(readAssetPrice)),
    ),
    readTokenSecurity: vi.fn(() => Promise.reject(new Error("not used"))),
    readPoolOhlcv: vi.fn(() => Promise.reject(new Error("not used"))),
    readNewPools: vi.fn(() => Promise.reject(new Error("not used"))),
    readUnlistedToken: vi.fn(() => Promise.reject(new Error("not used"))),
    candlesProviderEnabled: false,
  };
}

/** Minimal provider-operation journal with the real one-attempt rule. */
export function controlPlaneFake(): ControlPlaneRepository & {
  readonly operations: Map<string, ProviderOperation>;
} {
  const operations = new Map<string, ProviderOperation>();
  const byKey = new Map<string, { digest: string; id: string }>();
  const stamp = (): string => new Date().toISOString();
  const base = (input: {
    ownerUserId: string;
    domain: string;
    operationKind: string;
    requestSha256: string;
  }): ProviderOperation => ({
    id: randomUUID(),
    ownerUserId: input.ownerUserId,
    domain: input.domain,
    operationKind: input.operationKind,
    requestSha256: input.requestSha256,
    state: "prepared",
    attemptCount: 0,
    transportAttemptId: null,
    attemptCommittedAt: null,
    attemptDeadlineAt: null,
    reconciliationStatus: "not_required",
    reconciliationAttemptCount: 0,
    reconcileAfter: null,
    operatorRequiredAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    fenceToken: "0",
    recordVersion: "1",
    createdAt: stamp(),
    updatedAt: stamp(),
  });
  const unused = (): Promise<never> => Promise.reject(new Error("not used"));
  return {
    operations,
    prepareProviderOperation: (input) => {
      const key = `${input.scope}:${input.idempotencyKey}`;
      const existing = byKey.get(key);
      if (existing !== undefined) {
        if (existing.digest !== input.requestSha256) {
          return Promise.reject(new IdempotencyConflictError());
        }
        const operation = operations.get(existing.id);
        if (operation === undefined) {
          return Promise.reject(new Error("journal corrupted"));
        }
        return Promise.resolve({ created: false, operation });
      }
      const operation = base(input);
      operations.set(operation.id, operation);
      byKey.set(key, { digest: input.requestSha256, id: operation.id });
      return Promise.resolve({ created: true, operation });
    },
    findProviderOperation: (_owner, id) =>
      Promise.resolve(operations.get(id) ?? null),
    markProviderOperationSubmitting: (input) => {
      const operation = operations.get(input.operationId);
      if (operation === undefined || operation.state !== "prepared") {
        return Promise.reject(new InvalidProviderOperationStateError());
      }
      const next: ProviderOperation = {
        ...operation,
        state: "submitting",
        attemptCount: 1,
        transportAttemptId: randomUUID(),
        recordVersion: String(Number(operation.recordVersion) + 1),
      };
      operations.set(next.id, next);
      return Promise.resolve(next);
    },
    markProviderOperationUnknown: (input) => {
      const operation = operations.get(input.operationId);
      if (operation === undefined || operation.state !== "submitting") {
        return Promise.reject(new InvalidProviderOperationStateError());
      }
      const next: ProviderOperation = {
        ...operation,
        state: "unknown",
        reconciliationStatus: "pending",
        recordVersion: String(Number(operation.recordVersion) + 1),
      };
      operations.set(next.id, next);
      return Promise.resolve(next);
    },
    markProviderOperationResult: (input) => {
      const operation = operations.get(input.operationId);
      if (operation === undefined || operation.state !== "submitting") {
        return Promise.reject(new InvalidProviderOperationStateError());
      }
      const next: ProviderOperation = {
        ...operation,
        state: input.state,
        recordVersion: String(Number(operation.recordVersion) + 1),
      };
      operations.set(next.id, next);
      return Promise.resolve(next);
    },
    quarantineExpiredSubmissions: unused,
    leaseProviderOperationsForReconciliation: unused,
    completeProviderOperationReconciliation: unused,
    rescheduleProviderOperationReconciliation: unused,
    holdProviderOperationForOperator: unused,
    consumeIssuanceQuota: unused,
    deleteExpiredIssuanceQuotaRecords: unused,
  };
}

export interface RecordedIntentEvent {
  readonly intentId: string;
  readonly eventType: string;
  readonly toState: string;
  readonly reasonCode: string | null;
}

/** In-memory intent store with version checks and append-only events. */
export function intentRepositoryFake(
  now: () => Date = (): Date => new Date(),
): WalletIntentRepository & {
  readonly records: Map<string, WalletIntentRecord>;
  readonly events: RecordedIntentEvent[];
} {
  const records = new Map<string, WalletIntentRecord>();
  const events: RecordedIntentEvent[] = [];
  const quotes = new Map<string, StoredSwapQuote>();
  const bump = (record: WalletIntentRecord): string =>
    String(Number(record.recordVersion) + 1);
  return {
    records,
    events,
    create: (input: CreateWalletIntentInput) => {
      for (const [id, record] of records) {
        if (
          record.walletId === input.walletId &&
          openWalletIntentStates.has(record.state)
        ) {
          records.set(id, {
            ...record,
            state: "expired",
            reasonCode: "INTENT_SUPERSEDED",
            recordVersion: bump(record),
          });
          events.push({
            intentId: id,
            eventType: "intent_superseded",
            toState: "expired",
            reasonCode: "INTENT_SUPERSEDED",
          });
        }
      }
      const created: WalletIntentRecord = {
        intentId: input.intentId,
        ownerUserId: input.ownerUserId,
        walletId: input.walletId,
        providerOperationId: input.providerOperationId,
        kind: input.kind,
        state: input.state,
        chainId: input.chainId,
        canonicalPayload: input.canonicalPayload,
        publicReview: input.publicReview,
        reviewSha256: input.reviewSha256,
        policyConfigVersion: input.policyConfigVersion,
        factsObservedAt: input.factsObservedAt,
        expiresAt: input.expiresAt,
        simulationStatus: input.simulationStatus,
        transactionHash: null,
        providerActionId: null,
        reasonCode: null,
        receipt: null,
        reconcileAfter: null,
        reconcileAttemptCount: 0,
        payloadVerified: false,
        recordVersion: "1",
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
      };
      records.set(created.intentId, created);
      events.push({
        intentId: created.intentId,
        eventType: "intent_prepared",
        toState: created.state,
        reasonCode: null,
      });
      return Promise.resolve(created);
    },
    get: (owner, intentId) => {
      const record = records.get(intentId);
      return Promise.resolve(
        record === undefined || record.ownerUserId !== owner ? null : record,
      );
    },
    findByOperationId: (owner, operationId) =>
      Promise.resolve(
        [...records.values()].find(
          (record) =>
            record.ownerUserId === owner &&
            record.providerOperationId === operationId,
        ) ?? null,
      ),
    sumRecentExposureUsd: (input) =>
      Promise.resolve(
        [...records.values()]
          .filter(
            (record) =>
              record.ownerUserId === input.ownerUserId &&
              record.createdAt >= input.since &&
              [
                "awaiting_signature",
                "submitted",
                "confirmed",
                "reverted",
                "unknown",
              ].includes(record.state),
          )
          .reduce((total, record) => {
            const valueUsd = (
              record.canonicalPayload as {
                readonly policy?: { readonly valueUsd?: string | null };
              }
            ).policy?.valueUsd;
            return typeof valueUsd === "string"
              ? addDecimalStrings(total, valueUsd)
              : total;
          }, "0"),
      ),
    list: (input) => {
      const items = [...records.values()]
        .filter((record) => record.ownerUserId === input.ownerUserId)
        .sort((left, right) =>
          right.createdAt === left.createdAt
            ? right.intentId.localeCompare(left.intentId)
            : right.createdAt.localeCompare(left.createdAt),
        )
        .filter(
          (record) =>
            input.before === undefined ||
            record.createdAt < input.before.createdAt ||
            (record.createdAt === input.before.createdAt &&
              record.intentId < input.before.intentId),
        );
      return Promise.resolve({
        items: items.slice(0, input.limit),
        hasMore: items.length > input.limit,
      });
    },
    transition: (input) => {
      const record = records.get(input.intentId);
      if (
        record === undefined ||
        record.ownerUserId !== input.ownerUserId ||
        record.recordVersion !== input.expectedVersion ||
        !input.fromStates.includes(record.state)
      ) {
        return Promise.reject(new WalletIntentStateConflictError());
      }
      const next: WalletIntentRecord = {
        ...record,
        state: input.toState,
        reasonCode:
          input.reasonCode === undefined ? record.reasonCode : input.reasonCode,
        transactionHash:
          input.transactionHash === undefined
            ? record.transactionHash
            : input.transactionHash,
        providerActionId:
          input.providerActionId === undefined
            ? record.providerActionId
            : input.providerActionId,
        receipt: input.receipt === undefined ? record.receipt : input.receipt,
        reconcileAfter:
          input.reconcileAfter === undefined
            ? record.reconcileAfter
            : input.reconcileAfter,
        payloadVerified:
          input.payloadVerified === undefined
            ? record.payloadVerified
            : input.payloadVerified,
        recordVersion: bump(record),
        updatedAt: now().toISOString(),
      };
      records.set(next.intentId, next);
      events.push({
        intentId: next.intentId,
        eventType: input.eventType,
        toState: next.state,
        reasonCode: input.reasonCode ?? null,
      });
      return Promise.resolve(next);
    },
    recordEvent: (input) => {
      const record = records.get(input.intentId);
      events.push({
        intentId: input.intentId,
        eventType: input.eventType,
        toState: record?.state ?? "unknown",
        reasonCode: input.reasonCode ?? null,
      });
      return Promise.resolve();
    },
    expireElapsed: () => {
      let count = 0;
      for (const [id, record] of records) {
        if (
          openWalletIntentStates.has(record.state) &&
          Date.parse(record.expiresAt) <= now().getTime()
        ) {
          records.set(id, {
            ...record,
            state: "expired",
            reasonCode: "INTENT_EXPIRED",
            recordVersion: bump(record),
          });
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    leaseReconcilable: (input) => {
      const due = [...records.values()]
        .filter(
          (record) =>
            (record.state === "submitted" || record.state === "unknown") &&
            (record.reconcileAfter === null ||
              Date.parse(record.reconcileAfter) <= now().getTime()),
        )
        .slice(0, input.limit)
        .map((record) => {
          const leased: WalletIntentRecord = {
            ...record,
            reconcileAfter: new Date(
              now().getTime() + input.leaseMs,
            ).toISOString(),
            reconcileAttemptCount: record.reconcileAttemptCount + 1,
            recordVersion: bump(record),
          };
          records.set(leased.intentId, leased);
          return leased;
        });
      return Promise.resolve(due);
    },
    recordApprovalObservation: () => Promise.resolve(),
    storeSwapQuote: (input) => {
      quotes.set(input.quoteId, {
        quoteId: input.quoteId,
        ownerUserId: input.ownerUserId,
        walletId: input.walletId,
        snapshot: input.snapshot,
        expiresAt: input.expiresAt,
        consumedByIntentId: null,
      });
      return Promise.resolve();
    },
    getSwapQuote: (owner, quoteId) => {
      const quote = quotes.get(quoteId);
      return Promise.resolve(
        quote === undefined || quote.ownerUserId !== owner ? null : quote,
      );
    },
    consumeSwapQuote: (input) => {
      const quote = quotes.get(input.quoteId);
      if (
        quote === undefined ||
        quote.ownerUserId !== input.ownerUserId ||
        quote.consumedByIntentId !== null ||
        Date.parse(quote.expiresAt) <= now().getTime()
      ) {
        return Promise.resolve(null);
      }
      const consumed = { ...quote, consumedByIntentId: input.intentId };
      quotes.set(input.quoteId, consumed);
      return Promise.resolve(consumed);
    },
  };
}

export function swapAdapterFake(
  options: {
    readonly quote?: Partial<{
      readonly estimatedOutputAmount: string;
      readonly minimumOutputAmount: string;
      readonly inputAmount: string;
      readonly caip2: string;
    }>;
    readonly execute?: () => Promise<PrivySwapAction>;
    readonly action?: () => Promise<PrivySwapAction>;
  } = {},
) {
  const executeCalls: unknown[] = [];
  const quoteCalls: unknown[] = [];
  const adapter: PrivySwapAdapter = {
    quote: (request) => {
      quoteCalls.push(request);
      return Promise.resolve({
        caip2: options.quote?.caip2 ?? bscChainId,
        inputToken: request.source.assetAddress,
        outputToken: request.destination.assetAddress,
        inputAmount: options.quote?.inputAmount ?? request.baseAmount,
        estimatedOutputAmount:
          options.quote?.estimatedOutputAmount ?? "5970000000000000",
        minimumOutputAmount:
          options.quote?.minimumOutputAmount ?? "5940000000000000",
        gasEstimate: "150000",
        providerExpiresAt: null,
      });
    },
    execute: (request) => {
      executeCalls.push(request);
      return (
        options.execute?.() ??
        Promise.resolve({
          actionId: "act_1",
          status: "pending",
          inputAmount: null,
          outputAmount: null,
          steps: [],
          failureReasonCode: null,
        })
      );
    },
    getAction: () =>
      options.action?.() ??
      Promise.resolve({
        actionId: "act_1",
        status: "pending",
        inputAmount: null,
        outputAmount: null,
        steps: [],
        failureReasonCode: null,
      }),
  };
  return { adapter, executeCalls, quoteCalls };
}

export interface RuntimeFakeOptions {
  readonly writesEnabled?: boolean;
  readonly canaryAssetIds?: readonly string[];
  readonly canaryMaxUsd?: string;
  readonly canaryDailyMaxUsd?: string | null;
  readonly canaryCounterpartyAddresses?: readonly string[];
  readonly privyAppId?: string | null;
  readonly readClient?: ReadClientFakeOptions;
  readonly marketFacts?: MarketFactService | null;
  readonly swapAdapter?: PrivySwapAdapter;
  readonly indexer?: BscIndexerRepository;
  readonly now?: () => Date;
}

export function runtimeFake(options: RuntimeFakeOptions = {}) {
  const now = options.now ?? ((): Date => new Date());
  const repository = intentRepositoryFake(now);
  const controlPlane = controlPlaneFake();
  const readClient = readClientFake(options.readClient);
  const swap = swapAdapterFake();
  const runtime: WalletIntentRuntime = {
    config: {
      bscWrites:
        options.writesEnabled === false
          ? null
          : {
              configVersion: "bscWriteCanaryV1",
              canaryAssetIds: options.canaryAssetIds ?? [
                nativeAssetId,
                wbnbAssetId,
                usdtAssetId,
              ],
              canaryMaxUsd: options.canaryMaxUsd ?? "20",
              canaryDailyMaxUsd: options.canaryDailyMaxUsd ?? null,
              canaryCounterpartyAddresses:
                options.canaryCounterpartyAddresses ?? [],
              swapFeeBps: null,
            },
      privyAppId:
        options.privyAppId === undefined ? "app_test" : options.privyAppId,
      gasReserveRawWei: 5_000_000_000_000_000n,
    },
    repository,
    wallets: walletsFake(),
    registry: registryFake(),
    indexer: options.indexer ?? indexerFake(),
    readClient: readClient.client,
    controlPlane,
    marketFacts:
      options.marketFacts === undefined
        ? marketFactsFake()
        : options.marketFacts,
    swapAdapter: options.swapAdapter ?? swap.adapter,
    cursorCodec: null,
    now,
    createUuid: randomUUID,
  };
  return { runtime, repository, controlPlane, readClient, swap };
}
