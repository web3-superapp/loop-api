import type { FastifyInstance } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { assertNoBody } from "./chain-schemas.js";
import type { V2RouteDependencies } from "./index.js";
import {
  approvalDetailParamsSchema,
  approvalDetailResourceSchema,
  approvalListResourceSchema,
  approvalsQuerySchema,
  v2CommonHeadersSchema,
  validateIntentReadHeaders,
  walletIntentReadErrors,
} from "./wallet-intents-schemas.js";

/**
 * V2 approvals inventory (D16, Decision 0035). Candidates come from indexed
 * `Approval` logs; every published allowance is re-read over RPC at one
 * block. Revocation goes through `POST /v2/wallet-intents/revoke`.
 */

export function registerV2ApprovalRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, approvalService } = dependencies;

  app.get(
    "/v2/approvals",
    {
      schema: {
        operationId: "listV2Approvals",
        summary: "List the wallet's ERC-20 allowances",
        description:
          "Spenders observed through indexed Approval events for registry assets, each with the current allowance() read at one block. Rows whose current allowance is zero are omitted; an unreadable allowance is reported as unavailable, never as zero. INDEXING_DELAYED until the transfer lane has a checkpoint.",
        tags: ["approvals"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: approvalsQuerySchema,
        response: {
          200: approvalListResourceSchema,
          ...walletIntentReadErrors,
        },
      },
      onRequest: validateIntentReadHeaders,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as { readonly walletId: unknown };
      const resource = await approvalService.list({
        principal: requireAuthenticatedLoopPrincipal(request),
        walletId: query.walletId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/approvals/:assetId/:spender",
    {
      schema: {
        operationId: "getV2Approval",
        summary: "Read one allowance live",
        description:
          "Current allowance(owner, spender) for one registry asset, read over RPC regardless of indexed history.",
        tags: ["approvals"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: approvalDetailParamsSchema,
        querystring: approvalsQuerySchema,
        response: {
          200: approvalDetailResourceSchema,
          ...walletIntentReadErrors,
        },
      },
      onRequest: validateIntentReadHeaders,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as {
        readonly assetId: unknown;
        readonly spender: unknown;
      };
      const query = request.query as { readonly walletId: unknown };
      const resource = await approvalService.get({
        principal: requireAuthenticatedLoopPrincipal(request),
        walletId: query.walletId,
        assetId: params.assetId,
        spender: params.spender,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
