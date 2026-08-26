import { z } from "zod";

import {
  parseSpotContract,
  type DeepReadonly,
} from "./spot-contract-support.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const addressPattern = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const maximumBindingVersion = 9_223_372_036_854_775_807n;
const maximumUint64 = 18_446_744_073_709_551_615n;

const uuidSchema = z.string().regex(uuidPattern);
const rfc3339Schema = z.string().max(64).datetime({ offset: true });
const addressSchema = z
  .string()
  .regex(addressPattern)
  .refine((value) => value !== zeroAddress);
const bindingVersionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= maximumBindingVersion);
const nonceSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/)
  .refine((value) => BigInt(value) <= maximumUint64);

const signableDomainSchema = z
  .object({
    name: z.literal("HyperliquidSignTransaction"),
    version: z.literal("1"),
    chain_id: z.literal(421_614),
    verifying_contract: z.literal(zeroAddress),
  })
  .strict();

const typedDataFieldSchema = <Name extends string, Type extends string>(
  name: Name,
  type: Type,
) =>
  z
    .object({
      name: z.literal(name),
      type: z.literal(type),
    })
    .strict();

const approveAgentTypedDataSchema = z
  .object({
    domain: z
      .object({
        name: z.literal("HyperliquidSignTransaction"),
        version: z.literal("1"),
        chainId: z.literal(421_614),
        verifyingContract: z.literal(zeroAddress),
      })
      .strict(),
    types: z
      .object({
        "HyperliquidTransaction:ApproveAgent": z.tuple([
          typedDataFieldSchema("hyperliquidChain", "string"),
          typedDataFieldSchema("agentAddress", "address"),
          typedDataFieldSchema("agentName", "string"),
          typedDataFieldSchema("nonce", "uint64"),
        ]),
        EIP712Domain: z.tuple([
          typedDataFieldSchema("name", "string"),
          typedDataFieldSchema("version", "string"),
          typedDataFieldSchema("chainId", "uint256"),
          typedDataFieldSchema("verifyingContract", "address"),
        ]),
      })
      .strict(),
    primaryType: z.literal("HyperliquidTransaction:ApproveAgent"),
    message: z
      .object({
        type: z.literal("approveAgent"),
        agentAddress: addressSchema,
        agentName: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/)
          .refine((value) => value === value.trim()),
        nonce: nonceSchema,
        signatureChainId: z.literal("0x66eee"),
        hyperliquidChain: z.literal("Testnet"),
      })
      .strict(),
  })
  .strict();

const resultSchema = z
  .object({
    state: z.enum([
      "accepted",
      "active",
      "rejected",
      "failed",
      "unknown",
      "operator_required",
    ]),
    observed_at: rfc3339Schema,
    reason_code: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .nullable(),
  })
  .strict();

const statusResourceSchema = z
  .object({
    authorization_id: uuidSchema,
    state: z.enum([
      "prepared",
      "submitting",
      "accepted",
      "active",
      "rejected",
      "failed",
      "unknown",
      "reconciling",
      "operator_required",
      "expired",
    ]),
    binding_epoch: bindingVersionSchema,
    signing_state: z.enum(["required", "consumed", "expired"]),
    protocol_scope_warning: z.literal(
      "hyperliquid_agent_authorization_is_protocol_broad",
    ),
    expires_at: rfc3339Schema,
    result: resultSchema.nullable(),
    created_at: rfc3339Schema,
    updated_at: rfc3339Schema,
  })
  .strict()
  .superRefine((resource, context) => {
    const expectedSignatureState =
      resource.state === "prepared"
        ? "required"
        : resource.state === "expired"
          ? "expired"
          : "consumed";
    if (resource.signing_state !== expectedSignatureState) {
      context.addIssue({ code: "custom", path: ["signing_state"] });
    }
    const resultRequired = new Set([
      "accepted",
      "active",
      "rejected",
      "failed",
      "unknown",
      "reconciling",
      "operator_required",
    ]).has(resource.state);
    if (resultRequired !== (resource.result !== null)) {
      context.addIssue({ code: "custom", path: ["result"] });
    }
    if (resource.result !== null) {
      if (resource.state === "reconciling") {
        if (
          resource.result.state !== "accepted" &&
          resource.result.state !== "unknown"
        ) {
          context.addIssue({ code: "custom", path: ["result", "state"] });
        }
      } else if (resource.result.state !== resource.state) {
        context.addIssue({ code: "custom", path: ["result", "state"] });
      }
      if (
        Date.parse(resource.result.observed_at) <
          Date.parse(resource.created_at) ||
        Date.parse(resource.result.observed_at) >
          Date.parse(resource.updated_at)
      ) {
        context.addIssue({ code: "custom", path: ["result", "observed_at"] });
      }
    }
    if (
      Date.parse(resource.created_at) > Date.parse(resource.updated_at) ||
      Date.parse(resource.created_at) >= Date.parse(resource.expires_at)
    ) {
      context.addIssue({ code: "custom" });
    }
  });

const signablePayloadSchema = z
  .object({
    format: z.literal("privy_eip712_json_v1"),
    agent_address: addressSchema,
    agent_name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/)
      .refine((value) => value === value.trim()),
    nonce: nonceSchema,
    domain: signableDomainSchema,
    typed_data: approveAgentTypedDataSchema,
    expires_at: rfc3339Schema,
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      payload.typed_data.message.agentAddress !== payload.agent_address ||
      payload.typed_data.message.agentName !== payload.agent_name ||
      payload.typed_data.message.nonce !== payload.nonce
    ) {
      context.addIssue({ code: "custom", path: ["typed_data", "message"] });
    }
  });

const creationResourceSchema = statusResourceSchema
  .safeExtend({ signable_payload: signablePayloadSchema })
  .refine(
    (resource) =>
      resource.state === "prepared" &&
      resource.signing_state === "required" &&
      resource.signable_payload.expires_at === resource.expires_at,
  );

const signatureRequestSchema = z
  .object({
    signature: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict();

export type SpotAgentAuthorizationResource = DeepReadonly<
  z.output<typeof statusResourceSchema>
>;
export type SpotAgentAuthorizationCreationResource = DeepReadonly<
  z.output<typeof creationResourceSchema>
>;
export type SpotAgentAuthorizationSignatureRequest = DeepReadonly<
  z.output<typeof signatureRequestSchema>
>;

export function parseSpotAgentAuthorizationId(value: unknown): string {
  return parseSpotContract(uuidSchema, value);
}

export function parseSpotAgentAuthorizationResource(
  value: unknown,
): SpotAgentAuthorizationResource {
  return parseSpotContract(statusResourceSchema, value);
}

export function parseSpotAgentAuthorizationCreationResource(
  value: unknown,
): SpotAgentAuthorizationCreationResource {
  return parseSpotContract(creationResourceSchema, value);
}

export function parseSpotAgentAuthorizationSignatureRequest(
  value: unknown,
): SpotAgentAuthorizationSignatureRequest {
  return parseSpotContract(signatureRequestSchema, value);
}
