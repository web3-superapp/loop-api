import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  canonicalizeSpotIntentRequest,
  digestSpotIntentRequest,
  parseSpotIntentId,
  parseSpotIntentRequest,
  parseSpotIntentResource,
  type SpotIntentRequest,
  type SpotIntentResource,
} from "./spot-intent-contract.js";
import { InvalidSpotContractValueError } from "./spot-contract-support.js";
import {
  InvalidSpotRequestError,
  SpotUnavailableError,
} from "./spot-errors.js";
import { assertSpotPrincipal } from "./spot-principal.js";

export interface PrepareSpotIntentInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

export interface GetSpotIntentInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly intentId: string;
}

export interface SubmitSpotIntentInput extends GetSpotIntentInput {
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface SpotIntentService {
  prepare(input: PrepareSpotIntentInput): Promise<SpotIntentResource>;
  get(input: GetSpotIntentInput): Promise<SpotIntentResource>;
  submit(input: SubmitSpotIntentInput): Promise<SpotIntentResource>;
}

export interface SpotIntentWorkflow {
  prepare(input: {
    readonly ownerUserId: string;
    readonly privyUserId: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly request: SpotIntentRequest;
    readonly canonicalRequest: string;
    readonly requestSha256: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  findOwned(input: {
    readonly ownerUserId: string;
    readonly intentId: string;
  }): Promise<unknown>;
  submit(input: {
    readonly ownerUserId: string;
    readonly privyUserId: string;
    readonly intentId: string;
    readonly requestId: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export class SpotIntentNotFoundError extends Error {
  readonly code = "spot_intent_not_found";

  constructor() {
    super("The Spot intent does not exist");
    this.name = "SpotIntentNotFoundError";
  }
}

export class SpotIntentExpiredError extends Error {
  readonly code = "spot_intent_expired";

  constructor() {
    super("The Spot intent has expired");
    this.name = "SpotIntentExpiredError";
  }
}

export class SpotIntentStaleError extends Error {
  readonly code = "spot_intent_stale";

  constructor() {
    super("The Spot intent must be reviewed again");
    this.name = "SpotIntentStaleError";
  }
}

export class SpotIntentIdempotencyConflictError extends Error {
  readonly code = "spot_intent_idempotency_conflict";

  constructor() {
    super("The Spot intent idempotency key conflicts");
    this.name = "SpotIntentIdempotencyConflictError";
  }
}

export class SpotIntentClaimRateLimitedError extends Error {
  readonly code = "spot_intent_claim_rate_limited";

  constructor() {
    super("The Spot intent preparation budget is exhausted");
    this.name = "SpotIntentClaimRateLimitedError";
  }
}

function assertUuid(value: string): string {
  try {
    return parseSpotIntentId(value);
  } catch {
    throw new InvalidSpotRequestError();
  }
}

function assertSignal(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) {
    throw new InvalidSpotRequestError();
  }
}

function parseResource(value: unknown): SpotIntentResource {
  try {
    return parseSpotIntentResource(value);
  } catch (error) {
    if (error instanceof InvalidSpotContractValueError) {
      throw new SpotUnavailableError();
    }
    throw error;
  }
}

export function createSpotIntentService(
  workflow: SpotIntentWorkflow,
): SpotIntentService {
  return Object.freeze({
    async prepare(input: PrepareSpotIntentInput): Promise<SpotIntentResource> {
      const principal = assertSpotPrincipal(input.principal);
      assertSignal(input.signal);
      const idempotencyKey = assertUuid(input.idempotencyKey);
      const requestId = assertUuid(input.requestId);
      let request: SpotIntentRequest;
      try {
        request = parseSpotIntentRequest(input.body);
      } catch {
        throw new InvalidSpotRequestError();
      }
      const resource = parseResource(
        await workflow.prepare({
          ownerUserId: principal.userId,
          privyUserId: principal.privyUserId,
          idempotencyKey,
          requestId,
          request,
          canonicalRequest: canonicalizeSpotIntentRequest(request),
          requestSha256: digestSpotIntentRequest(request),
          signal: input.signal,
        }),
      );
      if (
        resource.review.market_id !== request.market_id ||
        resource.review.side !== request.side ||
        resource.review.amount_mode !== request.amount.mode ||
        resource.review.amount_value !== request.amount.value
      ) {
        throw new SpotUnavailableError();
      }
      return resource;
    },
    async get(input: GetSpotIntentInput): Promise<SpotIntentResource> {
      const principal = assertSpotPrincipal(input.principal);
      const intentId = assertUuid(input.intentId);
      const resource = parseResource(
        await workflow.findOwned({
          ownerUserId: principal.userId,
          intentId,
        }),
      );
      if (resource.intent_id !== intentId) {
        throw new SpotUnavailableError();
      }
      return resource;
    },
    async submit(input: SubmitSpotIntentInput): Promise<SpotIntentResource> {
      const principal = assertSpotPrincipal(input.principal);
      assertSignal(input.signal);
      const intentId = assertUuid(input.intentId);
      const resource = parseResource(
        await workflow.submit({
          ownerUserId: principal.userId,
          privyUserId: principal.privyUserId,
          intentId,
          requestId: assertUuid(input.requestId),
          signal: input.signal,
        }),
      );
      if (resource.intent_id !== intentId) {
        throw new SpotUnavailableError();
      }
      return resource;
    },
  });
}

export function createUnavailableSpotIntentService(): SpotIntentService {
  const unavailable = (): Promise<never> =>
    Promise.reject(new SpotUnavailableError());
  return Object.freeze({
    prepare: unavailable,
    get: unavailable,
    submit: unavailable,
  });
}
