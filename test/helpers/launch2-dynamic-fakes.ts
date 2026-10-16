import { decodeFunctionData } from "viem";

import { launch2DynamicSellExtraFee } from "../../src/features/launch2/launch2-dynamic.js";
import {
  launch2PoolId,
  launch2PoolKey,
} from "../../src/features/launch2/launch2-pool.js";
import type {
  Launch2DynamicChain,
  Launch2DynamicFactoryRouting,
  Launch2DynamicHookState,
  Launch2DynamicSwapCall,
  Launch2InstanceRecord,
  Launch2PoolRouterCheck,
} from "../../src/features/launch2/launch2-ports.js";
import { loopRouterAbi } from "../../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
import {
  graduatedInstance,
  launch2NowSeconds,
  launch2PoolManager,
  launch2PoolSqrtPriceX96,
  wad,
} from "./launch2-fakes.js";
import { memeUsd1 } from "./meme-service-fakes.js";

/**
 * Decision 0131 test doubles: a graduated LoopDynamic instance (registry
 * hook = 0, the Hook bound at graduation) and a LoopRouter / Hook reader
 * at a constant price of 1,600 MEME per USD1 (no impact). The buy fee is
 * `buyFeePpm` of the MEME output; a sell pays `baseSellFeePpm` plus
 * `min(dropWad, maxDynamicFeeWad)` of the rest (Decision 0144) unless the
 * call is "neutral".
 */

export const launch2LoopRouter = "0x7777777777777777777777777777777777777777";
export const launch2LoopRouterCodeHash = `0x${"ef".repeat(32)}`;
export const launch2DynamicHook = `0x${"c".repeat(36)}10c4`;
/**
 * Decision 0152: an S209 Hook (bits 0x10CC) — the fake takes its buy fee
 * from the USD1 input instead of the MEME output.
 */
export const launch2DynamicHookS209 = `0x${"c".repeat(36)}10cc`;
export const launch2RouterRegistry =
  "0x4444444444444444444444444444444444444444";
const zero = "0x0000000000000000000000000000000000000000";

/** Decision 0153: the current LoopDynamic Factory of the fixtures. */
export const launch2DynamicFactory =
  "0x5725000000000000000000000000000000005725";
export const launch2DynamicFactoryCodeHash = `0x${"5d".repeat(32)}`;
export const launch2HookDeploymentFactory =
  "0x4e62000000000000000000000000000000004e62";
/** Decision 0153: an older LoopDynamic Factory with its own router / registry. */
export const launch2LegacyDynamicFactory =
  "0xd05e000000000000000000000000000000008c4d";
export const launch2LegacyLoopRouter =
  "0x135c000000000000000000000000000000000135";
export const launch2LegacyRouterRegistry =
  "0x9bcd000000000000000000000000000000009bcd";

export const launch2DynamicEnv = Object.freeze({
  LAUNCH2_DYNAMIC_ROUTER_ADDRESS: launch2LoopRouter,
  LAUNCH2_DYNAMIC_ROUTER_CODE_HASH: launch2LoopRouterCodeHash,
});

/**
 * Decision 0153: the trusted LoopDynamic Factories (the fixture instance's
 * Factory is the current one). Spread into a test config's env.
 */
export const launch2DynamicFactoryEnv = Object.freeze({
  LAUNCH2_DYNAMIC_FACTORY_ADDRESS: launch2DynamicFactory,
  LAUNCH2_DYNAMIC_FACTORY_CODE_HASH: launch2DynamicFactoryCodeHash,
  LAUNCH2_LEGACY_FACTORIES: `v3:${launch2LegacyDynamicFactory}`,
});

export const launch2DefaultFactoryRoutings: Readonly<
  Record<string, Launch2DynamicFactoryRouting | null>
> = Object.freeze({
  [launch2DynamicFactory]: Object.freeze({
    router: launch2LoopRouter,
    routerRegistry: launch2RouterRegistry,
    hookDeploymentFactory: launch2HookDeploymentFactory,
  }),
  [launch2LegacyDynamicFactory]: Object.freeze({
    router: launch2LegacyLoopRouter,
    routerRegistry: launch2LegacyRouterRegistry,
    hookDeploymentFactory: "0x8613000000000000000000000000000000008613",
  }),
});

export function dynamicPoolIdFor(
  meme: string,
  hook: string = launch2DynamicHook,
): string {
  return launch2PoolId(launch2PoolKey({ meme, usd1: memeUsd1, hook }));
}

export function graduatedDynamicInstance(
  overrides: Partial<Launch2InstanceRecord> = {},
): Launch2InstanceRecord {
  const base = graduatedInstance();
  const poolId = dynamicPoolIdFor(base.addresses.meme);
  return {
    ...base,
    factoryAddress: launch2DynamicFactory,
    addresses: { ...base.addresses, hook: zero, priceRecorder: zero },
    poolHookKind: "loopDynamic",
    dynamicPool: { hook: launch2DynamicHook, poolId, boundBlock: "4000" },
    graduation: {
      ...(base.graduation as NonNullable<Launch2InstanceRecord["graduation"]>),
      poolId,
    },
    ...overrides,
  };
}

export interface FakeLaunch2DynamicState {
  routerCheck: Launch2PoolRouterCheck;
  failRead: boolean;
  hook: Partial<Launch2DynamicHookState>;
  /** The candle's drop (18 decimals) while armed. */
  dropWad: bigint;
  /** Decision 0144: the Hook's cap (0 = uncapped); the rate is min(drop, cap). */
  maxDynamicFeeWad: bigint;
  usd1Balance: bigint;
  memeBalance: bigint;
  walletWeight: bigint;
  swapRevert: string | null;
  claim:
    | { readonly status: "ok"; readonly amount: bigint }
    | { readonly status: "reverted"; readonly errorName: string | null };
  swaps: Launch2DynamicSwapCall[];
  claims: { roundId: bigint; wallet: string }[];
  /** Decision 0153: each Factory's routing (absent key = reverts → null). */
  factoryRoutings: Record<string, Launch2DynamicFactoryRouting | null>;
  /** Decision 0153: `factory.loopHook(launchId)` (any Factory / launch). */
  factoryHook: string | null;
  failFactoryRead: boolean;
  /** Decision 0153: the Factories whose routing was read (cache checks). */
  factoryReads: string[];
  factoryHookReads: string[];
  /** Decision 0153: the routers `verifyRouter` was asked about. */
  routerChecks: string[];
}

export function defaultDynamicState(
  overrides: Partial<FakeLaunch2DynamicState> = {},
): FakeLaunch2DynamicState {
  return {
    routerCheck: { status: "ok", poolManager: launch2PoolManager },
    failRead: false,
    hook: {},
    dropWad: 3n * 10n ** 17n,
    maxDynamicFeeWad: 0n,
    usd1Balance: 1_000n * wad,
    memeBalance: 2_000_000n * wad,
    walletWeight: 25n * wad,
    swapRevert: null,
    claim: { status: "ok", amount: 12n * wad },
    swaps: [],
    claims: [],
    factoryRoutings: { ...launch2DefaultFactoryRoutings },
    factoryHook: launch2DynamicHook,
    failFactoryRead: false,
    factoryReads: [],
    factoryHookReads: [],
    routerChecks: [],
    ...overrides,
  };
}

const ppm = 1_000_000n;

export function createFakeLaunch2DynamicChain(
  state: FakeLaunch2DynamicState,
): Launch2DynamicChain {
  function hookState(meme: string, wallet: string | null) {
    const armed = state.hook.armed ?? true;
    const memeIsCurrency0 = BigInt(meme) < BigInt(memeUsd1);
    const result: Launch2DynamicHookState = {
      blockNumber: 6_000n,
      blockHash: `0x${"78".repeat(32)}`,
      blockTimestamp: launch2NowSeconds,
      manager: launch2PoolManager,
      trustedRouter: launch2LoopRouter,
      meme: meme.toLowerCase(),
      quote: memeUsd1,
      memeIsCurrency0,
      poolId: dynamicPoolIdFor(meme),
      initialized: true,
      armed,
      // The current candle: no roll pending.
      candleId: launch2NowSeconds / 300n,
      candleOpenSqrtPriceX96: launch2PoolSqrtPriceX96,
      lastSqrtPriceX96: launch2PoolSqrtPriceX96,
      currentRoundId: 3n,
      carry: 40n * wad,
      reservedRewards: 10n * wad,
      currentDropWad: armed ? state.dropWad : 0n,
      baseSellFeePpm: 20_000n,
      buyFeePpm: 20_000n,
      maxDynamicFeeWad: state.maxDynamicFeeWad,
      roundCloseRule: "closeAtOrAboveOpen",
      priceTiming: 1,
      routingPolicy: 1,
      routerRegistry: launch2RouterRegistry,
      excludeBuybackFromRewards: true,
      rewardExcludedBuyer: "0x3333333333333333333333333333333333333333",
      currentRound: {
        startCandle: launch2NowSeconds / 300n - 2n,
        endCandle: 0n,
        extraFees: 5n * wad,
        totalBuyWeight: 100n * wad,
        allocation: 0n,
        claimed: 0n,
        closed: false,
      },
      sqrtPriceX96: launch2PoolSqrtPriceX96,
      wallet:
        wallet === null
          ? null
          : {
              address: wallet.toLowerCase(),
              currentRoundWeight: state.walletWeight,
              usd1Balance: state.usd1Balance,
              memeBalance: state.memeBalance,
            },
      ...state.hook,
    };
    return result;
  }
  const fixtureMeme = `0x${"a".repeat(36)}6666`;
  return {
    router: launch2LoopRouter,
    verifyRouter: (router = launch2LoopRouter) => {
      state.routerChecks.push(router.toLowerCase());
      return Promise.resolve(state.routerCheck);
    },
    readFactoryRouting: (factory) => {
      state.factoryReads.push(factory.toLowerCase());
      if (state.failFactoryRead) {
        return Promise.reject(new Error("rpc down"));
      }
      return Promise.resolve(
        state.factoryRoutings[factory.toLowerCase()] ?? null,
      );
    },
    readFactoryHook: (input) => {
      state.factoryHookReads.push(input.factory.toLowerCase());
      return Promise.resolve(state.factoryHook);
    },
    readHookState: (input) => {
      if (state.failRead) return Promise.reject(new Error("rpc down"));
      return Promise.resolve(hookState(fixtureMeme, input.wallet));
    },
    readWalletRound: () => Promise.reject(new Error("unused")),
    simulateSwap: (call) => {
      state.swaps.push(call);
      if (state.swapRevert !== null) {
        return Promise.resolve({
          status: "reverted",
          errorName: state.swapRevert,
        });
      }
      const decoded = decodeFunctionData({
        abi: loopRouterAbi,
        data: call.data as `0x${string}`,
      });
      const args = decoded.args as readonly [
        { currency0: string; currency1: string; hooks: string },
        boolean,
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      const zeroForOne = args[1];
      const amountIn = args[2];
      const usd1First = args[0].currency0.toLowerCase() === memeUsd1;
      const buy = usd1First ? zeroForOne : !zeroForOne;
      if (buy && (BigInt(args[0].hooks) & 0x3fffn) === 0x10ccn) {
        // S209: floor(amountIn × 2 %) stays in the Hook, the rest swaps.
        const fee = (amountIn * 20_000n) / ppm;
        return Promise.resolve({
          status: "ok",
          amountSpent: amountIn,
          amountReceived: (amountIn - fee) * 1_600n,
        });
      }
      if (buy) {
        const gross = amountIn * 1_600n;
        const fee = (gross * 20_000n) / ppm;
        return Promise.resolve({
          status: "ok",
          amountSpent: amountIn,
          amountReceived: gross - fee,
        });
      }
      const gross = amountIn / 1_600n;
      const base = (gross * 20_000n) / ppm;
      const armed = state.hook.armed ?? true;
      const extra =
        call.neutralHook !== null || !armed
          ? 0n
          : launch2DynamicSellExtraFee({
              gross,
              baseFee: base,
              dropWad: state.dropWad,
              maxDynamicFeeWad: state.maxDynamicFeeWad,
            });
      return Promise.resolve({
        status: "ok",
        amountSpent: amountIn,
        amountReceived: gross - base - extra,
      });
    },
    simulateClaim: (input) => {
      state.claims.push({ roundId: input.roundId, wallet: input.wallet });
      return Promise.resolve(state.claim);
    },
    estimateGas: () => Promise.resolve(200_000n),
  };
}
