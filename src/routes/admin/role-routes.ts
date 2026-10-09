import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  adminApiPrefix,
  adminSessionCookieName,
  adminSessionTtlSeconds,
} from "../../features/admin/admin-contract.js";
import { sessionCookieHeader } from "../../features/admin/admin-auth.js";
import {
  adminPrincipalFromAccount,
  type AdminAccountService,
  type AdminPrincipal,
  type AdminRequestContext,
} from "../../features/admin/admin-accounts.js";
import type { AdminLaunchReviewConsoleService } from "../../features/admin/admin-launch-review.js";
import type { AdminPermission } from "../../features/admin/admin-roles.js";
import type { AdminService } from "../../features/admin/admin-service.js";
import {
  accountCreateRequestSchema,
  accountDisableRequestSchema,
  accountIdParamsSchema,
  accountListResourceSchema,
  accountResetPasswordRequestSchema,
  accountUnlockRequestSchema,
  accountWriteResourceSchema,
  idempotencyHeadersSchema,
  launchAcceptanceRequestSchema,
  launchAcceptanceResourceSchema,
  launchApproveRequestSchema,
  launchApproveResourceSchema,
  launchProjectDetailResourceSchema,
  launchProjectListResourceSchema,
  launchProjectParamsSchema,
  launchProjectsQuerySchema,
  launchVersionParamsSchema,
  passwordChangeRequestSchema,
  principalResourceSchema,
} from "./admin-role-schemas.js";
import { adminErrors, adminSecurity, sessionErrors } from "./admin-schemas.js";
import type { AdminRouteGuard } from "./index.js";

/**
 * Decision 0109 routes: the holder's password change, console accounts
 * (platform administrator), and the Hooks launch review (reviewer /
 * testnet acceptor; read by every role with `launch.read`).
 */

export interface AdminRoleRouteDependencies {
  readonly service: AdminService;
  readonly accounts: AdminAccountService;
  readonly launchReview: AdminLaunchReviewConsoleService;
  readonly cookieSecure: boolean;
  readonly sessionOnly: AdminRouteGuard;
  readonly guard: (permission: AdminPermission) => AdminRouteGuard;
  readonly principalOf: (request: FastifyRequest) => AdminPrincipal;
  readonly requestContext: (request: FastifyRequest) => AdminRequestContext;
}

const emptyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

/** Errors of a role-guarded route. */
const guardedErrors = [
  ...sessionErrors,
  "PERMISSION_DENIED",
  "CAPABILITY_UNAVAILABLE",
] as const;

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
}

function idempotencyKey(request: FastifyRequest): unknown {
  return request.headers["idempotency-key"];
}

function body(request: FastifyRequest): Readonly<Record<string, unknown>> {
  const value = request.body;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function registerAdminRoleRoutes(
  app: FastifyInstance,
  dependencies: AdminRoleRouteDependencies,
): void {
  const { accounts, launchReview, requestContext, sessionOnly, guard } =
    dependencies;

  app.post(
    `${adminApiPrefix}/session/password`,
    {
      schema: {
        operationId: "changeAdminSessionPassword",
        summary: "Change my own password",
        description:
          "Decision 0109. Console accounts only (the ADMIN_USERNAME bootstrap administrator is 409 ADMIN_CONFLICT / ADMIN_ACCOUNT_ENVIRONMENT). Verifies `currentPassword` (wrong: 401 ADMIN_LOGIN_INVALID), stores the new argon2id hash, clears `passwordChangeRequired`, bumps the credentials version (every other session of the account ends), and sets a fresh session cookie. A concurrent reset by an administrator wins (409 ADMIN_CONFLICT). The only write allowed while `passwordChangeRequired`.",
        tags: ["admin-session"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        body: passwordChangeRequestSchema,
        response: {
          200: principalResourceSchema,
          ...adminErrors(
            ...sessionErrors,
            "ADMIN_LOGIN_INVALID",
            "ADMIN_LOGIN_BUSY",
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...sessionOnly,
    },
    async (request, reply) => {
      const context = requestContext(request);
      const account = await accounts.changeOwnPassword(context, body(request));
      const issued = dependencies.service.reissueSession(
        context.principal.session,
        account,
      );
      noStore(reply);
      reply.header(
        "set-cookie",
        sessionCookieHeader({
          name: adminSessionCookieName,
          value: issued.token,
          maxAgeSeconds: adminSessionTtlSeconds,
          secure: dependencies.cookieSecure,
        }),
      );
      const principal = adminPrincipalFromAccount(issued.session, account);
      return reply.code(200).send({
        actor: principal.session.actor,
        accountId: principal.session.accountId,
        role: principal.role,
        permissions: principal.permissions,
        passwordChangeRequired: principal.passwordChangeRequired,
        operatorUserId: principal.operatorUserId,
        issuedAt: principal.session.issuedAt,
        expiresAt: principal.session.expiresAt,
      });
    },
  );

  app.get(
    `${adminApiPrefix}/accounts`,
    {
      schema: {
        operationId: "listAdminAccounts",
        summary: "List console accounts",
        description:
          "Decision 0109 (`accounts.read`: platform_admin, auditor). Newest first, at most 500, with each bound operator's live ops grants. Never a password hash. `bootstrap` names the ADMIN_USERNAME administrator (environment).",
        tags: ["admin-accounts"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: accountListResourceSchema,
          ...adminErrors(...guardedErrors),
        },
      },
      ...guard("accounts.read"),
    },
    async (request, reply) => {
      const resource = await accounts.list(requestContext(request));
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.post(
    `${adminApiPrefix}/accounts`,
    {
      schema: {
        operationId: "createAdminAccount",
        summary: "Create a console account",
        description:
          "Decision 0109 (`accounts.manage`: platform_admin). The role is fixed for the account's life. reviewer / testnet_acceptor need `operatorUserId` (a LOOP user; 422 ADMIN_ACCOUNT_OPERATOR_USER_NOT_FOUND) and, in the same transaction, get that user's ops_operators row enabled and its ops_grants replaced by the role's (reviewer: launch.read, launch.approve, audit.read; testnet_acceptor: launch.read, testnet.read, testnet.accept, audit.read; optionally scoped to `projectIds`), with an ops_audit row. One active account per LOOP user (409 ADMIN_ACCOUNT_OPERATOR_ALREADY_BOUND). Username taken (any case, or the bootstrap name) → 409 ADMIN_ACCOUNT_USERNAME_TAKEN. The holder must change the password at first login. 201 on create; an exact Idempotency-Key replay is 200 with `replayed: true`.",
        tags: ["admin-accounts"],
        security: adminSecurity,
        headers: idempotencyHeadersSchema,
        querystring: emptyQuerySchema,
        body: accountCreateRequestSchema,
        response: {
          200: accountWriteResourceSchema,
          201: accountWriteResourceSchema,
          ...adminErrors(
            ...guardedErrors,
            "ADMIN_CONFLICT",
            "ADMIN_LOGIN_BUSY",
            "VALIDATION_FAILED",
          ),
        },
      },
      ...guard("accounts.manage"),
    },
    async (request, reply) => {
      const result = await accounts.create(
        requestContext(request),
        idempotencyKey(request),
        body(request),
      );
      noStore(reply);
      return reply.code(result.status).send(result.body);
    },
  );

  app.post(
    `${adminApiPrefix}/accounts/:accountId/disable`,
    {
      schema: {
        operationId: "disableAdminAccount",
        summary: "Disable a console account (terminal)",
        description:
          "Decision 0109 (`accounts.manage`). Ends every session of the account at once and, for a bound account, sets the LOOP user's ops_operators.enabled=false in the same transaction (ops_audit `operator.revoke`; the admin audit row carries `operatorEnabledBefore` / `operatorEnabled`), which stops both the Hooks launch review and (Decision 0111) mining formula approval. Disabled is terminal (create a new account instead). Already disabled → 200 `changed: false`. Your own account → 409 ADMIN_ACCOUNT_SELF.",
        tags: ["admin-accounts"],
        security: adminSecurity,
        headers: idempotencyHeadersSchema,
        params: accountIdParamsSchema,
        querystring: emptyQuerySchema,
        body: accountDisableRequestSchema,
        response: {
          200: accountWriteResourceSchema,
          ...adminErrors(
            ...guardedErrors,
            "NOT_FOUND",
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
          ),
        },
      },
      ...guard("accounts.manage"),
    },
    async (request, reply) => {
      const { accountId } = request.params as { readonly accountId: string };
      const resource = await accounts.disable(
        requestContext(request),
        idempotencyKey(request),
        accountId,
        body(request),
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.post(
    `${adminApiPrefix}/accounts/:accountId/reset-password`,
    {
      schema: {
        operationId: "resetAdminAccountPassword",
        summary: "Set a new initial password for an account",
        description:
          "Decision 0109 (`accounts.manage`). Ends every session of the account and sets `passwordChangeRequired` (the holder must choose their own password before doing anything). Disabled account → 409 ADMIN_ACCOUNT_DISABLED; your own account → 409 ADMIN_ACCOUNT_SELF (use POST /session/password).",
        tags: ["admin-accounts"],
        security: adminSecurity,
        headers: idempotencyHeadersSchema,
        params: accountIdParamsSchema,
        querystring: emptyQuerySchema,
        body: accountResetPasswordRequestSchema,
        response: {
          200: accountWriteResourceSchema,
          ...adminErrors(
            ...guardedErrors,
            "NOT_FOUND",
            "ADMIN_CONFLICT",
            "ADMIN_LOGIN_BUSY",
            "VALIDATION_FAILED",
          ),
        },
      },
      ...guard("accounts.manage"),
    },
    async (request, reply) => {
      const { accountId } = request.params as { readonly accountId: string };
      const resource = await accounts.resetPassword(
        requestContext(request),
        idempotencyKey(request),
        accountId,
        body(request),
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.post(
    `${adminApiPrefix}/accounts/:accountId/unlock`,
    {
      schema: {
        operationId: "unlockAdminAccount",
        summary: "Lift an account's login-name lock early",
        description:
          "Decision 0111 (`accounts.manage`: platform_admin). Deletes the account's login-name bucket (Decision 0110 `admin_login_attempts`, scope username): the lock and the failure count. Address (IP) buckets are never cleared here. Writes `account.unlock` to admin_audit_log (before: failureCount, lockedUntil) and an admin_account_commands row in one transaction. No bucket → 200 `changed: false`, `audit: null`. An exact Idempotency-Key replay → 200 `replayed: true`, `audit: null`. The ADMIN_USERNAME bootstrap administrator (path `bootstrap` or its name) → 409 ADMIN_ACCOUNT_ENVIRONMENT; a disabled account → 409 ADMIN_ACCOUNT_DISABLED.",
        tags: ["admin-accounts"],
        security: adminSecurity,
        headers: idempotencyHeadersSchema,
        params: accountIdParamsSchema,
        querystring: emptyQuerySchema,
        body: accountUnlockRequestSchema,
        response: {
          200: accountWriteResourceSchema,
          ...adminErrors(
            ...guardedErrors,
            "NOT_FOUND",
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
          ),
        },
      },
      ...guard("accounts.manage"),
    },
    async (request, reply) => {
      const { accountId } = request.params as { readonly accountId: string };
      const resource = await accounts.unlock(
        requestContext(request),
        idempotencyKey(request),
        accountId,
        body(request),
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.get(
    `${adminApiPrefix}/launch/projects`,
    {
      schema: {
        operationId: "listAdminLaunchProjects",
        summary: "List Hooks launch projects by review stage",
        description:
          "Decision 0109 (`launch.read`). Newest first. `status` filters by the stage of the latest config version: draft, awaiting_approval, approved, accepted, deploying. A reviewer / testnet acceptor sees only the projects their ops grants cover (`scope: projects`); a disabled operator or one without launch.read is 403 PERMISSION_DENIED (OPS_FORBIDDEN).",
        tags: ["admin-launch"],
        security: adminSecurity,
        querystring: launchProjectsQuerySchema,
        response: {
          200: launchProjectListResourceSchema,
          ...adminErrors(...guardedErrors),
        },
      },
      ...guard("launch.read"),
    },
    async (request, reply) => {
      const resource = await launchReview.listProjects(
        requestContext(request),
        request.query as Record<string, unknown>,
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.get(
    `${adminApiPrefix}/launch/projects/:projectId`,
    {
      schema: {
        operationId: "getAdminLaunchProject",
        summary: "Read one Hooks launch project for review",
        description:
          "Decision 0109 (`launch.read`). Every config version (fields, configHash, editor, approval), BSC Testnet acceptances, and deployment tasks with the EIP-712-bound predicted MEME / Hook addresses. Signatures and signed payloads are never returned. Outside the caller's scope → 404.",
        tags: ["admin-launch"],
        security: adminSecurity,
        params: launchProjectParamsSchema,
        querystring: emptyQuerySchema,
        response: {
          200: launchProjectDetailResourceSchema,
          ...adminErrors(...guardedErrors, "NOT_FOUND"),
        },
      },
      ...guard("launch.read"),
    },
    async (request, reply) => {
      const { projectId } = request.params as { readonly projectId: string };
      const resource = await launchReview.getProject(
        requestContext(request),
        projectId,
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.post(
    `${adminApiPrefix}/launch/projects/:projectId/versions/:version/approve`,
    {
      schema: {
        operationId: "approveAdminLaunchConfigVersion",
        summary: "Approve a Hooks launch config version (reviewer)",
        description:
          "Decision 0109 (`launch.approve`: reviewer only — the platform administrator cannot approve). Runs the Decision 0108 `launch.config.approve` command as the account's bound LOOP user with operationId = Idempotency-Key. The service refuses the version's editor and the project owner (403 PERMISSION_DENIED / OPS_SELF_APPROVAL), an operator without a matching grant (OPS_FORBIDDEN), a stale version or hash (409 OPS_VERSION_CONFLICT), a project whose launch review is not approved (409 OPS_LAUNCH_NOT_APPROVED), and a reused key with another body (409 OPS_IDEMPOTENCY_CONFLICT). Audit: `launch.config.approve.requested` before (when it cannot be written: 503 ADMIN_AUDIT_UNAVAILABLE, nothing runs), then `.decided` or `.failed`; the service writes ops_audit.",
        tags: ["admin-launch"],
        security: adminSecurity,
        headers: idempotencyHeadersSchema,
        params: launchVersionParamsSchema,
        querystring: emptyQuerySchema,
        body: launchApproveRequestSchema,
        response: {
          200: launchApproveResourceSchema,
          ...adminErrors(
            ...guardedErrors,
            "NOT_FOUND",
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
          ),
        },
      },
      ...guard("launch.approve"),
    },
    async (request, reply) => {
      const { projectId, version } = request.params as {
        readonly projectId: string;
        readonly version: string;
      };
      const resource = await launchReview.approve(
        requestContext(request),
        idempotencyKey(request),
        projectId,
        version,
        body(request),
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.post(
    `${adminApiPrefix}/launch/projects/:projectId/testnet-acceptance`,
    {
      schema: {
        operationId: "recordAdminLaunchTestnetAcceptance",
        summary: "Record a BSC Testnet acceptance (testnet acceptor)",
        description:
          "Decision 0109 (`testnet.accept`: testnet_acceptor only). Runs the Decision 0108 `testnet.acceptance.record` command as the bound LOOP user (acceptanceId = Idempotency-Key, chain 97). Needs an approved version with that hash (409 OPS_LAUNCH_CONFIG_NOT_APPROVED); the version's editor and the project owner are refused (403 OPS_SELF_ACCEPTANCE). Same audit pattern as approve (`testnet.acceptance.record.requested` / `.decided` / `.failed`).",
        tags: ["admin-launch"],
        security: adminSecurity,
        headers: idempotencyHeadersSchema,
        params: launchProjectParamsSchema,
        querystring: emptyQuerySchema,
        body: launchAcceptanceRequestSchema,
        response: {
          200: launchAcceptanceResourceSchema,
          ...adminErrors(
            ...guardedErrors,
            "NOT_FOUND",
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
          ),
        },
      },
      ...guard("testnet.accept"),
    },
    async (request, reply) => {
      const { projectId } = request.params as { readonly projectId: string };
      const resource = await launchReview.recordTestnetAcceptance(
        requestContext(request),
        idempotencyKey(request),
        projectId,
        body(request),
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );
}
