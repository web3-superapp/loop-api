import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  AdminApiError,
  adminApiPrefix,
  adminSessionCookieName,
  adminSessionTtlSeconds,
} from "../../features/admin/admin-contract.js";
import {
  readCookie,
  sessionCookieHeader,
  type AdminSession,
} from "../../features/admin/admin-auth.js";
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
  sessionErrors,
  sessionRequestSchema,
  sessionResourceSchema,
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
  readonly cookieSecure: boolean;
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
  const sessions = new WeakMap<FastifyRequest, AdminSession>();

  function requireSession(request: FastifyRequest): Promise<void> {
    const session = service.sessionCodec.verify(
      readCookie(request.headers.cookie, adminSessionCookieName),
    );
    if (session === null) {
      throw new AdminApiError("ADMIN_SESSION_REQUIRED");
    }
    sessions.set(request, session);
    return Promise.resolve();
  }

  function context(request: FastifyRequest): AdminWriteContext {
    const session = sessions.get(request);
    if (session === undefined) {
      throw new AdminApiError("ADMIN_SESSION_REQUIRED");
    }
    return { session, requestId: request.id };
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
  const protectedRoute = {
    onRequest: requireSession,
  } as const;

  app.post(
    `${adminApiPrefix}/session`,
    {
      schema: {
        operationId: "createAdminSession",
        summary: "Log in as the operator",
        description:
          "Username + password (argon2id). Success sets the signed session cookie (HttpOnly, SameSite=Strict, Path=/admin, 12 hours). Five failures in a row lock every login for 15 minutes (423 ADMIN_LOGIN_LOCKED, `detailsSafe.retryAfterSeconds`, `Retry-After`).",
        tags: ["admin-session"],
        querystring: emptyQuerySchema,
        body: sessionRequestSchema,
        response: {
          200: sessionResourceSchema,
          ...adminErrors(
            "ADMIN_LOGIN_INVALID",
            "ADMIN_LOGIN_LOCKED",
            "INVALID_REQUEST",
            "REQUEST_TIMEOUT",
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
      return reply.code(200).send({
        actor: issued.session.actor,
        issuedAt: issued.session.issuedAt,
        expiresAt: issued.session.expiresAt,
      });
    },
  );

  app.get(
    `${adminApiPrefix}/session`,
    {
      schema: {
        operationId: "getAdminSession",
        summary: "Read the current operator session",
        description: "200 with the session, or 401 ADMIN_SESSION_REQUIRED.",
        tags: ["admin-session"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: {
            ...sessionResourceSchema,
            headers: overviewResourceSchema.headers,
          },
          ...adminErrors(...sessionErrors),
        },
      },
      ...protectedRoute,
    },
    async (request, reply) => {
      const { session } = context(request);
      noStore(reply);
      return reply.code(200).send({
        actor: session.actor,
        issuedAt: session.issuedAt,
        expiresAt: session.expiresAt,
      });
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
          ...adminErrors(...sessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...protectedRoute,
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
          ...adminErrors(...sessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...protectedRoute,
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
            ...sessionErrors,
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...protectedRoute,
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
          ...adminErrors(...sessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...protectedRoute,
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
            ...sessionErrors,
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...protectedRoute,
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
          ...adminErrors(...sessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...protectedRoute,
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
            ...sessionErrors,
            "NOT_FOUND",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...protectedRoute,
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
          "Runs the existing review path (Decision 0073: status, community audit row, owner notification and push) and records a review note plus a console audit row. `reject` needs `reasonText` (the applicant reads it). Rejecting a verified community is 409 ADMIN_CONFLICT (ADMIN_COMMUNITY_ALREADY_VERIFIED). Repeating the current decision is 200 with `changed: false`.",
        tags: ["admin-communities"],
        security: adminSecurity,
        params: communityIdParamsSchema,
        querystring: emptyQuerySchema,
        body: communityReviewRequestSchema,
        response: {
          200: communityReviewResourceSchema,
          ...adminErrors(
            ...sessionErrors,
            "NOT_FOUND",
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...protectedRoute,
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
          "Newest 50 versions (Decision 0046 table) with their editable parameters. `approval.available: false` (reasonCode MINING_APPROVE_FORBIDDEN_IN_PRODUCTION) greys the approve button.",
        tags: ["admin-mining"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: formulaVersionListResourceSchema,
          ...adminErrors(...sessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...protectedRoute,
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
          "Copies `baseVersion` and applies the editable parameters; the draft is `pending_approval` and changes no number until approved. An existing configVersion is 409 ADMIN_CONFLICT (ADMIN_FORMULA_VERSION_EXISTS).",
        tags: ["admin-mining"],
        security: adminSecurity,
        querystring: emptyQuerySchema,
        body: formulaDraftRequestSchema,
        response: {
          201: formulaDraftResourceSchema,
          ...adminErrors(
            ...sessionErrors,
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...protectedRoute,
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
          "Same semantics as `pnpm mining:approve-formula` (Decision 0046): only `pending_approval` can be approved; the approved version is retired; effectiveAt = now; the draft's community weights are applied in the same transaction. The snapshot lane computes under it from its next run. Refused under NODE_ENV=production (503 MINING_APPROVE_FORBIDDEN_IN_PRODUCTION).",
        tags: ["admin-mining"],
        security: adminSecurity,
        params: configVersionParamsSchema,
        querystring: emptyQuerySchema,
        response: {
          200: formulaApproveResourceSchema,
          ...adminErrors(
            ...sessionErrors,
            "NOT_FOUND",
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      preValidation: assertEmptyBody,
      ...protectedRoute,
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
            ...sessionErrors,
            "NOT_FOUND",
            "ADMIN_CONFLICT",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      preValidation: assertEmptyBody,
      ...protectedRoute,
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
          ...adminErrors(...sessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...protectedRoute,
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
            ...sessionErrors,
            "NOT_FOUND",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...protectedRoute,
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
          description: `Signs \`${action}(token)\` on the curve with the executor key (MEME_GRADUATION_EXECUTOR_ENABLED, testnet only) after a dry run, and answers 202 once broadcast. The token status follows when the meme_event lane indexes the ${action === "pause" ? "Paused" : "Unpaused"} log. Executor off or contract unconfigured → 503 with reasonCode (MEME_EXECUTOR_DISABLED, MEME_CONTRACT_NOT_CONFIGURED, MEME_MAINNET_SIGNING_CLOSED, MEME_CHAIN_RPC_NOT_CONFIGURED). Wrong state or a reverting dry run → 409.`,
          tags: ["admin-meme"],
          security: adminSecurity,
          params: memeTokenIdParamsSchema,
          querystring: emptyQuerySchema,
          body: memePauseRequestSchema,
          response: {
            202: memePauseResourceSchema,
            ...adminErrors(
              ...sessionErrors,
              "NOT_FOUND",
              "ADMIN_CONFLICT",
              "VALIDATION_FAILED",
              "CAPABILITY_UNAVAILABLE",
            ),
          },
        },
        ...protectedRoute,
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
          ...adminErrors(...sessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...protectedRoute,
    },
    async (request, reply) => {
      const resource = await service.listAudit(
        request.query as Record<string, unknown>,
      );
      noStore(reply);
      return reply.code(200).send(resource);
    },
  );
}
