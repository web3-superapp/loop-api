import { createHmac, timingSafeEqual } from "node:crypto";

import {
  MiningParameterDocumentError,
  miningDefaultParameterDocument,
  miningSettlementReasonCodes,
  parseMiningParameterDraft,
} from "../mining/hourly-settlement-contract.js";
import {
  MiningCommunityUnknownError,
  MiningSettlementConflictError,
  MiningSettlementUnavailableError,
  type MiningAuditRecord,
  type MiningClaimChain,
  type MiningEpochRecord,
  type MiningParameterVersionRecord,
  type MiningSettlementRepository,
} from "../mining/hourly-settlement-ports.js";
import {
  miningVersionAt,
  type MiningSettlementRunner,
} from "../mining/hourly-settlement-runner.js";
import {
  miningPoolSettleability,
  resolveMiningPoolEntry,
  type MiningPoolCandidate,
  type MiningPoolKind,
} from "../mining/mining-pool-roster.js";
import { AdminApiError, adminReasonCodes } from "./admin-contract.js";
import { adminRoleHasPermission } from "./admin-roles.js";
import type { AdminWriteContext } from "./admin-service.js";

/**
 * Decision 0116: the console side of the hourly settlement. Parameter
 * drafts (`console.write`) → approval (`formula.approve`, reviewer, not the
 * author, bound operator live; intent audit first) → in force at
 * `effectiveFrom`. Epoch list / detail / replay and the funding check are
 * read-only. A manual settlement of a completed hour needs
 * `MINING_SETTLEMENT_TEST_TRIGGER` (never in production).
 */

type Resource = Record<string, unknown>;

export interface AdminMiningSettlementService {
  listParameterVersions(): Promise<Resource>;
  /** Decision 0187: the mining pool roster table. */
  listPool(query: Record<string, unknown>): Promise<Resource>;
  createParameterDraft(
    context: AdminWriteContext,
    body: Record<string, unknown>,
  ): Promise<Resource>;
  approveParameterVersion(
    context: AdminWriteContext,
    versionId: string,
  ): Promise<Resource>;
  withdrawParameterVersion(
    context: AdminWriteContext,
    versionId: string,
  ): Promise<Resource>;
  listEpochs(query: Record<string, unknown>): Promise<Resource>;
  getEpoch(epochId: string): Promise<Resource>;
  replayEpoch(epochId: string): Promise<Resource>;
  funding(): Promise<Resource>;
  settleHour(
    context: AdminWriteContext,
    body: Record<string, unknown>,
  ): Promise<Resource>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const configVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const permissionReasons: ReadonlySet<string> = new Set([
  adminReasonCodes.formulaSelfApproval,
  adminReasonCodes.operatorDisabled,
  adminReasonCodes.accountDisabled,
]);

/** Decision 0183: 422 MINING_COMMUNITY_UNKNOWN with the offending ids. */
function communityUnknown(
  communityIds: readonly string[],
  field:
    "communityCoefficients" | "excludedCommunities" = "communityCoefficients",
): AdminApiError {
  return new AdminApiError("MINING_COMMUNITY_UNKNOWN", {
    reasonCode: "MINING_COMMUNITY_UNKNOWN",
    field,
    unknownCommunityIds: Object.freeze([...communityIds]),
  });
}

function translate(error: unknown): never {
  if (error instanceof AdminApiError) throw error;
  if (error instanceof MiningCommunityUnknownError) {
    throw communityUnknown(error.communityIds);
  }
  if (error instanceof MiningSettlementConflictError) {
    if (permissionReasons.has(error.reasonCode)) {
      throw new AdminApiError("PERMISSION_DENIED", {
        reasonCode: error.reasonCode,
      });
    }
    if (error.reasonCode === "ADMIN_MINING_PARAMETERS_NOT_FOUND") {
      throw new AdminApiError("NOT_FOUND", { reasonCode: error.reasonCode });
    }
    throw new AdminApiError("ADMIN_CONFLICT", { reasonCode: error.reasonCode });
  }
  if (error instanceof MiningSettlementUnavailableError) {
    throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
      reasonCode: adminReasonCodes.databaseUnavailable,
    });
  }
  throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
    reasonCode: miningSettlementReasonCodes.claimChainReadFailed,
  });
}

const addressPattern = /^0x[0-9a-fA-F]{40}$/u;

function parsePoolLimit(value: unknown): number {
  if (value === undefined) return 20;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9][0-9]{0,2}$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new AdminApiError("INVALID_REQUEST");
  }
  return parsed;
}

/** Decision 0187: one roster row, in force and (if any) as the draft has it. */
function projectPoolRow(
  row: MiningPoolCandidate,
  inForce: MiningParameterVersionRecord["document"] | null,
  pending: MiningParameterVersionRecord | null,
  settlementChainId: string | null,
): Resource {
  const entry = resolveMiningPoolEntry(inForce, row);
  // Decision 0189: whether the hourly settlement can read the row's
  // holdings (else the snapshot alone values it).
  const settleability = miningPoolSettleability(row, settlementChainId);
  const draft =
    pending === null ? null : resolveMiningPoolEntry(pending.document, row);
  return Object.freeze({
    communityId: row.communityId,
    communityName: row.communityName,
    assetId: row.assetId,
    chainId: row.chainId,
    memeAddress: row.memeAddress,
    kind: row.kind,
    symbol: row.symbol,
    instanceId: row.instanceId,
    launchId: row.launchId,
    participate: entry.participate,
    tokenWeight: entry.tokenWeight,
    nftCoefficient: entry.nftCoefficient,
    source: entry.source,
    settleable: settleability.settleable,
    settleableReasonCode: settleability.reasonCode,
    pendingDraft:
      pending === null || draft === null
        ? null
        : Object.freeze({
            versionId: pending.versionId,
            configVersion: pending.configVersion,
            participate: draft.participate,
            tokenWeight: draft.tokenWeight,
            nftCoefficient: draft.nftCoefficient,
            source: draft.source,
          }),
  });
}

function projectVersion(version: MiningParameterVersionRecord): Resource {
  return Object.freeze({
    versionId: version.versionId,
    configVersion: version.configVersion,
    status: version.status,
    effectiveFrom: version.effectiveFrom,
    document: version.document,
    draftAuthor: version.draftAuthor?.actor ?? null,
    approvedBy: version.approvedBy,
    approvedAt: version.approvedAt,
    createdAt: version.createdAt,
  });
}

function projectEpoch(epoch: MiningEpochRecord): Resource {
  return Object.freeze({
    epochId: epoch.epochId,
    hourStart: epoch.hourStart,
    hourEnd: epoch.hourEnd,
    status: epoch.status,
    trigger: epoch.trigger,
    versionId: epoch.versionId,
    budgetNftRaw: epoch.budgetNftRaw,
    budgetAssetRaw: epoch.budgetAssetRaw,
    denominatorNftPower: epoch.denominatorNftPower,
    denominatorAssetPower: epoch.denominatorAssetPower,
    allocatedNftRaw: epoch.allocatedNftRaw,
    allocatedAssetRaw: epoch.allocatedAssetRaw,
    unallocatedNftRaw: epoch.unallocatedNftRaw,
    unallocatedAssetRaw: epoch.unallocatedAssetRaw,
    userCount: epoch.userCount,
    inputDigest: epoch.inputDigest,
    inputSummary: epoch.inputSummary,
    failureReasonCode: epoch.failureReasonCode,
    attemptCount: epoch.attemptCount,
    settledAt: epoch.settledAt,
    updatedAt: epoch.updatedAt,
  });
}

function auditReference(audit: MiningAuditRecord): Resource {
  return Object.freeze({
    auditId: audit.auditId,
    seq: audit.seq,
    at: audit.at,
    action: audit.action,
  });
}

export function createAdminMiningSettlementService(dependencies: {
  readonly repository: MiningSettlementRepository | null;
  readonly runner: MiningSettlementRunner | null;
  readonly chain: MiningClaimChain | null;
  readonly contractAddress: string | null;
  readonly testTrigger: boolean;
  /**
   * Decision 0187: signs the pool list cursors (the console session secret).
   * Without it the first page is served and `nextCursor` is null.
   */
  readonly cursorSecret?: string | null;
  /**
   * Decision 0189: the chain the hourly settlement runs on (the launch
   * chain), for the pool rows' `settleable`. Null: only `erc20` external
   * rows are settleable.
   */
  readonly settlementChainId?: string | null;
  readonly now?: () => Date;
}): AdminMiningSettlementService {
  const now = dependencies.now ?? ((): Date => new Date());
  const cursorKey =
    dependencies.cursorSecret === undefined ||
    dependencies.cursorSecret === null
      ? null
      : createHmac("sha256", "loop-admin-mining-pool-cursor-v1")
          .update(dependencies.cursorSecret)
          .digest();

  function encodePoolCursor(
    filter: string,
    payload: Readonly<Record<string, string | number>>,
  ): string | null {
    if (cursorKey === null) return null;
    const body = Buffer.from(
      JSON.stringify({ f: filter, p: payload }),
    ).toString("base64url");
    const mac = createHmac("sha256", cursorKey)
      .update(body)
      .digest("base64url");
    return `${body}.${mac}`;
  }

  function decodePoolCursor(
    filter: string,
    cursor: unknown,
  ): Readonly<Record<string, unknown>> {
    // Without a key no cursor was ever minted: any cursor is foreign.
    if (cursorKey === null) throw new AdminApiError("INVALID_REQUEST");
    if (typeof cursor !== "string" || cursor.length > 1_024) {
      throw new AdminApiError("INVALID_REQUEST");
    }
    const [body, mac, extra] = cursor.split(".");
    if (body === undefined || mac === undefined || extra !== undefined) {
      throw new AdminApiError("INVALID_REQUEST");
    }
    const expected = Buffer.from(
      createHmac("sha256", cursorKey).update(body).digest("base64url"),
    );
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new AdminApiError("INVALID_REQUEST");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new AdminApiError("INVALID_REQUEST");
    }
    const record = parsed as Record<string, unknown> | null;
    if (
      record === null ||
      typeof record !== "object" ||
      record["f"] !== filter ||
      typeof record["p"] !== "object" ||
      record["p"] === null
    ) {
      throw new AdminApiError("INVALID_REQUEST");
    }
    return record["p"] as Record<string, unknown>;
  }

  function repository(): MiningSettlementRepository {
    if (dependencies.repository === null) {
      throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
        reasonCode: miningSettlementReasonCodes.settlementUnavailable,
      });
    }
    return dependencies.repository;
  }

  function versionIdOrNotFound(versionId: string): string {
    if (!uuidPattern.test(versionId)) {
      throw new AdminApiError("NOT_FOUND", {
        reasonCode: "ADMIN_MINING_PARAMETERS_NOT_FOUND",
      });
    }
    return versionId;
  }

  return Object.freeze<AdminMiningSettlementService>({
    async listParameterVersions() {
      try {
        const versions = await repository().listParameterVersions();
        return Object.freeze({
          items: versions.map(projectVersion),
          defaults: miningDefaultParameterDocument,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listPool(query) {
      const address = query["address"];
      if (
        address !== undefined &&
        (typeof address !== "string" || !addressPattern.test(address))
      ) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      const rawQ = query["q"];
      if (
        rawQ !== undefined &&
        (typeof rawQ !== "string" || rawQ.trim().length > 64)
      ) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      const q =
        typeof rawQ === "string" && rawQ.trim() !== "" ? rawQ.trim() : null;
      if (query["cursor"] !== undefined && query["limit"] !== undefined) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      const rawKind = query["kind"];
      if (
        rawKind !== undefined &&
        rawKind !== "platform" &&
        rawKind !== "external"
      ) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      const kind: MiningPoolKind | null = rawKind ?? null;
      const normalizedAddress =
        typeof address === "string" ? address.toLowerCase() : null;
      // Decision 0189: `kind` is bound into the cursor only when given, so a
      // cursor issued before 0189 (no kind) stays valid.
      const filter = `address=${normalizedAddress ?? ""}&q=${q ?? ""}${
        kind === null ? "" : `&kind=${kind}`
      }`;
      let limit = parsePoolLimit(query["limit"]);
      let after: { communityName: string; communityId: string } | null = null;
      if (query["cursor"] !== undefined) {
        const payload = decodePoolCursor(filter, query["cursor"]);
        if (
          typeof payload["communityName"] !== "string" ||
          typeof payload["communityId"] !== "string" ||
          !uuidPattern.test(payload["communityId"])
        ) {
          throw new AdminApiError("INVALID_REQUEST");
        }
        after = {
          communityName: payload["communityName"],
          communityId: payload["communityId"],
        };
        limit = parsePoolLimit(payload["limit"]);
      }
      try {
        const repo = repository();
        const [rows, versions] = await Promise.all([
          repo.listMiningPoolCandidates({
            address: normalizedAddress,
            query: q,
            kind,
            after,
            limit: limit + 1,
          }),
          repo.listParameterVersions(),
        ]);
        const nowSeconds = BigInt(Math.floor(now().getTime() / 1000));
        const inForce = miningVersionAt(
          versions.filter((version) => version.status === "approved"),
          nowSeconds,
        );
        // The newest pending draft (what a reviewer would approve next).
        const pending =
          [...versions]
            .filter((version) => version.status === "pending_approval")
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return Object.freeze({
          inForce:
            inForce === null
              ? null
              : Object.freeze({
                  versionId: inForce.versionId,
                  configVersion: inForce.configVersion,
                  effectiveFrom: inForce.effectiveFrom,
                }),
          pendingDraftVersion:
            pending === null
              ? null
              : Object.freeze({
                  versionId: pending.versionId,
                  configVersion: pending.configVersion,
                  effectiveFrom: pending.effectiveFrom,
                }),
          items: page.map((row) =>
            projectPoolRow(
              row,
              inForce?.document ?? null,
              pending,
              dependencies.settlementChainId ?? null,
            ),
          ),
          nextCursor:
            rows.length > limit && last !== undefined
              ? encodePoolCursor(filter, {
                  communityName: last.communityName,
                  communityId: last.communityId,
                  limit,
                })
              : null,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async createParameterDraft(context, body) {
      const configVersion = body["configVersion"];
      const effectiveFrom = body["effectiveFrom"];
      const parameters = body["parameters"];
      if (
        typeof configVersion !== "string" ||
        !configVersionPattern.test(configVersion) ||
        typeof effectiveFrom !== "string" ||
        Number.isNaN(Date.parse(effectiveFrom)) ||
        typeof parameters !== "object" ||
        parameters === null ||
        Array.isArray(parameters)
      ) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      try {
        const repo = repository();
        if (Date.parse(effectiveFrom) <= now().getTime()) {
          throw new AdminApiError("VALIDATION_FAILED", {
            reasonCode: "ADMIN_MINING_PARAMETERS_EFFECTIVE_PASSED",
            field: "effectiveFrom",
          });
        }
        const given = parameters as Record<string, unknown>;
        // Decision 0183: the frozen copy keeps only verified communities and
        // reports the ones it skipped; an explicit table is checked below.
        let skippedCommunityIds: readonly string[] | null = null;
        let communityCoefficients: unknown = given["communityCoefficients"];
        if (communityCoefficients === undefined) {
          const copied = await repo.listApprovedCommunityWeights();
          const skipped = new Set(
            await repo.findUnverifiedCommunityIds(
              copied.map((entry) => entry.communityId),
            ),
          );
          skippedCommunityIds = Object.freeze(
            copied
              .map((entry) => entry.communityId)
              .filter((id) => skipped.has(id)),
          );
          communityCoefficients = copied
            .filter((entry) => !skipped.has(entry.communityId))
            .map((entry) => ({
              communityId: entry.communityId,
              coefficient: entry.weight,
            }));
        }
        let document;
        try {
          document = parseMiningParameterDraft({
            ...miningDefaultParameterDocument,
            assetWeights: [],
            ...given,
            communityCoefficients,
          });
        } catch (error) {
          if (error instanceof MiningParameterDocumentError) {
            throw new AdminApiError("VALIDATION_FAILED", {
              reasonCode: "ADMIN_MINING_PARAMETERS_INVALID",
              field: error.field,
            });
          }
          throw error;
        }
        // Decision 0187: the excluded communities / assets are checked the
        // same way as the explicit tables.
        const coefficientIds = document.communityCoefficients.map(
          (entry) => entry.communityId,
        );
        const unverified = await repo.findUnverifiedCommunityIds([
          ...new Set([
            ...coefficientIds,
            ...(document.excludedCommunities ?? []),
          ]),
        ]);
        if (unverified.length > 0) {
          throw communityUnknown(
            unverified,
            unverified.some((id) => coefficientIds.includes(id))
              ? "communityCoefficients"
              : "excludedCommunities",
          );
        }
        // Decision 0189: an external token let in (`includedAssets`) needs
        // no settlement source — a verified community binding it is enough;
        // its weight may then be listed too.
        const sourced = await repo.findUnknownAssetIds([
          ...new Set([
            ...document.assetWeights.map((entry) => entry.assetId),
            ...(document.excludedAssets ?? []),
            ...(document.includedAssets ?? []),
          ]),
        ]);
        const included = new Set(document.includedAssets ?? []);
        const bound =
          sourced.length === 0
            ? new Set<string>()
            : new Set(
                await repo.findVerifiedBoundAssetIds(
                  sourced.filter((assetId) => included.has(assetId)),
                ),
              );
        const unknown = sourced.filter((assetId) => !bound.has(assetId));
        if (unknown.length > 0) {
          throw new AdminApiError("VALIDATION_FAILED", {
            reasonCode: miningSettlementReasonCodes.assetSourceUnknown,
            assetId: unknown[0] as string,
          });
        }
        const created = await repo.createParameterDraft({
          configVersion,
          document,
          effectiveFrom: new Date(Date.parse(effectiveFrom)).toISOString(),
          author: {
            actor: context.session.actor,
            accountId: context.session.accountId,
          },
          audit: {
            actor: context.session.actor,
            actorAccountId: context.session.accountId,
            action: "mining.parameters.draft",
            targetType: "mining_parameter_version",
            targetId: null,
            requestId: context.requestId,
          },
        });
        return Object.freeze({
          version: projectVersion(created.version),
          audit: auditReference(created.audit),
          // Only when the frozen copy dropped something (additive key).
          ...(skippedCommunityIds === null || skippedCommunityIds.length === 0
            ? {}
            : { skippedCommunityIds }),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async approveParameterVersion(context, rawVersionId) {
      const approverAccountId = context.session.accountId;
      if (
        !adminRoleHasPermission(context.session.role, "formula.approve") ||
        approverAccountId === null
      ) {
        throw new AdminApiError("PERMISSION_DENIED", {
          reasonCode: adminReasonCodes.roleForbidden,
          permission: "formula.approve",
        });
      }
      const versionId = versionIdOrNotFound(rawVersionId);
      const repo = repository();
      const auditBase = {
        actor: context.session.actor,
        actorAccountId: approverAccountId,
        targetType: "mining_parameter_version",
        targetId: versionId,
        requestId: context.requestId,
      } as const;
      let requested: MiningAuditRecord;
      try {
        requested = await repo.recordAudit({
          ...auditBase,
          action: "mining.parameters.approve.requested",
          after: { versionId },
        });
      } catch {
        throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
          reasonCode: adminReasonCodes.auditUnavailable,
        });
      }
      try {
        const approved = await repo.approveParameterVersion({
          versionId,
          approver: {
            actor: context.session.actor,
            accountId: approverAccountId,
          },
          requestedAuditId: requested.auditId,
          audit: { ...auditBase, action: "mining.parameters.approve" },
        });
        return Object.freeze({
          version: projectVersion(approved.version),
          audit: auditReference(approved.audit),
        });
      } catch (error) {
        const reason =
          error instanceof MiningSettlementConflictError
            ? error.reasonCode
            : error instanceof MiningCommunityUnknownError
              ? "MINING_COMMUNITY_UNKNOWN"
              : adminReasonCodes.databaseUnavailable;
        await repo
          .recordAudit({
            ...auditBase,
            action: "mining.parameters.approve.failed",
            after: { reasonCode: reason, requestedAuditId: requested.auditId },
          })
          .catch(() => null);
        return translate(error);
      }
    },

    async withdrawParameterVersion(context, rawVersionId) {
      const versionId = versionIdOrNotFound(rawVersionId);
      try {
        const withdrawn = await repository().withdrawParameterVersion({
          versionId,
          audit: {
            actor: context.session.actor,
            actorAccountId: context.session.accountId,
            action: "mining.parameters.withdraw",
            targetType: "mining_parameter_version",
            targetId: versionId,
            requestId: context.requestId,
          },
        });
        return Object.freeze({
          version: projectVersion(withdrawn.version),
          audit: auditReference(withdrawn.audit),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listEpochs(query) {
      const before = query["before"];
      if (
        before !== undefined &&
        (typeof before !== "string" || Number.isNaN(Date.parse(before)))
      ) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      try {
        const rows = await repository().listEpochs({
          beforeHourStart:
            before === undefined
              ? null
              : new Date(Date.parse(before)).toISOString(),
          limit: 49,
        });
        const page = rows.slice(0, 48);
        return Object.freeze({
          items: page.map(projectEpoch),
          nextBefore:
            rows.length > 48
              ? (page[page.length - 1]?.hourStart ?? null)
              : null,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getEpoch(epochId) {
      if (!uuidPattern.test(epochId)) throw new AdminApiError("NOT_FOUND");
      try {
        const repo = repository();
        const epoch = await repo.getEpoch(epochId);
        if (epoch === null) throw new AdminApiError("NOT_FOUND");
        const rewards = await repo.listEpochRewards({ epochId });
        return Object.freeze({
          epoch: projectEpoch(epoch),
          rewards: rewards.slice(0, 500).map((row) =>
            Object.freeze({
              userId: row.userId,
              nftSelfPower: row.nftSelfPower,
              nftReferralPower: row.nftReferralPower,
              nftTotalPower: row.nftTotalPower,
              assetSelfPower: row.assetSelfPower,
              assetReferralPower: row.assetReferralPower,
              assetTotalPower: row.assetTotalPower,
              levels: row.levels,
              nftRewardRaw: row.nftRewardRaw,
              assetRewardRaw: row.assetRewardRaw,
              totalRewardRaw: row.totalRewardRaw,
            }),
          ),
          rewardRowCount: rewards.length,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async replayEpoch(epochId) {
      if (!uuidPattern.test(epochId)) throw new AdminApiError("NOT_FOUND");
      if (dependencies.runner === null) {
        throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
          reasonCode: miningSettlementReasonCodes.settlementUnavailable,
        });
      }
      try {
        const result = await dependencies.runner.replay(epochId);
        if (result === null) throw new AdminApiError("NOT_FOUND");
        return Object.freeze({ replay: result });
      } catch (error) {
        return translate(error);
      }
    },

    async funding() {
      try {
        const liability = await repository().totalUnclaimedRaw();
        if (
          dependencies.chain === null ||
          dependencies.contractAddress === null
        ) {
          return Object.freeze({
            status: "unavailable",
            reasonCode:
              dependencies.contractAddress === null
                ? miningSettlementReasonCodes.claimContractNotConfigured
                : miningSettlementReasonCodes.claimChainNotConfigured,
            contractAddress: dependencies.contractAddress,
            liabilityRaw: liability,
            balanceRaw: null,
            liabilityHintRaw: null,
            paused: null,
            blockNumber: null,
            alert: null,
            shortfallRaw: null,
          });
        }
        let funding;
        try {
          funding = await dependencies.chain.readFunding(
            dependencies.contractAddress,
          );
        } catch {
          throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
            reasonCode: miningSettlementReasonCodes.claimChainReadFailed,
          });
        }
        const owed = BigInt(liability);
        return Object.freeze({
          status: "available",
          reasonCode: null,
          contractAddress: dependencies.contractAddress,
          liabilityRaw: liability,
          balanceRaw: funding.balanceRaw.toString(),
          liabilityHintRaw: funding.liabilityHintRaw?.toString() ?? null,
          paused: funding.paused,
          blockNumber: funding.blockNumber.toString(),
          alert: funding.balanceRaw < owed,
          shortfallRaw:
            funding.balanceRaw < owed
              ? (owed - funding.balanceRaw).toString()
              : "0",
        });
      } catch (error) {
        return translate(error);
      }
    },

    async settleHour(context, body) {
      if (!dependencies.testTrigger || dependencies.runner === null) {
        throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
          reasonCode: miningSettlementReasonCodes.testTriggerDisabled,
        });
      }
      const hourStart = body["hourStart"];
      if (
        typeof hourStart !== "string" ||
        Number.isNaN(Date.parse(hourStart)) ||
        Date.parse(hourStart) % 3_600_000 !== 0
      ) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      try {
        const repo = repository();
        const requested = await repo.recordAudit({
          actor: context.session.actor,
          actorAccountId: context.session.accountId,
          action: "mining.epoch.settle.requested",
          targetType: "mining_epoch",
          targetId: null,
          requestId: context.requestId,
          after: { hourStart },
        });
        const outcome = await dependencies.runner.settleHour({
          hourStart: BigInt(Date.parse(hourStart) / 1000),
          trigger: "test_trigger",
        });
        return Object.freeze({
          outcome: outcome.kind,
          reasonCode:
            outcome.kind === "skipped" || outcome.kind === "failed"
              ? outcome.reasonCode
              : null,
          epoch:
            outcome.kind === "settled" || outcome.kind === "already_settled"
              ? projectEpoch(outcome.epoch)
              : outcome.kind === "failed" && outcome.epoch !== null
                ? projectEpoch(outcome.epoch)
                : null,
          audit: auditReference(requested),
        });
      } catch (error) {
        return translate(error);
      }
    },
  });
}
