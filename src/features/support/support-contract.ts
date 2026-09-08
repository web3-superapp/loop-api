import { createHash } from "node:crypto";

/**
 * Support ticket contract (Decision 0037). Categories are a fixed enum, the
 * body is 1–2000 Unicode code points with the alias character-safety rule
 * (no control, bidirectional-control, or invisible formatting characters),
 * status moves only through the operator script, and attachments do not
 * exist in this step.
 */

export const supportTicketCategories = Object.freeze([
  "account",
  "security",
  "wallet",
  "trade",
  "launch",
  "mining",
  "community",
  "other",
] as const);
export type SupportTicketCategory = (typeof supportTicketCategories)[number];

export const supportTicketStatuses = Object.freeze([
  "open",
  "answered",
  "closed",
] as const);
export type SupportTicketStatus = (typeof supportTicketStatuses)[number];

export const supportTicketEventTypes = Object.freeze([
  "created",
  "answered",
  "closed",
] as const);
export type SupportTicketEventType = (typeof supportTicketEventTypes)[number];

export const supportTicketActors = Object.freeze(["user", "operator"] as const);
export type SupportTicketActor = (typeof supportTicketActors)[number];

export const maximumSupportBodyCodePoints = 2_000;
/** UTF-16 units; 2000 astral code points need up to 4000. */
export const maximumSupportBodyRawLength = 4_000;
export const supportTicketListLimits = Object.freeze({
  default: 25,
  maximum: 50,
} as const);
/** Rolling 24-hour creation bound per owner; exhaustion is RATE_LIMITED. */
export const maximumSupportTicketsPerOwnerPerDay = 20;

export const supportTicketIdempotencyScope = "support_ticket_create" as const;
export const supportTicketCreateDigestVersion =
  "support_ticket_create_v1" as const;
const supportTicketDigestDomain = "loop:v2:support-ticket:create:v1";

export const supportReasonCodes = Object.freeze({
  attachmentsUnavailable: "SUPPORT_ATTACHMENTS_UNAVAILABLE",
  runtimeUnavailable: "SUPPORT_RUNTIME_UNAVAILABLE",
} as const);

/** Reply-time expectation shown on the support page; operator policy text. */
export const supportResponsePolicy = Object.freeze({
  configVersion: "supportPolicyV1",
  responseWindowHours: 24,
  businessDaysOnly: true,
  escalationChannel: "copy" as const,
} as const);

const forbiddenTextCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export class SupportTextInvalidError extends Error {
  constructor(readonly reason: "shape" | "length") {
    super("Support text is invalid");
    this.name = "SupportTextInvalidError";
  }
}

/**
 * Normalises a user or operator text: trims, refuses forbidden characters
 * (`shape`), then bounds the code-point length (`length`).
 */
export function normalizeSupportText(value: unknown): string {
  if (typeof value !== "string" || value.length > maximumSupportBodyRawLength) {
    throw new SupportTextInvalidError("shape");
  }
  if (forbiddenTextCharacters.test(value)) {
    throw new SupportTextInvalidError("shape");
  }
  const trimmed = value.trim();
  const codePoints = Array.from(trimmed).length;
  if (codePoints < 1) {
    throw new SupportTextInvalidError("shape");
  }
  if (codePoints > maximumSupportBodyCodePoints) {
    throw new SupportTextInvalidError("length");
  }
  return trimmed;
}

export function isSupportTicketCategory(
  value: unknown,
): value is SupportTicketCategory {
  return (
    typeof value === "string" &&
    (supportTicketCategories as readonly string[]).includes(value)
  );
}

export function supportTicketCreateDigest(input: {
  readonly category: SupportTicketCategory;
  readonly body: string;
}): string {
  return createHash("sha256")
    .update(supportTicketDigestDomain, "utf8")
    .update(
      JSON.stringify([
        supportTicketCreateDigestVersion,
        input.category,
        input.body,
      ]),
      "utf8",
    )
    .digest("hex");
}
