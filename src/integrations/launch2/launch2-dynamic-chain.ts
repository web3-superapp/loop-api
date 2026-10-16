import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  ExecutionRevertedError,
  fallback,
  http,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type StateOverride,
  type Transport,
} from "viem";
import { viemLaunchChain } from "../bsc/viem-launch-chain.js";

import { launch2DynamicNeutralHookSlots } from "../../features/launch2/launch2-dynamic.js";
import type {
  Launch2DynamicChain,
  Launch2DynamicFactoryRouting,
  Launch2DynamicHookState,
  Launch2DynamicRoundState,
  Launch2DynamicSwapCall,
  Launch2PoolRouterCheck,
} from "../../features/launch2/launch2-ports.js";
import {
  loopDynamicBuybackAdapterAbi,
  loopDynamicHookAbi,
  loopDynamicLaunchFactoryAbi,
  loopRouterAbi,
  poolManagerAbi,
} from "../launch/hooks-launch-protocol-abi.generated.js";
import {
  mappingSlot,
  nestedSlot,
  probeErc20Layout,
  revertData,
  slotHex,
  tokenOverride,
  type TokenLayout,
} from "./launch2-pool-chain.js";

/**
 * Decision 0131 (S166): the LoopDynamic reader behind
 * `/v2/launch2/instances/{id}/dynamic-pool*` and the LoopDynamic branch of
 * `…/pool/quote` and `…/pool/trade/prepare`. It verifies the configured
 * `LoopRouter` by runtime code hash, reads the per-project
 * `LoopDynamicHook` (immutables, candle / round state, the wallet's
 * weight) and the pool's slot0 at one block, and simulates
 * `LoopRouter.swapExactInput` / `hook.claim(roundId)` with `eth_call`. A
 * swap simulation overrides the input token's balance and allowance to the
 * router in the call only (the same ERC-20 slot probe as Decision 0124);
 * a "neutral" simulation additionally overrides the Hook's `initialized /
 * armed` and `candleId` slots so only the base fee applies (the sell fee
 * split). It never signs or sends.
 *
 * Decision 0153: every redeploy ships a new LoopRouter, so a LoopDynamic
 * instance trades through **its own Factory's** router. The reader takes
 * the router per call (`simulateSwap.router`, `verifyRouter(router)`), reads
 * a Factory's immutable routing (`loopRouter()` / `routerRegistry()` /
 * `loopHookDeploymentFactory()`) and its `loopHook(launchId)`, and accepts
 * a router whose runtime code hash is the configured one or one of the
 * listed legacy hashes. Which Factories are trusted is the service's call.
 */

const revertAbi = [
  ...loopRouterAbi,
  ...loopDynamicHookAbi,
  ...loopDynamicBuybackAdapterAbi,
  ...poolManagerAbi,
  ...erc20Abi,
  {
    type: "error",
    name: "WrappedError",
    inputs: [
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
      { name: "reason", type: "bytes" },
      { name: "details", type: "bytes" },
    ],
  },
] as unknown as Abi;

const lower = (value: string): string => value.toLowerCase();
/** Name-addressed reads (`functionName: string`). */
const hookAbi = loopDynamicHookAbi as Abi;
/** Decision 0153: name-addressed Factory reads. */
const factoryAbi = loopDynamicLaunchFactoryAbi as Abi;

/** Decodes a custom error name, unwrapping the v4 `WrappedError`. */
export function launch2DynamicErrorName(data: Hex | null): string | null {
  if (data === null || data.length < 10) return null;
  try {
    const decoded = decodeErrorResult({ abi: revertAbi, data });
    if (decoded.errorName === "WrappedError") {
      const args = decoded.args as readonly unknown[];
      return launch2DynamicErrorName(args[2] as Hex) ?? "WrappedError";
    }
    return decoded.errorName;
  } catch {
    return null;
  }
}

/**
 * A contract-level revert (or empty return data) of a view — a function the
 * contract does not have. Network and RPC failures are not reverts.
 */
export function isLaunch2ContractRevert(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return (
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError ||
        cause instanceof ContractFunctionZeroDataError ||
        cause instanceof ExecutionRevertedError,
    ) !== null
  );
}

function roundOf(value: unknown): Launch2DynamicRoundState {
  const r = value as readonly [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    boolean,
  ];
  return Object.freeze({
    startCandle: r[0],
    endCandle: r[1],
    extraFees: r[2],
    totalBuyWeight: r[3],
    allocation: r[4],
    claimed: r[5],
    closed: r[6],
  });
}

export function createLaunch2DynamicChain(input: {
  readonly rpcUrls: readonly string[];
  readonly router: string;
  readonly expectedRuntimeCodeHash: string;
  /**
   * Decision 0153: `LAUNCH2_DYNAMIC_LEGACY_ROUTER_CODE_HASHES` — further
   * accepted LoopRouter runtime code hashes (older Factories' routers).
   */
  readonly legacyRuntimeCodeHashes?: readonly string[];
  readonly transport?: Transport;
  readonly retryAfterMs?: number;
  readonly now?: () => number;
  /** Decision 0150: the launch slot (viem chain); absent = 97. */
  readonly chainReference?: 56 | 97;
}): Launch2DynamicChain {
  const legacyHashes = input.legacyRuntimeCodeHashes ?? [];
  if (
    !/^0x[0-9a-fA-F]{40}$/u.test(input.router) ||
    !/^0x[0-9a-fA-F]{64}$/u.test(input.expectedRuntimeCodeHash) ||
    legacyHashes.some((hash) => !/^0x[0-9a-fA-F]{64}$/u.test(hash))
  ) {
    throw new Error("Launch2 LoopRouter address / code hash are malformed");
  }
  const router = lower(input.router);
  const acceptedCodeHashes = new Set([
    lower(input.expectedRuntimeCodeHash),
    ...legacyHashes.map(lower),
  ]);
  const retryAfterMs = input.retryAfterMs ?? 60_000;
  const now = input.now ?? Date.now;
  const transport =
    input.transport ??
    fallback(
      input.rpcUrls.map((url) =>
        http(url, { timeout: 10_000, retryCount: 1, batch: { batchSize: 32 } }),
      ),
      { retryCount: 0 },
    );
  const client = createPublicClient({
    chain: viemLaunchChain(input.chainReference ?? 97),
    transport,
  });
  /** Decision 0153: one verification state per router address. */
  const checks = new Map<
    string,
    {
      verified: Launch2PoolRouterCheck | null;
      failedAt: number;
      inFlight: Promise<Launch2PoolRouterCheck> | null;
    }
  >();
  const layouts = new Map<string, TokenLayout | null>();

  async function checkRouter(target: string): Promise<Launch2PoolRouterCheck> {
    const code = await client.getCode({ address: target as Address });
    if (
      code === undefined ||
      code === "0x" ||
      !acceptedCodeHashes.has(lower(keccak256(code)))
    ) {
      return {
        status: "unavailable",
        reasonCode: "LAUNCH2_DYNAMIC_ROUTER_CODE_MISMATCH",
      };
    }
    const manager = await client.readContract({
      address: target as Address,
      abi: loopRouterAbi,
      functionName: "manager",
    });
    return { status: "ok", poolManager: lower(manager) };
  }

  /** A Factory view, or null when the Factory reverts (RPC errors throw). */
  async function factoryRead(
    factory: string,
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<string | null> {
    try {
      return lower(
        String(
          await client.readContract({
            address: factory as Address,
            abi: factoryAbi,
            functionName,
            args,
          }),
        ),
      );
    } catch (error) {
      if (isLaunch2ContractRevert(error)) return null;
      throw error;
    }
  }

  async function hookRead<T>(
    hook: string,
    functionName: string,
    blockNumber: bigint,
    args: readonly unknown[] = [],
  ): Promise<T> {
    return (await client.readContract({
      address: hook as Address,
      abi: hookAbi,
      functionName,
      args,
      blockNumber,
    })) as T;
  }

  /**
   * Decision 0144: `maxDynamicFeeWad()` of the Hook, or null when the Hook
   * has no such function (a pre-S193 Hook: the call reverts / returns no
   * data). RPC and network failures propagate (fail closed).
   */
  async function hookCapRead(
    hook: string,
    blockNumber: bigint,
  ): Promise<bigint | null> {
    try {
      return await hookRead<bigint>(hook, "maxDynamicFeeWad", blockNumber);
    } catch (error) {
      if (isLaunch2ContractRevert(error)) return null;
      throw error;
    }
  }

  async function overrideFor(
    call: Pick<
      Launch2DynamicSwapCall,
      "override" | "neutralHook" | "from" | "router"
    > & {
      readonly blockNumber?: bigint;
    },
  ): Promise<StateOverride | undefined | "unsupported"> {
    const spender = lower(call.router);
    const entries: StateOverride = [];
    if (call.override !== null) {
      const { token, balance, allowance } = call.override;
      const key = lower(token);
      let layout = layouts.get(key);
      if (layout === undefined) {
        const block =
          call.blockNumber ?? (await client.getBlockNumber({ cacheTime: 0 }));
        layout = await probeErc20Layout(
          client,
          key,
          lower(call.from),
          spender,
          block,
        );
        layouts.set(key, layout);
      }
      if (layout === null) return "unsupported";
      const slots = [
        {
          slot: nestedSlot(
            lower(call.from),
            spender,
            layout.allowanceBase,
            layout.order,
          ),
          value: allowance,
        },
      ];
      if (balance !== null) {
        slots.push({
          slot: mappingSlot(lower(call.from), layout.balanceBase, layout.order),
          value: balance,
        });
      }
      entries.push(...tokenOverride(key, slots));
    }
    if (call.neutralHook !== null) {
      entries.push(
        ...tokenOverride(
          lower(call.neutralHook),
          launch2DynamicNeutralHookSlots,
        ),
      );
    }
    return entries.length === 0 ? undefined : entries;
  }

  return Object.freeze<Launch2DynamicChain>({
    router,

    async verifyRouter(target = router) {
      const key = lower(target);
      if (!/^0x[0-9a-f]{40}$/u.test(key)) {
        return {
          status: "unavailable",
          reasonCode: "LAUNCH2_DYNAMIC_ROUTER_CODE_MISMATCH",
        };
      }
      let entry = checks.get(key);
      if (entry === undefined) {
        entry = { verified: null, failedAt: 0, inFlight: null };
        checks.set(key, entry);
      }
      const state = entry;
      if (state.verified?.status === "ok") return state.verified;
      if (state.verified !== null && now() - state.failedAt < retryAfterMs) {
        return state.verified;
      }
      if (state.inFlight !== null) return state.inFlight;
      state.inFlight = checkRouter(key)
        .then((result) => {
          state.verified = result;
          if (result.status !== "ok") state.failedAt = now();
          return result;
        })
        .finally(() => {
          state.inFlight = null;
        });
      return state.inFlight;
    },

    async readFactoryRouting(factory) {
      const address = lower(factory);
      const [loopRouter, routerRegistry, hookDeploymentFactory] =
        await Promise.all([
          factoryRead(address, "loopRouter"),
          factoryRead(address, "routerRegistry"),
          factoryRead(address, "loopHookDeploymentFactory"),
        ]);
      if (
        loopRouter === null ||
        routerRegistry === null ||
        hookDeploymentFactory === null
      ) {
        return null;
      }
      return Object.freeze<Launch2DynamicFactoryRouting>({
        router: loopRouter,
        routerRegistry,
        hookDeploymentFactory,
      });
    },

    async readFactoryHook(request) {
      return factoryRead(lower(request.factory), "loopHook", [
        request.launchId,
      ]);
    },

    async readHookState(request): Promise<Launch2DynamicHookState> {
      const block = await client.getBlock({ blockTag: "latest" });
      const at = block.number;
      const hook = lower(request.hook);
      const [
        manager,
        trustedRouter,
        meme,
        quote,
        memeIsCurrency0,
        poolId,
        initialized,
        armed,
        candleId,
        candleOpen,
        lastPrice,
        currentRoundId,
        carry,
        reservedRewards,
        currentDropWad,
        baseSellFeePpm,
        buyFeePpm,
        priceTiming,
        routingPolicy,
        routerRegistry,
        excludeBuybackFromRewards,
        rewardExcludedBuyer,
        maxDynamicFeeWad,
      ] = await Promise.all([
        hookRead<string>(hook, "manager", at),
        hookRead<string>(hook, "trustedRouter", at),
        hookRead<string>(hook, "meme", at),
        hookRead<string>(hook, "quote", at),
        hookRead<boolean>(hook, "memeIsCurrency0", at),
        hookRead<string>(hook, "poolId", at),
        hookRead<boolean>(hook, "initialized", at),
        hookRead<boolean>(hook, "armed", at),
        hookRead<bigint>(hook, "candleId", at),
        hookRead<bigint>(hook, "candleOpenSqrtPriceX96", at),
        hookRead<bigint>(hook, "lastSqrtPriceX96", at),
        hookRead<bigint>(hook, "currentRoundId", at),
        hookRead<bigint>(hook, "carry", at),
        hookRead<bigint>(hook, "reservedRewards", at),
        hookRead<bigint>(hook, "currentDropWad", at),
        hookRead<number>(hook, "baseSellFeePpm", at),
        hookRead<number>(hook, "buyFeePpm", at),
        hookRead<number>(hook, "priceTiming", at),
        hookRead<number>(hook, "routingPolicy", at),
        hookRead<string>(hook, "routerRegistry", at),
        hookRead<boolean>(hook, "excludeBuybackFromRewards", at),
        hookRead<string>(hook, "rewardExcludedBuyer", at),
        hookCapRead(hook, at),
      ]);
      const slotKey = keccak256(
        encodePacked(["bytes32", "bytes32"], [poolId as Hex, slotHex(6n)]),
      );
      const [slot0, round] = await Promise.all([
        client.readContract({
          address: manager as Address,
          abi: poolManagerAbi,
          functionName: "extsload",
          args: [slotKey],
          blockNumber: at,
        }),
        currentRoundId === 0n
          ? Promise.resolve(null)
          : hookRead<unknown>(hook, "rounds", at, [currentRoundId]),
      ]);
      let wallet: Launch2DynamicHookState["wallet"] = null;
      if (request.wallet !== null) {
        const address = lower(request.wallet) as Address;
        const [weight, usd1Balance, memeBalance] = await Promise.all([
          currentRoundId === 0n
            ? Promise.resolve(0n)
            : hookRead<bigint>(hook, "buyWeight", at, [
                currentRoundId,
                address,
              ]),
          client.readContract({
            address: quote as Address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
            blockNumber: at,
          }),
          client.readContract({
            address: meme as Address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
            blockNumber: at,
          }),
        ]);
        wallet = Object.freeze({
          address: lower(address),
          currentRoundWeight: weight,
          usd1Balance,
          memeBalance,
        });
      }
      return Object.freeze({
        blockNumber: at,
        blockHash: lower(block.hash),
        blockTimestamp: block.timestamp,
        manager: lower(manager),
        trustedRouter: lower(trustedRouter),
        meme: lower(meme),
        quote: lower(quote),
        memeIsCurrency0,
        poolId: lower(poolId),
        initialized,
        armed,
        candleId,
        candleOpenSqrtPriceX96: candleOpen,
        lastSqrtPriceX96: lastPrice,
        currentRoundId,
        carry,
        reservedRewards,
        currentDropWad,
        baseSellFeePpm: BigInt(baseSellFeePpm),
        buyFeePpm: BigInt(buyFeePpm),
        maxDynamicFeeWad: maxDynamicFeeWad ?? 0n,
        roundCloseRule:
          maxDynamicFeeWad === null ? "closeAboveOpen" : "closeAtOrAboveOpen",
        priceTiming: Number(priceTiming),
        routingPolicy: Number(routingPolicy),
        routerRegistry: lower(routerRegistry),
        excludeBuybackFromRewards,
        rewardExcludedBuyer: lower(rewardExcludedBuyer),
        currentRound: round === null ? null : roundOf(round),
        sqrtPriceX96: BigInt(slot0) & ((1n << 160n) - 1n),
        wallet,
      });
    },

    async readWalletRound(request) {
      const block = await client.getBlock({ blockTag: "latest" });
      const at = block.number;
      const hook = lower(request.hook);
      const wallet = lower(request.wallet);
      const [round, weight, hasClaimed, claimable] = await Promise.all([
        hookRead<unknown>(hook, "rounds", at, [request.roundId]),
        hookRead<bigint>(hook, "buyWeight", at, [request.roundId, wallet]),
        hookRead<boolean>(hook, "hasClaimed", at, [request.roundId, wallet]),
        hookRead<bigint>(hook, "claimable", at, [request.roundId, wallet]),
      ]);
      return Object.freeze({
        blockNumber: at,
        blockHash: lower(block.hash),
        round: roundOf(round),
        weight,
        hasClaimed,
        claimable,
      });
    },

    async simulateSwap(call) {
      const stateOverride = await overrideFor(call);
      if (stateOverride === "unsupported") {
        return { status: "override_unsupported" };
      }
      try {
        const result = await client.call({
          account: call.from as Address,
          to: lower(call.router) as Address,
          data: call.data as Hex,
          blockNumber: call.blockNumber,
          ...(stateOverride === undefined ? {} : { stateOverride }),
        });
        const data = result.data ?? "0x";
        if (data.length < 130) return { status: "reverted", errorName: null };
        const [amountSpent, amountReceived] = decodeFunctionResult({
          abi: loopRouterAbi,
          functionName: "swapExactInput",
          data,
        });
        return { status: "ok", amountSpent, amountReceived };
      } catch (error) {
        const data = revertData(error);
        if (data === null) {
          if (
            error instanceof BaseError &&
            /revert/iu.test(error.shortMessage)
          ) {
            return { status: "reverted", errorName: null };
          }
          throw error;
        }
        return {
          status: "reverted",
          errorName: launch2DynamicErrorName(data),
        };
      }
    },

    async simulateClaim(request) {
      try {
        const result = await client.call({
          account: lower(request.wallet) as Address,
          to: lower(request.hook) as Address,
          data: encodeFunctionData({
            abi: loopDynamicHookAbi,
            functionName: "claim",
            args: [request.roundId],
          }),
          blockNumber: request.blockNumber,
        });
        const data = result.data ?? "0x";
        if (data.length < 66) return { status: "reverted", errorName: null };
        return { status: "ok", amount: BigInt(data.slice(0, 66)) };
      } catch (error) {
        const data = revertData(error);
        if (data === null) {
          if (
            error instanceof BaseError &&
            /revert/iu.test(error.shortMessage)
          ) {
            return { status: "reverted", errorName: null };
          }
          throw error;
        }
        return {
          status: "reverted",
          errorName: launch2DynamicErrorName(data),
        };
      }
    },

    async estimateGas(call) {
      // Decision 0153: the call target (the instance's LoopRouter) is the
      // spender the allowance override names.
      const stateOverride = await overrideFor({
        from: call.from,
        router: call.to,
        override: call.override,
        neutralHook: null,
      });
      if (stateOverride === "unsupported") return null;
      try {
        return await client.estimateGas({
          account: call.from as Address,
          to: call.to as Address,
          data: call.data as Hex,
          ...(stateOverride === undefined ? {} : { stateOverride }),
        });
      } catch {
        return null;
      }
    },
  });
}
