import type { FastifyInstance, FastifyRequest } from "fastify";

import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { adminApiPrefix } from "../../features/admin/admin-contract.js";
import type { AdminChainGuardService } from "../../features/admin/admin-chain-guard.js";
import type { AdminPermission } from "../../features/admin/admin-roles.js";
import type { AdminWriteContext } from "../../features/admin/admin-service.js";
import { chainGuardIncidentKinds } from "../../features/chain-guard/chain-guard-contract.js";
import {
  adminErrors,
  adminSecurity,
  guardedSessionErrors,
} from "./admin-schemas.js";
import type { AdminRouteGuard } from "./index.js";

/**
 * Decision 0134 console route: `GET /admin/v1/chain-guard/incidents`, the
 * unresolved chain guard incidents (console.read). Decision 0135:
 * `POST …/incidents/{incidentId}/resolve` closes one by hand
 * (console.write, audited).
 */

export interface AdminChainGuardRouteDependencies {
  readonly service: AdminChainGuardService;
  readonly guard: (permission: AdminPermission) => AdminRouteGuard;
  readonly context: (request: FastifyRequest) => AdminWriteContext;
}

const kindSchema = {
  type: "string",
  enum: [...chainGuardIncidentKinds],
} as const;

const incidentSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "incidentId",
    "kind",
    "subject",
    "details",
    "firstSeenAt",
    "lastSeenAt",
    "hold",
  ],
  properties: {
    incidentId: { type: "string", format: "uuid" },
    kind: kindSchema,
    subject: {
      type: "string",
      pattern: "^0x([0-9a-f]{40}|[0-9a-f]{64})$",
    },
    details: { type: "object", additionalProperties: true },
    firstSeenAt: { type: "string", format: "date-time" },
    lastSeenAt: { type: "string", format: "date-time" },
    hold: { type: "boolean" },
  },
} as const;

const resourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["chainId", "holdActive", "holdKinds", "items", "generatedAt"],
  properties: {
    chainId: { type: "string", pattern: "^eip155:[1-9][0-9]*$" },
    holdActive: { type: "boolean" },
    holdKinds: { type: "array", items: kindSchema },
    items: { type: "array", items: incidentSchema, maxItems: 200 },
    generatedAt: { type: "string", format: "date-time" },
  },
} as const;

const resolvedIncidentSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    ...incidentSchema.required,
    "resolvedAt",
    "resolution",
    "resolvedBy",
    "resolutionNote",
    "reopensIfStillTrue",
  ],
  properties: {
    ...incidentSchema.properties,
    resolvedAt: { type: "string", format: "date-time" },
    resolution: { type: "string", enum: ["auto", "manual"] },
    resolvedBy: {
      anyOf: [{ type: "string", format: "uuid" }, { type: "null" }],
    },
    resolutionNote: {
      anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }],
    },
    reopensIfStillTrue: { type: "boolean" },
  },
} as const;

const resolveResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["incident", "audit"],
  properties: {
    incident: resolvedIncidentSchema,
    audit: {
      type: "object",
      additionalProperties: false,
      required: ["auditId", "seq", "at"],
      properties: {
        auditId: { type: "string", format: "uuid" },
        seq: { type: "integer" },
        at: { type: "string", format: "date-time" },
      },
    },
  },
} as const;

export function registerAdminChainGuardRoutes(
  app: FastifyInstance,
  dependencies: AdminChainGuardRouteDependencies,
): void {
  app.get(
    `${adminApiPrefix}/chain-guard/incidents`,
    {
      schema: {
        operationId: "listAdminChainGuardIncidents",
        summary: "List unresolved chain guard incidents",
        description:
          "Decision 0134: the unresolved incidents the read-only `chain_guard` worker lane recorded on the launch chain, newest sighting first (≤ 200): USD1 paused / one of our addresses frozen (`hold: true` — the buyback keeper, Hooks executor, and poke keeper skip their ticks with CHAIN_GUARD_HOLD while any is open), USD1 implementation / ProxyAdmin / owner changes, frozen funds drained or reallocated, the Uniswap v4 protocol fee controller changed or a protocol fee on one of our pools (nonzero; ≥ CHAIN_GUARD_PROTOCOL_FEE_ALERT_PIPS = high), a USD1 read the token does not implement on mainnet, a signer account under CHAIN_GUARD_MIN_BNB. `subject` is the chain fact (lower-case address or pool id); `details` holds the readings (amounts as decimal strings). An empty list means the lane recorded nothing open — it does not say the lane is running (see the worker log). Without the database: 503 CAPABILITY_UNAVAILABLE (CHAIN_GUARD_REPOSITORY_UNAVAILABLE). console.read.",
        tags: ["admin-chain-guard"],
        security: adminSecurity,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        response: {
          200: resourceSchema,
          ...adminErrors(...guardedSessionErrors, "CAPABILITY_UNAVAILABLE"),
        },
      },
      ...dependencies.guard("console.read"),
    },
    async (_request, reply) => {
      const resource = await dependencies.service.listIncidents();
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    `${adminApiPrefix}/chain-guard/incidents/:incidentId/resolve`,
    {
      schema: {
        operationId: "resolveAdminChainGuardIncident",
        summary: "Resolve a chain guard incident by hand",
        description:
          "Decision 0135: closes one unresolved incident of the launch chain with a note (1–500 characters, trimmed; control characters refused: 422 VALIDATION_FAILED CHAIN_GUARD_RESOLUTION_NOTE_INVALID). Records resolution = manual, resolvedBy (the console account id; null for the ADMIN_USERNAME bootstrap administrator), resolutionNote, and one admin_audit_log row (`chain_guard.incident.resolve`, target chain_guard_incident) in the same transaction. Unknown incident (or another chain's): 404 NOT_FOUND CHAIN_GUARD_INCIDENT_NOT_FOUND. Already resolved (auto or manual): 409 ADMIN_CONFLICT CHAIN_GUARD_INCIDENT_ALREADY_RESOLVED, nothing written. A condition kind (USD1 paused / an address frozen / USD1 mismatch / implementation / fee controller / protocol fee or fee policy / balance; `reopensIfStillTrue: true`) whose fact still holds is opened again as a new incident by the lane's next tick — expected: resolving does not silence a live condition, and a resolved hold incident releases the signing lanes only until then. Event kinds (drained / reallocated / upgraded / admin or owner changed) stay closed. The optional webhook / Telegram outlets announce the resolve. Without the database: 503 CAPABILITY_UNAVAILABLE (CHAIN_GUARD_REPOSITORY_UNAVAILABLE). console.write (platform_admin).",
        tags: ["admin-chain-guard"],
        security: adminSecurity,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["incidentId"],
          properties: { incidentId: { type: "string", maxLength: 64 } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["note"],
          properties: {
            note: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
        response: {
          200: resolveResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "NOT_FOUND",
            "ADMIN_CONFLICT",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...dependencies.guard("console.write"),
    },
    async (request, reply) => {
      const { incidentId } = request.params as { readonly incidentId: string };
      const resource = await dependencies.service.resolveIncident(
        dependencies.context(request),
        incidentId,
        request.body,
      );
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
