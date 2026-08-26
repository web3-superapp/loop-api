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

export interface AtomicDomainLeaseIdentity {
  readonly workerId: string;
  readonly fenceToken: string;
  readonly recordVersion: string;
  readonly attemptCommittedAt: string | null;
}

export interface AtomicDomainReconciliationInput extends AuthoritativeReadInput {
  readonly finalizationRequestId: string;
  readonly lease: AtomicDomainLeaseIdentity;
}

/**
 * An atomic-domain handler owns both the authoritative provider read and the
 * domain transaction. Returning `resolved` certifies that the domain and
 * generic provider operation were finalized together; the generic service
 * must not perform a second completion write. The handler must call
 * `input.signal.throwIfAborted()` after its provider read and immediately
 * before it enters the database finalizer.
 */
export type AtomicDomainReconciliationHandler = (
  input: AtomicDomainReconciliationInput,
) => Promise<AuthoritativeReadResult>;

export type AuthoritativeReconciliationHandler =
  | Readonly<{
      mode: "generic_control_plane";
      read: AuthoritativeResultReader;
    }>
  | Readonly<{
      mode: "atomic_domain";
      run: AtomicDomainReconciliationHandler;
    }>;

export type AuthoritativeReaderRegistryEntry =
  AuthoritativeResultReader | AuthoritativeReconciliationHandler;

export type AuthoritativeReaderRegistryRegistration = readonly [
  domain: string,
  operationKind: string,
  entry: AuthoritativeReaderRegistryEntry,
];

export interface AuthoritativeReaderRegistry {
  find(
    domain: string,
    operationKind: string,
  ): AuthoritativeReconciliationHandler | undefined;
}

const registrySegmentPattern = /^[a-z][a-z0-9_]{0,63}$/;

function registryKey(domain: string, operationKind: string): string {
  // The validated segments cannot contain a colon, so this encoding cannot
  // alias two different provider-domain/operation-kind registrations.
  return `${domain}:${operationKind}`;
}

export function createAuthoritativeReaderRegistry(
  entries: ReadonlyArray<AuthoritativeReaderRegistryRegistration>,
): AuthoritativeReaderRegistry {
  const handlers = new Map<string, AuthoritativeReconciliationHandler>();

  for (const [domain, operationKind, entry] of entries) {
    if (!registrySegmentPattern.test(domain)) {
      throw new Error("Authoritative reader domain is invalid");
    }
    if (!registrySegmentPattern.test(operationKind)) {
      throw new Error("Authoritative reader operation kind is invalid");
    }
    const key = registryKey(domain, operationKind);
    if (handlers.has(key)) {
      throw new Error("Authoritative reader registration is duplicated");
    }

    const rawEntry: unknown = entry;
    if (typeof rawEntry === "function") {
      handlers.set(
        key,
        Object.freeze({
          mode: "generic_control_plane",
          read: rawEntry as AuthoritativeResultReader,
        }),
      );
      continue;
    }

    if (
      typeof rawEntry !== "object" ||
      rawEntry === null ||
      Array.isArray(rawEntry)
    ) {
      throw new Error("Authoritative reader handler is invalid");
    }
    const handler = rawEntry as Record<string, unknown>;

    if (
      handler["mode"] === "generic_control_plane" &&
      typeof handler["read"] === "function"
    ) {
      handlers.set(
        key,
        Object.freeze({
          mode: "generic_control_plane",
          read: handler["read"] as AuthoritativeResultReader,
        }),
      );
      continue;
    }

    if (
      handler["mode"] === "atomic_domain" &&
      typeof handler["run"] === "function"
    ) {
      handlers.set(
        key,
        Object.freeze({
          mode: "atomic_domain",
          run: handler["run"] as AtomicDomainReconciliationHandler,
        }),
      );
      continue;
    }

    throw new Error("Authoritative reader handler is invalid");
  }

  return Object.freeze({
    find(
      domain: string,
      operationKind: string,
    ): AuthoritativeReconciliationHandler | undefined {
      return handlers.get(registryKey(domain, operationKind));
    },
  });
}

export function parseAuthoritativeReadResult(
  value: unknown,
): AuthoritativeReadResult | null {
  const parsed = authoritativeReadResultSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : null;
}
