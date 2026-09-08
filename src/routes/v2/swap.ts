import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import { assertDecimalStringFields, assertNoQuery } from "./chain-schemas.js";
import type { V2RouteDependencies } from "./index.js";
import { registerV2WalletIntentLifecycleRoutes } from "./wallet-intents.js";
import {
  commandIdempotencyKey,
  intentIdParamsSchema,
  swapExecuteRequestSchema,
  swapPrepareRequestSchema,
  swapQuoteRequestSchema,
  swapQuoteResourceSchema,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateIntentCommandHeaders,
  validateQuoteHeaders,
  walletIntentCommandErrors,
  walletIntentReadErrors,
  walletIntentResourceSchema,
} from "./wallet-intents-schemas.js";

/**
 * V2 Privy Swap routes (D15, Decision 0035). Registered by the `swap` module;
 * they share the intent lifecycle routes with `sendApprovals`.
 */

interface IntentParams {
  readonly intentId: string;
}

function requestSignal(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  request.raw.once("close", () => {
    controller.abort();
  });
  return controller.signal;
}

export function registerV2SwapRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  registerV2WalletIntentLifecycleRoutes(app, dependencies);
  const { authenticateLoopBearer, swapService } = dependencies;

  app.post(
    "/v2/swap/quote",
    {
      schema: {
        operationId: "quoteV2Swap",
        summary: "Quote a Privy Swap",
        description:
          "Server-side wallets.swap.quote on BSC with LOOP's own 30 s expiry. Price impact is computed from market prices and decides allowed / confirm / blocked; an unpriceable pair is blocked. Creates no durable state and rejects an Idempotency-Key.",
        tags: ["swap"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: swapQuoteRequestSchema,
        response: {
          200: swapQuoteResourceSchema,
          ...walletIntentCommandErrors,
        },
      },
      onRequest: validateQuoteHeaders,
      preValidation: [assertNoQuery, assertDecimalStringFields(["amount"])],
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await swapService.quote({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
        signal: requestSignal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/wallet-intents/swap",
    {
      schema: {
        operationId: "prepareV2SwapIntent",
        summary: "Prepare an immutable swap intent from a quote",
        description:
          "Binds the quote snapshot, the exact Privy execute body, and the authorizationPayload the device signs with generateAuthorizationSignature. An expired or unknown quote is QUOTE_EXPIRED; a blocked price impact is POLICY_BLOCKED; confirm-tier impact needs confirmPriceImpact=true.",
        tags: ["swap"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: swapPrepareRequestSchema,
        response: {
          200: walletIntentResourceSchema,
          201: walletIntentResourceSchema,
          ...walletIntentCommandErrors,
        },
      },
      onRequest: validateIntentCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const result = await swapService.prepare({
        principal: requireAuthenticatedLoopPrincipal(request),
        idempotencyKey: commandIdempotencyKey(request),
        body: request.body,
        signal: requestSignal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(result.created ? 201 : 200).send(result.resource);
    },
  );

  app.post(
    "/v2/wallet-intents/:intentId/execute",
    {
      schema: {
        operationId: "executeV2SwapIntent",
        summary:
          "Execute a swap intent once with the device authorization signature",
        description:
          "Forwards privy-authorization-signature, privy-idempotency-key (= intentId), and privy-request-expiry to wallets.swap.execute exactly once. A definitive Provider rejection is failed; an ambiguous outcome is unknown and reconciled, never retried. A second call is SUBMISSION_UNKNOWN.",
        tags: ["swap"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: intentIdParamsSchema,
        querystring: emptyQueryStringSchema,
        body: swapExecuteRequestSchema,
        response: {
          200: walletIntentResourceSchema,
          ...walletIntentCommandErrors,
        },
      },
      onRequest: validateIntentCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as IntentParams;
      const resource = await swapService.execute({
        principal: requireAuthenticatedLoopPrincipal(request),
        intentId: params.intentId,
        body: request.body,
        signal: requestSignal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}

export { walletIntentReadErrors };
