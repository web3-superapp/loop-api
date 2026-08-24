import { z } from "zod";

const resolvedStateSchema = z.enum([
  "accepted",
  "succeeded",
  "rejected",
  "failed",
]);
const reasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const retryAfterMsSchema = z.number().int().min(0).max(86_400_000);

const authoritativeReadResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("resolved"),
      state: resolvedStateSchema,
      reasonCode: reasonCodeSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pending"),
      reasonCode: reasonCodeSchema.optional(),
      retryAfterMs: retryAfterMsSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("retry"),
      reasonCode: reasonCodeSchema,
      retryAfterMs: retryAfterMsSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("operator_required"),
      reasonCode: reasonCodeSchema,
    })
    .strict(),
]);

export interface AuthoritativeReadSubject {
  readonly operationId: string;
  readonly ownerUserId: string;
  readonly domain: string;
  readonly operationKind: string;
  readonly transportAttemptId: string | null;
}

export interface AuthoritativeReadInput {
  readonly readRequestId: string;
  readonly subject: AuthoritativeReadSubject;
  readonly signal: AbortSignal;
}

export type AuthoritativeReadResult = z.infer<
  typeof authoritativeReadResultSchema
>;

/**
 * A reconciliation adapter is deliberately a single read function. The port
 * exposes no provider submit, execute, sign, or replay capability.
 */
export type AuthoritativeResultReader = (
  input: AuthoritativeReadInput,
) => Promise<AuthoritativeReadResult>;

export interface AuthoritativeReaderRegistry {
  find(domain: string): AuthoritativeResultReader | undefined;
}

export function createAuthoritativeReaderRegistry(
  entries: ReadonlyArray<readonly [string, AuthoritativeResultReader]>,
): AuthoritativeReaderRegistry {
  const readers = new Map<string, AuthoritativeResultReader>();

  for (const [domain, reader] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(domain)) {
      throw new Error("Authoritative reader domain is invalid");
    }
    if (readers.has(domain)) {
      throw new Error("Authoritative reader domain is duplicated");
    }

    readers.set(domain, reader);
  }

  return Object.freeze({
    find(domain: string): AuthoritativeResultReader | undefined {
      return readers.get(domain);
    },
  });
}

export function parseAuthoritativeReadResult(
  value: unknown,
): AuthoritativeReadResult | null {
  const parsed = authoritativeReadResultSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : null;
}
