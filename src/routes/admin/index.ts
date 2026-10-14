import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

import {
  AdminApiError,
  adminApiPrefix,
  adminSessionCookieName,
  adminSessionTtlSeconds,
} from "../../features/admin/admin-contract.js";
import {
  readCookie,
  sessionCookieHeader,
} from "../../features/admin/admin-auth.js";
import {
  assertAdminPermission,
  type AdminAccountService,
  type AdminPrincipal,
  type AdminRequestContext,
} from "../../features/admin/admin-accounts.js";
import type { AdminLaunchReviewConsoleService } from "../../features/admin/admin-launch-review.js";
import type { AdminPermission } from "../../features/admin/admin-roles.js";
import {
  principalReadResourceSchema,
  principalResourceSchema,
} from "./admin-role-schemas.js";
import { registerAdminRoleRoutes } from "./role-routes.js";
import { registerAdminMiningSettlementRoutes } from "./mining-settlement-routes.js";
import { registerAdminChainGuardRoutes } from "./chain-guard-routes.js";
import {
  createAdminChainGuardService,
  type AdminChainGuardService,
} from "../../features/admin/admin-chain-guard.js";
import type { AdminMiningSettlementService } from "../../features/admin/admin-mining-settlement.js";
import type {
  AdminService,
  AdminWriteContext,
} from "../../features/admin/admin-service.js";
import {
  adminErrors,
  adminSecurity,
  auditListResourceSchema,
  auditQuerySchema,
  communitiesQuerySchema,
  communityDetailResourceSchema,
  communityIdParamsSchema,
  communityListResourceSchema,
  communityReviewRequestSchema,
  communityReviewResourceSchema,
  configVersionParamsSchema,
  formulaApproveResourceSchema,
  formulaDraftRequestSchema,
  formulaDraftResourceSchema,
  formulaVersionListResourceSchema,
  formulaWithdrawResourceSchema,
  intelPromotionsAdminResourceSchema,
  intelPromotionsAdminWriteResourceSchema,
  intelPromotionsRequestSchema,
  memeListingRequestSchema,
  memeListingResourceSchema,
  memePauseRequestSchema,
  memePauseResourceSchema,
  memeTokenIdParamsSchema,
  memeTokenListResourceSchema,
  memeTokensQuerySchema,
  noContentSchema,
  overviewResourceSchema,
  recommendedCommunitiesRequestSchema,
  recommendedCommunitiesResourceSchema,
  recommendedCommunitiesWriteResourceSchema,
  guardedSessionErrors,
  sessionErrors,
  sessionRequestSchema,
} from "./admin-schemas.js";

/**
 * Operator console routes (Decision 0102), all under `/admin/v1`. Mounted
 * only when ADMIN_USERNAME, ADMIN_PASSWORD_HASH, and ADMIN_SESSION_SECRET
 * are all configured. Every route except `POST /session` needs the signed
 * session cookie; there is no `X-Loop-Contract-Version` and no Privy
 * Bearer on this surface.
 */

export interface AdminRouteDependencies {
  readonly service: AdminService;
  /** Decision 0109: console accounts. */
  readonly accounts: AdminAccountService;
  /** Decision 0109: Hooks launch review. */
  readonly launchReview: AdminLaunchReviewConsoleService;
  readonly cookieSecure: boolean;
  /** Decision 0116: hourly settlement console. */
  readonly miningSettlement: AdminMiningSettlementService;
  /** Decision 0134: chain guard incidents; absent = 503 CAPABILITY_UNAVAILABLE. */
  readonly chainGuard?: AdminChainGuardService;
}

/** Decision 0109: `onRequest` hooks of a protected route. */
export interface AdminRouteGuard {
  onRequest: onRequestHookHandler[];
}

/** Decision 0109: the session resource (login, GET, password change). */
export function principalResource(principal: AdminPrincipal) {
  return Object.freeze({
    actor: principal.session.actor,
    accountId: principal.session.accountId,
    role: principal.role,
    permissions: principal.permissions,
    passwordChangeRequired: principal.passwordChangeRequired,
    operatorUserId: principal.operatorUserId,
    issuedAt: principal.session.issuedAt,
    expiresAt: principal.session.expiresAt,
  });
}

const emptyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
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

export function registerAdminRoutes(
  app: FastifyInstance,
  dependencies: AdminRouteDependencies,
): void {
  const { service } = dependencies;
  const principals = new WeakMap<FastifyRequest, AdminPrincipal>();

  async function requireSession(request: FastifyRequest): Promise<void> {
    const principal = await service.resolvePrincipal(
      readCookie(request.headers.cookie, adminSessionCookieName),
    );
    if (principal === null) {
      throw new AdminApiError("ADMIN_SESSION_REQUIRED");
    }
    principals.set(request, principal);
  }

  function principalOf(request: FastifyRequest): AdminPrincipal {
    const principal = principals.get(request);
    if (principal === undefined) {
      throw new AdminApiError("ADMIN_SESSION_REQUIRED");
    }
    return principal;
  }

  function context(request: FastifyRequest): AdminWriteContext {
    return { session: principalOf(request).session, requestId: request.id };
  }

  function requestContext(request: FastifyRequest): AdminRequestContext {
    return { principal: principalOf(request), requestId: request.id };
  }

  function clearCookie(reply: FastifyReply): void {
    reply.header(
      "set-cookie",
      sessionCookieHeader({
        name: adminSessionCookieName,
        value: "",
        maxAgeSeconds: 0,
        secure: dependencies.cookieSecure,
      }),
    );
  }

  // `onRequest`: an unauthenticated caller is refused before its body is
  // parsed or validated, so it always sees 401, never a validation detail.
  // Decision 0109: the role check runs there too (403 before any body
  // detail); every service re-checks what it executes.
  const sessionOnly: AdminRouteGuard = {
    onRequest: [requireSession],
  };
  function guard(permission: AdminPermission): AdminRouteGuard {
    return {
      onRequest: [
        requireSession,
        (request: FastifyRequest): Promise<void> => {
          assertAdminPermission(principalOf(request), permission);
          return Promise.resolve();
        },
      ],
    };
  }
  /**
   * Decision 0110: a read route open to more than one permission (the
   * formula list: `console.read`, or `formula.approve` for the reviewer who
   * has to see the draft). A refusal names the first permission.
   */
  function guardAny(
    permissions: readonly [AdminPermission, ...AdminPermission[]],
  ): AdminRouteGuard {
    return {
      onRequest: [
        requireSession,
        (request: FastifyRequest): Promise<void> => {
          const principal = principalOf(request);
          const held = permissions.find((permission) =>
            principal.permissions.includes(permission),
          );
          assertAdminPermission(principal, held ?? permissions[0]);
          return Promise.resolve();
        },
      ],
    };
  }

  app.post(
    `${adminApiPrefix}/session`,
    {
      schema: {
        operationId: "createAdminSession",
        summary: "Log in as the operator",
        description:
          "Decision 0109: a console account (admin_accounts) is tried first, then the ADMIN_USERNAME bootstrap administrator; a disabled account is ADMIN_LOGIN_INVALID. The response carries the role and its permissions. Username + password (argon2id). Success sets the signed session cookie (HttpOnly, SameSite=Strict, Path=/admin, 12 hours). Decision 0110: failures lock per login name (case-insensitive; ADMIN_LOGIN_USERNAME_MAX_FAILURES in a row, default 5, lock ADMIN_LOGIN_USERNAME_LOCK_SECONDS, default 900) and per client address (ADMIN_LOGIN_IP_MAX_FAILURES within ADMIN_LOGIN_IP_WINDOW_SECONDS, default 50 in 900, lock ADMIN_LOGIN_IP_LOCK_SECONDS, default 900): 423 ADMIN_LOGIN_LOCKED with `detailsSafe.scope` (`username` | `ip`), `detailsSafe.retryAfterSeconds`, and `Retry-After`. One name's failures never lock another name. A success clears its name's count. The counters live in PostgreSQL (`admin_login_attempts`), shared by every instance and kept across restarts. Only one login is verified at a time per instance; a concurrent one is 429 ADMIN_LOGIN_BUSY (not counted, `Retry-After: 1`). Counters unavailable → 503 ADMIN_DATABASE_UNAVAILABLE (no password is verified).",
        tags: ["admin-session"],
        querystring: emptyQuerySchema,
        body: sessionRequestSchema,
        response: {
          200: principalResourceSchema,
          ...adminErrors(
            "ADMIN_LOGIN_INVALID",
            "ADMIN_LOGIN_LOCKED",
            "ADMIN_LOGIN_BUSY",
            "INVALID_REQUEST",
            "REQUEST_TIMEOUT",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        readonly username: string;
        readonly password: string;
      };
      const issued = await service.login({
        username: body.username,
        password: body.password,
        requestId: request.id,
        sourceIp: request.ip,
      });
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
      return reply.code(200).send(principalResource(issued.principal));
    },
  );

  app.get(
    `${adminApiPrefix}/session`,
    {
      schema: {
        operationId: "getAdminSession",
        summary: "Read the current operator session",
        description:
          "200 with the session principal (role, permissions, passwordChangeRequired), or 401 ADMIN_SESSION_REQUIRED. Decision 0109: an account session ends at once when the account is disabled or its password is changed or reset.",
        tags: ["admin-session"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: principalReadResourceSchema,
          ...adminErrors(...sessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...sessionOnly,
    },
    async (request, reply) => {
      noStore(reply);
      return reply.code(200).send(principalResource(principalOf(request)));
    },
  );

  app.delete(
    `${adminApiPrefix}/session`,
    {
      schema: {
        operationId: "deleteAdminSession",
        summary: "Log out",
        description:
          "Revokes the session (when the cookie is valid) and clears the cookie. Always 204, so a stale cookie can be cleared too.",
        tags: ["admin-session"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        response: {
          204: noContentSchema,
          ...adminErrors("INVALID_REQUEST", "REQUEST_TIMEOUT"),
        },
      },
      preValidation: assertEmptyBody,
    },
    async (request, reply) => {
      const session = service.sessionCodec.verify(
        readCookie(request.headers.cookie, adminSessionCookieName),
      );
      if (session !== null) {
        await service.logout({ session, requestId: request.id });
      }
      noStore(reply);
      clearCookie(reply);
      return reply.code(204).send();
    },
  );

  app.get(
    `${adminApiPrefix}/overview`,
    {
      schema: {
        operationId: "getAdminOverview",
        summary: "Console landing figures",
        description:
          "Accounts, communities by status, pending reviews, live voice rooms, MEME tokens by status (and hidden), indexer lane progress, and the latest 20 audit rows.",
        tags: ["admin-overview"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: overviewResourceSchema,
          ...adminErrors(...guardedSessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...guard("console.read"),
    },
    async (_request, reply) => {
      const resource = await service.overview();
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.get(
    `${adminApiPrefix}/settings/recommended-communities`,
    {
      schema: {
        operationId: "getAdminRecommendedCommunities",
        summary: "Read the onboarding recommended communities",
        description:
          "The list in force: the console list (`source: database`) or RECOMMENDED_COMMUNITY_IDS (`source: environment`). `updatedAt` is the concurrency token for PUT (null when no console list exists).",
        tags: ["admin-settings"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: recommendedCommunitiesResourceSchema,
          ...adminErrors(...guardedSessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...guard("console.read"),
    },
    async (_request, reply) => {
      const resource = await service.getRecommendedCommunities();
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.put(
    `${adminApiPrefix}/settings/recommended-communities`,
    {
      schema: {
        operationId: "putAdminRecommendedCommunities",
        summary: "Replace the onboarding recommended communities",
        description:
          "Ordered list of verified community IDs (max 50; the first five are pre-selected in the App). Every ID must exist and be verified (422). `updatedAt` mismatch → 409 ADMIN_CONFLICT. `communityIds: null` deletes the console list. The App reads it within 60 seconds.",
        tags: ["admin-settings"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        body: recommendedCommunitiesRequestSchema,
        response: {
          200: recommendedCommunitiesWriteResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guard("console.write"),
    },
    async (request, reply) => {
      const body = request.body as {
        readonly communityIds: unknown;
        readonly updatedAt: unknown;
      };
      const resource = await service.putRecommendedCommunities(
        context(request),
        body,
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.get(
    `${adminApiPrefix}/settings/intel-promotions`,
    {
      schema: {
        operationId: "getAdminIntelPromotions",
        summary: "Read the intel page promotion cards",
        description:
          "Every card of the list in force (including ones outside their window), its source, configVersion, and the deeplink choices for the editor.",
        tags: ["admin-settings"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: intelPromotionsAdminResourceSchema,
          ...adminErrors(...guardedSessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...guard("console.read"),
    },
    async (_request, reply) => {
      const resource = await service.getIntelPromotions();
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.put(
    `${adminApiPrefix}/settings/intel-promotions`,
    {
      schema: {
        operationId: "putAdminIntelPromotions",
        summary: "Replace the intel page promotion cards",
        description:
          "Whole-list replacement validated like the shipped list (Decision 0100: title ≤ 40, subtitle ≤ 80, https image or null, in-app deeplink allow-list, endsAt > startsAt, order ≥ 0, ≤ 20 cards). A refused card is 422 ADMIN_PROMOTION_INVALID with `detailsSafe.index`. `items: null` restores the shipped list.",
        tags: ["admin-settings"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        body: intelPromotionsRequestSchema,
        response: {
          200: intelPromotionsAdminWriteResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guard("console.write"),
    },
    async (request, reply) => {
      const body = request.body as {
        readonly items: unknown;
        readonly updatedAt: unknown;
      };
      const resource = await service.putIntelPromotions(context(request), body);
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.get(
    `${adminApiPrefix}/communities`,
    {
      schema: {
        operationId: "listAdminCommunities",
        summary: "List communities for review",
        description:
          "Newest first. `status` filters by verification status; `q` matches name/slug (substring) or the exact community ID.",
        tags: ["admin-communities"],
        security: adminSecurity,
        querystring: communitiesQuerySchema,
        response: {
          200: communityListResourceSchema,
          ...adminErrors(...guardedSessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...guard("console.read"),
    },
    async (request, reply) => {
      const resource = await service.listCommunities(
        request.query as Record<string, unknown>,
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.get(
    `${adminApiPrefix}/communities/:communityId`,
    {
      schema: {
        operationId: "getAdminCommunity",
        summary: "Read one community with its review notes",
        tags: ["admin-communities"],
        security: adminSecurity,
        params: communityIdParamsSchema,
        querystring: emptyQuerySchema,
        response: {
          200: communityDetailResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "NOT_FOUND",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guard("console.read"),
    },
    async (request, reply) => {
      const { communityId } = request.params as {
        readonly communityId: string;
      };
      const resource = await service.getCommunity(communityId);
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.post(
    `${adminApiPrefix}/communities/:communityId/review`,
    {
      schema: {
        operationId: "reviewAdminCommunity",
        summary: "Verify or reject a community application",
        description:
          "Runs the existing review path (Decision 0073: status, community audit row, owner notification and push) and records a review note plus console audit rows: `community.review.requested` before the review runs (when it cannot be written: 503 ADMIN_AUDIT_UNAVAILABLE, nothing changes), then `community.review.decided` (with the note) or `community.review.failed` (Decision 0105). `reject` needs `reasonText` (the applicant reads it). Rejecting a verified community is 409 ADMIN_CONFLICT (ADMIN_COMMUNITY_ALREADY_VERIFIED). Repeating the current decision is 200 with `changed: false`.",
        tags: ["admin-communities"],
        security: adminSecurity,
        params: communityIdParamsSchema,
        querystring: emptyQuerySchema,
        body: communityReviewRequestSchema,
        response: {
          200: communityReviewResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "NOT_FOUND",
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guard("console.write"),
    },
    async (request, reply) => {
      const { communityId } = request.params as {
        readonly communityId: string;
      };
      const body = request.body as {
        readonly decision: unknown;
        readonly reasonCode: unknown;
        readonly reasonText?: unknown;
      };
      const resource = await service.reviewCommunity(
        context(request),
        communityId,
        body,
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.get(
    `${adminApiPrefix}/mining/formula-versions`,
    {
      schema: {
        operationId: "listAdminFormulaVersions",
        summary: "List mining formula versions",
        description:
          "Newest 50 versions (Decision 0046 table) with their editable parameters. `approval.available: false` (reasonCode MINING_APPROVE_FORBIDDEN_IN_PRODUCTION) greys the approve button. Decision 0110: readable with `console.read` (platform_admin, auditor) or `formula.approve` (reviewer). `draftAuthor` names who saved a draft (null = unknown author: the draft cannot be approved and must be saved again); `approvedBy` names the approving reviewer.",
        tags: ["admin-mining"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: formulaVersionListResourceSchema,
          ...adminErrors(...guardedSessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...guardAny(["console.read", "formula.approve"]),
    },
    async (_request, reply) => {
      const resource = await service.listFormulaVersions();
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.post(
    `${adminApiPrefix}/mining/formula-versions`,
    {
      schema: {
        operationId: "createAdminFormulaDraft",
        summary: "Create a draft mining formula version",
        description:
          "Copies `baseVersion` and applies the editable parameters; the draft is `pending_approval` and changes no number until approved. An existing configVersion is 409 ADMIN_CONFLICT (ADMIN_FORMULA_VERSION_EXISTS). Decision 0110: the caller is stored as the draft's `draftAuthor`; saving a draft is submitting it for a reviewer's approval.",
        tags: ["admin-mining"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        body: formulaDraftRequestSchema,
        response: {
          201: formulaDraftResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guard("console.write"),
    },
    async (request, reply) => {
      const body = request.body as {
        readonly configVersion: unknown;
        readonly baseVersion: unknown;
        readonly parameters?: unknown;
      };
      const resource = await service.createFormulaDraft(context(request), body);
      noStore(reply);
      return reply.code(201).send(resource);
    },
  );

  app.post(
    `${adminApiPrefix}/mining/formula-versions/:configVersion/approve`,
    {
      schema: {
        operationId: "approveAdminFormulaVersion",
        summary: "Approve a draft: it becomes the version in force",
        description:
          "Decision 0110: needs `formula.approve` (reviewer only; platform_admin and the bootstrap administrator are 403 ADMIN_ROLE_FORBIDDEN). The approver must not be the draft's author (403 PERMISSION_DENIED, reasonCode ADMIN_FORMULA_SELF_APPROVAL); a draft without a recorded author is 409 ADMIN_CONFLICT (ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN; save it again as a new draft). Decision 0111: the reviewer's bound ops operator must be enabled (revoked or account disabled meanwhile: 403 PERMISSION_DENIED, reasonCode ADMIN_OPERATOR_DISABLED / ADMIN_ACCOUNT_DISABLED). Audit: `mining.formula.approve.requested` first (cannot be written: 503 ADMIN_AUDIT_UNAVAILABLE, nothing approved), then `mining.formula.approve` in the approving transaction or `mining.formula.approve.failed`. Same semantics as the break-glass `pnpm mining:approve-formula` (Decisions 0046, 0111; it records `cli:<name>`, which `approvedBy` shows as null): only `pending_approval` can be approved; the approved version is retired; effectiveAt = now; the draft's community weights are applied in the same transaction. The snapshot lane computes under it from its next run. Refused under NODE_ENV=production (503 MINING_APPROVE_FORBIDDEN_IN_PRODUCTION).",
        tags: ["admin-mining"],
        security: adminSecurity,
        params: configVersionParamsSchema,
        querystring: emptyQuerySchema,
        response: {
          200: formulaApproveResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "NOT_FOUND",
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      preValidation: assertEmptyBody,
      ...guard("formula.approve"),
    },
    async (request, reply) => {
      const { configVersion } = request.params as {
        readonly configVersion: string;
      };
      const resource = await service.approveFormula(
        context(request),
        configVersion,
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.post(
    `${adminApiPrefix}/mining/formula-versions/:configVersion/withdraw`,
    {
      schema: {
        operationId: "withdrawAdminFormulaVersion",
        summary: "Withdraw a draft",
        description:
          "`pending_approval → retired`. The version in force cannot be withdrawn here (409); approve another version instead.",
        tags: ["admin-mining"],
        security: adminSecurity,
        params: configVersionParamsSchema,
        querystring: emptyQuerySchema,
        response: {
          200: formulaWithdrawResourceSchema,
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
      const { configVersion } = request.params as {
        readonly configVersion: string;
      };
      const resource = await service.withdrawFormula(
        context(request),
        configVersion,
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.get(
    `${adminApiPrefix}/meme/tokens`,
    {
      schema: {
        operationId: "listAdminMemeTokens",
        summary: "List MEME tokens (every status and listing)",
        description:
          "Newest first; `q` matches name/symbol (substring), the exact memeTokenId, or the token address. `pause` says whether pause/unpause can sign.",
        tags: ["admin-meme"],
        security: adminSecurity,
        querystring: memeTokensQuerySchema,
        response: {
          200: memeTokenListResourceSchema,
          ...adminErrors(...guardedSessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...guard("console.read"),
    },
    async (request, reply) => {
      const resource = await service.listMemeTokens(
        request.query as Record<string, unknown>,
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  app.post(
    `${adminApiPrefix}/meme/tokens/:memeTokenId/listing`,
    {
      schema: {
        operationId: "setAdminMemeListing",
        summary: "Hide or restore a MEME token",
        description:
          "`hidden` removes the token from GET /v2/meme/tokens and category=meme at once; GET /v2/meme/tokens/{id} still reads it with `listing: hidden` and `listingReason`. `hidden` needs `reasonText` (users see it).",
        tags: ["admin-meme"],
        security: adminSecurity,
        params: memeTokenIdParamsSchema,
        querystring: emptyQuerySchema,
        body: memeListingRequestSchema,
        response: {
          200: memeListingResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "NOT_FOUND",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guard("console.write"),
    },
    async (request, reply) => {
      const { memeTokenId } = request.params as {
        readonly memeTokenId: string;
      };
      const body = request.body as {
        readonly listing: unknown;
        readonly reasonCode: unknown;
        readonly reasonText?: unknown;
      };
      const resource = await service.setMemeListing(
        context(request),
        memeTokenId,
        body,
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  for (const action of ["pause", "unpause"] as const) {
    app.post(
      `${adminApiPrefix}/meme/tokens/:memeTokenId/${action}`,
      {
        schema: {
          operationId:
            action === "pause"
              ? "pauseAdminMemeToken"
              : "unpauseAdminMemeToken",
          summary:
            action === "pause"
              ? "Pause a MEME token's curve"
              : "Unpause a MEME token's curve",
          description: `Signs \`${action}(token)\` on the curve with the operator key (MEME_OPERATOR_PRIVATE_KEY, testnet only; Decision 0105) after a dry run, and answers 202 once broadcast. Audit rows: \`meme.${action}.requested\` before anything is signed (when it cannot be written: 503 ADMIN_AUDIT_UNAVAILABLE, nothing signed), then \`meme.${action}.submitted\` or \`meme.${action}.failed\`. The token status follows when the meme_event lane indexes the ${action === "pause" ? "Paused" : "Unpaused"} log. A pause/unpause of the same token still in flight or not yet mined → 409 MEME_PAUSE_PENDING. Key missing or contract unconfigured → 503 with reasonCode (MEME_OPERATOR_KEY_MISSING, MEME_CONTRACT_NOT_CONFIGURED, MEME_MAINNET_SIGNING_CLOSED, MEME_CHAIN_RPC_NOT_CONFIGURED). Wrong state or a reverting dry run → 409.`,
          tags: ["admin-meme"],
          security: adminSecurity,
          params: memeTokenIdParamsSchema,
          querystring: emptyQuerySchema,
          body: memePauseRequestSchema,
          response: {
            202: memePauseResourceSchema,
            ...adminErrors(
              ...guardedSessionErrors,
              "NOT_FOUND",
              "ADMIN_CONFLICT",
              "VALIDATION_FAILED",
              "CAPABILITY_UNAVAILABLE",
            ),
          },
        },
        ...guard("console.write"),
      },
      async (request, reply) => {
        const { memeTokenId } = request.params as {
          readonly memeTokenId: string;
        };
        const body = request.body as {
          readonly reasonCode: unknown;
          readonly reasonText?: unknown;
        };
        const resource = await service.pauseMeme(
          context(request),
          memeTokenId,
          action,
          body,
        );
        noStore(reply);
        return reply.code(202).send(resource);
      },
    );
  }

  app.get(
    `${adminApiPrefix}/audit`,
    {
      schema: {
        operationId: "listAdminAudit",
        summary: "Read the console audit log",
        description:
          "Newest first; filter by exact `actor` or `action`. Rows are never edited or deleted.",
        tags: ["admin-audit"],
        security: adminSecurity,
        querystring: auditQuerySchema,
        response: {
          200: auditListResourceSchema,
          ...adminErrors(...guardedSessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...guard("audit.read"),
    },
    async (request, reply) => {
      const resource = await service.listAudit(
        request.query as Record<string, unknown>,
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );

  registerAdminMiningSettlementRoutes(app, {
    service: dependencies.miningSettlement,
    guard,
    guardAny,
    context,
  });

  registerAdminChainGuardRoutes(app, {
    service:
      dependencies.chainGuard ??
      createAdminChainGuardService({ repository: null, chainId: "eip155:56" }),
    guard,
    context,
  });

  registerAdminRoleRoutes(app, {
    service,
    accounts: dependencies.accounts,
    launchReview: dependencies.launchReview,
    cookieSecure: dependencies.cookieSecure,
    sessionOnly,
    guard,
    principalOf,
    requestContext,
  });
}
