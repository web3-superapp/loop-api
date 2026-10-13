/**
 * Decision 0121: the `launch2_buyback_keeper` lane. For every graduated
 * MEME v2 instance whose buyback is not paused it calls
 * `BuybackExecutor.execute()` from a Factory keeper account, under the
 * contract's own rules (one order = min(escrow budget, `ORDER_AMOUNT`),
 * at least `MIN_SUCCESS_INTERVAL` between successes, the locked-principal
 * guard, pause; Decision 0122: no price protection on the v3 Factory, the
 * v2 instances keep theirs):
 *
 * 1. pre-checks on chain (keeper of this executor, escrow binding, not
 *    paused, budget > 0, interval elapsed) — a failed pre-check is a
 *    waiting reason, never a row;
 * 2. simulates `execute()` from the keeper. A refusal is classified from
 *    the contract error name and recorded as a `rejected` attempt
 *    (consecutive refusals with the same reason refresh one row and back
 *    off exponentially); nothing is sent;
 * 3. a passing simulation is a `pending` attempt written first; the signed
 *    transaction (hash / nonce / raw bytes, nonce reserved under the
 *    account lock shared with the Hooks executor and the snapshot
 *    publisher — Decision 0112) is recorded before it is sent;
 * 4. follows the receipt to `confirmed` (`confirmations` deep, canonical),
 *    then waits until the `launch2_event` lane's ledger row for the same
 *    transaction exists (`buyback_id`), before the next order.
 *
 * The ledger (`launch2_buybacks`) stays the lane's, from `BuybackCompleted`
 * only; the keeper never writes it. Fail closed: anything unknown leaves
 * the instance waiting with a reason code.
 */

export const launch2BuybackKeeperLane = "launch2_buyback_keeper";

export const launch2BuybackAttemptStatuses = Object.freeze([
  "rejected",
  "pending",
  "broadcast",
  "confirmed",
  "failed",
] as const);
export type Launch2BuybackAttemptStatus =
  (typeof launch2BuybackAttemptStatuses)[number];

export const launch2KeeperReasonCodes = Object.freeze({
  // Lane level.
  chainMismatch: "LAUNCH2_BUYBACK_KEEPER_CHAIN_MISMATCH",
  notAuthorized: "LAUNCH2_BUYBACK_KEEPER_NOT_AUTHORIZED",
  // Pre-checks and refusals (the same code whether seen in a view or in
  // the simulation's contract error).
  paused: "LAUNCH2_BUYBACK_PAUSED",
  noBudget: "LAUNCH2_BUYBACK_NO_BUDGET",
  tooSoon: "LAUNCH2_BUYBACK_TOO_SOON",
  notKeeper: "LAUNCH2_BUYBACK_NOT_KEEPER",
  notGraduated: "LAUNCH2_BUYBACK_NOT_GRADUATED",
  escrowMismatch: "LAUNCH2_BUYBACK_ESCROW_MISMATCH",
  // v2-generation (legacy) price protection only (Decision 0122).
  referenceUnavailable: "LAUNCH2_BUYBACK_REFERENCE_UNAVAILABLE",
  spotOutsideProtection: "LAUNCH2_BUYBACK_SPOT_OUTSIDE_PROTECTION",
  outputBelowProtection: "LAUNCH2_BUYBACK_OUTPUT_BELOW_PROTECTION",
  principalInsufficient: "LAUNCH2_BUYBACK_PRINCIPAL_INSUFFICIENT",
  /** Decision 0122 (v3): the swap delivered nothing (`NoOutput`). */
  noOutput: "LAUNCH2_BUYBACK_NO_OUTPUT",
  contractReverted: "LAUNCH2_BUYBACK_CONTRACT_REVERTED",
  /**
   * Decision 0131 (LoopDynamic buyback through LoopRouter): the Hook is
   * mid-swap (`Busy`) or refused the router (`UnauthorizedRouter`).
   */
  hookBusy: "LAUNCH2_BUYBACK_HOOK_BUSY",
  routerUnauthorized: "LAUNCH2_BUYBACK_ROUTER_UNAUTHORIZED",
  // Waiting only.
  ledgerPending: "LAUNCH2_BUYBACK_LEDGER_PENDING",
  retryWait: "LAUNCH2_BUYBACK_RETRY_WAIT",
  gasPriceAboveCap: "LAUNCH2_BUYBACK_GAS_PRICE_ABOVE_CAP",
  // Failure codes stored on a `failed` row.
  gasAboveCap: "LAUNCH2_BUYBACK_GAS_ABOVE_CAP",
  txReverted: "LAUNCH2_BUYBACK_TX_REVERTED",
  txRejected: "LAUNCH2_BUYBACK_TX_REJECTED",
  txDropped: "LAUNCH2_BUYBACK_TX_DROPPED",
  insufficientFunds: "LAUNCH2_BUYBACK_KEEPER_INSUFFICIENT_FUNDS",
  nonceConsumed: "LAUNCH2_BUYBACK_NONCE_CONSUMED",
} as const);

/**
 * The refusal families of Decision 0121 (backoff and reporting). Decision
 * 0122: `principal` = the locked-principal guard (both generations);
 * `legacy_price_protection` = the reference / spot / output protection that
 * only v2-generation executors still have.
 */
export type Launch2KeeperRefusalCategory =
  | "principal"
  | "legacy_price_protection"
  | "interval"
  | "budget"
  | "paused"
  | "not_keeper"
  | "not_graduated"
  | "other";

export interface Launch2KeeperRefusal {
  readonly code: string;
  readonly category: Launch2KeeperRefusalCategory;
  /** The contract error name when it is a safe identifier. */
  readonly detail: string | null;
}

/**
 * Maps a `BuybackExecutor.execute()` revert (decoded error name; the
 * escrow's `BudgetExceeded` included) to a refusal.
 */
export function classifyLaunch2BuybackRevert(
  errorName: string,
): Launch2KeeperRefusal {
  const codes = launch2KeeperReasonCodes;
  const detail = /^[A-Za-z0-9_]{1,64}$/u.test(errorName) ? errorName : null;
  const of = (
    code: string,
    category: Launch2KeeperRefusalCategory,
  ): Launch2KeeperRefusal => Object.freeze({ code, category, detail });
  switch (errorName) {
    case "ReferenceUnavailable":
      return of(codes.referenceUnavailable, "legacy_price_protection");
    case "SpotOutsideProtection":
      return of(codes.spotOutsideProtection, "legacy_price_protection");
    case "OutputBelowProtection":
      return of(codes.outputBelowProtection, "legacy_price_protection");
    case "LockedPrincipalInsufficient":
      return of(codes.principalInsufficient, "principal");
    case "NoOutput":
      return of(codes.noOutput, "other");
    case "TooSoon":
      return of(codes.tooSoon, "interval");
    case "NoBudget":
    case "BudgetExceeded":
      return of(codes.noBudget, "budget");
    case "BuybackPaused":
      return of(codes.paused, "paused");
    case "Unauthorized":
      return of(codes.notKeeper, "not_keeper");
    // Decision 0131: `NotGraduated` = LoopDynamicBuybackAdapter.
    case "LaunchNotGraduated":
    case "NotGraduated":
      return of(codes.notGraduated, "not_graduated");
    case "Busy":
      return of(codes.hookBusy, "other");
    case "UnauthorizedRouter":
      return of(codes.routerUnauthorized, "other");
    default:
      return of(codes.contractReverted, "other");
  }
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface Launch2BuybackAttemptRecord {
  readonly attemptId: string;
  readonly instanceId: string;
  readonly attempt: number;
  readonly status: Launch2BuybackAttemptStatus;
  readonly keeperAddress: string;
  readonly executorAddress: string;
  readonly simulation: "passed" | "reverted";
  /** Raw USD1 (18 decimals) of the simulated order; null when unknown. */
  readonly orderUsd1: string | null;
  readonly simulatedGas: string | null;
  readonly reasonCode: string | null;
  readonly reasonDetail: string | null;
  readonly rejectionCount: number | null;
  readonly lastRejectedAt: string | null;
  readonly nextEligibleAt: string | null;
  readonly txHash: string | null;
  readonly txNonce: string | null;
  readonly rawTx: string | null;
  readonly blockNumber: string | null;
  readonly blockHash: string | null;
  readonly confirmations: number | null;
  readonly buybackId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Launch2BuybackKeeperCandidate {
  readonly instanceId: string;
  readonly buybackExecutor: string;
  readonly escrow: string;
  /** The read model says `graduated` (the lane indexed `Graduated`). */
  readonly graduated: boolean;
  /** The read model's buyback pause (`BuybackPausedEvent` / `Resumed`). */
  readonly buybackPaused: boolean;
  /** `pending | broadcast`, or `confirmed` not yet in the ledger. */
  readonly active: Launch2BuybackAttemptRecord | null;
  /** The newest attempt of any status. */
  readonly latest: Launch2BuybackAttemptRecord | null;
  readonly lastAttempt: number;
}

export interface Launch2BuybackAttemptRepository {
  listCandidates(
    chainId: string,
  ): Promise<readonly Launch2BuybackKeeperCandidate[]>;
  /**
   * A refused simulation: refreshes the newest attempt when it is a
   * `rejected` row with the same code and detail (count + 1), else inserts
   * a new `rejected` row (next attempt number, under a per-instance lock).
   */
  recordRejection(input: {
    readonly instanceId: string;
    readonly chainId: string;
    readonly keeperAddress: string;
    readonly executorAddress: string;
    readonly orderUsd1: string | null;
    readonly reasonCode: string;
    readonly reasonDetail: string | null;
    /** Seconds after now before the instance is simulated again. */
    readonly backoffSeconds: (rejectionCount: number) => number;
  }): Promise<{
    readonly record: Launch2BuybackAttemptRecord;
    readonly repeated: boolean;
  }>;
  /** Inserts a `pending` attempt; null when another attempt is active. */
  insertPending(input: {
    readonly instanceId: string;
    readonly chainId: string;
    readonly attempt: number;
    readonly keeperAddress: string;
    readonly executorAddress: string;
    readonly orderUsd1: string;
    readonly simulatedGas: string;
  }): Promise<Launch2BuybackAttemptRecord | null>;
  /**
   * Under the keeper account's nonce lock (shared with the Hooks executor
   * and the snapshot publisher): picks the lowest free nonce ≥
   * `chainPendingNonce`, signs, and records the transaction on the
   * still-`pending` row. Null when the row moved.
   */
  reserveAndRecordTx(input: {
    readonly attemptId: string;
    readonly keeperAddress: string;
    readonly chainPendingNonce: bigint;
    readonly sign: (nonce: bigint) => Promise<{
      readonly txHash: string;
      readonly rawTx: string;
    }>;
  }): Promise<Launch2BuybackAttemptRecord | null>;
  transition(input: {
    readonly attemptId: string;
    readonly from: Launch2BuybackAttemptStatus;
    readonly to: Launch2BuybackAttemptStatus;
    readonly inclusion?: {
      readonly blockNumber: string;
      readonly blockHash: string;
      readonly confirmations: number;
    } | null;
    readonly failure?: {
      readonly code: string;
      readonly detail: string | null;
      readonly retryAfterSeconds: number;
    };
  }): Promise<Launch2BuybackAttemptRecord | null>;
  /** The lane's ledger row of this transaction (`removed` excluded). */
  findLedgerBuyback(input: {
    readonly instanceId: string;
    readonly txHash: string;
  }): Promise<string | null>;
  /** Sets `buyback_id` once on a `confirmed` attempt. */
  align(input: {
    readonly attemptId: string;
    readonly buybackId: string;
  }): Promise<Launch2BuybackAttemptRecord | null>;
}

export class Launch2KeeperRevertError extends Error {
  constructor(readonly errorName: string) {
    super("The buyback execution would revert");
    this.name = "Launch2KeeperRevertError";
  }
}

export type Launch2KeeperSendResult =
  "accepted" | "known" | "nonce_too_low" | "insufficient_funds" | "rejected";

export interface Launch2BuybackExecutorFacts {
  readonly primaryKeeper: string;
  readonly fallbackKeeper: string;
  /** `budget()` — must be the instance's NftEscrow. */
  readonly budget: string;
  /** `ORDER_AMOUNT` (100 USD1). */
  readonly orderAmount: bigint;
  /** `MIN_SUCCESS_INTERVAL` (10 s). */
  readonly minSuccessInterval: bigint;
}

export interface Launch2BuybackExecutorState {
  readonly blockTimestamp: bigint;
  readonly paused: boolean;
  readonly lastSuccessfulAt: bigint;
  readonly availableBudget: bigint;
}

export interface Launch2BuybackKeeperChain {
  readonly keeperAddress: string;
  chainId(): Promise<number>;
  head(): Promise<{
    readonly number: bigint;
    readonly hash: string;
    readonly timestamp: bigint;
  }>;
  block(
    blockNumber: bigint,
  ): Promise<{ readonly hash: string; readonly timestamp: bigint } | null>;
  /** `LoopLaunchFactory.primaryKeeper()` / `fallbackKeeper()`. */
  factoryKeepers(factory: string): Promise<{
    readonly primary: string;
    readonly fallback: string;
  }>;
  /** Immutables of one executor (cached by the keeper). */
  executorFacts(executor: string): Promise<Launch2BuybackExecutorFacts>;
  /** Views of the executor and its escrow at one block. */
  executorState(
    executor: string,
    escrow: string,
  ): Promise<Launch2BuybackExecutorState>;
  /** Throws `Launch2KeeperRevertError` with the contract error name. */
  estimateExecute(executor: string): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  pendingNonce(): Promise<bigint>;
  signExecute(
    executor: string,
    tx: {
      readonly nonce: bigint;
      readonly gas: bigint;
      readonly gasPrice: bigint;
    },
  ): Promise<{ readonly txHash: string; readonly rawTx: string }>;
  sendRaw(rawTx: string): Promise<Launch2KeeperSendResult>;
  receipt(txHash: string): Promise<{
    readonly status: "success" | "reverted";
    readonly blockNumber: bigint;
    readonly blockHash: string;
  } | null>;
}

export interface Launch2BuybackKeeperPolicy {
  readonly chainId: string;
  readonly factoryAddress: string;
  readonly confirmations: number;
  readonly intervalSeconds: number;
  readonly maxGasPriceWei: bigint;
  readonly gasLimitCap: bigint;
  /** Wait after a `failed` attempt before the next one. */
  readonly retryDelaySeconds: number;
  /** Cap of the exponential refusal backoff. */
  readonly maxBackoffSeconds: number;
}

export const launch2BuybackKeeperDefaults = Object.freeze({
  intervalSeconds: 15,
  minIntervalSeconds: 10,
  confirmations: 12,
  maxGasPriceGwei: 20,
  gasLimitCap: 2_000_000n,
  retryDelaySeconds: 60,
  maxBackoffSeconds: 600,
});

/**
 * Seconds before an instance refused with `refusal` for the `count`-th
 * time in a row is simulated again: `TooSoon` waits one contract
 * interval; everything else doubles from the lane interval up to the cap.
 */
export function launch2KeeperBackoffSeconds(
  refusal: Pick<Launch2KeeperRefusal, "category">,
  count: number,
  policy: Pick<
    Launch2BuybackKeeperPolicy,
    "intervalSeconds" | "maxBackoffSeconds"
  >,
  minSuccessInterval = 10,
): number {
  if (refusal.category === "interval") return minSuccessInterval;
  const exponent = Math.min(Math.max(count - 1, 0), 16);
  return Math.min(
    policy.intervalSeconds * 2 ** exponent,
    policy.maxBackoffSeconds,
  );
}

export interface Launch2KeeperStep {
  readonly instanceId: string;
  readonly attemptId: string;
  readonly from: Launch2BuybackAttemptStatus | null;
  readonly to: Launch2BuybackAttemptStatus;
  readonly txHash: string | null;
  readonly reasonCode: string | null;
  /** A refreshed same-reason refusal (not logged as a new step). */
  readonly repeated: boolean;
}

export interface Launch2KeeperTickResult {
  readonly kind: "ran" | "unavailable";
  readonly reasonCode: string | null;
  readonly candidates: number;
  readonly steps: number;
  /** Instance → why it is not progressing this tick. */
  readonly waiting: Readonly<Record<string, string>>;
}

export interface Launch2BuybackKeeper {
  /** Reads the Factory keepers; `not_keeper` = this key must not run. */
  verifyKeeper(): Promise<"ok" | "not_keeper">;
  runOnce(signal?: AbortSignal): Promise<Launch2KeeperTickResult>;
}

export function createLaunch2BuybackKeeper(options: {
  readonly repository: Launch2BuybackAttemptRepository;
  readonly chain: Launch2BuybackKeeperChain;
  readonly policy: Launch2BuybackKeeperPolicy;
  readonly now?: () => Date;
  readonly onStep?: (step: Launch2KeeperStep) => void;
}): Launch2BuybackKeeper {
  const now = options.now ?? ((): Date => new Date());
  const { repository, chain, policy } = options;
  const keeper = chain.keeperAddress.toLowerCase();
  const facts = new Map<string, Launch2BuybackExecutorFacts>();
  let verified: "ok" | "not_keeper" | null = null;

  async function factsOf(
    executor: string,
  ): Promise<Launch2BuybackExecutorFacts> {
    const cached = facts.get(executor);
    if (cached !== undefined) return cached;
    const read = await chain.executorFacts(executor);
    facts.set(executor, read);
    return read;
  }

  async function verifyKeeper(): Promise<"ok" | "not_keeper"> {
    const keepers = await chain.factoryKeepers(policy.factoryAddress);
    verified =
      keepers.primary.toLowerCase() === keeper ||
      keepers.fallback.toLowerCase() === keeper
        ? "ok"
        : "not_keeper";
    return verified;
  }

  function step(
    record: Launch2BuybackAttemptRecord,
    from: Launch2BuybackAttemptStatus | null,
    repeated = false,
  ): void {
    options.onStep?.({
      instanceId: record.instanceId,
      attemptId: record.attemptId,
      from,
      to: record.status,
      txHash: record.txHash,
      reasonCode: record.reasonCode,
      repeated,
    });
  }

  async function move(
    record: Launch2BuybackAttemptRecord,
    to: Launch2BuybackAttemptStatus,
    extra: Omit<
      Parameters<Launch2BuybackAttemptRepository["transition"]>[0],
      "attemptId" | "from" | "to"
    > = {},
  ): Promise<Launch2BuybackAttemptRecord | null> {
    const updated = await repository.transition({
      attemptId: record.attemptId,
      from: record.status,
      to,
      ...extra,
    });
    if (updated !== null && updated.status !== record.status) {
      step(updated, record.status);
    }
    return updated;
  }

  function fail(
    record: Launch2BuybackAttemptRecord,
    code: string,
    detail: string | null = null,
  ): Promise<Launch2BuybackAttemptRecord | null> {
    return move(record, "failed", {
      failure: { code, detail, retryAfterSeconds: policy.retryDelaySeconds },
    });
  }

  async function sendSigned(record: Launch2BuybackAttemptRecord) {
    if (record.rawTx === null || record.txHash === null) return;
    const outcome = await chain.sendRaw(record.rawTx);
    if (outcome === "accepted" || outcome === "known") {
      await move(record, "broadcast");
      return;
    }
    if (outcome === "nonce_too_low") {
      const receipt = await chain.receipt(record.txHash);
      if (receipt !== null) {
        await move(record, "broadcast");
        return;
      }
      await fail(record, launch2KeeperReasonCodes.nonceConsumed);
      return;
    }
    await fail(
      record,
      outcome === "insufficient_funds"
        ? launch2KeeperReasonCodes.insufficientFunds
        : launch2KeeperReasonCodes.txRejected,
    );
  }

  /** `pending`: a crash between insert and send; finish or fail it. */
  async function advancePending(
    candidate: Launch2BuybackKeeperCandidate,
    record: Launch2BuybackAttemptRecord,
  ): Promise<string | null> {
    if (record.txHash !== null) {
      await sendSigned(record);
      return null;
    }
    if (candidate.buybackPaused) {
      await fail(record, launch2KeeperReasonCodes.paused);
      return launch2KeeperReasonCodes.paused;
    }
    let estimate: bigint;
    try {
      estimate = await chain.estimateExecute(candidate.buybackExecutor);
    } catch (error) {
      if (error instanceof Launch2KeeperRevertError) {
        const refusal = classifyLaunch2BuybackRevert(error.errorName);
        await fail(record, refusal.code, refusal.detail);
        return refusal.code;
      }
      throw error;
    }
    return signAndSend(candidate, record, estimate);
  }

  async function signAndSend(
    candidate: Launch2BuybackKeeperCandidate,
    record: Launch2BuybackAttemptRecord,
    estimate: bigint,
  ): Promise<string | null> {
    const gas = (estimate * 12n) / 10n;
    if (gas > policy.gasLimitCap) {
      await fail(record, launch2KeeperReasonCodes.gasAboveCap);
      return null;
    }
    const gasPrice = await chain.gasPrice();
    if (gasPrice > policy.maxGasPriceWei) {
      return launch2KeeperReasonCodes.gasPriceAboveCap;
    }
    const chainPendingNonce = await chain.pendingNonce();
    const signed = await repository.reserveAndRecordTx({
      attemptId: record.attemptId,
      keeperAddress: keeper,
      chainPendingNonce,
      sign: (nonce) =>
        chain.signExecute(candidate.buybackExecutor, { nonce, gas, gasPrice }),
    });
    if (signed === null) return null;
    await sendSigned(signed);
    return null;
  }

  async function advanceBroadcast(
    record: Launch2BuybackAttemptRecord,
    headNumber: bigint,
  ): Promise<void> {
    if (record.txHash === null || record.rawTx === null) return;
    const receipt = await chain.receipt(record.txHash);
    if (receipt === null) {
      const outcome = await chain.sendRaw(record.rawTx);
      if (outcome === "nonce_too_low") {
        const again = await chain.receipt(record.txHash);
        if (again === null) {
          await fail(record, launch2KeeperReasonCodes.txDropped);
        }
      }
      return;
    }
    if (receipt.status === "reverted") {
      await fail(record, launch2KeeperReasonCodes.txReverted);
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

  /** `confirmed`: wait for the lane's ledger row of the same transaction. */
  async function advanceConfirmed(
    record: Launch2BuybackAttemptRecord,
  ): Promise<string | null> {
    if (record.txHash === null || record.rawTx === null) return null;
    const buybackId = await repository.findLedgerBuyback({
      instanceId: record.instanceId,
      txHash: record.txHash,
    });
    if (buybackId !== null) {
      const aligned = await repository.align({
        attemptId: record.attemptId,
        buybackId,
      });
      if (aligned !== null) step(aligned, record.status);
      return null;
    }
    const receipt = await chain.receipt(record.txHash);
    if (receipt !== null && receipt.blockHash === record.blockHash) {
      return launch2KeeperReasonCodes.ledgerPending;
    }
    // The inclusion block left the canonical chain: re-send the same bytes.
    const reopened = await move(record, "broadcast", { inclusion: null });
    if (reopened !== null) await chain.sendRaw(record.rawTx);
    return null;
  }

  async function reject(
    candidate: Launch2BuybackKeeperCandidate,
    refusal: Launch2KeeperRefusal,
    orderUsd1: bigint | null,
    minSuccessInterval: bigint,
  ): Promise<string> {
    const recorded = await repository.recordRejection({
      instanceId: candidate.instanceId,
      chainId: policy.chainId,
      keeperAddress: keeper,
      executorAddress: candidate.buybackExecutor,
      orderUsd1:
        orderUsd1 === null || orderUsd1 === 0n ? null : orderUsd1.toString(10),
      reasonCode: refusal.code,
      reasonDetail: refusal.detail,
      backoffSeconds: (count) =>
        launch2KeeperBackoffSeconds(
          refusal,
          count,
          policy,
          Number(minSuccessInterval),
        ),
    });
    step(
      recorded.record,
      recorded.repeated ? "rejected" : null,
      recorded.repeated,
    );
    return refusal.code;
  }

  async function start(
    candidate: Launch2BuybackKeeperCandidate,
  ): Promise<string | null> {
    const latest = candidate.latest;
    if (
      latest !== null &&
      latest.nextEligibleAt !== null &&
      (latest.status === "rejected" || latest.status === "failed") &&
      Date.parse(latest.nextEligibleAt) > now().getTime()
    ) {
      return latest.status === "rejected" && latest.reasonCode !== null
        ? latest.reasonCode
        : launch2KeeperReasonCodes.retryWait;
    }
    const executor = await factsOf(candidate.buybackExecutor);
    if (
      executor.primaryKeeper.toLowerCase() !== keeper &&
      executor.fallbackKeeper.toLowerCase() !== keeper
    ) {
      return launch2KeeperReasonCodes.notKeeper;
    }
    if (executor.budget.toLowerCase() !== candidate.escrow.toLowerCase()) {
      return launch2KeeperReasonCodes.escrowMismatch;
    }
    const state = await chain.executorState(
      candidate.buybackExecutor,
      candidate.escrow,
    );
    if (state.paused) return launch2KeeperReasonCodes.paused;
    const order =
      state.availableBudget < executor.orderAmount
        ? state.availableBudget
        : executor.orderAmount;
    if (order === 0n) return launch2KeeperReasonCodes.noBudget;
    if (
      state.lastSuccessfulAt !== 0n &&
      state.blockTimestamp <
        state.lastSuccessfulAt + executor.minSuccessInterval
    ) {
      return launch2KeeperReasonCodes.tooSoon;
    }
    let estimate: bigint;
    try {
      estimate = await chain.estimateExecute(candidate.buybackExecutor);
    } catch (error) {
      if (error instanceof Launch2KeeperRevertError) {
        return reject(
          candidate,
          classifyLaunch2BuybackRevert(error.errorName),
          order,
          executor.minSuccessInterval,
        );
      }
      throw error;
    }
    const gasPrice = await chain.gasPrice();
    if (gasPrice > policy.maxGasPriceWei) {
      return launch2KeeperReasonCodes.gasPriceAboveCap;
    }
    const inserted = await repository.insertPending({
      instanceId: candidate.instanceId,
      chainId: policy.chainId,
      attempt: candidate.lastAttempt + 1,
      keeperAddress: keeper,
      executorAddress: candidate.buybackExecutor,
      orderUsd1: order.toString(10),
      simulatedGas: estimate.toString(10),
    });
    if (inserted === null) return null;
    step(inserted, null);
    return signAndSend(candidate, inserted, estimate);
  }

  async function tick(signal?: AbortSignal): Promise<Launch2KeeperTickResult> {
    const unavailable = (reasonCode: string): Launch2KeeperTickResult =>
      Object.freeze({
        kind: "unavailable",
        reasonCode,
        candidates: 0,
        steps: 0,
        waiting: {},
      });
    const expected = Number(policy.chainId.split(":")[1]);
    if ((await chain.chainId()) !== expected) {
      return unavailable(launch2KeeperReasonCodes.chainMismatch);
    }
    // Boot verified the Factory keepers; a boot-time read failure leaves
    // it to the first tick. Never act unverified.
    if (verified === null) await verifyKeeper();
    if (verified !== "ok") {
      return unavailable(launch2KeeperReasonCodes.notAuthorized);
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
        if (!candidate.graduated) continue;
        reason = candidate.buybackPaused
          ? launch2KeeperReasonCodes.paused
          : await start(candidate);
      } else if (active.status === "pending") {
        reason = await advancePending(candidate, active);
      } else if (active.status === "broadcast") {
        await advanceBroadcast(active, head.number);
      } else if (active.status === "confirmed") {
        reason = await advanceConfirmed(active);
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

  let inFlight: Promise<Launch2KeeperTickResult> | null = null;
  return Object.freeze({
    verifyKeeper,
    runOnce(signal?: AbortSignal): Promise<Launch2KeeperTickResult> {
      if (inFlight !== null) return inFlight;
      const tracked = tick(signal).finally(() => {
        if (inFlight === tracked) inFlight = null;
      });
      inFlight = tracked;
      return tracked;
    },
  });
}
