import { randomUUID } from "node:crypto";

import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import Fastify, {
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
import { createBootstrapService } from "./features/identity/bootstrap-service.js";
import {
  createPrivyAccessTokenVerifier,
  createUnavailablePrivyAccessTokenVerifier,
  type PrivyAccessTokenVerifier,
} from "./integrations/privy/access-token-verifier.js";
import { registerBootstrapRoute } from "./routes/bootstrap.js";
import { registerHealthRoutes } from "./routes/health.js";

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly database?: Database;
  readonly privyAccessTokenVerifier?: PrivyAccessTokenVerifier;
  readonly logger?: false;
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
    bodyLimit: 1_048_576,
    connectionTimeout: 10_000,
    genReqId: () => randomUUID(),
    handlerTimeout: 15_000,
    keepAliveTimeout: 72_000,
    logger: options.logger === false ? false : loggerOptions(config),
    requestIdHeader: false,
    requestTimeout: 15_000,
    trustProxy: config.trustProxy,
  };
  const app = Fastify(fastifyOptions);

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
