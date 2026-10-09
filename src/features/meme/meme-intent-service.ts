import { createHash } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  V2ApiError,
  type V2ErrorDetailsSafe,
} from "../../core/http/v2-error.js";
import { isOpaqueId } from "../../core/ids/opaque-id.js";
import { canonicalJson } from "../../core/json/canonical-json.js";
import type { AccountWalletRecord } from "../../database/account-wallet-repository.js";
import type {
  BscFeeData,
  BscTransactionObservation,
} from "../../integrations/bsc/rpc-client.js";
import {
  buildErc20Approve,
  toHexQuantity,
} from "../../integrations/bsc/tx-builder.js";
import type { MemeContractConfig } from "../../integrations/meme/meme-contract-adapter.js";
import {
  assetIdForAddress,
  bscChainId,
  formatDecimalAmount,
  nativeAssetId,
  parseDecimalAmount,
} from "../chain/chain-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  bscWriteCanaryPolicyVersion,
  walletIntentRefusalReasonCodes,
} from "../wallet-intents/intent-contract.js";
import {
  assertDailyCanaryCeiling,
  dailyCanaryAdmission,
  enforceCanaryCeiling,
  requireCanaryCounterparty,
} from "../wallet-intents/intent-preparation.js";
import {
  memeReasonCodes,
  memeRules,
  type MemeIntentKind,
} from "./meme-contract.js";
import { randomMemeSalt } from "./meme-create2.js";
import {
  MemeSellExceedsSoldError,
  exceedsRelativeDifference,
  freshMemeCurve,
  memeMinBuyUsd1,
  memeWalletCap,
  quoteMemeBuy,
  quoteMemeSell,
} from "./meme-curve-math.js";
import {
  MemeCreateIntentInFlightError,
  MemeIdempotencyConflictError,
  MemeIntentReportConflictError,
  MemeRepositoryUnavailableError,
  MemeTokenNotDraftError,
  type CreateMemeIntentRecord,
  type MemeIntentRecord,
  type MemeTokenRecord,
} from "./meme-repository.js";
import type { MemeServiceDependencies } from "./meme-service.js";

/**
 * MEME create / buy / sell Intents (Decision 0101, the Decision 0077
 * discipline): every docs/10 check the contract would apply is run at one
 * snapshot block before anything is built, each refusal names its rule;
 * the unsigned transaction (and, when the allowance is short, an exact
 * `approve` before it) goes through the device signing exit; the Decision
 * 0065 canary applies with USD1 at 1 USD. A broadcast report is pending
 * evidence; `confirmed` comes from the `meme_event` lane or the receipt.
 */

export interface MemeIntentResource {
  readonly memeIntent: Record<string, unknown>;
  readonly contractVersion: typeof v2ContractVersion;
}

interface PrepareDependencies extends MemeServiceDependencies {
  readonly contractConfig: MemeContractConfig;
  readonly now: () => Date;
  readonly createUuid: () => string;
  readonly visibleToken: (memeTokenId: string) => Promise<MemeTokenRecord>;
}

interface ReadDependencies extends MemeServiceDependencies {
  readonly now: () => Date;
}

/** Fixed gas limits when the call cannot be estimated before an approval. */
const fallbackGas: Readonly<Record<MemeIntentKind, bigint>> = Object.freeze({
  create: 700_000n,
  buy: 300_000n,
  sell: 200_000n,
});
const approvalGas = 80_000n;

function unavailableWith(reasonCode: string): never {
  throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", { reasonCode });
}

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

const decimalAmountPattern = /^(0|[1-9][0-9]{0,40})(\.[0-9]{1,18})?$/u;
const rawPattern = /^(0|[1-9][0-9]{0,77})$/u;

interface ParsedBody {
  readonly kind: MemeIntentKind;
  readonly walletId: string;
  readonly usd1In: bigint;
  readonly tokensIn: bigint;
  readonly minOut: bigint | null;
  readonly slippageBps: number;
  readonly deadlineSeconds: number;
}

function parseBody(body: unknown): ParsedBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw V2ApiError.invalidRequest();
  }
  const value = body as Record<string, unknown>;
  const kind = value["kind"];
  if (kind !== "create" && kind !== "buy" && kind !== "sell") {
    throw V2ApiError.invalidRequest();
  }
  if (!isOpaqueId(value["walletId"])) {
    throw V2ApiError.invalidRequest();
  }
  const amount = (key: string): bigint | null => {
    const raw = value[key];
    if (raw === undefined) {
      return null;
    }
    if (typeof raw !== "string" || !decimalAmountPattern.test(raw)) {
      throw V2ApiError.invalidRequest();
    }
    return parseDecimalAmount(raw, 18);
  };
  const usd1 = amount("usd1Amount");
  const tokens = amount("tokenAmount");
  if (kind === "sell") {
    if (usd1 !== null || tokens === null || tokens <= 0n) {
      throw V2ApiError.invalidRequest();
    }
  } else if (tokens !== null) {
    throw V2ApiError.invalidRequest();
  }
  if (kind === "buy" && (usd1 === null || usd1 <= 0n)) {
    throw V2ApiError.invalidRequest();
  }
  const rawMinOut = value["minOut"];
  const rawSlippage = value["slippageBps"];
  if (rawMinOut !== undefined && rawSlippage !== undefined) {
    throw V2ApiError.invalidRequest();
  }
  let minOut: bigint | null = null;
  if (rawMinOut !== undefined) {
    if (typeof rawMinOut !== "string" || !rawPattern.test(rawMinOut)) {
      throw V2ApiError.invalidRequest();
    }
    minOut = BigInt(rawMinOut);
  }
  let slippageBps: number = memeRules.defaultSlippageBps;
  if (rawSlippage !== undefined) {
    if (
      typeof rawSlippage !== "number" ||
      !Number.isInteger(rawSlippage) ||
      rawSlippage < 0 ||
      rawSlippage > memeRules.maximumSlippageBps
    ) {
      throw V2ApiError.invalidRequest();
    }
    slippageBps = rawSlippage;
  }
  let deadlineSeconds: number = memeRules.intentDefaultDeadlineSeconds;
  const rawDeadline = value["deadlineSeconds"];
  if (rawDeadline !== undefined) {
    if (
      typeof rawDeadline !== "number" ||
      !Number.isInteger(rawDeadline) ||
      rawDeadline < memeRules.intentMinimumDeadlineSeconds ||
      rawDeadline > memeRules.intentMaximumDeadlineSeconds
    ) {
      throw V2ApiError.invalidRequest();
    }
    deadlineSeconds = rawDeadline;
  }
  return {
    kind,
    walletId: value["walletId"],
    usd1In: usd1 ?? 0n,
    tokensIn: tokens ?? 0n,
    minOut,
    slippageBps,
    deadlineSeconds,
  };
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

export function memeTransactionMatches(
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

export function projectMemeIntent(
  record: MemeIntentRecord,
  now: Date,
): MemeIntentResource {
  const elapsed =
    record.state === "prepared" &&
    Date.parse(record.expiresAt) <= now.getTime();
  const state = elapsed ? "expired" : record.state;
  const simulation = record.policy["simulation"] as
    { readonly status: string; readonly reasonCode: string | null } | undefined;
  const simulationReverted = simulation?.status === "reverted";
  const signingAllowed = state === "prepared" && !simulationReverted;
  return Object.freeze({
    memeIntent: Object.freeze({
      memeIntentId: record.intentId,
      kind: record.kind,
      state,
      memeTokenId: record.memeTokenId,
      walletId: record.walletId,
      chainId: record.chainId,
      chainReference: record.unsignedTransaction["chainId"],
      contractAddress: record.contractAddress,
      tokenAddress: record.tokenAddress,
      ...(record.kind === "create"
        ? { predictedAddress: record.policy["predictedAddress"] ?? null }
        : {}),
      usd1Amount: record.usd1AmountRaw,
      tokenAmount: record.tokenAmountRaw,
      expectedOut: record.expectedOutRaw,
      minOut: record.minOutRaw,
      fee: record.feeRaw,
      refund: record.refundRaw,
      deadline: record.deadline,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      calldata: record.calldata,
      unsignedTransaction: record.unsignedTransaction,
      approval: record.approval,
      payloadDigest: record.payloadDigest,
      snapshotBlockNumber: record.snapshotBlockNumber,
      snapshotBlockHash: record.snapshotBlockHash,
      transactionHash: record.transactionHash,
      reasonCode: elapsed ? memeReasonCodes.intentExpired : record.reasonCode,
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
            ? memeReasonCodes.intentExpired
            : state === "prepared"
              ? memeReasonCodes.simulationReverted
              : record.reasonCode !== null
                ? record.reasonCode
                : memeReasonCodes.intentAlreadyReported,
      }),
    }),
    contractVersion: v2ContractVersion,
  });
}

function translate(error: unknown): never {
  if (error instanceof V2ApiError) {
    throw error;
  }
  if (error instanceof MemeIdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (error instanceof MemeRepositoryUnavailableError) {
    return unavailableWith("MEME_REPOSITORY_UNAVAILABLE");
  }
  if (error instanceof MemeCreateIntentInFlightError) {
    return refuse("DATA_STALE", memeReasonCodes.intentCreateInFlight);
  }
  if (error instanceof MemeTokenNotDraftError) {
    return refuse(
      "DATA_STALE",
      memeReasonCodes.tokenNotDraft,
      error.status === null ? {} : { status: error.status },
    );
  }
  if (error instanceof Error && error.name === "MemeContractUnavailableError") {
    return unavailableWith(
      (error as Error & { reasonCode: string }).reasonCode,
    );
  }
  if (
    error instanceof Error &&
    (error.name === "BscReadUnavailableError" ||
      error.name === "BscChainMismatchError")
  ) {
    return unavailableWith(memeReasonCodes.contractReadFailed);
  }
  throw error;
}

/**
 * Decision 0104 m6: every chain read on a POST path goes through here. A
 * refusal (`V2ApiError`) and the adapter's own unavailability keep their
 * reason; anything else the RPC throws (a viem timeout, an HTTP or socket
 * failure, a malformed answer) is `503 CAPABILITY_UNAVAILABLE` /
 * `MEME_CONTRACT_READ_FAILED`, never a 500.
 */
async function chainRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof V2ApiError) {
      throw error;
    }
    if (
      error instanceof Error &&
      error.name === "MemeContractUnavailableError"
    ) {
      return unavailableWith(
        (error as Error & { reasonCode: string }).reasonCode,
      );
    }
    return unavailableWith(memeReasonCodes.contractReadFailed);
  }
}

function requestDigest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(`loop:v2:meme:meme_intent_v1:${v2ContractVersion}`);
  for (const part of parts) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

export async function prepareMemeIntent(
  deps: PrepareDependencies,
  input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly memeTokenId: string;
    readonly body: unknown;
    readonly idempotencyKey: string;
  },
): Promise<MemeIntentResource> {
  const writes = deps.writes;
  if (writes === null) {
    return unavailableWith("MEME_WRITES_DISABLED");
  }
  // BSC Mainnet signing stays closed (00 §4.8): only the testnet slot signs.
  if (deps.contract.chainId === bscChainId) {
    return unavailableWith(memeReasonCodes.mainnetSigningClosed);
  }
  const request = parseBody(input.body);
  const availability = await chainRead(() => deps.contract.availability());
  if (availability.status === "unavailable") {
    return unavailableWith(availability.reasonCode);
  }
  const token = await deps.visibleToken(input.memeTokenId);
  if (deps.wallets === null) {
    return unavailableWith("MEME_WALLETS_UNAVAILABLE");
  }
  const wallet = await deps.wallets
    .get(input.principal.userId, request.walletId)
    .catch(() => unavailableWith("MEME_WALLETS_UNAVAILABLE"));
  if (wallet === null || wallet.status !== "active") {
    throw V2ApiError.notFound();
  }
  if (wallet.kind !== "embedded" || wallet.providerWalletId === null) {
    throw V2ApiError.fromCode("VALIDATION_FAILED");
  }
  if (request.kind === "create") {
    if (token.creatorUserId !== input.principal.userId) {
      throw V2ApiError.notFound();
    }
    if (token.status !== "draft") {
      refuse("DATA_STALE", memeReasonCodes.tokenNotDraft, {
        status: token.status,
      });
    }
  } else if (token.tokenAddress === null) {
    refuse("DATA_STALE", memeReasonCodes.tokenNotOnChain);
  }
  const requestSha256 = requestDigest([
    token.memeTokenId,
    wallet.walletId,
    request.kind,
    request.usd1In.toString(10),
    request.tokensIn.toString(10),
    request.minOut === null ? "" : request.minOut.toString(10),
    String(request.slippageBps),
    String(request.deadlineSeconds),
  ]);
  try {
    const writesConfig = writes;
    const outcome = await deps.repository.createIntent({
      ownerUserId: input.principal.userId,
      idempotencyKey: input.idempotencyKey,
      requestSha256,
      build: () => buildIntent(deps, { ...input, request, token, wallet }),
      // Decision 0104 M2: re-checked under the owner lock at insert time.
      canaryAdmission: (built) => {
        const valueUsd = String(built.policy["valueUsd"]);
        // Same condition as the pre-check in buildIntent.
        return parseDecimalAmount(valueUsd, 18) > 0n
          ? dailyCanaryAdmission(writesConfig, valueUsd, deps.now())
          : null;
      },
      exclusiveCreate:
        request.kind === "create" ? { memeTokenId: token.memeTokenId } : null,
    });
    return projectMemeIntent(outcome.intent, deps.now());
  } catch (error) {
    return translate(error);
  }
}

async function buildIntent(
  deps: PrepareDependencies,
  input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly request: ParsedBody;
    readonly token: MemeTokenRecord;
    readonly wallet: AccountWalletRecord;
  },
): Promise<CreateMemeIntentRecord> {
  const { request, wallet } = input;
  let token = input.token;
  const configured = deps.contractConfig;
  const writes = deps.writes as NonNullable<typeof deps.writes>;
  const chainId = deps.contract.chainId;
  const usd1AssetId = assetIdForAddress(chainId, configured.usd1Address);
  const client = deps.readClient;

  // --- Canary admission first: it costs no chain read (Decision 0065). ---
  // USD1 is paid (create / buy) or received (sell): every kind moves it, so
  // every kind needs it on the canary allowlist (Decision 0104 m2).
  if (!writes.canaryAssetIds.includes(usd1AssetId)) {
    refuse(
      "POLICY_BLOCKED",
      walletIntentRefusalReasonCodes.assetNotInCanaryAllowlist,
    );
  }
  requireCanaryCounterparty(writes, configured.address);

  // --- One snapshot for every chain read. ---
  const snapshot = await chainRead(() => deps.contract.takeSnapshot());
  const block = await chainRead(() =>
    deps.contract.readBlock(snapshot.blockNumber),
  );
  let curve = freshMemeCurve;
  if (request.kind !== "create") {
    const read = await chainRead(() =>
      deps.contract.getCurve(token.tokenAddress as string, snapshot),
    );
    if (read.value.status === "FULL") {
      refuse("DATA_STALE", memeReasonCodes.curveFull);
    }
    if (read.value.status !== "TRADING") {
      refuse("DATA_STALE", memeReasonCodes.curveNotTrading, {
        status: read.value.status,
      });
    }
    curve = { vUsd1: read.value.vUsd1, vToken: read.value.vToken };
  } else {
    // A salt is not bound to its creator on chain: one someone else used
    // (SaltUsed) or one whose reservation lapsed is replaced first.
    const fallback = randomMemeSalt({
      deployer: configured.address,
      implementation: configured.tokenImplementation,
    });
    const scope = {
      chainId,
      contractAddress: configured.address,
      tokenImplementation: configured.tokenImplementation,
      suffix: deps.config.vanitySuffix,
    };
    let taken =
      token.predictedAddress === null
        ? true
        : (await chainRead(() =>
            client.getCode(token.predictedAddress as string),
          )) !== "0x";
    for (let attempt = 0; taken && attempt < 3; attempt += 1) {
      const replaced = await deps.repository.replaceDraftSalt({
        memeTokenId: token.memeTokenId,
        expectedSalt: token.salt,
        saltScope: scope,
        fallbackSalt: fallback,
      });
      if (replaced === null || replaced.predictedAddress === null) {
        refuse("DATA_STALE", memeReasonCodes.tokenNotDraft);
      }
      token = replaced;
      const predicted = replaced.predictedAddress;
      taken = (await chainRead(() => client.getCode(predicted))) !== "0x";
    }
    if (taken) {
      refuse("DATA_STALE", memeReasonCodes.saltTaken);
    }
    await deps.repository.touchDraftSalt(token.memeTokenId);
  }

  // --- docs/10 §2 recomputation and the contract's checks. ---
  let expectedOut = 0n;
  let fee = 0n;
  let refund = 0n;
  let valueUsdRaw = 0n;
  const tokenAddress = token.tokenAddress;
  const tokenAssetId =
    tokenAddress === null ? null : assetIdForAddress(chainId, tokenAddress);
  const nativeId = nativeAssetId(chainId);
  const balances = await chainRead(() =>
    client.readBalances(wallet.address, [
      { assetId: usd1AssetId, address: configured.usd1Address },
      { assetId: nativeId, address: null },
      ...(tokenAssetId === null
        ? []
        : [{ assetId: tokenAssetId, address: tokenAddress }]),
    ]),
  );
  const balanceOf = (assetId: string | null): bigint => {
    const raw = balances.balances.find(
      (item) => item.assetId === assetId,
    )?.rawValue;
    if (raw === undefined || raw === null) {
      return unavailableWith(memeReasonCodes.contractReadFailed);
    }
    return raw;
  };
  const usd1Balance = balanceOf(usd1AssetId);
  const nativeBalance = balanceOf(nativeId);
  const tokenBalance = tokenAssetId === null ? 0n : balanceOf(tokenAssetId);

  if (request.kind === "sell") {
    if (request.tokensIn > tokenBalance) {
      refuse("INSUFFICIENT_BALANCE", memeReasonCodes.sellExceedsBalance, {
        balance: tokenBalance.toString(10),
      });
    }
    try {
      const q = quoteMemeSell(curve, request.tokensIn);
      expectedOut = q.usd1Out;
      fee = q.fee;
    } catch (error) {
      if (error instanceof MemeSellExceedsSoldError) {
        refuse("VALIDATION_FAILED", memeReasonCodes.sellExceedsBalance);
      }
      throw error;
    }
    valueUsdRaw = expectedOut;
  } else if (request.usd1In > 0n) {
    if (request.usd1In < memeMinBuyUsd1) {
      refuse("VALIDATION_FAILED", memeReasonCodes.belowMinBuy, {
        minBuyUsd1: memeMinBuyUsd1.toString(10),
      });
    }
    const q = quoteMemeBuy(curve, request.usd1In);
    expectedOut = q.tokensOut;
    fee = q.fee;
    refund = q.refund;
    valueUsdRaw = q.paid;
    if (tokenBalance + expectedOut > memeWalletCap) {
      const remaining = memeWalletCap - tokenBalance;
      refuse("VALIDATION_FAILED", memeReasonCodes.walletCapExceeded, {
        walletCapTokens: memeWalletCap.toString(10),
        remainingTokens: (remaining < 0n ? 0n : remaining).toString(10),
      });
    }
    if (usd1Balance < q.paid) {
      refuse("INSUFFICIENT_BALANCE", memeReasonCodes.usd1BalanceInsufficient);
    }
  }
  if (request.kind !== "create" && expectedOut <= 0n) {
    refuse("VALIDATION_FAILED", memeReasonCodes.quoteZero);
  }
  // Audit the recomputation against the chain at the same block.
  if (request.kind !== "create" && tokenAddress !== null) {
    try {
      const chainOut =
        request.kind === "buy"
          ? (
              await deps.contract.quoteBuy(
                { token: tokenAddress, usd1In: request.usd1In },
                snapshot,
              )
            ).value.tokensOut
          : (
              await deps.contract.quoteSell(
                { token: tokenAddress, tokensIn: request.tokensIn },
                snapshot,
              )
            ).value.usd1Out;
      if (
        exceedsRelativeDifference(
          chainOut,
          expectedOut,
          memeRules.quoteDriftWarningBps,
        )
      ) {
        deps.logger?.warn(
          {
            reasonCode: "MEME_QUOTE_DRIFT",
            side: request.kind,
            blockNumber: snapshot.blockNumber.toString(10),
            recomputed: expectedOut.toString(10),
            chain: chainOut.toString(10),
          },
          "MEME quote recomputation differs from the chain by more than 0.1%",
        );
      }
    } catch {
      // Best-effort audit; the Intent is built from the recomputation.
    }
  }
  let minOut = (expectedOut * BigInt(10_000 - request.slippageBps)) / 10_000n;
  if (request.minOut !== null) {
    if (request.minOut > expectedOut) {
      refuse("VALIDATION_FAILED", memeReasonCodes.slippageExceeded, {
        expectedOut: expectedOut.toString(10),
      });
    }
    minOut = request.minOut;
  }

  // --- Canary ceilings on what the wallet pays or receives (USD1 at par). ---
  const valueUsd = formatDecimalAmount(valueUsdRaw, 18);
  enforceCanaryCeiling(writes, valueUsd);
  if (writes.canaryDailyMaxUsd !== null && valueUsdRaw > 0n) {
    const since = new Date(
      deps.now().getTime() - 24 * 60 * 60 * 1000,
    ).toISOString();
    // One window over wallet + Launch + MEME Intents (Decision 0104 M1);
    // the repository re-checks it under the owner lock before the insert.
    const spentUsd = await deps.repository.sumRecentExposureUsd({
      ownerUserId: input.principal.userId,
      since,
    });
    assertDailyCanaryCeiling(writes.canaryDailyMaxUsd, spentUsd, valueUsd);
  }

  // --- Allowance: an exact approve precedes the call when it is short. ---
  const nowSeconds = BigInt(Math.floor(deps.now().getTime() / 1000));
  const reference = nowSeconds > block.timestamp ? nowSeconds : block.timestamp;
  const deadlineSeconds = reference + BigInt(request.deadlineSeconds);
  let approvalTarget: { token: string; amount: bigint } | null = null;
  if (request.kind === "sell") {
    const allowances = await chainRead(() =>
      client.readAllowances(wallet.address, [
        {
          assetId: tokenAssetId as string,
          token: tokenAddress as string,
          spender: configured.address,
        },
      ]),
    );
    const allowance = allowances.allowances[0]?.rawValue;
    if (allowance === undefined || allowance === null) {
      return unavailableWith(memeReasonCodes.contractReadFailed);
    }
    if (allowance < request.tokensIn) {
      approvalTarget = {
        token: tokenAddress as string,
        amount: request.tokensIn,
      };
    }
  } else if (request.usd1In > 0n) {
    const allowances = await chainRead(() =>
      client.readAllowances(wallet.address, [
        {
          assetId: usd1AssetId,
          token: configured.usd1Address,
          spender: configured.address,
        },
      ]),
    );
    const allowance = allowances.allowances[0]?.rawValue;
    if (allowance === undefined || allowance === null) {
      return unavailableWith(memeReasonCodes.contractReadFailed);
    }
    if (allowance < request.usd1In) {
      approvalTarget = {
        token: configured.usd1Address,
        amount: request.usd1In,
      };
    }
  }

  // --- Calldata. ---
  const call =
    request.kind === "create"
      ? deps.contract.encodeCreateToken({
          salt: token.salt as string,
          name: token.name,
          symbol: token.symbol,
          metadataHash: token.metadataHash,
          initialBuyUsd1: request.usd1In,
          minTokensOut: request.usd1In > 0n ? minOut : 0n,
        })
      : request.kind === "buy"
        ? deps.contract.encodeBuy({
            token: tokenAddress as string,
            usd1In: request.usd1In,
            minTokensOut: minOut,
            deadline: deadlineSeconds,
          })
        : deps.contract.encodeSell({
            token: tokenAddress as string,
            tokensIn: request.tokensIn,
            minUsd1Out: minOut,
            deadline: deadlineSeconds,
          });

  // --- Simulation, gas, nonce, fee. ---
  let simulation: { status: string; reasonCode: string | null };
  let gasLimit = fallbackGas[request.kind];
  const callRequest = {
    from: wallet.address,
    to: call.to,
    data: call.data,
    value: 0n,
  };
  if (approvalTarget !== null) {
    simulation = {
      status: "unavailable",
      reasonCode: memeReasonCodes.approvalRequired,
    };
  } else {
    const simulated = await chainRead(() => client.call(callRequest));
    if (simulated.status === "reverted") {
      simulation = {
        status: "reverted",
        reasonCode: memeReasonCodes.simulationReverted,
      };
    } else {
      const estimate = await client.estimateGas(callRequest).catch(() => null);
      if (estimate === null) {
        simulation = {
          status: "unavailable",
          reasonCode: memeReasonCodes.simulationUnavailable,
        };
      } else {
        simulation = { status: "passed", reasonCode: null };
        gasLimit = (estimate * 12n) / 10n;
      }
    }
  }
  const [fee_, nonce] = await chainRead(() =>
    Promise.all([
      client.getFeeData(),
      client.getTransactionCount(wallet.address),
    ]),
  );
  const perGas = fee_.type === "eip1559" ? fee_.maxFeePerGas : fee_.gasPrice;
  const totalGas = gasLimit + (approvalTarget === null ? 0n : approvalGas);
  if (totalGas * perGas > nativeBalance) {
    refuse("INSUFFICIENT_BALANCE", memeReasonCodes.gasInsufficient);
  }
  const chainReference = client.chainReference;
  let approval: Record<string, unknown> | null = null;
  if (approvalTarget !== null) {
    const approveCall = buildErc20Approve({
      token: approvalTarget.token,
      spender: configured.address,
      value: approvalTarget.amount,
    });
    approval = {
      token: approvalTarget.token,
      spender: configured.address,
      amount: approvalTarget.amount.toString(10),
      calldata: { to: approveCall.to, data: approveCall.data, value: "0" },
      unsignedTransaction: unsignedTransactionFor({
        chainReference,
        from: wallet.address,
        to: approveCall.to,
        data: approveCall.data,
        gasLimit: approvalGas,
        nonce,
        fee: fee_,
      }),
    };
  }
  const unsignedTransaction = unsignedTransactionFor({
    chainReference,
    from: wallet.address,
    to: call.to,
    data: call.data,
    gasLimit,
    nonce: approvalTarget === null ? nonce : nonce + 1,
    fee: fee_,
  });
  const intentId = deps.createUuid();
  const at = deps.now();
  const expiresAt = new Date(
    Math.min(
      at.getTime() + request.deadlineSeconds * 1000,
      Number(deadlineSeconds) * 1000,
    ),
  ).toISOString();
  const deadline = new Date(Number(deadlineSeconds) * 1000).toISOString();
  const calldata = { to: call.to, data: call.data, value: "0" };
  const policy = {
    configVersion: bscWriteCanaryPolicyVersion,
    canaryMaxUsd: writes.canaryMaxUsd,
    valueUsd,
    priceSource: "usd1_par",
    simulation,
    ...(request.kind === "create"
      ? { predictedAddress: token.predictedAddress, salt: token.salt }
      : {}),
  };
  const binding = {
    version: "memeIntentV1",
    intentId,
    accountId: input.principal.userId,
    walletId: wallet.walletId,
    memeTokenId: token.memeTokenId,
    kind: request.kind,
    chainId,
    contractAddress: configured.address,
    tokenAddress,
    usd1Amount: request.usd1In.toString(10),
    tokenAmount: request.tokensIn.toString(10),
    expectedOut: expectedOut.toString(10),
    minOut: minOut.toString(10),
    deadline,
    snapshotBlockNumber: snapshot.blockNumber.toString(10),
    snapshotBlockHash: snapshot.blockHash,
    calldata,
    unsignedTransaction,
    approval,
    policy,
  };
  const payloadDigest = createHash("sha256")
    .update(canonicalJson(binding), "utf8")
    .digest("hex");
  return Object.freeze({
    intentId,
    ownerUserId: input.principal.userId,
    walletId: wallet.walletId,
    walletAddress: wallet.address,
    memeTokenId: token.memeTokenId,
    kind: request.kind,
    chainId,
    contractAddress: configured.address,
    tokenAddress,
    usd1AmountRaw: request.usd1In.toString(10),
    tokenAmountRaw: request.tokensIn.toString(10),
    expectedOutRaw: expectedOut.toString(10),
    minOutRaw: minOut.toString(10),
    feeRaw: fee.toString(10),
    refundRaw: refund.toString(10),
    deadline,
    snapshotBlockNumber: snapshot.blockNumber.toString(10),
    snapshotBlockHash: snapshot.blockHash,
    calldata,
    unsignedTransaction,
    approval,
    policy,
    payloadDigest,
    state: "prepared",
    expiresAt,
  });
}

const transactionHashPattern = /^0x[0-9a-f]{64}$/u;

export async function reportMemeIntentBroadcast(
  deps: ReadDependencies,
  input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly memeTokenId: string;
    readonly memeIntentId: string;
    readonly body: unknown;
  },
): Promise<MemeIntentResource> {
  if (deps.writes === null) {
    return unavailableWith("MEME_WRITES_DISABLED");
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
  if (!isOpaqueId(input.memeIntentId) || !isOpaqueId(input.memeTokenId)) {
    throw V2ApiError.notFound();
  }
  let record: MemeIntentRecord | null;
  try {
    record = await deps.repository.getIntent({
      ownerUserId: input.principal.userId,
      intentId: input.memeIntentId,
    });
  } catch (error) {
    return translate(error);
  }
  if (record === null || record.memeTokenId !== input.memeTokenId) {
    throw V2ApiError.notFound();
  }
  const now = deps.now();
  if (record.transactionHash !== null) {
    if (record.transactionHash === txHash) {
      return projectMemeIntent(record, now);
    }
    refuse("DATA_STALE", memeReasonCodes.intentAlreadyReported);
  }
  if (record.state !== "prepared") {
    refuse("DATA_STALE", memeReasonCodes.intentNotSignable);
  }
  let observed;
  try {
    observed = await deps.readClient.getTransaction(txHash);
  } catch {
    return unavailableWith(memeReasonCodes.contractReadFailed);
  }
  const elapsed = Date.parse(record.expiresAt) <= now.getTime();
  if (observed === null && elapsed) {
    refuse("DATA_STALE", memeReasonCodes.intentExpired);
  }
  if (
    observed !== null &&
    !memeTransactionMatches(observed, record.unsignedTransaction)
  ) {
    refuse("VALIDATION_FAILED", memeReasonCodes.txPayloadMismatch);
  }
  try {
    const reported = await deps.repository.reportIntentBroadcast({
      ownerUserId: input.principal.userId,
      intentId: record.intentId,
      transactionHash: txHash,
      payloadVerified: observed !== null,
    });
    return projectMemeIntent(reported, now);
  } catch (error) {
    if (error instanceof MemeIntentReportConflictError) {
      refuse("DATA_STALE", memeReasonCodes.intentAlreadyReported);
    }
    return translate(error);
  }
}

export async function readMemeIntent(
  deps: ReadDependencies,
  input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly memeIntentId: string;
  },
): Promise<MemeIntentResource> {
  if (!isOpaqueId(input.memeIntentId)) {
    throw V2ApiError.notFound();
  }
  let record: MemeIntentRecord | null;
  try {
    record = await deps.repository.getIntent({
      ownerUserId: input.principal.userId,
      intentId: input.memeIntentId,
    });
  } catch (error) {
    return translate(error);
  }
  if (record === null) {
    throw V2ApiError.notFound();
  }
  return projectMemeIntent(record, deps.now());
}
