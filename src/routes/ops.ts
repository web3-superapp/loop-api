import type { OpsMiningRuntime } from "../features/ops/ops-mining-job.js";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { requireAuthenticatedLoopPrincipal } from "../core/http/authentication.js";
import {
  OpsError,
  opsCommandSchema,
  opsListFiltersSchema,
  type OpsListFilters,
  type OpsRepository,
} from "../features/ops/ops-contract.js";
import { opsCatalog } from "../features/ops/ops-catalog.js";

export function registerOpsRoutes(
  app: FastifyInstance,
  options: {
    authenticate: preHandlerAsyncHookHandler;
    repository: OpsRepository | undefined;
    enabled: boolean;
    miningRuntime?: OpsMiningRuntime;
  },
): void {
  void app.register((scope) => {
    scope.addHook("onSend", async (_request, reply, payload) => {
      reply.header("cache-control", "no-store");
      return payload;
    });
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof OpsError)
        return reply.code(error.statusCode).send({ code: error.code });
      if (error instanceof z.ZodError)
        return reply.code(400).send({ code: "OPS_INVALID_INPUT" });
      if (
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        typeof error.statusCode === "number" &&
        error.statusCode < 500
      )
        return reply.code(error.statusCode).send({
          code:
            error.statusCode === 401
              ? "AUTHENTICATION_REQUIRED"
              : "OPS_REQUEST_REJECTED",
        });
      return reply.code(503).send({ code: "OPS_UNAVAILABLE" });
    });
    scope.addHook("preHandler", options.authenticate);
    scope.addHook("preHandler", () => {
      if (!options.enabled || !options.repository)
        throw new OpsError("OPS_UNAVAILABLE", 503);
      return Promise.resolve();
    });
    const repo = () => {
      if (!options.repository) throw new OpsError("OPS_UNAVAILABLE", 503);
      return options.repository;
    };
    const schema = {
      tags: ["Operations"],
      security: [{ privyBearer: [] }],
      response: { 200: { type: "object", additionalProperties: true } },
    };
    scope.get(
      "/ops/api/session",
      { schema: { ...schema, operationId: "opsSession" } },
      async (req) =>
        repo().session(requireAuthenticatedLoopPrincipal(req).userId),
    );
    scope.get(
      "/ops/api/catalog",
      { schema: { ...schema, operationId: "opsCatalog" } },
      async (req) => {
        await repo().session(requireAuthenticatedLoopPrincipal(req).userId);
        return { items: opsCatalog };
      },
    );
    scope.get<{
      Params: { resource: string };
      Querystring: { before?: string } & OpsListFilters;
    }>(
      "/ops/api/resources/:resource",
      {
        schema: {
          ...schema,
          operationId: "opsResources",
          params: {
            type: "object",
            additionalProperties: false,
            required: ["resource"],
            properties: {
              resource: {
                type: "string",
                enum: [
                  "mining",
                  "drafts",
                  "weights",
                  "snapshots",
                  "communities",
                  "support",
                  "audit",
                ],
              },
            },
          },
          querystring: {
            type: "object",
            additionalProperties: false,
            properties: {
              before: { type: "string", maxLength: 128 },
              ...z.toJSONSchema(opsListFiltersSchema, { target: "draft-7" })
                .properties,
            },
          },
        },
      },
      async (req) =>
        repo().list(
          requireAuthenticatedLoopPrincipal(req).userId,
          req.params.resource,
          req.query.before,
          opsListFiltersSchema.parse(
            Object.fromEntries(
              Object.entries(req.query).filter(([key]) => key !== "before"),
            ),
          ),
        ),
    );
    scope.get<{ Params: { id: string } }>(
      "/ops/api/operations/:id",
      {
        schema: {
          ...schema,
          operationId: "opsOperation",
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", format: "uuid" } },
            additionalProperties: false,
          },
        },
      },
      async (req) =>
        repo().operation(
          requireAuthenticatedLoopPrincipal(req).userId,
          req.params.id,
        ),
    );
    const jobParams = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", format: "uuid" } },
      additionalProperties: false,
    };
    scope.get<{ Params: { id: string } }>(
      "/ops/api/jobs/:id",
      { schema: { ...schema, operationId: "opsJob", params: jobParams } },
      async (req) =>
        repo().job(
          requireAuthenticatedLoopPrincipal(req).userId,
          req.params.id,
        ),
    );
    scope.post<{ Params: { id: string } }>(
      "/ops/api/jobs/:id/run",
      { schema: { ...schema, operationId: "opsRunJob", params: jobParams } },
      async (req) => {
        if (!options.miningRuntime)
          throw new OpsError("OPS_MINING_RUNTIME_UNAVAILABLE", 503);
        return repo().runJob(
          requireAuthenticatedLoopPrincipal(req).userId,
          req.params.id,
          options.miningRuntime,
        );
      },
    );
    const body = z.toJSONSchema(opsCommandSchema, { target: "draft-7" });
    delete body.$schema;
    scope.post(
      "/ops/api/commands",
      {
        bodyLimit: 262144,
        schema: { ...schema, operationId: "opsCommand", body },
      },
      async (req) =>
        repo().execute(
          requireAuthenticatedLoopPrincipal(req).userId,
          opsCommandSchema.parse(req.body),
        ),
    );
    return Promise.resolve();
  });
}
