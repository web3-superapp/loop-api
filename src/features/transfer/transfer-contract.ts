import { z } from "zod";

export const TRANSFER_FORBIDDEN_CLIENT_KEYS = Object.freeze([
  "owner_user_id",
  "wallet_id",
  "wallet_epoch",
  "chain_family",
  "chain_id",
  "provider_chain",
  "asset_id",
  "token_address",
  "action_id",
  "submission_record_id",
  "endpoint_path",
  "url",
  "request_expiry_ms",
  "nonce",
  "idempotency_key",
  "screening_verdict",
  "screening_status",
  "wallet_api_payload",
  "formatted_payload_bytes",
  "structured_payload",
  "acknowledgement_binding_digest",
  "acknowledgement_verdict",
  "result_binding_handle",
  "cursor",
] as const);
const forbiddenClientAuthorityKeys: ReadonlySet<string> = new Set(
  TRANSFER_FORBIDDEN_CLIENT_KEYS,
);
const unsafeObjectKeys: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function isSafeUnresolvedJsonValue(root: unknown): boolean {
  const pending: unknown[] = [root];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const value = pending.pop();
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return false;
      }
      continue;
    }
    if (typeof value !== "object" || seen.has(value)) {
      return false;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return false;
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || !keys.includes("length")) {
        return false;
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          return false;
        }
        pending.push(descriptor.value);
      }
      continue;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return false;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (
        typeof key !== "string" ||
        forbiddenClientAuthorityKeys.has(key) ||
        unsafeObjectKeys.has(key)
      ) {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return false;
      }
      pending.push(descriptor.value);
    }
  }

  return true;
}

const unresolvedContractValueSchema = z
  .unknown()
  .refine(isSafeUnresolvedJsonValue);
const positiveDecimalStringSchema = z
  .string()
  .max(128)
  .regex(/^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/);
const opaqueAuthorizationSignatureSchema = z.string().min(1);
const officialFormatterEnvelopeSha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/);

const resolveRecipientRequestSchema = z
  .object({
    command: z.literal("resolve"),
    asset_selection_id: unresolvedContractValueSchema,
    recipient_input: unresolvedContractValueSchema,
  })
  .strict();

const acknowledgeRecipientRequestSchema = z
  .object({
    command: z.literal("acknowledge"),
    preflight_handle: unresolvedContractValueSchema,
    acknowledgement_kind: z.enum(["first_recipient", "history_unknown"]),
  })
  .strict();

const recipientPreflightRequestSchema = z.discriminatedUnion("command", [
  resolveRecipientRequestSchema,
  acknowledgeRecipientRequestSchema,
]);

const prepareTransferReviewRequestSchema = z
  .object({
    preflight_handle: unresolvedContractValueSchema,
    amount_decimal: positiveDecimalStringSchema,
  })
  .strict();

const issueAuthorizationPayloadRequestSchema = z
  .object({
    command: z.literal("issue_payload"),
    prepared_review_handle: unresolvedContractValueSchema,
  })
  .strict();

const submitAuthorizationSignatureRequestSchema = z
  .object({
    command: z.literal("submit_signature"),
    prepared_review_handle: unresolvedContractValueSchema,
    authorization_signature: opaqueAuthorizationSignatureSchema,
    official_formatter_envelope_sha256: officialFormatterEnvelopeSha256Schema,
  })
  .strict();

const transferAuthorizationRequestSchema = z.discriminatedUnion("command", [
  issueAuthorizationPayloadRequestSchema,
  submitAuthorizationSignatureRequestSchema,
]);

export type RecipientPreflightRequest = z.infer<
  typeof recipientPreflightRequestSchema
>;
export type PrepareTransferReviewRequest = z.infer<
  typeof prepareTransferReviewRequestSchema
>;
export type TransferAuthorizationRequest = z.infer<
  typeof transferAuthorizationRequestSchema
>;

export function parseRecipientPreflightRequest(
  value: unknown,
): RecipientPreflightRequest {
  return Object.freeze(recipientPreflightRequestSchema.parse(value));
}

export function parsePrepareTransferReviewRequest(
  value: unknown,
): PrepareTransferReviewRequest {
  return Object.freeze(prepareTransferReviewRequestSchema.parse(value));
}

export function parseTransferAuthorizationRequest(
  value: unknown,
): TransferAuthorizationRequest {
  return Object.freeze(transferAuthorizationRequestSchema.parse(value));
}
