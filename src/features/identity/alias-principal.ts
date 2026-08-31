import { z } from "zod";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { deriveStreamUserId } from "./loop-identifiers.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const principalSchema = z
  .object({
    userId: z.string().regex(canonicalUuidPattern),
    privyUserId: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/),
    streamUserId: z.string().min(1).max(63),
  })
  .strict();

export function parseAliasPrincipal(
  value: AuthenticatedLoopPrincipal,
): AuthenticatedLoopPrincipal {
  const parsed = principalSchema.parse(value);
  if (deriveStreamUserId(parsed.userId) !== parsed.streamUserId) {
    throw new Error("The alias principal is invalid");
  }
  return Object.freeze(parsed);
}
