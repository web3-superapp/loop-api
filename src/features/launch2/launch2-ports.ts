import type {
  Launch2MemeCoverageFacts,
  Launch2MemeCoverageVerdict,
} from "./launch2-meme-coverage.js";
import type {
  Launch2HoldReason,
  Launch2IntentKind,
  Launch2Stage,
} from "./launch2-contract.js";
import type { Launch2CurveState } from "./launch2-curve-math.js";
import type { Launch2PoolHookKind } from "./launch2-dynamic.js";
import type { Launch2FactoryGeneration } from "./launch2-generation.js";

/**
 * Decision 0114: the boundaries of the launch2 read model — the chain
 * reader (an `src/integrations/launch2` adapter over the launch slot RPC)
 * and the PostgreSQL repository. Amounts and block numbers cross as
 * decimal strings; addresses and hashes are lower-case.
 */

/**
 * Decision 0122: `buybackExecutorV2` is the price-protected executor of a
 * v2-generation instance (other `BuybackCompleted` / `quoteNextOrder`
 * shapes); `buybackExecutor` is the current generation's.
 */
export type Launch2ContractRole =
  | "factory"
  | "gate"
  | "nft"
  | "snapshots"
  | "curve"
  | "buybackExecutor"
  | "buybackExecutorV2"
  /** Decision 0125: the MEME ERC-20 itself (`Transfer` only). */
  | "meme"
  /** Decision 0124: the v4 PoolManager (official-pool `Swap` logs only). */
  | "poolManager"
  /**
   * Decision 0126: `OfficialPoolRouter` (its own `Swap(poolId, payer,
   * recipient, …)`, decoded as `RouterSwap`).
   */
  | "poolRouter"
  /**
   * Decision 0131: a LoopDynamic instance's graduation adapter
   * (`LoopHookBound(hook, poolId)` only).
   */
  | "dynamicGraduationAdapter"
  /** Decision 0131: the per-project `LoopDynamicHook` (rounds, fees, claims). */
  | "dynamicHook"
  /**
   * Decision 0137: the instance's `NftEscrow` (`RefundClaimed` only) — in
   * the role map only for instances whose Factory has the S175 exit paths.
   */
  | "escrow";

export const launch2EventNames = Object.freeze([
  "LaunchDeployed",
  "LaunchActivated",
  "NftMinted",
  "Transfer",
  "SnapshotPublished",
  "PublicRoundOpenedWithoutHolders",
  /** Decision 0137 (S175 Factories): the snapshot-timeout opening. */
  "PublicRoundOpenedAfterTimeout",
  "CurveBought",
  "CurveSold",
  "Graduated",
  "BuybackCompleted",
  "BuybackPausedEvent",
  "BuybackResumed",
  "Swap",
  /** Decision 0126: the router's `Swap` event (other topic0 than the PoolManager's). */
  "RouterSwap",
  // Decision 0131: LoopDynamic (graduation adapter + per-project Hook).
  "LoopHookBound",
  "SellFeeCharged",
  "BuyFeeCharged",
  "CandleClosed",
  "EmptyCandlesSkipped",
  "RoundActivated",
  "RoundClosed",
  "BuyCredited",
  "BuyNotCredited",
  "RewardClaimed",
  /** Decision 0137 (S175 Factories): `NftEscrow.RefundClaimed`. */
  "RefundClaimed",
] as const);

export type Launch2EventName = (typeof launch2EventNames)[number];

/** One decoded log (args as lower-case strings / decimal strings). */
export interface Launch2DecodedLog {
  readonly contractAddress: string;
  readonly eventName: Launch2EventName;
  readonly args: Readonly<Record<string, string>>;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

export interface Launch2ChainHead {
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly timestamp: bigint;
}

export interface Launch2ViewerChainState {
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly curve: Launch2CurveState;
  /** `cumulativeBought(wallet)`; 0 when no wallet was asked. */
  readonly cumulativeBought: bigint;
  /** `ProjectNFT.mintedByAddress(wallet)`; false when no wallet was asked. */
  readonly nftMinted: boolean;
  readonly nftTotalMinted: bigint;
  readonly snapshotRootPublishedAt: bigint;
  /** `CurveEngine.usd1()` (the Factory's USD1). */
  readonly usd1: string;
  /** Wallet balances at the same block; null when no wallet was asked. */
  readonly usd1Balance: bigint | null;
  readonly memeBalance: bigint | null;
}

export interface Launch2BuybackChainState {
  /** Timestamp of the block every value was read at. */
  readonly blockTimestamp: bigint;
  readonly paused: boolean;
  readonly lastSuccessfulAt: bigint;
  readonly availableBudget: bigint;
  readonly totalRecorded: bigint;
  readonly totalSpent: bigint;
  /**
   * `quoteNextOrder().amountIn`; null when the read reverted (a v2
   * instance whose price recorder is not ready).
   */
  readonly nextOrderAmountIn: bigint | null;
  /**
   * Decision 0122, v3: `quoteNextOrder().executable` — every precondition
   * of `execute()` before the swap holds (not paused, interval elapsed,
   * graduated, budget > 0, locked-principal guard). v2: derived — true
   * when the price protection would not refuse (`minMemeOut > 0`); null
   * when the read reverted.
   */
  readonly nextOrderExecutable: boolean | null;
}

export interface Launch2SnapshotPublication {
  readonly signatures: readonly string[];
}

/** Decision 0137: one token's `NftEscrow.refundQuote` / `refunded` / owner. */
export interface Launch2NftRefundQuote {
  readonly tokenId: string;
  /** `ProjectNFT.ownerOf(tokenId)`; null when the token does not exist. */
  readonly owner: string | null;
  readonly refunded: boolean;
  readonly claimable: boolean;
  /** Raw USD1 (18 decimals) `claimRefund` would pay now. */
  readonly amount: bigint;
  /** `refundOpensAt()` (Unix seconds). */
  readonly opensAt: bigint;
}

/** Decision 0137: escrow / curve / NFT facts of a refund at one block. */
export interface Launch2NftRefundState {
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly blockTimestamp: bigint;
  /** `CurveEngine.graduated()` (the escrow reads the MEME's flag; same fact). */
  readonly graduated: boolean;
  /** `CurveEngine.usd1()` (the Factory's USD1). */
  readonly usd1: string;
  readonly refundOpensAt: bigint;
  readonly tokens: readonly Launch2NftRefundQuote[];
}

export interface Launch2Chain {
  /** Lane-facing: the node must be chain 97 (else unavailable). */
  verifyChain(): Promise<"ok" | "wrong_chain">;
  getHead(): Promise<Launch2ChainHead>;
  getBlock(
    blockNumber: bigint,
  ): Promise<{ readonly hash: string; readonly timestamp: bigint } | null>;
  getLogs(input: {
    readonly roles: ReadonlyMap<string, Launch2ContractRole>;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
    /**
     * Decision 0124: PoolManager `Swap` logs of these pool ids only
     * (PoolManager address → pool ids; topic-filtered, batched like the
     * address filter). Decoded with the `poolManager` role.
     */
    readonly poolSwaps?: ReadonlyMap<string, readonly string[]>;
    /**
     * Decision 0126: `OfficialPoolRouter.Swap` logs of these pool ids
     * (topic1, batched like the address filter); decoded as `RouterSwap`
     * with the `poolRouter` role.
     */
    readonly routerSwaps?: {
      readonly router: string;
      readonly poolIds: readonly string[];
    };
    /**
     * Decision 0129 §2: ERC-20 mints that must be in the answer (a MEME's
     * `Transfer` from the zero address at its instance's deploy block,
     * for every deploy block inside the range). An answer without one is
     * untrusted (a public endpoint that silently returns `[]` for old
     * blocks): the reader asks the next endpoint. Decision 0132: when no
     * endpoint has every anchor it keeps the answer holding the most and
     * names the tokens still missing in `untrustedTokens` (per instance,
     * never a refusal of the whole range).
     */
    readonly mintAnchors?: readonly {
      readonly token: string;
      readonly blockNumber: bigint;
    }[];
  }): Promise<{
    readonly logs: readonly Launch2DecodedLog[];
    /** A tracked address's log with a topic its role does not know. */
    readonly ignored: number;
    /**
     * Decision 0135: logs of addresses outside the tracked set, skipped
     * before decoding (absent = 0).
     */
    readonly skippedForeign?: number;
    /** Decision 0132: anchor tokens no endpoint answered (lower-case). */
    readonly untrustedTokens?: readonly string[];
  }>;
  /**
   * Decision 0132 (lane): `balanceOf(address)` of `token` for each address
   * and its `totalSupply()`, all at `blockNumber` (raw integer strings).
   * Asks the endpoints in order; throws `Launch2ChainRefusedError`
   * `LAUNCH2_RPC_STATE_UNAVAILABLE` when none serves that block's state.
   * Absent: the instance's segments stay unverified (fail closed).
   */
  readMemeBalances?(input: {
    readonly token: string;
    readonly addresses: readonly string[];
    readonly blockNumber: bigint;
  }): Promise<{
    readonly balances: Readonly<Record<string, string>>;
    readonly totalSupply: string;
  }>;
  /**
   * Decision 0132 (lane): `token`'s `Transfer` logs over the range from
   * every endpoint separately (an endpoint that fails is skipped), decoded
   * like the `meme` role — the second chance of a segment whose balances
   * did not reconcile.
   */
  readMemeTransferAlternatives?(input: {
    readonly token: string;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }): Promise<readonly (readonly Launch2DecodedLog[])[]>;
  /** `publishSnapshot` signatures from the publishing transaction's input. */
  readSnapshotPublication(
    transactionHash: string,
  ): Promise<Launch2SnapshotPublication | null>;
  /** Recovers the EIP-712 signer of `SnapshotRegistry.snapshotDigest`. */
  recoverSnapshotSigners(input: {
    readonly snapshots: string;
    readonly launchId: string;
    readonly nft: string;
    readonly cutoffBlock: bigint;
    readonly cutoffBlockHash: string;
    readonly dataHash: string;
    readonly root: string;
    readonly signatures: readonly string[];
  }): Promise<readonly string[]>;
  /** Route-facing: curve + NFT facts (and a wallet's) at one block. */
  readViewerState(input: {
    readonly meme: string;
    readonly curve: string;
    readonly gate: string;
    readonly nft: string;
    readonly snapshots: string;
    readonly wallet: string | null;
  }): Promise<Launch2ViewerChainState>;
  /**
   * Decision 0126 (route-facing): the wallet's MEME and instance-USD1
   * (`CurveEngine.usd1()`) balances at one block.
   */
  readWalletBalances(input: {
    readonly curve: string;
    readonly meme: string;
    readonly wallet: string;
  }): Promise<{
    readonly blockNumber: bigint;
    readonly memeBalance: bigint;
    readonly usd1Balance: bigint;
  }>;
  readBuybackState(input: {
    readonly buybackExecutor: string;
    readonly escrow: string;
    /** Decision 0122: selects the executor ABI. */
    readonly generation: Launch2FactoryGeneration;
  }): Promise<Launch2BuybackChainState>;
  /**
   * Decision 0124 (lane): the hook's immutable `poolManager()` and
   * `currency0()` — where the official pool's Swap logs come from and which
   * side of them is MEME.
   */
  readHookPool(hook: string): Promise<{
    readonly poolManager: string;
    readonly currency0: string;
  }>;
  /**
   * Decision 0131 (lane): a `LoopDynamicHook`'s immutable `manager()` and
   * the pool's currency0 (`min(meme(), quote())`).
   */
  readDynamicHookPool(hook: string): Promise<{
    readonly poolManager: string;
    readonly currency0: string;
    /**
     * Decision 0132: the Hook's immutable `trustedRouter()` (the shared
     * LoopRouter). Absent from older readers: no swap is attributed.
     */
    readonly trustedRouter?: string;
  }>;
  /**
   * Decision 0132 (lane): `from` / `to` of these transactions (lower-case;
   * `to` null for a contract creation). A LoopDynamic pool swap is
   * attributed to `from` only when `to` is the Hook's trusted LoopRouter.
   * Absent: no LoopDynamic swap is attributed (fail closed).
   */
  readTransactionParties?(
    transactionHashes: readonly string[],
  ): Promise<
    ReadonlyMap<string, { readonly from: string; readonly to: string | null }>
  >;
  /**
   * Decision 0137: `LoopLaunchFactory.snapshotTimeout()` / `refundDelay()`;
   * null when the Factory has no exit paths (the call reverts or the
   * selector is missing — every pre-S175 Factory); throws on an RPC
   * failure. Absent: no Factory supports them (fail closed).
   */
  readExitTiming?(factory: string): Promise<{
    readonly snapshotTimeout: bigint;
    readonly refundDelay: bigint;
  } | null>;
  /**
   * Decision 0137 (route-facing): `refundQuote` / `refunded` / `ownerOf`
   * of each token plus `refundOpensAt`, the curve's `graduated` and `usd1`,
   * all at the latest block.
   */
  readNftRefunds?(input: {
    readonly escrow: string;
    readonly nft: string;
    readonly curve: string;
    readonly tokenIds: readonly bigint[];
  }): Promise<Launch2NftRefundState>;
}

// ---------------------------------------------------------------------------
// Decision 0131: the LoopDynamic reader (route-facing)
// ---------------------------------------------------------------------------

/** One reward round as `rounds(id)` returns it. */
export interface Launch2DynamicRoundState {
  readonly startCandle: bigint;
  readonly endCandle: bigint;
  readonly extraFees: bigint;
  readonly totalBuyWeight: bigint;
  readonly allocation: bigint;
  readonly claimed: bigint;
  readonly closed: boolean;
}

/** Hook, pool and (optionally) wallet facts at one block. */
export interface Launch2DynamicHookState {
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly blockTimestamp: bigint;
  readonly manager: string;
  readonly trustedRouter: string;
  readonly meme: string;
  readonly quote: string;
  readonly memeIsCurrency0: boolean;
  readonly poolId: string;
  readonly initialized: boolean;
  readonly armed: boolean;
  readonly candleId: bigint;
  readonly candleOpenSqrtPriceX96: bigint;
  readonly lastSqrtPriceX96: bigint;
  readonly currentRoundId: bigint;
  readonly carry: bigint;
  readonly reservedRewards: bigint;
  readonly currentDropWad: bigint;
  readonly baseSellFeePpm: bigint;
  /** S165: buy fee in ppm of the MEME output. */
  readonly buyFeePpm: bigint;
  /** 0 PRE_SWAP, 1 POST_SWAP. */
  readonly priceTiming: number;
  /** 0 LoopRouterOnly, 1 Open. */
  readonly routingPolicy: number;
  readonly routerRegistry: string;
  readonly excludeBuybackFromRewards: boolean;
  readonly rewardExcludedBuyer: string;
  /** `rounds(currentRoundId)`; null while no round ever activated. */
  readonly currentRound: Launch2DynamicRoundState | null;
  /** PoolManager slot0 of the Hook's pool. */
  readonly sqrtPriceX96: bigint;
  /** Present when a wallet was asked about. */
  readonly wallet: {
    readonly address: string;
    readonly currentRoundWeight: bigint;
    readonly usd1Balance: bigint;
    readonly memeBalance: bigint;
  } | null;
}

export type Launch2DynamicSimulation =
  | {
      readonly status: "ok";
      readonly amountSpent: bigint;
      readonly amountReceived: bigint;
    }
  | { readonly status: "reverted"; readonly errorName: string | null }
  | { readonly status: "override_unsupported" };

export interface Launch2DynamicSwapCall {
  readonly blockNumber: bigint;
  readonly from: string;
  readonly data: string;
  /** In-call override of the input token (`balance` null = real balance). */
  readonly override: {
    readonly token: string;
    readonly balance: bigint | null;
    readonly allowance: bigint;
  } | null;
  /**
   * The Hook to simulate as "initialized, not armed, no candle to roll"
   * (base fee only; Decision 0131 sell split). Null = the real Hook state.
   */
  readonly neutralHook: string | null;
}

export interface Launch2DynamicChain {
  /** `LAUNCH2_DYNAMIC_ROUTER_ADDRESS` (LoopRouter, lower-case). */
  readonly router: string;
  /** Runtime code hash = `LAUNCH2_DYNAMIC_ROUTER_CODE_HASH`, and `manager()`. */
  verifyRouter(): Promise<Launch2PoolRouterCheck>;
  readHookState(input: {
    readonly hook: string;
    readonly wallet: string | null;
  }): Promise<Launch2DynamicHookState>;
  /** `rounds(id)`, `buyWeight`, `hasClaimed`, `claimable` at one block. */
  readWalletRound(input: {
    readonly hook: string;
    readonly roundId: bigint;
    readonly wallet: string;
  }): Promise<{
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly round: Launch2DynamicRoundState;
    readonly weight: bigint;
    readonly hasClaimed: boolean;
    readonly claimable: bigint;
  }>;
  /** eth_call of `LoopRouter.swapExactInput`. */
  simulateSwap(call: Launch2DynamicSwapCall): Promise<Launch2DynamicSimulation>;
  /** eth_call of `hook.claim(roundId)` from the wallet: the amount. */
  simulateClaim(input: {
    readonly blockNumber: bigint;
    readonly hook: string;
    readonly roundId: bigint;
    readonly wallet: string;
  }): Promise<
    | { readonly status: "ok"; readonly amount: bigint }
    | { readonly status: "reverted"; readonly errorName: string | null }
  >;
  /** eth_estimateGas (swap: with the call's override; null when refused). */
  estimateGas(call: {
    readonly from: string;
    readonly to: string;
    readonly data: string;
    readonly override: Launch2DynamicSwapCall["override"];
  }): Promise<bigint | null>;
}

// ---------------------------------------------------------------------------
// Decision 0124: the official-pool router reader (route-facing)
// ---------------------------------------------------------------------------

export type Launch2PoolRouterCheck =
  | { readonly status: "ok"; readonly poolManager: string }
  | { readonly status: "unavailable"; readonly reasonCode: string };

/** Pool, hook and wallet facts at one block of the launch slot. */
export interface Launch2PoolChainState {
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly blockTimestamp: bigint;
  /** `OfficialTaxHook.poolManager()` / `currency0()` / `currency1()`. */
  readonly hookPoolManager: string;
  readonly currency0: string;
  readonly currency1: string;
  /** `CurveEngine.usd1()` of the instance (Decision 0117 trust anchor). */
  readonly curveUsd1: string;
  /** PoolManager slot0 of the pool id asked about. */
  readonly sqrtPriceX96: bigint;
  readonly usd1Balance: bigint;
  readonly memeBalance: bigint;
  /** `allowance(wallet, router)` of each token. */
  readonly usd1Allowance: bigint;
  readonly memeAllowance: bigint;
}

export type Launch2PoolSimulation =
  | { readonly status: "ok"; readonly returned: bigint }
  | {
      readonly status: "reverted";
      /** Decoded custom error name (router / hook / PoolManager / ERC20). */
      readonly errorName: string | null;
    }
  /** The node refused the state override or the token layout is unknown. */
  | { readonly status: "override_unsupported" };

export interface Launch2PoolCall {
  readonly blockNumber: bigint;
  readonly from: string;
  readonly data: string;
  /**
   * In-call state override of the input token for `from`: `balance` (null =
   * keep the real balance) and the allowance to the router.
   */
  readonly override: {
    readonly token: string;
    readonly balance: bigint | null;
    readonly allowance: bigint;
  } | null;
}

export interface Launch2PoolChain {
  /** `LAUNCH2_POOL_ROUTER_ADDRESS` (lower-case). */
  readonly router: string;
  /**
   * The router's runtime code hash equals `LAUNCH2_POOL_ROUTER_CODE_HASH`
   * (and its `poolManager()`); cached once verified, re-read after a
   * failure.
   */
  verifyRouter(): Promise<Launch2PoolRouterCheck>;
  readPoolState(input: {
    readonly hook: string;
    readonly curve: string;
    readonly meme: string;
    readonly poolId: string;
    readonly wallet: string;
  }): Promise<Launch2PoolChainState>;
  /** eth_call of a router call; returns the uint256 the function returns. */
  simulate(call: Launch2PoolCall): Promise<Launch2PoolSimulation>;
  /** eth_estimateGas of the same call (null when the node refuses). */
  estimateGas(call: Launch2PoolCall): Promise<bigint | null>;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface Launch2InstanceAddresses {
  readonly meme: string;
  readonly hook: string;
  readonly nft: string;
  readonly curve: string;
  readonly gate: string;
  readonly escrow: string;
  readonly snapshots: string;
  readonly graduationAdapter: string;
  readonly buybackAdapter: string;
  readonly priceRecorder: string;
  readonly buybackExecutor: string;
}

export interface Launch2SnapshotRecord {
  readonly root: string;
  readonly dataHash: string | null;
  readonly cutoffBlock: string;
  readonly cutoffBlockHash: string | null;
  readonly publishedAt: string;
  readonly publishedBlock: string | null;
  readonly transactionHash: string | null;
  readonly verification: "verified" | "mismatch" | null;
  readonly memberCount: number | null;
  readonly signers: readonly string[] | null;
}

export interface Launch2InstanceRecord {
  readonly instanceId: string;
  readonly jobId: string;
  readonly projectId: string;
  readonly configVersion: number;
  readonly ownerUserId: string;
  readonly chainId: string;
  readonly factoryAddress: string;
  /** Decision 0122: the deploying Factory's bytecode generation. */
  readonly generation: Launch2FactoryGeneration;
  readonly launchId: string;
  readonly configHash: string;
  readonly projectOwner: string;
  readonly name: string;
  readonly ticker: string;
  readonly logoUrl: string | null;
  readonly addresses: Launch2InstanceAddresses;
  readonly buybackRecipient: string;
  readonly nftSaleStart: string;
  /**
   * Decision 0119: the deployed `ProjectNFT.saleEnd()` (ISO), verified at
   * deployment; 1 hour after the start on the testnet Factory, 7 days on
   * mainnet. Never derived from a constant.
   */
  readonly nftSaleEnd: string;
  readonly deployBlockNumber: string;
  readonly activationBlockNumber: string | null;
  readonly deployedEventSeen: boolean;
  readonly activatedAt: string | null;
  readonly holdReason: Launch2HoldReason | null;
  readonly stage: Launch2Stage;
  readonly nextChangeAt: string | null;
  readonly nftMintedCount: string;
  readonly soldSupply: string;
  readonly reserveUsd1: string;
  readonly priceE18: string;
  readonly tradeCount: string;
  readonly buyVolumeUsd1: string;
  readonly taxUsd1: string;
  readonly snapshot: Launch2SnapshotRecord | null;
  /** Decision 0118: the latest server-side publication attempt, if any. */
  readonly snapshotPublication: {
    readonly status:
      "pending" | "broadcast" | "confirmed" | "failed" | "mismatch";
    readonly txHash: string | null;
    readonly cutoffBlock: string;
    readonly memberCount: number;
  } | null;
  /**
   * Decision 0120: the publisher's no-holder closure (the NFT sale ended
   * with `totalMinted() = 0` at the confirmed cutoff); stage
   * `closed_no_holders`.
   */
  readonly noHoldersClosure: {
    readonly cutoffBlock: string;
    readonly closedAt: string;
  } | null;
  /**
   * Decision 0122 (v3): the indexed `PublicRoundOpenedWithoutHolders` — the
   * sale ended with no mint and the public round opened at `openedAt`
   * without a snapshot (stage `public`).
   */
  readonly openedWithoutHolders: {
    readonly openedAt: string;
    readonly blockNumber: string;
    readonly transactionHash: string;
  } | null;
  /**
   * Decision 0137 (S175 Factories): the indexed
   * `PublicRoundOpenedAfterTimeout` — public round from `openedAt`, no
   * early round. Absent / null = not opened that way.
   */
  readonly openedAfterTimeout?: {
    readonly openedAt: string;
    readonly blockNumber: string;
    readonly transactionHash: string;
    readonly totalMinted: string;
  } | null;
  /** Decision 0137: distinct token ids with an indexed `RefundClaimed`. */
  readonly nftRefundedCount?: string;
  readonly graduation: {
    readonly graduatedAt: string;
    readonly blockNumber: string | null;
    readonly transactionHash: string | null;
    readonly poolId: string;
  } | null;
  readonly buyback: {
    readonly paused: boolean;
    readonly count: string;
    readonly usd1: string;
    readonly meme: string;
    readonly lastAt: string | null;
  };
  /**
   * Decision 0124: the official pool's indexed swaps (all callers). Raw
   * integer strings; `volume24hUsd1` is computed at read time.
   */
  readonly pool: {
    readonly tradeCount: string;
    readonly buyCount: string;
    readonly sellCount: string;
    readonly buyVolumeUsd1: string;
    readonly sellVolumeUsd1: string;
    readonly volume24hUsd1: string;
    readonly taxUsd1: string;
    readonly taxMeme: string;
    readonly lastPriceE18: string | null;
    readonly lastTradeAt: string | null;
    /**
     * Decision 0127: the same counts without the swaps of the instance's
     * buyback adapter / executor (market trades only).
     */
    readonly userTradeCount: string;
    readonly userBuyVolumeUsd1: string;
    readonly userSellVolumeUsd1: string;
  };
  /**
   * Decision 0131: `officialTax` unless the registry row has no Hook
   * (LoopDynamic Factory). Absent = officialTax (pre-0131 fakes).
   */
  readonly poolHookKind?: Launch2PoolHookKind;
  /** Decision 0131: the indexed `LoopHookBound` of a LoopDynamic instance. */
  readonly dynamicPool?: {
    readonly hook: string;
    readonly poolId: string;
    readonly boundBlock: string;
  } | null;
  /** Decision 0121: the buyback keeper's newest attempt, if any. */
  readonly buybackKeeper: {
    readonly status:
      "rejected" | "pending" | "broadcast" | "confirmed" | "failed";
    readonly reasonCode: string | null;
    /** The decision time (latest refusal for a refreshed `rejected`). */
    readonly lastAttemptAt: string;
    readonly nextEligibleAt: string | null;
    /** The ledger row of the transaction exists (`confirmed` only). */
    readonly aligned: boolean;
  } | null;
  readonly registeredAt: string;
  readonly projectedAt: string;
}

export interface Launch2LaneEvent {
  readonly instanceId: string;
  readonly contractAddress: string;
  readonly eventName: Launch2EventName;
  readonly args: Readonly<Record<string, string>>;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  /** Unix seconds (block timestamp). */
  readonly at: string;
}

export interface Launch2Checkpoint {
  readonly lastBlockNumber: string;
  readonly lastBlockHash: string;
  readonly startedFromBlockNumber: string;
  readonly updatedAt: string;
}

export interface Launch2LaneInstance {
  readonly instanceId: string;
  readonly launchId: string;
  /** Decision 0122: selects the buyback executor ABI of the instance. */
  readonly generation: Launch2FactoryGeneration;
  readonly addresses: Launch2InstanceAddresses;
  readonly deployBlockNumber: string;
  readonly nftSaleStart: string;
  /**
   * Decision 0119: the deployed `ProjectNFT.saleEnd()` (ISO), verified at
   * deployment; 1 hour after the start on the testnet Factory, 7 days on
   * mainnet. Never derived from a constant.
   */
  readonly nftSaleEnd: string;
  readonly holdReason: Launch2HoldReason | null;
  readonly graduated: boolean;
  /** Decision 0124: `Graduated.officialPoolId` once indexed. */
  readonly officialPoolId: string | null;
  readonly snapshotPublishedAt: string | null;
  /** Decision 0120: a no-holder closure is recorded. */
  readonly closedNoHolders: boolean;
  /** Decision 0122: the indexed zero-holder public opening (ISO). */
  readonly openedWithoutHoldersAt: string | null;
  /** Decision 0137: the indexed snapshot-timeout opening (ISO). */
  readonly openedAfterTimeoutAt?: string | null;
  /**
   * Decision 0137: the deploying Factory (lower-case) — the exit-path
   * capability is probed per Factory. Absent: never probed (unsupported).
   */
  readonly factoryAddress?: string;
  readonly activatedAt: string | null;
  readonly stage: Launch2Stage;
  readonly nextChangeAt: string | null;
  /**
   * Decision 0125: the block the one-time MEME `Transfer` re-scan of this
   * instance must reach (null: the re-scan has not started yet, so the
   * lane rewinds to the deploy block). Absent when the repository does not
   * track the coverage (no re-scan is triggered).
   */
  readonly memeTransfersTargetBlock?: string | null;
  /**
   * Decision 0129 §2 / 0132: consecutive failed coverage checks (3 =
   * stalled, the lane leaves the instance to an operator). Absent when the
   * repository does not track the coverage (no balance check runs).
   */
  readonly memeTransfersCoverageFailures?: number;
  /** Decision 0126: `Graduated` block (null before graduation). */
  readonly graduationBlockNumber?: string | null;
  /**
   * Decision 0126: the block the one-time router-attribution re-scan of a
   * graduated instance must reach (null: not started — the lane rewinds to
   * the graduation block when the router is configured). Absent when the
   * repository does not track it.
   */
  readonly poolRouterTargetBlock?: string | null;
  /** Decision 0131: the indexed LoopDynamic Hook (null before graduation). */
  readonly dynamicHook?: string | null;
}

/** Decision 0131: one round of a wallet's LoopDynamic rewards (projection). */
export interface Launch2DynamicRewardRecord {
  readonly roundId: string;
  readonly hook: string;
  readonly closed: boolean;
  readonly startCandle: string;
  readonly endCandle: string | null;
  readonly carriedInUsd1: string;
  readonly extraFeesUsd1: string;
  readonly totalBuyWeightUsd1: string;
  readonly allocationUsd1: string | null;
  readonly weightUsd1: string;
  readonly claimedAmountUsd1: string | null;
  readonly claimTransactionHash: string | null;
  readonly claimedAt: string | null;
  readonly activatedAt: string;
  readonly closedAt: string | null;
}

/** Decision 0131: the projected round totals of one instance. */
export interface Launch2DynamicRoundSummary {
  readonly roundCount: number;
  readonly closedRoundCount: number;
  readonly allocatedUsd1: string;
  readonly claimedUsd1: string;
  readonly extraFeesUsd1: string;
  readonly baseSellFeesUsd1: string;
  readonly buyFeesMeme: string;
  readonly lastRound: {
    readonly roundId: string;
    readonly closed: boolean;
    readonly activatedAt: string;
    readonly closedAt: string | null;
  } | null;
}

/** Decision 0131: a reported `dynamic_claim` transaction. */
export interface Launch2DynamicClaimReportRecord {
  readonly intentId: string;
  readonly instanceId: string;
  readonly walletId: string;
  readonly walletAddress: string;
  readonly roundId: string;
  readonly transactionHash: string;
  readonly reportedAt: string;
}

/** Decision 0137: an indexed `NftEscrow.RefundClaimed`. */
export interface Launch2NftRefundRecord {
  readonly tokenId: string;
  readonly ownerAddress: string;
  readonly amountUsd1: string;
  readonly remainingRecordedUsd1: string;
  readonly transactionHash: string;
  readonly blockNumber: string;
  readonly refundedAt: string;
}

/** Decision 0137: a reported `nft_refund` transaction. */
export interface Launch2NftRefundReportRecord {
  readonly intentId: string;
  readonly instanceId: string;
  readonly walletId: string;
  readonly walletAddress: string;
  readonly tokenId: string;
  readonly transactionHash: string;
  readonly reportedAt: string;
}

/** Decision 0125: one MEME ERC-20 `Transfer` of a launch2 instance. */
export interface Launch2MemeTransferRecord {
  readonly instanceId: string;
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  /** Unix seconds (block timestamp). */
  readonly at: string;
}

export interface Launch2PositionRecord {
  readonly instanceId: string;
  readonly holderAddress: string;
  readonly nftMintedTokenId: string | null;
  readonly nftHeld: number;
  readonly curveBought: string;
  readonly curveSold: string;
  readonly cumulativeBought: string;
  readonly usd1Spent: string;
  readonly usd1Received: string;
  readonly taxUsd1: string;
  readonly buyCount: number;
  readonly sellCount: number;
  readonly snapshotMember: boolean;
  readonly lastActivityAt: string | null;
}

/** Decision 0126: one official-pool swap attributed to a wallet. */
export interface Launch2PoolTradeRecord {
  readonly poolTradeId: string;
  readonly side: "buy" | "sell";
  /** OfficialPoolRouter Swap amounts (raw). */
  readonly amountIn: string;
  readonly amountOut: string;
  /** PoolManager side (raw, output gross of the tax). */
  readonly usd1Amount: string;
  readonly memeAmount: string;
  readonly taxAmount: string;
  readonly taxToken: "usd1" | "meme";
  readonly priceE18: string;
  readonly recipientAddress: string;
  readonly tradedAt: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
}

/** Decision 0126: a wallet's attributed pool trades of one instance. */
export interface Launch2PoolTradeStats {
  readonly instanceId: string;
  readonly walletAddress: string;
  readonly count: string;
  readonly lastAt: string | null;
}

export interface Launch2BuybackRecord {
  readonly buybackId: string;
  readonly outcome: "executed" | "rejected";
  readonly reasonCode: string | null;
  readonly usd1Spent: string;
  readonly memeDelivered: string;
  /** Decision 0122: null for a v3 (no price protection) execution. */
  readonly minMemeOut: string | null;
  readonly referencePriceE18: string | null;
  readonly spotPriceE18: string | null;
  readonly executedAt: string;
  readonly transactionHash: string;
  readonly blockNumber: string;
}

export interface Launch2TradeRecord {
  readonly tradeId: string;
  readonly side: "buy" | "sell";
  readonly traderAddress: string;
  readonly memeAmount: string;
  readonly usd1Gross: string;
  readonly usd1Net: string;
  readonly taxUsd1: string;
  readonly refundUsd1: string;
  readonly cumulativeBought: string | null;
  readonly soldAfter: string | null;
  readonly tradedAt: string;
  readonly transactionHash: string;
  readonly blockNumber: string;
}

export interface Launch2SnapshotMemberRecord {
  readonly memberAddress: string;
  readonly leaf: string;
  readonly proof: readonly string[] | null;
  readonly nftBalance: number;
}

export interface CreateLaunch2IntentRecord {
  readonly intentId: string;
  readonly ownerUserId: string;
  readonly instanceId: string;
  readonly walletId: string;
  readonly walletAddress: string;
  readonly kind: Launch2IntentKind;
  readonly chainId: string;
  readonly contractAddress: string;
  readonly amountIn: string;
  readonly expectedOut: string;
  readonly minOut: string;
  readonly taxUsd1: string;
  readonly refundUsd1: string;
  readonly deadline: string;
  readonly snapshotBlockNumber: string;
  readonly snapshotBlockHash: string;
  readonly calldata: Readonly<Record<string, unknown>>;
  readonly unsignedTransaction: Readonly<Record<string, unknown>>;
  readonly approval: Readonly<Record<string, unknown>> | null;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly payloadDigest: string;
  readonly expiresAt: string;
}

export interface Launch2IntentRecord extends CreateLaunch2IntentRecord {
  readonly state: "prepared";
  readonly createdAt: string;
}

export interface Launch2CanaryAdmission {
  readonly since: string;
  admit(spentUsd: string): void;
}

export class Launch2RepositoryUnavailableError extends Error {
  readonly code = "launch2_repository_unavailable";

  constructor() {
    super("The launch2 repository is unavailable");
    this.name = "Launch2RepositoryUnavailableError";
  }
}

export class Launch2IdempotencyConflictError extends Error {
  readonly code = "launch2_idempotency_conflict";

  constructor() {
    super("The Idempotency-Key was used for a different request");
    this.name = "Launch2IdempotencyConflictError";
  }
}

export interface Launch2Repository {
  // --- Lane ---
  /**
   * Decision 0122: registers activated tasks of every listed Factory and
   * records that Factory's generation on the instance.
   */
  registerActivatedInstances(input: {
    readonly chainId: string;
    readonly factories: readonly {
      readonly address: string;
      readonly generation: Launch2FactoryGeneration;
    }[];
  }): Promise<readonly string[]>;
  listLaneInstances(chainId: string): Promise<readonly Launch2LaneInstance[]>;
  getCheckpoint(chainId: string): Promise<Launch2Checkpoint | null>;
  commitSegment(input: {
    readonly chainId: string;
    readonly events: readonly Launch2LaneEvent[];
    readonly checkpoint: {
      readonly lastBlockNumber: string;
      readonly lastBlockHash: string;
      readonly startedFromBlockNumber: string;
    };
    /** A reorg: facts at or above this block are marked removed first. */
    readonly rewindFromBlockNumber?: string;
    /** Blocks past the activation block before a missing activation is a hold. */
    readonly activationGraceBlocks: number;
    /** Decision 0125: MEME ERC-20 transfers of this segment. */
    readonly memeTransfers?: readonly Launch2MemeTransferRecord[];
    /**
     * Decision 0125: instances whose MEME re-scan starts with this segment
     * (from their deploy block); their coverage is complete once a
     * checkpoint reaches `targetBlockNumber`.
     */
    readonly memeTransferCoverage?: {
      readonly instanceIds: readonly string[];
      readonly targetBlockNumber: string;
    };
    /**
     * Decision 0126: instances whose router-attribution re-scan starts with
     * this segment (from their graduation block).
     */
    readonly poolRouterCoverage?: {
      readonly instanceIds: readonly string[];
      readonly targetBlockNumber: string;
    };
    /**
     * Decision 0132: instances this segment could not vouch for, applied
     * after `memeTransferCoverage` in the same transaction — every kind
     * un-marks `meme_transfers_complete_at`; `retry` records the failure
     * and clears the target (re-scan from the deploy block), `stalled`
     * records it and keeps the target, `unverified` changes nothing else.
     */
    readonly memeCoverageDegraded?: readonly {
      readonly instanceId: string;
      readonly kind: "retry" | "stalled" | "unverified";
      readonly failedAttempts: number;
    }[];
  }): Promise<{ readonly storedCount: number; readonly touched: number }>;
  /**
   * Decision 0132: an instance's indexed MEME ledger strictly below
   * `beforeBlockNumber` (non-removed transfers): Σ(in) − Σ(out) of each
   * address, and mints − burns. Absent: no balance check runs (a
   * repository that does not track coverage).
   */
  memeLedgerBalances?(input: {
    readonly chainId: string;
    readonly instanceId: string;
    readonly addresses: readonly string[];
    readonly beforeBlockNumber: string;
  }): Promise<{
    readonly balances: Readonly<Record<string, string>>;
    readonly supply: string;
  }>;
  /**
   * Decision 0129 §2: instances whose MEME re-scan reached its target
   * (target ≤ `throughBlockNumber`), not complete, with fewer than
   * `maxAttempts` failed checks, and the facts the coverage check needs.
   */
  listMemeCoverageChecks(input: {
    readonly chainId: string;
    readonly throughBlockNumber: string;
    readonly maxAttempts: number;
  }): Promise<readonly Launch2MemeCoverageFacts[]>;
  /**
   * Decision 0129 §2: complete marks `meme_transfers_complete_at`; retry
   * records the failure and clears the target (one more re-scan); stalled
   * records the failure and keeps the target (no automatic re-scan).
   */
  recordMemeCoverage(input: {
    readonly chainId: string;
    readonly verdicts: readonly Launch2MemeCoverageVerdict[];
  }): Promise<void>;
  listSnapshotsToVerify(chainId: string): Promise<
    readonly {
      readonly instanceId: string;
      readonly launchId: string;
      readonly nft: string;
      readonly snapshots: string;
      readonly root: string;
      readonly dataHash: string;
      readonly cutoffBlock: string;
      readonly cutoffBlockHash: string;
      readonly transactionHash: string;
    }[]
  >;
  nftHoldersAt(input: {
    readonly instanceId: string;
    readonly blockNumber: string;
  }): Promise<
    readonly { readonly address: string; readonly balance: number }[]
  >;
  recordSnapshotVerification(input: {
    readonly instanceId: string;
    readonly root: string;
    readonly verification: "verified" | "mismatch";
    readonly members: readonly Launch2SnapshotMemberRecord[];
    readonly signers: readonly string[] | null;
  }): Promise<void>;
  updateStages(
    updates: readonly {
      readonly instanceId: string;
      readonly stage: Launch2Stage;
      readonly nextChangeAt: string | null;
    }[],
  ): Promise<number>;
  // --- Reads ---
  listInstances(input: {
    readonly chainId: string;
    readonly stage: Launch2Stage | null;
    readonly after: {
      readonly activatedAt: string;
      readonly instanceId: string;
    } | null;
    readonly limit: number;
  }): Promise<readonly Launch2InstanceRecord[]>;
  getInstance(instanceId: string): Promise<Launch2InstanceRecord | null>;
  listPositions(input: {
    readonly holderAddresses: readonly string[];
    readonly instanceId: string | null;
  }): Promise<readonly Launch2PositionRecord[]>;
  getSnapshotMember(input: {
    readonly instanceId: string;
    readonly address: string;
  }): Promise<Launch2SnapshotMemberRecord | null>;
  listBuybacks(input: {
    readonly instanceId: string;
    readonly after: {
      readonly executedAt: string;
      readonly buybackId: string;
    } | null;
    readonly limit: number;
  }): Promise<readonly Launch2BuybackRecord[]>;
  listTrades(input: {
    readonly instanceId: string;
    readonly limit: number;
  }): Promise<readonly Launch2TradeRecord[]>;
  /** Decision 0126: one wallet's attributed pool swaps, newest first. */
  listPoolTrades(input: {
    readonly instanceId: string;
    readonly walletAddress: string;
    readonly limit: number;
  }): Promise<readonly Launch2PoolTradeRecord[]>;
  /**
   * Decision 0126: count / newest of the attributed pool swaps per
   * (instance, wallet) — every instance when `instanceId` is null; only
   * pairs with at least one trade are returned.
   */
  poolTradeStats(input: {
    readonly instanceId: string | null;
    readonly walletAddresses: readonly string[];
  }): Promise<readonly Launch2PoolTradeStats[]>;
  // --- Decision 0131: LoopDynamic ---
  dynamicRoundSummary(instanceId: string): Promise<Launch2DynamicRoundSummary>;
  /** Rounds in which the wallet has buy weight, newest first. */
  listDynamicRewards(input: {
    readonly instanceId: string;
    readonly walletAddress: string;
    readonly limit: number;
  }): Promise<readonly Launch2DynamicRewardRecord[]>;
  /** The caller's `dynamic_claim` intent (null when not theirs / not one). */
  getDynamicClaimIntent(input: {
    readonly intentId: string;
    readonly ownerUserId: string;
  }): Promise<Launch2IntentRecord | null>;
  /**
   * Records the hash once: `created`, `same` (re-report of the same hash),
   * or `conflict` (another hash already recorded).
   */
  recordDynamicClaimReport(
    input: Omit<Launch2DynamicClaimReportRecord, "reportedAt"> & {
      readonly ownerUserId: string;
    },
  ): Promise<{
    readonly outcome: "created" | "same" | "conflict";
    readonly report: Launch2DynamicClaimReportRecord;
  }>;
  /** The indexed `RewardClaimed` of that transaction for (round, buyer). */
  findDynamicClaim(input: {
    readonly instanceId: string;
    readonly transactionHash: string;
    readonly roundId: string;
    readonly buyer: string;
  }): Promise<{
    readonly amountUsd1: string;
    readonly blockNumber: string;
    readonly claimedAt: string;
  } | null>;
  // --- Decision 0137: escrow exit paths (absent = repository predates it) ---
  /**
   * Token ids whose latest non-removed NFT `Transfer` names this holder
   * (ascending, at most `limit`).
   */
  listHeldNftTokens?(input: {
    readonly instanceId: string;
    readonly holderAddress: string;
    readonly limit: number;
  }): Promise<readonly string[]>;
  /** Non-removed `RefundClaimed` of these tokens (empty list = all of them). */
  listNftRefunds?(input: {
    readonly instanceId: string;
    readonly tokenIds: readonly string[];
  }): Promise<readonly Launch2NftRefundRecord[]>;
  /** The caller's `nft_refund` intent (null when not theirs / not one). */
  getNftRefundIntent?(input: {
    readonly intentId: string;
    readonly ownerUserId: string;
  }): Promise<Launch2IntentRecord | null>;
  /** Records the hash once (`created` / `same` / `conflict`). */
  recordNftRefundReport?(
    input: Omit<Launch2NftRefundReportRecord, "reportedAt"> & {
      readonly ownerUserId: string;
    },
  ): Promise<{
    readonly outcome: "created" | "same" | "conflict";
    readonly report: Launch2NftRefundReportRecord;
  }>;
  // --- Intents ---
  createIntent(input: {
    readonly ownerUserId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
    readonly build: () => Promise<CreateLaunch2IntentRecord>;
    readonly canaryAdmission: (
      built: CreateLaunch2IntentRecord,
    ) => Launch2CanaryAdmission | null;
  }): Promise<{
    readonly created: boolean;
    readonly intent: Launch2IntentRecord;
  }>;
}
