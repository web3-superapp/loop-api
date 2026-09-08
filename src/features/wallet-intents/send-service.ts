import type { Hex } from "viem";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import type { WalletIntentRecord } from "../../database/wallet-intent-repository.js";
import {
  buildErc20Transfer,
  buildNativeTransfer,
  checksumAddress,
  decodeErc20Call,
  InvalidTransactionArgumentError,
  parseRecipientAddress,
} from "../../integrations/bsc/tx-builder.js";
import {
  bscChainId,
  formatDecimalAmount,
  isChainId,
} from "../chain/chain-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  sealIntent,
  sendIntentTtlSeconds,
  walletIntentPayloadVersions,
  walletIntentReasonCodes,
  intentRequestDigest,
  type DecodedCallReview,
  type IntentSource,
  type RecipientReview,
} from "./intent-contract.js";
import {
  assertNativeSufficiency,
  assetSnapshot,
  buildUnsignedTransaction,
  canaryPolicyFact,
  enforceCanaryCeiling,
  intentStateForSimulation,
  parseIntentAmount,
  preExecute,
  projectIntent,
  readBalanceSnapshot,
  readFeeSnapshot,
  readNonce,
  requireCanaryAsset,
  requireSignableWallet,
  requireWallet,
  requireWriteAdmission,
  valueInUsd,
  withPrepareIdempotency,
  type WalletIntentResource,
  type WalletIntentRuntime,
} from "./intent-preparation.js";

/**
 * D16 Send (Decision 0035): recipient preflight and the immutable send
 * intent. The server builds the exact unsigned transaction (native transfer
 * or ERC-20 `transfer`), pre-executes it, and binds every fact it relied on
 * into the canonical payload the device will sign.
 */

export interface RecipientPreflightResource {
  readonly walletId: string;
  readonly chainId: string;
  readonly recipient: RecipientReview;
  readonly warnings: readonly string[];
  readonly contractVersion: typeof v2ContractVersion;
}

export interface SendService {
  preflight(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly body: unknown;
  }): Promise<RecipientPreflightResource>;
  prepare(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly body: unknown;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly created: boolean;
    readonly resource: WalletIntentResource;
  }>;
}

function parseRecipient(value: unknown): string {
  try {
    return parseRecipientAddress(value);
  } catch (error) {
    if (error instanceof InvalidTransactionArgumentError) {
      throw V2ApiError.invalidRequest();
    }
    throw error;
  }
}

function assertChain(chainId: unknown): void {
  if (chainId === undefined) {
    return;
  }
  if (!isChainId(chainId)) {
    throw V2ApiError.invalidRequest();
  }
  if (chainId !== bscChainId) {
    throw V2ApiError.fromCode("CHAIN_MISMATCH");
  }
}

export async function reviewRecipient(
  runtime: WalletIntentRuntime,
  walletAddress: string,
  recipient: string,
): Promise<RecipientReview> {
  let code: Hex;
  try {
    code = await runtime.readClient.getCode(recipient);
  } catch {
    throw V2ApiError.capabilityUnavailable();
  }
  const isFirstRecipient = !(await runtime.indexer.hasOutgoingTransferTo({
    chainId: bscChainId,
    fromAddress: walletAddress,
    toAddress: recipient,
  }));
  return Object.freeze({
    address: recipient,
    checksumAddress: checksumAddress(recipient),
    isContract: code !== "0x",
    isFirstRecipient,
    // Malicious-address screening needs the GoPlus address endpoint, which
    // is not connected; the sheet shows a strong notice, never a verdict.
    screening: Object.freeze({
      status: "unavailable" as const,
      reasonCode: walletIntentReasonCodes.screeningNotConfigured,
    }),
  });
}

export function createSendService(runtime: WalletIntentRuntime): SendService {
  const service: SendService = {
    async preflight({ principal, body }) {
      if (typeof body !== "object" || body === null) {
        throw V2ApiError.invalidRequest();
      }
      const request = body as {
        readonly walletId?: unknown;
        readonly address?: unknown;
        readonly chainId?: unknown;
      };
      assertChain(request.chainId);
      const wallet = await requireWallet(runtime, principal, request.walletId);
      const recipient = parseRecipient(request.address);
      if (recipient === wallet.address) {
        throw V2ApiError.fromCode("VALIDATION_FAILED");
      }
      if (runtime.readClient.currentVerification() !== "verified") {
        const state = await runtime.readClient.verifyChain();
        if (state !== "verified") {
          throw V2ApiError.capabilityUnavailable();
        }
      }
      const review = await reviewRecipient(runtime, wallet.address, recipient);
      const warnings: string[] = [];
      if (review.isFirstRecipient) {
        warnings.push("send.recipient.firstTime");
      }
      if (review.isContract) {
        warnings.push("send.recipient.isContract");
      }
      warnings.push("send.recipient.screeningUnavailable");
      return Object.freeze({
        walletId: wallet.walletId,
        chainId: bscChainId,
        recipient: review,
        warnings: Object.freeze(warnings),
        contractVersion: v2ContractVersion,
      });
    },

    async prepare({ principal, idempotencyKey, body, signal }) {
      if (typeof body !== "object" || body === null) {
        throw V2ApiError.invalidRequest();
      }
      const request = body as {
        readonly walletId?: unknown;
        readonly assetId?: unknown;
        readonly amount?: unknown;
        readonly recipientAddress?: unknown;
        readonly chainId?: unknown;
      };
      assertChain(request.chainId);
      const writes = await requireWriteAdmission(runtime);
      const wallet = await requireSignableWallet(
        runtime,
        principal,
        request.walletId,
      );
      const asset = await requireCanaryAsset(runtime, writes, request.assetId);
      const amountRaw = parseIntentAmount(request.amount, asset.decimals);
      const recipient = parseRecipient(request.recipientAddress);
      if (recipient === wallet.address) {
        throw V2ApiError.fromCode("VALIDATION_FAILED");
      }
      const requestId = runtime.createUuid();
      const outcome = await withPrepareIdempotency(
        runtime,
        {
          principal,
          kind: "send",
          idempotencyKey,
          requestSha256: intentRequestDigest("send", [
            wallet.walletId,
            asset.assetId,
            amountRaw.toString(10),
            recipient,
          ]),
          requestId,
        },
        async (operationId): Promise<WalletIntentRecord> => {
          const valuation = await valueInUsd(runtime, asset, amountRaw, signal);
          enforceCanaryCeiling(writes, valuation.valueUsd);
          const balance = await readBalanceSnapshot(runtime, wallet, asset);
          if (amountRaw > balance.rawBalance) {
            throw V2ApiError.fromCode("INSUFFICIENT_BALANCE");
          }
          const recipientReview = await reviewRecipient(
            runtime,
            wallet.address,
            recipient,
          );
          const isNative = asset.address === null;
          const call =
            asset.address === null
              ? buildNativeTransfer({ to: recipient, value: amountRaw })
              : buildErc20Transfer({
                  token: asset.address,
                  to: recipient,
                  value: amountRaw,
                });
          const execution = await preExecute(
            runtime,
            {
              from: wallet.address,
              to: call.to,
              data: call.data,
              value: call.value,
            },
            isNative,
          );
          const fee = await readFeeSnapshot(runtime, execution.gasLimit);
          assertNativeSufficiency({
            rawNativeBalance: balance.rawNativeBalance,
            nativeAmount: isNative ? amountRaw : 0n,
            maximumFeeRaw: fee.maximumFeeRaw,
            gasReserveRaw: runtime.config.gasReserveRawWei,
          });
          const nonce = await readNonce(runtime, wallet.address);
          const now = runtime.now();
          const intentId = runtime.createUuid();
          const decodedCall: DecodedCallReview | null = isNative
            ? null
            : projectDecodedTransfer(call.data);
          const source: IntentSource = {
            version: walletIntentPayloadVersions.send,
            intentId,
            kind: "send",
            chainId: bscChainId,
            walletId: wallet.walletId,
            from: wallet.address,
            asset: assetSnapshot(asset),
            amount: {
              raw: amountRaw.toString(10),
              display: formatDecimalAmount(amountRaw, asset.decimals),
            },
            recipient: recipientReview,
            spender: null,
            decodedCall,
            transaction: buildUnsignedTransaction({
              from: wallet.address,
              to: call.to,
              data: call.data,
              value: call.value,
              gasLimit: execution.gasLimit,
              nonce,
              feeData: fee.feeData,
            }),
            fee: fee.fact,
            balance: balance.fact,
            simulation: execution.simulation,
            policy: canaryPolicyFact(writes, valuation),
            swap: null,
            signingMode: "device_eth_send_transaction",
            factsObservedAt: now.toISOString(),
            expiresAt: new Date(
              now.getTime() + sendIntentTtlSeconds * 1000,
            ).toISOString(),
          };
          const sealed = sealIntent(source);
          return runtime.repository.create({
            intentId,
            ownerUserId: principal.userId,
            walletId: wallet.walletId,
            providerOperationId: operationId,
            kind: "send",
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
    },
  };
  return Object.freeze(service);
}

export function projectDecodedTransfer(data: Hex): DecodedCallReview {
  const decoded = decodeErc20Call(data);
  if (decoded.functionName !== "transfer") {
    throw new InvalidTransactionArgumentError();
  }
  return Object.freeze({
    functionName: "transfer" as const,
    selector: data.slice(0, 10),
    args: Object.freeze({
      to: decoded.to,
      value: decoded.value.toString(10),
    }),
  });
}
