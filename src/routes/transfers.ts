import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preHandlerAsyncHookHandler,
} from "fastify";

import { ApiError } from "../core/http/api-error.js";
import { requireAuthenticatedLoopPrincipal } from "../core/http/authentication.js";
import {
  emptyQueryStringSchema,
  errorResponseSchema,
} from "../core/http/schemas.js";
import { assertNoBodyOrQuery } from "../core/http/request-input.js";
import {
  parsePrepareTransferReviewRequest,
  parseRecipientPreflightRequest,
  parseTransferAuthorizationRequest,
} from "../features/transfer/transfer-contract.js";
import {
  TransferUnavailableError,
  type TransferRequestContext,
  type TransferService,
} from "../features/transfer/transfer-service.js";

const unresolvedContractValueSchema = {
  description:
    "The reviewed transfer contract fixes this key but not its nested wire shape. Only finite plain JSON is accepted, and exact names from the reviewed forbidden_client_keys lists are rejected at every depth.",
} as const;

const positiveDecimalStringSchema = {
  type: "string",
  maxLength: 128,
  pattern: "^(?:[1-9][0-9]*(?:\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$",
} as const;

const opaqueAuthorizationSignatureSchema = {
  type: "string",
  minLength: 1,
} as const;

const recipientPreflightBodySchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["command", "asset_selection_id", "recipient_input"],
      properties: {
        command: { type: "string", const: "resolve" },
        asset_selection_id: unresolvedContractValueSchema,
        recipient_input: unresolvedContractValueSchema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["command", "preflight_handle", "acknowledgement_kind"],
      properties: {
        command: { type: "string", const: "acknowledge" },
        preflight_handle: unresolvedContractValueSchema,
        acknowledgement_kind: {
          type: "string",
          enum: ["first_recipient", "history_unknown"],
        },
      },
    },
  ],
} as const;

const prepareReviewBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["preflight_handle", "amount_decimal"],
  properties: {
    preflight_handle: unresolvedContractValueSchema,
    amount_decimal: positiveDecimalStringSchema,
  },
} as const;

const transferAuthorizationBodySchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["command", "prepared_review_handle"],
      properties: {
        command: { type: "string", const: "issue_payload" },
        prepared_review_handle: unresolvedContractValueSchema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "command",
        "prepared_review_handle",
        "authorization_signature",
        "official_formatter_envelope_sha256",
      ],
      properties: {
        command: { type: "string", const: "submit_signature" },
        prepared_review_handle: unresolvedContractValueSchema,
        authorization_signature: opaqueAuthorizationSignatureSchema,
        official_formatter_envelope_sha256: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
        },
      },
    },
  ],
} as const;

const transferErrors = {
  400: errorResponseSchema(["invalid_request"]),
  401: errorResponseSchema(
    ["authentication_required", "invalid_access_token"],
    { includeBearerChallenge: true },
  ),
  409: errorResponseSchema(["bootstrap_required"]),
  503: errorResponseSchema([
    "authentication_unavailable",
    "transfer_unavailable",
    "request_timeout",
  ]),
  500: errorResponseSchema(["internal_error"]),
} as const;

function assertNoRawRequestBody(request: FastifyRequest): void {
  const contentLength = request.headers["content-length"];
  const transferEncoding = request.headers["transfer-encoding"];

  if (
    (contentLength !== undefined && contentLength !== "0") ||
    transferEncoding !== undefined
  ) {
    throw ApiError.invalidRequest();
  }
}

const forbiddenClientAuthorityHeaders: ReadonlySet<string> = new Set([
  "idempotency-key",
  "privy-app-id",
  "privy-idempotency-key",
  "privy-request-expiry",
  "authorization-signature",
  "privy-authorization-signature",
]);

function assertNoClientAuthorityHeaders(request: FastifyRequest): void {
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    const name = request.raw.rawHeaders[index]?.toLowerCase();
    if (name !== undefined && forbiddenClientAuthorityHeaders.has(name)) {
      throw ApiError.invalidRequest();
    }
  }
}

const noRawBodyOrClientAuthorityGuard: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    assertNoRawRequestBody(request);
    assertNoClientAuthorityHeaders(request);
  } catch (error) {
    done(error instanceof Error ? error : ApiError.invalidRequest());
    return;
  }

  done();
};

const forbidClientAuthorityHeaders: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    assertNoClientAuthorityHeaders(request);
  } catch (error) {
    done(error instanceof Error ? error : ApiError.invalidRequest());
    return;
  }
  done();
};

function assertStrictPostInput(
  request: FastifyRequest,
  parse: (value: unknown) => unknown,
): Promise<void> {
  if (Object.keys(request.query as Record<string, unknown>).length > 0) {
    throw ApiError.invalidRequest();
  }

  try {
    parse(request.body);
  } catch {
    throw ApiError.invalidRequest();
  }

  return Promise.resolve();
}

function assertRecipientPreflightInput(request: FastifyRequest): Promise<void> {
  return assertStrictPostInput(request, parseRecipientPreflightRequest);
}

function assertPrepareReviewInput(request: FastifyRequest): Promise<void> {
  return assertStrictPostInput(request, parsePrepareTransferReviewRequest);
}

function assertTransferAuthorizationInput(
  request: FastifyRequest,
): Promise<void> {
  return assertStrictPostInput(request, parseTransferAuthorizationRequest);
}

function requestContext(request: FastifyRequest): TransferRequestContext {
  return Object.freeze({
    principal: requireAuthenticatedLoopPrincipal(request),
    requestId: request.id,
    signal: request.signal,
  });
}

function mapTransferError(error: unknown): never {
  if (error instanceof TransferUnavailableError) {
    throw ApiError.transferUnavailable();
  }

  throw error;
}

export function registerTransferRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: TransferService,
): void {
  app.get(
    "/v1/transfer/assets",
    {
      schema: {
        operationId: "listTransferAssets",
        summary: "List same-chain transfer assets",
        description:
          "Reserves the reviewed transfer-asset interface. Provider execution remains unavailable until its exact nested response contract and credentialed evidence are approved.",
        tags: ["transfer"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: transferErrors,
      },
      onRequest: noRawBodyOrClientAuthorityGuard,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      try {
        await service.listAssets(requestContext(request));
      } catch (error) {
        mapTransferError(error);
      }
      throw ApiError.transferUnavailable();
    },
  );

  app.post(
    "/v1/transfer/recipient-preflight",
    {
      schema: {
        operationId: "runTransferRecipientPreflight",
        summary: "Resolve or acknowledge a transfer recipient",
        description:
          "Accepts only the reviewed resolve and acknowledge top-level variants. It creates no session or provider state while transfer capability is unavailable.",
        tags: ["transfer"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        body: recipientPreflightBodySchema,
        response: transferErrors,
      },
      onRequest: forbidClientAuthorityHeaders,
      preValidation: assertRecipientPreflightInput,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const context = requestContext(request);
      reply.header("cache-control", "no-store");
      try {
        await service.recipientPreflight({
          ...context,
          body: parseRecipientPreflightRequest(request.body),
        });
      } catch (error) {
        mapTransferError(error);
      }
      throw ApiError.transferUnavailable();
    },
  );

  app.post(
    "/v1/transfer/reviews",
    {
      schema: {
        operationId: "prepareTransferReview",
        summary: "Prepare a same-chain transfer review",
        description:
          "Reserves the reviewed preflight-handle and amount keys without inventing an unresolved review or handle representation.",
        tags: ["transfer"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        body: prepareReviewBodySchema,
        response: transferErrors,
      },
      onRequest: forbidClientAuthorityHeaders,
      preValidation: assertPrepareReviewInput,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const context = requestContext(request);
      reply.header("cache-control", "no-store");
      try {
        await service.prepareReview({
          ...context,
          body: parsePrepareTransferReviewRequest(request.body),
        });
      } catch (error) {
        mapTransferError(error);
      }
      throw ApiError.transferUnavailable();
    },
  );

  app.post(
    "/v1/transfer/authorize",
    {
      schema: {
        operationId: "authorizeTransfer",
        summary: "Issue or submit a transfer authorization handoff",
        description:
          "Accepts only the reviewed private issue-payload and submit-signature top-level variants. No formatter, signer, session, or provider call is composed.",
        tags: ["transfer"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        body: transferAuthorizationBodySchema,
        response: transferErrors,
      },
      onRequest: forbidClientAuthorityHeaders,
      preValidation: assertTransferAuthorizationInput,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const context = requestContext(request);
      reply.header("cache-control", "no-store");
      try {
        await service.authorize({
          ...context,
          body: parseTransferAuthorizationRequest(request.body),
        });
      } catch (error) {
        mapTransferError(error);
      }
      throw ApiError.transferUnavailable();
    },
  );

  app.get(
    "/v1/transfer/current-result",
    {
      schema: {
        operationId: "getCurrentTransferResult",
        summary: "Get the authenticated owner's current transfer result",
        description:
          "Accepts no caller-selected handle, cursor, action, or submission ID. The route remains unavailable until native current-result selection is defined.",
        tags: ["transfer"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: transferErrors,
      },
      onRequest: noRawBodyOrClientAuthorityGuard,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      try {
        await service.readCurrentResult(requestContext(request));
      } catch (error) {
        mapTransferError(error);
      }
      throw ApiError.transferUnavailable();
    },
  );

  app.get(
    "/v1/transfer/reconciliation",
    {
      schema: {
        operationId: "getTransferReconciliation",
        summary: "Get the authenticated owner's transfer reconciliation",
        description:
          "Accepts no caller-selected handle or cursor. The route remains unavailable because the public reconciliation state DTO is not fixed.",
        tags: ["transfer"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: transferErrors,
      },
      onRequest: noRawBodyOrClientAuthorityGuard,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      try {
        await service.readReconciliation(requestContext(request));
      } catch (error) {
        mapTransferError(error);
      }
      throw ApiError.transferUnavailable();
    },
  );
}
