import { z } from "zod";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  AgentAuthorizationPrepareExpiredError,
  AgentAuthorizationRepositoryUnavailableError,
  type AgentAuthorizationRecord,
  type AgentAuthorizationRepository,
} from "../../database/agent-authorization-repository.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";
import {
  InvalidAgentAuthorizationContractError,
  parseAgentAuthorizationResource,
  parseAgentAuthorizationSignatureRequest,
  type AgentAuthorizationResource,
  type AgentAuthorizationResourceState,
} from "./agent-authorization-contract.js";

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

export interface IssueAgentAuthorizationInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface GetAgentAuthorizationInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly authorizationId: string;
}

export interface SubmitAgentAuthorizationSignatureInput extends GetAgentAuthorizationInput {
  readonly requestId: string;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

export interface CheckAgentAuthorizationMutationInput {
  readonly ownerUserId: string;
  readonly phase: "issue" | "relay";
  readonly action: "approve_agent";
  readonly network: "testnet";
  readonly signal: AbortSignal;
}

export interface AgentAuthorizationMutationGate {
  assertAllowed(input: CheckAgentAuthorizationMutationInput): Promise<void>;
}

export interface AgentAuthorizationService {
  issue(
    input: IssueAgentAuthorizationInput,
  ): Promise<AgentAuthorizationResource>;
  get(input: GetAgentAuthorizationInput): Promise<AgentAuthorizationResource>;
  submitSignature(
    input: SubmitAgentAuthorizationSignatureInput,
  ): Promise<AgentAuthorizationResource>;
}

export interface CreateAgentAuthorizationServiceInput {
  readonly repository: AgentAuthorizationRepository;
  readonly mutationGate?: AgentAuthorizationMutationGate;
  readonly now?: () => Date;
}

export class InvalidAgentAuthorizationRequestError extends Error {
  readonly code = "invalid_agent_authorization_request";

  constructor() {
    super("The Agent authorization request is invalid");
    this.name = "InvalidAgentAuthorizationRequestError";
  }
}

export class AgentAuthorizationMutationDisabledError extends Error {
  readonly code = "perp_mutation_disabled";

  constructor() {
    super("Perp mutations are disabled");
    this.name = "AgentAuthorizationMutationDisabledError";
  }
}

export class AgentAuthorizationNotFoundError extends Error {
  readonly code = "agent_authorization_not_found";

  constructor() {
    super("The Agent authorization was not found");
    this.name = "AgentAuthorizationNotFoundError";
  }
}

export class AgentAuthorizationExpiredError extends Error {
  readonly code = "agent_authorization_expired";

  constructor() {
    super("The Agent authorization signing handoff has expired");
    this.name = "AgentAuthorizationExpiredError";
  }
}

export class AgentAuthorizationUnavailableError extends Error {
  readonly code = "agent_authorization_unavailable";

  constructor() {
    super("Agent authorization is unavailable");
    this.name = "AgentAuthorizationUnavailableError";
  }
}

export class AgentAuthorizationFailedError extends Error {
  readonly code = "agent_authorization_failed";

  constructor() {
    super("Agent authorization processing failed");
    this.name = "AgentAuthorizationFailedError";
  }
}

export function createDisabledAgentAuthorizationMutationGate(): AgentAuthorizationMutationGate {
  return Object.freeze({
    assertAllowed(): Promise<never> {
      return Promise.reject(new AgentAuthorizationMutationDisabledError());
    },
  });
}

function assertExactInputKeys(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new InvalidAgentAuthorizationRequestError();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new InvalidAgentAuthorizationRequestError();
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new InvalidAgentAuthorizationRequestError();
    }
  }
}

function assertPrincipal(
  value: AuthenticatedLoopPrincipal,
): AuthenticatedLoopPrincipal {
  const parsed = principalSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.streamUserId !== deriveStreamUserId(parsed.data.userId)
  ) {
    throw new InvalidAgentAuthorizationRequestError();
  }
  return parsed.data;
}

function assertCanonicalUuid(value: string): string {
  if (!uuidPattern.test(value)) {
    throw new InvalidAgentAuthorizationRequestError();
  }
  return value;
}

function assertSignal(value: unknown): asserts value is AbortSignal {
  if (!(value instanceof AbortSignal)) {
    throw new InvalidAgentAuthorizationRequestError();
  }
}

function readNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AgentAuthorizationFailedError();
  }
  return value;
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof AgentAuthorizationPrepareExpiredError) {
    throw new AgentAuthorizationExpiredError();
  }
  if (error instanceof AgentAuthorizationRepositoryUnavailableError) {
    throw new AgentAuthorizationUnavailableError();
  }
  throw error;
}

async function findOwnedAuthorization(
  repository: AgentAuthorizationRepository,
  ownerUserId: string,
  authorizationId: string,
): Promise<AgentAuthorizationRecord> {
  let record: AgentAuthorizationRecord | null;
  try {
    record = await repository.findOwned(ownerUserId, authorizationId);
  } catch (error) {
    return mapRepositoryError(error);
  }
  if (
    record === null ||
    record.ownerUserId !== ownerUserId ||
    record.id !== authorizationId
  ) {
    throw new AgentAuthorizationNotFoundError();
  }
  return record;
}

function projectedState(
  record: AgentAuthorizationRecord,
  observedAt: Date,
): AgentAuthorizationResourceState {
  return record.state === "prepared" &&
    Date.parse(record.signingExpiresAt) <= observedAt.getTime()
    ? "expired"
    : record.state;
}

function toResource(
  record: AgentAuthorizationRecord,
  observedAt: Date,
): AgentAuthorizationResource {
  try {
    if (
      record.publicReview.account.address !== record.accountAddress ||
      record.publicReview.account.kind !== record.accountKind ||
      record.publicReview.signer_wallet_address !==
        record.signerWalletAddress ||
      record.publicReview.agent.address !== record.agentAddress ||
      record.publicReview.agent.name !== record.agentName ||
      Date.parse(record.publicReview.agent.valid_until) !==
        Date.parse(record.agentValidUntil)
    ) {
      throw new AgentAuthorizationFailedError();
    }
    const state = projectedState(record, observedAt);
    return parseAgentAuthorizationResource({
      authorization_id: record.id,
      state,
      review: record.publicReview,
      signature: {
        state:
          state === "prepared"
            ? "required"
            : state === "expired"
              ? "expired"
              : "consumed",
      },
      expires_at: record.signingExpiresAt,
      result: state === "expired" ? null : record.result,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    });
  } catch (error) {
    if (error instanceof AgentAuthorizationFailedError) {
      throw error;
    }
    throw new AgentAuthorizationFailedError();
  }
}

function parseSignatureBody(value: unknown): string {
  try {
    return parseAgentAuthorizationSignatureRequest(value).signature;
  } catch (error) {
    if (error instanceof InvalidAgentAuthorizationContractError) {
      throw new InvalidAgentAuthorizationRequestError();
    }
    throw error;
  }
}

export function createAgentAuthorizationService(
  input: CreateAgentAuthorizationServiceInput,
): AgentAuthorizationService {
  const mutationGate =
    input.mutationGate ?? createDisabledAgentAuthorizationMutationGate();
  const now = input.now ?? (() => new Date());

  return Object.freeze({
    async issue(
      requestInput: IssueAgentAuthorizationInput,
    ): Promise<AgentAuthorizationResource> {
      assertExactInputKeys(requestInput, ["principal", "requestId", "signal"]);
      const principal = assertPrincipal(requestInput.principal);
      assertCanonicalUuid(requestInput.requestId);
      assertSignal(requestInput.signal);

      await mutationGate.assertAllowed({
        ownerUserId: principal.userId,
        phase: "issue",
        action: "approve_agent",
        network: "testnet",
        signal: requestInput.signal,
      });

      // No effectful allocator, formatter, signer, repository finalizer, or
      // provider handoff is composed until one audited transaction can persist
      // the exact issued payload binding before any external side effect.
      throw new AgentAuthorizationUnavailableError();
    },

    async get(
      requestInput: GetAgentAuthorizationInput,
    ): Promise<AgentAuthorizationResource> {
      assertExactInputKeys(requestInput, ["principal", "authorizationId"]);
      const principal = assertPrincipal(requestInput.principal);
      const authorizationId = assertCanonicalUuid(requestInput.authorizationId);
      const record = await findOwnedAuthorization(
        input.repository,
        principal.userId,
        authorizationId,
      );
      return toResource(record, readNow(now));
    },

    async submitSignature(
      requestInput: SubmitAgentAuthorizationSignatureInput,
    ): Promise<AgentAuthorizationResource> {
      assertExactInputKeys(requestInput, [
        "principal",
        "authorizationId",
        "requestId",
        "body",
        "signal",
      ]);
      const principal = assertPrincipal(requestInput.principal);
      const authorizationId = assertCanonicalUuid(requestInput.authorizationId);
      const requestId = assertCanonicalUuid(requestInput.requestId);
      assertSignal(requestInput.signal);
      const signature = parseSignatureBody(requestInput.body);
      const record = await findOwnedAuthorization(
        input.repository,
        principal.userId,
        authorizationId,
      );
      const observedAt = readNow(now);
      if (
        record.state === "expired" ||
        (record.state === "prepared" &&
          Date.parse(record.signingExpiresAt) <= observedAt.getTime())
      ) {
        throw new AgentAuthorizationExpiredError();
      }
      if (record.state !== "prepared") {
        return toResource(record, observedAt);
      }

      await mutationGate.assertAllowed({
        ownerUserId: principal.userId,
        phase: "relay",
        action: "approve_agent",
        network: "testnet",
        signal: requestInput.signal,
      });

      // The transient signature is deliberately not forwarded or persisted.
      // A future relay must journal its only transport attempt before sending.
      void requestId;
      void signature;
      throw new AgentAuthorizationUnavailableError();
    },
  });
}
