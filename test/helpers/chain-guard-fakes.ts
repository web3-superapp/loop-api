import { randomUUID } from "node:crypto";

import {
  chainGuardEventKinds,
  chainGuardHoldKinds,
  chainGuardIncidentKey,
  chainGuardStateKinds,
  type ChainGuardIncidentRecord,
  type ChainGuardInstanceRecord,
  type ChainGuardRepository,
} from "../../src/features/chain-guard/chain-guard-contract.js";
import type {
  ChainGuardChain,
  ChainGuardFactoryReading,
} from "../../src/features/chain-guard/chain-guard-collect.js";
import type { ChainGuardLog } from "../../src/features/chain-guard/chain-guard-evaluate.js";

export const guardAddress = (n: number): string =>
  `0x${n.toString(16).padStart(40, "0")}`;
export const guardPoolId = (n: number): string =>
  `0x${n.toString(16).padStart(64, "0")}`;

export const usd1 = guardAddress(0x05d1);
export const factory = guardAddress(0xfac);
export const poolManager = guardAddress(0x9001);
export const controller = guardAddress(0xc0c0);
export const proxyAdmin = guardAddress(0xad);

export function instanceRecord(n: number): ChainGuardInstanceRecord {
  return {
    instanceId: randomUUID(),
    escrow: guardAddress(0x1000 + n * 16 + 1),
    nft: guardAddress(0x1000 + n * 16 + 2),
    curve: guardAddress(0x1000 + n * 16 + 3),
    graduationAdapter: guardAddress(0x1000 + n * 16 + 4),
    buybackAdapter: guardAddress(0x1000 + n * 16 + 5),
    buybackExecutor: guardAddress(0x1000 + n * 16 + 6),
    poolId: guardPoolId(0x5000 + n),
  };
}

export interface FakeChainGuardChainState {
  chainId: number;
  head: bigint;
  paused: boolean | null;
  implementation: string | null;
  frozen: Map<string, boolean>;
  frozenSupported: boolean;
  controller: string;
  protocolFee: Map<string, number>;
  balances: Map<string, bigint>;
  defaultBalance: bigint;
  logs: ChainGuardLog[];
  factory: ChainGuardFactoryReading | null;
  logQueries: { fromBlock: bigint; toBlock: bigint }[];
}

/** slot0 with only the protocolFee bits set. */
export function slot0WithFee(zeroForOne: number, oneForZero: number): bigint {
  return BigInt(zeroForOne | (oneForZero << 12)) << 184n;
}

export function createFakeChainGuardChain(
  overrides: Partial<FakeChainGuardChainState> = {},
): ChainGuardChain & { readonly state: FakeChainGuardChainState } {
  const state: FakeChainGuardChainState = {
    chainId: 97,
    head: 10_000n,
    paused: false,
    implementation: guardAddress(0x1111),
    frozen: new Map(),
    frozenSupported: true,
    controller,
    protocolFee: new Map(),
    balances: new Map(),
    defaultBalance: 10n ** 18n,
    logs: [],
    factory: {
      factory,
      usd1,
      poolManager,
      platformTaxReceiver: guardAddress(0x7a8),
      feeVault: guardAddress(0xfee),
      loopRouter: null,
      primaryKeeper: guardAddress(0xbee1),
      fallbackKeeper: guardAddress(0xbee2),
      deploymentExecutor: guardAddress(0xe8ec),
    },
    logQueries: [],
    ...overrides,
  };
  return {
    state,
    chainId: () => Promise.resolve(state.chainId),
    head: () => Promise.resolve(state.head),
    readFactory: (address) => {
      if (state.factory === null || state.factory.factory !== address) {
        return Promise.reject(new Error("unknown factory"));
      }
      return Promise.resolve(state.factory);
    },
    readUsd1: () =>
      Promise.resolve({
        paused: state.paused,
        implementation: state.implementation,
        proxyAdmin,
      }),
    readFrozen: (_token, addresses) =>
      Promise.resolve(
        new Map(
          addresses.map((entry) => [
            entry,
            state.frozenSupported ? (state.frozen.get(entry) ?? false) : null,
          ]),
        ),
      ),
    readProtocolFeeController: () => Promise.resolve(state.controller),
    readPoolSlot0: (_manager, poolId) => {
      const fee = state.protocolFee.get(poolId) ?? 0;
      return Promise.resolve(slot0WithFee(fee, fee));
    },
    readBalances: (addresses) =>
      Promise.resolve(
        new Map(
          addresses.map((entry) => [
            entry,
            state.balances.get(entry) ?? state.defaultBalance,
          ]),
        ),
      ),
    getLogs: ({ fromBlock, toBlock }) => {
      state.logQueries.push({ fromBlock, toBlock });
      return Promise.resolve(
        state.logs.filter(
          (log) =>
            BigInt(log.blockNumber) >= fromBlock &&
            BigInt(log.blockNumber) <= toBlock,
        ),
      );
    },
  };
}

export function createInMemoryChainGuardRepository(
  instances: ChainGuardInstanceRecord[] = [],
): ChainGuardRepository & {
  readonly rows: ChainGuardIncidentRecord[];
  readonly cursors: Map<string, bigint>;
  readonly instances: ChainGuardInstanceRecord[];
} {
  const rows: ChainGuardIncidentRecord[] = [];
  const cursors = new Map<string, bigint>();
  const open = (chainId: string) =>
    rows.filter((row) => row.chainId === chainId && row.resolvedAt === null);
  return {
    rows,
    cursors,
    instances,
    listWatchInstances: () => Promise.resolve([...instances]),
    openOrTouch: (input) => {
      const index = rows.findIndex(
        (row) =>
          row.chainId === input.chainId &&
          row.kind === input.kind &&
          row.subject === input.subject &&
          row.resolvedAt === null,
      );
      const at = input.now.toISOString();
      if (index >= 0) {
        const touched = {
          ...(rows[index] as ChainGuardIncidentRecord),
          lastSeenAt: at,
          details: input.details,
        };
        rows[index] = touched;
        return Promise.resolve({ incident: touched, opened: false });
      }
      const incident: ChainGuardIncidentRecord = {
        incidentId: input.incidentId,
        chainId: input.chainId,
        kind: input.kind,
        subject: input.subject,
        details: input.details,
        firstSeenAt: at,
        lastSeenAt: at,
        resolvedAt: null,
      };
      rows.push(incident);
      return Promise.resolve({ incident, opened: true });
    },
    resolve: (input) => {
      const keep = new Set(input.keep);
      const resolved: ChainGuardIncidentRecord[] = [];
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] as ChainGuardIncidentRecord;
        if (row.chainId !== input.chainId || row.resolvedAt !== null) continue;
        if (!input.kinds.includes(row.kind)) continue;
        const isEvent = (chainGuardEventKinds as readonly string[]).includes(
          row.kind,
        );
        const isState = (chainGuardStateKinds as readonly string[]).includes(
          row.kind,
        );
        const due = isEvent
          ? new Date(row.lastSeenAt) < input.eventsSeenBefore
          : isState && !keep.has(chainGuardIncidentKey(row.kind, row.subject));
        if (!due) continue;
        const done = { ...row, resolvedAt: input.now.toISOString() };
        rows[index] = done;
        resolved.push(done);
      }
      return Promise.resolve(resolved);
    },
    listUnresolved: (input) =>
      Promise.resolve(
        rows
          .filter(
            (row) =>
              row.resolvedAt === null &&
              (input.chainId === null || row.chainId === input.chainId),
          )
          .slice(0, input.limit),
      ),
    listHolds: (chainId) =>
      Promise.resolve(
        open(chainId).filter((row) => chainGuardHoldKinds.includes(row.kind)),
      ),
    getCursor: (chainId) => Promise.resolve(cursors.get(chainId) ?? null),
    setCursor: (input) => {
      cursors.set(input.chainId, input.blockNumber);
      return Promise.resolve();
    },
  };
}

export function usd1Log(
  name: ChainGuardLog["name"],
  blockNumber: bigint,
  args: Record<string, string> = {},
  address: string = usd1,
): ChainGuardLog {
  return {
    name,
    address,
    blockNumber: blockNumber.toString(),
    transactionHash: guardPoolId(Number(blockNumber) + 0xabc),
    logIndex: 0,
    args,
  };
}
