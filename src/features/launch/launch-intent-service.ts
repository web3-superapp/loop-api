import { createHash } from "node:crypto";

import type { BscWriteConfig } from "../../config.js";
import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  V2ApiError,
  type V2ErrorDetailsSafe,
} from "../../core/http/v2-error.js";
import { isOpaqueId } from "../../core/ids/opaque-id.js";
import { canonicalJson } from "../../core/json/canonical-json.js";
import type {
  AccountWalletRecord,
  AccountWalletRepository,
} from "../../database/account-wallet-repository.js";
import {
  BscChainMismatchError,
  BscReadUnavailableError,
  type BscChainCallClient,
  type BscFeeData,
  type BscTransactionObservation,
} from "../../integrations/bsc/rpc-client.js";
import { toHexQuantity } from "../../integrations/bsc/tx-builder.js";
import {
  LaunchContractUnavailableError,
  isZeroBytes32,
  type LaunchContractAdapter,
  type LaunchContractRound,
} from "../../integrations/launch/launch-contract-adapter.js";
import {
  assetIdForAddress,
  formatDecimalAmount,
  nativeAssetId,
  parseDecimalAmount,
} from "../chain/chain-contract.js";
import {
  addDecimalStrings,
  compareDecimalStrings,
  subtractDecimalStrings,
} from "../market/market-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import { bscWriteCanaryPolicyVersion } from "../wallet-intents/intent-contract.js";
import {
  enforceCanaryCeiling,
  requireCanaryCounterparty,
} from "../wallet-intents/intent-preparation.js";
import { walletIntentRefusalReasonCodes } from "../wallet-intents/intent-contract.js";
import {
  LaunchIntentIdempotencyConflictError,
  LaunchChainRepositoryUnavailableError,
  LaunchIntentReportConflictError,
  type CreateLaunchIntentInput,
  type LaunchChainRepository,
  type LaunchIntentRecord,
} from "./launch-chain-repository.js";
import {
  launchContractReasonCodes,
  type LaunchEligibilityMode,
} from "./launch-contract.js";
import { decideEligibility, isOpenRoot } from "./launch-eligibility.js";
import type {
  LaunchDetailRecord,
  LaunchRepository,
} from "./launch-repository.js";

/**
 * Launch purchase Intent prepare (03 §8.2, 06 §4.1, Decision 0077). It is a
 * namespace of its own (`launch_intents`, `launch_intent_v1`), never a wallet
 * intent and never a Swap. Every 06 §4.1 `buy` check is run server-side at
 * one snapshot block before anything is built; each refusal names its rule.
 * The unsigned transaction goes through the Decision 0065 signing exit
 * (device `eth_sendTransaction`) and canary (USD1 valued at 1 USD).
 */

export const launchIntentTtlSeconds = 120;
/** A deadline closer than this to the round end is refused, not shortened. */
export const launchIntentMinimumWindowSeconds = 15;
export const usd1Decimals = 18;

export const launchIntentReasonCodes = Object.freeze({
  saleNotLive: "LAUNCH_SALE_NOT_LIVE",
  salePaused: "LAUNCH_SALE_PAUSED",
  roundNotOpen: "LAUNCH_ROUND_NOT_OPEN",
  roundNotOnChain: "LAUNCH_ROUND_NOT_ON_CHAIN",
  deadlineTooClose: "LAUNCH_DEADLINE_TOO_CLOSE",
  belowMinPurchase: "LAUNCH_BELOW_MIN_PURCHASE",
  walletRoundCapExceeded: "LAUNCH_WALLET_ROUND_CAP_EXCEEDED",
  walletProjectCapExceeded: "LAUNCH_WALLET_PROJECT_CAP_EXCEEDED",
  roundCapExceeded: "LAUNCH_ROUND_CAP_EXCEEDED",
  hardCapExceeded: "LAUNCH_HARD_CAP_EXCEEDED",
  quoteZero: "LAUNCH_QUOTE_ZERO",
  configVersionMismatch: "LAUNCH_CONFIG_VERSION_MISMATCH",
  usd1BalanceInsufficient: "LAUNCH_USD1_BALANCE_INSUFFICIENT",
  usd1AllowanceInsufficient: "LAUNCH_USD1_ALLOWANCE_INSUFFICIENT",
  gasInsufficient: "LAUNCH_GAS_INSUFFICIENT",
  saleAssetsUnregistered: "LAUNCH_SALE_ASSETS_UNREGISTERED",
  simulationReverted: "LAUNCH_SIMULATION_REVERTED",
  simulationUnavailable: "LAUNCH_SIMULATION_UNAVAILABLE",
  intentExpired: "LAUNCH_INTENT_EXPIRED",
  intentNotSignable: "LAUNCH_INTENT_NOT_SIGNABLE",
  intentAlreadyReported: "LAUNCH_INTENT_ALREADY_REPORTED",
  txPayloadMismatch: "LAUNCH_TX_PAYLOAD_MISMATCH",
  /** Decision 0080: the finalized receipt has status 0x0. */
  txReverted: "LAUNCH_TX_REVERTED",
  /** Decision 0080: no receipt once the deadline plus grace has passed. */
  txNotObserved: "LAUNCH_TX_NOT_OBSERVED",
} as const);

export interface LaunchIntentRuntime {
  /** `null` keeps every prepare CAPABILITY_UNAVAILABLE (0065 switch). */
  readonly writes: BscWriteConfig | null;
  /** The launch chain slot's call client. */
  readonly readClient: BscChainCallClient;
  readonly wallets: AccountWalletRepository;
  /**
   * Rolling-window exposure of the owner's wallet AND Launch intents
   * (Decision 0065; the wallet-intent repository sums both since 0077).
   */
  readonly walletIntentExposureUsd: (input: {
    readonly ownerUserId: string;
    readonly since: string;
  }) => Promise<string>;
  readonly now: () => Date;
  readonly createUuid: () => string;
}

export interface LaunchIntentResource {
  readonly launchIntent: Record<string, unknown>;
  readonly contractVersion: typeof v2ContractVersion;
}

const payAmountPattern = /^(0|[1-9][0-9]{0,77})(\.[0-9]{1,60})?$/;

function refuse(
  code:
    | "DATA_STALE"
    | "VALIDATION_FAILED"
    | "POLICY_BLOCKED"
    | "INSUFFICIENT_BALANCE",
  reasonCode: string,
  extra: V2ErrorDetailsSafe = {},
): never {
  throw V2ApiError.fromCode(code, { reasonCode, ...extra });
}

function unavailableWith(reasonCode: string): never {
  throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", { reasonCode });
}

function usd1(raw: bigint): string {
  return raw.toString(10);
}

function translateChain(error: unknown): never {
  if (error instanceof V2ApiError) {
    throw error;
  }
  if (error instanceof LaunchContractUnavailableError) {
    return unavailableWith(error.reasonCode);
  }
  if (
    error instanceof BscReadUnavailableError ||
    error instanceof BscChainMismatchError
  ) {
    return unavailableWith(launchContractReasonCodes.readFailed);
  }
  throw error;
}

export function launchIntentRequestDigest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(`loop:v2:launch:launch_intent_v1:${v2ContractVersion}`);
  for (const part of parts) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

function unsignedTransactionFor(input: {
  readonly chainReference: number;
  readonly from: string;
  readonly to: string;
  readonly data: string;
  readonly gasLimit: bigint;
  readonly nonce: number;
  readonly fee: BscFeeData;
}): Record<string, unknown> {
  return {
    chainId: input.chainReference,
    to: input.to,
    data: input.data,
    value: "0x0",
    from: input.from,
    gas: toHexQuantity(input.gasLimit),
    nonce: toHexQuantity(BigInt(input.nonce)),
    type: input.fee.type,
    maxFeePerGas:
      input.fee.type === "eip1559"
        ? toHexQuantity(input.fee.maxFeePerGas)
        : null,
    maxPriorityFeePerGas:
      input.fee.type === "eip1559"
        ? toHexQuantity(input.fee.maxPriorityFeePerGas)
        : null,
    gasPrice:
      input.fee.type === "legacy" ? toHexQuantity(input.fee.gasPrice) : null,
  };
}

export function projectLaunchIntent(
  record: LaunchIntentRecord,
  now: Date,
): LaunchIntentResource {
  // Only an unreported Intent expires; a reported one waits for the index.
  const elapsed =
    (record.state === "prepared" || record.state === "awaiting_signature") &&
    Date.parse(record.expiresAt) <= now.getTime();
  const state = elapsed ? "expired" : record.state;
  const simulation = record.policy["simulation"] as
    { readonly status: string; readonly reasonCode: string | null } | undefined;
  const signingAllowed = state === "awaiting_signature";
  const caps = record.policy["caps"] as
    | {
        readonly walletRoundCapUsd1: string;
        readonly walletProjectCapUsd1: string;
      }
    | undefined;
  return Object.freeze({
    launchIntent: Object.freeze({
      launchIntentId: record.intentId,
      state,
      launchId: record.launchId,
      projectId: record.projectId,
      walletId: record.walletId,
      roundId: record.roundId,
      roundIndex: record.roundIndex,
      chainId: record.chainId,
      contractAddress: record.contractAddress,
      quoteAssetId: record.quoteAssetId,
      usd1Amount: record.payAmountRaw,
      expectedTokenAmount: record.expectedReceiveRaw,
      minTokenAmount: record.minTokenAmountRaw,
      walletCumulativeUsd1: record.walletCumulativeRaw,
      deadline: record.deadline,
      eligibilityProof: record.eligibilityProof,
      configVersion: record.configVersion,
      stateTupleDigest: record.stateTupleDigest,
      snapshotBlockNumber: record.snapshotBlockNumber,
      snapshotBlockHash: record.snapshotBlockHash,
      payloadDigest: record.payloadDigest,
      unsignedTransaction: record.unsignedTransaction,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      projectAssetId: record.projectAssetId,
      saleId: record.saleId,
      ...(caps === undefined
        ? {}
        : {
            walletRoundCapUsd1: caps.walletRoundCapUsd1,
            walletProjectCapUsd1: caps.walletProjectCapUsd1,
          }),
      transactionHash: record.transactionHash,
      // Decision 0080: present on a reverted Intent only; null while no
      // read surface yields a decoded reason.
      ...(state === "reverted" ? { revertReason: record.revertReason } : {}),
      simulation: Object.freeze({
        status: simulation?.status ?? "unavailable",
        reasonCode: simulation?.reasonCode ?? null,
      }),
      policy: Object.freeze({
        configVersion: record.policy["configVersion"],
        canaryMaxUsd: record.policy["canaryMaxUsd"],
        valueUsd: record.policy["valueUsd"],
        priceSource: record.policy["priceSource"],
      }),
      signing: Object.freeze({
        mode: "device_eth_send_transaction",
        allowed: signingAllowed,
        reasonCode: signingAllowed
          ? null
          : elapsed
            ? launchIntentReasonCodes.intentExpired
            : record.reasonCode !== null
              ? // Decision 0080: why the reconcile lane settled it.
                record.reasonCode
              : record.transactionHash !== null
                ? launchIntentReasonCodes.intentAlreadyReported
                : (simulation?.reasonCode ??
                  launchIntentReasonCodes.simulationUnavailable),
      }),
    }),
    contractVersion: v2ContractVersion,
  });
}

interface PrepareInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly launchId: string;
  readonly body: unknown;
  readonly idempotencyKey: string;
}

export interface LaunchIntentPrepareDependencies {
  readonly repository: LaunchRepository;
  readonly chain: LaunchChainRepository;
  readonly contract: LaunchContractAdapter;
  readonly runtime: LaunchIntentRuntime;
  /** Registry reason from the launch service (0076), null when readable. */
  readonly registryReason: (detail: LaunchDetailRecord) => string | null;
  readonly eligibilityMode: (
    detail: LaunchDetailRecord,
  ) => LaunchEligibilityMode;
}

function parseBody(body: unknown): {
  readonly walletId: string;
  readonly roundId: string;
  readonly payRaw: bigint;
} {
  if (typeof body !== "object" || body === null) {
    throw V2ApiError.invalidRequest();
  }
  const value = body as Record<string, unknown>;
  if (
    !isOpaqueId(value["walletId"]) ||
    !isOpaqueId(value["roundId"]) ||
    typeof value["payAmount"] !== "string" ||
    !payAmountPattern.test(value["payAmount"])
  ) {
    throw V2ApiError.invalidRequest();
  }
  let payRaw: bigint;
  try {
    payRaw = parseDecimalAmount(value["payAmount"], usd1Decimals);
  } catch {
    throw V2ApiError.invalidRequest();
  }
  if (payRaw <= 0n) {
    throw V2ApiError.invalidRequest();
  }
  return { walletId: value["walletId"], roundId: value["roundId"], payRaw };
}

export async function prepareLaunchIntent(
  deps: LaunchIntentPrepareDependencies,
  input: PrepareInput,
): Promise<{
  readonly created: boolean;
  readonly resource: LaunchIntentResource;
}> {
  const { runtime, contract } = deps;
  const configured = contract.contract;
  const writes = runtime.writes;
  // Unchanged Decision 0036/0076 bytes: no switch or no contract is the bare
  // CAPABILITY_UNAVAILABLE without detailsSafe.
  if (writes === null || configured === null) {
    throw V2ApiError.capabilityUnavailable();
  }
  const request = parseBody(input.body);
  const availability = await contract.availability();
  if (availability.status === "unavailable") {
    return unavailableWith(availability.reasonCode);
  }
  if (runtime.readClient.currentVerification() !== "verified") {
    const verified = await runtime.readClient.verifyChain();
    if (verified !== "verified") {
      return unavailableWith(launchContractReasonCodes.chainRpcUnreachable);
    }
  }
  const detail = await deps.repository.getLaunch(input.launchId);
  if (detail === null) {
    throw V2ApiError.notFound();
  }
  const registry = deps.registryReason(detail);
  if (registry !== null) {
    return unavailableWith(registry);
  }
  const wallet = await runtime.wallets.get(
    input.principal.userId,
    request.walletId,
  );
  if (wallet === null || wallet.status !== "active") {
    throw V2ApiError.notFound();
  }
  if (wallet.kind !== "embedded" || wallet.providerWalletId === null) {
    // Only a Privy embedded wallet signs through the app's exit (0035).
    throw V2ApiError.fromCode("VALIDATION_FAILED");
  }
  const round = detail.rounds.find((item) => item.roundId === request.roundId);
  if (round === undefined) {
    throw V2ApiError.notFound();
  }
  const quoteAssetId = assetIdForAddress(
    detail.launch.chainId,
    configured.usd1Address,
  );
  const requestSha256 = launchIntentRequestDigest([
    detail.launch.launchId,
    wallet.walletId,
    round.roundId,
    request.payRaw.toString(10),
  ]);
  let outcome;
  try {
    outcome = await deps.chain.createIntent({
      ownerUserId: input.principal.userId,
      idempotencyKey: input.idempotencyKey,
      requestSha256,
      build: () =>
        buildIntent(deps, {
          principal: input.principal,
          detail,
          wallet,
          roundId: round.roundId,
          roundIndex: round.roundIndex,
          roundTier: round.eligibilityTier,
          payRaw: request.payRaw,
          quoteAssetId,
          writes,
        }),
    });
  } catch (error) {
    if (error instanceof LaunchIntentIdempotencyConflictError) {
      throw V2ApiError.idempotencyConflict();
    }
    return translateChain(error);
  }
  return Object.freeze({
    created: outcome.created,
    resource: projectLaunchIntent(outcome.intent, runtime.now()),
  });
}

async function buildIntent(
  deps: LaunchIntentPrepareDependencies,
  input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly detail: LaunchDetailRecord;
    readonly wallet: AccountWalletRecord;
    readonly roundId: string;
    readonly roundIndex: number;
    readonly roundTier: LaunchDetailRecord["rounds"][number]["eligibilityTier"];
    readonly payRaw: bigint;
    readonly quoteAssetId: string;
    readonly writes: BscWriteConfig;
  },
): Promise<CreateLaunchIntentInput> {
  const { contract, runtime } = deps;
  const configured = contract.contract;
  if (configured === null) {
    throw V2ApiError.capabilityUnavailable();
  }
  const launch = input.detail.launch;
  if (
    launch.projectAssetId === undefined ||
    launch.projectAssetId === null ||
    launch.quoteAssetId === undefined ||
    launch.quoteAssetId === null
  ) {
    return unavailableWith(launchIntentReasonCodes.saleAssetsUnregistered);
  }
  const saleId = BigInt(launch.saleId as string);
  const pay = input.payRaw;

  // --- Canary admission first: it costs no chain read (Decision 0065). ---
  if (!input.writes.canaryAssetIds.includes(input.quoteAssetId)) {
    refuse(
      "POLICY_BLOCKED",
      walletIntentRefusalReasonCodes.assetNotInCanaryAllowlist,
    );
  }
  requireCanaryCounterparty(input.writes, configured.address);
  // USD1 is valued at exactly 1 USD (user ruling for S83b).
  const valueUsd = formatDecimalAmount(pay, usd1Decimals);
  enforceCanaryCeiling(input.writes, valueUsd);
  if (input.writes.canaryDailyMaxUsd !== null) {
    const since = new Date(
      runtime.now().getTime() - 24 * 60 * 60 * 1000,
    ).toISOString();
    // One rolling window for wallet and Launch intents (0065 / 0077).
    const spentUsd = await runtime.walletIntentExposureUsd({
      ownerUserId: input.principal.userId,
      since,
    });
    const exposureUsd = addDecimalStrings(spentUsd, valueUsd);
    const ceilingUsd = input.writes.canaryDailyMaxUsd;
    if (compareDecimalStrings(exposureUsd, ceilingUsd) > 0) {
      const remaining = subtractDecimalStrings(ceilingUsd, spentUsd);
      refuse(
        "POLICY_BLOCKED",
        walletIntentRefusalReasonCodes.canaryDailyCeilingExceeded,
        {
          exposureUsd,
          ceilingUsd,
          spentUsd,
          remainingUsd:
            compareDecimalStrings(remaining, "0") < 0 ? "0" : remaining,
        },
      );
    }
  }

  // --- One snapshot for every contract read (Decision 0076). ---
  const snapshot = await contract.takeSnapshot();
  const [state, config, rounds, roundPosition, position, quote, block] =
    await Promise.all([
      contract.getState(saleId, snapshot),
      contract.getSaleConfig(saleId, snapshot),
      contract.getRounds(saleId, snapshot),
      contract.getRoundPosition(
        { saleId, roundId: input.roundIndex, wallet: input.wallet.address },
        snapshot,
      ),
      contract.getPosition({ saleId, wallet: input.wallet.address }, snapshot),
      contract.quote(
        { saleId, roundId: input.roundIndex, usd1Amount: pay },
        snapshot,
      ),
      contract.readBlock(snapshot.blockNumber),
    ]);
  await contract.confirmSnapshot(snapshot);
  if (isZeroBytes32(state.value.configVersion)) {
    return unavailableWith(launchContractReasonCodes.saleNotFound);
  }
  if (config.value.usd1 !== configured.usd1Address) {
    return unavailableWith(launchContractReasonCodes.usd1AddressMismatch);
  }
  if (
    state.value.configVersion !== config.value.configVersion ||
    (launch.configVersionOnchain !== null &&
      launch.configVersionOnchain !== state.value.configVersion)
  ) {
    refuse("DATA_STALE", launchIntentReasonCodes.configVersionMismatch);
  }

  // --- 06 §4.1 buy checks, in the contract's order. ---
  if (state.value.saleState !== "LIVE") {
    refuse("DATA_STALE", launchIntentReasonCodes.saleNotLive, {
      saleState: state.value.saleState,
    });
  }
  const chainRound: LaunchContractRound | undefined = rounds.value.find(
    (item) => item.roundId === input.roundIndex,
  );
  if (chainRound === undefined) {
    refuse("DATA_STALE", launchIntentReasonCodes.roundNotOnChain);
  }
  const nowSeconds = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const chainSeconds = block.timestamp;
  const reference = nowSeconds > chainSeconds ? nowSeconds : chainSeconds;
  if (reference < chainRound.startAt || reference >= chainRound.endAt) {
    refuse("DATA_STALE", launchIntentReasonCodes.roundNotOpen);
  }
  if (state.value.operationalState === "PAUSED") {
    refuse("DATA_STALE", launchIntentReasonCodes.salePaused);
  }
  if (pay < config.value.minPurchaseUsd1) {
    refuse("VALIDATION_FAILED", launchIntentReasonCodes.belowMinPurchase, {
      minPurchaseUsd1: usd1(config.value.minPurchaseUsd1),
    });
  }
  const roundRemaining = chainRound.walletRoundCapUsd1 - roundPosition.value;
  if (roundPosition.value + pay > chainRound.walletRoundCapUsd1) {
    refuse(
      "VALIDATION_FAILED",
      launchIntentReasonCodes.walletRoundCapExceeded,
      { remainingUsd1: usd1(roundRemaining < 0n ? 0n : roundRemaining) },
    );
  }
  const projectRemaining =
    config.value.walletProjectCapUsd1 - position.value.cumulativeUsd1;
  if (position.value.cumulativeUsd1 + pay > config.value.walletProjectCapUsd1) {
    refuse(
      "VALIDATION_FAILED",
      launchIntentReasonCodes.walletProjectCapExceeded,
      { remainingUsd1: usd1(projectRemaining < 0n ? 0n : projectRemaining) },
    );
  }
  if (chainRound.raisedUsd1 + pay > chainRound.roundCapUsd1) {
    const remaining = chainRound.roundCapUsd1 - chainRound.raisedUsd1;
    refuse("VALIDATION_FAILED", launchIntentReasonCodes.roundCapExceeded, {
      remainingUsd1: usd1(remaining < 0n ? 0n : remaining),
    });
  }
  const totalRaised = rounds.value.reduce(
    (sum, item) => sum + item.raisedUsd1,
    0n,
  );
  if (totalRaised + pay > config.value.hardCapUsd1) {
    const remaining = config.value.hardCapUsd1 - totalRaised;
    refuse("VALIDATION_FAILED", launchIntentReasonCodes.hardCapExceeded, {
      remainingUsd1: usd1(remaining < 0n ? 0n : remaining),
    });
  }
  if (quote.value <= 0n) {
    refuse("VALIDATION_FAILED", launchIntentReasonCodes.quoteZero);
  }
  // deadline: now + TTL, never past the round end; too close is refused.
  let deadlineSeconds = reference + BigInt(launchIntentTtlSeconds);
  if (deadlineSeconds > chainRound.endAt) {
    deadlineSeconds = chainRound.endAt;
  }
  if (deadlineSeconds - reference < BigInt(launchIntentMinimumWindowSeconds)) {
    refuse("DATA_STALE", launchIntentReasonCodes.deadlineTooClose);
  }

  // --- Eligibility: the chain root selects the stored allowlist. ---
  // Decision 0084: an all-zero root is a public round; no stored root, no
  // mode, and no proof are consulted.
  const roots = isOpenRoot(chainRound.allowlistRoot)
    ? []
    : await deps.chain.listAllowlistRoots(launch.launchId, input.roundIndex);
  const mode = deps.eligibilityMode(input.detail);
  const decision = decideEligibility({
    chainRoot: chainRound.allowlistRoot,
    roots,
    mode: mode === "unavailable" ? null : mode,
    walletAddress: input.wallet.address,
  });
  if (decision.status === "refused") {
    refuse("POLICY_BLOCKED", decision.reasonCode);
  }
  if (decision.status === "not_member") {
    refuse("POLICY_BLOCKED", "LAUNCH_WALLET_NOT_ELIGIBLE");
  }
  const proof = decision.status === "member" ? decision.proof : [];

  // --- Funds: USD1 balance, allowance to the contract, native gas. ---
  const client = runtime.readClient;
  const nativeId = nativeAssetId(launch.chainId);
  const [balances, allowances] = await Promise.all([
    client.readBalances(input.wallet.address, [
      { assetId: input.quoteAssetId, address: configured.usd1Address },
      { assetId: nativeId, address: null },
    ]),
    client.readAllowances(input.wallet.address, [
      {
        assetId: input.quoteAssetId,
        token: configured.usd1Address,
        spender: configured.address,
      },
    ]),
  ]);
  const usd1Balance = balances.balances.find(
    (item) => item.assetId === input.quoteAssetId,
  )?.rawValue;
  const nativeBalance = balances.balances.find(
    (item) => item.assetId === nativeId,
  )?.rawValue;
  const allowance = allowances.allowances[0]?.rawValue;
  if (
    usd1Balance === undefined ||
    usd1Balance === null ||
    nativeBalance === undefined ||
    nativeBalance === null ||
    allowance === undefined ||
    allowance === null
  ) {
    return unavailableWith(launchContractReasonCodes.readFailed);
  }
  if (usd1Balance < pay) {
    refuse(
      "INSUFFICIENT_BALANCE",
      launchIntentReasonCodes.usd1BalanceInsufficient,
    );
  }
  if (allowance < pay) {
    refuse(
      "INSUFFICIENT_BALANCE",
      launchIntentReasonCodes.usd1AllowanceInsufficient,
      { allowanceUsd1: usd1(allowance) },
    );
  }

  const call = contract.encodeBuy({
    saleId,
    roundId: input.roundIndex,
    usd1Amount: pay,
    minTokenAmount: quote.value,
    deadline: deadlineSeconds,
    eligibilityProof: proof,
  });
  const request = {
    from: input.wallet.address,
    to: call.to,
    data: call.data,
    value: 0n,
  };
  const simulated = await client.call(request);
  let simulation: {
    readonly status: string;
    readonly reasonCode: string | null;
  };
  let gasLimit = 250_000n;
  if (simulated.status === "reverted") {
    simulation = {
      status: "reverted",
      reasonCode: launchIntentReasonCodes.simulationReverted,
    };
  } else {
    const estimate = await client.estimateGas(request).catch(() => null);
    if (estimate === null) {
      simulation = {
        status: "unavailable",
        reasonCode: launchIntentReasonCodes.simulationUnavailable,
      };
    } else {
      simulation = { status: "passed", reasonCode: null };
      gasLimit = (estimate * 12n) / 10n;
    }
  }
  const [fee, nonce] = await Promise.all([
    client.getFeeData(),
    client.getTransactionCount(input.wallet.address),
  ]);
  const perGas = fee.type === "eip1559" ? fee.maxFeePerGas : fee.gasPrice;
  if (gasLimit * perGas > nativeBalance) {
    refuse("INSUFFICIENT_BALANCE", launchIntentReasonCodes.gasInsufficient);
  }

  const intentId = runtime.createUuid();
  const unsignedTransaction = unsignedTransactionFor({
    chainReference: runtime.readClient.chainReference,
    from: input.wallet.address,
    to: call.to,
    data: call.data,
    gasLimit,
    nonce,
    fee,
  });
  const deadline = new Date(Number(deadlineSeconds) * 1000).toISOString();
  const policy = {
    configVersion: bscWriteCanaryPolicyVersion,
    canaryMaxUsd: input.writes.canaryMaxUsd,
    valueUsd,
    priceSource: "usd1_par",
    simulation,
    // Same snapshot block as every check (Decision 0088): shown before signing.
    caps: {
      walletRoundCapUsd1: chainRound.walletRoundCapUsd1.toString(10),
      walletProjectCapUsd1: config.value.walletProjectCapUsd1.toString(10),
    },
  };
  const binding = {
    version: "launchIntentV1",
    intentId,
    accountId: input.principal.userId,
    walletId: input.wallet.walletId,
    launchId: launch.launchId,
    projectId: launch.projectId,
    roundId: input.roundId,
    roundIndex: input.roundIndex,
    saleId: saleId.toString(10),
    chainId: launch.chainId,
    quoteAssetId: input.quoteAssetId,
    projectAssetId: launch.projectAssetId,
    direction: "buy",
    usd1Amount: pay.toString(10),
    expectedTokenAmount: quote.value.toString(10),
    minTokenAmount: quote.value.toString(10),
    configVersion: state.value.configVersion,
    walletRoundCumulativeUsd1: roundPosition.value.toString(10),
    walletCumulativeUsd1: position.value.cumulativeUsd1.toString(10),
    deadline,
    contractAddress: configured.address,
    stateTupleDigest: state.value.stateTupleDigest,
    snapshotBlockNumber: snapshot.blockNumber.toString(10),
    snapshotBlockHash: snapshot.blockHash,
    eligibilityProof: proof,
    unsignedTransaction,
  };
  const payloadDigest = createHash("sha256")
    .update(canonicalJson(binding), "utf8")
    .digest("hex");
  return Object.freeze({
    intentId,
    ownerUserId: input.principal.userId,
    walletId: input.wallet.walletId,
    launchId: launch.launchId,
    projectId: launch.projectId,
    roundId: input.roundId,
    roundIndex: input.roundIndex,
    saleId: saleId.toString(10),
    chainId: launch.chainId,
    quoteAssetId: input.quoteAssetId,
    projectAssetId: launch.projectAssetId,
    payAmountRaw: pay.toString(10),
    expectedReceiveRaw: quote.value.toString(10),
    minTokenAmountRaw: quote.value.toString(10),
    configVersion: state.value.configVersion,
    walletCumulativeRaw: position.value.cumulativeUsd1.toString(10),
    contractAddress: configured.address,
    stateTupleDigest: state.value.stateTupleDigest,
    snapshotBlockNumber: snapshot.blockNumber.toString(10),
    snapshotBlockHash: snapshot.blockHash,
    payloadDigest,
    state: simulation.status === "passed" ? "awaiting_signature" : "prepared",
    deadline,
    eligibilityProof: Object.freeze([...proof]),
    unsignedTransaction,
    policy,
    expiresAt: deadline,
  });
}

const transactionHashPattern = /^0x[0-9a-f]{64}$/;

export interface LaunchIntentReportDependencies {
  readonly chain: LaunchChainRepository;
  readonly contract: LaunchContractAdapter;
  readonly runtime: LaunchIntentRuntime;
}

/**
 * Whether an observed transaction is the sealed `buy()` payload: sender,
 * contract, calldata, zero value, and chain (Decision 0077). The broadcast
 * report and the receipt reconciler (Decision 0080) apply the same test.
 */
export function launchTransactionMatches(
  observed: BscTransactionObservation,
  transaction: Readonly<Record<string, unknown>>,
): boolean {
  return (
    observed.from === transaction["from"] &&
    observed.to === transaction["to"] &&
    observed.input.toLowerCase() ===
      String(transaction["data"]).toLowerCase() &&
    observed.value === 0n &&
    (observed.chainId === null || observed.chainId === transaction["chainId"])
  );
}

/**
 * Device broadcast report (Decision 0077, same discipline as 0035): the
 * transaction hash is pending evidence, verified against the sealed payload
 * when the launch slot already sees it. The Intent becomes `confirmed` only
 * when the `launch_event` lane indexes a Purchased log of that transaction.
 */
export async function reportLaunchIntentBroadcast(
  deps: LaunchIntentReportDependencies,
  input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly launchId: string;
    readonly launchIntentId: string;
    readonly body: unknown;
  },
): Promise<LaunchIntentResource> {
  if (deps.runtime.writes === null || deps.contract.contract === null) {
    throw V2ApiError.capabilityUnavailable();
  }
  if (
    typeof input.body !== "object" ||
    input.body === null ||
    typeof (input.body as { txHash?: unknown }).txHash !== "string"
  ) {
    throw V2ApiError.invalidRequest();
  }
  const txHash = (input.body as { txHash: string }).txHash.toLowerCase();
  if (!transactionHashPattern.test(txHash)) {
    throw V2ApiError.invalidRequest();
  }
  const record = await deps.chain.getIntent({
    ownerUserId: input.principal.userId,
    launchId: input.launchId,
    intentId: input.launchIntentId,
  });
  if (record === null) {
    throw V2ApiError.notFound();
  }
  const now = deps.runtime.now();
  if (record.transactionHash !== null) {
    if (record.transactionHash === txHash) {
      return projectLaunchIntent(record, now);
    }
    refuse("DATA_STALE", launchIntentReasonCodes.intentAlreadyReported);
  }
  if (record.state !== "awaiting_signature") {
    refuse("DATA_STALE", launchIntentReasonCodes.intentNotSignable);
  }
  const transaction = record.unsignedTransaction;
  let observed;
  try {
    observed = await deps.runtime.readClient.getTransaction(txHash);
  } catch {
    return unavailableWith(launchContractReasonCodes.readFailed);
  }
  const elapsed = Date.parse(record.expiresAt) <= now.getTime();
  if (observed === null && elapsed) {
    // A late report is accepted only with the transaction in hand.
    refuse("DATA_STALE", launchIntentReasonCodes.intentExpired);
  }
  if (observed !== null && !launchTransactionMatches(observed, transaction)) {
    refuse("VALIDATION_FAILED", launchIntentReasonCodes.txPayloadMismatch);
  }
  try {
    const reported = await deps.chain.reportIntentBroadcast({
      ownerUserId: input.principal.userId,
      intentId: record.intentId,
      transactionHash: txHash,
      payloadVerified: observed !== null,
    });
    return projectLaunchIntent(reported, now);
  } catch (error) {
    if (error instanceof LaunchIntentReportConflictError) {
      refuse("DATA_STALE", launchIntentReasonCodes.intentAlreadyReported);
    }
    throw error;
  }
}

/**
 * Owner-scoped read of one Launch Intent (Decision 0081): the same projection
 * as the prepare `201` and the broadcast report, so the client can follow a
 * reported Intent through the reconcile lane (Decision 0080) without
 * re-reporting. Another account's Intent is NOT_FOUND, never a distinct
 * code. The gate is the report's: CAPABILITY_UNAVAILABLE while writes are
 * off or the contract keys are blank.
 */
export async function readLaunchIntent(
  deps: LaunchIntentReportDependencies,
  input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly launchId: string;
    readonly launchIntentId: string;
  },
): Promise<LaunchIntentResource> {
  if (deps.runtime.writes === null || deps.contract.contract === null) {
    throw V2ApiError.capabilityUnavailable();
  }
  let record: LaunchIntentRecord | null;
  try {
    record = await deps.chain.getIntent({
      ownerUserId: input.principal.userId,
      launchId: input.launchId,
      intentId: input.launchIntentId,
    });
  } catch (error) {
    if (error instanceof LaunchChainRepositoryUnavailableError) {
      // Fail closed: the store is unreadable, which is not "not found".
      throw V2ApiError.capabilityUnavailable();
    }
    throw error;
  }
  if (record === null) {
    throw V2ApiError.notFound();
  }
  return projectLaunchIntent(record, deps.runtime.now());
}
