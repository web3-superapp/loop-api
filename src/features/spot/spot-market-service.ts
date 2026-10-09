import { randomUUID } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  parseSpotBalancesResource,
  parseSpotConfigResource,
  parseSpotMarketFactsResource,
  parseSpotMarketId,
  type SpotBalancesResource,
  type SpotConfigResource,
  type SpotMarketFactsResource,
} from "./spot-market-contract.js";
import { InvalidSpotContractValueError } from "./spot-contract-support.js";
import { assertSpotPrincipal } from "./spot-principal.js";
import {
  InvalidSpotRequestError,
  SpotUnavailableError,
  SpotWalletBindingRequiredError,
} from "./spot-errors.js";

interface SpotReadContext {
  readonly ownerUserId: string;
  readonly privyUserId: string;
  readonly providerRequestId: string;
  readonly signal: AbortSignal;
}

export interface SpotMarketReader {
  readConfig(input: SpotReadContext): Promise<unknown>;
  readMarketFacts(
    input: SpotReadContext & { readonly marketId: string },
  ): Promise<unknown>;
  readBalances(input: SpotReadContext): Promise<unknown>;
}

export interface SpotMarketServiceInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly signal: AbortSignal;
}

export interface SpotMarketFactsServiceInput extends SpotMarketServiceInput {
  readonly marketId: string;
}

export interface SpotMarketService {
  getConfig(input: SpotMarketServiceInput): Promise<SpotConfigResource>;
  getMarketFacts(
    input: SpotMarketFactsServiceInput,
  ): Promise<SpotMarketFactsResource>;
  getBalances(input: SpotMarketServiceInput): Promise<SpotBalancesResource>;
}

export interface CreateSpotMarketServiceInput {
  readonly reader: SpotMarketReader;
  readonly createUuid?: () => string;
  readonly now?: () => Date;
}

export class SpotMarketNotFoundError extends Error {
  readonly code = "spot_market_not_found";

  constructor() {
    super("The Spot market does not exist");
    this.name = "SpotMarketNotFoundError";
  }
}

export class SpotMarketReaderUnavailableError extends Error {
  readonly code = "spot_market_reader_unavailable";

  constructor() {
    super("The Spot market reader is unavailable");
    this.name = "SpotMarketReaderUnavailableError";
  }
}

export class SpotBalanceWalletBindingRequiredError extends Error {
  readonly code = "spot_balance_wallet_binding_required";

  constructor() {
    super("A verified wallet binding is required for Spot balances");
    this.name = "SpotBalanceWalletBindingRequiredError";
  }
}

function readContext(
  input: SpotMarketServiceInput,
  createUuid: () => string,
): SpotReadContext {
  const principal = assertSpotPrincipal(input.principal);
  if (!(input.signal instanceof AbortSignal)) {
    throw new InvalidSpotRequestError();
  }
  const providerRequestId = createUuid();
  try {
    parseSpotMarketId(providerRequestId);
  } catch {
    throw new SpotUnavailableError();
  }
  return Object.freeze({
    ownerUserId: principal.userId,
    privyUserId: principal.privyUserId,
    providerRequestId,
    signal: input.signal,
  });
}

function mapReaderError(error: unknown): never {
  if (error instanceof SpotMarketNotFoundError) {
    throw error;
  }
  if (error instanceof SpotBalanceWalletBindingRequiredError) {
    throw new SpotWalletBindingRequiredError();
  }
  if (error instanceof SpotMarketReaderUnavailableError) {
    throw new SpotUnavailableError();
  }
  if (error instanceof InvalidSpotContractValueError) {
    throw new SpotUnavailableError();
  }
  throw error;
}

function assertFreshSource<
  Resource extends {
    readonly source: {
      readonly fetched_at: string;
      readonly expires_at: string;
    };
  },
>(resource: Resource, now: () => Date): Resource {
  let currentTime: unknown;
  try {
    currentTime = now();
  } catch {
    throw new SpotUnavailableError();
  }
  if (!(currentTime instanceof Date)) {
    throw new SpotUnavailableError();
  }
  const currentMilliseconds = currentTime.getTime();
  if (
    !Number.isFinite(currentMilliseconds) ||
    Date.parse(resource.source.fetched_at) > currentMilliseconds ||
    Date.parse(resource.source.expires_at) <= currentMilliseconds
  ) {
    throw new SpotUnavailableError();
  }
  return resource;
}

export function createSpotMarketService(
  input: CreateSpotMarketServiceInput,
): SpotMarketService {
  const createUuid = input.createUuid ?? randomUUID;
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    async getConfig(
      serviceInput: SpotMarketServiceInput,
    ): Promise<SpotConfigResource> {
      try {
        return assertFreshSource(
          parseSpotConfigResource(
            await input.reader.readConfig(
              readContext(serviceInput, createUuid),
            ),
          ),
          now,
        );
      } catch (error) {
        return mapReaderError(error);
      }
    },
    async getMarketFacts(
      serviceInput: SpotMarketFactsServiceInput,
    ): Promise<SpotMarketFactsResource> {
      let marketId: string;
      try {
        marketId = parseSpotMarketId(serviceInput.marketId);
      } catch {
        throw new InvalidSpotRequestError();
      }
      try {
        const resource = assertFreshSource(
          parseSpotMarketFactsResource(
            await input.reader.readMarketFacts({
              ...readContext(serviceInput, createUuid),
              marketId,
            }),
          ),
          now,
        );
        if (resource.market_id !== marketId) {
          throw new SpotUnavailableError();
        }
        return resource;
      } catch (error) {
        return mapReaderError(error);
      }
    },
    async getBalances(
      serviceInput: SpotMarketServiceInput,
    ): Promise<SpotBalancesResource> {
      try {
        return assertFreshSource(
          parseSpotBalancesResource(
            await input.reader.readBalances(
              readContext(serviceInput, createUuid),
            ),
          ),
          now,
        );
      } catch (error) {
        return mapReaderError(error);
      }
    },
  });
}

export function createUnavailableSpotMarketService(): SpotMarketService {
  const unavailable = (): Promise<never> =>
    Promise.reject(new SpotUnavailableError());
  return Object.freeze({
    getConfig: unavailable,
    getMarketFacts: unavailable,
    getBalances: unavailable,
  });
}
