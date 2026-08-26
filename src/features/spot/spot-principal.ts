import { z } from "zod";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const principalSchema = z
  .object({
    userId: z.string().regex(uuidPattern),
    privyUserId: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/),
    streamUserId: z.string().min(1).max(63),
  })
  .strict();

export class InvalidSpotPrincipalError extends Error {
  readonly code = "invalid_spot_principal";

  constructor() {
    super("The Spot principal is invalid");
    this.name = "InvalidSpotPrincipalError";
  }
}

export function assertSpotPrincipal(
  principal: AuthenticatedLoopPrincipal,
): AuthenticatedLoopPrincipal {
  const parsed = principalSchema.safeParse(principal);
  if (!parsed.success) {
    throw new InvalidSpotPrincipalError();
  }

  try {
    if (parsed.data.streamUserId !== deriveStreamUserId(parsed.data.userId)) {
      throw new InvalidSpotPrincipalError();
    }
  } catch (error) {
    if (error instanceof InvalidSpotPrincipalError) {
      throw error;
    }
    throw new InvalidSpotPrincipalError();
  }

  return Object.freeze(parsed.data);
}
