import { randomUUID } from "node:crypto";

import { vi } from "vitest";

import {
  MiningClaimIdempotencyConflictError,
  MiningSettlementConflictError,
  MiningSettlementUnavailableError,
  type MiningBalanceRecord,
  type MiningClaimChain,
  type MiningClaimReceipt,
  type MiningClaimRecord,
  type MiningEpochRecord,
  type MiningEpochRewardRecord,
  type MiningParameterVersionRecord,
  type MiningSettlementRepository,
} from "../../src/features/mining/hourly-settlement-ports.js";
import { miningDefaultParameterDocument } from "../../src/features/mining/hourly-settlement-contract.js";

export const loop = 10n ** 18n;
export const claimContract = "0x7777777777777777777777777777777777777777";
export const signerKey =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

export function parameterVersion(
  overrides: Partial<MiningParameterVersionRecord> = {},
): MiningParameterVersionRecord {
  return {
    versionId: "11111111-1111-4111-8111-111111111111",
    configVersion: "miningHourlyV1",
    status: "approved",
    document: {
      ...miningDefaultParameterDocument,
      releaseStartAt: "2026-10-10T00:00:00.000Z",
      assetWeights: [],
      communityCoefficients: [],
    },
    effectiveFrom: "2026-10-10T00:00:00.000Z",
    draftAuthor: { actor: "admin", accountId: null },
    approvedBy: "reviewer",
    approvedAt: "2026-10-09T00:00:00.000Z",
    createdAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  };
}

export function epochRecord(
  overrides: Partial<MiningEpochRecord> = {},
): MiningEpochRecord {
  return {
    epochId: "22222222-2222-4222-8222-222222222222",
    hourStart: "2026-10-10T10:00:00.000Z",
    hourEnd: "2026-10-10T11:00:00.000Z",
    status: "settled",
    versionId: "11111111-1111-4111-8111-111111111111",
    budgetNftRaw: "20833333333333333333333",
    budgetAssetRaw: "20833333333333333333333",
    denominatorNftPower: "10",
    denominatorAssetPower: "0",
    allocatedNftRaw: "20833333333333333333333",
    allocatedAssetRaw: "0",
    unallocatedNftRaw: "0",
    unallocatedAssetRaw: "20833333333333333333333",
    userCount: 1,
    inputDigest: "a".repeat(64),
    inputSummary: { excludedAssets: [] },
    failureReasonCode: null,
    attemptCount: 1,
    trigger: "scheduled",
    settledAt: "2026-10-10T11:02:00.000Z",
    updatedAt: "2026-10-10T11:02:00.000Z",
    ...overrides,
  };
}

export function rewardRecord(
  userId: string,
  totalRaw: bigint,
  overrides: Partial<MiningEpochRewardRecord> = {},
): MiningEpochRewardRecord {
  return {
    epochId: "22222222-2222-4222-8222-222222222222",
    hourStart: "2026-10-10T10:00:00.000Z",
    hourEnd: "2026-10-10T11:00:00.000Z",
    userId,
    nftSelfPower: "10",
    assetSelfPower: "0",
    nftReferralPower: "0",
    assetReferralPower: "0",
    nftTotalPower: "10",
    assetTotalPower: "0",
    levels: [1, 2, 3, 4, 5].map((level, index) => ({
      level,
      ratioBps: [1000, 500, 300, 200, 100][index] as number,
      effectiveMembers: 0,
      nftPower: "0",
      assetPower: "0",
      nftUnitsByCommunity: [],
    })),
    nftHoldings: [
      {
        instanceId: "33333333-3333-4333-8333-333333333333",
        communityId: "44444444-4444-4444-8444-444444444444",
        countAtEnd: "5",
        power: "10",
      },
    ],
    assetHoldings: [],
    nftRewardRaw: totalRaw.toString(),
    assetRewardRaw: "0",
    totalRewardRaw: totalRaw.toString(),
    ...overrides,
  };
}

export interface InMemoryMiningSettlement extends MiningSettlementRepository {
  versions: MiningParameterVersionRecord[];
  epochs: MiningEpochRecord[];
  rewards: MiningEpochRewardRecord[];
  balances: Map<string, { settled: bigint; claimed: bigint }>;
  claims: Map<string, MiningClaimRecord>;
  claimedEvents: Set<string>;
  unavailable: boolean;
}

export function createInMemoryMiningSettlement(): InMemoryMiningSettlement {
  const prepareKeys = new Map<
    string,
    { sha: string; claimId: string | null }
  >();
  const reportKeys = new Map<string, string>();
  const reject = vi.fn(() =>
    Promise.reject(new MiningSettlementUnavailableError()),
  );
  const repo: InMemoryMiningSettlement = {
    versions: [],
    epochs: [],
    rewards: [],
    balances: new Map(),
    claims: new Map(),
    claimedEvents: new Set(),
    unavailable: false,
    listApprovedParameterVersions: () =>
      repo.unavailable
        ? Promise.reject(new MiningSettlementUnavailableError())
        : Promise.resolve(repo.versions.filter((v) => v.status === "approved")),
    listParameterVersions: () => Promise.resolve(repo.versions),
    getParameterVersion: (id) =>
      Promise.resolve(repo.versions.find((v) => v.versionId === id) ?? null),
    listApprovedCommunityWeights: () => Promise.resolve([]),
    findUnknownAssetIds: () => Promise.resolve([]),
    createParameterDraft: reject,
    approveParameterVersion: reject,
    withdrawParameterVersion: reject,
    recordAudit: reject,
    readIndexerFreshness: reject,
    readSettlementFacts: reject,
    getEpochByHour: (hour) =>
      Promise.resolve(repo.epochs.find((e) => e.hourStart === hour) ?? null),
    getEpoch: (id) =>
      Promise.resolve(repo.epochs.find((e) => e.epochId === id) ?? null),
    recordEpochFailure: reject,
    commitEpoch: reject,
    listEpochs: () => Promise.resolve(repo.epochs),
    listEpochRewards: ({ epochId }) =>
      Promise.resolve(repo.rewards.filter((r) => r.epochId === epochId)),
    latestSettledEpoch: () => {
      if (repo.unavailable) {
        return Promise.reject(new MiningSettlementUnavailableError());
      }
      const settled = repo.epochs
        .filter((e) => e.status === "settled")
        .sort((a, b) => (a.hourStart < b.hourStart ? 1 : -1));
      return Promise.resolve(settled[0] ?? null);
    },
    totalUnclaimedRaw: () => {
      let total = 0n;
      for (const row of repo.balances.values())
        total += row.settled - row.claimed;
      return Promise.resolve(total.toString());
    },
    getBalance: (userId): Promise<MiningBalanceRecord> => {
      if (repo.unavailable) {
        return Promise.reject(new MiningSettlementUnavailableError());
      }
      const row = repo.balances.get(userId) ?? { settled: 0n, claimed: 0n };
      return Promise.resolve({
        settledTotalRaw: row.settled.toString(),
        claimedTotalRaw: row.claimed.toString(),
        unclaimedRaw: (row.settled - row.claimed).toString(),
      });
    },
    getUserEpochReward: (userId, epochId) =>
      Promise.resolve(
        repo.rewards.find(
          (r) => r.userId === userId && r.epochId === epochId,
        ) ?? null,
      ),
    listUserEpochRewards: ({ userId, beforeHourStart, limit }) =>
      Promise.resolve(
        repo.rewards
          .filter(
            (r) =>
              r.userId === userId &&
              (beforeHourStart === null || r.hourStart < beforeHourStart) &&
              // Decision 0125: zero-power hours are not listed.
              (Number(r.nftTotalPower) > 0 ||
                Number(r.assetTotalPower) > 0 ||
                BigInt(r.totalRewardRaw) > 0n),
          )
          .sort((a, b) => (a.hourStart < b.hourStart ? 1 : -1))
          .slice(0, limit),
      ),
    listUserClaimWallets: (userId) =>
      Promise.resolve([
        ...new Set(
          [...repo.claims.values()]
            .filter((c) => c.userId === userId)
            .map((c) => c.walletAddress),
        ),
      ]),
    listOpenClaims: (userId) =>
      Promise.resolve(
        [...repo.claims.values()].filter(
          (c) =>
            c.userId === userId &&
            ["claimable", "submitting", "confirming"].includes(c.status),
        ),
      ),
    async createClaim(input) {
      const key = `${input.userId}|${input.idempotencyKey}`;
      const seen = prepareKeys.get(key);
      if (seen !== undefined) {
        if (seen.sha !== input.requestSha256) {
          throw new MiningClaimIdempotencyConflictError();
        }
        if (seen.claimId !== null) {
          return {
            created: false,
            claim: repo.claims.get(seen.claimId) as MiningClaimRecord,
          };
        }
      }
      prepareKeys.set(key, { sha: input.requestSha256, claimId: null });
      const built = await input.build();
      const now = new Date().toISOString();
      const claim: MiningClaimRecord = {
        ...built,
        status: "claimable",
        transactionHash: null,
        blockNumber: null,
        confirmedDeltaRaw: null,
        failureReasonCode: null,
        createdAt: now,
        updatedAt: now,
      };
      repo.claims.set(claim.claimId, claim);
      prepareKeys.set(key, {
        sha: input.requestSha256,
        claimId: claim.claimId,
      });
      return { created: true, claim };
    },
    getClaim: (userId, claimId) => {
      const claim = repo.claims.get(claimId);
      return Promise.resolve(
        claim === undefined || claim.userId !== userId ? null : claim,
      );
    },
    claimReportCommand: ({ userId, idempotencyKey, requestSha256 }) => {
      const key = `${userId}|${idempotencyKey}`;
      const seen = reportKeys.get(key);
      if (seen !== undefined && seen !== requestSha256) {
        return Promise.reject(new MiningClaimIdempotencyConflictError());
      }
      reportKeys.set(key, requestSha256);
      return Promise.resolve();
    },
    transitionClaim: ({ claimId, transition }) => {
      const claim = repo.claims.get(claimId) as MiningClaimRecord;
      const terminal = ["succeeded", "failed", "expired"].includes(
        claim.status,
      );
      const set = (patch: Partial<MiningClaimRecord>) => {
        const next = {
          ...claim,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        repo.claims.set(claimId, next);
        return Promise.resolve(next);
      };
      if (transition.kind === "expired") {
        return claim.status === "claimable"
          ? set({
              status: "expired",
              failureReasonCode: "MINING_CLAIM_EXPIRED",
            })
          : Promise.resolve(claim);
      }
      if (
        transition.transactionHash !== null &&
        claim.transactionHash !== null &&
        claim.transactionHash !== transition.transactionHash
      ) {
        return Promise.reject(
          new MiningSettlementConflictError(
            "MINING_CLAIM_TRANSACTION_CONFLICT",
          ),
        );
      }
      for (const other of repo.claims.values()) {
        if (
          other.claimId !== claimId &&
          transition.transactionHash !== null &&
          other.transactionHash === transition.transactionHash
        ) {
          return Promise.reject(
            new MiningSettlementConflictError(
              "MINING_CLAIM_TRANSACTION_CONFLICT",
            ),
          );
        }
      }
      if (terminal) return Promise.resolve(claim);
      if (transition.kind === "submitted") {
        return claim.status === "claimable"
          ? set({
              status: "submitting",
              transactionHash: transition.transactionHash,
            })
          : Promise.resolve(claim);
      }
      if (transition.kind === "confirming") {
        return set({
          status: "confirming",
          transactionHash: transition.transactionHash,
          blockNumber: transition.blockNumber,
        });
      }
      if (transition.kind === "failed") {
        return set({
          status: "failed",
          transactionHash: transition.transactionHash,
          blockNumber: transition.blockNumber,
          failureReasonCode: transition.reasonCode,
        });
      }
      if (!repo.claimedEvents.has(claimId)) {
        repo.claimedEvents.add(claimId);
        const row = repo.balances.get(claim.userId) ?? {
          settled: 0n,
          claimed: 0n,
        };
        row.claimed += BigInt(transition.deltaRaw);
        repo.balances.set(claim.userId, row);
      }
      return set({
        status: "succeeded",
        transactionHash: transition.transactionHash,
        blockNumber: transition.blockNumber,
        confirmedDeltaRaw: transition.deltaRaw,
      });
    },
    listClaims: ({ userId, limit }) =>
      Promise.resolve(
        [...repo.claims.values()]
          .filter((c) => c.userId === userId)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .slice(0, limit),
      ),
    listUnresolvedClaims: (limit) =>
      Promise.resolve(
        [...repo.claims.values()]
          .filter((c) =>
            ["claimable", "submitting", "confirming"].includes(c.status),
          )
          .slice(0, limit),
      ),
  };
  return repo;
}

export interface FakeClaimChainState {
  nonces: Map<string, bigint>;
  claimed: Map<string, bigint>;
  paused: boolean;
  balance: bigint;
  head: bigint;
  receipts: Map<string, MiningClaimReceipt>;
  logs: Array<{
    transactionHash: string;
    wallet: string;
    nonce: bigint;
    amountRaw: bigint;
    cumulativeAmountRaw: bigint;
    blockNumber: bigint;
  }>;
  unavailable: boolean;
}

export function defaultClaimChainState(): FakeClaimChainState {
  return {
    nonces: new Map(),
    claimed: new Map(),
    paused: false,
    balance: 1_000_000n * loop,
    head: 1_000n,
    receipts: new Map(),
    logs: [],
    unavailable: false,
  };
}

export function createFakeClaimChain(
  state: FakeClaimChainState,
): MiningClaimChain {
  const guard = () => {
    if (state.unavailable) throw new Error("rpc down");
  };
  return {
    chainReference: 97,
    readClaimState: ({ wallet, otherWallets }) => {
      guard();
      const all = [...new Set([wallet, ...otherWallets])];
      return Promise.resolve({
        blockNumber: state.head,
        nonce: state.nonces.get(wallet) ?? 0n,
        paused: state.paused,
        contractBalanceRaw: state.balance,
        claimedByWallet: new Map(
          all.map((address) => [address, state.claimed.get(address) ?? 0n]),
        ),
      });
    },
    readFunding: () => {
      guard();
      return Promise.resolve({
        blockNumber: state.head,
        balanceRaw: state.balance,
        liabilityHintRaw: null,
        paused: state.paused,
      });
    },
    readReceipt: ({ transactionHash }) => {
      guard();
      return Promise.resolve(
        state.receipts.get(transactionHash) ?? { kind: "not_found" },
      );
    },
    findClaimedLog: ({ wallet, nonce }) => {
      guard();
      const log = state.logs.find(
        (entry) => entry.wallet === wallet && entry.nonce === nonce,
      );
      return Promise.resolve(log ?? null);
    },
    readNonce: ({ wallet }) => {
      guard();
      return Promise.resolve({
        nonce: state.nonces.get(wallet) ?? 0n,
        blockNumber: state.head,
      });
    },
  };
}

/** Simulates the contract landing a claim: claimed/nonce move, log + receipt. */
export function landClaim(
  state: FakeClaimChainState,
  input: {
    readonly wallet: string;
    readonly cumulativeAmountRaw: bigint;
    readonly confirmations?: bigint;
    readonly transactionHash?: string;
  },
): string {
  const hash =
    input.transactionHash ??
    `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const before = state.claimed.get(input.wallet) ?? 0n;
  const nonce = state.nonces.get(input.wallet) ?? 0n;
  const amount = input.cumulativeAmountRaw - before;
  state.claimed.set(input.wallet, input.cumulativeAmountRaw);
  state.nonces.set(input.wallet, nonce + 1n);
  state.balance -= amount;
  const log = {
    transactionHash: hash,
    wallet: input.wallet,
    nonce,
    amountRaw: amount,
    cumulativeAmountRaw: input.cumulativeAmountRaw,
    blockNumber: state.head,
  };
  state.logs.push(log);
  state.receipts.set(hash, {
    kind: "mined",
    blockNumber: state.head,
    confirmations: input.confirmations ?? 5n,
    logs: [log],
  });
  return hash;
}
