import { vi } from "vitest";

import type {
  AccountWalletRecord,
  AccountWalletRepository,
} from "../../src/database/account-wallet-repository.js";
import {
  TestnetFaucetIdempotencyConflictError,
  testnetFaucetReasonCodes,
  type TestnetFaucetChain,
  type TestnetFaucetCooldownPolicy,
  type TestnetFaucetGrantRecord,
  type TestnetFaucetRepository,
  type TestnetFaucetTransferOutcome,
} from "../../src/features/testnet-faucet/testnet-faucet-contract.js";

/** Decision 0128 fakes: in-memory grants, a scripted operator chain, wallets. */

/** The MEME v2 / launch2 USD1 (S127 MockUSD1), returned by Factory.usd1(). */
export const faucetUsd1 = "0x3a1236e68ecf3225640367c84b6f50a51d0b0195";
/** The old Launch v1 IDO MockUSD1 behind LAUNCH_USD1_ADDRESS. */
export const legacyLaunchUsd1 = "0x17d554fd00000000000000000000000000ce2b00";
export const hooksFactory = "0x00000000000000000000000000000000000fac70";
export const faucetOperator = "0x00000000000000000000000000000000000000fe";
export const embeddedWalletId = "d64786bb-408d-415d-8a69-6277d56c921b";
export const embeddedAddress = "0x000000000000000000000000000000000000000a";
export const secondWalletId = "a1b2c3d4-1111-4222-8333-444455556666";
export const secondAddress = "0x000000000000000000000000000000000000000b";
export const externalWalletId = "e5e5e5e5-1111-4222-8333-444455556666";
export const archivedWalletId = "f6f6f6f6-1111-4222-8333-444455556666";

const seenAt = "2026-09-08T01:00:00.000Z";

function wallet(
  walletId: string,
  address: string,
  overrides: Partial<AccountWalletRecord> = {},
): AccountWalletRecord {
  return {
    walletId,
    providerWalletId: `privy-${walletId.slice(0, 8)}`,
    address,
    kind: "embedded",
    status: "active",
    isActive: true,
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
    ...overrides,
  };
}

export function faucetWallets(): AccountWalletRepository {
  const records = [
    wallet(embeddedWalletId, embeddedAddress),
    wallet(secondWalletId, secondAddress, { isActive: false }),
    wallet(externalWalletId, "0x000000000000000000000000000000000000000c", {
      kind: "external",
      providerWalletId: null,
    }),
    wallet(archivedWalletId, "0x000000000000000000000000000000000000000d", {
      status: "archived",
    }),
  ];
  return {
    sync: vi.fn(() => Promise.reject(new Error("not used"))),
    list: vi.fn(() => Promise.resolve(records)),
    get: vi.fn((_owner: string, id: string) =>
      Promise.resolve(records.find((record) => record.walletId === id) ?? null),
    ),
    setActive: vi.fn(() => Promise.reject(new Error("not used"))),
    recordBalanceSnapshot: vi.fn(() => Promise.resolve()),
  };
}

interface StoredGrant {
  record: TestnetFaucetGrantRecord;
  idempotencyKey: string;
}

export interface InMemoryFaucetRepository extends TestnetFaucetRepository {
  readonly grants: StoredGrant[];
  /** `usd1_token_address` of each reservation, in order. */
  readonly usd1Tokens: string[];
  readonly records: Map<
    string,
    { readonly ownerUserId: string; readonly requestSha256: string }
  >;
}

const dayMs = 86_400_000;

/** Mirrors `blockedUntil` of the PostgreSQL repository (S169). */
function blockedUntil(
  grants: readonly TestnetFaucetGrantRecord[],
  input: {
    readonly address: string;
    readonly ownerUserId: string;
    readonly now: Date;
    readonly policy: TestnetFaucetCooldownPolicy;
  },
): string | null {
  const at = input.now.getTime();
  const dayStart = Math.floor(at / dayMs) * dayMs;
  const attempted = (grant: TestnetFaucetGrantRecord) =>
    grant.status === "failed" &&
    grant.failureReasonCode === testnetFaucetReasonCodes.transferFailed;
  const instants: number[] = [];
  for (const grant of grants) {
    const granted = Date.parse(grant.grantedAt);
    if (grant.address !== input.address) continue;
    if (
      grant.status !== "failed" &&
      granted > at - input.policy.cooldownSeconds * 1_000
    ) {
      instants.push(granted + input.policy.cooldownSeconds * 1_000);
    }
    if (
      attempted(grant) &&
      granted > at - input.policy.failedCooldownSeconds * 1_000
    ) {
      instants.push(granted + input.policy.failedCooldownSeconds * 1_000);
    }
  }
  const failedToday = grants.filter(
    (grant) =>
      grant.ownerUserId === input.ownerUserId &&
      attempted(grant) &&
      Date.parse(grant.grantedAt) >= dayStart,
  ).length;
  if (failedToday >= input.policy.failedDailyLimit) {
    instants.push(dayStart + dayMs);
  }
  return instants.length === 0
    ? null
    : new Date(Math.max(...instants)).toISOString();
}

/** Mirrors the PostgreSQL repository's rules (Decision 0128 §2). */
export function createInMemoryFaucetRepository(): InMemoryFaucetRepository {
  const grants: StoredGrant[] = [];
  const usd1Tokens: string[] = [];
  const records = new Map<
    string,
    { readonly ownerUserId: string; readonly requestSha256: string }
  >();
  const newest = (filter: (grant: TestnetFaucetGrantRecord) => boolean) =>
    grants
      .map((grant) => grant.record)
      .filter(filter)
      .sort((left, right) =>
        right.grantedAt.localeCompare(left.grantedAt),
      )[0] ?? null;
  const update = (
    grantId: string,
    change: Partial<TestnetFaucetGrantRecord>,
  ): TestnetFaucetGrantRecord => {
    const stored = grants.find((grant) => grant.record.grantId === grantId);
    if (stored === undefined) throw new Error("grant not found");
    stored.record = { ...stored.record, ...change };
    return stored.record;
  };
  return {
    grants,
    usd1Tokens,
    records,
    nextAvailableAt(input) {
      return Promise.resolve(
        blockedUntil(
          grants.map((grant) => grant.record),
          input,
        ),
      );
    },
    dailyTotals(dayStart) {
      const counted = grants
        .map((grant) => grant.record)
        .filter(
          (grant) =>
            ["granted", "partial", "unknown"].includes(grant.status) &&
            Date.parse(grant.grantedAt) >= dayStart.getTime() &&
            Date.parse(grant.grantedAt) < dayStart.getTime() + dayMs,
        );
      return Promise.resolve({
        grants: counted.length,
        bnbRaw: counted
          .reduce((sum, grant) => sum + BigInt(grant.bnbAmountRaw), 0n)
          .toString(),
      });
    },
    listStalePending(before, limit) {
      return Promise.resolve(
        grants
          .map((grant) => grant.record)
          .filter(
            (grant) =>
              grant.status === "pending" &&
              Date.parse(grant.grantedAt) < before.getTime(),
          )
          .sort((left, right) => left.grantedAt.localeCompare(right.grantedAt))
          .slice(0, limit),
      );
    },
    resolveStalePending(input) {
      const stored = grants.find(
        (grant) => grant.record.grantId === input.grantId,
      );
      if (stored === undefined || stored.record.status !== "pending") {
        return Promise.resolve(false);
      }
      stored.record = {
        ...stored.record,
        status: input.status,
        failureReasonCode: input.failureReasonCode,
        completedAt: input.now.toISOString(),
      };
      return Promise.resolve(true);
    },
    latestSentGrant(address) {
      return Promise.resolve(
        newest(
          (grant) =>
            grant.address === address &&
            ["granted", "partial", "unknown"].includes(grant.status),
        ),
      );
    },
    findReplay(input) {
      const record = records.get(input.idempotencyKey);
      if (record === undefined) return Promise.resolve({ kind: "none" });
      if (
        record.ownerUserId !== input.ownerUserId ||
        record.requestSha256 !== input.requestSha256
      ) {
        return Promise.resolve({ kind: "conflict" });
      }
      const grant = grants.find(
        (stored) => stored.idempotencyKey === input.idempotencyKey,
      );
      return Promise.resolve(
        grant === undefined
          ? { kind: "none" }
          : { kind: "grant", grant: grant.record },
      );
    },
    reserve(input) {
      const record = records.get(input.idempotencyKey);
      if (
        record !== undefined &&
        (record.ownerUserId !== input.ownerUserId ||
          record.requestSha256 !== input.requestSha256)
      ) {
        return Promise.reject(new TestnetFaucetIdempotencyConflictError());
      }
      const existing = grants.find(
        (stored) => stored.idempotencyKey === input.idempotencyKey,
      );
      if (existing !== undefined) {
        return Promise.resolve({ kind: "replay", grant: existing.record });
      }
      const blocked = blockedUntil(
        grants.map((grant) => grant.record),
        input,
      );
      if (blocked !== null) {
        return Promise.resolve({ kind: "cooldown", nextAvailableAt: blocked });
      }
      usd1Tokens.push(input.usd1TokenAddress);
      records.set(input.idempotencyKey, {
        ownerUserId: input.ownerUserId,
        requestSha256: input.requestSha256,
      });
      const grant: TestnetFaucetGrantRecord = {
        grantId: input.grantId,
        ownerUserId: input.ownerUserId,
        walletId: input.walletId,
        address: input.address,
        bnbAmount: input.bnbAmount,
        bnbAmountRaw: input.bnbAmountRaw,
        usd1Amount: input.usd1Amount,
        usd1AmountRaw: input.usd1AmountRaw,
        status: "pending",
        bnbTransactionHash: null,
        usd1TransactionHash: null,
        failureReasonCode: null,
        grantedAt: input.now.toISOString(),
        completedAt: null,
      };
      grants.push({ record: grant, idempotencyKey: input.idempotencyKey });
      return Promise.resolve({ kind: "reserved", grant });
    },
    recordTransactionHash(input) {
      update(
        input.grantId,
        input.leg === "bnb"
          ? { bnbTransactionHash: input.transactionHash }
          : { usd1TransactionHash: input.transactionHash },
      );
      return Promise.resolve();
    },
    finalize(input) {
      return Promise.resolve(
        update(input.grantId, {
          status: input.status,
          bnbTransactionHash: input.bnbTransactionHash,
          usd1TransactionHash: input.usd1TransactionHash,
          failureReasonCode: input.failureReasonCode,
          completedAt: input.now.toISOString(),
        }),
      );
    },
  };
}

export const bnbHash = `0x${"b1".repeat(32)}`;
export const usd1Hash = `0x${"c2".repeat(32)}`;

export interface FakeFaucetChainState {
  /** What Factory.usd1() answers; "throws" fails the read. */
  factoryUsd1: string;
  decimals: number;
  balanceWei: bigint;
  gasPriceWei: bigint;
  mintGas: bigint;
  mintEstimate: "ok" | "reverted" | "throws";
  /** S169: the tBNB transfer estimate. */
  nativeEstimate: "ok" | "reverted" | "throws";
  nativeGas: bigint;
  /** The gas limit of every native send, in order. */
  readonly nativeGasLimits: bigint[];
  readsThrow: boolean;
  native: TestnetFaucetTransferOutcome["status"];
  mint: TestnetFaucetTransferOutcome["status"];
  /** Resolves the native send only when released (concurrency tests). */
  nativeGate: Promise<void> | null;
  readonly calls: string[];
  readonly factoryReads: string[];
}

export function defaultFaucetChainState(
  overrides: Partial<FakeFaucetChainState> = {},
): FakeFaucetChainState {
  return {
    factoryUsd1: faucetUsd1,
    decimals: 18,
    balanceWei: 10n ** 18n,
    gasPriceWei: 1_000_000_000n,
    mintGas: 60_000n,
    mintEstimate: "ok",
    nativeEstimate: "ok",
    nativeGas: 21_000n,
    nativeGasLimits: [],
    readsThrow: false,
    native: "confirmed",
    mint: "confirmed",
    nativeGate: null,
    calls: [],
    factoryReads: [],
    ...overrides,
  };
}

function outcome(
  status: TestnetFaucetTransferOutcome["status"],
  hash: string,
): TestnetFaucetTransferOutcome {
  return status === "not_sent" ? { status } : { status, transactionHash: hash };
}

export function createFakeFaucetChain(
  state: FakeFaucetChainState,
): TestnetFaucetChain {
  const read = <T>(value: T): Promise<T> =>
    state.readsThrow
      ? Promise.reject(new Error("rpc down"))
      : Promise.resolve(value);
  return {
    operatorAddress: faucetOperator,
    readFactoryUsd1: (factory) => {
      state.factoryReads.push(factory);
      return state.factoryUsd1 === "throws"
        ? Promise.reject(new Error("rpc down"))
        : read(state.factoryUsd1);
    },
    readUsd1Decimals: () => read(state.decimals),
    estimateMintGas: () => {
      if (state.readsThrow || state.mintEstimate === "throws") {
        return Promise.reject(new Error("rpc down"));
      }
      return Promise.resolve(
        state.mintEstimate === "ok"
          ? { kind: "ok" as const, gas: state.mintGas }
          : { kind: "reverted" as const },
      );
    },
    estimateNativeGas: () => {
      if (state.readsThrow || state.nativeEstimate === "throws") {
        return Promise.reject(new Error("rpc down"));
      }
      return Promise.resolve(
        state.nativeEstimate === "ok"
          ? { kind: "ok" as const, gas: state.nativeGas }
          : { kind: "reverted" as const },
      );
    },
    readGasPrice: () => read(state.gasPriceWei),
    readOperatorBalance: () => read(state.balanceWei),
    async sendNative(input) {
      state.calls.push(`native:${input.to}:${input.valueWei}`);
      state.nativeGasLimits.push(input.gas);
      if (state.native !== "not_sent") await input.onSigned(bnbHash);
      if (state.nativeGate !== null) await state.nativeGate;
      return outcome(state.native, bnbHash);
    },
    async sendMint(input) {
      state.calls.push(`mint:${input.to}:${input.amountRaw}:${input.usd1}`);
      if (state.mint !== "not_sent") await input.onSigned(usd1Hash);
      return outcome(state.mint, usd1Hash);
    },
  };
}
