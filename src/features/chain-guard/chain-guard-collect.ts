import { launch2PoolId, launch2PoolKey } from "../launch2/launch2-pool.js";
import {
  chainGuardPolicyLimitedReasons,
  type ChainGuardInstanceRecord,
} from "./chain-guard-contract.js";
import {
  decodePackedProtocolFee,
  decodeProtocolFee,
  mergeWatchedAddresses,
  zeroAddress,
  type ChainGuardLog,
  type ChainGuardSnapshot,
  type ChainGuardWatchedAddress,
} from "./chain-guard-evaluate.js";

/**
 * Decision 0134: the read port of the chain guard (implemented over viem in
 * `integrations/chain-guard`) and the collection of one snapshot, shared by
 * the lane and the preflight command.
 */

export interface ChainGuardFactoryReading {
  readonly factory: string;
  readonly usd1: string;
  readonly poolManager: string;
  readonly platformTaxReceiver: string;
  /** OfficialTax Factory only. */
  readonly feeVault: string | null;
  /** LoopDynamic Factory only. */
  readonly loopRouter: string | null;
  readonly primaryKeeper: string;
  readonly fallbackKeeper: string;
  readonly deploymentExecutor: string;
}

export interface ChainGuardChain {
  chainId(): Promise<number>;
  head(): Promise<bigint>;
  readFactory(factory: string): Promise<ChainGuardFactoryReading>;
  readUsd1(usd1: string): Promise<{
    /** null: `paused()` reverted / is absent (testnet mock token). */
    readonly paused: boolean | null;
    readonly implementation: string | null;
    readonly proxyAdmin: string | null;
  }>;
  /** `frozen(address)` per address; null: not implemented. */
  readFrozen(
    usd1: string,
    addresses: readonly string[],
  ): Promise<ReadonlyMap<string, boolean | null>>;
  readProtocolFeeController(poolManager: string): Promise<string>;
  /** The packed v4 `slot0` word of a pool (0 for an unknown pool). */
  readPoolSlot0(poolManager: string, poolId: string): Promise<bigint>;
  /**
   * Decision 0135: `IProtocolFeeController.protocolFeeForPool(key)` (the
   * packed uint24, 12 bits per direction); null when it reverts or the
   * controller has no such function.
   */
  readProtocolFeePolicy(
    controller: string,
    key: {
      readonly currency0: string;
      readonly currency1: string;
      readonly fee: number;
      readonly tickSpacing: number;
      readonly hooks: string;
    },
  ): Promise<number | null>;
  readBalances(
    addresses: readonly string[],
  ): Promise<ReadonlyMap<string, bigint>>;
  getLogs(input: {
    readonly usd1: string;
    readonly proxyAdmin: string | null;
    /** Decision 0135: `ProtocolFeeUpdated` / `ProtocolFeeControllerUpdated`. */
    readonly poolManagers: readonly string[];
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }): Promise<readonly ChainGuardLog[]>;
}

export interface ChainGuardTargets {
  readonly chainId: string;
  readonly chainReference: number;
  /** CHAIN_GUARD_USD1_ADDRESS / LAUNCH_USD1_ADDRESS; else Factory `usd1()`. */
  readonly usd1Address: string | null;
  /** HOOKS_LAUNCH_FACTORY_ADDRESS and LAUNCH2_DYNAMIC_FACTORY_ADDRESS. */
  readonly factories: readonly string[];
  /** CHAIN_GUARD_POOL_MANAGER_ADDRESS (before a Factory exists). */
  readonly poolManagerAddress: string | null;
  /** LAUNCH2_POOL_ROUTER_ADDRESS (OfficialPoolRouter). */
  readonly poolRouterAddress: string | null;
  /** CHAIN_GUARD_WATCH_ADDRESSES: extra `frozen()` subjects. */
  readonly watch: readonly {
    readonly address: string;
    readonly label: string;
  }[];
  /** Signer accounts (derived from configured keys + CHAIN_GUARD_BALANCE_ACCOUNTS). */
  readonly balanceAccounts: readonly {
    readonly address: string;
    readonly label: string;
  }[];
}

export interface ChainGuardCollected {
  readonly snapshot: ChainGuardSnapshot;
  readonly usd1: string;
  readonly proxyAdmin: string | null;
  readonly watched: readonly ChainGuardWatchedAddress[];
}

export class ChainGuardUsd1NotConfiguredError extends Error {
  constructor() {
    super("No USD1 address: none configured and no Factory to read it from");
    this.name = "ChainGuardUsd1NotConfiguredError";
  }
}

const instanceRoles = [
  "escrow",
  "nft",
  "curve",
  "graduationAdapter",
  "buybackAdapter",
  "buybackExecutor",
] as const;

export async function collectChainGuardSnapshot(input: {
  readonly chain: ChainGuardChain;
  readonly targets: ChainGuardTargets;
  readonly instances: readonly ChainGuardInstanceRecord[];
}): Promise<ChainGuardCollected> {
  const { chain, targets, instances } = input;
  const factories: ChainGuardFactoryReading[] = [];
  for (const factory of targets.factories) {
    factories.push(await chain.readFactory(factory));
  }
  const usd1 = targets.usd1Address ?? factories[0]?.usd1 ?? null;
  if (usd1 === null) throw new ChainGuardUsd1NotConfiguredError();

  const watchEntries: { address: string; label: string }[] = [];
  for (const instance of instances) {
    for (const role of instanceRoles) {
      watchEntries.push({
        address: instance[role],
        label: `instance:${instance.instanceId}:${role}`,
      });
    }
  }
  if (targets.poolRouterAddress !== null) {
    watchEntries.push({
      address: targets.poolRouterAddress,
      label: "officialPoolRouter",
    });
  }
  const balanceEntries = [...targets.balanceAccounts];
  const poolManagerSet = new Set<string>();
  if (targets.poolManagerAddress !== null) {
    poolManagerSet.add(targets.poolManagerAddress);
  }
  for (const reading of factories) {
    const tag = `factory:${reading.factory}`;
    poolManagerSet.add(reading.poolManager);
    watchEntries.push(
      { address: reading.poolManager, label: "poolManager" },
      {
        address: reading.platformTaxReceiver,
        label: `${tag}:platformTaxReceiver`,
      },
      { address: reading.primaryKeeper, label: `${tag}:primaryKeeper` },
      { address: reading.fallbackKeeper, label: `${tag}:fallbackKeeper` },
      {
        address: reading.deploymentExecutor,
        label: `${tag}:deploymentExecutor`,
      },
    );
    if (reading.feeVault !== null) {
      watchEntries.push({
        address: reading.feeVault,
        label: `${tag}:feeVault`,
      });
    }
    if (reading.loopRouter !== null) {
      watchEntries.push({
        address: reading.loopRouter,
        label: `${tag}:loopRouter`,
      });
    }
    balanceEntries.push(
      { address: reading.primaryKeeper, label: `${tag}:primaryKeeper` },
      { address: reading.fallbackKeeper, label: `${tag}:fallbackKeeper` },
      {
        address: reading.deploymentExecutor,
        label: `${tag}:deploymentExecutor`,
      },
    );
  }
  for (const manager of poolManagerSet) {
    watchEntries.push({ address: manager, label: "poolManager" });
  }
  watchEntries.push(...targets.watch);
  for (const account of balanceEntries) {
    watchEntries.push({ address: account.address, label: account.label });
  }
  const watched = mergeWatchedAddresses(watchEntries);
  const balanceAccounts = mergeWatchedAddresses(balanceEntries);

  const usd1State = await chain.readUsd1(usd1);
  const frozen = await chain.readFrozen(
    usd1,
    watched.map((entry) => entry.address),
  );
  const poolManagers: {
    address: string;
    protocolFeeController: string;
  }[] = [];
  for (const manager of [...poolManagerSet].sort()) {
    poolManagers.push({
      address: manager,
      protocolFeeController: await chain.readProtocolFeeController(manager),
    });
  }
  const pools: ChainGuardSnapshot["pools"][number][] = [];
  for (const instance of instances) {
    if (instance.poolId === null) continue;
    const poolId = instance.poolId.toLowerCase();
    // Decision 0135: the PoolKey the fee policy is asked about, rebuilt the
    // way the launch2 pool routes do (launch2PoolKey) and checked against
    // the indexed pool id.
    const candidate =
      instance.poolHook === null
        ? null
        : launch2PoolKey({
            meme: instance.meme,
            usd1,
            hook: instance.poolHook,
          });
    const key =
      candidate !== null && launch2PoolId(candidate) === poolId
        ? candidate
        : null;
    for (const manager of poolManagers) {
      const fee = decodeProtocolFee(
        await chain.readPoolSlot0(manager.address, instance.poolId),
      );
      let policy: ChainGuardSnapshot["pools"][number]["policy"] = null;
      let policyLimited: string | null = null;
      if (manager.protocolFeeController === zeroAddress) {
        policyLimited = chainGuardPolicyLimitedReasons.controllerUnset;
      } else if (key === null) {
        policyLimited = chainGuardPolicyLimitedReasons.poolKeyUnknown;
      } else {
        const packed = await chain.readProtocolFeePolicy(
          manager.protocolFeeController,
          key,
        );
        if (packed === null) {
          policyLimited = chainGuardPolicyLimitedReasons.unsupported;
        } else {
          policy = decodePackedProtocolFee(packed);
        }
      }
      pools.push({
        poolId: instance.poolId,
        instanceId: instance.instanceId,
        poolManager: manager.address,
        ...fee,
        policy,
        policyLimited,
      });
    }
  }
  const balances = await chain.readBalances(
    balanceAccounts.map((entry) => entry.address),
  );

  return Object.freeze({
    usd1,
    proxyAdmin: usd1State.proxyAdmin,
    watched,
    snapshot: Object.freeze({
      chainReference: targets.chainReference,
      usd1: {
        address: usd1,
        paused: usd1State.paused,
        implementation: usd1State.implementation,
      },
      factoryUsd1: factories.map((reading) => ({
        factory: reading.factory,
        usd1: reading.usd1,
      })),
      frozen: watched.map((entry) => ({
        ...entry,
        frozen: frozen.get(entry.address) ?? null,
      })),
      poolManagers,
      pools,
      balances: balanceAccounts.map((entry) => ({
        ...entry,
        wei: balances.get(entry.address) ?? 0n,
      })),
    }),
  });
}
