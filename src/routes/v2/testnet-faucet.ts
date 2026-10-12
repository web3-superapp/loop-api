import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import { parseV2CommandMetadata } from "../../features/community/community-contract.js";
import type { TestnetFaucetService } from "../../features/testnet-faucet/testnet-faucet-service.js";
import {
  assertNoQuery,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateCommandHeaders,
  validateCommonHeaders,
} from "./community-schemas.js";
import {
  testnetFaucetCommandErrors,
  testnetFaucetGrantRequestSchema,
  testnetFaucetGrantResourceSchema,
  testnetFaucetQuerySchema,
  testnetFaucetReadErrors,
  testnetFaucetStatusResourceSchema,
} from "./testnet-faucet-schemas.js";

const unavailableReasons =
  "TESTNET_FAUCET_DISABLED | TESTNET_FAUCET_WRONG_CHAIN | TESTNET_FAUCET_OPERATOR_NOT_CONFIGURED | TESTNET_FAUCET_USD1_NOT_CONFIGURED | TESTNET_FAUCET_RPC_NOT_CONFIGURED | TESTNET_FAUCET_RUNTIME_UNAVAILABLE";

/**
 * Decision 0128: the testnet faucet. Always registered (not a
 * `V2_MODULES_ENABLED` module); while capability `testnetFaucet` is
 * unavailable both routes answer 503 with its reason.
 */
export function registerV2TestnetFaucetRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: TestnetFaucetService,
): void {
  app.get(
    "/v2/testnet/faucet",
    {
      schema: {
        operationId: "getV2TestnetFaucet",
        summary: "Get the testnet faucet state of one embedded wallet",
        description: `Decision 0128: amounts, cooldown, whether the wallet's address can claim now, and its newest sent grant. walletId must be the caller's active embedded wallet (else 403 PERMISSION_DENIED / TESTNET_FAUCET_WALLET_NOT_OWNED). 503 CAPABILITY_UNAVAILABLE: ${unavailableReasons}.`,
        tags: ["testnet"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: testnetFaucetQuerySchema,
        response: {
          200: testnetFaucetStatusResourceSchema,
          ...testnetFaucetReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.status({
        principal: requireAuthenticatedLoopPrincipal(request),
        query: request.query,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/testnet/faucet",
    {
      schema: {
        operationId: "claimV2TestnetFaucet",
        summary:
          "Send testnet tBNB and mint MockUSD1 to the caller's embedded wallet",
        description: `Decision 0128: BSC Testnet only. The operator account sends TESTNET_FAUCET_BNB_AMOUNT tBNB, then calls MockUSD1.mint(address, TESTNET_FAUCET_USD1_AMOUNT); each waits for its receipt. Once per wallet address per TESTNET_FAUCET_COOLDOWN_SECONDS. 403 PERMISSION_DENIED / TESTNET_FAUCET_WALLET_NOT_OWNED. 409 RESOURCE_CONFLICT / TESTNET_FAUCET_IN_FLIGHT (same key, still pending); 409 IDEMPOTENCY_CONFLICT. 429 RATE_LIMITED / TESTNET_FAUCET_COOLDOWN (nextAvailableAt). 502 PROVIDER_UNREACHABLE / TESTNET_FAUCET_TRANSFER_FAILED (nothing moved, no cooldown). 503 CAPABILITY_UNAVAILABLE / TESTNET_FAUCET_PARTIAL (tBNB landed, USD1 did not; bnbTransactionHash, usd1TransactionHash only when that mint went out, nextAvailableAt; cooldown counts) | TESTNET_FAUCET_SUBMISSION_UNKNOWN (tBNB broadcast, receipt not seen; bnbTransactionHash, nextAvailableAt; cooldown counts) | ${unavailableReasons} | TESTNET_FAUCET_OPERATOR_LOW | TESTNET_FAUCET_USD1_UNAVAILABLE | TESTNET_FAUCET_CHAIN_READ_FAILED | TESTNET_FAUCET_BUSY. The same Idempotency-Key replays the stored outcome (the same 201 body).`,
        tags: ["testnet"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: testnetFaucetGrantRequestSchema,
        response: {
          201: testnetFaucetGrantResourceSchema,
          ...testnetFaucetCommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.grant({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
        idempotencyKey: parseV2CommandMetadata(request.raw.rawHeaders)
          .idempotencyKey,
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send(resource);
    },
  );
}
