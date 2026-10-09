import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../config.js";
import { errorResponseSchema } from "../core/http/schemas.js";
import type { Database } from "../database/database.js";

const liveResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "service", "version"],
  properties: {
    status: { type: "string", const: "ok" },
    service: { type: "string", const: "loop-api" },
    version: { type: "string", minLength: 1 },
  },
} as const;

const readyResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "checks"],
  properties: {
    status: { type: "string", enum: ["ready", "not_ready"] },
    checks: {
      type: "object",
      additionalProperties: false,
      required: ["database"],
      properties: {
        database: { type: "string", enum: ["up", "down"] },
      },
    },
  },
} as const;

export function registerHealthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  database: Database,
): void {
  app.get(
    "/health/live",
    {
      schema: {
        operationId: "getLiveness",
        summary: "Report whether the HTTP process is alive",
        tags: ["health"],
        response: {
          200: liveResponseSchema,
          503: errorResponseSchema(["request_timeout"]),
          500: errorResponseSchema(["internal_error"]),
        },
      },
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return {
        status: "ok" as const,
        service: config.serviceName,
        version: config.serviceVersion,
      };
    },
  );

  app.get(
    "/health/ready",
    {
      schema: {
        operationId: "getReadiness",
        summary: "Report whether required infrastructure is reachable",
        tags: ["health"],
        response: {
          200: readyResponseSchema,
          503: {
            oneOf: [
              readyResponseSchema,
              errorResponseSchema(["request_timeout"]),
            ],
          },
          500: errorResponseSchema(["internal_error"]),
        },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");

      try {
        await database.ping();
        return {
          status: "ready" as const,
          checks: { database: "up" as const },
        };
      } catch {
        request.log.warn(
          { requestId: request.id },
          "Readiness database probe failed",
        );
        return reply.code(503).send({
          status: "not_ready" as const,
          checks: { database: "down" as const },
        });
      }
    },
  );
}
