import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { canonicalizeClientIp } from "../../core/http/client-ip.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import { parseV2CommandMetadata } from "../../features/community/community-contract.js";
import type { CommunityService } from "../../features/community/community-service.js";
import {
  assertNoBodyOrQueryV2,
  assertNoBodyV2,
  assertNoQuery,
  commandErrors,
  communityHomeResourceSchema,
  communityIdParamsSchema,
  communityListQuerySchema,
  communityListResourceSchema,
  communityResourceSchema,
  createCommunityRequestSchema,
  memberListErrors,
  memberListQuerySchema,
  memberListResourceSchema,
  memberParamsSchema,
  readErrors,
  roleChangeRequestSchema,
  updateCommunityRequestSchema,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateCommandHeaders,
  validateCommonHeaders,
} from "./community-schemas.js";
import { registerV2CommunityAiRoutes } from "./community-ai.js";
import type { V2RouteDependencies } from "./index.js";
import { registerV2SocialRoutes } from "./social.js";

/**
 * V2 community module routes (Decision 0031). Registered only when
 * `V2_MODULES_ENABLED` contains `community`; otherwise every path returns the
 * V2 NOT_FOUND envelope. `GET /v2/search` belongs to the separate `search`
 * module gate.
 */

interface CommunityParams {
  readonly communityId: string;
}

interface MemberParams extends CommunityParams {
  readonly publicProfileId: string;
}

function commandContext(request: FastifyRequest): {
  readonly idempotencyKey: string;
  readonly requestId: string;
} {
  return {
    idempotencyKey: parseV2CommandMetadata(request.raw.rawHeaders)
      .idempotencyKey,
    requestId: request.id,
  };
}

export function registerV2CommunityRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, communityService } = dependencies;
  const service: CommunityService = communityService;

  app.get(
    "/v2/community/home",
    {
      schema: {
        operationId: "getV2CommunityHome",
        summary: "Get the community landing aggregate",
        description:
          "Joined communities and up to five verified discover candidates from PostgreSQL. Unread counts, online presence, and live voice rooms stay unavailable until Stream is connected; no fixture replaces them.",
        tags: ["community"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: communityHomeResourceSchema, ...readErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.getHome({
        principal: requireAuthenticatedLoopPrincipal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/communities",
    {
      schema: {
        operationId: "listV2Communities",
        summary: "Discover communities by verifiable ordering",
        description:
          "Ordering uses only checkable facts: member count or creation time. Highest mining power, fastest growing, and most discussed have no backend and are not offered. `verification=all` additionally shows communities the caller created or joined.",
        tags: ["community"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: communityListQuerySchema,
        response: { 200: communityListResourceSchema, ...readErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly sort?: unknown;
        readonly verification?: unknown;
        readonly membership?: unknown;
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await service.listCommunities({
        principal: requireAuthenticatedLoopPrincipal(request),
        sort: query.sort,
        verification: query.verification,
        membership: query.membership,
        cursor: query.cursor,
        limit: query.limit,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/communities",
    {
      schema: {
        operationId: "createV2Community",
        summary: "Apply for a community",
        description:
          "Creates a `pending` community with the applicant as owner. Verification is never self-served: only the Dev-only operator script `pnpm community:verify` can set `verified`, and it writes an audit row.",
        tags: ["community"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: createCommunityRequestSchema,
        response: { 201: communityResourceSchema, ...commandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.createCommunity({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send(resource);
    },
  );

  app.get(
    "/v2/communities/:communityId",
    {
      schema: {
        operationId: "getV2Community",
        summary: "Get one community record",
        description:
          "Community archive header with the viewer's membership and permission flags. Mining, presence, announcements, and official links remain unavailable in this step.",
        tags: ["community"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: communityIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: communityResourceSchema, ...readErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as CommunityParams;
      const resource = await service.getCommunity({
        principal: requireAuthenticatedLoopPrincipal(request),
        communityId: params.communityId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.patch(
    "/v2/communities/:communityId",
    {
      schema: {
        operationId: "updateV2Community",
        summary: "Edit the community profile",
        description:
          "Owner-only partial edit of name, description, logo, and bound asset key; only the keys present in the body change. The slug and the verification status are immutable through this path, and every edit appends a community_profile_updated audit row.",
        tags: ["community"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: communityIdParamsSchema,
        querystring: emptyQueryStringSchema,
        body: updateCommunityRequestSchema,
        response: { 200: communityResourceSchema, ...commandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as CommunityParams;
      const resource = await service.updateCommunity({
        principal: requireAuthenticatedLoopPrincipal(request),
        communityId: params.communityId,
        body: request.body,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/communities/:communityId/join",
    {
      schema: {
        operationId: "joinV2Community",
        summary: "Join a community",
        description:
          "Idempotent join. `member_count` is maintained inside the same transaction, so concurrent joins can neither lose nor double count. A banned account is PERMISSION_DENIED.",
        tags: ["community"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: communityIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: communityResourceSchema, ...commandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as CommunityParams;
      const resource = await service.joinCommunity({
        principal: requireAuthenticatedLoopPrincipal(request),
        communityId: params.communityId,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.delete(
    "/v2/communities/:communityId/membership",
    {
      schema: {
        operationId: "leaveV2Community",
        summary: "Leave a community",
        description:
          "An owner cannot leave: ownership must be transferred first (PERMISSION_DENIED). Leaving when no membership exists is DATA_STALE.",
        tags: ["community"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: communityIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: communityResourceSchema, ...commandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as CommunityParams;
      const resource = await service.leaveCommunity({
        principal: requireAuthenticatedLoopPrincipal(request),
        communityId: params.communityId,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/communities/:communityId/resubmit",
    {
      schema: {
        operationId: "resubmitV2Community",
        summary: "Resubmit a rejected community application",
        description:
          "Owner-only, body-less command that moves a `rejected` application back to `pending` (Decision 0073): the rejection reason and review time are cleared, `application.submittedAt` moves to now, and a `community_resubmitted` audit row is appended. Edit the profile with PATCH first; this command changes nothing else. Any state other than `rejected` is DATA_STALE.",
        tags: ["community"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: communityIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: communityResourceSchema, ...commandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as CommunityParams;
      const resource = await service.resubmitCommunity({
        principal: requireAuthenticatedLoopPrincipal(request),
        communityId: params.communityId,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/communities/:communityId/members",
    {
      schema: {
        operationId: "listV2CommunityMembers",
        summary: "List community members grouped by role",
        description:
          'Owner first, then admins, then members; inside a group the earliest join comes first. Each row carries `actions`: the governance commands this viewer may run against that row, computed from the actor x action x target permission matrix and the row\'s stored state, so a client renders exactly that list and derives nothing. Segment counts come from the server and always describe the whole non-banned directory, so they do not shrink while `q` narrows the page. Per-member mining power and the online count stay unavailable. `role=banned` is the owner/admin governance view that lists banned memberships (`status: "banned"`), which no other view contains. `q` narrows the page to a member alias prefix, draws on the shared public alias search quota, and is bound into the cursor.',
        tags: ["community"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: communityIdParamsSchema,
        querystring: memberListQuerySchema,
        response: { 200: memberListResourceSchema, ...memberListErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as CommunityParams;
      const query = request.query as {
        readonly role?: unknown;
        readonly q?: unknown;
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await service.listMembers({
        principal: requireAuthenticatedLoopPrincipal(request),
        communityId: params.communityId,
        role: query.role,
        q: query.q,
        cursor: query.cursor,
        limit: query.limit,
        canonicalClientIp: canonicalizeClientIp(request.ip),
        signal: request.signal,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/communities/:communityId/members/:publicProfileId/role",
    {
      schema: {
        operationId: "changeV2CommunityMemberRole",
        summary: "Appoint, revoke, or transfer a community role",
        description:
          "Only an owner may change roles: `admin` appoints, `member` revokes, `owner` transfers (the previous owner becomes admin). An owner can never be downgraded by anyone else. Every change appends a RoleChanged audit row.",
        tags: ["community"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: memberParamsSchema,
        querystring: emptyQueryStringSchema,
        body: roleChangeRequestSchema,
        response: { 200: memberListResourceSchema, ...commandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as MemberParams;
      const resource = await service.governMember({
        principal: requireAuthenticatedLoopPrincipal(request),
        communityId: params.communityId,
        targetPublicProfileId: params.publicProfileId,
        action: "role",
        body: request.body,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  for (const [action, method, path, operationId, summary] of [
    [
      "mute",
      "post",
      "mute",
      "muteV2CommunityMember",
      "Mute a community member",
    ],
    [
      "unmute",
      "delete",
      "mute",
      "unmuteV2CommunityMember",
      "Unmute a community member",
    ],
    ["ban", "post", "ban", "banV2CommunityMember", "Ban a community member"],
    [
      "unban",
      "delete",
      "ban",
      "unbanV2CommunityMember",
      "Unban a community member",
    ],
  ] as const) {
    const register =
      method === "post" ? app.post.bind(app) : app.delete.bind(app);
    register(
      `/v2/communities/:communityId/members/:publicProfileId/${path}`,
      {
        schema: {
          operationId,
          summary,
          description:
            'Owner or admin governance action. An admin may only act on members; an owner is never a valid target. A transition the stored state does not allow is DATA_STALE. A ban keeps the membership row at `status: "banned"` (visible through `GET .../members?role=banned`) and removes the account from the official channel; an unban restores it as `role: "member", status: "active"` with its original join date and re-adds it to the channel. Both are community scoped: neither touches the personal follow graph.',
          tags: ["community"],
          security: [{ privyBearer: [] }],
          headers: v2CommandHeadersSchema,
          params: memberParamsSchema,
          querystring: emptyQueryStringSchema,
          response: { 200: memberListResourceSchema, ...commandErrors },
        },
        onRequest: validateCommandHeaders,
        preValidation: assertNoBodyOrQueryV2,
        preHandler: authenticateLoopBearer,
      },
      async (request, reply) => {
        const params = request.params as MemberParams;
        const resource = await service.governMember({
          principal: requireAuthenticatedLoopPrincipal(request),
          communityId: params.communityId,
          targetPublicProfileId: params.publicProfileId,
          action,
          body: undefined,
          ...commandContext(request),
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      },
    );
  }

  registerV2CommunityAiRoutes(app, dependencies);
  registerV2SocialRoutes(app, dependencies);
}
