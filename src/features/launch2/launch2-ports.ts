import type {
  Launch2HoldReason,
  Launch2IntentKind,
  Launch2Stage,
} from "./launch2-contract.js";
import type { Launch2CurveState } from "./launch2-curve-math.js";
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
  | "poolManager";

export const launch2EventNames = Object.freeze([
  "LaunchDeployed",
  "LaunchActivated",
  "NftMinted",
  "Transfer",
  "SnapshotPublished",
  "PublicRoundOpenedWithoutHolders",
  "CurveBought",
  "CurveSold",
  "Graduated",
  "BuybackCompleted",
  "BuybackPausedEvent",
  "BuybackResumed",
  "Swap",
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
  }): Promise<{
    readonly logs: readonly Launch2DecodedLog[];
    readonly ignored: number;
  }>;
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
  };
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
  }): Promise<{ readonly storedCount: number; readonly touched: number }>;
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
