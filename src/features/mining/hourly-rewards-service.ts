import { createHash, randomUUID } from "node:crypto";

import { encodeFunctionData } from "viem";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
} from "../../core/http/v2-cursor.js";
import {
  V2ApiError,
  type V2ErrorCode,
  type V2ErrorDetailsSafe,
} from "../../core/http/v2-error.js";
import { isOpaqueId } from "../../core/ids/opaque-id.js";
import { canonicalJson } from "../../core/json/canonical-json.js";
import type {
  AccountWalletRecord,
  AccountWalletRepository,
} from "../../database/account-wallet-repository.js";
import type {
  BscChainCallClient,
  BscFeeData,
} from "../../integrations/bsc/rpc-client.js";
import { toHexQuantity } from "../../integrations/bsc/tx-builder.js";
import { loopRewardClaimAbi } from "../../integrations/mining/loop-reward-claim-abi.js";
import {
  assetIdForAddress,
  bscChainId,
  nativeAssetId,
} from "../chain/chain-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import type { MiningClaimSigner } from "./claim-voucher.js";
import { projectMiningMinuteDisplay } from "./hourly-display.js";
import {
  formatMiningDecimal,
  miningClaimDeadlineGraceSeconds,
  miningClaimDeadlineSeconds,
  miningClaimFallbackGas,
  miningClaimLogSearchBlocks,
  miningSettlementReasonCodes as reasons,
} from "./hourly-settlement-contract.js";
import {
  MiningClaimIdempotencyConflictError,
  MiningSettlementConflictError,
  MiningSettlementUnavailableError,
  type MiningClaimChain,
  type MiningClaimRecord,
  type MiningEpochRewardRecord,
  type MiningSettlementRepository,
} from "./hourly-settlement-ports.js";
import { miningVersionAt } from "./hourly-settlement-runner.js";

/**
 * Decision 0116: the hourly-settlement half of the `mining` module — the
 * `hourly` block of `GET /v2/mining/rewards`, the epoch history, the claim
 * list, and the claim prepare / report. Every number comes from the
 * settled ledger; the claim prepare signs an EIP-712 voucher and returns
 * the unsigned `claim(...)` transaction for the device signing exit
 * (`device_eth_send_transaction`); nothing is broadcast here. Anything
 * missing is 503 with the reason, never an estimate.
 */

type Resource = Record<string, unknown>;

export interface MiningRewardsServiceDependencies {
  readonly repository: MiningSettlementRepository | null;
  readonly chain: MiningClaimChain | null;
  readonly callClient: BscChainCallClient | null;
  readonly wallets: AccountWalletRepository | null;
  readonly signer: MiningClaimSigner | null;
  readonly contractAddress: string | null;
  /** CAIP-2 id of the launch slot the claim contract lives on. */
  readonly chainId: string;
  readonly writesEnabled: boolean;
  readonly usdtAddress: string | null;
  readonly confirmations: number;
  readonly cursorCodec: V2CursorCodec | null;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
}

export interface MiningRewardsService {
  hourlyBlock(principal: AuthenticatedLoopPrincipal): Promise<Resource>;
  listEpochs(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly cursor?: unknown;
  }): Promise<Resource>;
  listClaims(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly cursor?: unknown;
  }): Promise<Resource>;
  prepareClaim(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly body: unknown;
    readonly idempotencyKey: string;
  }): Promise<Resource>;
  reportClaim(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly body: unknown;
    readonly idempotencyKey: string;
  }): Promise<Resource>;
  /** Worker: re-checks one open claim against the chain. */
  reconcileClaim(claim: MiningClaimRecord): Promise<MiningClaimRecord>;
}

const epochPageSize = 24;
const claimPageSize = 20;
const txHashPattern = /^0x[0-9a-f]{64}$/u;

function unavailableWith(reasonCode: string): never {
  throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", { reasonCode });
}

function refuse(
  code: V2ErrorCode,
  reasonCode: string,
  extra: V2ErrorDetailsSafe = {},
): never {
  throw V2ApiError.fromCode(code, { reasonCode, ...extra });
}

function translate(error: unknown): never {
  if (error instanceof V2ApiError) throw error;
  if (error instanceof MiningClaimIdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (error instanceof MiningSettlementConflictError) {
    if (error.reasonCode === reasons.claimHashConflict) {
      refuse("RESOURCE_CONFLICT", error.reasonCode);
    }
    refuse("RESOURCE_CONFLICT", error.reasonCode);
  }
  if (error instanceof MiningSettlementUnavailableError) {
    return unavailableWith(reasons.settlementUnavailable);
  }
  return unavailableWith(reasons.claimChainReadFailed);
}

async function chainRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof V2ApiError) throw error;
    return unavailableWith(reasons.claimChainReadFailed);
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sumPower(left: string, right: string): string {
  const parse = (value: string): bigint => {
    const [whole, fraction = ""] = value.split(".");
    return (
      BigInt(whole as string) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"))
    );
  };
  return formatMiningDecimal(parse(left) + parse(right));
}

function rewardRow(reward: MiningEpochRewardRecord): Resource {
  return Object.freeze({
    epochId: reward.epochId,
    hourStart: reward.hourStart,
    hourEnd: reward.hourEnd,
    nftSelfPower: reward.nftSelfPower,
    nftReferralPower: reward.nftReferralPower,
    nftTotalPower: reward.nftTotalPower,
    assetSelfPower: reward.assetSelfPower,
    assetReferralPower: reward.assetReferralPower,
    assetTotalPower: reward.assetTotalPower,
    nftRewardRaw: reward.nftRewardRaw,
    assetRewardRaw: reward.assetRewardRaw,
    totalRewardRaw: reward.totalRewardRaw,
  });
}

export function projectMiningClaim(
  claim: MiningClaimRecord,
  chainReference: number | null,
): Resource {
  return Object.freeze({
    claimId: claim.claimId,
    walletId: claim.walletId,
    status: claim.status,
    chainId: claim.chainId,
    chainReference,
    contractAddress: claim.contractAddress,
    cumulativeAmountRaw: claim.cumulativeAmountRaw,
    amountRaw: claim.confirmedDeltaRaw ?? claim.expectedDeltaRaw,
    nonce: claim.nonce,
    deadline: claim.deadline,
    transactionHash: claim.transactionHash,
    blockNumber: claim.blockNumber,
    failureReasonCode: claim.failureReasonCode,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
  });
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

function parsePrepareBody(body: unknown): { readonly walletId: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw V2ApiError.invalidRequest();
  }
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => key !== "walletId") ||
    !isOpaqueId(value["walletId"])
  ) {
    throw V2ApiError.invalidRequest();
  }
  return { walletId: value["walletId"] };
}

function parseReportBody(body: unknown): {
  readonly claimId: string;
  readonly transactionHash: string;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw V2ApiError.invalidRequest();
  }
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => key !== "claimId" && key !== "transactionHash",
    ) ||
    !isOpaqueId(value["claimId"]) ||
    typeof value["transactionHash"] !== "string" ||
    !txHashPattern.test(value["transactionHash"])
  ) {
    throw V2ApiError.invalidRequest();
  }
  return {
    claimId: value["claimId"],
    transactionHash: value["transactionHash"],
  };
}

/** Which claim dependency is missing, in the order an operator fixes them. */
export function miningClaimUnavailableReason(
  deps: Pick<
    MiningRewardsServiceDependencies,
    | "repository"
    | "chain"
    | "callClient"
    | "signer"
    | "contractAddress"
    | "chainId"
    | "writesEnabled"
    | "wallets"
  >,
): string | null {
  if (deps.repository === null) return reasons.settlementUnavailable;
  if (deps.chainId === bscChainId) return reasons.claimMainnetClosed;
  if (deps.contractAddress === null) return reasons.claimContractNotConfigured;
  if (
    deps.chain === null ||
    deps.callClient === null ||
    deps.wallets === null
  ) {
    return reasons.claimChainNotConfigured;
  }
  if (deps.signer === null) return reasons.claimSignerNotConfigured;
  if (!deps.writesEnabled) return reasons.claimWritesDisabled;
  return null;
}

export function createMiningRewardsService(
  deps: MiningRewardsServiceDependencies,
): MiningRewardsService {
  const now = deps.now ?? ((): Date => new Date());
  const createUuid = deps.createUuid ?? randomUUID;

  function repository(): MiningSettlementRepository {
    if (deps.repository === null) {
      return unavailableWith(reasons.settlementUnavailable);
    }
    return deps.repository;
  }

  function cursorCodec(): V2CursorCodec {
    if (deps.cursorCodec === null) {
      return unavailableWith(reasons.settlementUnavailable);
    }
    return deps.cursorCodec;
  }

  function decodeCursor(
    principal: AuthenticatedLoopPrincipal,
    route: string,
    cursor: unknown,
  ): Readonly<Record<string, string | number | boolean>> | null {
    if (cursor === undefined) return null;
    if (typeof cursor !== "string") throw V2ApiError.invalidRequest();
    try {
      return cursorCodec().decode({
        ownerId: principal.userId,
        route,
        filter: "",
        cursor,
      });
    } catch (error) {
      if (error instanceof InvalidV2CursorError) {
        throw V2ApiError.invalidRequest();
      }
      throw error;
    }
  }

  function claimDeps() {
    const reason = miningClaimUnavailableReason(deps);
    if (reason !== null) unavailableWith(reason);
    return {
      repository: deps.repository as MiningSettlementRepository,
      chain: deps.chain as MiningClaimChain,
      callClient: deps.callClient as BscChainCallClient,
      wallets: deps.wallets as AccountWalletRepository,
      signer: deps.signer as MiningClaimSigner,
      contract: deps.contractAddress as string,
    };
  }

  async function signingWallet(
    principal: AuthenticatedLoopPrincipal,
    wallets: AccountWalletRepository,
    walletId: string,
  ): Promise<AccountWalletRecord> {
    const wallet = await wallets
      .get(principal.userId, walletId)
      .catch(() => unavailableWith(reasons.claimChainNotConfigured));
    if (wallet === null || wallet.status !== "active") {
      throw V2ApiError.notFound();
    }
    if (wallet.kind !== "embedded" || wallet.providerWalletId === null) {
      refuse("VALIDATION_FAILED", reasons.claimWalletNotEmbedded);
    }
    return wallet;
  }

  async function reconcileWithHash(
    claim: MiningClaimRecord,
    transactionHash: string,
  ): Promise<MiningClaimRecord> {
    const repo = repository();
    const chain = deps.chain;
    if (chain === null) return unavailableWith(reasons.claimChainNotConfigured);
    const receipt = await chainRead(() =>
      chain.readReceipt({ contract: claim.contractAddress, transactionHash }),
    );
    if (receipt.kind === "not_found") {
      return repo.transitionClaim({
        claimId: claim.claimId,
        transition: { kind: "submitted", transactionHash },
      });
    }
    if (receipt.kind === "reverted") {
      return repo.transitionClaim({
        claimId: claim.claimId,
        transition: {
          kind: "failed",
          transactionHash,
          blockNumber: receipt.blockNumber.toString(),
          reasonCode: reasons.claimReverted,
        },
      });
    }
    const log = receipt.logs.find(
      (entry) =>
        entry.wallet === claim.walletAddress &&
        entry.nonce === BigInt(claim.nonce) &&
        entry.cumulativeAmountRaw === BigInt(claim.cumulativeAmountRaw),
    );
    if (log === undefined) {
      // A mined transaction that is not this voucher's claim: nothing is
      // recorded; the voucher may still land in another transaction.
      return refuse("DATA_STALE", reasons.claimTransactionMismatch);
    }
    if (receipt.confirmations < BigInt(deps.confirmations)) {
      return repo.transitionClaim({
        claimId: claim.claimId,
        transition: {
          kind: "confirming",
          transactionHash,
          blockNumber: receipt.blockNumber.toString(),
        },
      });
    }
    return repo.transitionClaim({
      claimId: claim.claimId,
      transition: {
        kind: "succeeded",
        transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        deltaRaw: log.amountRaw.toString(),
      },
    });
  }

  const service: MiningRewardsService = {
    async hourlyBlock(principal) {
      const serverTime = now();
      const base = {
        serverTime: serverTime.toISOString(),
        decimals: 18,
      };
      const claimReason = miningClaimUnavailableReason(deps);
      if (deps.repository === null) {
        return Object.freeze({
          ...base,
          displayState: "unavailable",
          reasonCode: reasons.settlementUnavailable,
          totals: null,
          lastHour: null,
          display: null,
          tracks: null,
          referral: null,
          parameters: null,
          claim: {
            executable: false,
            reasonCode: claimReason,
            latest: null,
          },
        });
      }
      const repo = deps.repository;
      try {
        const nowSeconds = BigInt(Math.floor(serverTime.getTime() / 1000));
        const [balance, latest, versions, claims] = await Promise.all([
          repo.getBalance(principal.userId),
          repo.latestSettledEpoch(),
          repo.listApprovedParameterVersions(),
          repo.listClaims({
            userId: principal.userId,
            beforeCreatedAt: null,
            beforeClaimId: null,
            limit: 1,
          }),
        ]);
        const version = miningVersionAt(versions, nowSeconds);
        const reward =
          latest === null
            ? null
            : await repo.getUserEpochReward(principal.userId, latest.epochId);
        const total = BigInt(reward?.totalRewardRaw ?? "0");
        const display = projectMiningMinuteDisplay({
          now: serverTime,
          lastEpoch:
            latest === null
              ? null
              : {
                  hourStart: latest.hourStart,
                  hourEnd: latest.hourEnd,
                  totalRewardRaw: total,
                },
        });
        const excluded = (latest?.inputSummary["excludedAssets"] ?? []) as {
          assetId: string;
          reasonCode: string;
        }[];
        const ratios =
          version?.document.referralRatiosBps ??
          (latest === null ? null : null);
        const levels =
          reward?.levels ??
          (ratios === null
            ? null
            : ratios.map((ratioBps, index) => ({
                level: index + 1,
                ratioBps,
                effectiveMembers: 0,
                nftPower: "0",
                assetPower: "0",
                nftUnitsByCommunity: [],
              })));
        return Object.freeze({
          ...base,
          displayState: display.displayState,
          reasonCode:
            latest === null && version === null
              ? reasons.parametersPending
              : null,
          totals: Object.freeze({
            settledRaw: balance.settledTotalRaw,
            claimedRaw: balance.claimedTotalRaw,
            claimableRaw: balance.unclaimedRaw,
          }),
          lastHour:
            latest === null
              ? null
              : Object.freeze({
                  epochId: latest.epochId,
                  hourStart: latest.hourStart,
                  hourEnd: latest.hourEnd,
                  settledAt: latest.settledAt,
                  nftRewardRaw: reward?.nftRewardRaw ?? "0",
                  assetRewardRaw: reward?.assetRewardRaw ?? "0",
                  totalRewardRaw: total.toString(),
                }),
          display:
            latest === null
              ? null
              : Object.freeze({
                  windowStart: display.windowStart,
                  windowEnd: display.windowEnd,
                  totalRaw: display.totalRaw,
                  perMinuteRaw: display.perMinuteRaw,
                  completedMinutes: display.completedMinutes,
                  displayedRaw: display.displayedRaw,
                  nextUpdateAt: display.nextUpdateAt,
                }),
          tracks:
            latest === null
              ? null
              : Object.freeze({
                  nft: Object.freeze({
                    realNftCount: (reward?.nftHoldings ?? [])
                      .reduce(
                        (sum, holding) => sum + BigInt(holding.countAtEnd),
                        0n,
                      )
                      .toString(),
                    selfPower: reward?.nftSelfPower ?? "0",
                    referralPower: reward?.nftReferralPower ?? "0",
                    totalPower: reward?.nftTotalPower ?? "0",
                    networkPower: latest.denominatorNftPower,
                    budgetRaw: latest.budgetNftRaw,
                    rewardRaw: reward?.nftRewardRaw ?? "0",
                    holdings: reward?.nftHoldings ?? [],
                  }),
                  asset: Object.freeze({
                    selfPower: reward?.assetSelfPower ?? "0",
                    referralPower: reward?.assetReferralPower ?? "0",
                    totalPower: reward?.assetTotalPower ?? "0",
                    networkPower: latest.denominatorAssetPower,
                    budgetRaw: latest.budgetAssetRaw,
                    rewardRaw: reward?.assetRewardRaw ?? "0",
                    holdings: reward?.assetHoldings ?? [],
                    excludedAssets: excluded.map((entry) => ({
                      assetId: entry.assetId,
                      reasonCode: entry.reasonCode,
                    })),
                  }),
                }),
          referral:
            levels === null
              ? null
              : Object.freeze({
                  levels: levels.map((level) =>
                    Object.freeze({
                      level: level.level,
                      ratioBps: level.ratioBps,
                      effectiveMembers: level.effectiveMembers,
                      nftPower: level.nftPower,
                      assetPower: level.assetPower,
                      totalPower: sumPower(level.nftPower, level.assetPower),
                      nftUnitsByCommunity: level.nftUnitsByCommunity,
                    }),
                  ),
                }),
          parameters:
            version === null
              ? null
              : Object.freeze({
                  versionId: version.versionId,
                  configVersion: version.configVersion,
                  effectiveFrom: version.effectiveFrom,
                  referralRatiosBps: version.document.referralRatiosBps,
                  minimumClaimRaw: version.document.minimumClaimRaw,
                }),
          claim: Object.freeze({
            executable: claimReason === null,
            reasonCode: claimReason,
            latest:
              claims[0] === undefined
                ? null
                : projectMiningClaim(
                    claims[0],
                    deps.chain?.chainReference ?? null,
                  ),
          }),
        });
      } catch (error) {
        if (error instanceof MiningSettlementUnavailableError) {
          return Object.freeze({
            ...base,
            displayState: "unavailable",
            reasonCode: reasons.settlementUnavailable,
            totals: null,
            lastHour: null,
            display: null,
            tracks: null,
            referral: null,
            parameters: null,
            claim: { executable: false, reasonCode: claimReason, latest: null },
          });
        }
        throw error;
      }
    },

    async listEpochs(input) {
      try {
        const repo = repository();
        const continuation = decodeCursor(
          input.principal,
          "miningRewardEpochs",
          input.cursor,
        );
        const before =
          continuation === null ? null : String(continuation["at"]);
        const rows = await repo.listUserEpochRewards({
          userId: input.principal.userId,
          beforeHourStart: before,
          limit: epochPageSize + 1,
        });
        const page = rows.slice(0, epochPageSize);
        const last = page[page.length - 1];
        return Object.freeze({
          items: page.map(rewardRow),
          nextCursor:
            rows.length > epochPageSize && last !== undefined
              ? cursorCodec().encode({
                  ownerId: input.principal.userId,
                  route: "miningRewardEpochs",
                  filter: "",
                  continuation: { at: last.hourStart },
                })
              : null,
          decimals: 18,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listClaims(input) {
      try {
        const repo = repository();
        const continuation = decodeCursor(
          input.principal,
          "miningClaims",
          input.cursor,
        );
        const rows = await repo.listClaims({
          userId: input.principal.userId,
          beforeCreatedAt:
            continuation === null ? null : String(continuation["at"]),
          beforeClaimId:
            continuation === null ? null : String(continuation["id"]),
          limit: claimPageSize + 1,
        });
        const page = rows.slice(0, claimPageSize);
        const last = page[page.length - 1];
        return Object.freeze({
          items: page.map((claim) =>
            projectMiningClaim(claim, deps.chain?.chainReference ?? null),
          ),
          nextCursor:
            rows.length > claimPageSize && last !== undefined
              ? cursorCodec().encode({
                  ownerId: input.principal.userId,
                  route: "miningClaims",
                  filter: "",
                  continuation: { at: last.createdAt, id: last.claimId },
                })
              : null,
          decimals: 18,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async prepareClaim(input) {
      try {
        const body = parsePrepareBody(input.body);
        const ready = claimDeps();
        const wallet = await signingWallet(
          input.principal,
          ready.wallets,
          body.walletId,
        );
        const walletAddress = wallet.address.toLowerCase();
        const result = await ready.repository.createClaim({
          userId: input.principal.userId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: sha256({ walletId: wallet.walletId }),
          build: async () => {
            const nowDate = now();
            const nowSeconds = BigInt(Math.floor(nowDate.getTime() / 1000));
            const [balance, open, priorWallets, versions] = await Promise.all([
              ready.repository.getBalance(input.principal.userId),
              ready.repository.listOpenClaims(input.principal.userId),
              ready.repository.listUserClaimWallets(input.principal.userId),
              ready.repository.listApprovedParameterVersions(),
            ]);
            for (const claim of open) {
              const live =
                Date.parse(claim.deadline) +
                  miningClaimDeadlineGraceSeconds * 1000 >
                nowDate.getTime();
              if (
                claim.status === "submitting" ||
                claim.status === "confirming" ||
                (live && claim.walletAddress !== walletAddress)
              ) {
                refuse("RESOURCE_CONFLICT", reasons.claimInFlight, {
                  claimId: claim.claimId,
                });
              }
            }
            const state = await chainRead(() =>
              ready.chain.readClaimState({
                contract: ready.contract,
                wallet: walletAddress,
                otherWallets: priorWallets,
              }),
            );
            if (state.paused) {
              unavailableWith(reasons.claimContractPaused);
            }
            let paid = 0n;
            for (const amount of state.claimedByWallet.values()) paid += amount;
            const settled = BigInt(balance.settledTotalRaw);
            if (paid > settled) {
              refuse("RESOURCE_CONFLICT", reasons.claimLedgerMismatch);
            }
            const claimable = settled - paid;
            const minimum = BigInt(
              miningVersionAt(versions, nowSeconds)?.document.minimumClaimRaw ??
                "1000000000000000000",
            );
            if (claimable === 0n) {
              refuse("INSUFFICIENT_BALANCE", reasons.claimNothingToClaim);
            }
            if (claimable < minimum) {
              refuse("INSUFFICIENT_BALANCE", reasons.claimBelowMinimum, {
                minimumRaw: minimum.toString(),
                claimableRaw: claimable.toString(),
              });
            }
            if (state.contractBalanceRaw < claimable) {
              unavailableWith(reasons.claimFundingInsufficient);
            }
            const cumulative =
              (state.claimedByWallet.get(walletAddress) ?? 0n) + claimable;
            const deadline = nowSeconds + BigInt(miningClaimDeadlineSeconds);
            const signature = await ready.signer.sign({
              chainId: ready.chain.chainReference,
              contract: ready.contract as `0x${string}`,
              voucher: {
                wallet: walletAddress as `0x${string}`,
                cumulativeAmount: cumulative,
                nonce: state.nonce,
                deadline,
              },
            });
            const data = encodeFunctionData({
              abi: loopRewardClaimAbi,
              functionName: "claim",
              args: [
                walletAddress as `0x${string}`,
                cumulative,
                state.nonce,
                deadline,
                signature,
              ],
            });
            const request = {
              from: walletAddress,
              to: ready.contract,
              data,
              value: 0n,
            };
            const simulated = await chainRead(() =>
              ready.callClient.call(request),
            );
            if (simulated.status === "reverted") {
              refuse("SIMULATION_FAILED", reasons.claimSimulationReverted);
            }
            const estimate = await ready.callClient
              .estimateGas(request)
              .catch(() => null);
            const gasLimit =
              estimate === null
                ? miningClaimFallbackGas
                : (estimate * 12n) / 10n;
            const native = nativeAssetId(deps.chainId);
            const usdt = deps.usdtAddress;
            const [fee, txNonce, balances] = await chainRead(() =>
              Promise.all([
                ready.callClient.getFeeData(),
                ready.callClient.getTransactionCount(walletAddress),
                ready.callClient.readBalances(walletAddress, [
                  { assetId: native, address: null },
                  ...(usdt === null
                    ? []
                    : [
                        {
                          assetId: assetIdForAddress(deps.chainId, usdt),
                          address: usdt,
                        },
                      ]),
                ]),
              ]),
            );
            const nativeBalance = balances.balances[0]?.rawValue;
            if (nativeBalance === undefined || nativeBalance === null) {
              return unavailableWith(reasons.claimChainReadFailed);
            }
            const perGas =
              fee.type === "eip1559" ? fee.maxFeePerGas : fee.gasPrice;
            const required = gasLimit * perGas;
            if (required > nativeBalance) {
              const shortfall = required - nativeBalance;
              const usdtBalance =
                usdt === null ? null : (balances.balances[1]?.rawValue ?? null);
              const suggested = formatMiningDecimal((shortfall * 3n) / 2n);
              if (usdtBalance !== null && usdtBalance > 0n) {
                refuse("INSUFFICIENT_BALANCE", reasons.claimGasInsufficient, {
                  requiredNativeAmount: formatMiningDecimal(required),
                  suggestedSwapFromSymbol: "USDT",
                  suggestedSwapFromAssetId: assetIdForAddress(
                    deps.chainId,
                    usdt as string,
                  ),
                  suggestedSwapToSymbol: "BNB",
                  suggestedSwapToAssetId: native,
                  suggestedSwapToAmount: suggested,
                });
              }
              refuse("INSUFFICIENT_BALANCE", reasons.claimNoGasSource, {
                requiredNativeAmount: formatMiningDecimal(required),
              });
            }
            return {
              claimId: createUuid(),
              userId: input.principal.userId,
              walletId: wallet.walletId,
              walletAddress,
              chainId: deps.chainId,
              contractAddress: ready.contract,
              cumulativeAmountRaw: cumulative.toString(),
              expectedDeltaRaw: claimable.toString(),
              nonce: state.nonce.toString(),
              deadline: new Date(Number(deadline) * 1000).toISOString(),
              signature: signature.toLowerCase(),
              signerAddress: ready.signer.address,
              preparedBlockNumber: state.blockNumber.toString(),
              unsignedTransaction: unsignedTransactionFor({
                chainReference: ready.chain.chainReference,
                from: walletAddress,
                to: ready.contract,
                data,
                gasLimit,
                nonce: txNonce,
                fee,
              }),
            };
          },
        });
        const claim = result.claim;
        const expired =
          claim.status !== "claimable" ||
          Date.parse(claim.deadline) <= now().getTime();
        return Object.freeze({
          claim: projectMiningClaim(claim, ready.chain.chainReference),
          intent: Object.freeze({
            calldata: Object.freeze({
              to: claim.contractAddress,
              data: claim.unsignedTransaction["data"],
              value: "0",
            }),
            unsignedTransaction: claim.unsignedTransaction,
            signing: Object.freeze({
              mode: "device_eth_send_transaction",
              allowed: !expired,
              reasonCode: expired ? reasons.claimExpired : null,
            }),
          }),
          decimals: 18,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async reportClaim(input) {
      try {
        const body = parseReportBody(input.body);
        const repo = repository();
        if (deps.chain === null || deps.contractAddress === null) {
          unavailableWith(
            deps.contractAddress === null
              ? reasons.claimContractNotConfigured
              : reasons.claimChainNotConfigured,
          );
        }
        await repo.claimReportCommand({
          userId: input.principal.userId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: sha256(body),
        });
        const claim = await repo.getClaim(input.principal.userId, body.claimId);
        if (claim === null) {
          refuse("NOT_FOUND", reasons.claimNotFound);
        }
        if (
          claim.transactionHash !== null &&
          claim.transactionHash !== body.transactionHash
        ) {
          refuse("RESOURCE_CONFLICT", reasons.claimHashConflict);
        }
        const terminal =
          claim.status === "succeeded" ||
          claim.status === "failed" ||
          claim.status === "expired";
        const updated = terminal
          ? claim
          : await reconcileWithHash(claim, body.transactionHash);
        return Object.freeze({
          claim: projectMiningClaim(updated, deps.chain.chainReference),
          decimals: 18,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async reconcileClaim(claim) {
      const chain = deps.chain;
      if (chain === null) return claim;
      if (claim.transactionHash !== null) {
        try {
          return await reconcileWithHash(claim, claim.transactionHash);
        } catch (error) {
          if (error instanceof V2ApiError) return claim;
          throw error;
        }
      }
      const graceEnd =
        Date.parse(claim.deadline) + miningClaimDeadlineGraceSeconds * 1000;
      if (now().getTime() < graceEnd) return claim;
      const { nonce, blockNumber } = await chain.readNonce({
        contract: claim.contractAddress,
        wallet: claim.walletAddress,
      });
      if (nonce <= BigInt(claim.nonce)) {
        return repository().transitionClaim({
          claimId: claim.claimId,
          transition: { kind: "expired" },
        });
      }
      // The nonce was consumed without a report: find the Claimed log.
      const from = BigInt(claim.preparedBlockNumber);
      const to =
        from + miningClaimLogSearchBlocks < blockNumber
          ? from + miningClaimLogSearchBlocks
          : blockNumber;
      const log = await chain.findClaimedLog({
        contract: claim.contractAddress,
        wallet: claim.walletAddress,
        nonce: BigInt(claim.nonce),
        fromBlock: from,
        toBlock: to,
      });
      if (log === null) {
        // Another voucher with the same nonce landed: this one is dead.
        return repository().transitionClaim({
          claimId: claim.claimId,
          transition: { kind: "expired" },
        });
      }
      try {
        return await reconcileWithHash(claim, log.transactionHash);
      } catch (error) {
        if (
          error instanceof MiningSettlementConflictError ||
          (error instanceof V2ApiError && error.code === "DATA_STALE")
        ) {
          // The log is another voucher's (same nonce): this one is dead.
          return repository().transitionClaim({
            claimId: claim.claimId,
            transition: { kind: "expired" },
          });
        }
        if (error instanceof V2ApiError) return claim;
        throw error;
      }
    },
  };
  return Object.freeze(service);
}
