import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { InvalidSpotContractValueError } from "./spot-contract-support.js";
import {
  parseSpotWalletBindingMutationRequest,
  parseSpotWalletBindingResource,
  type SpotWalletBindingResource,
} from "./spot-wallet-binding-contract.js";
import {
  InvalidSpotRequestError,
  SpotUnavailableError,
  SpotVersionConflictError,
  SpotWalletBindingRequiredError,
} from "./spot-errors.js";
import { assertSpotPrincipal } from "./spot-principal.js";

export interface SpotWalletBindingService {
  get(input: {
    readonly principal: AuthenticatedLoopPrincipal;
  }): Promise<SpotWalletBindingResource>;
  put(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly body: unknown;
    readonly signal: AbortSignal;
  }): Promise<SpotWalletBindingResource>;
  delete(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly expectedBindingVersion: string;
  }): Promise<SpotWalletBindingResource>;
}

export interface SpotWalletBindingLifecycle {
  get(input: { readonly ownerUserId: string }): Promise<unknown>;
  put(input: {
    readonly ownerUserId: string;
    readonly privyUserId: string;
    readonly expectedBindingVersion: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  remove(input: {
    readonly ownerUserId: string;
    readonly expectedBindingVersion: string;
  }): Promise<unknown>;
}

export class SpotWalletBindingLifecycleUnavailableError extends Error {
  readonly code = "spot_wallet_binding_lifecycle_unavailable";

  constructor() {
    super("The shared wallet-binding lifecycle is unavailable");
    this.name = "SpotWalletBindingLifecycleUnavailableError";
  }
}

export class SpotWalletBindingSelectionRequiredError extends Error {
  readonly code = "spot_wallet_binding_selection_required";

  constructor() {
    super("A unique eligible wallet is required");
    this.name = "SpotWalletBindingSelectionRequiredError";
  }
}

export class SpotWalletBindingLifecycleVersionConflictError extends Error {
  readonly code = "spot_wallet_binding_lifecycle_version_conflict";

  constructor() {
    super("The wallet-binding lifecycle version conflicts");
    this.name = "SpotWalletBindingLifecycleVersionConflictError";
  }
}

function parseResource(value: unknown): SpotWalletBindingResource {
  try {
    return parseSpotWalletBindingResource(value);
  } catch (error) {
    if (error instanceof InvalidSpotContractValueError) {
      throw new SpotUnavailableError();
    }
    throw error;
  }
}

function mapLifecycleError(error: unknown): never {
  if (error instanceof SpotWalletBindingSelectionRequiredError) {
    throw new SpotWalletBindingRequiredError();
  }
  if (error instanceof SpotWalletBindingLifecycleVersionConflictError) {
    throw new SpotVersionConflictError();
  }
  if (error instanceof SpotWalletBindingLifecycleUnavailableError) {
    throw new SpotUnavailableError();
  }
  throw error;
}

export function createSpotWalletBindingService(
  lifecycle: SpotWalletBindingLifecycle,
): SpotWalletBindingService {
  return Object.freeze({
    async get(
      input: Parameters<SpotWalletBindingService["get"]>[0],
    ): Promise<SpotWalletBindingResource> {
      const principal = assertSpotPrincipal(input.principal);
      try {
        return parseResource(
          await lifecycle.get({ ownerUserId: principal.userId }),
        );
      } catch (error) {
        return mapLifecycleError(error);
      }
    },
    async put(
      input: Parameters<SpotWalletBindingService["put"]>[0],
    ): Promise<SpotWalletBindingResource> {
      const principal = assertSpotPrincipal(input.principal);
      if (!(input.signal instanceof AbortSignal)) {
        throw new InvalidSpotRequestError();
      }
      let expectedBindingVersion: string;
      try {
        expectedBindingVersion = parseSpotWalletBindingMutationRequest(
          input.body,
        ).expected_binding_version;
      } catch {
        throw new InvalidSpotRequestError();
      }
      try {
        return parseResource(
          await lifecycle.put({
            ownerUserId: principal.userId,
            privyUserId: principal.privyUserId,
            expectedBindingVersion,
            signal: input.signal,
          }),
        );
      } catch (error) {
        return mapLifecycleError(error);
      }
    },
    async delete(
      input: Parameters<SpotWalletBindingService["delete"]>[0],
    ): Promise<SpotWalletBindingResource> {
      const principal = assertSpotPrincipal(input.principal);
      let expectedBindingVersion: string;
      try {
        expectedBindingVersion = parseSpotWalletBindingMutationRequest({
          expected_binding_version: input.expectedBindingVersion,
        }).expected_binding_version;
      } catch {
        throw new InvalidSpotRequestError();
      }
      try {
        return parseResource(
          await lifecycle.remove({
            ownerUserId: principal.userId,
            expectedBindingVersion,
          }),
        );
      } catch (error) {
        return mapLifecycleError(error);
      }
    },
  });
}

export function createUnavailableSpotWalletBindingService(): SpotWalletBindingService {
  const unavailable = (): Promise<never> =>
    Promise.reject(new SpotUnavailableError());
  return Object.freeze({
    get: unavailable,
    put: unavailable,
    delete: unavailable,
  });
}
