import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  PerpWalletBindingRepositoryUnavailableError,
  PerpWalletBindingRepositoryVersionConflictError,
  type PerpWalletBindingRecord,
  type PerpWalletBindingRepository,
} from "../../database/perp-wallet-binding-repository.js";
import type { PrivyUserReader } from "../../integrations/privy/user-reader.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";
import {
  parsePerpWalletBindingMutationRequest,
  parsePerpWalletBindingResource,
  unboundPerpWalletBindingResource,
  type PerpWalletBindingResource,
} from "./wallet-binding-contract.js";
import {
  findExactPrivyWallet,
  parsePrivyEmbeddedEthereumWallets,
  PrivyWalletCatalogUnavailableError,
  type PrivyEmbeddedEthereumWallet,
} from "./privy-wallet-catalog.js";
import { parsePerpWalletBindingRecord } from "./wallet-binding-record.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const principalSchema = z
  .object({
    userId: z.string().regex(canonicalUuidPattern),
    privyUserId: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\x21-\x7e]+$/),
    streamUserId: z.string().min(1).max(63),
  })
  .strict();

export interface PerpWalletBindingServiceInput {
  readonly principal: AuthenticatedLoopPrincipal;
}

export interface ChangePerpWalletBindingInput extends PerpWalletBindingServiceInput {
  readonly body: unknown;
  readonly signal: AbortSignal;
}

export interface DeletePerpWalletBindingInput extends PerpWalletBindingServiceInput {
  readonly expectedBindingVersion: unknown;
}

export interface PerpWalletBindingService {
  get(input: PerpWalletBindingServiceInput): Promise<PerpWalletBindingResource>;
  put(input: ChangePerpWalletBindingInput): Promise<PerpWalletBindingResource>;
  delete(
    input: DeletePerpWalletBindingInput,
  ): Promise<PerpWalletBindingResource>;
}

export class InvalidPerpWalletBindingRequestError extends Error {
  constructor() {
    super("The Perp wallet-binding request is invalid");
    this.name = "InvalidPerpWalletBindingRequestError";
  }
}

export class PerpWalletBindingVersionConflictError extends Error {
  constructor() {
    super("The Perp wallet-binding version conflicts");
    this.name = "PerpWalletBindingVersionConflictError";
  }
}

export class PerpWalletBindingUnavailableError extends Error {
  constructor() {
    super("The Perp wallet-binding lifecycle is unavailable");
    this.name = "PerpWalletBindingUnavailableError";
  }
}

export class PerpWalletBindingSelectionRequiredError extends Error {
  constructor() {
    super("A unique eligible Privy wallet is required");
    this.name = "PerpWalletBindingSelectionRequiredError";
  }
}

function assertPrincipal(
  value: AuthenticatedLoopPrincipal,
): AuthenticatedLoopPrincipal {
  const parsed = principalSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidPerpWalletBindingRequestError();
  }
  let streamUserId: string;
  try {
    streamUserId = deriveStreamUserId(parsed.data.userId);
  } catch {
    throw new InvalidPerpWalletBindingRequestError();
  }
  if (streamUserId !== parsed.data.streamUserId) {
    throw new InvalidPerpWalletBindingRequestError();
  }
  return parsed.data;
}

function toResource(
  record: PerpWalletBindingRecord | null,
  principal: AuthenticatedLoopPrincipal,
): PerpWalletBindingResource {
  if (record === null) {
    return unboundPerpWalletBindingResource;
  }
  try {
    const parsed = parsePerpWalletBindingRecord(record, {
      ownerUserId: principal.userId,
      privyUserId: principal.privyUserId,
    });
    return parsePerpWalletBindingResource({
      state: parsed.state,
      binding_version: parsed.bindingVersion,
      account_kind: parsed.accountKind,
      last_verified_at: parsed.lastVerifiedAt,
    });
  } catch {
    throw new PerpWalletBindingUnavailableError();
  }
}

function readStoredRecord(
  repository: PerpWalletBindingRepository,
  principal: AuthenticatedLoopPrincipal,
): Promise<PerpWalletBindingRecord | null> {
  return repository.get({
    ownerUserId: principal.userId,
    privyUserId: principal.privyUserId,
  });
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof InvalidPerpWalletBindingRequestError ||
    error instanceof PerpWalletBindingSelectionRequiredError ||
    error instanceof PerpWalletBindingUnavailableError
  ) {
    throw error;
  }
  if (error instanceof PerpWalletBindingRepositoryVersionConflictError) {
    throw new PerpWalletBindingVersionConflictError();
  }
  if (error instanceof PerpWalletBindingRepositoryUnavailableError) {
    throw new PerpWalletBindingUnavailableError();
  }
  throw new PerpWalletBindingUnavailableError();
}

async function readWallets(
  reader: PrivyUserReader,
  principal: AuthenticatedLoopPrincipal,
  signal: AbortSignal,
): Promise<readonly PrivyEmbeddedEthereumWallet[]> {
  signal.throwIfAborted();
  try {
    const user = await reader.readCurrentUser({
      privyUserId: principal.privyUserId,
      signal,
    });
    return parsePrivyEmbeddedEthereumWallets(user, principal.privyUserId);
  } catch (error) {
    if (signal.aborted) {
      signal.throwIfAborted();
      throw error;
    }
    if (error instanceof PrivyWalletCatalogUnavailableError) {
      throw new PerpWalletBindingUnavailableError();
    }
    throw new PerpWalletBindingUnavailableError();
  }
}

function selectWallet(
  current: PerpWalletBindingRecord | null,
  wallets: readonly PrivyEmbeddedEthereumWallet[],
  principal: AuthenticatedLoopPrincipal,
): PrivyEmbeddedEthereumWallet {
  let parsedCurrent: PerpWalletBindingRecord | null = null;
  if (current !== null) {
    try {
      parsedCurrent = parsePerpWalletBindingRecord(current, {
        ownerUserId: principal.userId,
        privyUserId: principal.privyUserId,
      });
    } catch {
      throw new PerpWalletBindingUnavailableError();
    }
  }

  if (parsedCurrent?.state === "bound") {
    let exact;
    try {
      exact = findExactPrivyWallet(wallets, {
        walletId: parsedCurrent.walletId,
        accountAddress: parsedCurrent.accountAddress!,
      });
    } catch {
      throw new PerpWalletBindingUnavailableError();
    }
    if (exact !== null) {
      return exact;
    }
  }

  if (wallets.length !== 1) {
    throw new PerpWalletBindingSelectionRequiredError();
  }
  return wallets[0]!;
}

export function createPerpWalletBindingService(options: {
  readonly repository: PerpWalletBindingRepository;
  readonly userReader: PrivyUserReader;
  readonly createRequestId?: () => string;
}): PerpWalletBindingService {
  const createRequestId = options.createRequestId ?? randomUUID;
  return Object.freeze({
    async get(
      input: PerpWalletBindingServiceInput,
    ): Promise<PerpWalletBindingResource> {
      const principal = assertPrincipal(input.principal);
      try {
        return toResource(
          await readStoredRecord(options.repository, principal),
          principal,
        );
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async put(
      input: ChangePerpWalletBindingInput,
    ): Promise<PerpWalletBindingResource> {
      const principal = assertPrincipal(input.principal);
      input.signal.throwIfAborted();
      let request;
      try {
        request = parsePerpWalletBindingMutationRequest(input.body);
      } catch {
        throw new InvalidPerpWalletBindingRequestError();
      }

      try {
        const current = await readStoredRecord(options.repository, principal);
        const wallets = await readWallets(
          options.userReader,
          principal,
          input.signal,
        );
        input.signal.throwIfAborted();
        const selected = selectWallet(current, wallets, principal);
        return toResource(
          await options.repository.putVerifiedBinding({
            ownerUserId: principal.userId,
            privyUserId: principal.privyUserId,
            expectedBindingVersion: request.expected_binding_version,
            requestId: createRequestId(),
            walletId: selected.walletId,
            accountAddress: selected.accountAddress,
            accountKind: "master",
          }),
          principal,
        );
      } catch (error) {
        if (input.signal.aborted) {
          input.signal.throwIfAborted();
          throw error;
        }
        if (
          error instanceof InvalidPerpWalletBindingRequestError ||
          error instanceof PerpWalletBindingSelectionRequiredError ||
          error instanceof PerpWalletBindingUnavailableError
        ) {
          throw error;
        }
        return translateRepositoryError(error);
      }
    },

    async delete(
      input: DeletePerpWalletBindingInput,
    ): Promise<PerpWalletBindingResource> {
      const principal = assertPrincipal(input.principal);
      let request;
      try {
        request = parsePerpWalletBindingMutationRequest({
          expected_binding_version: input.expectedBindingVersion,
        });
      } catch {
        throw new InvalidPerpWalletBindingRequestError();
      }
      try {
        return toResource(
          await options.repository.unbind({
            ownerUserId: principal.userId,
            privyUserId: principal.privyUserId,
            expectedBindingVersion: request.expected_binding_version,
            requestId: createRequestId(),
          }),
          principal,
        );
      } catch (error) {
        return translateRepositoryError(error);
      }
    },
  });
}
