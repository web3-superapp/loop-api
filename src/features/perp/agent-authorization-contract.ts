import { createHash } from "node:crypto";

import { z } from "zod";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const lowercaseAddressPattern = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const agentNamePattern = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;
const safeReasonCodePattern = /^[a-z][a-z0-9_]{0,63}$/;
const opaqueSignaturePattern = /^[\x21-\x7e]{1,1024}$/;
const reviewDigestDomain = "loop.perp.agent-authorization.review.v1\0";

const resourceStates = [
  "prepared",
  "submitting",
  "accepted",
  "active",
  "rejected",
  "failed",
  "unknown",
  "reconciling",
  "expired",
] as const;

const uuidSchema = z.string().regex(uuidPattern);
const rfc3339Schema = z.string().max(64).datetime({ offset: true });
const addressSchema = z
  .string()
  .regex(lowercaseAddressPattern)
  .refine((value) => value !== zeroAddress);
const agentNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(agentNamePattern)
  .refine((value) => value === value.trim());
const reasonCodeSchema = z.string().regex(safeReasonCodePattern);

const reviewSchema = z
  .object({
    version: z.literal("perp_agent_authorization_review_v1"),
    provider: z.literal("hyperliquid"),
    network: z.literal("testnet"),
    action: z.literal("approve_agent"),
    account: z
      .object({
        address: addressSchema,
        kind: z.enum(["master", "subaccount"]),
      })
      .strict(),
    signer_wallet_address: addressSchema,
    agent: z
      .object({
        address: addressSchema,
        name: agentNameSchema,
        valid_until: rfc3339Schema,
      })
      .strict(),
  })
  .strict();

const resultSchema = z
  .object({
    state: z.enum(["active", "rejected", "failed", "unknown"]),
    observed_at: rfc3339Schema,
    reason_code: reasonCodeSchema.nullable(),
  })
  .strict();

const resourceSchema = z
  .object({
    authorization_id: uuidSchema,
    state: z.enum(resourceStates),
    review: reviewSchema,
    signature: z
      .object({
        state: z.enum(["required", "consumed", "expired"]),
      })
      .strict(),
    expires_at: rfc3339Schema,
    result: resultSchema.nullable(),
    created_at: rfc3339Schema,
    updated_at: rfc3339Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedSignatureState =
      value.state === "prepared"
        ? "required"
        : value.state === "expired"
          ? "expired"
          : "consumed";
    if (value.signature.state !== expectedSignatureState) {
      context.addIssue({
        code: "custom",
        message: "The signature state does not match the authorization state",
      });
    }

    const expectedResultState =
      value.state === "active" ||
      value.state === "rejected" ||
      value.state === "failed"
        ? value.state
        : value.state === "unknown" || value.state === "reconciling"
          ? "unknown"
          : null;
    if (
      (expectedResultState === null && value.result !== null) ||
      (expectedResultState !== null &&
        value.result?.state !== expectedResultState)
    ) {
      context.addIssue({
        code: "custom",
        message: "The result does not match the authorization state",
      });
    }

    const createdAt = Date.parse(value.created_at);
    const updatedAt = Date.parse(value.updated_at);
    const expiresAt = Date.parse(value.expires_at);
    const agentValidUntil = Date.parse(value.review.agent.valid_until);
    if (
      createdAt > updatedAt ||
      createdAt >= expiresAt ||
      expiresAt > agentValidUntil
    ) {
      context.addIssue({
        code: "custom",
        message: "The authorization time window is inconsistent",
      });
    }
  });

const signatureRequestSchema = z
  .object({
    signature: z.string().regex(opaqueSignaturePattern),
  })
  .strict();

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type AgentAuthorizationResourceState = (typeof resourceStates)[number];
export type AgentAuthorizationReview = DeepReadonly<
  z.output<typeof reviewSchema>
>;
export type AgentAuthorizationResult = DeepReadonly<
  z.output<typeof resultSchema>
>;
export type AgentAuthorizationResource = DeepReadonly<
  z.output<typeof resourceSchema>
>;
export type AgentAuthorizationSignatureRequest = DeepReadonly<
  z.output<typeof signatureRequestSchema>
>;

export class InvalidAgentAuthorizationContractError extends Error {
  readonly code = "invalid_agent_authorization_contract";

  constructor() {
    super("The Agent authorization contract value is invalid");
    this.name = "InvalidAgentAuthorizationContractError";
  }
}

function invalidContract(): never {
  throw new InvalidAgentAuthorizationContractError();
}

function assertJsonDataTree(value: unknown, ancestors: WeakSet<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalidContract();
    }
    return;
  }
  if (typeof value !== "object") {
    return invalidContract();
  }
  if (ancestors.has(value)) {
    return invalidContract();
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return invalidContract();
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)),
        )
      ) {
        return invalidContract();
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          return invalidContract();
        }
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          return invalidContract();
        }
        assertJsonDataTree(descriptor.value, ancestors);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidContract();
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        return invalidContract();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return invalidContract();
      }
      assertJsonDataTree(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value) as DeepReadonly<T>;
}

function parseStrict<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): DeepReadonly<z.output<Schema>> {
  try {
    assertJsonDataTree(value, new WeakSet());
    return deepFreeze(schema.parse(value));
  } catch (error) {
    if (error instanceof InvalidAgentAuthorizationContractError) {
      throw error;
    }
    throw new InvalidAgentAuthorizationContractError();
  }
}

export function parseAgentAuthorizationReview(
  value: unknown,
): AgentAuthorizationReview {
  return parseStrict(reviewSchema, value);
}

export function parseAgentAuthorizationResource(
  value: unknown,
): AgentAuthorizationResource {
  return parseStrict(resourceSchema, value);
}

export function parseAgentAuthorizationSignatureRequest(
  value: unknown,
): AgentAuthorizationSignatureRequest {
  return parseStrict(signatureRequestSchema, value);
}

export function digestAgentAuthorizationReview(value: unknown): string {
  const parsed = parseAgentAuthorizationReview(value);
  return createHash("sha256")
    .update(reviewDigestDomain, "utf8")
    .update(JSON.stringify(parsed), "utf8")
    .digest("hex");
}
