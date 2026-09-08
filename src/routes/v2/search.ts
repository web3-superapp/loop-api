import type { FastifyInstance } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { canonicalizeClientIp } from "../../core/http/client-ip.js";
import {
  assertNoBodyV2,
  searchErrors,
  searchQuerySchema,
  searchResourceSchema,
  v2CommonHeadersSchema,
  validateCommonHeaders,
} from "./community-schemas.js";
import type { V2RouteDependencies } from "./index.js";

/**
 * V2 global search (Decision 0031), gated by the separate `search` module.
 * `users` and `communities` are backed by PostgreSQL; `assets`, `launch`, and
 * `dapps` have no selected backend and answer 200 with
 * `status: "unavailable"` so the client can disable those segments without
 * inventing results. Chat content is never searched here.
 */
export function registerV2SearchRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, communityService: service } = dependencies;

  app.get(
    "/v2/search",
    {
      schema: {
        operationId: "searchV2",
        summary: "Search users and communities",
        description:
          "The `users` domain reuses the public alias prefix normalization and the shared public search quota; the `communities` domain matches a name or slug prefix and only returns verified communities unless the caller already joined. Results carry a result type, opaque stable ID, display snapshot, and canonical destination.",
        tags: ["search"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: searchQuerySchema,
        response: { 200: searchResourceSchema, ...searchErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly domain?: unknown;
        readonly q?: unknown;
        readonly verification?: unknown;
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await service.search({
        principal: requireAuthenticatedLoopPrincipal(request),
        domain: query.domain,
        q: query.q,
        verification: query.verification,
        cursor: query.cursor,
        limit: query.limit,
        canonicalClientIp: canonicalizeClientIp(request.ip),
        signal: request.signal,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
