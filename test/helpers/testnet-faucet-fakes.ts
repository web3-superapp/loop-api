import { vi } from "vitest";

import type {
  AccountWalletRecord,
  AccountWalletRepository,
} from "../../src/database/account-wallet-repository.js";
import {
  TestnetFaucetIdempotencyConflictError,
  type TestnetFaucetChain,
  type TestnetFaucetGrantRecord,
  type TestnetFaucetRepository,
  type TestnetFaucetTransferOutcome,
} from "../../src/features/testnet-faucet/testnet-faucet-contract.js";

/** Decision 0128 fakes: in-memory grants, a scripted operator chain, wallets. */

export const faucetUsd1 = "0x00000000000000000000000000000000000005d1";
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
  readonly records: Map<
    string,
    { readonly ownerUserId: string; readonly requestSha256: string }
  >;
}

/** Mirrors the PostgreSQL repository's rules (Decision 0128 §2). */
export function createInMemoryFaucetRepository(): InMemoryFaucetRepository {
  const grants: StoredGrant[] = [];
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
    records,
    latestBlockingGrant(address, since) {
      return Promise.resolve(
        newest(
          (grant) =>
            grant.address === address &&
            grant.status !== "failed" &&
            Date.parse(grant.grantedAt) > since.getTime(),
        ),
      );
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
      const since = new Date(
        input.now.getTime() - input.cooldownSeconds * 1_000,
      );
      const blocking = newest(
        (grant) =>
          grant.address === input.address &&
          grant.status !== "failed" &&
          Date.parse(grant.grantedAt) > since.getTime(),
      );
      if (blocking !== null) {
        return Promise.resolve({ kind: "cooldown", blocking });
      }
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
  decimals: number;
  balanceWei: bigint;
  gasPriceWei: bigint;
  mintGas: bigint;
  mintEstimate: "ok" | "reverted" | "throws";
  readsThrow: boolean;
  native: TestnetFaucetTransferOutcome["status"];
  mint: TestnetFaucetTransferOutcome["status"];
  /** Resolves the native send only when released (concurrency tests). */
  nativeGate: Promise<void> | null;
  readonly calls: string[];
}

export function defaultFaucetChainState(
  overrides: Partial<FakeFaucetChainState> = {},
): FakeFaucetChainState {
  return {
    decimals: 18,
    balanceWei: 10n ** 18n,
    gasPriceWei: 1_000_000_000n,
    mintGas: 60_000n,
    mintEstimate: "ok",
    readsThrow: false,
    native: "confirmed",
    mint: "confirmed",
    nativeGate: null,
    calls: [],
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
    readGasPrice: () => read(state.gasPriceWei),
    readOperatorBalance: () => read(state.balanceWei),
    async sendNative(input) {
      state.calls.push(`native:${input.to}:${input.valueWei}`);
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
