import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  parseSpotAgentAuthorizationCreationResource,
  parseSpotAgentAuthorizationId,
  parseSpotAgentAuthorizationResource,
  parseSpotAgentAuthorizationSignatureRequest,
  type SpotAgentAuthorizationCreationResource,
  type SpotAgentAuthorizationResource,
} from "./spot-agent-authorization-contract.js";
import { InvalidSpotContractValueError } from "./spot-contract-support.js";
import {
  InvalidSpotRequestError,
  SpotUnavailableError,
} from "./spot-errors.js";
import { assertSpotPrincipal } from "./spot-principal.js";

export interface SpotAgentAuthorizationService {
  issue(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly requestId: string;
    readonly signal: AbortSignal;
  }): Promise<SpotAgentAuthorizationCreationResource>;
  get(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly authorizationId: string;
  }): Promise<SpotAgentAuthorizationResource>;
  submitSignature(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly authorizationId: string;
    readonly requestId: string;
    readonly body: unknown;
    readonly signal: AbortSignal;
  }): Promise<SpotAgentAuthorizationResource>;
}

export interface SpotAgentAuthorizationWorkflow {
  issue(input: {
    readonly ownerUserId: string;
    readonly privyUserId: string;
    readonly requestId: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  findOwned(input: {
    readonly ownerUserId: string;
    readonly authorizationId: string;
  }): Promise<unknown>;
  submitSignature(input: {
    readonly ownerUserId: string;
    readonly privyUserId: string;
    readonly authorizationId: string;
    readonly requestId: string;
    readonly signature: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export class SpotAgentAuthorizationNotFoundError extends Error {
  readonly code = "spot_agent_authorization_not_found";

  constructor() {
    super("The Spot Agent authorization does not exist");
    this.name = "SpotAgentAuthorizationNotFoundError";
  }
}

export class SpotAgentAuthorizationExpiredError extends Error {
  readonly code = "spot_agent_authorization_expired";

  constructor() {
    super("The Spot Agent authorization has expired");
    this.name = "SpotAgentAuthorizationExpiredError";
  }
}

function assertUuid(value: string): string {
  try {
    return parseSpotAgentAuthorizationId(value);
  } catch {
    throw new InvalidSpotRequestError();
  }
}

function assertSignal(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) {
    throw new InvalidSpotRequestError();
  }
}

function unavailableOnMalformed<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof InvalidSpotContractValueError) {
      throw new SpotUnavailableError();
    }
    throw error;
  }
}

export function createSpotAgentAuthorizationService(
  workflow: SpotAgentAuthorizationWorkflow,
): SpotAgentAuthorizationService {
  return Object.freeze({
    async issue(
      input: Parameters<SpotAgentAuthorizationService["issue"]>[0],
    ): Promise<SpotAgentAuthorizationCreationResource> {
      const principal = assertSpotPrincipal(input.principal);
      assertSignal(input.signal);
      const resource = await workflow.issue({
        ownerUserId: principal.userId,
        privyUserId: principal.privyUserId,
        requestId: assertUuid(input.requestId),
        signal: input.signal,
      });
      return unavailableOnMalformed(() =>
        parseSpotAgentAuthorizationCreationResource(resource),
      );
    },
    async get(
      input: Parameters<SpotAgentAuthorizationService["get"]>[0],
    ): Promise<SpotAgentAuthorizationResource> {
      const principal = assertSpotPrincipal(input.principal);
      const authorizationId = assertUuid(input.authorizationId);
      const resource = await workflow.findOwned({
        ownerUserId: principal.userId,
        authorizationId,
      });
      const parsed = unavailableOnMalformed(() =>
        parseSpotAgentAuthorizationResource(resource),
      );
      if (parsed.authorization_id !== authorizationId) {
        throw new SpotUnavailableError();
      }
      return parsed;
    },
    async submitSignature(
      input: Parameters<SpotAgentAuthorizationService["submitSignature"]>[0],
    ): Promise<SpotAgentAuthorizationResource> {
      const principal = assertSpotPrincipal(input.principal);
      assertSignal(input.signal);
      let signature: string;
      try {
        signature = parseSpotAgentAuthorizationSignatureRequest(
          input.body,
        ).signature;
      } catch {
        throw new InvalidSpotRequestError();
      }
      const authorizationId = assertUuid(input.authorizationId);
      const resource = await workflow.submitSignature({
        ownerUserId: principal.userId,
        privyUserId: principal.privyUserId,
        authorizationId,
        requestId: assertUuid(input.requestId),
        signature,
        signal: input.signal,
      });
      const parsed = unavailableOnMalformed(() =>
        parseSpotAgentAuthorizationResource(resource),
      );
      if (parsed.authorization_id !== authorizationId) {
        throw new SpotUnavailableError();
      }
      return parsed;
    },
  });
}

export function createUnavailableSpotAgentAuthorizationService(): SpotAgentAuthorizationService {
  const unavailable = (): Promise<never> =>
    Promise.reject(new SpotUnavailableError());
  return Object.freeze({
    issue: unavailable,
    get: unavailable,
    submitSignature: unavailable,
  });
}
