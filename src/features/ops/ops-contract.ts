import type { OpsMiningRuntime } from "./ops-mining-job.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  miningFormulaDocumentSchema,
  miningWeightRangeDocumentSchema,
  miningPriceGuardRulesSchema,
  configVersionPatternSource,
} from "../mining/mining-contract.js";

export const opsPermissions = [
  "audit.read",
  "mining.read",
  "mining.edit",
  "mining.approve",
  "mining.snapshot",
  "community.review",
  "support.manage",
  "launch.read",
  "launch.edit",
  "launch.approve",
  "testnet.read",
  "testnet.accept",
] as const;
export type OpsPermission = (typeof opsPermissions)[number];
export class OpsError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(code);
  }
}
export const miningPackageSchema = z
  .object({
    configVersion: z.string().regex(new RegExp(configVersionPatternSource)),
    formula: miningFormulaDocumentSchema,
    weightRange: miningWeightRangeDocumentSchema,
    priceGuardRules: miningPriceGuardRulesSchema,
    communityWeights: z
      .array(
        z
          .object({
            communityId: z.uuid(),
            boundAssetId: z
              .string()
              .regex(/^eip155:[1-9][0-9]{0,9}:(0x[0-9a-f]{40}|native)$/),
            weight: z.string().regex(/^(0|[1-9]\d{0,10})(\.\d{1,18})?$/),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.communityWeights.map((w) => w.communityId)).size ===
      value.communityWeights.length,
    "Duplicate community",
  );
export type MiningPackage = z.infer<typeof miningPackageSchema>;
const hooksLaunchAdminConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    ticker: z.string().regex(/^[A-Za-z0-9]{2,12}$/),
    logoAssetUrl: z.url().startsWith("https://"),
    description: z.string().max(2000),
    links: z.array(z.url().startsWith("https://")).max(8),
    nftSaleStartAt: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
    buybackRecipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  })
  .strict();
const hash32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const hooksTestnetAcceptanceSchema = z
  .object({
    configVersion: z.number().int().positive(),
    configHash: hash32Schema,
    contractManifestHash: hash32Schema,
    checklistVersion: z.string().regex(/^hooks-testnet-v[1-9][0-9]*$/),
    outcome: z.enum(["passed", "failed", "incomplete"]),
    evidence: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(100),
            uri: z.union([
              z.url().startsWith("https://"),
              z.string().regex(/^0x[0-9a-fA-F]{64}$/),
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
const base = {
  operationId: z.uuid(),
  target: z.string().min(1).max(128),
  reason: z.string().trim().min(1).max(500),
};
export const opsCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...base,
      action: z.literal("launch.config.save"),
      payload: z
        .object({
          expectedVersion: z.number().int().nonnegative(),
          config: hooksLaunchAdminConfigSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("launch.config.approve"),
      payload: z
        .object({
          configVersion: z.number().int().positive(),
          configHash: hash32Schema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("testnet.acceptance.record"),
      payload: hooksTestnetAcceptanceSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("mining.create"),
      payload: miningPackageSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("mining.revise"),
      payload: z
        .object({
          expectedRevision: z.number().int().positive(),
          package: miningPackageSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("mining.submit"),
      payload: z
        .object({ expectedRevision: z.number().int().positive() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("mining.publish"),
      payload: z
        .object({
          expectedRevision: z.number().int().positive(),
          contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          expectedActiveVersion: z.string().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("community.review"),
      payload: z
        .object({
          outcome: z.enum(["verified", "rejected"]),
          expectedVersion: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("support.answer"),
      payload: z
        .object({
          status: z.enum(["answered", "closed"]),
          note: z.string().trim().min(1).max(4000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("mining.snapshot"),
      payload: z
        .object({ expectedActiveVersion: z.string().min(1).max(128) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("mining.trial"),
      payload: z
        .object({
          expectedRevision: z.number().int().positive(),
          contentHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("mining.invalidate"),
      payload: z
        .object({ snapshotIds: z.array(z.uuid()).min(1).max(100) })
        .strict(),
    })
    .strict(),
]);
export type OpsCommand = z.infer<typeof opsCommandSchema>;
export function commandPermission(action: OpsCommand["action"]): OpsPermission {
  if (action === "launch.config.save") return "launch.edit";
  if (action === "launch.config.approve") return "launch.approve";
  if (action === "testnet.acceptance.record") return "testnet.accept";
  if (action === "community.review") return "community.review";
  if (action === "support.answer") return "support.manage";
  if (action === "mining.publish") return "mining.approve";
  if (action === "mining.invalidate" || action === "mining.snapshot")
    return "mining.snapshot";
  return "mining.edit";
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(",")}}`;
  const encoded: unknown = JSON.stringify(value);
  if (typeof encoded !== "string")
    throw new OpsError("OPS_INVALID_CONTENT", 400);
  return encoded;
}
export function opsHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export const opsListFiltersSchema = z
  .object({
    configVersion: z
      .string()
      .regex(new RegExp(configVersionPatternSource))
      .optional(),
    actorId: z.uuid().optional(),
    target: z.string().min(1).max(128).optional(),
    action: z.string().min(1).max(128).optional(),
    outcome: z.enum(["succeeded", "rejected", "unknown"]).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type OpsListFilters = z.infer<typeof opsListFiltersSchema>;
export interface OpsRepository {
  session(actor: string): Promise<unknown>;
  list(
    actor: string,
    resource: string,
    before?: string,
    filters?: OpsListFilters,
  ): Promise<unknown>;
  execute(actor: string, command: OpsCommand): Promise<unknown>;
  operation(actor: string, id: string): Promise<unknown>;
  job(actor: string, id: string): Promise<unknown>;
  runJob(
    actor: string,
    id: string,
    runtime: OpsMiningRuntime,
  ): Promise<unknown>;
}
