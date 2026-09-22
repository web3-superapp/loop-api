import type { Hex } from "viem";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import type { AssetRecord } from "../../database/chain-registry-repository.js";
import type { WalletIntentRecord } from "../../database/wallet-intent-repository.js";
import {
  buildErc20Approve,
  checksumAddress,
  decodeErc20Call,
  InvalidTransactionArgumentError,
  isUnlimitedAllowance,
  maxUint256,
  parseRecipientAddress,
} from "../../integrations/bsc/tx-builder.js";
import {
  bscChainId,
  bscChainReference,
  formatDecimalAmount,
  isAssetId,
  isNormalizedEvmAddress,
} from "../chain/chain-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  approvalIntentTtlSeconds,
  intentRequestDigest,
  sealIntent,
  walletIntentPayloadVersions,
  walletIntentRefusalReasonCodes,
  type DecodedCallReview,
  type IntentSource,
  type SpenderReview,
  type WalletIntentKind,
} from "./intent-contract.js";
import {
  assertNativeSufficiency,
  assetSnapshot,
  buildUnsignedTransaction,
  canaryPolicyFact,
  chainUnavailable,
  enforceCanaryCeiling,
  enforceDailyCanaryCeiling,
  intentStateForSimulation,
  parseIntentAmount,
  preExecute,
  projectIntent,
  readBalanceSnapshot,
  readFeeSnapshot,
  readNonce,
  requireAdmittedAsset,
  requireCanaryAllowlisted,
  requireSignableWallet,
  requireWallet,
  requireCanaryCounterparty,
  requireWriteAdmission,
  valueInUsd,
  withPrepareIdempotency,
  type UsdValuation,
  type WalletIntentResource,
  type WalletIntentRuntime,
} from "./intent-preparation.js";

/**
 * D16 approvals (Decision 0035): the approve/revoke intents and the
 * allowance inventory. An approval is the same intent path as a send with
 * `approve(spender, amount)` calldata; a revoke is `approve(spender, 0)`. The
 * inventory lists spenders from indexed `Approval` logs and always re-reads
 * the current `allowance()` over RPC before publishing a value.
 */

export interface ApprovalRowResource {
  readonly assetId: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly spender: {
    readonly address: string;
    readonly checksumAddress: string;
  };
  readonly allowance:
    | {
        readonly status: "available";
        readonly rawValue: string;
        readonly displayValue: string;
        readonly isUnlimited: boolean;
        readonly blockNumber: string;
        readonly blockHash: string;
        readonly observedAt: string;
      }
    | { readonly status: "unavailable"; readonly reasonCode: string };
  readonly lastApproval: {
    readonly transactionHash: string;
    readonly blockNumber: string;
    readonly rawValue: string;
    readonly observedAt: string;
  } | null;
  readonly riskFacts: {
    readonly status: "unavailable";
    readonly reasonCode: string;
  };
}

export interface ApprovalListResource {
  readonly walletId: string;
  readonly items: readonly ApprovalRowResource[];
  readonly summary: {
    readonly activeCount: number;
    readonly unlimitedCount: number;
  };
  readonly freshness: {
    readonly indexerBlockNumber: string;
    /** First block from which Approval logs are contiguous up to `indexerBlockNumber`. */
    readonly approvalCoverageFromBlockNumber: string;
    readonly headBlockNumber: string;
    readonly observedAt: string;
  };
  readonly contractVersion: typeof v2ContractVersion;
}

export interface ApprovalDetailResource {
  readonly walletId: string;
  readonly item: ApprovalRowResource;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface ApprovalService {
  prepareApprove(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly body: unknown;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly created: boolean;
    readonly resource: WalletIntentResource;
  }>;
  prepareRevoke(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly body: unknown;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly created: boolean;
    readonly resource: WalletIntentResource;
  }>;
  list(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly walletId: unknown;
  }): Promise<ApprovalListResource>;
  get(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly walletId: unknown;
    readonly assetId: unknown;
    readonly spender: unknown;
  }): Promise<ApprovalDetailResource>;
}

const approvalRiskReasonCode = "GOPLUS_APPROVAL_FACTS_NOT_CONFIGURED";

function parseSpender(value: unknown): string {
  try {
    return parseRecipientAddress(value);
  } catch (error) {
    if (error instanceof InvalidTransactionArgumentError) {
      throw V2ApiError.invalidRequest();
    }
    throw error;
  }
}

export function projectDecodedApprove(data: Hex): DecodedCallReview {
  const decoded = decodeErc20Call(data);
  if (decoded.functionName !== "approve") {
    throw new InvalidTransactionArgumentError();
  }
  return Object.freeze({
    functionName: "approve" as const,
    selector: data.slice(0, 10),
    args: Object.freeze({
      spender: decoded.spender,
      value: decoded.value.toString(10),
    }),
  });
}

export function createApprovalService(
  runtime: WalletIntentRuntime,
): ApprovalService {
  async function prepareAllowanceIntent(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly kind: Extract<WalletIntentKind, "approve" | "revoke">;
    readonly walletId: unknown;
    readonly assetId: unknown;
    readonly spenderAddress: unknown;
    readonly allowance:
      | { readonly mode: "unlimited" }
      | { readonly mode: "exact"; readonly amount: unknown }
      | { readonly mode: "zero" };
    readonly signal: AbortSignal;
  }): Promise<{
    readonly created: boolean;
    readonly resource: WalletIntentResource;
  }> {
    const writes = await requireWriteAdmission(runtime);
    const wallet = await requireSignableWallet(
      runtime,
      input.principal,
      input.walletId,
    );
    // Order (S6 finding 2): shape → native → allowlist → ceiling. The native
    // asset has no allowance surface, so that is a request-shape fact
    // (422) and is decided before the canary allowlist (403).
    const admitted = await requireAdmittedAsset(runtime, input.assetId);
    if (admitted.address === null) {
      throw V2ApiError.fromCode("VALIDATION_FAILED", {
        reasonCode: walletIntentRefusalReasonCodes.nativeAssetNotApprovable,
      });
    }
    const asset = requireCanaryAllowlisted(writes, admitted);
    const tokenAddress = admitted.address;
    const spender = parseSpender(input.spenderAddress);
    if (spender === wallet.address) {
      throw V2ApiError.fromCode("VALIDATION_FAILED");
    }
    // A spender is a counterparty that can move funds, so it walks the same
    // allowlist as a send recipient (Decision 0065). Revoke passes through:
    // `approve(spender, 0)` removes exposure.
    if (input.allowance.mode !== "zero") {
      requireCanaryCounterparty(writes, spender);
    }
    const allowanceRaw =
      input.allowance.mode === "unlimited"
        ? maxUint256
        : input.allowance.mode === "zero"
          ? 0n
          : parseIntentAmount(input.allowance.amount, asset.decimals);
    const isUnlimited = isUnlimitedAllowance(allowanceRaw);
    const requestId = runtime.createUuid();
    const outcome = await withPrepareIdempotency(
      runtime,
      {
        principal: input.principal,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        requestSha256: intentRequestDigest(input.kind, [
          wallet.walletId,
          asset.assetId,
          allowanceRaw.toString(10),
          spender,
        ]),
        requestId,
      },
      async (operationId): Promise<WalletIntentRecord> => {
        // The ceiling is enforced on the actual exposure an approval creates:
        // the spender can never move more than the wallet holds, so the
        // exposure is min(allowance, balance) at the snapshot block.
        const balance = await readBalanceSnapshot(runtime, wallet, asset);
        const exposureRaw =
          allowanceRaw < balance.rawBalance ? allowanceRaw : balance.rawBalance;
        let valuation: UsdValuation | null = null;
        if (allowanceRaw > 0n) {
          valuation = await valueInUsd(
            runtime,
            asset,
            exposureRaw,
            input.signal,
          );
          enforceCanaryCeiling(
            writes,
            valuation.valueUsd,
            isUnlimited
              ? walletIntentRefusalReasonCodes.unlimitedExposureExceedsCeiling
              : walletIntentRefusalReasonCodes.canaryCeilingExceeded,
          );
          await enforceDailyCanaryCeiling(
            runtime,
            writes,
            input.principal.userId,
            valuation.valueUsd,
          );
        }
        let spenderCode: Hex;
        try {
          spenderCode = await runtime.readClient.getCode(spender);
        } catch (error) {
          return chainUnavailable(error);
        }
        const call = buildErc20Approve({
          token: tokenAddress,
          spender,
          value: allowanceRaw,
        });
        const execution = await preExecute(
          runtime,
          { from: wallet.address, to: call.to, data: call.data, value: 0n },
          false,
        );
        const fee = await readFeeSnapshot(runtime, execution.gasLimit);
        assertNativeSufficiency({
          rawNativeBalance: balance.rawNativeBalance,
          nativeAmount: 0n,
          maximumFeeRaw: fee.maximumFeeRaw,
          gasReserveRaw: runtime.config.gasReserveRawWei,
        });
        const nonce = await readNonce(runtime, wallet.address);
        const now = runtime.now();
        const intentId = runtime.createUuid();
        const spenderReview: SpenderReview = Object.freeze({
          address: spender,
          checksumAddress: checksumAddress(spender),
          isContract: spenderCode !== "0x",
          isUnlimited,
        });
        const source: IntentSource = {
          version: walletIntentPayloadVersions[input.kind],
          intentId,
          kind: input.kind,
          chainId: bscChainId,
          walletId: wallet.walletId,
          from: wallet.address,
          asset: assetSnapshot(asset),
          amount: {
            raw: allowanceRaw.toString(10),
            display: isUnlimited
              ? "unlimited"
              : formatDecimalAmount(allowanceRaw, asset.decimals),
          },
          recipient: null,
          spender: spenderReview,
          decodedCall: projectDecodedApprove(call.data),
          transaction: buildUnsignedTransaction({
            kind: input.kind,
            chainReference: bscChainReference,
            from: wallet.address,
            to: call.to,
            data: call.data,
            value: 0n,
            gasLimit: execution.gasLimit,
            nonce,
            feeData: fee.feeData,
          }),
          fee: fee.fact,
          balance: balance.fact,
          simulation: execution.simulation,
          policy: canaryPolicyFact(writes, valuation, {
            basis: input.kind === "revoke" ? "none" : "balance_at_prepare",
            raw: input.kind === "revoke" ? null : exposureRaw,
            blockNumber:
              input.kind === "revoke" ? null : balance.fact.blockNumber,
          }),
          swap: null,
          signingMode: "device_eth_send_transaction",
          factsObservedAt: now.toISOString(),
          expiresAt: new Date(
            now.getTime() + approvalIntentTtlSeconds * 1000,
          ).toISOString(),
        };
        const sealed = sealIntent(source);
        return runtime.repository.create({
          intentId,
          ownerUserId: input.principal.userId,
          walletId: wallet.walletId,
          providerOperationId: operationId,
          kind: input.kind,
          state: intentStateForSimulation(execution.simulation),
          chainId: bscChainId,
          canonicalPayload: sealed.canonicalPayload,
          publicReview: sealed.publicReview,
          reviewSha256: sealed.reviewSha256,
          policyConfigVersion: writes.configVersion,
          factsObservedAt: source.factsObservedAt,
          expiresAt: source.expiresAt,
          simulationStatus: execution.simulation.status,
          requestId,
        });
      },
    );
    return Object.freeze({
      created: outcome.created,
      resource: projectIntent(
        outcome.record,
        runtime.now(),
        null,
        runtime.readClient.confirmations,
      ),
    });
  }

  async function readRows(
    walletId: string,
    walletAddress: string,
    candidates: readonly {
      readonly asset: AssetRecord;
      readonly spender: string;
      readonly lastApproval: ApprovalRowResource["lastApproval"];
    }[],
  ): Promise<{
    readonly rows: readonly ApprovalRowResource[];
    readonly headBlockNumber: string;
    readonly observedAt: string;
  }> {
    let read;
    try {
      read = await runtime.readClient.readAllowances(
        walletAddress,
        candidates.map((candidate) => ({
          assetId: candidate.asset.assetId,
          token: candidate.asset.address as string,
          spender: candidate.spender,
        })),
      );
    } catch (error) {
      return chainUnavailable(error);
    }
    const rows: ApprovalRowResource[] = [];
    for (const candidate of candidates) {
      const observed = read.allowances.find(
        (allowance) =>
          allowance.assetId === candidate.asset.assetId &&
          allowance.spender === candidate.spender,
      );
      let allowance: ApprovalRowResource["allowance"];
      if (observed === undefined || observed.rawValue === null) {
        allowance = Object.freeze({
          status: "unavailable" as const,
          reasonCode: observed?.reasonCode ?? "BSC_ALLOWANCE_CALL_FAILED",
        });
      } else {
        allowance = Object.freeze({
          status: "available" as const,
          rawValue: observed.rawValue.toString(10),
          displayValue: isUnlimitedAllowance(observed.rawValue)
            ? "unlimited"
            : formatDecimalAmount(observed.rawValue, candidate.asset.decimals),
          isUnlimited: isUnlimitedAllowance(observed.rawValue),
          blockNumber: read.head.blockNumber.toString(10),
          blockHash: read.head.blockHash,
          observedAt: read.head.observedAt,
        });
        try {
          await runtime.repository.recordApprovalObservation({
            walletId,
            assetId: candidate.asset.assetId,
            spenderAddress: candidate.spender,
            rawValue: observed.rawValue.toString(10),
            blockNumber: read.head.blockNumber.toString(10),
            blockHash: read.head.blockHash,
          });
        } catch {
          // Audit trail only; the observed value is still published.
        }
      }
      rows.push(
        Object.freeze({
          assetId: candidate.asset.assetId,
          symbol: candidate.asset.symbol,
          decimals: candidate.asset.decimals,
          spender: Object.freeze({
            address: candidate.spender,
            checksumAddress: checksumAddress(candidate.spender),
          }),
          allowance,
          lastApproval: candidate.lastApproval,
          riskFacts: Object.freeze({
            status: "unavailable" as const,
            reasonCode: approvalRiskReasonCode,
          }),
        }),
      );
    }
    return Object.freeze({
      rows: Object.freeze(rows),
      headBlockNumber: read.head.blockNumber.toString(10),
      observedAt: read.head.observedAt,
    });
  }

  const service: ApprovalService = {
    async prepareApprove({ principal, idempotencyKey, body, signal }) {
      if (typeof body !== "object" || body === null) {
        throw V2ApiError.invalidRequest();
      }
      const request = body as {
        readonly walletId?: unknown;
        readonly assetId?: unknown;
        readonly spenderAddress?: unknown;
        readonly allowance?: unknown;
        readonly acknowledgeUnlimited?: unknown;
      };
      if (typeof request.allowance !== "object" || request.allowance === null) {
        throw V2ApiError.invalidRequest();
      }
      const allowance = request.allowance as {
        readonly mode?: unknown;
        readonly amount?: unknown;
      };
      if (
        request.acknowledgeUnlimited !== undefined &&
        typeof request.acknowledgeUnlimited !== "boolean"
      ) {
        throw V2ApiError.invalidRequest();
      }
      let parsedAllowance:
        | { readonly mode: "unlimited" }
        | { readonly mode: "exact"; readonly amount: unknown };
      if (allowance.mode === "unlimited") {
        // The guard shows the unlimited notice and asks a second time; the
        // top-level acknowledgement is that second confirmation.
        if (request.acknowledgeUnlimited !== true) {
          throw V2ApiError.fromCode("VALIDATION_FAILED");
        }
        parsedAllowance = { mode: "unlimited" };
      } else if (allowance.mode === "exact") {
        if (typeof allowance.amount !== "string") {
          throw V2ApiError.invalidRequest();
        }
        parsedAllowance = { mode: "exact", amount: allowance.amount };
      } else {
        throw V2ApiError.invalidRequest();
      }
      return prepareAllowanceIntent({
        principal,
        idempotencyKey,
        kind: "approve",
        walletId: request.walletId,
        assetId: request.assetId,
        spenderAddress: request.spenderAddress,
        allowance: parsedAllowance,
        signal,
      });
    },

    async prepareRevoke({ principal, idempotencyKey, body, signal }) {
      if (typeof body !== "object" || body === null) {
        throw V2ApiError.invalidRequest();
      }
      const request = body as {
        readonly walletId?: unknown;
        readonly assetId?: unknown;
        readonly spenderAddress?: unknown;
      };
      return prepareAllowanceIntent({
        principal,
        idempotencyKey,
        kind: "revoke",
        walletId: request.walletId,
        assetId: request.assetId,
        spenderAddress: request.spenderAddress,
        allowance: { mode: "zero" },
        signal,
      });
    },

    async list({ principal, walletId }) {
      const wallet = await requireWallet(runtime, principal, walletId);
      const checkpoint = await runtime.indexer.getCheckpoint(
        "erc20_transfer",
        bscChainId,
      );
      if (checkpoint === null) {
        throw V2ApiError.fromCode("INDEXING_DELAYED");
      }
      // The lane shares its checkpoint with the transfer history, but
      // Approval decoding only covers [approvalCoverageFromBlockNumber,
      // lastBlockNumber]. An inventory is published only when that window
      // reaches back to the wallet's earliest indexed activity; otherwise
      // "no approvals" would be a gap, not a fact (S6 finding 4).
      const coverage = checkpoint.approvalCoverageFromBlockNumber;
      if (coverage === null) {
        throw V2ApiError.fromCode("INDEXING_DELAYED");
      }
      const earliestActivity =
        await runtime.indexer.earliestWalletActivityBlockNumber({
          chainId: bscChainId,
          address: wallet.address,
        });
      if (
        earliestActivity !== null &&
        BigInt(coverage) > BigInt(earliestActivity)
      ) {
        throw V2ApiError.fromCode("INDEXING_DELAYED");
      }
      const assets = (
        await runtime.registry.listReadableAssets(bscChainId)
      ).filter((asset) => asset.address !== null);
      const approvals = await runtime.indexer.listLatestApprovals({
        chainId: bscChainId,
        ownerAddress: wallet.address,
        assetIds: assets.map((asset) => asset.assetId),
      });
      const candidates = approvals.flatMap((approval) => {
        const asset = assets.find(
          (candidate) => candidate.assetId === approval.assetId,
        );
        return asset === undefined
          ? []
          : [
              {
                asset,
                spender: approval.spenderAddress,
                lastApproval: Object.freeze({
                  transactionHash: approval.transactionHash,
                  blockNumber: approval.blockNumber,
                  rawValue: approval.rawValue,
                  observedAt: approval.observedAt,
                }),
              },
            ];
      });
      const read = await readRows(wallet.walletId, wallet.address, candidates);
      // Only spenders that still hold a positive allowance are "active".
      const active = read.rows.filter(
        (row) =>
          row.allowance.status === "available" &&
          row.allowance.rawValue !== "0",
      );
      return Object.freeze({
        walletId: wallet.walletId,
        items: Object.freeze(
          read.rows.filter(
            (row) =>
              row.allowance.status !== "available" ||
              row.allowance.rawValue !== "0",
          ),
        ),
        summary: Object.freeze({
          activeCount: active.length,
          unlimitedCount: active.filter(
            (row) =>
              row.allowance.status === "available" && row.allowance.isUnlimited,
          ).length,
        }),
        freshness: Object.freeze({
          indexerBlockNumber: checkpoint.lastBlockNumber,
          approvalCoverageFromBlockNumber: coverage,
          headBlockNumber: read.headBlockNumber,
          observedAt: read.observedAt,
        }),
        contractVersion: v2ContractVersion,
      });
    },

    async get({ principal, walletId, assetId, spender }) {
      const wallet = await requireWallet(runtime, principal, walletId);
      if (!isAssetId(assetId) || !isNormalizedEvmAddress(spender)) {
        throw V2ApiError.invalidRequest();
      }
      const asset = await runtime.registry.getAsset(assetId);
      if (asset === null || asset.address === null) {
        throw V2ApiError.notFound();
      }
      if (asset.status === "blocked") {
        throw V2ApiError.fromCode("POLICY_BLOCKED");
      }
      const approvals = await runtime.indexer.listLatestApprovals({
        chainId: bscChainId,
        ownerAddress: wallet.address,
        assetIds: [asset.assetId],
      });
      const last = approvals.find(
        (approval) => approval.spenderAddress === spender,
      );
      const read = await readRows(wallet.walletId, wallet.address, [
        {
          asset,
          spender,
          lastApproval:
            last === undefined
              ? null
              : Object.freeze({
                  transactionHash: last.transactionHash,
                  blockNumber: last.blockNumber,
                  rawValue: last.rawValue,
                  observedAt: last.observedAt,
                }),
        },
      ]);
      const item = read.rows[0];
      if (item === undefined) {
        throw V2ApiError.notFound();
      }
      return Object.freeze({
        walletId: wallet.walletId,
        item,
        contractVersion: v2ContractVersion,
      });
    },
  };
  return Object.freeze(service);
}
