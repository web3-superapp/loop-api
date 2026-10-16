import { hashTypedData, recoverAddress, type Hex } from "viem";

import {
  launchSlotRefusal,
  testnetLaunchSlot,
  type LaunchSlotPolicy,
} from "../chain/chain-contract.js";

import {
  createHooksLaunchDeploymentTypedData,
  hooksLaunchId,
} from "./hooks-launch-deployment-crypto.js";
import {
  hooksLaunchBindingHash,
  hooksLaunchSubmissionSchema,
  type HooksLaunchSignedSubmission,
} from "./hooks-launch-submission.js";
import type { HooksLaunchDeploymentStatus } from "./hooks-launch-deployment-status.js";
import type { HooksLaunchLoopDynamicParams } from "./hooks-launch-config.js";
import {
  verifyHooksLaunchLoopDynamicDeployment,
  type HooksLaunchLoopDynamicOnChainFacts,
} from "./hooks-launch-loop-dynamic-verification.js";
import {
  verifyHooksLaunchDeployment,
  type HooksLaunchDeployedEvent,
  type HooksLaunchExpectedDeployment,
  type HooksLaunchModules,
  type HooksLaunchOnChainFacts,
} from "./hooks-launch-verification.js";

/**
 * Decision 0112: the Hooks deployment executor. One lane in the worker
 * process, default off (`HOOKS_LAUNCH_EXECUTOR_ENABLED`). It claims a
 * project-signed task under a lease, re-checks config / approval /
 * signature deadline / owner nonce, persists the signed transaction (hash,
 * raw bytes, reserved executor nonce) *before* sending it, follows the
 * receipt to the configured confirmations, detects reorgs by block hash,
 * verifies every module by read-back, and only then activates the launch
 * through `LoopLaunchFactory.activateLaunch`. A failed check never
 * activates. BSC Testnet (97), or BSC Mainnet only under Decision 0150.
 */

export {
  hooksLaunchDeploymentStatuses,
  type HooksLaunchDeploymentStatus,
} from "./hooks-launch-deployment-status.js";

/** Failure codes written to the task and its events (wire-safe). */
export type HooksLaunchExecutorFailureCode =
  | "HOOKS_CONFIG_SUPERSEDED"
  | "HOOKS_CONFIG_NOT_APPROVED"
  | "HOOKS_AUTHORIZATION_INVALID"
  | "HOOKS_SIGNATURE_EXPIRED"
  | "HOOKS_OWNER_NONCE_CONSUMED"
  | "HOOKS_LAUNCH_ALREADY_DEPLOYED"
  | "HOOKS_ACTIVATION_WINDOW_CLOSED"
  | "HOOKS_DEPLOY_SIMULATION_REVERTED"
  | "HOOKS_DEPLOY_GAS_ABOVE_CAP"
  | "HOOKS_EXECUTOR_FUNDS_INSUFFICIENT"
  | "HOOKS_BROADCAST_REJECTED"
  | "HOOKS_TX_DROPPED"
  | "HOOKS_DEPLOY_REVERTED"
  | "HOOKS_VERIFICATION_MISMATCH"
  | "HOOKS_ACTIVATION_STATE_UNEXPECTED"
  | "HOOKS_ACTIVATION_SIMULATION_REVERTED"
  | "HOOKS_ACTIVATION_REVERTED";

/** Lane-level reasons: nothing is claimed or changed while one holds. */
export type HooksLaunchExecutorIdleReason =
  | "HOOKS_EXECUTOR_WRONG_CHAIN"
  /** Decision 0150: a chain-56 slot without `LAUNCH_MAINNET_ACK`. */
  | "LAUNCH_MAINNET_NOT_ACKNOWLEDGED"
  | "HOOKS_FACTORY_CODE_MISMATCH"
  /**
   * Decision 0132: a LoopDynamic Factory whose `hookKind()` /
   * `TEMPLATE_HASH` / Hook parameters cannot be read or do not reproduce
   * `hooksLaunchLoopDynamicTemplateHash(params)`.
   */
  | "HOOKS_FACTORY_TEMPLATE_MISMATCH"
  | "HOOKS_EXECUTOR_NOT_AUTHORIZED"
  | "HOOKS_GAS_PRICE_ABOVE_CAP";

/**
 * Decision 0132: thrown by `loopDynamicTemplate()` when the Factory is not
 * a LoopDynamic Factory whose parameters reproduce its `TEMPLATE_HASH`
 * (transport failures are not this error and back off as infrastructure).
 */
export class HooksLaunchFactoryTemplateMismatchError extends Error {
  constructor() {
    super("Hooks launch Factory template mismatch");
    this.name = "HooksLaunchFactoryTemplateMismatchError";
  }
}

export class HooksLaunchExecutorIdleError extends Error {
  constructor(readonly reason: HooksLaunchExecutorIdleReason) {
    super(`Hooks launch executor idle: ${reason}`);
    this.name = "HooksLaunchExecutorIdleError";
  }
}

export interface HooksLaunchExecutorTask {
  readonly jobId: string;
  readonly projectId: string;
  readonly configVersion: number;
  readonly chainId: number;
  readonly factoryAddress: string;
  readonly projectOwner: string;
  readonly ownerNonce: string;
  readonly bindingHash: string;
  readonly memeAddress: string;
  readonly hookAddress: string;
  readonly status: HooksLaunchDeploymentStatus;
  readonly claimedBy: string | null;
  readonly attemptCount: number;
  readonly executorAddress: string | null;
  readonly txHash: string | null;
  readonly txNonce: bigint | null;
  readonly rawTx: string | null;
  readonly blockNumber: bigint | null;
  readonly blockHash: string | null;
  readonly confirmations: number | null;
  readonly launchId: string | null;
  readonly activationTxHash: string | null;
  readonly activationTxNonce: bigint | null;
  readonly activationRawTx: string | null;
  readonly activationBlockNumber: bigint | null;
  readonly activationBlockHash: string | null;
  readonly activationAttemptCount: number;
  readonly failureCode: string | null;
  readonly failureRetryable: boolean | null;
}

export interface HooksLaunchExecutorContext {
  readonly latestConfig: {
    readonly version: number;
    readonly configHash: string;
    readonly approvedHash: string | null;
  } | null;
  readonly authorizations: readonly { readonly signedPayload: unknown }[];
}

/** Mutable task columns an executor step may set (undefined = unchanged). */
export interface HooksLaunchTaskPatch {
  readonly executorAddress?: string | null;
  readonly txHash?: string | null;
  readonly txNonce?: bigint | null;
  readonly rawTx?: string | null;
  readonly blockNumber?: bigint | null;
  readonly blockHash?: string | null;
  readonly confirmations?: number | null;
  readonly launchId?: string | null;
  readonly deployedAddresses?: Readonly<Record<string, string>> | null;
  readonly verification?: Readonly<Record<string, unknown>> | null;
  readonly activationTxHash?: string | null;
  readonly activationTxNonce?: bigint | null;
  readonly activationRawTx?: string | null;
  readonly activationBlockNumber?: bigint | null;
  readonly activationBlockHash?: string | null;
  readonly activationAttemptCount?: number;
  readonly activatedAt?: "now" | null;
  readonly failureCode?: string | null;
  readonly failureRetryable?: boolean | null;
}

export interface HooksLaunchExecutorEventInput {
  readonly kind: string;
  readonly txHash?: string | null;
  readonly blockNumber?: bigint | null;
  readonly blockHash?: string | null;
  readonly confirmations?: number | null;
  readonly errorCode?: string | null;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface HooksLaunchExecutorRepository {
  /**
   * Leases at most one task not in `exclude`: `awaiting_executor` /
   * retryable `failed` (attempt + 1) and `reorged` move to `claimed`;
   * in-flight states are re-leased when expired or already ours.
   */
  acquire(input: {
    readonly executorId: string;
    /** Only tasks signed for this Factory on the configured slot are leased. */
    readonly factoryAddress: string;
    readonly maxAttempts: number;
    readonly retryDelaySeconds: number;
    readonly exclude: readonly string[];
  }): Promise<HooksLaunchExecutorTask | null>;
  context(jobId: string): Promise<HooksLaunchExecutorContext>;
  get(jobId: string): Promise<HooksLaunchExecutorTask | null>;
  /** Atomic status update + event under the caller's live lease; null = lost. */
  transition(input: {
    readonly jobId: string;
    readonly executorId: string;
    readonly from: HooksLaunchDeploymentStatus;
    readonly to: HooksLaunchDeploymentStatus;
    readonly patch: HooksLaunchTaskPatch;
    readonly event: HooksLaunchExecutorEventInput | null;
  }): Promise<HooksLaunchExecutorTask | null>;
  /**
   * In one transaction: re-checks the lease, reserves the executor nonce
   * `max(chainPendingNonce, highest pending reservation + 1)`, signs, and
   * persists the transaction (deploy: `claimed → broadcast`; activate:
   * `verified` with the activation columns) with its event. Sending
   * happens only after this commits.
   */
  reserveAndRecord(input: {
    readonly jobId: string;
    readonly executorId: string;
    readonly executorAddress: string;
    readonly purpose: "deploy" | "activate";
    readonly chainPendingNonce: bigint;
    readonly sign: (nonce: bigint) => Promise<HooksLaunchSignedTransaction>;
  }): Promise<HooksLaunchExecutorTask | null>;
  reservationPending(txHash: string): Promise<boolean>;
  releaseReservation(txHash: string): Promise<void>;
}

export interface HooksLaunchSignedTransaction {
  readonly txHash: string;
  readonly rawTx: string;
}

export interface HooksLaunchDeployCall {
  readonly request: {
    readonly projectOwner: string;
    readonly configVersion: number;
    readonly configHash: string;
    readonly name: string;
    readonly ticker: string;
    readonly nftSaleStart: bigint;
    readonly buybackRecipient: string;
    readonly deadline: bigint;
    readonly memeSalt: string;
  };
  readonly hookSalt: string;
  readonly signature: string;
}

export interface HooksLaunchTxParameters {
  readonly nonce: bigint;
  readonly gas: bigint;
  readonly gasPrice: bigint;
}

export interface HooksLaunchReceipt {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly launchDeployed: HooksLaunchDeployedEvent | null;
}

export type HooksLaunchSendResult =
  "accepted" | "known" | "nonce_too_low" | "insufficient_funds" | "rejected";

/** Thrown by estimates whose call reverts; `reason` is a contract error name. */
export class HooksLaunchChainRevertError extends Error {
  constructor(readonly reason: string) {
    super(`Hooks launch call reverted: ${reason}`);
    this.name = "HooksLaunchChainRevertError";
  }
}

export interface HooksLaunchExecutorChain {
  readonly executorAddress: string;
  readonly factoryAddress: string;
  /** Decision 0132: the Factory's Hook kind (absent = officialTax). */
  readonly hookKind?: "officialTax" | "loopDynamic";
  /**
   * Decision 0132 (loopDynamic): the Factory's Hook parameters and its
   * `TEMPLATE_HASH`, verified equal to
   * `hooksLaunchLoopDynamicTemplateHash(params)`; throws when unreadable or
   * different.
   */
  loopDynamicTemplate?(): Promise<{
    readonly params: HooksLaunchLoopDynamicParams;
    readonly templateHash: string;
  }>;
  chainId(): Promise<number>;
  codeHash(address: string): Promise<string | null>;
  deploymentExecutor(): Promise<string>;
  activationBufferSeconds(): Promise<bigint>;
  ownerNonce(projectOwner: string): Promise<bigint>;
  launchIdByOwnerVersion(
    projectOwner: string,
    configVersion: number,
  ): Promise<string>;
  latestBlock(): Promise<{
    readonly number: bigint;
    readonly timestamp: bigint;
  }>;
  blockHash(blockNumber: bigint): Promise<string | null>;
  transactionCount(blockTag: "latest" | "pending"): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  estimateDeploy(call: HooksLaunchDeployCall): Promise<bigint>;
  estimateActivate(launchId: string, configHash: string): Promise<bigint>;
  signDeploy(
    call: HooksLaunchDeployCall,
    tx: HooksLaunchTxParameters,
  ): Promise<HooksLaunchSignedTransaction>;
  signActivate(
    launchId: string,
    configHash: string,
    tx: HooksLaunchTxParameters,
  ): Promise<HooksLaunchSignedTransaction>;
  sendRaw(rawTx: string): Promise<HooksLaunchSendResult>;
  receipt(txHash: string): Promise<HooksLaunchReceipt | null>;
  /** Decision 0132: a LoopDynamic chain answers LoopDynamic facts. */
  readLaunch(
    launchId: string,
  ): Promise<HooksLaunchOnChainFacts | HooksLaunchLoopDynamicOnChainFacts>;
  gatePublished(gate: string): Promise<boolean>;
}

export interface HooksLaunchExecutorPolicy {
  /**
   * Decision 0150: the configured launch slot (absent = BSC Testnet, the
   * pre-0150 constant). The node must report this chain, the task must be
   * signed for it, and chain 56 also needs the ack.
   */
  readonly launchSlot?: LaunchSlotPolicy;
  /**
   * Decision 0132: the target Factory's Hook kind (absent = officialTax).
   * Must equal the chain client's; a mismatch idles the lane.
   */
  readonly hookKind?: "officialTax" | "loopDynamic";
  readonly factoryCodeHash: string;
  readonly confirmations: number;
  readonly maxAttempts: number;
  readonly retryDelaySeconds: number;
  readonly gasLimitCap: bigint;
  readonly maxGasPriceWei: bigint;
  /** Seconds a signature must still be valid when the executor signs. */
  readonly deadlineMarginSeconds: number;
  /** Seconds of slack required before the activation window closes. */
  readonly activationMarginSeconds: number;
  /** Tasks advanced per tick. */
  readonly tasksPerTick: number;
}

export const hooksLaunchExecutorDefaults = Object.freeze({
  confirmations: 3,
  maxAttempts: 3,
  retryDelaySeconds: 60,
  leaseSeconds: 120,
  pollIntervalMs: 5_000,
  gasLimitCap: 16_000_000n,
  maxGasPriceGwei: 20,
  deadlineMarginSeconds: 60,
  activationMarginSeconds: 120,
  tasksPerTick: 8,
});

export interface HooksLaunchExecutorStepEvent {
  readonly jobId: string;
  readonly from: HooksLaunchDeploymentStatus;
  readonly to: HooksLaunchDeploymentStatus;
  readonly kind: string;
  readonly txHash: string | null;
  readonly errorCode: string | null;
}

export interface HooksLaunchExecutorTickResult {
  readonly idleReason: HooksLaunchExecutorIdleReason | null;
  readonly processed: number;
  readonly transitions: number;
}

export interface HooksLaunchExecutor {
  readonly executorId: string;
  runOnce(signal?: AbortSignal): Promise<HooksLaunchExecutorTickResult>;
}

const zeroBytes32 = `0x${"0".repeat(64)}`;

function parseAuthorization(
  payload: unknown,
): HooksLaunchSignedSubmission | null {
  const parsed = hooksLaunchSubmissionSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

async function authorizationValid(input: {
  readonly task: HooksLaunchExecutorTask;
  readonly payload: HooksLaunchSignedSubmission;
  /** Decision 0132: a LoopDynamic Factory's `TEMPLATE_HASH`. */
  readonly templateHash: string | null;
  /** Decision 0150: the configured slot; a task of another chain fails. */
  readonly chainReference: number;
}): Promise<boolean> {
  const { task, payload } = input;
  const request = payload.request;
  try {
    if (
      hooksLaunchBindingHash({
        factoryAddress: task.factoryAddress,
        request,
        hookSalt: payload.hookSalt,
        memeAddress: task.memeAddress,
        hookAddress: task.hookAddress,
      }) !== task.bindingHash ||
      request.projectOwner.toLowerCase() !== task.projectOwner ||
      request.configVersion !== task.configVersion ||
      request.nonce !== task.ownerNonce
    ) {
      return false;
    }
    const typed = createHooksLaunchDeploymentTypedData({
      chainId: input.chainReference,
      verifyingContract: task.factoryAddress,
      request,
      ...(input.templateHash === null
        ? {}
        : { templateHash: input.templateHash }),
    });
    const digest = hashTypedData({
      ...typed,
      message: {
        ...typed.message,
        nftSaleStart: BigInt(request.nftSaleStart),
        deadline: BigInt(request.deadline),
        nonce: BigInt(request.nonce),
      },
    });
    const signer = await recoverAddress({
      hash: digest,
      signature: payload.signature as Hex,
    });
    return signer.toLowerCase() === task.projectOwner;
  } catch {
    return false;
  }
}

function deployCallOf(
  payload: HooksLaunchSignedSubmission,
): HooksLaunchDeployCall {
  const request = payload.request;
  return Object.freeze({
    request: Object.freeze({
      projectOwner: request.projectOwner.toLowerCase(),
      configVersion: request.configVersion,
      configHash: request.configHash.toLowerCase(),
      name: request.name,
      ticker: request.ticker,
      nftSaleStart: BigInt(request.nftSaleStart),
      buybackRecipient: request.buybackRecipient.toLowerCase(),
      deadline: BigInt(request.deadline),
      memeSalt: request.memeSalt.toLowerCase(),
    }),
    hookSalt: payload.hookSalt.toLowerCase(),
    signature: payload.signature.toLowerCase(),
  });
}

function deployedAddresses(
  launchId: string,
  modules: HooksLaunchModules,
): Record<string, string> {
  return {
    launchId,
    meme: modules.meme,
    hook: modules.officialHook,
    nft: modules.nft,
    curve: modules.curve,
    gate: modules.gate,
    escrow: modules.escrow,
    snapshots: modules.snapshots,
    graduationAdapter: modules.graduationAdapter,
    buybackAdapter: modules.buybackAdapter,
    priceRecorder: modules.priceRecorder,
    buybackExecutor: modules.buybackExecutor,
  };
}

/** Internal: a step's outcome for the tick loop. */
type StepOutcome = "advanced" | "waiting" | "lost";

export function createHooksLaunchExecutor(options: {
  readonly repository: HooksLaunchExecutorRepository;
  readonly chain: HooksLaunchExecutorChain;
  readonly policy: HooksLaunchExecutorPolicy;
  readonly executorId: string;
  /** Wall clock, unix seconds (test seam). */
  readonly now?: () => number;
  readonly onStep?: (event: HooksLaunchExecutorStepEvent) => void;
}): HooksLaunchExecutor {
  const { repository, chain, policy, executorId } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const executorAddress = chain.executorAddress.toLowerCase();
  let transitions = 0;
  const loopDynamic = (policy.hookKind ?? "officialTax") === "loopDynamic";
  const slot = policy.launchSlot ?? testnetLaunchSlot;
  /**
   * Decision 0132: the LoopDynamic template verified by this tick's
   * preflight (null for OfficialTax: the constant template, no read).
   */
  let template: {
    readonly params: HooksLaunchLoopDynamicParams;
    readonly templateHash: string;
  } | null = null;

  async function move(
    task: HooksLaunchExecutorTask,
    to: HooksLaunchDeploymentStatus,
    patch: HooksLaunchTaskPatch,
    event: HooksLaunchExecutorEventInput | null,
  ): Promise<HooksLaunchExecutorTask | null> {
    const next = await repository.transition({
      jobId: task.jobId,
      executorId,
      from: task.status,
      to,
      patch,
      event,
    });
    if (next !== null && event !== null) {
      transitions += 1;
      options.onStep?.({
        jobId: task.jobId,
        from: task.status,
        to,
        kind: event.kind,
        txHash: event.txHash ?? null,
        errorCode: event.errorCode ?? null,
      });
    }
    return next;
  }

  async function fail(
    task: HooksLaunchExecutorTask,
    code: HooksLaunchExecutorFailureCode,
    input: {
      readonly retryable: boolean;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly patch?: HooksLaunchTaskPatch;
    },
  ): Promise<StepOutcome> {
    // A retryable failure becomes final once the attempt budget is spent.
    const retryable = input.retryable && task.attemptCount < policy.maxAttempts;
    const next = await move(
      task,
      "failed",
      { ...input.patch, failureCode: code, failureRetryable: retryable },
      {
        kind: "failed",
        errorCode: code,
        txHash: input.patch?.txHash ?? task.txHash,
        details: { retryable, ...input.details },
      },
    );
    return next === null ? "lost" : "waiting";
  }

  async function canonical(receipt: HooksLaunchReceipt): Promise<boolean> {
    const hash = await chain.blockHash(receipt.blockNumber);
    return hash !== null && hash.toLowerCase() === receipt.blockHash;
  }

  async function confirmationsOf(blockNumber: bigint): Promise<number> {
    const head = await chain.latestBlock();
    const count = head.number - blockNumber + 1n;
    return count < 0n ? 0 : Number(count > 1_000_000n ? 1_000_000n : count);
  }

  async function chooseAuthorization(
    task: HooksLaunchExecutorTask,
    context: HooksLaunchExecutorContext,
  ): Promise<HooksLaunchSignedSubmission | null> {
    let best: HooksLaunchSignedSubmission | null = null;
    for (const entry of context.authorizations) {
      const payload = parseAuthorization(entry.signedPayload);
      if (payload === null) continue;
      if (
        !(await authorizationValid({
          task,
          payload,
          templateHash: template?.templateHash ?? null,
          chainReference: slot.chainReference,
        }))
      )
        continue;
      if (
        best === null ||
        BigInt(payload.request.deadline) > BigInt(best.request.deadline)
      ) {
        best = payload;
      }
    }
    return best;
  }

  /** Re-checks everything a signed task depends on; null = keep going. */
  async function preconditions(task: HooksLaunchExecutorTask): Promise<
    | {
        readonly kind: "ok";
        readonly payload: HooksLaunchSignedSubmission;
        readonly blockTimestamp: bigint;
      }
    | { readonly kind: "stop"; readonly outcome: StepOutcome }
  > {
    const context = await repository.context(task.jobId);
    const latest = context.latestConfig;
    const payload = await chooseAuthorization(task, context);
    if (payload === null) {
      return {
        kind: "stop",
        outcome: await fail(task, "HOOKS_AUTHORIZATION_INVALID", {
          retryable: false,
        }),
      };
    }
    const signedHash = payload.request.configHash.toLowerCase();
    if (
      latest === null ||
      latest.version !== task.configVersion ||
      latest.configHash !== signedHash
    ) {
      return {
        kind: "stop",
        outcome: await fail(task, "HOOKS_CONFIG_SUPERSEDED", {
          retryable: false,
        }),
      };
    }
    if (latest.approvedHash !== latest.configHash) {
      return {
        kind: "stop",
        outcome: await fail(task, "HOOKS_CONFIG_NOT_APPROVED", {
          retryable: false,
        }),
      };
    }
    const block = await chain.latestBlock();
    const reference = BigInt(Math.max(now(), 0));
    const clock = block.timestamp > reference ? block.timestamp : reference;
    if (
      BigInt(payload.request.deadline) <=
      clock + BigInt(policy.deadlineMarginSeconds)
    ) {
      return {
        kind: "stop",
        outcome: await fail(task, "HOOKS_SIGNATURE_EXPIRED", {
          retryable: false,
        }),
      };
    }
    return { kind: "ok", payload, blockTimestamp: block.timestamp };
  }

  async function sendRecorded(
    task: HooksLaunchExecutorTask,
    rawTx: string,
    txHash: string,
  ): Promise<StepOutcome> {
    const result = await chain.sendRaw(rawTx);
    if (result === "accepted" || result === "known") return "advanced";
    if (result === "nonce_too_low") {
      // Mined already (ours) or taken by another transaction; the receipt
      // step decides. Never re-sign here.
      return "waiting";
    }
    await repository.releaseReservation(txHash);
    return fail(
      task,
      result === "insufficient_funds"
        ? "HOOKS_EXECUTOR_FUNDS_INSUFFICIENT"
        : "HOOKS_BROADCAST_REJECTED",
      { retryable: true },
    );
  }

  async function stepClaimed(
    task: HooksLaunchExecutorTask,
  ): Promise<StepOutcome> {
    const checked = await preconditions(task);
    if (checked.kind === "stop") return checked.outcome;
    const { payload } = checked;
    const call = deployCallOf(payload);

    // A previously recorded transaction (reorg or retry) is reused while
    // its nonce is still ours: same bytes, same hash, never a second launch.
    if (task.txHash !== null && task.rawTx !== null && task.txNonce !== null) {
      const receipt = await chain.receipt(task.txHash);
      if (receipt !== null && receipt.status === "success") {
        const next = await move(
          task,
          "broadcast",
          {
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash,
            confirmations: await confirmationsOf(receipt.blockNumber),
          },
          {
            kind: "receipt_found",
            txHash: task.txHash,
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash,
          },
        );
        return next === null ? "lost" : "advanced";
      }
      if (receipt === null) {
        const latestNonce = await chain.transactionCount("latest");
        if (
          latestNonce > task.txNonce &&
          (await chain.receipt(task.txHash)) !== null
        ) {
          // Mined between the two reads; the next tick takes the receipt.
          return "waiting";
        }
        if (
          latestNonce <= task.txNonce &&
          (await repository.reservationPending(task.txHash))
        ) {
          const next = await move(
            task,
            "broadcast",
            { blockNumber: null, blockHash: null, confirmations: null },
            { kind: "rebroadcast", txHash: task.txHash },
          );
          if (next === null) return "lost";
          return sendRecorded(next, task.rawTx, task.txHash);
        }
      }
    }

    const [ownerNonce, existingLaunch] = await Promise.all([
      chain.ownerNonce(task.projectOwner),
      chain.launchIdByOwnerVersion(task.projectOwner, task.configVersion),
    ]);
    if (existingLaunch.toLowerCase() !== zeroBytes32) {
      return fail(task, "HOOKS_LAUNCH_ALREADY_DEPLOYED", { retryable: false });
    }
    if (ownerNonce.toString() !== task.ownerNonce) {
      return fail(task, "HOOKS_OWNER_NONCE_CONSUMED", { retryable: false });
    }
    const buffer = await chain.activationBufferSeconds();
    if (
      call.request.nftSaleStart <=
      checked.blockTimestamp + buffer + BigInt(policy.activationMarginSeconds)
    ) {
      return fail(task, "HOOKS_ACTIVATION_WINDOW_CLOSED", {
        retryable: false,
      });
    }
    let estimate: bigint;
    try {
      estimate = await chain.estimateDeploy(call);
    } catch (error) {
      if (error instanceof HooksLaunchChainRevertError) {
        return fail(task, "HOOKS_DEPLOY_SIMULATION_REVERTED", {
          retryable: false,
          details: { revert: error.reason },
        });
      }
      throw error;
    }
    const gas = (estimate * 125n) / 100n;
    if (gas > policy.gasLimitCap) {
      return fail(task, "HOOKS_DEPLOY_GAS_ABOVE_CAP", {
        retryable: false,
        details: { gasEstimate: estimate.toString() },
      });
    }
    const gasPrice = await chain.gasPrice();
    if (gasPrice > policy.maxGasPriceWei) {
      throw new HooksLaunchExecutorIdleError("HOOKS_GAS_PRICE_ABOVE_CAP");
    }
    const pending = await chain.transactionCount("pending");
    const recorded = await repository.reserveAndRecord({
      jobId: task.jobId,
      executorId,
      executorAddress,
      purpose: "deploy",
      chainPendingNonce: pending,
      sign: (nonce) => chain.signDeploy(call, { nonce, gas, gasPrice }),
    });
    if (
      recorded === null ||
      recorded.rawTx === null ||
      recorded.txHash === null
    )
      return "lost";
    transitions += 1;
    options.onStep?.({
      jobId: task.jobId,
      from: "claimed",
      to: "broadcast",
      kind: "broadcast",
      txHash: recorded.txHash,
      errorCode: null,
    });
    return sendRecorded(recorded, recorded.rawTx, recorded.txHash);
  }

  /** Reorg / drop / revert handling shared by deploy-tracking states. */
  async function trackDeploy(
    task: HooksLaunchExecutorTask,
  ): Promise<
    | { readonly kind: "receipt"; readonly receipt: HooksLaunchReceipt }
    | { readonly kind: "stop"; readonly outcome: StepOutcome }
  > {
    const txHash = task.txHash!;
    const receipt = await chain.receipt(txHash);
    const reorg = async (): Promise<StepOutcome> => {
      const next = await move(
        task,
        "reorged",
        {
          blockNumber: null,
          blockHash: null,
          confirmations: null,
          launchId: null,
          deployedAddresses: null,
          verification: null,
          activationBlockNumber: null,
          activationBlockHash: null,
        },
        {
          kind: "reorg_detected",
          txHash,
          blockNumber: task.blockNumber,
          blockHash: task.blockHash,
          details: {
            observedBlockHash: receipt?.blockHash ?? null,
          },
        },
      );
      return next === null ? "lost" : "advanced";
    };
    if (receipt === null) {
      if (task.blockHash !== null) {
        return { kind: "stop", outcome: await reorg() };
      }
      const latestNonce = await chain.transactionCount("latest");
      if (task.txNonce !== null && latestNonce > task.txNonce) {
        // The nonce moved: either our transaction was mined between the two
        // reads (look again) or another one consumed it (dropped).
        if ((await chain.receipt(txHash)) !== null) {
          return { kind: "stop", outcome: "waiting" };
        }
        await repository.releaseReservation(txHash);
        return {
          kind: "stop",
          outcome: await fail(task, "HOOKS_TX_DROPPED", { retryable: true }),
        };
      }
      // Still pending (or lost by a node): re-send the same bytes.
      await chain.sendRaw(task.rawTx!);
      return { kind: "stop", outcome: "waiting" };
    }
    if (task.blockHash !== null && receipt.blockHash !== task.blockHash) {
      return { kind: "stop", outcome: await reorg() };
    }
    if (!(await canonical(receipt))) {
      return { kind: "stop", outcome: "waiting" };
    }
    return { kind: "receipt", receipt };
  }

  async function stepBroadcast(
    task: HooksLaunchExecutorTask,
  ): Promise<StepOutcome> {
    const tracked = await trackDeploy(task);
    if (tracked.kind === "stop") return tracked.outcome;
    const { receipt } = tracked;
    if (receipt.status === "reverted") {
      return fail(task, "HOOKS_DEPLOY_REVERTED", {
        retryable: true,
        patch: {
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
        },
      });
    }
    const confirmations = await confirmationsOf(receipt.blockNumber);
    const blockPatch = {
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      confirmations,
    };
    if (confirmations >= policy.confirmations) {
      const next = await move(task, "confirmed", blockPatch, {
        kind: "confirmed",
        txHash: task.txHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        confirmations,
      });
      return next === null ? "lost" : "advanced";
    }
    if (
      task.blockHash === receipt.blockHash &&
      task.confirmations === confirmations
    ) {
      return "waiting";
    }
    const next = await move(
      task,
      "broadcast",
      blockPatch,
      task.blockHash === null
        ? {
            kind: "included",
            txHash: task.txHash,
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash,
            confirmations,
          }
        : null,
    );
    return next === null ? "lost" : "waiting";
  }

  function expectedOf(
    task: HooksLaunchExecutorTask,
    payload: HooksLaunchSignedSubmission,
  ): HooksLaunchExpectedDeployment {
    const request = payload.request;
    return {
      factoryAddress: task.factoryAddress,
      factoryCodeHash: policy.factoryCodeHash,
      launchId: hooksLaunchId({
        chainId: slot.chainReference,
        factory: task.factoryAddress,
        projectOwner: task.projectOwner,
        configVersion: task.configVersion,
        configHash: request.configHash,
      }).toLowerCase(),
      projectOwner: task.projectOwner,
      configVersion: task.configVersion,
      configHash: request.configHash.toLowerCase(),
      name: request.name,
      ticker: request.ticker,
      nftSaleStart: BigInt(request.nftSaleStart),
      buybackRecipient: request.buybackRecipient.toLowerCase(),
      hookSalt: payload.hookSalt.toLowerCase(),
      predictedMemeAddress: task.memeAddress,
      predictedHookAddress: task.hookAddress,
    };
  }

  async function stepConfirmed(
    task: HooksLaunchExecutorTask,
  ): Promise<StepOutcome> {
    const tracked = await trackDeploy(task);
    if (tracked.kind === "stop") return tracked.outcome;
    const context = await repository.context(task.jobId);
    const payload = await chooseAuthorization(task, context);
    if (payload === null) {
      return fail(task, "HOOKS_AUTHORIZATION_INVALID", { retryable: false });
    }
    const expected = expectedOf(task, payload);
    const facts = await chain.readLaunch(expected.launchId);
    // Decision 0132: LoopDynamic modules are verified against the template
    // this tick's preflight read; a Factory / facts kind mismatch fails.
    const factsDynamic = "hookKind" in facts;
    const result =
      factsDynamic !== loopDynamic
        ? {
            passed: false,
            failedChecks: ["factory_template"],
            passedChecks: [],
          }
        : factsDynamic
          ? template === null
            ? {
                passed: false,
                failedChecks: ["factory_template"],
                passedChecks: [],
              }
            : verifyHooksLaunchLoopDynamicDeployment({
                expected,
                template,
                event: tracked.receipt.launchDeployed,
                facts: facts,
              })
          : verifyHooksLaunchDeployment({
              expected,
              event: tracked.receipt.launchDeployed,
              facts: facts,
            });
    if (!result.passed || facts.modules === null) {
      return fail(task, "HOOKS_VERIFICATION_MISMATCH", {
        retryable: false,
        details: { failedChecks: result.failedChecks },
      });
    }
    const codeHashes: Record<string, string | null> = {};
    for (const [address, hash] of Object.entries(facts.codeHashes)) {
      codeHashes[address] = hash;
    }
    const next = await move(
      task,
      "verified",
      {
        launchId: expected.launchId,
        deployedAddresses: deployedAddresses(expected.launchId, facts.modules),
        verification: {
          checks: result.passedChecks,
          codeHashes,
          factoryCodeHash: facts.factoryCodeHash,
          // Decision 0119: the verified sale window (decimal Unix seconds)
          // the launch2 read model derives `nft_sale` / its end from.
          nftSaleDurationSeconds: facts.factory.nftSaleDuration.toString(10),
          nftSaleEnd: (facts.nft?.saleEnd ?? 0n).toString(10),
          // Decision 0152: the verified per-address curve purchase cap
          // (S209: the Factory's maxCumulativeBuy) the launch2 read model
          // shows (`launch2_instances` → curve_purchase_cap).
          curveMaxCumulativeBuy: (facts.curve?.maxCumulativeBuy ?? 0n).toString(
            10,
          ),
          ...(facts.factory.nftSaleDurationLegacy
            ? { legacyFactory: true }
            : {}),
          // Decision 0132: what the LoopDynamic launch was verified against.
          ...(factsDynamic && template !== null
            ? {
                hookKind: "loopDynamic",
                templateHash: template.templateHash,
              }
            : {}),
        },
      },
      {
        kind: "verified",
        txHash: task.txHash,
        details: {
          checks: result.passedChecks.length,
          nftSaleDurationSeconds: Number(facts.factory.nftSaleDuration),
          ...(facts.factory.nftSaleDurationLegacy
            ? { legacyFactory: true }
            : {}),
        },
      },
    );
    return next === null ? "lost" : "advanced";
  }

  async function stepVerified(
    task: HooksLaunchExecutorTask,
  ): Promise<StepOutcome> {
    const tracked = await trackDeploy(task);
    if (tracked.kind === "stop") return tracked.outcome;
    const context = await repository.context(task.jobId);
    const payload = await chooseAuthorization(task, context);
    if (payload === null || task.launchId === null) {
      return fail(task, "HOOKS_AUTHORIZATION_INVALID", { retryable: false });
    }
    const expected = expectedOf(task, payload);
    const configHash = expected.configHash;
    const facts = await chain.readLaunch(task.launchId);
    const gate = facts.modules?.gate ?? null;
    if (gate === null) {
      return fail(task, "HOOKS_VERIFICATION_MISMATCH", {
        retryable: false,
        details: { failedChecks: ["launch_registered"] },
      });
    }

    if (task.activationTxHash === null) {
      if (await chain.gatePublished(gate)) {
        return fail(task, "HOOKS_ACTIVATION_STATE_UNEXPECTED", {
          retryable: false,
        });
      }
      const [block, buffer] = await Promise.all([
        chain.latestBlock(),
        chain.activationBufferSeconds(),
      ]);
      if (
        block.timestamp + buffer + BigInt(policy.activationMarginSeconds) >=
        expected.nftSaleStart
      ) {
        return fail(task, "HOOKS_ACTIVATION_WINDOW_CLOSED", {
          retryable: false,
        });
      }
      let estimate: bigint;
      try {
        estimate = await chain.estimateActivate(task.launchId, configHash);
      } catch (error) {
        if (error instanceof HooksLaunchChainRevertError) {
          return fail(task, "HOOKS_ACTIVATION_SIMULATION_REVERTED", {
            retryable: false,
            details: { revert: error.reason },
          });
        }
        throw error;
      }
      const gasPrice = await chain.gasPrice();
      if (gasPrice > policy.maxGasPriceWei) {
        throw new HooksLaunchExecutorIdleError("HOOKS_GAS_PRICE_ABOVE_CAP");
      }
      const gas = (estimate * 150n) / 100n;
      const pending = await chain.transactionCount("pending");
      const recorded = await repository.reserveAndRecord({
        jobId: task.jobId,
        executorId,
        executorAddress,
        purpose: "activate",
        chainPendingNonce: pending,
        sign: (nonce) =>
          chain.signActivate(task.launchId!, configHash, {
            nonce,
            gas,
            gasPrice,
          }),
      });
      if (
        recorded === null ||
        recorded.activationRawTx === null ||
        recorded.activationTxHash === null
      )
        return "lost";
      transitions += 1;
      options.onStep?.({
        jobId: task.jobId,
        from: "verified",
        to: "verified",
        kind: "activation_broadcast",
        txHash: recorded.activationTxHash,
        errorCode: null,
      });
      const sent = await chain.sendRaw(recorded.activationRawTx);
      if (sent === "insufficient_funds" || sent === "rejected") {
        await repository.releaseReservation(recorded.activationTxHash);
        const cleared = await move(
          recorded,
          "verified",
          {
            activationTxHash: null,
            activationTxNonce: null,
            activationRawTx: null,
          },
          {
            kind: "activation_rejected",
            txHash: recorded.activationTxHash,
            errorCode:
              sent === "insufficient_funds"
                ? "HOOKS_EXECUTOR_FUNDS_INSUFFICIENT"
                : "HOOKS_BROADCAST_REJECTED",
          },
        );
        return cleared === null ? "lost" : "waiting";
      }
      return "advanced";
    }

    const activationHash = task.activationTxHash;
    const clearActivation = async (
      kind: string,
      errorCode: string | null,
    ): Promise<StepOutcome> => {
      const next = await move(
        task,
        "verified",
        {
          activationTxHash: null,
          activationTxNonce: null,
          activationRawTx: null,
          activationBlockNumber: null,
          activationBlockHash: null,
        },
        { kind, txHash: activationHash, errorCode },
      );
      return next === null ? "lost" : "advanced";
    };
    const receipt = await chain.receipt(activationHash);
    if (receipt === null) {
      if (task.activationBlockHash !== null) {
        // The activation block left the canonical chain: send it again.
        const next = await move(
          task,
          "verified",
          { activationBlockNumber: null, activationBlockHash: null },
          {
            kind: "activation_reorged",
            txHash: activationHash,
            blockNumber: task.activationBlockNumber,
            blockHash: task.activationBlockHash,
          },
        );
        if (next === null) return "lost";
        await chain.sendRaw(task.activationRawTx!);
        return "waiting";
      }
      const latestNonce = await chain.transactionCount("latest");
      if (
        task.activationTxNonce !== null &&
        latestNonce > task.activationTxNonce
      ) {
        if ((await chain.receipt(activationHash)) !== null) return "waiting";
        await repository.releaseReservation(activationHash);
        return clearActivation("activation_dropped", "HOOKS_TX_DROPPED");
      }
      await chain.sendRaw(task.activationRawTx!);
      return "waiting";
    }
    if (!(await canonical(receipt))) return "waiting";
    if (receipt.status === "reverted") {
      if (task.activationAttemptCount >= policy.maxAttempts) {
        return fail(task, "HOOKS_ACTIVATION_REVERTED", {
          retryable: false,
          details: { activationTxHash: activationHash },
        });
      }
      return clearActivation(
        "activation_reverted",
        "HOOKS_ACTIVATION_REVERTED",
      );
    }
    const confirmations = await confirmationsOf(receipt.blockNumber);
    const published = await chain.gatePublished(gate);
    if (confirmations >= policy.confirmations && published) {
      const next = await move(
        task,
        "activated",
        {
          activationBlockNumber: receipt.blockNumber,
          activationBlockHash: receipt.blockHash,
          activatedAt: "now",
        },
        {
          kind: "activated",
          txHash: activationHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          confirmations,
        },
      );
      return next === null ? "lost" : "advanced";
    }
    if (task.activationBlockHash !== receipt.blockHash) {
      const next = await move(
        task,
        "verified",
        {
          activationBlockNumber: receipt.blockNumber,
          activationBlockHash: receipt.blockHash,
        },
        task.activationBlockHash === null
          ? {
              kind: "activation_included",
              txHash: activationHash,
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash,
              confirmations,
            }
          : {
              kind: "activation_reorged",
              txHash: activationHash,
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash,
            },
      );
      return next === null ? "lost" : "waiting";
    }
    return "waiting";
  }

  async function step(task: HooksLaunchExecutorTask): Promise<StepOutcome> {
    switch (task.status) {
      case "claimed":
        return stepClaimed(task);
      case "broadcast":
        return stepBroadcast(task);
      case "confirmed":
        return stepConfirmed(task);
      case "verified":
        return stepVerified(task);
      default:
        return "waiting";
    }
  }

  return Object.freeze({
    executorId,
    async runOnce(
      signal?: AbortSignal,
    ): Promise<HooksLaunchExecutorTickResult> {
      transitions = 0;
      // Lane preflight: wrong chain, a different Factory, or an executor
      // key the Factory does not authorize keeps every task untouched.
      const [chainId, factoryHash, authorized] = await Promise.all([
        chain.chainId(),
        chain.codeHash(chain.factoryAddress),
        chain.deploymentExecutor(),
      ]);
      const idle = (
        reason: HooksLaunchExecutorIdleReason,
      ): HooksLaunchExecutorTickResult => ({
        idleReason: reason,
        processed: 0,
        transitions: 0,
      });
      // Decision 0150: the configured slot (97 unchanged; 56 needs the ack).
      const slotRefusal = launchSlotRefusal(slot, chainId);
      if (slotRefusal === "wrong_chain")
        return idle("HOOKS_EXECUTOR_WRONG_CHAIN");
      if (slotRefusal === "not_acknowledged")
        return idle("LAUNCH_MAINNET_NOT_ACKNOWLEDGED");
      if (
        factoryHash === null ||
        factoryHash.toLowerCase() !== policy.factoryCodeHash.toLowerCase()
      )
        return idle("HOOKS_FACTORY_CODE_MISMATCH");
      if (authorized.toLowerCase() !== executorAddress)
        return idle("HOOKS_EXECUTOR_NOT_AUTHORIZED");
      // Decision 0132: the client and the policy name the same Hook kind,
      // and a LoopDynamic Factory's template reproduces from its
      // parameters (read every tick; immutable, so the client may cache).
      if (
        (chain.hookKind ?? "officialTax") !== (policy.hookKind ?? "officialTax")
      )
        return idle("HOOKS_FACTORY_TEMPLATE_MISMATCH");
      template = null;
      if (loopDynamic) {
        if (chain.loopDynamicTemplate === undefined) {
          return idle("HOOKS_FACTORY_TEMPLATE_MISMATCH");
        }
        let read: Awaited<
          ReturnType<
            NonNullable<HooksLaunchExecutorChain["loopDynamicTemplate"]>
          >
        >;
        try {
          read = await chain.loopDynamicTemplate();
        } catch (error) {
          if (error instanceof HooksLaunchFactoryTemplateMismatchError) {
            return idle("HOOKS_FACTORY_TEMPLATE_MISMATCH");
          }
          throw error;
        }
        if (!/^0x[0-9a-f]{64}$/u.test(read.templateHash.toLowerCase())) {
          return idle("HOOKS_FACTORY_TEMPLATE_MISMATCH");
        }
        template = {
          params: read.params,
          templateHash: read.templateHash.toLowerCase(),
        };
      }

      const seen: string[] = [];
      let processed = 0;
      const aborted = (): boolean => signal?.aborted === true;
      try {
        while (seen.length < policy.tasksPerTick && !aborted()) {
          let task = await repository.acquire({
            executorId,
            factoryAddress: chain.factoryAddress.toLowerCase(),
            maxAttempts: policy.maxAttempts,
            retryDelaySeconds: policy.retryDelaySeconds,
            exclude: seen,
          });
          if (task === null) break;
          seen.push(task.jobId);
          processed += 1;
          // Advance one task as far as it goes without waiting on the chain.
          for (let hop = 0; hop < 8 && !aborted(); hop += 1) {
            const outcome = await step(task);
            if (outcome !== "advanced") break;
            const again = await repository.get(task.jobId);
            if (again === null || again.claimedBy !== executorId) break;
            task = again;
          }
        }
      } catch (error) {
        if (error instanceof HooksLaunchExecutorIdleError) {
          return { idleReason: error.reason, processed, transitions };
        }
        throw error;
      }
      return { idleReason: null, processed, transitions };
    },
  });
}
