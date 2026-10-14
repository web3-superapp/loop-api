import type { FastifyInstance } from "fastify";

import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { adminApiPrefix } from "../../features/admin/admin-contract.js";
import type { AdminChainGuardService } from "../../features/admin/admin-chain-guard.js";
import type { AdminPermission } from "../../features/admin/admin-roles.js";
import { chainGuardIncidentKinds } from "../../features/chain-guard/chain-guard-contract.js";
import {
  adminErrors,
  adminSecurity,
  guardedSessionErrors,
} from "./admin-schemas.js";
import type { AdminRouteGuard } from "./index.js";

/**
 * Decision 0134 console route: `GET /admin/v1/chain-guard/incidents`, the
 * unresolved chain guard incidents (console.read).
 */

export interface AdminChainGuardRouteDependencies {
  readonly service: AdminChainGuardService;
  readonly guard: (permission: AdminPermission) => AdminRouteGuard;
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
}
