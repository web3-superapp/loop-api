import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import {
  activityQuerySchema,
  assertNoBody,
  assertNoBodyOrQuery,
  assertNoQuery,
  chainReadErrors,
  chainWriteErrors,
  setActiveWalletRequestSchema,
  v2CommonHeadersSchema,
  validateChainHeaders,
  validateChainWriteHeaders,
  walletActivityResourceSchema,
  walletBalancesResourceSchema,
  walletIdParamsSchema,
  walletListResourceSchema,
  walletReceiveResourceSchema,
} from "./chain-schemas.js";
import type { V2RouteDependencies } from "./index.js";

/**
 * V2 wallet module routes (D12, Decision 0033). Every route is read-only
 * except the compare-and-swap active-wallet selection, which moves no funds.
 */

interface WalletParams {
  readonly walletId: string;
}

/**
 * Provider and RPC reads are bound to the HTTP request lifetime so a client
 * disconnect cancels the outbound call instead of leaking it.
 */
function requestSignal(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  request.raw.once("close", () => {
    controller.abort();
  });
  return controller.signal;
}

export function registerV2WalletRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, walletReadService } = dependencies;

  app.get(
    "/v2/wallets",
    {
      schema: {
        operationId: "listV2Wallets",
        summary: "List the account's wallets",
        description:
          "Privy is authoritative for which wallets exist; the first call projects them into LOOP and issues an opaque walletId. Wallets Privy no longer reports are archived, never deleted. Each row carries the wallet's public address as an on-chain fact; only the walletId is ever accepted as an identifier.",
        tags: ["wallet"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: walletListResourceSchema, ...chainReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await walletReadService.listWallets({
        principal: requireAuthenticatedLoopPrincipal(request),
        signal: requestSignal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.put(
    "/v2/wallets/active",
    {
      schema: {
        operationId: "setV2ActiveWallet",
        summary: "Select the active wallet",
        description:
          "Compare-and-swap on the currently active wallet. An identical retry returns the committed list, a concurrent switch is VERSION_CONFLICT, and an Idempotency-Key is rejected because the write is idempotent through expectedActiveWalletId.",
        tags: ["wallet"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: setActiveWalletRequestSchema,
        response: { 200: walletListResourceSchema, ...chainWriteErrors },
      },
      onRequest: validateChainWriteHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await walletReadService.setActiveWallet({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/wallets/:walletId/balances",
    {
      schema: {
        operationId: "getV2WalletBalances",
        summary: "Get registry-asset balances at one block",
        description:
          "Authoritative multicall balances at a single snapshot block. display/available/spendable/gasReserve/pending are separate facts; valuation and net worth stay unavailable until a price Provider is configured. The Privy balance view is a cross-check that never changes the RPC value.",
        tags: ["wallet"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: walletIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: walletBalancesResourceSchema, ...chainReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as WalletParams;
      const resource = await walletReadService.getBalances({
        principal: requireAuthenticatedLoopPrincipal(request),
        walletId: params.walletId,
        signal: requestSignal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/wallets/:walletId/activity",
    {
      schema: {
        operationId: "getV2WalletActivity",
        summary: "List indexed ERC-20 transfers for one wallet",
        description:
          "Indexer-derived ERC-20 activity for Asset Registry assets, newest first, each row carrying its transaction, log index, block, and confirmations. Native transfers and cross-chain activity are unavailable in this step. An indexer that has never run is INDEXING_DELAYED, never an empty success.",
        tags: ["wallet"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: walletIdParamsSchema,
        querystring: activityQuerySchema,
        response: { 200: walletActivityResourceSchema, ...chainReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as WalletParams;
      const query = request.query as {
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await walletReadService.getActivity({
        principal: requireAuthenticatedLoopPrincipal(request),
        walletId: params.walletId,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/wallets/:walletId/receive",
    {
      schema: {
        operationId: "getV2WalletReceive",
        summary: "Get the receive address and EIP-681 request",
        description:
          "The wallet's public address plus an EIP-681 request string for BSC. Only supported networks are listed; an unsupported network is absent rather than shown as an unavailable placeholder.",
        tags: ["wallet"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: walletIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: walletReceiveResourceSchema, ...chainReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as WalletParams;
      const resource = await walletReadService.getReceive({
        principal: requireAuthenticatedLoopPrincipal(request),
        walletId: params.walletId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
