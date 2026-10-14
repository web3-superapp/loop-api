import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { adminSessionCookieName } from "../../features/admin/admin-contract.js";
import {
  adminAccountProjectScopeMaximum,
  adminOperatorLabelMaximumLength,
  adminPasswordMaximumLength,
  adminPasswordMinimumLength,
} from "../../features/admin/admin-accounts.js";
import { adminLaunchStages } from "../../features/admin/admin-launch-review.js";
import { hooksLaunchDeploymentStatuses } from "../../features/launch/hooks-launch-deployment-status.js";
import {
  adminPermissions,
  adminRoles,
} from "../../features/admin/admin-roles.js";
import { hooksLaunchOpsPermissions } from "../../features/launch/hooks-launch-review.js";
import { auditReferenceSchema } from "./admin-schemas.js";

/**
 * Decision 0109 route schemas: session principal, console accounts, and
 * the Hooks launch review. Source of `openapi/loop-admin.v1.json`.
 */

const uuidSchema = { type: "string", format: "uuid" } as const;
const nullableUuidSchema = { anyOf: [uuidSchema, { type: "null" }] } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;
const nullableDateTimeSchema = {
  anyOf: [dateTimeSchema, { type: "null" }],
} as const;
const hash32Schema = {
  type: "string",
  pattern: "^0x[0-9a-fA-F]{64}$",
} as const;
const addressSchema = {
  type: "string",
  pattern: "^0x[0-9a-fA-F]{40}$",
} as const;
const roleSchema = { type: "string", enum: [...adminRoles] } as const;
const permissionListSchema = {
  type: "array",
  items: { type: "string", enum: [...adminPermissions] },
  description:
    "Console permissions of the role (Decision 0109). Empty while `passwordChangeRequired`. The client may hide buttons with it; the server checks every request.",
} as const;
const nullableAuditReferenceSchema = {
  anyOf: [auditReferenceSchema, { type: "null" }],
} as const;

export const idempotencyHeadersSchema = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": {
      type: "string",
      pattern:
        "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      description:
        "Lower-case UUIDv4. The same key with the same body replays the first result (`replayed: true`); with another body or actor it is 409 ADMIN_CONFLICT (ADMIN_IDEMPOTENCY_CONFLICT / OPS_IDEMPOTENCY_CONFLICT).",
    },
  },
} as const;

const principalProperties = {
  actor: { type: "string", description: "Display username." },
  accountId: {
    ...nullableUuidSchema,
    description:
      "Stable console account ID; null for the ADMIN_USERNAME bootstrap administrator.",
  },
  role: roleSchema,
  permissions: permissionListSchema,
  passwordChangeRequired: {
    type: "boolean",
    description:
      "An administrator-set password: every route except GET/DELETE /session and POST /session/password answers 403 PERMISSION_DENIED (ADMIN_PASSWORD_CHANGE_REQUIRED) until it is changed.",
  },
  operatorUserId: {
    ...nullableUuidSchema,
    description:
      "The LOOP user whose ops grants the reviewer / testnet acceptor acts with; null for other roles.",
  },
  issuedAt: dateTimeSchema,
  expiresAt: dateTimeSchema,
} as const;

const principalRequired = [
  "actor",
  "accountId",
  "role",
  "permissions",
  "passwordChangeRequired",
  "operatorUserId",
  "issuedAt",
  "expiresAt",
] as const;

/** Login, current session, and password change responses. */
export const principalResourceSchema = {
  type: "object",
  headers: {
    ...noStoreResponseHeaders(),
    "set-cookie": {
      type: "string",
      description: `${adminSessionCookieName}=<signed>; Path=/admin; Max-Age=43200; HttpOnly; SameSite=Strict; Secure`,
    },
  },
  additionalProperties: false,
  required: [...principalRequired],
  properties: principalProperties,
} as const;

export const principalReadResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [...principalRequired],
  properties: principalProperties,
} as const;

export const passwordChangeRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["currentPassword", "newPassword"],
  properties: {
    currentPassword: { type: "string", minLength: 1, maxLength: 1024 },
    newPassword: {
      type: "string",
      minLength: adminPasswordMinimumLength,
      maxLength: adminPasswordMaximumLength,
    },
  },
} as const;

const operatorStateSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["loopId", "enabled", "grants"],
      properties: {
        loopId: {
          type: ["string", "null"],
          description:
            "Decision 0130: the bound user's LOOP ID (`LOOP-XXXXXXXX`, what the App's Me page shows). null only if the user row is gone.",
        },
        enabled: {
          type: ["boolean", "null"],
          description: "null: no ops_operators row.",
        },
        grants: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["permission", "scope"],
            properties: {
              permission: {
                type: "string",
                enum: [...hooksLaunchOpsPermissions],
              },
              scope: {
                type: "string",
                description: "`*` or one launch project ID.",
              },
            },
          },
        },
      },
    },
    { type: "null" },
  ],
} as const;

export const accountSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "accountId",
    "username",
    "role",
    "permissions",
    "status",
    "operatorUserId",
    "operator",
    "locked",
    "lockedUntil",
    "passwordChangeRequired",
    "credentialsChangedAt",
    "createdAt",
    "createdBy",
    "disabledAt",
    "disabledBy",
  ],
  properties: {
    accountId: uuidSchema,
    username: { type: "string" },
    role: roleSchema,
    permissions: permissionListSchema,
    status: { type: "string", enum: ["active", "disabled"] },
    operatorUserId: nullableUuidSchema,
    operator: operatorStateSchema,
    locked: {
      type: "boolean",
      description:
        "Decision 0111: the login name is locked right now (too many wrong passwords; Decision 0110). Show the unlock button only when true.",
    },
    lockedUntil: {
      ...nullableDateTimeSchema,
      description:
        "Decision 0111: when the login-name lock lifts by itself; null when not locked. Read-only (admin_login_attempts). Address (IP) locks are not shown here.",
    },
    passwordChangeRequired: { type: "boolean" },
    credentialsChangedAt: dateTimeSchema,
    createdAt: dateTimeSchema,
    createdBy: { type: "string" },
    disabledAt: nullableDateTimeSchema,
    disabledBy: { type: ["string", "null"] },
  },
} as const;

export const accountListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "bootstrap"],
  properties: {
    items: { type: "array", maxItems: 500, items: accountSchema },
    bootstrap: {
      type: "object",
      additionalProperties: false,
      required: ["username", "role", "source"],
      properties: {
        username: { type: "string" },
        role: { type: "string", const: "platform_admin" },
        source: { type: "string", const: "environment" },
      },
      description:
        "The ADMIN_USERNAME bootstrap administrator (environment; cannot be disabled or reset here).",
    },
  },
} as const;

export const accountWriteResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["account", "changed", "replayed", "audit"],
  properties: {
    account: accountSchema,
    changed: { type: "boolean" },
    replayed: {
      type: "boolean",
      description: "True when this Idempotency-Key was already applied.",
    },
    audit: nullableAuditReferenceSchema,
  },
} as const;

export const accountCreateRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["username", "password", "role"],
  properties: {
    username: {
      type: "string",
      pattern: "^[A-Za-z0-9._@-]{1,64}$",
      description:
        "Unique, case-insensitive; never the ADMIN_USERNAME bootstrap name.",
    },
    password: {
      type: "string",
      minLength: adminPasswordMinimumLength,
      maxLength: adminPasswordMaximumLength,
      description:
        "Initial password; the holder must change it at first login.",
    },
    role: roleSchema,
    operatorUserId: {
      ...nullableUuidSchema,
      description:
        "reviewer / testnet_acceptor need this or `operatorLoopId` (the LOOP user that holds the ops grants); refused for other roles. One active account per LOOP user.",
    },
    operatorLoopId: {
      anyOf: [
        { type: "string", pattern: "^[Ll][Oo][Oo][Pp]-[A-Za-z0-9]{8}$" },
        { type: "null" },
      ],
      description:
        "Decision 0130: the LOOP ID the App shows (`LOOP-XXXXXXXX`, any case; upper-cased by the server), as an alternative to `operatorUserId`. Unknown → 422 VALIDATION_FAILED (ADMIN_ACCOUNT_OPERATOR_LOOP_ID_NOT_FOUND). With `operatorUserId` both must name the same user, else 422 VALIDATION_FAILED (ADMIN_ACCOUNT_OPERATOR_IDENTITY_MISMATCH). Refused for roles without an operator.",
    },
    operatorLabel: {
      type: ["string", "null"],
      maxLength: adminOperatorLabelMaximumLength * 4,
      description: "ops_operators.label (default: the username).",
    },
    projectIds: {
      anyOf: [
        {
          type: "array",
          minItems: 1,
          maxItems: adminAccountProjectScopeMaximum,
          items: uuidSchema,
        },
        { type: "null" },
      ],
      description:
        "Per-project authorization: scope the project permissions to these launch projects. null = every project.",
    },
  },
} as const;

export const accountIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["accountId"],
  properties: { accountId: { type: "string", maxLength: 64 } },
} as const;

export const accountDisableRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reasonCode"],
  properties: {
    reasonCode: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
  },
} as const;

export const accountUnlockRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reasonCode"],
  properties: {
    reasonCode: {
      type: "string",
      pattern: "^[a-z][a-z0-9_]{0,63}$",
      description:
        "Why the lock is lifted early (lower snake case, e.g. `identity_verified`); stored in the audit row.",
    },
  },
} as const;

export const accountResetPasswordRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["password"],
  properties: {
    password: {
      type: "string",
      minLength: adminPasswordMinimumLength,
      maxLength: adminPasswordMaximumLength,
    },
  },
} as const;

const editorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "userId"],
  properties: {
    kind: { type: "string", enum: ["owner", "operator"] },
    userId: uuidSchema,
  },
} as const;

/** Decision 0122: the five review rejection reasons. */
const rejectionReasonSchema = {
  type: "string",
  enum: [
    "incomplete_materials",
    "name_or_ticker_conflict",
    "buyback_recipient_invalid",
    "community_binding_mismatch",
    "other",
  ],
} as const;

const projectSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "projectId",
    "name",
    "ticker",
    "ownerUserId",
    "launchReviewStatus",
    "stage",
    "latestConfigVersion",
    "latestConfigHash",
    "latestEditedBy",
    "latestApproval",
    "latestAcceptanceOutcome",
    "activeDeploymentJobId",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    projectId: uuidSchema,
    name: { type: "string" },
    ticker: { type: "string" },
    ownerUserId: uuidSchema,
    kind: {
      type: "string",
      enum: ["ido", "launch2"],
      description:
        "Decision 0122 (optional in the schema, always present): the catalog product kind (Decision 0120); filter with ?kind=.",
    },
    launchReviewStatus: {
      type: "string",
      description:
        "launch_projects.review_status (draft, submitted, in_review, returned, approved, rejected). Hooks review commands need `approved`. Decision 0122: a reviewer may reject `submitted` / `in_review` material (POST …/reject); `rejected` material can be edited and resubmitted by the applicant.",
    },
    materialVersion: {
      type: "integer",
      minimum: 1,
      description:
        "Decision 0122 (optional in the schema, always present): launch_projects.material_version — send it as materialVersion when rejecting the catalog material.",
    },
    rejection: {
      description:
        "Decision 0122 (optional in the schema, always present): the latest catalog rejection while launchReviewStatus is rejected; null otherwise.",
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "reasonCode",
            "note",
            "reviewerUserId",
            "materialVersion",
            "rejectedAt",
          ],
          properties: {
            reasonCode: rejectionReasonSchema,
            note: { anyOf: [{ type: "string" }, { type: "null" }] },
            reviewerUserId: uuidSchema,
            materialVersion: { type: "integer", minimum: 1 },
            rejectedAt: dateTimeSchema,
          },
        },
        { type: "null" },
      ],
    },
    materialApproval: {
      description:
        "Decision 0125 (optional in the schema, always present): the latest console approval of the catalog material (POST …/materials/{materialVersion}/approve); null when none (also for material approved with the pnpm launch:review script).",
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["approverUserId", "materialVersion", "approvedAt"],
          properties: {
            approverUserId: uuidSchema,
            materialVersion: { type: "integer", minimum: 1 },
            approvedAt: dateTimeSchema,
          },
        },
        { type: "null" },
      ],
    },
    communityId: {
      description:
        "Decision 0125 (optional in the schema, always present): launch_projects.community_id — the community the owner named for the MEME; null when none.",
      anyOf: [uuidSchema, { type: "null" }],
    },
    community: {
      description:
        "Decision 0125 (optional in the schema, always present): the named community as it is now, for the community_binding_mismatch review — name, its current boundAssetKey (null when unbound), verificationStatus, and binding = the launch2_event lane's one automatic binding attempt of the latest MEME v2 instance (bound | already_bound | conflict | not_owner | community_unavailable | asset_blocked | none; null before the MEME is registered). null when the project names no community.",
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "communityId",
            "name",
            "verificationStatus",
            "boundAssetKey",
            "binding",
          ],
          properties: {
            communityId: uuidSchema,
            name: { type: "string" },
            verificationStatus: {
              type: "string",
              enum: ["pending", "verified", "rejected"],
            },
            boundAssetKey: { anyOf: [{ type: "string" }, { type: "null" }] },
            binding: {
              anyOf: [
                {
                  type: "string",
                  enum: [
                    "bound",
                    "already_bound",
                    "conflict",
                    "not_owner",
                    "community_unavailable",
                    "asset_blocked",
                    "none",
                  ],
                },
                { type: "null" },
              ],
            },
          },
        },
        { type: "null" },
      ],
    },
    stage: {
      type: "string",
      enum: [...adminLaunchStages],
      description:
        "Of the latest config version: draft (none saved), awaiting_approval, rejected (Decision 0122: a reviewer rejected it; the owner saves a new version), approved, accepted (a passed BSC Testnet acceptance), deploying (a task the executor still owns: awaiting_executor, claimed, broadcast, confirmed, verified, reorged, or a retryable failure), activated (Decision 0112: the launch is activated on chain).",
    },
    latestConfigVersion: { type: ["integer", "null"], minimum: 1 },
    latestConfigHash: { anyOf: [hash32Schema, { type: "null" }] },
    latestEditedBy: { anyOf: [editorSchema, { type: "null" }] },
    latestApproval: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["approverUserId", "approvedAt"],
          properties: {
            approverUserId: uuidSchema,
            approvedAt: dateTimeSchema,
          },
        },
        { type: "null" },
      ],
    },
    latestRejection: {
      description:
        "Decision 0122 (optional in the schema, always present): the latest config version's reviewer rejection; null otherwise.",
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["reviewerUserId", "rejectedAt"],
          properties: {
            reviewerUserId: uuidSchema,
            rejectedAt: dateTimeSchema,
          },
        },
        { type: "null" },
      ],
    },
    latestAcceptanceOutcome: {
      anyOf: [
        { type: "string", enum: ["passed", "failed", "incomplete"] },
        { type: "null" },
      ],
    },
    activeDeploymentJobId: nullableUuidSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
} as const;

export const launchProjectsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: [...adminLaunchStages] },
    kind: {
      type: "string",
      enum: ["all", "ido", "launch2"],
      description:
        "Decision 0122: product kind filter (default all); bound into the cursor.",
    },
    cursor: { type: "string", minLength: 1, maxLength: 1024 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

export const launchProjectListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "nextCursor", "scope"],
  properties: {
    items: { type: "array", maxItems: 100, items: projectSummarySchema },
    nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    scope: {
      type: "string",
      enum: ["all", "projects"],
      description:
        "`projects`: a reviewer / acceptor authorized for some projects only.",
    },
  },
} as const;

export const launchProjectParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectId"],
  properties: { projectId: { type: "string", maxLength: 64 } },
} as const;

export const launchVersionParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectId", "version"],
  properties: {
    projectId: { type: "string", maxLength: 64 },
    version: { type: "string", pattern: "^[1-9][0-9]{0,9}$" },
  },
} as const;

/** Decision 0125: `…/materials/{materialVersion}/approve`. */
export const launchMaterialParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectId", "materialVersion"],
  properties: {
    projectId: { type: "string", maxLength: 64 },
    materialVersion: { type: "string", pattern: "^[1-9][0-9]{0,9}$" },
  },
} as const;

const configSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "ticker",
    "logoAssetUrl",
    "description",
    "links",
    "nftSaleStartAt",
    "buybackRecipient",
    "templateHash",
    "fixedEconomics",
  ],
  properties: {
    name: { type: ["string", "null"] },
    ticker: { type: ["string", "null"] },
    logoAssetUrl: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    links: { type: ["array", "null"], items: { type: "string" } },
    nftSaleStartAt: {
      type: ["string", "null"],
      description: "Unix seconds as a decimal string.",
    },
    buybackRecipient: {
      anyOf: [addressSchema, { type: "null" }],
      description: "Per-project receiving address (收币地址).",
    },
    templateHash: { anyOf: [hash32Schema, { type: "null" }] },
    fixedEconomics: {
      anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }],
      description:
        "hooks_launch_v1 fixed economics as stored (raw amounts are decimal strings).",
    },
  },
} as const;

const approvalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["approverUserId", "configHash", "reason", "approvedAt"],
  properties: {
    approverUserId: uuidSchema,
    configHash: hash32Schema,
    reason: { type: "string" },
    approvedAt: dateTimeSchema,
  },
} as const;

const evidenceSchema = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["label", "uri"],
    properties: {
      label: { type: "string", minLength: 1, maxLength: 100 },
      uri: {
        type: "string",
        maxLength: 2048,
        description: "An https URL or a 0x transaction hash.",
      },
    },
  },
} as const;

const acceptanceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "acceptanceId",
    "configVersion",
    "chainId",
    "configHash",
    "contractManifestHash",
    "checklistVersion",
    "outcome",
    "evidence",
    "acceptorUserId",
    "reason",
    "createdAt",
  ],
  properties: {
    acceptanceId: uuidSchema,
    configVersion: { type: "integer", minimum: 1 },
    chainId: { type: "integer", const: 97 },
    configHash: hash32Schema,
    contractManifestHash: hash32Schema,
    checklistVersion: { type: "string" },
    outcome: { type: "string", enum: ["passed", "failed", "incomplete"] },
    evidence: evidenceSchema,
    acceptorUserId: uuidSchema,
    reason: { type: "string" },
    createdAt: dateTimeSchema,
  },
} as const;

const deploymentStatusSchema = {
  type: "string",
  enum: [...hooksLaunchDeploymentStatuses],
} as const;
const nullableHash32Schema = {
  anyOf: [hash32Schema, { type: "null" }],
} as const;
const nullableDecimalSchema = {
  anyOf: [
    { type: "string", pattern: "^(0|[1-9][0-9]{0,19})$" },
    { type: "null" },
  ],
} as const;

const deploymentEventSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sequence",
    "fromStatus",
    "toStatus",
    "kind",
    "txHash",
    "blockNumber",
    "blockHash",
    "confirmations",
    "errorCode",
    "details",
    "actor",
    "createdAt",
  ],
  properties: {
    sequence: { type: "integer", minimum: 1 },
    fromStatus: { anyOf: [deploymentStatusSchema, { type: "null" }] },
    toStatus: deploymentStatusSchema,
    kind: { type: "string", pattern: "^[a-z_]{1,40}$" },
    txHash: nullableHash32Schema,
    blockNumber: nullableDecimalSchema,
    blockHash: nullableHash32Schema,
    confirmations: { type: ["integer", "null"], minimum: 0 },
    errorCode: { type: ["string", "null"] },
    details: {
      type: "object",
      additionalProperties: true,
      description:
        "Safe step details: failedChecks (verification check names), retryable, attempt, nonce, revert (contract error name). Never a key, signature, or raw transaction.",
    },
    actor: {
      type: ["string", "null"],
      description:
        "Executor instance ID (host:pid:random); null for owner/system rows.",
    },
    createdAt: dateTimeSchema,
  },
} as const;

const deploymentTaskSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "jobId",
    "configVersion",
    "status",
    "chainId",
    "factoryAddress",
    "projectOwner",
    "ownerNonce",
    "bindingHash",
    "predictedMemeAddress",
    "predictedHookAddress",
    "authorizationCount",
    "latestAuthorizationAt",
    "executorAddress",
    "claimedBy",
    "attemptCount",
    "txHash",
    "txNonce",
    "blockNumber",
    "blockHash",
    "confirmations",
    "launchId",
    "deployedAddresses",
    "verifiedChecks",
    "activationTxHash",
    "activationBlockNumber",
    "activatedAt",
    "failure",
    "events",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    jobId: uuidSchema,
    configVersion: { type: "integer", minimum: 1 },
    status: {
      ...deploymentStatusSchema,
      description:
        "Decision 0112 state machine: awaiting_executor → claimed → broadcast → confirmed → verified → activated; failed (failure.retryable → retried), reorged (→ claimed, same transaction re-sent), cancelled.",
    },
    chainId: { type: "integer", const: 97 },
    factoryAddress: addressSchema,
    projectOwner: {
      ...addressSchema,
      description: "The project wallet that signed (a fact, never a key).",
    },
    ownerNonce: {
      type: "string",
      pattern: "^(0|[1-9][0-9]*)$",
      description: "Factory nonce, decimal string.",
    },
    bindingHash: hash32Schema,
    predictedMemeAddress: {
      ...addressSchema,
      description: "EIP-712-bound CREATE2 prediction (suffix 6666).",
    },
    predictedHookAddress: {
      ...addressSchema,
      description: "EIP-712-bound CREATE2 prediction of the Hook.",
    },
    authorizationCount: {
      type: "integer",
      minimum: 0,
      description:
        "Signed authorizations on file (deadline renewals). The signatures themselves are never returned.",
    },
    latestAuthorizationAt: nullableDateTimeSchema,
    executorAddress: { anyOf: [addressSchema, { type: "null" }] },
    claimedBy: { type: ["string", "null"] },
    attemptCount: { type: "integer", minimum: 0 },
    txHash: nullableHash32Schema,
    txNonce: nullableDecimalSchema,
    blockNumber: nullableDecimalSchema,
    blockHash: nullableHash32Schema,
    confirmations: { type: ["integer", "null"], minimum: 0 },
    launchId: nullableHash32Schema,
    deployedAddresses: {
      anyOf: [
        {
          type: "object",
          additionalProperties: { type: "string" },
        },
        { type: "null" },
      ],
      description:
        "launchId and every module address read back from the Factory (meme, hook, nft, curve, gate, escrow, snapshots, graduationAdapter, buybackAdapter, priceRecorder, buybackExecutor).",
    },
    verifiedChecks: {
      type: "array",
      maxItems: 64,
      items: { type: "string" },
      description: "Verification checks that passed before activation.",
    },
    activationTxHash: nullableHash32Schema,
    activationBlockNumber: nullableDecimalSchema,
    activatedAt: nullableDateTimeSchema,
    failure: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["code", "retryable"],
          properties: {
            code: { type: "string" },
            retryable: { type: "boolean" },
          },
        },
        { type: "null" },
      ],
    },
    events: {
      type: "array",
      maxItems: 100,
      items: deploymentEventSchema,
      description: "Latest 100 executor events, oldest first.",
    },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
} as const;

const snapshotPublicationSchema = {
  type: "object",
  additionalProperties: false,
  description:
    "Decision 0118: one server-side 2-of-3 snapshot publication attempt (newest first). Signatures and the raw transaction are never returned.",
  required: [
    "publicationId",
    "instanceId",
    "jobId",
    "attempt",
    "status",
    "cutoffBlock",
    "cutoffBlockHash",
    "memberCount",
    "root",
    "dataHash",
    "signerAddresses",
    "submitterAddress",
    "txHash",
    "blockNumber",
    "confirmations",
    "failure",
    "verification",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    publicationId: uuidSchema,
    instanceId: uuidSchema,
    jobId: uuidSchema,
    action: {
      type: "string",
      enum: ["publish_snapshot", "open_without_holders", "open_after_timeout"],
      description:
        "Decision 0122 (optional in the schema, always present): open_without_holders = the v3 zero-holder openPublicWithoutSnapshot() call (memberCount 0, zero root / dataHash, no signers). Decision 0137: open_after_timeout = the S175 openPublicAfterTimeout() fallback (same shape; cutoff = the head block the decision was taken at).",
    },
    attempt: { type: "integer", minimum: 1 },
    status: {
      type: "string",
      enum: ["pending", "broadcast", "confirmed", "failed", "mismatch"],
    },
    cutoffBlock: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
    cutoffBlockHash: hash32Schema,
    memberCount: { type: "integer", minimum: 0 },
    root: hash32Schema,
    dataHash: hash32Schema,
    signerAddresses: {
      type: "array",
      minItems: 0,
      maxItems: 2,
      items: addressSchema,
    },
    submitterAddress: addressSchema,
    txHash: { anyOf: [hash32Schema, { type: "null" }] },
    blockNumber: {
      anyOf: [
        { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        { type: "null" },
      ],
    },
    confirmations: {
      anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
    },
    failure: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["code", "detail", "retryable"],
          properties: {
            code: { type: "string" },
            detail: { anyOf: [{ type: "string" }, { type: "null" }] },
            retryable: { anyOf: [{ type: "boolean" }, { type: "null" }] },
          },
        },
        { type: "null" },
      ],
    },
    verification: {
      anyOf: [
        { type: "string", enum: ["verified", "mismatch"] },
        { type: "null" },
      ],
    },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
} as const;

const uintTextSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]*)$",
} as const;
const nullableUintTextSchema = {
  anyOf: [uintTextSchema, { type: "null" }],
} as const;

/** Decision 0121: one buyback keeper attempt (no raw transaction). */
const buybackAttemptSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "attemptId",
    "instanceId",
    "jobId",
    "attempt",
    "status",
    "simulation",
    "keeperAddress",
    "executorAddress",
    "orderUsd1Wei",
    "simulatedGas",
    "reason",
    "rejectionCount",
    "lastRejectedAt",
    "nextEligibleAt",
    "txHash",
    "txNonce",
    "blockNumber",
    "confirmations",
    "buybackId",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    attemptId: uuidSchema,
    instanceId: uuidSchema,
    jobId: uuidSchema,
    attempt: { type: "integer", minimum: 1 },
    status: {
      type: "string",
      enum: ["rejected", "pending", "broadcast", "confirmed", "failed"],
    },
    simulation: { type: "string", enum: ["passed", "reverted"] },
    keeperAddress: addressSchema,
    executorAddress: addressSchema,
    orderUsd1Wei: {
      ...nullableUintTextSchema,
      description: "Raw USD1 units (18 decimals) of the simulated order.",
    },
    simulatedGas: nullableUintTextSchema,
    reason: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["code", "detail"],
          properties: {
            code: { type: "string" },
            detail: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
        { type: "null" },
      ],
    },
    rejectionCount: {
      anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
    },
    lastRejectedAt: nullableDateTimeSchema,
    nextEligibleAt: nullableDateTimeSchema,
    txHash: { anyOf: [hash32Schema, { type: "null" }] },
    txNonce: nullableUintTextSchema,
    blockNumber: nullableUintTextSchema,
    confirmations: {
      anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
    },
    buybackId: nullableUuidSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
} as const;

/** Decision 0120: a platform-administrator retry grant (append-only). */
const snapshotReleaseSchema = {
  type: "object",
  additionalProperties: false,
  description:
    "Decision 0120: a retry grant. Attempts up to releasedAttempt no longer block the publisher or count against its retry budget; the publisher's next attempt is releasedAttempt + 1. The released publication row is unchanged.",
  required: [
    "releaseId",
    "projectId",
    "instanceId",
    "publicationId",
    "releasedAttempt",
    "releasedStatus",
    "releasedFailureCode",
    "actor",
    "reason",
    "createdAt",
  ],
  properties: {
    releaseId: uuidSchema,
    projectId: uuidSchema,
    instanceId: uuidSchema,
    publicationId: uuidSchema,
    releasedAttempt: { type: "integer", minimum: 1 },
    releasedStatus: { type: "string", enum: ["failed", "mismatch"] },
    releasedFailureCode: { type: "string" },
    actor: { type: "string" },
    reason: { type: "string" },
    createdAt: dateTimeSchema,
  },
} as const;

const snapshotClosureSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      description:
        "Decision 0120: the NFT sale ended with no holder (ProjectNFT.totalMinted() = 0 at the confirmed cutoff block); nothing can be published and the instance stage is closed_no_holders.",
      required: [
        "instanceId",
        "reason",
        "cutoffBlock",
        "cutoffBlockHash",
        "saleEndAt",
        "createdAt",
      ],
      properties: {
        instanceId: uuidSchema,
        reason: { type: "string", const: "no_holders" },
        cutoffBlock: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        cutoffBlockHash: hash32Schema,
        saleEndAt: dateTimeSchema,
        createdAt: dateTimeSchema,
      },
    },
    { type: "null" },
  ],
} as const;

/** Decision 0122: a config version's reviewer rejection. */
const configRejectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "reviewerUserId",
    "configHash",
    "reasonCode",
    "note",
    "rejectedAt",
  ],
  properties: {
    reviewerUserId: uuidSchema,
    configHash: hash32Schema,
    reasonCode: rejectionReasonSchema,
    note: { anyOf: [{ type: "string" }, { type: "null" }] },
    rejectedAt: dateTimeSchema,
  },
} as const;

/** Decision 0122: one catalog material rejection. */
const projectRejectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "rejectionId",
    "materialVersion",
    "reasonCode",
    "note",
    "reviewerUserId",
    "rejectedAt",
  ],
  properties: {
    rejectionId: uuidSchema,
    materialVersion: { type: "integer", minimum: 1 },
    reasonCode: rejectionReasonSchema,
    note: { anyOf: [{ type: "string" }, { type: "null" }] },
    reviewerUserId: uuidSchema,
    rejectedAt: dateTimeSchema,
  },
} as const;

export const launchProjectDetailResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "project",
    "versions",
    "testnetAcceptances",
    "deploymentTasks",
    "deploymentChainId",
    "snapshotPublications",
    "buybackAttempts",
    "snapshotReleases",
    "snapshotClosure",
  ],
  properties: {
    project: projectSummarySchema,
    versions: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "version",
          "templateVersion",
          "configHash",
          "config",
          "editedBy",
          "createdAt",
          "approval",
        ],
        properties: {
          version: { type: "integer", minimum: 1 },
          templateVersion: { type: "string" },
          configHash: hash32Schema,
          config: configSchema,
          editedBy: editorSchema,
          createdAt: dateTimeSchema,
          approval: { anyOf: [approvalSchema, { type: "null" }] },
          rejection: {
            description:
              "Decision 0122 (optional in the schema, always present): the reviewer rejection of this version; a version is approved or rejected, never both.",
            anyOf: [configRejectionSchema, { type: "null" }],
          },
        },
      },
    },
    testnetAcceptances: {
      type: "array",
      maxItems: 200,
      items: acceptanceSchema,
    },
    deploymentTasks: {
      type: "array",
      maxItems: 200,
      items: deploymentTaskSchema,
    },
    deploymentChainId: {
      type: "integer",
      enum: [56, 97],
      description:
        "Decision 0117, read-only: the chain this API deploys Hooks launches to (LAUNCH_CHAIN_ID). versions[].config.fixedEconomics.chainId is the template value (always 56) and is not the deployment chain.",
    },
    snapshotPublications: {
      type: "array",
      maxItems: 200,
      items: snapshotPublicationSchema,
    },
    buybackAttempts: {
      type: "array",
      maxItems: 20,
      description:
        "Decision 0121: the newest 20 buyback keeper attempts of the project's MEME v2 instance (simulation refusals included; the ledger stays launch2_buybacks).",
      items: buybackAttemptSchema,
    },
    snapshotReleases: {
      type: "array",
      maxItems: 200,
      items: snapshotReleaseSchema,
      description: "Decision 0120: retry grants, newest first.",
    },
    snapshotClosure: snapshotClosureSchema,
    projectRejections: {
      type: "array",
      maxItems: 200,
      description:
        "Decision 0122 (optional in the schema, always present): every catalog material rejection, newest first.",
      items: projectRejectionSchema,
    },
  },
} as const;

/** Decision 0122: `POST …/reject` (catalog material). */
export const launchProjectRejectRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["materialVersion", "reasonCode"],
  properties: {
    materialVersion: {
      type: "integer",
      minimum: 1,
      maximum: 2_147_483_647,
      description: "project.materialVersion as read (compare-and-swap).",
    },
    reasonCode: rejectionReasonSchema,
    note: {
      anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }],
      description:
        "Shown to the applicant. Required for other; 1–500 characters after trimming (blank = none).",
    },
  },
} as const;

export const launchProjectRejectResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["operationId", "replayed", "rejection", "audit"],
  properties: {
    operationId: {
      ...uuidSchema,
      description: "= the Idempotency-Key (= rejection.rejectionId).",
    },
    replayed: { type: "boolean" },
    rejection: {
      type: "object",
      additionalProperties: false,
      required: [
        "rejectionId",
        "projectId",
        "materialVersion",
        "reviewerUserId",
        "reasonCode",
        "note",
        "rejectedAt",
      ],
      properties: {
        rejectionId: uuidSchema,
        projectId: uuidSchema,
        materialVersion: { type: "integer", minimum: 1 },
        reviewerUserId: uuidSchema,
        reasonCode: rejectionReasonSchema,
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
        rejectedAt: nullableDateTimeSchema,
      },
    },
    audit: nullableAuditReferenceSchema,
  },
} as const;

/** Decision 0122: `POST …/versions/{version}/reject`. */
export const launchConfigRejectRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["configHash", "reasonCode"],
  properties: {
    configHash: hash32Schema,
    reasonCode: rejectionReasonSchema,
    note: {
      anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }],
      description:
        "Shown to the applicant. Required for other; 1–500 characters after trimming (blank = none).",
    },
  },
} as const;

export const launchConfigRejectResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["operationId", "replayed", "rejection", "audit"],
  properties: {
    operationId: {
      ...uuidSchema,
      description: "= the Idempotency-Key (ops_operations.operation_id).",
    },
    replayed: { type: "boolean" },
    rejection: {
      type: "object",
      additionalProperties: false,
      required: [
        "projectId",
        "configVersion",
        "configHash",
        "reviewerUserId",
        "reasonCode",
        "note",
        "rejectedAt",
      ],
      properties: {
        projectId: uuidSchema,
        configVersion: { type: "integer", minimum: 1 },
        configHash: hash32Schema,
        reviewerUserId: uuidSchema,
        reasonCode: rejectionReasonSchema,
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
        rejectedAt: nullableDateTimeSchema,
      },
    },
    audit: nullableAuditReferenceSchema,
  },
} as const;

export const launchSnapshotRetryRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: {
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 2000,
      description: "Operator note (1–500 characters after trimming).",
    },
  },
} as const;

export const launchSnapshotRetryResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["operationId", "replayed", "release", "audit"],
  properties: {
    operationId: {
      ...uuidSchema,
      description: "= the Idempotency-Key (= release.releaseId).",
    },
    replayed: { type: "boolean" },
    release: {
      ...snapshotReleaseSchema,
      required: [...snapshotReleaseSchema.required, "nextAttempt"],
      properties: {
        ...snapshotReleaseSchema.properties,
        nextAttempt: {
          type: "integer",
          minimum: 2,
          description:
            "The attempt number the publisher uses on its next tick (releasedAttempt + 1).",
        },
      },
    },
    audit: nullableAuditReferenceSchema,
  },
} as const;

export const launchApproveRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["configHash", "reason"],
  properties: {
    configHash: hash32Schema,
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
} as const;

export const launchApproveResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["operationId", "replayed", "approval", "audit"],
  properties: {
    operationId: {
      ...uuidSchema,
      description: "= the Idempotency-Key (ops_operations.operation_id).",
    },
    replayed: { type: "boolean" },
    approval: {
      type: "object",
      additionalProperties: false,
      required: [
        "projectId",
        "configVersion",
        "configHash",
        "approverUserId",
        "reason",
        "approvedAt",
      ],
      properties: {
        projectId: uuidSchema,
        configVersion: { type: "integer", minimum: 1 },
        configHash: hash32Schema,
        approverUserId: uuidSchema,
        reason: { type: "string" },
        approvedAt: nullableDateTimeSchema,
      },
    },
    audit: nullableAuditReferenceSchema,
  },
} as const;

/** Decision 0125: `POST …/materials/{materialVersion}/approve`. */
export const launchMaterialApproveRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: {
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 2000,
      description:
        "Internal approval note (ops_audit / launch_project_approvals); 1–500 characters after trimming. Never shown to the applicant.",
    },
  },
} as const;

export const launchMaterialApproveResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["operationId", "replayed", "approval", "audit"],
  properties: {
    operationId: {
      ...uuidSchema,
      description: "= the Idempotency-Key (= approval.approvalId).",
    },
    replayed: { type: "boolean" },
    approval: {
      type: "object",
      additionalProperties: false,
      required: [
        "approvalId",
        "projectId",
        "materialVersion",
        "approverUserId",
        "reason",
        "launchId",
        "approvedAt",
      ],
      properties: {
        approvalId: uuidSchema,
        projectId: uuidSchema,
        materialVersion: { type: "integer", minimum: 1 },
        approverUserId: uuidSchema,
        reason: { type: "string" },
        launchId: {
          description:
            "The catalog launches row the approval created (or found).",
          anyOf: [uuidSchema, { type: "null" }],
        },
        approvedAt: nullableDateTimeSchema,
      },
    },
    audit: nullableAuditReferenceSchema,
  },
} as const;

export const launchAcceptanceRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "configVersion",
    "configHash",
    "contractManifestHash",
    "checklistVersion",
    "outcome",
    "evidence",
    "reason",
  ],
  properties: {
    configVersion: { type: "integer", minimum: 1, maximum: 2147483647 },
    configHash: hash32Schema,
    contractManifestHash: hash32Schema,
    checklistVersion: {
      type: "string",
      pattern: "^hooks-testnet-v[1-9][0-9]*$",
    },
    outcome: { type: "string", enum: ["passed", "failed", "incomplete"] },
    evidence: evidenceSchema,
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
} as const;

export const launchAcceptanceResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["operationId", "replayed", "acceptance", "audit"],
  properties: {
    operationId: uuidSchema,
    replayed: { type: "boolean" },
    acceptance: {
      ...acceptanceSchema,
      required: [...acceptanceSchema.required, "projectId"],
      properties: {
        ...acceptanceSchema.properties,
        projectId: uuidSchema,
        createdAt: nullableDateTimeSchema,
      },
    },
    audit: nullableAuditReferenceSchema,
  },
} as const;
