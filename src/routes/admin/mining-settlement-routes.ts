import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import {
  AdminApiError,
  adminApiPrefix,
} from "../../features/admin/admin-contract.js";
import type { AdminMiningSettlementService } from "../../features/admin/admin-mining-settlement.js";
import type { AdminPermission } from "../../features/admin/admin-roles.js";
import type { AdminWriteContext } from "../../features/admin/admin-service.js";
import {
  adminErrors,
  adminSecurity,
  guardedSessionErrors,
} from "./admin-schemas.js";
import type { AdminRouteGuard } from "./index.js";

/**
 * Decision 0116 console routes under `/admin/v1/mining/...`: settlement
 * parameter versions (draft `console.write` → approve `formula.approve`),
 * settled hours with replay (`console.read` or `audit.read`), the reward
 * contract funding check, and the test-only manual settlement.
 */

export interface AdminMiningSettlementRouteDependencies {
  readonly service: AdminMiningSettlementService;
  readonly guard: (permission: AdminPermission) => AdminRouteGuard;
  readonly guardAny: (
    permissions: readonly [AdminPermission, ...AdminPermission[]],
  ) => AdminRouteGuard;
  readonly context: (request: FastifyRequest) => AdminWriteContext;
}

const uuidPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const rawSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,77})$",
} as const;
const nullableRawSchema = { anyOf: [rawSchema, { type: "null" }] } as const;
const nullableString = {
  anyOf: [{ type: "string" }, { type: "null" }],
} as const;
const looseObject = { type: "object", additionalProperties: true } as const;
const emptyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;
const auditSchema = {
  type: "object",
  additionalProperties: false,
  required: ["auditId", "seq", "at", "action"],
  properties: {
    auditId: { type: "string", format: "uuid" },
    seq: { type: "integer" },
    at: { type: "string", format: "date-time" },
    action: { type: "string" },
  },
} as const;

const versionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "versionId",
    "configVersion",
    "status",
    "effectiveFrom",
    "document",
    "draftAuthor",
    "approvedBy",
    "approvedAt",
    "createdAt",
  ],
  properties: {
    versionId: { type: "string", pattern: uuidPattern },
    configVersion: { type: "string" },
    status: {
      type: "string",
      enum: ["pending_approval", "approved", "withdrawn"],
    },
    effectiveFrom: { type: "string", format: "date-time" },
    document: looseObject,
    draftAuthor: nullableString,
    approvedBy: nullableString,
    approvedAt: nullableString,
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const epochSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "epochId",
    "hourStart",
    "hourEnd",
    "status",
    "trigger",
    "versionId",
    "budgetNftRaw",
    "budgetAssetRaw",
    "denominatorNftPower",
    "denominatorAssetPower",
    "allocatedNftRaw",
    "allocatedAssetRaw",
    "unallocatedNftRaw",
    "unallocatedAssetRaw",
    "userCount",
    "inputDigest",
    "inputSummary",
    "failureReasonCode",
    "attemptCount",
    "settledAt",
    "updatedAt",
  ],
  properties: {
    epochId: { type: "string", pattern: uuidPattern },
    hourStart: { type: "string", format: "date-time" },
    hourEnd: { type: "string", format: "date-time" },
    status: {
      type: "string",
      enum: ["pending", "settling", "settled", "failed"],
    },
    trigger: { type: "string", enum: ["scheduled", "test_trigger"] },
    versionId: nullableString,
    budgetNftRaw: rawSchema,
    budgetAssetRaw: rawSchema,
    denominatorNftPower: { type: "string" },
    denominatorAssetPower: { type: "string" },
    allocatedNftRaw: rawSchema,
    allocatedAssetRaw: rawSchema,
    unallocatedNftRaw: rawSchema,
    unallocatedAssetRaw: rawSchema,
    userCount: { type: "integer" },
    inputDigest: nullableString,
    inputSummary: looseObject,
    failureReasonCode: nullableString,
    attemptCount: { type: "integer" },
    settledAt: nullableString,
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const decimalString = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,40})(\\.[0-9]{1,18})?$",
} as const;
const poolVersionReference = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["versionId", "configVersion", "effectiveFrom"],
      properties: {
        versionId: { type: "string", pattern: uuidPattern },
        configVersion: { type: "string" },
        effectiveFrom: { type: "string", format: "date-time" },
      },
    },
    { type: "null" },
  ],
} as const;
const poolValueSource = {
  type: "string",
  enum: ["default", "explicit"],
} as const;
/** Decision 0187: one roster row (Decision 0189: platform or external). */
const poolRowSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "communityId",
    "communityName",
    "assetId",
    "chainId",
    "memeAddress",
    "kind",
    "symbol",
    "instanceId",
    "launchId",
    "participate",
    "tokenWeight",
    "nftCoefficient",
    "source",
    "settleable",
    "settleableReasonCode",
    "pendingDraft",
  ],
  properties: {
    communityId: { type: "string", pattern: uuidPattern },
    communityName: { type: "string" },
    assetId: {
      type: "string",
      pattern: "^eip155:[1-9][0-9]{0,9}:0x[0-9a-f]{40}$",
    },
    chainId: { type: "string", pattern: "^eip155:[1-9][0-9]{0,9}$" },
    memeAddress: {
      type: "string",
      pattern: "^0x[0-9a-f]{40}$",
      description:
        "The bound token's contract address (the MEME for a platform row).",
    },
    kind: {
      type: "string",
      enum: ["platform", "external"],
      description:
        "Decision 0189: platform = the bound asset is a launch2 MEME (default in); external = any other bound token (default out, let in by `includedAssets`).",
    },
    symbol: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description:
        "The launch2 instance ticker; for an external row the asset registry symbol (null when not registered).",
    },
    instanceId: {
      anyOf: [{ type: "string", pattern: uuidPattern }, { type: "null" }],
      description:
        "Opaque launch2 instance id (the console launch2 pages); null for an external row.",
    },
    launchId: {
      anyOf: [
        { type: "string", pattern: "^0x[0-9a-f]{64}$" },
        { type: "null" },
      ],
      description:
        "On-chain launch id of the instance; null for an external row.",
    },
    participate: { type: "boolean" },
    tokenWeight: decimalString,
    nftCoefficient: decimalString,
    source: poolValueSource,
    settleable: {
      type: "boolean",
      description:
        "Decision 0189: whether the hourly settlement can read the row's holdings — a platform MEME or an external MEME v1 token on the settlement chain, or an external registered ERC-20 on a chain with an erc20_transfer lane (opening readings + indexed transfers). false: the snapshot alone values it (no LOOP reward). A settleable row can still count 0 for a holder whose balance is not reconstructable that hour (see the epoch summary externalUnknownHolders).",
    },
    settleableReasonCode: {
      anyOf: [
        {
          type: "string",
          enum: ["MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN"],
        },
        { type: "null" },
      ],
      description:
        "Decision 0189: null when settleable; MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN when the settlement has no holdings source for the row.",
    },
    pendingDraft: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "versionId",
            "configVersion",
            "participate",
            "tokenWeight",
            "nftCoefficient",
            "source",
          ],
          properties: {
            versionId: { type: "string", pattern: uuidPattern },
            configVersion: { type: "string" },
            participate: { type: "boolean" },
            tokenWeight: decimalString,
            nftCoefficient: decimalString,
            source: poolValueSource,
          },
        },
        { type: "null" },
      ],
    },
  },
} as const;

function resource(properties: Record<string, unknown>) {
  return {
    type: "object",
    headers: noStoreResponseHeaders(),
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  } as const;
}

const versionWriteResource = resource({
  version: versionSchema,
  audit: auditSchema,
});
/**
 * Decision 0183: a draft whose community table was the frozen copy also
 * lists the copied community ids it dropped because they are not verified.
 */
const draftWriteResource = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["version", "audit"],
  properties: {
    version: versionSchema,
    audit: auditSchema,
    skippedCommunityIds: {
      type: "array",
      items: { type: "string", pattern: uuidPattern },
    },
  },
} as const;
const versionParams = {
  type: "object",
  additionalProperties: false,
  required: ["versionId"],
  properties: { versionId: { type: "string", maxLength: 64 } },
} as const;
const epochParams = {
  type: "object",
  additionalProperties: false,
  required: ["epochId"],
  properties: { epochId: { type: "string", maxLength: 64 } },
} as const;

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
}

function assertEmptyBody(request: FastifyRequest): Promise<void> {
  const body = request.body;
  if (
    body !== undefined &&
    body !== null &&
    !(
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.keys(body).length === 0
    )
  ) {
    throw new AdminApiError("INVALID_REQUEST");
  }
  return Promise.resolve();
}

export function registerAdminMiningSettlementRoutes(
  app: FastifyInstance,
  dependencies: AdminMiningSettlementRouteDependencies,
): void {
  const { service, guard, guardAny, context } = dependencies;
  const prefix = `${adminApiPrefix}/mining`;

  app.get(
    `${prefix}/parameter-versions`,
    {
      schema: {
        operationId: "listAdminMiningParameterVersions",
        summary: "List hourly settlement parameter versions",
        description:
          "Decision 0116: newest 50 versions (pending_approval / approved / withdrawn) with their documents, plus `defaults` (docs/16, frozen 2026-10-10: 10/5/3/2/1 % in bps, 500,000 LOOP per pool per day spread over 24 UTC hours, 900 days, UTC, minimum claim 1 LOOP, assetPowerBasis quantity, defaultCommunityCoefficient 1). Documents approved before Decision 0123 have no assetPowerBasis / defaultCommunityCoefficient and are shown as valuation / 0 (the rule their hours were settled by). Readable with console.read or formula.approve.",
        tags: ["admin-mining"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: resource({
            items: { type: "array", items: versionSchema },
            defaults: looseObject,
          }),
          ...adminErrors(...guardedSessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...guardAny(["console.read", "formula.approve"]),
    },
    async (_request, reply) => {
      const result = await service.listParameterVersions();
      noStore(reply);
      return reply.code(200).send(result);
    },
  );

  app.get(
    `${prefix}/pool`,
    {
      schema: {
        operationId: "listAdminMiningPool",
        summary: "Mining power list (verified community × bound token)",
        description:
          'Decision 0187 / 0189 (power list): one row per verified community with a bound asset (`communities.bound_asset_key`). `kind` = platform when the asset is a launch2 instance MEME (any chain): it takes part without registration; kind = external for any other bound token (e.g. a BSC mainnet asset): it takes part only once let in — `includedAssets` lists the asset (and neither excluded list names it); its weight is then `assetWeights[assetId]` if listed, else "1"; not let in, it shows participate false, tokenWeight "0", nftCoefficient "0". The list is the only rule for bound assets (the community_mining_weights table is no longer read). Values are those of the approved parameter version in force now (`inForce`; null = none yet: every row shows the defaults) and, per row, of the newest pending draft (`pendingDraft`, null without one). Effective rule (also what settlement and snapshot apply): tokenWeight = `assetWeights[assetId]` if listed, else "1"; NFT coefficient = `communityCoefficients[communityId]` if listed, else `defaultCommunityCoefficient` ("1"); an asset in `excludedAssets` has weight "0", a community in `excludedCommunities` has coefficient "0"; `participate` = neither excluded. `source` = "explicit" when the document names the asset or community in any of those four keys, else "default". Filters: `address` = bound token contract address, exact, case-insensitive; `q` = community name or ticker / symbol, case-insensitive substring (≤ 64); `kind` = platform | external (absent: both). Ordered by community name then id; `cursor` / `limit` (1-100, default 20, not together). Saving: build ONE parameter draft from the whole table with `POST /admin/v1/mining/parameter-versions` — carry the other keys of the in-force document unchanged and fold every row: participate unticked → add assetId to `excludedAssets` AND communityId to `excludedCommunities` (drop both from the explicit tables); ticked → leave both out of the excluded lists, put `{assetId, weight}` in `assetWeights` only when tokenWeight ≠ "1" (or to pin it), and `{communityId, coefficient}` in `communityCoefficients` only when the coefficient ≠ defaultCommunityCoefficient (or to pin it); external rows: ticked → assetId in `includedAssets` (weight as above), unticked → assetId out of `includedAssets` and `assetWeights` (not into excludedAssets); keep explicit rows of non-roster assets / communities as they are (Decision 0191: an assetWeights entry for a non-roster asset weighs nothing in settlement or snapshot; each settled hour lists it in inputSummary.ignoredNonRosterAssetIds). A reviewer approves it as any parameter draft. Readable with console.read or formula.approve.',
        tags: ["admin-mining"],
        security: adminSecurity,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
            q: { type: "string", maxLength: 64 },
            kind: { type: "string", enum: ["platform", "external"] },
            cursor: { type: "string", minLength: 1, maxLength: 1024 },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        response: {
          200: resource({
            inForce: poolVersionReference,
            pendingDraftVersion: poolVersionReference,
            items: { type: "array", maxItems: 100, items: poolRowSchema },
            nextCursor: nullableString,
          }),
          ...adminErrors(...guardedSessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...guardAny(["console.read", "formula.approve"]),
    },
    async (request, reply) => {
      const result = await service.listPool(
        request.query as Record<string, unknown>,
      );
      noStore(reply);
      return reply.code(200).send(result);
    },
  );

  app.post(
    `${prefix}/parameter-versions`,
    {
      schema: {
        operationId: "createAdminMiningParameterDraft",
        summary: "Draft a hourly settlement parameter version",
        description:
          'Decision 0116 / 0123: `parameters` overrides the defaults (referralRatiosBps[5], dailyBudgetNftRaw, dailyBudgetAssetRaw, releaseStartAt (UTC midnight, required), releaseDays, minimumClaimRaw, assetWeights [{assetId, weight}], communityCoefficients [{communityId, coefficient}] — omitted: a frozen copy of the approved community_mining_weights, defaultCommunityCoefficient (decimal, default "1": every unlisted community), assetPowerBasis (optional, only "quantity"; stored as quantity: asset power = balance TWAB × weight, no price — there is no price / reference-price field; anything else is 422 field assetPowerBasis), Decision 0187: excludedAssets [assetId] (optional, ≤ 500, unique: weight 0 even if listed or a roster MEME), excludedCommunities [communityId] (optional, ≤ 2000, unique: NFT coefficient 0), Decision 0189: includedAssets [assetId] (optional, ≤ 500, unique: the external tokens let in to the power list)). Decision 0187 mining pool roster: a launch2 MEME bound by a verified community weighs 1 unless assetWeights lists it or excludedAssets names it — this is how the console pool table is saved (see GET /admin/v1/mining/pool for the folding rule). effectiveFrom must be in the future. An asset without a launch2 / MEME v1 source is 422 MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN (Decision 0189: an includedAssets id, or an assetWeights id also in includedAssets, may instead be the bound asset of a verified community); Decision 0183: a communityCoefficients or excludedCommunities id that does not exist or is not verified is 422 MINING_COMMUNITY_UNKNOWN (detailsSafe.unknownCommunityIds: string[], detailsSafe.field: communityCoefficients | excludedCommunities), an assetWeights or excludedAssets id without a source is 422 MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN, and the frozen copy drops non-verified communities and lists them in the optional skippedCommunityIds; a malformed field is 422 ADMIN_MINING_PARAMETERS_INVALID (field). The caller is the draft author; a reviewer other than the author approves.',
        tags: ["admin-mining"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["configVersion", "effectiveFrom", "parameters"],
          properties: {
            configVersion: { type: "string", maxLength: 128 },
            effectiveFrom: { type: "string", format: "date-time" },
            parameters: looseObject,
          },
        },
        response: {
          201: draftWriteResource,
          ...adminErrors(
            ...guardedSessionErrors,
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
            "MINING_COMMUNITY_UNKNOWN",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guard("console.write"),
    },
    async (request, reply) => {
      const result = await service.createParameterDraft(
        context(request),
        request.body as Record<string, unknown>,
      );
      noStore(reply);
      return reply.code(201).send(result);
    },
  );

  app.post(
    `${prefix}/parameter-versions/:versionId/approve`,
    {
      schema: {
        operationId: "approveAdminMiningParameterVersion",
        summary: "Approve a parameter version (in force at effectiveFrom)",
        description:
          "Decision 0116 (0110/0111 rules): formula.approve only (reviewer); not the draft author (403 ADMIN_FORMULA_SELF_APPROVAL); bound operator enabled (403 ADMIN_OPERATOR_DISABLED / ADMIN_ACCOUNT_DISABLED). Audit `mining.parameters.approve.requested` first (cannot be written: 503 ADMIN_AUDIT_UNAVAILABLE), then `mining.parameters.approve` or `.failed`. 409 ADMIN_MINING_PARAMETERS_STATE (not pending) | ADMIN_MINING_PARAMETERS_BASIS_RETIRED (Decision 0123: a draft stored without assetPowerBasis = quantity — withdraw and redraft) | ADMIN_MINING_PARAMETERS_EFFECTIVE_PASSED | ADMIN_MINING_PARAMETERS_EFFECTIVE_TAKEN. Decision 0183: 422 MINING_COMMUNITY_UNKNOWN (detailsSafe.unknownCommunityIds) when a listed community (communityCoefficients or, Decision 0187, excludedCommunities) no longer exists or is not verified. Approved versions are immutable; history is never rewritten.",
        tags: ["admin-mining"],
        security: adminSecurity,
        params: versionParams,
        querystring: emptyQuerySchema,
        response: {
          200: versionWriteResource,
          ...adminErrors(
            ...guardedSessionErrors,
            "NOT_FOUND",
            "ADMIN_CONFLICT",
            "MINING_COMMUNITY_UNKNOWN",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      preValidation: assertEmptyBody,
      ...guard("formula.approve"),
    },
    async (request, reply) => {
      const { versionId } = request.params as { readonly versionId: string };
      const result = await service.approveParameterVersion(
        context(request),
        versionId,
      );
      noStore(reply);
      return reply.code(200).send(result);
    },
  );

  app.post(
    `${prefix}/parameter-versions/:versionId/withdraw`,
    {
      schema: {
        operationId: "withdrawAdminMiningParameterVersion",
        summary: "Withdraw a pending parameter draft",
        description:
          "Decision 0116: pending_approval → withdrawn. An approved version cannot be withdrawn (409 ADMIN_MINING_PARAMETERS_STATE); approve a newer one instead.",
        tags: ["admin-mining"],
        security: adminSecurity,
        params: versionParams,
        querystring: emptyQuerySchema,
        response: {
          200: versionWriteResource,
          ...adminErrors(
            ...guardedSessionErrors,
            "NOT_FOUND",
            "ADMIN_CONFLICT",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      preValidation: assertEmptyBody,
      ...guard("console.write"),
    },
    async (request, reply) => {
      const { versionId } = request.params as { readonly versionId: string };
      const result = await service.withdrawParameterVersion(
        context(request),
        versionId,
      );
      noStore(reply);
      return reply.code(200).send(result);
    },
  );

  app.get(
    `${prefix}/epochs`,
    {
      schema: {
        operationId: "listAdminMiningEpochs",
        summary: "List settlement hours",
        description:
          "Decision 0116: newest 48 hours (settled / failed / pending), with budgets, denominators, allocated / unallocated, parameter version, input digest and summary (excluded assets, unbound instances, unattributed holdings), failure reason. Page with `before` (an hourStart). console.read or audit.read (auditor, reviewer).",
        tags: ["admin-mining"],
        security: adminSecurity,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { before: { type: "string", format: "date-time" } },
        },
        response: {
          200: resource({
            items: { type: "array", items: epochSchema },
            nextBefore: nullableString,
          }),
          ...adminErrors(...guardedSessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...guardAny(["console.read", "audit.read"]),
    },
    async (request, reply) => {
      const result = await service.listEpochs(
        request.query as Record<string, unknown>,
      );
      noStore(reply);
      return reply.code(200).send(result);
    },
  );

  app.get(
    `${prefix}/epochs/:epochId`,
    {
      schema: {
        operationId: "getAdminMiningEpoch",
        summary: "Read one settlement hour with its reward rows",
        description:
          "Decision 0116: the epoch and up to 500 user rows (both tracks' self / referral / total power, five levels, rewards). console.read or audit.read.",
        tags: ["admin-mining"],
        security: adminSecurity,
        params: epochParams,
        querystring: emptyQuerySchema,
        response: {
          200: resource({
            epoch: epochSchema,
            rewards: { type: "array", items: looseObject },
            rewardRowCount: { type: "integer" },
          }),
          ...adminErrors(
            ...guardedSessionErrors,
            "NOT_FOUND",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guardAny(["console.read", "audit.read"]),
    },
    async (request, reply) => {
      const { epochId } = request.params as { readonly epochId: string };
      const result = await service.getEpoch(epochId);
      noStore(reply);
      return reply.code(200).send(result);
    },
  );

  app.get(
    `${prefix}/epochs/:epochId/replay`,
    {
      schema: {
        operationId: "replayAdminMiningEpoch",
        summary: "Recompute a settled hour and compare (read-only)",
        description:
          "Decision 0116: re-reads the same sources, recomputes with the same parameter versions, and compares the input digest and every reward row. Nothing is written. A source that changed since (a reorg removed a log) shows digestMatches false.",
        tags: ["admin-mining"],
        security: adminSecurity,
        params: epochParams,
        querystring: emptyQuerySchema,
        response: {
          200: resource({
            replay: {
              type: "object",
              additionalProperties: false,
              required: [
                "epochId",
                "storedDigest",
                "replayDigest",
                "digestMatches",
                "rewardsMatch",
                "mismatchedUserCount",
                "reasonCode",
              ],
              properties: {
                epochId: { type: "string" },
                storedDigest: nullableString,
                replayDigest: nullableString,
                digestMatches: { type: "boolean" },
                rewardsMatch: { type: "boolean" },
                mismatchedUserCount: { type: "integer" },
                reasonCode: nullableString,
              },
            },
          }),
          ...adminErrors(
            ...guardedSessionErrors,
            "NOT_FOUND",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guardAny(["console.read", "audit.read"]),
    },
    async (request, reply) => {
      const { epochId } = request.params as { readonly epochId: string };
      const result = await service.replayEpoch(epochId);
      noStore(reply);
      return reply.code(200).send(result);
    },
  );

  app.get(
    `${prefix}/funding`,
    {
      schema: {
        operationId: "getAdminMiningFunding",
        summary:
          "Compare the claim contract balance with the unclaimed liability",
        description:
          "Decision 0116: liabilityRaw = Σ unclaimed (settled − claimed) of every user; balanceRaw = LoopRewardClaim.balance(); alert = balance < liability (shortfallRaw). status unavailable (no contract / chain) still shows the liability.",
        tags: ["admin-mining"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: resource({
            status: { type: "string", enum: ["available", "unavailable"] },
            reasonCode: nullableString,
            contractAddress: nullableString,
            liabilityRaw: rawSchema,
            balanceRaw: nullableRawSchema,
            liabilityHintRaw: nullableRawSchema,
            paused: { anyOf: [{ type: "boolean" }, { type: "null" }] },
            blockNumber: nullableRawSchema,
            alert: { anyOf: [{ type: "boolean" }, { type: "null" }] },
            shortfallRaw: nullableRawSchema,
          }),
          ...adminErrors(...guardedSessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...guardAny(["console.read", "audit.read"]),
    },
    async (_request, reply) => {
      const result = await service.funding();
      noStore(reply);
      return reply.code(200).send(result);
    },
  );

  app.post(
    `${prefix}/epochs/settle`,
    {
      schema: {
        operationId: "settleAdminMiningHour",
        summary: "Settle one completed hour now (test environments only)",
        description:
          "Decision 0116: only with MINING_SETTLEMENT_TEST_TRIGGER=true (refused under production; otherwise 503 MINING_SETTLEMENT_TEST_TRIGGER_DISABLED). Same rules as the worker: the hour must be complete (+ grace), sources indexed, parameters in force; a settled hour is not recomputed (outcome already_settled). Audit `mining.epoch.settle.requested`.",
        tags: ["admin-mining"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["hourStart"],
          properties: { hourStart: { type: "string", format: "date-time" } },
        },
        response: {
          200: resource({
            outcome: {
              type: "string",
              enum: ["settled", "already_settled", "skipped", "failed"],
            },
            reasonCode: nullableString,
            epoch: { anyOf: [epochSchema, { type: "null" }] },
            audit: auditSchema,
          }),
          ...adminErrors(...guardedSessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...guard("console.write"),
    },
    async (request, reply) => {
      const result = await service.settleHour(
        context(request),
        request.body as Record<string, unknown>,
      );
      noStore(reply);
      return reply.code(200).send(result);
    },
  );
}
