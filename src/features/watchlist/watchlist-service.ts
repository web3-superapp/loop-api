import { z } from "zod";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import type { WatchlistRepository } from "../../database/watchlist-repository.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";
import {
  InvalidWatchlistContractError,
  parseWatchlistReplaceRequest,
  parseWatchlistSnapshot,
  type WatchlistSnapshot,
} from "./watchlist-contract.js";

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

export interface GetWatchlistInput {
  readonly principal: AuthenticatedLoopPrincipal;
}

export interface ReplaceWatchlistInput extends GetWatchlistInput {
  readonly body: unknown;
}

export interface WatchlistService {
  get(input: GetWatchlistInput): Promise<WatchlistSnapshot>;
  replace(input: ReplaceWatchlistInput): Promise<WatchlistSnapshot>;
}

export interface CreateWatchlistServiceInput {
  readonly repository: WatchlistRepository;
}

export class InvalidWatchlistRequestError extends Error {
  readonly code = "invalid_watchlist_request";

  constructor() {
    super("The Watchlist request is invalid");
    this.name = "InvalidWatchlistRequestError";
  }
}

function assertPrincipal(
  principal: AuthenticatedLoopPrincipal,
): AuthenticatedLoopPrincipal {
  const parsed = principalSchema.safeParse(principal);
  if (!parsed.success) {
    throw new InvalidWatchlistRequestError();
  }

  let expectedStreamUserId: string;
  try {
    expectedStreamUserId = deriveStreamUserId(parsed.data.userId);
  } catch {
    throw new InvalidWatchlistRequestError();
  }

  if (parsed.data.streamUserId !== expectedStreamUserId) {
    throw new InvalidWatchlistRequestError();
  }
  return parsed.data;
}

export function createWatchlistService(
  input: CreateWatchlistServiceInput,
): WatchlistService {
  return Object.freeze({
    async get({ principal }: GetWatchlistInput): Promise<WatchlistSnapshot> {
      const owner = assertPrincipal(principal);
      return parseWatchlistSnapshot(await input.repository.get(owner.userId));
    },

    async replace({
      principal,
      body,
    }: ReplaceWatchlistInput): Promise<WatchlistSnapshot> {
      const owner = assertPrincipal(principal);
      let request;
      try {
        request = parseWatchlistReplaceRequest(body);
      } catch (error) {
        if (error instanceof InvalidWatchlistContractError) {
          throw new InvalidWatchlistRequestError();
        }
        throw error;
      }

      const snapshot = await input.repository.replace({
        ownerUserId: owner.userId,
        expectedVersion: request.expected_version,
        groups: request.groups,
      });
      return parseWatchlistSnapshot(snapshot);
    },
  });
}
