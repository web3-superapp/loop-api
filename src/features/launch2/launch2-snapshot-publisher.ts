import { keccak256, stringToHex } from "viem";

import { buildLaunchMerkleTree } from "../launch/launch-merkle.js";
import {
  launch2CanOpenWithoutHolders,
  type Launch2FactoryGeneration,
} from "./launch2-generation.js";
import type { Launch2Repository } from "./launch2-ports.js";
import {
  createLaunch2ExitProbe,
  launch2ExitReasonCodes,
  type Launch2ExitTiming,
} from "./launch2-escrow-exit.js";

/**
 * Decision 0118: the `launch2_snapshot_publisher` lane. For every activated
 * instance whose NFT sale is over on chain and whose snapshot is not yet
 * published it
 *
 * 1. finds the cutoff block — the last block whose timestamp is before the
 *    registry's `nftSaleEnd` (= `ProjectNFT.saleEnd()`; the sale length is
 *    a Factory immutable since S141, never assumed) — and waits until it has `confirmations`
 *    blocks on top and the `launch2_event` lane has indexed that far;
 * 2. takes the cutoff holders from the indexed NFT transfers (the same
 *    `nftHoldersAt` the lane verifies with), cross-checks their balance sum
 *    against `ProjectNFT.totalMinted` at the cutoff block, builds the
 *    Decision 0077 Merkle tree and the Decision 0118 `dataHash`;
 * 3. signs the registry's EIP-712 `Snapshot` digest with two snapshot
 *    signer keys (the local digest must equal `snapshotDigest(...)` on
 *    chain), persists the attestation, then the submitter's signed
 *    `publishSnapshot` transaction, then sends it;
 * 4. follows the receipt to `confirmed` (`confirmations` deep, canonical);
 *    a reverted simulation or receipt is `failed`; a root the lane does not
 *    reproduce, or another root on chain, is `mismatch`.
 *
 * Decision 0122: when the indexed holder set at the cutoff is empty and
 * `ProjectNFT.totalMinted()` agrees (0), a v3-generation instance is not
 * closed: the publisher records an `open_without_holders` row and sends
 * `SnapshotRegistry.openPublicWithoutSnapshot()` through the same steps
 * (simulate, sign + record under the shared nonce lock, send, follow to
 * `confirmed`); the `launch2_event` lane indexes
 * `PublicRoundOpenedWithoutHolders` and the instance becomes `public`.
 * A v2-generation instance (no such function) is still closed
 * (Decision 0120).
 *
 * The `launch2_event` lane then verifies the published snapshot as before.
 * Fail closed: anything not ready leaves the instance waiting with a
 * reason code; nothing is published from a partial view.
 */

export const launch2SnapshotPublisherLane = "launch2_snapshot_publisher";

/**
 * Decision 0122: what a publication row sends. `publish_snapshot` = the
 * Decision 0118 2-of-3 signed root; `open_without_holders` = the v3
 * `openPublicWithoutSnapshot()` call (no members, zero root / dataHash, no
 * snapshot signatures).
 */
export const launch2PublicationActions = Object.freeze([
  "publish_snapshot",
  "open_without_holders",
  /**
   * Decision 0137 (S175 Factories): `openPublicAfterTimeout()` — the
   * fallback once `snapshotTimeoutAt()` passed and this lane could not
   * publish (same row shape as `open_without_holders`; the cutoff columns
   * hold the head block the decision was taken at).
   */
  "open_after_timeout",
] as const);
export type Launch2PublicationAction =
  (typeof launch2PublicationActions)[number];

export const launch2PublicationStatuses = Object.freeze([
  "pending",
  "broadcast",
  "confirmed",
  "failed",
  "mismatch",
] as const);
export type Launch2PublicationStatus =
  (typeof launch2PublicationStatuses)[number];

export const launch2PublisherReasonCodes = Object.freeze({
  chainMismatch: "LAUNCH2_SNAPSHOT_CHAIN_MISMATCH",
  saleOpen: "LAUNCH2_SNAPSHOT_SALE_OPEN",
  saleEndMismatch: "LAUNCH2_SNAPSHOT_SALE_END_MISMATCH",
  alreadyOnChain: "LAUNCH2_SNAPSHOT_ALREADY_ON_CHAIN",
  cutoffUnconfirmed: "LAUNCH2_SNAPSHOT_CUTOFF_UNCONFIRMED",
  cutoffNotFound: "LAUNCH2_SNAPSHOT_CUTOFF_NOT_FOUND",
  indexerBehind: "LAUNCH2_SNAPSHOT_INDEXER_BEHIND",
  indexerIncomplete: "LAUNCH2_SNAPSHOT_INDEXER_INCOMPLETE",
  noHolders: "LAUNCH2_SNAPSHOT_NO_HOLDERS",
  /**
   * Decision 0120: the sale ended with no holder (`totalMinted() = 0` at the
   * confirmed cutoff); a closure is recorded and the instance is never a
   * candidate again (stage `closed_no_holders`). Since Decision 0122 only
   * for v2-generation instances.
   */
  closedNoHolders: "LAUNCH2_SNAPSHOT_CLOSED_NO_HOLDERS",
  /**
   * Decision 0122: a v3 instance with zero mints — the publisher is
   * opening the public round without a snapshot (an
   * `open_without_holders` row exists).
   */
  openingWithoutHolders: "LAUNCH2_SNAPSHOT_OPENING_WITHOUT_HOLDERS",
  /** Decision 0122: someone else's `openPublicWithoutSnapshot()` won. */
  openedByOther: "LAUNCH2_SNAPSHOT_OPENED_BY_OTHER",
  digestMismatch: "LAUNCH2_SNAPSHOT_DIGEST_MISMATCH",
  retryWait: "LAUNCH2_SNAPSHOT_RETRY_WAIT",
  attemptsExhausted: "LAUNCH2_SNAPSHOT_ATTEMPTS_EXHAUSTED",
  blocked: "LAUNCH2_SNAPSHOT_PUBLICATION_BLOCKED",
  gasPriceAboveCap: "LAUNCH2_SNAPSHOT_GAS_PRICE_ABOVE_CAP",
  // Failure codes stored on a `failed` / `mismatch` row.
  contractReverted: "LAUNCH2_SNAPSHOT_CONTRACT_REVERTED",
  gasAboveCap: "LAUNCH2_SNAPSHOT_GAS_ABOVE_CAP",
  txReverted: "LAUNCH2_SNAPSHOT_TX_REVERTED",
  txRejected: "LAUNCH2_SNAPSHOT_TX_REJECTED",
  txDropped: "LAUNCH2_SNAPSHOT_TX_DROPPED",
  insufficientFunds: "LAUNCH2_SNAPSHOT_SUBMITTER_INSUFFICIENT_FUNDS",
  nonceConsumed: "LAUNCH2_SNAPSHOT_NONCE_CONSUMED",
  publishedByOther: "LAUNCH2_SNAPSHOT_PUBLISHED_BY_OTHER",
  notReproduced: "LAUNCH2_SNAPSHOT_NOT_REPRODUCED",
} as const);

const zeroHash = `0x${"0".repeat(64)}`;

/**
 * Decision 0118 `dataHash`: keccak256 of the UTF-8 bytes of
 * `JSON.stringify(members)`, where `members` is the cutoff holder list —
 * lower-case `0x` addresses, de-duplicated, sorted ascending (string order
 * equals numeric order for fixed-width lower-case hex). Example:
 * `["0x15d3…","0x9965…"]` → keccak256('["0x15d3…","0x9965…"]').
 */
export function launch2SnapshotMembers(
  addresses: readonly string[],
): readonly string[] {
  return [...new Set(addresses.map((address) => address.toLowerCase()))].sort();
}

export function launch2SnapshotDataHash(addresses: readonly string[]): string {
  return keccak256(
    stringToHex(JSON.stringify(launch2SnapshotMembers(addresses))),
  ).toLowerCase();
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface Launch2PublicationRecord {
  readonly publicationId: string;
  readonly instanceId: string;
  readonly action: Launch2PublicationAction;
  readonly attempt: number;
  readonly status: Launch2PublicationStatus;
  readonly snapshots: string;
  readonly cutoffBlock: string;
  readonly cutoffBlockHash: string;
  readonly saleEndAt: string;
  readonly memberCount: number;
  readonly root: string;
  readonly dataHash: string;
  readonly signerAddresses: readonly string[];
  readonly signatures: readonly string[];
  readonly submitterAddress: string;
  readonly txHash: string | null;
  readonly txNonce: string | null;
  readonly rawTx: string | null;
  readonly blockNumber: string | null;
  readonly blockHash: string | null;
  readonly confirmations: number | null;
  readonly failureCode: string | null;
  readonly failureDetail: string | null;
  readonly failureRetryable: boolean | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Launch2PublicationCandidate {
  readonly instanceId: string;
  readonly launchId: string;
  readonly nft: string;
  readonly snapshots: string;
  readonly deployBlockNumber: string;
  readonly nftSaleStart: string;
  readonly holdReason: string | null;
  readonly graduated: boolean;
  /** Decision 0122: the deploying Factory's generation. */
  readonly generation: Launch2FactoryGeneration;
  /** Decision 0122: `PublicRoundOpenedWithoutHolders` is indexed. */
  readonly openedWithoutHolders: boolean;
  /**
   * Decision 0137: the deploying Factory (exit-path capability probe).
   * Absent: never probed (no timeout opening).
   */
  readonly factoryAddress?: string;
  /** Decision 0137: `PublicRoundOpenedAfterTimeout` is indexed. */
  readonly openedAfterTimeout?: boolean;
  /**
   * Decision 0137: the `open_after_timeout` rows since the latest release:
   * retryable failures, whether one failed for good (or mismatched), and
   * the newest failure time. Absent = none.
   */
  readonly timeoutOpen?: {
    readonly retryableFailures: number;
    readonly blocked: boolean;
    readonly lastFailedAt: string | null;
  };
  /** The indexed on-chain snapshot (null until `SnapshotPublished`). */
  readonly snapshotRoot: string | null;
  readonly snapshotVerification: "verified" | "mismatch" | null;
  /** The `pending | broadcast | confirmed` row, if any. */
  readonly active: Launch2PublicationRecord | null;
  readonly lastAttempt: number;
  readonly retryableFailures: number;
  /** A non-retryable `failed` or a `mismatch` row stops new attempts. */
  readonly blockingCode: string | null;
  readonly lastFailedAt: string | null;
}

export interface Launch2PublicationRepository {
  listCandidates(
    chainId: string,
  ): Promise<readonly Launch2PublicationCandidate[]>;
  /**
   * Decision 0120: records that the instance's NFT sale ended with no
   * holder (immutable, at most one per instance). False when a closure
   * already existed.
   */
  recordNoHoldersClosure(input: {
    readonly instanceId: string;
    readonly chainId: string;
    readonly snapshots: string;
    readonly saleEndAt: string;
    readonly cutoffBlock: string;
    readonly cutoffBlockHash: string;
  }): Promise<boolean>;
  /** Inserts a `pending` attestation; null when another row is active. */
  insertPending(input: {
    /** Decision 0122; absent = `publish_snapshot`. */
    readonly action?: Launch2PublicationAction;
    readonly instanceId: string;
    readonly chainId: string;
    readonly attempt: number;
    readonly snapshots: string;
    readonly cutoffBlock: string;
    readonly cutoffBlockHash: string;
    readonly saleEndAt: string;
    readonly members: readonly string[];
    readonly root: string;
    readonly dataHash: string;
    readonly signerAddresses: readonly string[];
    readonly signatures: readonly string[];
    readonly submitterAddress: string;
  }): Promise<Launch2PublicationRecord | null>;
  /**
   * Under the submitter's nonce lock (shared with the Hooks executor):
   * picks the lowest free nonce ≥ `chainPendingNonce`, signs, and records
   * the transaction on the still-`pending` row. Null when the row moved.
   */
  reserveAndRecordTx(input: {
    readonly publicationId: string;
    readonly submitterAddress: string;
    readonly chainPendingNonce: bigint;
    readonly sign: (nonce: bigint) => Promise<{
      readonly txHash: string;
      readonly rawTx: string;
    }>;
  }): Promise<Launch2PublicationRecord | null>;
  transition(input: {
    readonly publicationId: string;
    readonly from: Launch2PublicationStatus;
    readonly to: Launch2PublicationStatus;
    readonly inclusion?: {
      readonly blockNumber: string;
      readonly blockHash: string;
      readonly confirmations: number;
    } | null;
    readonly failure?: {
      readonly code: string;
      readonly detail: string | null;
      readonly retryable: boolean | null;
    };
  }): Promise<Launch2PublicationRecord | null>;
}

export class Launch2PublisherRevertError extends Error {
  constructor(readonly errorName: string) {
    super("The snapshot publication would revert");
    this.name = "Launch2PublisherRevertError";
  }
}

export interface Launch2PublishCall {
  readonly snapshots: string;
  readonly cutoffBlock: bigint;
  readonly cutoffBlockHash: string;
  readonly dataHash: string;
  readonly root: string;
  readonly signatures: readonly string[];
}

export type Launch2SendResult =
  "accepted" | "known" | "nonce_too_low" | "insufficient_funds" | "rejected";

export interface Launch2PublisherChain {
  readonly submitterAddress: string;
  chainId(): Promise<number>;
  head(): Promise<{
    readonly number: bigint;
    readonly hash: string;
    readonly timestamp: bigint;
  }>;
  block(
    blockNumber: bigint,
  ): Promise<{ readonly hash: string; readonly timestamp: bigint } | null>;
  /** Immutables of the registry (`nftSaleEnd` = `ProjectNFT.saleEnd()`). */
  registry(snapshots: string): Promise<{
    readonly nftSaleEnd: bigint;
    readonly launchId: string;
    readonly nft: string;
  }>;
  /** The published root (zero hash until `publishSnapshot`). */
  registryRoot(snapshots: string): Promise<string>;
  /**
   * Decision 0122: `rootPublishedAt()` — non-zero once a snapshot was
   * published or (v3) the public round was opened without holders.
   */
  registryPublishedAt(snapshots: string): Promise<bigint>;
  isSnapshotSigner(snapshots: string, address: string): Promise<boolean>;
  totalMintedAt(nft: string, blockNumber: bigint): Promise<bigint>;
  snapshotDigest(call: Omit<Launch2PublishCall, "signatures">): Promise<string>;
  /** Throws `Launch2PublisherRevertError` with the contract error name. */
  estimatePublish(call: Launch2PublishCall): Promise<bigint>;
  /**
   * Decision 0122: simulates then estimates
   * `openPublicWithoutSnapshot()`; throws `Launch2PublisherRevertError`.
   */
  estimateOpenWithoutHolders(snapshots: string): Promise<bigint>;
  signOpenWithoutHolders(
    snapshots: string,
    tx: {
      readonly nonce: bigint;
      readonly gas: bigint;
      readonly gasPrice: bigint;
    },
  ): Promise<{ readonly txHash: string; readonly rawTx: string }>;
  /**
   * Decision 0137: `LoopLaunchFactory.snapshotTimeout()` / `refundDelay()`,
   * null for a Factory without exit paths (revert / no selector); throws on
   * an RPC failure. Absent (older chains): no timeout opening.
   */
  exitTiming?(factory: string): Promise<Launch2ExitTiming | null>;
  /** Decision 0137: `SnapshotRegistry.snapshotTimeoutAt()`; null on a revert. */
  registrySnapshotTimeoutAt?(snapshots: string): Promise<bigint | null>;
  /**
   * Decision 0137: simulates then estimates `openPublicAfterTimeout()`;
   * throws `Launch2PublisherRevertError`.
   */
  estimateOpenAfterTimeout?(snapshots: string): Promise<bigint>;
  signOpenAfterTimeout?(
    snapshots: string,
    tx: {
      readonly nonce: bigint;
      readonly gas: bigint;
      readonly gasPrice: bigint;
    },
  ): Promise<{ readonly txHash: string; readonly rawTx: string }>;
  gasPrice(): Promise<bigint>;
  pendingNonce(): Promise<bigint>;
  signPublish(
    call: Launch2PublishCall,
    tx: {
      readonly nonce: bigint;
      readonly gas: bigint;
      readonly gasPrice: bigint;
    },
  ): Promise<{ readonly txHash: string; readonly rawTx: string }>;
  sendRaw(rawTx: string): Promise<Launch2SendResult>;
  receipt(txHash: string): Promise<{
    readonly status: "success" | "reverted";
    readonly blockNumber: bigint;
    readonly blockHash: string;
  } | null>;
}

export interface Launch2SnapshotMessage {
  readonly snapshots: string;
  readonly launchId: string;
  readonly nft: string;
  readonly cutoffBlock: bigint;
  readonly cutoffBlockHash: string;
  readonly dataHash: string;
  readonly root: string;
}

/** One snapshot signer key (lives only in the integration closure). */
export interface Launch2SnapshotSigner {
  readonly address: string;
  digest(message: Launch2SnapshotMessage): string;
  sign(message: Launch2SnapshotMessage): Promise<string>;
}

export interface Launch2PublisherPolicy {
  readonly chainId: string;
  readonly confirmations: number;
  readonly maxGasPriceWei: bigint;
  readonly gasLimitCap: bigint;
  readonly maxAttempts: number;
  readonly retryDelaySeconds: number;
  /**
   * Decision 0137: `LAUNCH2_TIMEOUT_OPEN_ENABLED` — send
   * `openPublicAfterTimeout()` when the timeout passed and this lane cannot
   * publish. Absent / false: the due opening is only logged
   * (`LAUNCH2_TIMEOUT_OPEN_SKIPPED`).
   */
  readonly timeoutOpenEnabled?: boolean;
}

/** `ProjectNFT` MIN / MAX_SALE_DURATION (loop-contracts S141). */
export const launch2PublisherSaleBounds = Object.freeze({
  minSeconds: 3_600,
  maxSeconds: 604_800,
});

export const launch2PublisherDefaults = Object.freeze({
  confirmations: 12,
  pollIntervalMs: 5_000,
  maxGasPriceGwei: 20,
  gasLimitCap: 1_000_000n,
  maxAttempts: 3,
  retryDelaySeconds: 60,
});

export interface Launch2PublisherStep {
  readonly instanceId: string;
  readonly publicationId: string;
  readonly from: Launch2PublicationStatus | null;
  readonly to: Launch2PublicationStatus;
  readonly txHash: string | null;
  readonly failureCode: string | null;
}

export interface Launch2PublisherTickResult {
  readonly kind: "ran" | "unavailable";
  readonly reasonCode: string | null;
  readonly candidates: number;
  readonly steps: number;
  /** Instance → why it is not progressing this tick. */
  readonly waiting: Readonly<Record<string, string>>;
}

export interface Launch2SnapshotPublisher {
  runOnce(signal?: AbortSignal): Promise<Launch2PublisherTickResult>;
}

function unixSeconds(iso: string): bigint {
  return BigInt(Math.floor(Date.parse(iso) / 1000));
}

function contractFailureCode(errorName: string): {
  readonly code: string;
  readonly retryable: boolean;
} {
  // `SnapshotNotReady` can only mean our view of time was early; the rest
  // (bad signatures, already published / opened, `HoldersExist`, bad data)
  // need an operator.
  return {
    code: launch2PublisherReasonCodes.contractReverted,
    retryable: errorName === "SnapshotNotReady",
  };
}

const zeroBytes32 = `0x${"0".repeat(64)}`;

export function createLaunch2SnapshotPublisher(options: {
  readonly repository: Launch2PublicationRepository;
  readonly launch2: Pick<Launch2Repository, "nftHoldersAt" | "getCheckpoint">;
  readonly chain: Launch2PublisherChain;
  readonly signers: readonly Launch2SnapshotSigner[];
  readonly policy: Launch2PublisherPolicy;
  readonly now?: () => Date;
  readonly onStep?: (step: Launch2PublisherStep) => void;
}): Launch2SnapshotPublisher {
  if (options.signers.length < 2) {
    throw new Error("The snapshot publisher needs at least two signer keys");
  }
  const now = options.now ?? ((): Date => new Date());
  const { repository, chain, policy } = options;
  // Registry immutables per SnapshotRegistry address. The sale length is a
  // Factory immutable (S141: 1 h on the testnet Factory, 7 d on mainnet),
  // so the sale end is always read from the chain, never derived.
  const registryFacts = new Map<
    string,
    Awaited<ReturnType<Launch2PublisherChain["registry"]>>
  >();
  async function factsOf(snapshots: string) {
    const cached = registryFacts.get(snapshots);
    if (cached !== undefined) return cached;
    const facts = await chain.registry(snapshots);
    registryFacts.set(snapshots, facts);
    return facts;
  }

  async function move(
    record: Launch2PublicationRecord,
    to: Launch2PublicationStatus,
    extra: Omit<
      Parameters<Launch2PublicationRepository["transition"]>[0],
      "publicationId" | "from" | "to"
    > = {},
  ): Promise<Launch2PublicationRecord | null> {
    const updated = await repository.transition({
      publicationId: record.publicationId,
      from: record.status,
      to,
      ...extra,
    });
    if (updated !== null && updated.status !== record.status) {
      options.onStep?.({
        instanceId: record.instanceId,
        publicationId: record.publicationId,
        from: record.status,
        to: updated.status,
        txHash: updated.txHash,
        failureCode: updated.failureCode,
      });
    }
    return updated;
  }

  /** Largest block number whose timestamp is < saleEnd (binary search). */
  async function findCutoff(
    low: bigint,
    high: bigint,
    saleEnd: bigint,
  ): Promise<bigint | null> {
    const lowBlock = await chain.block(low);
    if (lowBlock === null || lowBlock.timestamp >= saleEnd) return null;
    let lo = low;
    let hi = high;
    // Invariant: ts(lo) < saleEnd ≤ ts(hi).
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      const block = await chain.block(mid);
      if (block === null) return null;
      if (block.timestamp < saleEnd) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  async function sendSigned(record: Launch2PublicationRecord): Promise<void> {
    if (record.rawTx === null || record.txHash === null) return;
    const outcome = await chain.sendRaw(record.rawTx);
    if (outcome === "accepted" || outcome === "known") {
      await move(record, "broadcast");
      return;
    }
    if (outcome === "nonce_too_low") {
      // Either our own transaction was already mined, or the nonce went to
      // another transaction of the account.
      const receipt = await chain.receipt(record.txHash);
      if (receipt !== null) {
        await move(record, "broadcast");
        return;
      }
      await move(record, "failed", {
        failure: {
          code: launch2PublisherReasonCodes.nonceConsumed,
          detail: null,
          retryable: true,
        },
      });
      return;
    }
    await move(record, "failed", {
      failure: {
        code:
          outcome === "insufficient_funds"
            ? launch2PublisherReasonCodes.insufficientFunds
            : launch2PublisherReasonCodes.txRejected,
        detail: null,
        retryable: true,
      },
    });
  }

  function callOf(record: Launch2PublicationRecord): Launch2PublishCall {
    return {
      snapshots: record.snapshots,
      cutoffBlock: BigInt(record.cutoffBlock),
      cutoffBlockHash: record.cutoffBlockHash,
      dataHash: record.dataHash,
      root: record.root,
      signatures: record.signatures,
    };
  }

  /** `pending`: simulate, sign + record, send. Returns a waiting reason. */
  async function advancePending(
    record: Launch2PublicationRecord,
  ): Promise<string | null> {
    if (record.txHash !== null) {
      await sendSigned(record);
      return null;
    }
    const opening = record.action === "open_without_holders";
    const timeoutOpening = record.action === "open_after_timeout";
    const call = callOf(record);
    let estimate: bigint;
    try {
      estimate = timeoutOpening
        ? await requireTimeoutCalls().estimate(record.snapshots)
        : opening
          ? await chain.estimateOpenWithoutHolders(record.snapshots)
          : await chain.estimatePublish(call);
    } catch (error) {
      if (error instanceof Launch2PublisherRevertError) {
        const failure = contractFailureCode(error.errorName);
        await move(record, "failed", {
          failure: {
            code: failure.code,
            detail: /^[A-Za-z0-9_]{1,64}$/u.test(error.errorName)
              ? error.errorName
              : null,
            retryable: failure.retryable,
          },
        });
        return null;
      }
      throw error;
    }
    const gas = (estimate * 12n) / 10n;
    if (gas > policy.gasLimitCap) {
      await move(record, "failed", {
        failure: {
          code: launch2PublisherReasonCodes.gasAboveCap,
          detail: null,
          retryable: false,
        },
      });
      return null;
    }
    const gasPrice = await chain.gasPrice();
    if (gasPrice > policy.maxGasPriceWei) {
      return launch2PublisherReasonCodes.gasPriceAboveCap;
    }
    const chainPendingNonce = await chain.pendingNonce();
    const signed = await repository.reserveAndRecordTx({
      publicationId: record.publicationId,
      submitterAddress: chain.submitterAddress,
      chainPendingNonce,
      sign: (nonce) =>
        timeoutOpening
          ? requireTimeoutCalls().sign(record.snapshots, {
              nonce,
              gas,
              gasPrice,
            })
          : opening
            ? chain.signOpenWithoutHolders(record.snapshots, {
                nonce,
                gas,
                gasPrice,
              })
            : chain.signPublish(call, { nonce, gas, gasPrice }),
    });
    if (signed === null) return null;
    await sendSigned(signed);
    return null;
  }

  async function advanceBroadcast(
    record: Launch2PublicationRecord,
    headNumber: bigint,
  ): Promise<void> {
    if (record.txHash === null || record.rawTx === null) return;
    const receipt = await chain.receipt(record.txHash);
    if (receipt === null) {
      // Not (or no longer) included: re-send the same signed bytes.
      const outcome = await chain.sendRaw(record.rawTx);
      if (outcome === "nonce_too_low") {
        const again = await chain.receipt(record.txHash);
        if (again === null) {
          await move(record, "failed", {
            failure: {
              code: launch2PublisherReasonCodes.txDropped,
              detail: null,
              retryable: true,
            },
          });
        }
      }
      return;
    }
    if (receipt.status === "reverted") {
      if (
        record.action === "open_without_holders" ||
        record.action === "open_after_timeout"
      ) {
        // Anyone may open; a reverted call after another opening is not ours
        // to repeat (the lane indexes the other transaction's event).
        const opened =
          (await chain.registryPublishedAt(record.snapshots)) !== 0n;
        await move(record, "failed", {
          failure: {
            code: opened
              ? launch2PublisherReasonCodes.openedByOther
              : launch2PublisherReasonCodes.txReverted,
            detail: null,
            retryable: false,
          },
        });
        return;
      }
      const onChainRoot = await chain.registryRoot(record.snapshots);
      if (onChainRoot !== zeroHash && onChainRoot !== record.root) {
        await move(record, "mismatch", {
          failure: {
            code: launch2PublisherReasonCodes.publishedByOther,
            detail: null,
            retryable: null,
          },
        });
        return;
      }
      await move(record, "failed", {
        failure: {
          code: launch2PublisherReasonCodes.txReverted,
          detail: null,
          retryable: false,
        },
      });
      return;
    }
    const depth = headNumber - receipt.blockNumber + 1n;
    const confirmations = depth > 0n ? Number(depth) : 0;
    const inclusion = {
      blockNumber: receipt.blockNumber.toString(10),
      blockHash: receipt.blockHash,
      confirmations,
    };
    if (confirmations >= policy.confirmations) {
      const canonical = await chain.block(receipt.blockNumber);
      if (canonical?.hash === receipt.blockHash) {
        await move(record, "confirmed", { inclusion });
        return;
      }
    }
    if (
      record.blockHash !== inclusion.blockHash ||
      record.confirmations !== inclusion.confirmations
    ) {
      await move(record, "broadcast", { inclusion });
    }
  }

  async function advanceConfirmed(
    candidate: Launch2PublicationCandidate,
    record: Launch2PublicationRecord,
  ): Promise<void> {
    // Decision 0122: an opening is done once the lane indexed the event.
    if (
      record.action === "open_without_holders" &&
      candidate.openedWithoutHolders
    ) {
      return;
    }
    // Decision 0137: likewise once `PublicRoundOpenedAfterTimeout` is indexed.
    if (
      record.action === "open_after_timeout" &&
      candidate.openedAfterTimeout === true
    ) {
      return;
    }
    if (candidate.snapshotRoot !== null) {
      if (candidate.snapshotRoot !== record.root) {
        await move(record, "mismatch", {
          failure: {
            code: launch2PublisherReasonCodes.publishedByOther,
            detail: null,
            retryable: null,
          },
        });
      } else if (candidate.snapshotVerification === "mismatch") {
        await move(record, "mismatch", {
          failure: {
            code: launch2PublisherReasonCodes.notReproduced,
            detail: null,
            retryable: null,
          },
        });
      }
      return;
    }
    // Confirmed but not indexed: the lane may simply lag, or the inclusion
    // block left the canonical chain (the lane rewound it).
    if (record.txHash === null || record.rawTx === null) return;
    const receipt = await chain.receipt(record.txHash);
    if (receipt !== null && receipt.blockHash === record.blockHash) return;
    const reopened = await move(record, "broadcast", { inclusion: null });
    if (reopened !== null) await chain.sendRaw(record.rawTx);
  }

  /** Decision 0137: the two timeout-opening calls (present on S175 chains). */
  function requireTimeoutCalls(): {
    readonly estimate: (snapshots: string) => Promise<bigint>;
    readonly sign: NonNullable<Launch2PublisherChain["signOpenAfterTimeout"]>;
  } {
    const estimate = chain.estimateOpenAfterTimeout?.bind(chain);
    const sign = chain.signOpenAfterTimeout?.bind(chain);
    if (estimate === undefined || sign === undefined) {
      throw new Error("The publisher chain cannot open after the timeout");
    }
    return { estimate, sign };
  }

  const exitProbe = createLaunch2ExitProbe(
    chain.exitTiming === undefined
      ? undefined
      : (factory) =>
          (
            chain.exitTiming as NonNullable<Launch2PublisherChain["exitTiming"]>
          )(factory),
  );
  /** `snapshotTimeoutAt()` per registry (an immutable sum). */
  const timeoutAts = new Map<string, bigint | null>();

  /**
   * Decision 0137: the snapshot-timeout fallback. Only for an instance of a
   * Factory with exit paths, whose sale had holders, still unopened at or
   * after `snapshotTimeoutAt()`, while the normal path did not start a
   * publication this tick. Null = nothing to do here (keep the normal
   * reason); otherwise the waiting reason.
   */
  async function timeoutOpen(
    candidate: Launch2PublicationCandidate,
    head: {
      readonly number: bigint;
      readonly hash: string;
      readonly timestamp: bigint;
    },
  ): Promise<string | null> {
    if (
      candidate.factoryAddress === undefined ||
      chain.registrySnapshotTimeoutAt === undefined ||
      chain.estimateOpenAfterTimeout === undefined ||
      chain.signOpenAfterTimeout === undefined
    ) {
      return null;
    }
    if ((await exitProbe.timingOf(candidate.factoryAddress)) === null) {
      return null;
    }
    let timeoutAt = timeoutAts.get(candidate.snapshots);
    if (timeoutAt === undefined) {
      timeoutAt = await chain.registrySnapshotTimeoutAt(candidate.snapshots);
      timeoutAts.set(candidate.snapshots, timeoutAt);
    }
    if (timeoutAt === null || head.timestamp < timeoutAt) return null;
    // Zero mints is the Decision 0122 opening's case, not this one.
    if ((await chain.totalMintedAt(candidate.nft, head.number)) === 0n) {
      return null;
    }
    if ((await chain.registryPublishedAt(candidate.snapshots)) !== 0n) {
      return launch2PublisherReasonCodes.alreadyOnChain;
    }
    const skipped = launch2ExitReasonCodes.timeoutOpenSkipped;
    if (policy.timeoutOpenEnabled !== true) return skipped;
    const budget = candidate.timeoutOpen;
    if (budget !== undefined) {
      if (budget.blocked || budget.retryableFailures >= policy.maxAttempts) {
        return skipped;
      }
      if (
        budget.lastFailedAt !== null &&
        Date.parse(budget.lastFailedAt) + policy.retryDelaySeconds * 1000 >
          now().getTime()
      ) {
        return skipped;
      }
    }
    const registry = await factsOf(candidate.snapshots);
    const opening = await repository.insertPending({
      action: "open_after_timeout",
      instanceId: candidate.instanceId,
      chainId: policy.chainId,
      attempt: candidate.lastAttempt + 1,
      snapshots: candidate.snapshots,
      cutoffBlock: head.number.toString(10),
      cutoffBlockHash: head.hash,
      saleEndAt: new Date(Number(registry.nftSaleEnd) * 1000).toISOString(),
      members: [],
      root: zeroBytes32,
      dataHash: zeroBytes32,
      signerAddresses: [],
      signatures: [],
      submitterAddress: chain.submitterAddress,
    });
    if (opening === null) return null;
    options.onStep?.({
      instanceId: opening.instanceId,
      publicationId: opening.publicationId,
      from: null,
      to: "pending",
      txHash: null,
      failureCode: null,
    });
    return (
      (await advancePending(opening)) ?? launch2ExitReasonCodes.timeoutOpenSent
    );
  }

  async function start(
    candidate: Launch2PublicationCandidate,
    head: { readonly number: bigint; readonly timestamp: bigint },
  ): Promise<string | null> {
    const registry = await factsOf(candidate.snapshots);
    const saleLength =
      registry.nftSaleEnd - unixSeconds(candidate.nftSaleStart);
    if (
      registry.launchId !== candidate.launchId ||
      registry.nft !== candidate.nft ||
      saleLength < BigInt(launch2PublisherSaleBounds.minSeconds) ||
      saleLength > BigInt(launch2PublisherSaleBounds.maxSeconds)
    ) {
      return launch2PublisherReasonCodes.saleEndMismatch;
    }
    if (head.timestamp < registry.nftSaleEnd) {
      return launch2PublisherReasonCodes.saleOpen;
    }
    if (candidate.blockingCode !== null) {
      return launch2PublisherReasonCodes.blocked;
    }
    if (candidate.retryableFailures >= policy.maxAttempts) {
      return launch2PublisherReasonCodes.attemptsExhausted;
    }
    if (
      candidate.lastFailedAt !== null &&
      Date.parse(candidate.lastFailedAt) + policy.retryDelaySeconds * 1000 >
        now().getTime()
    ) {
      return launch2PublisherReasonCodes.retryWait;
    }
    if (
      (await chain.registryRoot(candidate.snapshots)) !== zeroHash ||
      (await chain.registryPublishedAt(candidate.snapshots)) !== 0n
    ) {
      // Published, or (v3) opened without holders by anyone.
      return launch2PublisherReasonCodes.alreadyOnChain;
    }
    const cutoff = await findCutoff(
      BigInt(candidate.deployBlockNumber),
      head.number,
      registry.nftSaleEnd,
    );
    if (cutoff === null) return launch2PublisherReasonCodes.cutoffNotFound;
    if (head.number - cutoff < BigInt(policy.confirmations)) {
      return launch2PublisherReasonCodes.cutoffUnconfirmed;
    }
    const checkpoint = await options.launch2.getCheckpoint(policy.chainId);
    if (
      checkpoint === null ||
      BigInt(checkpoint.lastBlockNumber) < cutoff + BigInt(policy.confirmations)
    ) {
      return launch2PublisherReasonCodes.indexerBehind;
    }
    const [cutoffBlock, nextBlock] = await Promise.all([
      chain.block(cutoff),
      chain.block(cutoff + 1n),
    ]);
    if (
      cutoffBlock === null ||
      nextBlock === null ||
      cutoffBlock.timestamp >= registry.nftSaleEnd ||
      nextBlock.timestamp < registry.nftSaleEnd
    ) {
      return launch2PublisherReasonCodes.cutoffNotFound;
    }
    const holders = await options.launch2.nftHoldersAt({
      instanceId: candidate.instanceId,
      blockNumber: cutoff.toString(10),
    });
    if (holders.length === 0) {
      // Decision 0120: an empty indexed holder set is only a closure when
      // the chain agrees that nothing was minted by the cutoff block.
      const mintedAtCutoff = await chain.totalMintedAt(candidate.nft, cutoff);
      if (mintedAtCutoff !== 0n) {
        return launch2PublisherReasonCodes.indexerIncomplete;
      }
      if (launch2CanOpenWithoutHolders(candidate.generation)) {
        // Decision 0122: record first, then open the public round.
        const opening = await repository.insertPending({
          action: "open_without_holders",
          instanceId: candidate.instanceId,
          chainId: policy.chainId,
          attempt: candidate.lastAttempt + 1,
          snapshots: candidate.snapshots,
          cutoffBlock: cutoff.toString(10),
          cutoffBlockHash: cutoffBlock.hash,
          saleEndAt: new Date(Number(registry.nftSaleEnd) * 1000).toISOString(),
          members: [],
          root: zeroBytes32,
          dataHash: zeroBytes32,
          signerAddresses: [],
          signatures: [],
          submitterAddress: chain.submitterAddress,
        });
        if (opening === null) return null;
        options.onStep?.({
          instanceId: opening.instanceId,
          publicationId: opening.publicationId,
          from: null,
          to: "pending",
          txHash: null,
          failureCode: null,
        });
        return (
          (await advancePending(opening)) ??
          launch2PublisherReasonCodes.openingWithoutHolders
        );
      }
      await repository.recordNoHoldersClosure({
        instanceId: candidate.instanceId,
        chainId: policy.chainId,
        snapshots: candidate.snapshots,
        saleEndAt: new Date(Number(registry.nftSaleEnd) * 1000).toISOString(),
        cutoffBlock: cutoff.toString(10),
        cutoffBlockHash: cutoffBlock.hash,
      });
      return launch2PublisherReasonCodes.closedNoHolders;
    }
    const indexedSupply = holders.reduce(
      (sum, holder) => sum + BigInt(holder.balance),
      0n,
    );
    const minted = await chain.totalMintedAt(candidate.nft, cutoff);
    if (minted !== indexedSupply) {
      return launch2PublisherReasonCodes.indexerIncomplete;
    }
    const members = launch2SnapshotMembers(
      holders.map((holder) => holder.address),
    );
    const tree = buildLaunchMerkleTree(members);
    const message: Launch2SnapshotMessage = {
      snapshots: candidate.snapshots,
      launchId: candidate.launchId,
      nft: candidate.nft,
      cutoffBlock: cutoff,
      cutoffBlockHash: cutoffBlock.hash,
      dataHash: launch2SnapshotDataHash(members),
      root: tree.root,
    };
    // Registered signers first; the contract stays the judge either way.
    const registered = await Promise.all(
      options.signers.map((signer) =>
        chain.isSnapshotSigner(candidate.snapshots, signer.address),
      ),
    );
    const chosen = [
      ...options.signers.filter((_, index) => registered[index] === true),
      ...options.signers.filter((_, index) => registered[index] !== true),
    ].slice(0, 2);
    const onChainDigest = await chain.snapshotDigest({
      snapshots: message.snapshots,
      cutoffBlock: message.cutoffBlock,
      cutoffBlockHash: message.cutoffBlockHash,
      dataHash: message.dataHash,
      root: message.root,
    });
    if (chosen.some((signer) => signer.digest(message) !== onChainDigest)) {
      return launch2PublisherReasonCodes.digestMismatch;
    }
    const signatures = await Promise.all(
      chosen.map((signer) => signer.sign(message)),
    );
    const inserted = await repository.insertPending({
      instanceId: candidate.instanceId,
      chainId: policy.chainId,
      attempt: candidate.lastAttempt + 1,
      snapshots: candidate.snapshots,
      cutoffBlock: cutoff.toString(10),
      cutoffBlockHash: cutoffBlock.hash,
      saleEndAt: new Date(Number(registry.nftSaleEnd) * 1000).toISOString(),
      members,
      root: tree.root,
      dataHash: message.dataHash,
      signerAddresses: chosen.map((signer) => signer.address),
      signatures,
      submitterAddress: chain.submitterAddress,
    });
    if (inserted === null) return null;
    options.onStep?.({
      instanceId: inserted.instanceId,
      publicationId: inserted.publicationId,
      from: null,
      to: "pending",
      txHash: null,
      failureCode: null,
    });
    return advancePending(inserted);
  }

  async function tick(
    signal?: AbortSignal,
  ): Promise<Launch2PublisherTickResult> {
    const expected = Number(policy.chainId.split(":")[1]);
    if ((await chain.chainId()) !== expected) {
      return Object.freeze({
        kind: "unavailable",
        reasonCode: launch2PublisherReasonCodes.chainMismatch,
        candidates: 0,
        steps: 0,
        waiting: {},
      });
    }
    const candidates = await repository.listCandidates(policy.chainId);
    const head = await chain.head();
    const waiting: Record<string, string> = {};
    let steps = 0;
    for (const candidate of candidates) {
      if (signal?.aborted === true) break;
      const active = candidate.active;
      let reason: string | null = null;
      if (active === null) {
        if (
          candidate.snapshotRoot !== null ||
          candidate.openedWithoutHolders ||
          candidate.openedAfterTimeout === true ||
          candidate.holdReason !== null ||
          candidate.graduated
        ) {
          continue;
        }
        reason = await start(candidate, head);
        // Decision 0137: the normal path is stuck (signatures refused,
        // retries exhausted, indexer gaps, …) — past the snapshot timeout
        // the registry can be opened without a snapshot.
        if (
          reason !== null &&
          reason !== launch2PublisherReasonCodes.alreadyOnChain &&
          reason !== launch2PublisherReasonCodes.saleOpen &&
          reason !== launch2PublisherReasonCodes.saleEndMismatch
        ) {
          reason = (await timeoutOpen(candidate, head)) ?? reason;
        }
      } else if (active.status === "pending") {
        if (candidate.holdReason !== null && active.txHash === null) {
          reason = candidate.holdReason;
        } else {
          reason = await advancePending(active);
        }
      } else if (active.status === "broadcast") {
        await advanceBroadcast(active, head.number);
      } else {
        await advanceConfirmed(candidate, active);
      }
      steps += 1;
      if (reason !== null) waiting[candidate.instanceId] = reason;
    }
    return Object.freeze({
      kind: "ran",
      reasonCode: null,
      candidates: candidates.length,
      steps,
      waiting: Object.freeze(waiting),
    });
  }

  let inFlight: Promise<Launch2PublisherTickResult> | null = null;
  return Object.freeze({
    runOnce(signal?: AbortSignal): Promise<Launch2PublisherTickResult> {
      if (inFlight !== null) return inFlight;
      const tracked = tick(signal).finally(() => {
        if (inFlight === tracked) inFlight = null;
      });
      inFlight = tracked;
      return tracked;
    },
  });
}
