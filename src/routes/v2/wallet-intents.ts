import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import {
  assertDecimalStringFields,
  assertNoBody,
  assertNoBodyOrQuery,
  assertNoQuery,
} from "./chain-schemas.js";
import type { V2RouteDependencies } from "./index.js";
import {
  approvePrepareRequestSchema,
  broadcastReportRequestSchema,
  commandIdempotencyKey,
  intentIdParamsSchema,
  revokePrepareRequestSchema,
  sendPreflightRequestSchema,
  sendPreflightResourceSchema,
  sendPrepareRequestSchema,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateIntentCommandHeaders,
  validateIntentReadHeaders,
  validateQuoteHeaders,
  walletIntentCommandErrors,
  walletIntentListQuerySchema,
  walletIntentListResourceSchema,
  walletIntentReadErrors,
  walletIntentResourceSchema,
} from "./wallet-intents-schemas.js";

/**
 * V2 wallet-intent routes (D16, Decision 0035). The shared lifecycle routes
 * (get, list, cancel, broadcast report) are registered by whichever of the
 * `sendApprovals` and `swap` modules registers first; send/approve/revoke
 * prepare belongs to `sendApprovals`.
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

const registeredLifecycle = new WeakSet<FastifyInstance>();

export function registerV2WalletIntentLifecycleRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  if (registeredLifecycle.has(app)) {
    return;
  }
  registeredLifecycle.add(app);
  const { authenticateLoopBearer, walletIntentService } = dependencies;

  app.get(
    "/v2/wallet-intents",
    {
      schema: {
        operationId: "listV2WalletIntents",
        summary: "List the account's wallet intents",
        description:
          "Newest first with an opaque cursor. Open intents past expiresAt are projected as expired.",
        tags: ["wallet-intents"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: walletIntentListQuerySchema,
        response: {
          200: walletIntentListResourceSchema,
          ...walletIntentReadErrors,
        },
      },
      onRequest: validateIntentReadHeaders,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await walletIntentService.list({
        principal: requireAuthenticatedLoopPrincipal(request),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/wallet-intents/:intentId",
    {
      schema: {
        operationId: "getV2WalletIntent",
        summary: "Get one wallet intent",
        description:
          "The tx-result page polls this. state is the state machine of record; result carries the hash, Provider action ID, reason code, and receipt with confirmations.",
        tags: ["wallet-intents"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: intentIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: walletIntentResourceSchema,
          ...walletIntentReadErrors,
        },
      },
      onRequest: validateIntentReadHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as IntentParams;
      const resource = await walletIntentService.get({
        principal: requireAuthenticatedLoopPrincipal(request),
        intentId: params.intentId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/wallet-intents/:intentId/cancel",
    {
      schema: {
        operationId: "cancelV2WalletIntent",
        summary: "Cancel an intent that has not been signed",
        description:
          "Only prepared or awaiting_signature intents can be cancelled; anything later may already be on chain and is DATA_STALE. Naturally idempotent.",
        tags: ["wallet-intents"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: intentIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: walletIntentResourceSchema,
          ...walletIntentCommandErrors,
        },
      },
      onRequest: validateIntentCommandHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as IntentParams;
      const resource = await walletIntentService.cancel({
        principal: requireAuthenticatedLoopPrincipal(request),
        intentId: params.intentId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/wallet-intents/:intentId/broadcast-report",
    {
      schema: {
        operationId: "reportV2WalletIntentBroadcast",
        summary:
          "Report the hash the device broadcast for a send/approve/revoke intent",
        description:
          "The server reads eth_getTransactionByHash and compares from/to/data/value/nonce with the reviewed payload; a mismatch is VALIDATION_FAILED and audited. A hash the endpoint has not seen yet is accepted as pending verification and re-checked by the reconciliation lane.",
        tags: ["wallet-intents"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: intentIdParamsSchema,
        querystring: emptyQueryStringSchema,
        body: broadcastReportRequestSchema,
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
      const resource = await walletIntentService.reportBroadcast({
        principal: requireAuthenticatedLoopPrincipal(request),
        intentId: params.intentId,
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}

export function registerV2WalletIntentRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  registerV2WalletIntentLifecycleRoutes(app, dependencies);
  const { authenticateLoopBearer, sendService, approvalService } = dependencies;

  app.post(
    "/v2/wallet-intents/send/preflight",
    {
      schema: {
        operationId: "preflightV2SendRecipient",
        summary: "Check a recipient address before building a send intent",
        description:
          "Normalises and checksums the address, reports whether it is a contract and whether the wallet has sent to it before. Malicious-address screening is unavailable until GoPlus address screening is configured; the client shows a strong notice, never a verdict.",
        tags: ["wallet-intents"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: sendPreflightRequestSchema,
        response: {
          200: sendPreflightResourceSchema,
          ...walletIntentReadErrors,
        },
      },
      onRequest: validateQuoteHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await sendService.preflight({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/wallet-intents/send",
    {
      schema: {
        operationId: "prepareV2SendIntent",
        summary: "Prepare an immutable send intent",
        description:
          "Builds the exact unsigned transaction (native transfer or ERC-20 transfer), pre-executes it with eth_call and estimateGas, binds balance/fee/nonce/policy facts, and returns the review with reviewSha256 and expiresAt. Requires BSC_WRITES_ENABLED with the asset on the canary allowlist and the USD value under the ceiling.",
        tags: ["wallet-intents"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: sendPrepareRequestSchema,
        response: {
          200: walletIntentResourceSchema,
          201: walletIntentResourceSchema,
          ...walletIntentCommandErrors,
        },
      },
      onRequest: validateIntentCommandHeaders,
      preValidation: [assertNoQuery, assertDecimalStringFields(["amount"])],
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const result = await sendService.prepare({
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
    "/v2/wallet-intents/approve",
    {
      schema: {
        operationId: "prepareV2ApproveIntent",
        summary: "Prepare an ERC-20 approve intent",
        description:
          "Exact allowance by default. An unlimited allowance needs the top-level acknowledgeUnlimited second confirmation; the canary ceiling is enforced on the actual exposure min(allowance, balance) at the snapshot block. The review carries the decoded approve(spender, value) call.",
        tags: ["wallet-intents"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: approvePrepareRequestSchema,
        response: {
          200: walletIntentResourceSchema,
          201: walletIntentResourceSchema,
          ...walletIntentCommandErrors,
        },
      },
      onRequest: validateIntentCommandHeaders,
      preValidation: [
        assertNoQuery,
        assertDecimalStringFields(["allowance.amount"]),
      ],
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const result = await approvalService.prepareApprove({
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
    "/v2/wallet-intents/revoke",
    {
      schema: {
        operationId: "prepareV2RevokeIntent",
        summary: "Prepare an approve(spender, 0) revoke intent",
        tags: ["wallet-intents"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: revokePrepareRequestSchema,
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
      const result = await approvalService.prepareRevoke({
        principal: requireAuthenticatedLoopPrincipal(request),
        idempotencyKey: commandIdempotencyKey(request),
        body: request.body,
        signal: requestSignal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(result.created ? 201 : 200).send(result.resource);
    },
  );
}
