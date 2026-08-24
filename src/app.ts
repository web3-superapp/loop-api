import { randomUUID } from "node:crypto";

import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import type { AppConfig } from "./config.js";
import { ApiError } from "./core/http/api-error.js";
import {
  createAuthenticationService,
  registerAuthenticationHooks,
} from "./core/http/authentication.js";
import { createPostgresDatabase, type Database } from "./database/database.js";
import {
  createStreamTokenService,
  StreamTokenUnavailableError,
  type StreamTokenService,
} from "./features/communication/stream-token-service.js";
import { createBootstrapService } from "./features/identity/bootstrap-service.js";
import { createPerpPrivateReadCursorCodec } from "./features/perp/private-read-cursor.js";
import { createPerpPrivateReadService } from "./features/perp/private-read-service.js";
import {
  createAgentAuthorizationService,
  type AgentAuthorizationMutationGate,
} from "./features/perp/agent-authorization-service.js";
import {
  createPerpIntentService,
  type PerpMutationGate,
} from "./features/perp/perp-intent-service.js";
import {
  createUnavailablePerpWalletBindingResolver,
  type PerpWalletBindingResolver,
} from "./features/perp/wallet-binding-resolver.js";
import {
  createUnavailableHyperliquidPrivateReader,
  type HyperliquidPrivateReader,
} from "./integrations/hyperliquid/private-reader.js";
import {
  createUnavailableHyperliquidPerpIntentReviewer,
  type HyperliquidPerpIntentReviewer,
} from "./integrations/hyperliquid/perp-intent-reviewer.js";
import {
  createUnavailableStreamTokenIssuer,
  type StreamTokenIssuer,
} from "./integrations/stream/token-issuer.js";
import {
  createPrivyAccessTokenVerifier,
  createUnavailablePrivyAccessTokenVerifier,
  type PrivyAccessTokenVerifier,
} from "./integrations/privy/access-token-verifier.js";
import { registerBootstrapRoute } from "./routes/bootstrap.js";
import { registerAgentAuthorizationRoutes } from "./routes/agent-authorizations.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPerpPrivateReadRoutes } from "./routes/perp-private-reads.js";
import { registerPerpIntentRoutes } from "./routes/perp-intents.js";
import { registerStreamTokenRoutes } from "./routes/stream-tokens.js";

const localCloudflaredProxyCidrs = ["127.0.0.0/8", "::1/128"];

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly database?: Database;
  readonly privyAccessTokenVerifier?: PrivyAccessTokenVerifier;
  readonly streamTokenIssuer?: StreamTokenIssuer;
  readonly perpWalletBindingResolver?: PerpWalletBindingResolver;
  readonly hyperliquidPrivateReader?: HyperliquidPrivateReader;
  readonly hyperliquidPerpIntentReviewer?: HyperliquidPerpIntentReviewer;
  readonly perpMutationGate?: PerpMutationGate;
  readonly agentAuthorizationMutationGate?: AgentAuthorizationMutationGate;
  readonly logger?: FastifyServerOptions["logger"];
}

function createUnavailableStreamTokenService(): StreamTokenService {
  return Object.freeze({
    issueToken: () => Promise.reject(new StreamTokenUnavailableError()),
  });
}

function classifyRequestError(error: unknown): {
  readonly code: string | undefined;
  readonly hasValidation: boolean;
  readonly statusCode: number | undefined;
} {
  if (typeof error !== "object" || error === null) {
    return { code: undefined, hasValidation: false, statusCode: undefined };
  }

  const code =
    "code" in error && typeof error.code === "string" ? error.code : undefined;
  const statusCode =
    "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
  const hasValidation = "validation" in error && error.validation !== undefined;
  return { code, hasValidation, statusCode };
}

function loggerOptions(
  config: AppConfig,
): NonNullable<FastifyServerOptions["logger"]> {
  if (config.nodeEnv === "test" || config.logLevel === "silent") {
    return false;
  }

  return {
    level: config.logLevel,
    redact: {
      censor: "[REDACTED]",
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        "appSecret",
        "privy.appSecret",
        "config.privy.appSecret",
        "PRIVY_APP_SECRET",
        "apiSecret",
        "stream.apiSecret",
        "config.stream.apiSecret",
        "STREAM_API_SECRET",
        "hmacSecret",
        "streamTokenQuota.hmacSecret",
        "config.streamTokenQuota.hmacSecret",
        "STREAM_TOKEN_QUOTA_HMAC_SECRET",
        "perpReadCursor.hmacSecret",
        "config.perpReadCursor.hmacSecret",
        "PERP_READ_CURSOR_HMAC_SECRET",
        "req.body.signature",
        "req.body.typed_data_json",
        "req.body.typedDataJson",
        "signing_request",
        "typed_data_json",
        "typedDataJson",
      ],
    },
    ...(config.nodeEnv === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, singleLine: true },
          },
        }
      : {}),
  };
}

export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  const { config } = options;
  const fastifyOptions: FastifyServerOptions = {
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
    bodyLimit: 1_048_576,
    connectionTimeout: 10_000,
    exposeHeadRoutes: false,
    genReqId: () => randomUUID(),
    handlerTimeout: 15_000,
    keepAliveTimeout: 72_000,
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? loggerOptions(config),
    requestIdHeader: false,
    requestTimeout: 15_000,
    trustProxy: config.trustProxy ? localCloudflaredProxyCidrs : false,
  };
  const app = Fastify(fastifyOptions);

  app.addHook("onRequest", (request, _reply, done) => {
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
      },
      "Request received",
    );
    done();
  });

  app.addHook("onResponse", (request, reply, done) => {
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        responseTimeMs: reply.elapsedTime,
      },
      "Request completed",
    );
    done();
  });

  await app.register(swagger, {
    hideUntagged: true,
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "LOOP API",
        description:
          "Private Backend-for-Frontend for LOOP. Provider routes fail closed until configured and verified.",
        version: config.serviceVersion,
      },
      servers: [{ url: config.publicBaseUrl.replace(/\/$/, "") }],
      tags: [
        { name: "health", description: "Process and dependency health" },
        {
          name: "identity",
          description: "Authenticated internal identity bootstrap",
        },
        {
          name: "communication",
          description: "Authenticated Stream Chat and Video token issuance",
        },
        {
          name: "perp",
          description:
            "Authenticated Hyperliquid Testnet Core perpetual interfaces",
        },
      ],
      components: {
        securitySchemes: {
          privyBearer: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Current Privy access token",
          },
        },
      },
    },
  });

  await app.register(helmet);

  const privyAccessTokenVerifier =
    options.privyAccessTokenVerifier ??
    (config.privy === null
      ? createUnavailablePrivyAccessTokenVerifier()
      : createPrivyAccessTokenVerifier(config.privy));
  const database = options.database ?? createPostgresDatabase(config, app.log);
  const authenticationService = createAuthenticationService(
    privyAccessTokenVerifier,
    database.internalUsers,
  );
  const authenticationHooks = registerAuthenticationHooks(
    app,
    authenticationService,
  );
  const bootstrapService = createBootstrapService(database.internalUsers);
  const streamTokenIssuer =
    options.streamTokenIssuer ?? createUnavailableStreamTokenIssuer();
  const streamTokenService =
    config.streamTokenQuota === null
      ? createUnavailableStreamTokenService()
      : createStreamTokenService({
          issuer: streamTokenIssuer,
          quota: database.controlPlane,
          quotaHmacSecret: new TextEncoder().encode(
            config.streamTokenQuota.hmacSecret,
          ),
          policy: {
            policyVersion: config.streamTokenQuota.policyVersion,
            quotaByProduct: {
              chat: {
                user: {
                  capacity: config.streamTokenQuota.userCapacity,
                  windowDurationSeconds:
                    config.streamTokenQuota.windowDurationSeconds,
                },
                ip: {
                  capacity: config.streamTokenQuota.ipCapacity,
                  windowDurationSeconds:
                    config.streamTokenQuota.windowDurationSeconds,
                },
              },
              video: {
                user: {
                  capacity: config.streamTokenQuota.userCapacity,
                  windowDurationSeconds:
                    config.streamTokenQuota.windowDurationSeconds,
                },
                ip: {
                  capacity: config.streamTokenQuota.ipCapacity,
                  windowDurationSeconds:
                    config.streamTokenQuota.windowDurationSeconds,
                },
              },
            },
          },
        });
  const perpWalletBindingResolver =
    options.perpWalletBindingResolver ??
    createUnavailablePerpWalletBindingResolver();
  const hyperliquidPrivateReader =
    options.hyperliquidPrivateReader ??
    createUnavailableHyperliquidPrivateReader();
  const perpPrivateReadCursorCodec =
    config.perpReadCursor === null
      ? null
      : createPerpPrivateReadCursorCodec({
          secret: new TextEncoder().encode(config.perpReadCursor.hmacSecret),
          ttlSeconds: config.perpReadCursor.ttlSeconds,
        });
  const perpPrivateReadService = createPerpPrivateReadService({
    bindingResolver: perpWalletBindingResolver,
    cursorCodec: perpPrivateReadCursorCodec,
    reader: hyperliquidPrivateReader,
  });
  const perpIntentService = createPerpIntentService({
    repository: database.perpIntents,
    bindingResolver: perpWalletBindingResolver,
    reviewer:
      options.hyperliquidPerpIntentReviewer ??
      createUnavailableHyperliquidPerpIntentReviewer(),
    ...(options.perpMutationGate === undefined
      ? {}
      : { mutationGate: options.perpMutationGate }),
  });
  const agentAuthorizationService = createAgentAuthorizationService({
    repository: database.agentAuthorizations,
    ...(options.agentAuthorizationMutationGate === undefined
      ? {}
      : { mutationGate: options.agentAuthorizationMutationGate }),
  });

  app.addHook("onClose", async () => {
    await database.close();
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  registerHealthRoutes(app, config, database);
  registerBootstrapRoute(
    app,
    authenticationHooks.authenticatePrivyBearer,
    bootstrapService,
  );
  registerStreamTokenRoutes(
    app,
    authenticationHooks.authenticateLoopBearer,
    streamTokenService,
  );
  registerPerpPrivateReadRoutes(
    app,
    authenticationHooks.authenticateLoopBearer,
    perpPrivateReadService,
  );
  registerPerpIntentRoutes(
    app,
    authenticationHooks.authenticateLoopBearer,
    perpIntentService,
  );
  registerAgentAuthorizationRoutes(
    app,
    authenticationHooks.authenticateLoopBearer,
    agentAuthorizationService,
  );

  if (config.apiDocsEnabled) {
    app.get(
      "/openapi.json",
      {
        schema: {
          hide: true,
        },
      },
      async (_request, reply) => {
        reply.header("cache-control", "no-store");
        return app.swagger();
      },
    );
  }

  app.setNotFoundHandler(async (request, reply) => {
    reply.header("cache-control", "no-store");
    return reply.code(404).send({
      code: "not_found",
      message: "The requested resource does not exist.",
      request_id: request.id,
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    const details = classifyRequestError(error);
    const apiError = error instanceof ApiError ? error : undefined;
    const isHandlerTimeout = details.code === "FST_ERR_HANDLER_TIMEOUT";
    const isClientError =
      details.statusCode !== undefined &&
      details.statusCode >= 400 &&
      details.statusCode < 500;
    const isRequestInputError =
      details.hasValidation ||
      details.statusCode === 400 ||
      details.statusCode === 413 ||
      details.statusCode === 415;
    const statusCode = apiError
      ? apiError.statusCode
      : isHandlerTimeout
        ? 503
        : isRequestInputError
          ? 400
          : isClientError
            ? details.statusCode
            : 500;
    const code = apiError
      ? apiError.code
      : isHandlerTimeout
        ? "request_timeout"
        : isRequestInputError
          ? "invalid_request"
          : "internal_error";
    const message = apiError
      ? apiError.safeMessage
      : isHandlerTimeout
        ? "The request timed out."
        : code === "invalid_request"
          ? "The request is invalid."
          : "The request could not be completed.";

    request.log.warn(
      {
        requestId: request.id,
        responseCode: code,
        statusCode,
      },
      "Request failed",
    );

    reply.header("cache-control", "no-store");
    if (apiError?.includeBearerChallenge === true) {
      reply.header("www-authenticate", 'Bearer realm="loop-api"');
    }
    return reply.code(statusCode).send({
      code,
      message,
      request_id: request.id,
    });
  });

  return app;
}
