import { randomUUID } from "node:crypto";

import {
  AdminStateConflictError,
  AdminTargetNotFoundError,
  type AdminAuditInput,
  type AdminAuditRecord,
  type AdminCommunityRecord,
  type AdminFormulaVersionRecord,
  type AdminMemeTokenRecord,
  type AdminRepository,
  type AdminSettingKey,
  type AdminSettingRecord,
  type CommunityReviewNoteRecord,
} from "../../src/features/admin/admin-repository.js";
import { adminReasonCodes } from "../../src/features/admin/admin-contract.js";
import type { MemePauseSender } from "../../src/integrations/meme/meme-pause-sender.js";

/**
 * In-memory operator console repository (Decision 0102) for route tests.
 * It follows the Postgres semantics the routes depend on: compare-and-set
 * settings, one audit row per write, formula state transitions.
 */

export interface InMemoryAdminRepository extends AdminRepository {
  readonly settings: Map<AdminSettingKey, AdminSettingRecord>;
  readonly audit: AdminAuditRecord[];
  readonly communities: Map<string, AdminCommunityRecord>;
  readonly notes: CommunityReviewNoteRecord[];
  readonly memeTokens: Map<string, AdminMemeTokenRecord>;
  readonly formulas: Map<string, AdminFormulaVersionRecord>;
}

export function adminCommunityFixture(
  overrides: Partial<AdminCommunityRecord> = {},
): AdminCommunityRecord {
  return {
    communityId: randomUUID(),
    name: "Alpha",
    slug: "alpha",
    description: null,
    logoRef: null,
    verificationStatus: "verified",
    boundAssetId: null,
    memberCount: 3,
    ownerUserId: randomUUID(),
    ownerLoopId: "LOOP-ABCDEFGH",
    applicationSubmittedAt: "2026-10-01T00:00:00.000Z",
    reviewedAt: null,
    verifiedAt: null,
    rejectedReason: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

export function adminMemeFixture(
  overrides: Partial<AdminMemeTokenRecord> = {},
): AdminMemeTokenRecord {
  return {
    memeTokenId: randomUUID(),
    chainId: "eip155:97",
    contractAddress: "0x00000000000000000000000000000000000000c1",
    tokenAddress: "0x00000000000000000000000000000000000000d2",
    name: "Frog",
    symbol: "FROG",
    status: "trading",
    listing: "listed",
    listingReasonCode: null,
    listingReasonText: null,
    listingChangedAt: null,
    creatorUserId: randomUUID(),
    creatorLoopId: null,
    holderCount: 1,
    tradeCount: 2,
    sold: "1000",
    graduationNeedsOperator: false,
    chainCreatedAt: "2026-10-02T00:00:00.000Z",
    graduatedAt: null,
    createdAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

export function adminFormulaFixture(
  overrides: Partial<AdminFormulaVersionRecord> = {},
): AdminFormulaVersionRecord {
  return {
    configVersion: "miningFormulaV1-dev",
    formula: {
      kind: "holding_times_reference_price_times_weight",
      expressionKey: "mining.rules.expression",
      dailyOutputKey: "mining.rules.dailyOutput",
      assetWeights: { "eip155:97:native": "1" },
      referralBoost: { status: "pending_approval" },
      scope: "development_baseline",
      dailyOutput: {
        status: "development_placeholder",
        budget: "1000",
        unitKey: "mining.rules.dailyOutput.unit.loopTokenPending",
      },
    },
    weightRange: {
      loop: {
        status: "pending_approval",
        descriptionKey: "mining.rules.weight.loopFixedMaximum",
      },
      community: {
        status: "approved",
        descriptionKey: "mining.rules.weight.communityReviewed",
        range: { min: "1", max: "3" },
      },
      reviewFactorKeys: [],
    },
    priceGuardRules: [],
    status: "approved",
    effectiveAt: "2026-10-01T00:00:00.000Z",
    approvedAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    communityWeights: null,
    ...overrides,
  };
}

export function createInMemoryAdminRepository(): InMemoryAdminRepository {
  const settings = new Map<AdminSettingKey, AdminSettingRecord>();
  const audit: AdminAuditRecord[] = [];
  const communities = new Map<string, AdminCommunityRecord>();
  const notes: CommunityReviewNoteRecord[] = [];
  const memeTokens = new Map<string, AdminMemeTokenRecord>();
  const formulas = new Map<string, AdminFormulaVersionRecord>();
  let clock = Date.parse("2026-10-08T00:00:00.000Z");

  function tick(): string {
    clock += 1;
    return new Date(clock).toISOString();
  }

  function append(input: AdminAuditInput): AdminAuditRecord {
    const record: AdminAuditRecord = {
      auditId: randomUUID(),
      seq: audit.length + 1,
      at: tick(),
      actor: input.actor,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      before: input.before ?? null,
      after: input.after ?? null,
      requestId: input.requestId,
    };
    audit.push(record);
    return record;
  }

  function formulaOrThrow(configVersion: string): AdminFormulaVersionRecord {
    const current = formulas.get(configVersion);
    if (current === undefined) {
      throw new AdminTargetNotFoundError(adminReasonCodes.formulaNotFound);
    }
    if (current.status !== "pending_approval") {
      throw new AdminStateConflictError(adminReasonCodes.formulaState, {
        status: current.status,
      });
    }
    return current;
  }

  return {
    settings,
    audit,
    communities,
    notes,
    memeTokens,
    formulas,
    getSetting: (key) => Promise.resolve(settings.get(key) ?? null),
    writeSetting: (input) => {
      const current = settings.get(input.key) ?? null;
      if ((current?.updatedAt ?? null) !== input.expectedUpdatedAt) {
        return Promise.reject(
          new AdminStateConflictError(adminReasonCodes.updatedAtMismatch, {
            currentUpdatedAt: current?.updatedAt ?? null,
          }),
        );
      }
      let setting: AdminSettingRecord | null = null;
      if (input.value === null) {
        settings.delete(input.key);
      } else {
        setting = {
          key: input.key,
          value: JSON.parse(JSON.stringify(input.value)) as unknown,
          updatedAt: tick(),
          updatedBy: input.audit.actor,
        };
        settings.set(input.key, setting);
      }
      const record = append({
        ...input.audit,
        before: current === null ? null : { value: current.value },
        after: setting === null ? null : { value: setting.value },
      });
      return Promise.resolve({ setting, audit: record });
    },
    appendAudit: (input) => Promise.resolve(append(input)),
    listAudit: (input) =>
      Promise.resolve(
        [...audit]
          .reverse()
          .filter(
            (row) =>
              (input.beforeSeq === null || row.seq < input.beforeSeq) &&
              (input.actor === null || row.actor === input.actor) &&
              (input.action === null || row.action === input.action),
          )
          .slice(0, input.limit),
      ),
    overview: () =>
      Promise.resolve({
        accounts: 7,
        communities: { pending: 1, verified: 2, rejected: 0 },
        pendingReviews: 1,
        voiceRooms: { live: 1, participants: 4 },
        memeTokens: { byStatus: { trading: 2 }, hidden: 0 },
        indexerLanes: [
          {
            lane: "meme_event",
            chainId: "eip155:97",
            lastBlockNumber: "123",
            updatedAt: "2026-10-08T00:00:00.000Z",
          },
        ],
      }),
    listCommunities: (input) =>
      Promise.resolve(
        [...communities.values()]
          .filter(
            (row) =>
              input.status === null || row.verificationStatus === input.status,
          )
          .sort((a, b) => (a.communityId < b.communityId ? 1 : -1))
          .filter(
            (row) =>
              input.after === null || row.communityId < input.after.communityId,
          )
          .slice(0, input.limit),
      ),
    getCommunity: (id) => Promise.resolve(communities.get(id) ?? null),
    getCommunitiesByIds: (ids) =>
      Promise.resolve(
        ids.flatMap((id) => {
          const row = communities.get(id);
          return row === undefined ? [] : [row];
        }),
      ),
    listCommunityReviewNotes: (id) =>
      Promise.resolve(notes.filter((note) => note.communityId === id)),
    recordCommunityReview: (input) => {
      const record = append(input.audit);
      const note: CommunityReviewNoteRecord = {
        noteId: randomUUID(),
        communityId: input.communityId,
        at: record.at,
        actor: input.audit.actor,
        decision: input.decision,
        reasonCode: input.reasonCode,
        reasonText: input.reasonText,
        auditId: record.auditId,
      };
      notes.push(note);
      return Promise.resolve({ note, audit: record });
    },
    listMemeTokens: (input) =>
      Promise.resolve(
        [...memeTokens.values()]
          .filter(
            (row) =>
              (input.status === null || row.status === input.status) &&
              (input.listing === null || row.listing === input.listing),
          )
          .slice(0, input.limit),
      ),
    getMemeToken: (id) => Promise.resolve(memeTokens.get(id) ?? null),
    setMemeListing: (input) => {
      const current = memeTokens.get(input.memeTokenId);
      if (current === undefined) {
        return Promise.reject(
          new AdminTargetNotFoundError(adminReasonCodes.memeTokenNotFound),
        );
      }
      const token: AdminMemeTokenRecord = {
        ...current,
        listing: input.listing,
        listingReasonCode: input.reasonCode,
        listingReasonText: input.reasonText,
        listingChangedAt: tick(),
      };
      memeTokens.set(token.memeTokenId, token);
      const record = append({
        ...input.audit,
        before: { listing: current.listing },
        after: { listing: token.listing },
      });
      return Promise.resolve({
        token,
        changed: current.listing !== token.listing,
        audit: record,
      });
    },
    listFormulaVersions: () => Promise.resolve([...formulas.values()]),
    getFormulaVersion: (configVersion) =>
      Promise.resolve(formulas.get(configVersion) ?? null),
    listApprovedCommunityWeights: () => Promise.resolve([]),
    createFormulaDraft: (input) => {
      if (formulas.has(input.configVersion)) {
        return Promise.reject(
          new AdminStateConflictError(adminReasonCodes.formulaExists),
        );
      }
      const at = tick();
      const version: AdminFormulaVersionRecord = {
        configVersion: input.configVersion,
        formula: input.formula,
        weightRange: input.weightRange,
        priceGuardRules: input.priceGuardRules,
        status: "pending_approval",
        effectiveAt: null,
        approvedAt: null,
        createdAt: at,
        updatedAt: at,
        communityWeights: input.communityWeights,
      };
      formulas.set(version.configVersion, version);
      const record = append({
        ...input.audit,
        before: null,
        after: { configVersion: version.configVersion },
      });
      return Promise.resolve({ version, audit: record });
    },
    approveFormula: (input) => {
      try {
        const current = formulaOrThrow(input.configVersion);
        let retiredVersion: string | null = null;
        for (const [key, value] of formulas) {
          if (value.status === "approved") {
            retiredVersion = key;
            formulas.set(key, { ...value, status: "retired" });
          }
        }
        const at = tick();
        const version: AdminFormulaVersionRecord = {
          ...current,
          status: "approved",
          effectiveAt: at,
          approvedAt: at,
          updatedAt: at,
        };
        formulas.set(version.configVersion, version);
        const record = append({
          ...input.audit,
          before: { status: current.status },
          after: { status: version.status, retiredVersion },
        });
        return Promise.resolve({ version, retiredVersion, audit: record });
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error("unexpected"),
        );
      }
    },
    withdrawFormula: (input) => {
      try {
        const current = formulaOrThrow(input.configVersion);
        const version: AdminFormulaVersionRecord = {
          ...current,
          status: "retired",
          updatedAt: tick(),
        };
        formulas.set(version.configVersion, version);
        const record = append({
          ...input.audit,
          before: { status: current.status },
          after: { status: version.status },
        });
        return Promise.resolve({ version, audit: record });
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error("unexpected"),
        );
      }
    },
  };
}

export function fakeMemePauseSender(
  outcome: "submitted" | "simulation_reverted" | "failed" = "submitted",
): MemePauseSender & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    address: "0x00000000000000000000000000000000000000e5",
    submit(action, token) {
      calls.push(`${action}:${token}`);
      if (outcome === "simulation_reverted") {
        return Promise.resolve({ status: "simulation_reverted" });
      }
      if (outcome === "failed") {
        return Promise.resolve({
          status: "failed",
          errorCode: "MEME_PAUSE_BROADCAST_FAILED",
        });
      }
      return Promise.resolve({
        status: "submitted",
        transactionHash: `0x${"ab".repeat(32)}`,
      });
    },
  };
}
