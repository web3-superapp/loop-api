import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { adminSessionCookieName } from "../../features/admin/admin-contract.js";
import {
  adminAccountProjectScopeMaximum,
  adminOperatorLabelMaximumLength,
  adminPasswordMaximumLength,
  adminPasswordMinimumLength,
} from "../../features/admin/admin-accounts.js";
import { adminLaunchStages } from "../../features/admin/admin-launch-review.js";
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
      required: ["enabled", "grants"],
      properties: {
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
        "Required for reviewer / testnet_acceptor (the LOOP user that holds the ops grants); refused for other roles. One active account per LOOP user.",
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
    launchReviewStatus: {
      type: "string",
      description:
        "launch_projects.review_status (draft, submitted, in_review, returned, approved, rejected). Hooks review commands need `approved`.",
    },
    stage: {
      type: "string",
      enum: [...adminLaunchStages],
      description:
        "Of the latest config version: draft (none saved), awaiting_approval, approved, accepted (a passed BSC Testnet acceptance), deploying (an awaiting_executor task).",
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
    "createdAt",
  ],
  properties: {
    jobId: uuidSchema,
    configVersion: { type: "integer", minimum: 1 },
    status: { type: "string", enum: ["awaiting_executor", "cancelled"] },
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
    createdAt: dateTimeSchema,
  },
} as const;

export const launchProjectDetailResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["project", "versions", "testnetAcceptances", "deploymentTasks"],
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
