import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import { assertNoQuery } from "./chain-schemas.js";
import {
  dappPrepareErrors,
  dappSignPrepareRequestSchema,
  dappTxPrepareRequestSchema,
  rpcReadErrors,
  rpcReadRequestSchema,
  rpcReadResourceSchema,
  signatureReportRequestSchema,
} from "./dapp-browser-schemas.js";
import type { V2RouteDependencies } from "./index.js";
import {
  commandIdempotencyKey,
  intentIdParamsSchema,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateIntentCommandHeaders,
  validateQuoteHeaders,
  walletIntentCommandErrors,
  walletIntentResourceSchema,
} from "./wallet-intents-schemas.js";

/**
 * Decision 0197 (S342, LOOP decision 0270): the in-app DApp browser's
 * server half — two prepares into the unified signing exit, the signature
 * report that closes a `dapp_sign`, and the read-only RPC proxy. All four
 * sit behind DAPP_BROWSER_ENABLED (default off → 503 CAPABILITY_UNAVAILABLE
 * / DAPP_BROWSER_DISABLED on the prepares and the proxy).
 */

function requestSignal(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  request.raw.once("close", () => {
    controller.abort();
  });
  return controller.signal;
}

interface IntentParams {
  readonly intentId: string;
}

export function registerV2DappBrowserRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, dappIntentService, dappRpcReadService } =
    dependencies;

  app.post(
    "/v2/wallet-intents/dapp-tx",
    {
      schema: {
        operationId: "prepareV2DappTxIntent",
        summary: "Prepare an immutable intent for a DApp page's transaction",
        description:
          "Decision 0197 (S342). The page's eth_sendTransaction (to / data / value) on the launch slot's testnet becomes a dapp_tx intent: the server decodes the call (ERC-20 transfer / approve / increaseAllowance / transferFrom, ERC-721 approve / transferFrom / safeTransferFrom / setApprovalForAll, Permit2 approve, LOOP router / launch2 / Launch methods on LOOP-known contracts; anything else functionName null + selector), checks whether the target and the decoded counterparty are contracts LOOP knows, pre-executes it with eth_call + estimateGas and binds nonce / gas / expiry. review.dapp carries origin, to, value, decodedCall, counterparty and riskFlags (UNLIMITED_APPROVAL, APPROVAL_FOR_ALL, EOA_SPENDER for a grant to an address without code, UNVERIFIED_CONTRACT, SIMULATION_FAILED). A pre-execution that does not pass still creates the intent, in prepared with signing.allowed=false and SIMULATION_FAILED. The intent walks the send lifecycle (device signs, broadcast-report, reconciliation). A new DApp prepare supersedes only an open DApp intent; an open send / swap / approve / send_nft on the wallet is 409 RESOURCE_CONFLICT / INTENT_BUSY. eip155:56 is 422 VALIDATION_FAILED / CHAIN_SIGNING_DISABLED; 503 CAPABILITY_UNAVAILABLE / DAPP_BROWSER_DISABLED while DAPP_BROWSER_ENABLED is off.",
        tags: ["wallet-intents"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: dappTxPrepareRequestSchema,
        response: {
          200: walletIntentResourceSchema,
          201: walletIntentResourceSchema,
          ...dappPrepareErrors,
        },
      },
      onRequest: validateIntentCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const result = await dappIntentService.prepareTransaction({
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
    "/v2/wallet-intents/dapp-sign",
    {
      schema: {
        operationId: "prepareV2DappSignIntent",
        summary: "Prepare an immutable intent for a DApp page's signature",
        description:
          "Decision 0197 (S342). personal_sign / eth_signTypedData_v4 on the launch slot's testnet becomes a dapp_sign intent in awaiting_signature: review.dapp.message (UTF-8 text when printable, else hex) or review.dapp.typedData (domain, primaryType, message leaves) plus riskFlags (PERMIT_SIGNATURE for EIP-2612 / DAI Permit and Permit2, UNLIMITED_APPROVAL on top for an unlimited permit, UNRECOGNIZED_TYPED_DATA for any other primaryType, UNVERIFIED_CONTRACT for a verifyingContract LOOP does not know, RAW_HASH_SIGNATURE for a personal_sign of 32 non-text bytes); signatureRequest is the exact JSON-RPC request the device signs. The device then reports the signature with POST /v2/wallet-intents/{intentId}/signature-report. eip155:56 is 422 VALIDATION_FAILED / CHAIN_SIGNING_DISABLED; typed data must carry domain.chainId (TYPED_DATA_INVALID otherwise) equal to chainId (TYPED_DATA_CHAIN_MISMATCH), and a page-supplied types.EIP712Domain must list exactly the domain's keys with their EIP-712 types (TYPED_DATA_INVALID); an open send / swap / approve / send_nft is 409 RESOURCE_CONFLICT / INTENT_BUSY; 503 CAPABILITY_UNAVAILABLE / DAPP_BROWSER_DISABLED while DAPP_BROWSER_ENABLED is off.",
        tags: ["wallet-intents"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: dappSignPrepareRequestSchema,
        response: {
          200: walletIntentResourceSchema,
          201: walletIntentResourceSchema,
          ...dappPrepareErrors,
        },
      },
      onRequest: validateIntentCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const result = await dappIntentService.prepareSignature({
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
    "/v2/wallet-intents/:intentId/signature-report",
    {
      schema: {
        operationId: "reportV2WalletIntentSignature",
        summary:
          "Report the signature the device produced for a dapp_sign intent",
        description:
          "Decision 0197 (S342). The server ecrecovers the signature over the reviewed signatureRequest; a signer other than the intent's wallet is 422 VALIDATION_FAILED / SIGNATURE_MISMATCH (audited). A match moves the intent to confirmed (a late report on an expired, superseded or cancelled intent is recorded too, like a late broadcast report); reporting again is idempotent. Only the signature's SHA-256 is kept, in the audit event. Any other kind is VALIDATION_FAILED.",
        tags: ["wallet-intents"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: intentIdParamsSchema,
        querystring: emptyQueryStringSchema,
        body: signatureReportRequestSchema,
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
      const resource = await dappIntentService.reportSignature({
        principal: requireAuthenticatedLoopPrincipal(request),
        intentId: params.intentId,
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/chain/rpc-read",
    {
      schema: {
        operationId: "readV2ChainRpc",
        summary: "Forward one read-only JSON-RPC request for a DApp page",
        description:
          "Decision 0197 (S342). The DApp browser's read channel: eth_chainId, eth_blockNumber, eth_call, eth_getBalance, eth_getCode, eth_getTransactionReceipt, eth_getTransactionByHash, eth_estimateGas, eth_gasPrice, eth_getLogs (a non-empty address, at most 1,000 blocks; forwarded with the resolved block numbers), eth_getBlockByNumber (transaction hashes only; fullTransactions true is 400) and eth_feeHistory (at most 128 blocks) on eip155:56 or the launch slot, through the API's verified RPC endpoints. A JSON-RPC error the node answers is returned in error (200; message only for standard node texts, data only when hex); an unreachable endpoint is 503; a provider quota / rate refusal or an answer above 1 MiB is 503 CAPABILITY_UNAVAILABLE / RPC_UPSTREAM_LIMITED. Per-account fixed one-minute window (DAPP_RPC_READ_PER_MINUTE, default 120) and a process-wide token bucket (DAPP_RPC_READ_GLOBAL_PER_MINUTE, default 1200) → 429 RATE_LIMITED. 503 CAPABILITY_UNAVAILABLE / DAPP_BROWSER_DISABLED while DAPP_BROWSER_ENABLED is off. A POST because it carries a body; it creates no state, so it rejects an Idempotency-Key.",
        tags: ["chain"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: rpcReadRequestSchema,
        response: {
          200: rpcReadResourceSchema,
          ...rpcReadErrors,
        },
      },
      onRequest: validateQuoteHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await dappRpcReadService.read({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
