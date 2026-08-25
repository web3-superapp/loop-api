import { z } from "zod";

import type { PerpWalletBindingRepository } from "../../database/perp-wallet-binding-repository.js";
import type { PrivyUserReader } from "../../integrations/privy/user-reader.js";
import {
  findExactPrivyWallet,
  parsePrivyEmbeddedEthereumWallets,
} from "./privy-wallet-catalog.js";
import { parsePerpWalletBindingRecord } from "./wallet-binding-record.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const resolverInputSchema = z
  .object({
    ownerUserId: z.string().regex(canonicalUuidPattern),
    privyUserId: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\x21-\x7e]+$/),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();

const verifiedLeaseMilliseconds = 15_000;

export type PerpWalletAccountKind = "master" | "subaccount";

/**
 * The service layer must parse and revalidate resolver output before using it.
 * The resolver deliberately returns `unknown` so a provider/database adapter
 * cannot silently widen this security boundary.
 */
export interface VerifiedPerpWalletBinding {
  readonly ownerUserId: string;
  readonly privyUserId: string;
  readonly accountAddress: string;
  readonly accountKind: PerpWalletAccountKind;
  readonly bindingVersion: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
}

export interface ResolvePerpWalletBindingInput {
  readonly ownerUserId: string;
  readonly privyUserId: string;
  readonly signal: AbortSignal;
}

export interface PerpWalletBindingResolver {
  resolve(input: ResolvePerpWalletBindingInput): Promise<unknown>;
}

export class WalletBindingRequiredError extends Error {
  readonly code = "wallet_binding_required";

  constructor() {
    super("A verified wallet binding is required");
    this.name = "WalletBindingRequiredError";
  }
}

export class WalletBindingResolutionUnavailableError extends Error {
  readonly code = "wallet_binding_resolution_unavailable";

  constructor() {
    super("Wallet binding resolution is unavailable");
    this.name = "WalletBindingResolutionUnavailableError";
  }
}

function unavailable(): Promise<never> {
  // The default adapter has no evidence of an eligible wallet. It must not
  // guess an address or downgrade absence of evidence into a usable binding.
  return Promise.reject(new WalletBindingRequiredError());
}

export function createUnavailablePerpWalletBindingResolver(): PerpWalletBindingResolver {
  return Object.freeze({ resolve: unavailable });
}

export function createPerpWalletBindingResolver(options: {
  readonly repository: PerpWalletBindingRepository;
  readonly userReader: PrivyUserReader;
  readonly now?: () => number;
}): PerpWalletBindingResolver {
  const now = options.now ?? Date.now;
  return Object.freeze({
    async resolve(input: ResolvePerpWalletBindingInput): Promise<unknown> {
      const parsedInput = resolverInputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new WalletBindingResolutionUnavailableError();
      }
      parsedInput.data.signal.throwIfAborted();

      let stored;
      try {
        stored = await options.repository.get({
          ownerUserId: parsedInput.data.ownerUserId,
          privyUserId: parsedInput.data.privyUserId,
        });
      } catch {
        throw new WalletBindingResolutionUnavailableError();
      }
      parsedInput.data.signal.throwIfAborted();
      if (stored === null) {
        throw new WalletBindingRequiredError();
      }

      let record;
      try {
        record = parsePerpWalletBindingRecord(stored, {
          ownerUserId: parsedInput.data.ownerUserId,
          privyUserId: parsedInput.data.privyUserId,
        });
      } catch {
        throw new WalletBindingResolutionUnavailableError();
      }
      if (record.state !== "bound") {
        throw new WalletBindingRequiredError();
      }

      let user;
      try {
        user = await options.userReader.readCurrentUser({
          privyUserId: parsedInput.data.privyUserId,
          signal: parsedInput.data.signal,
        });
      } catch (error) {
        if (parsedInput.data.signal.aborted) {
          parsedInput.data.signal.throwIfAborted();
          throw error;
        }
        throw new WalletBindingResolutionUnavailableError();
      }
      parsedInput.data.signal.throwIfAborted();

      let exact;
      try {
        const wallets = parsePrivyEmbeddedEthereumWallets(
          user,
          parsedInput.data.privyUserId,
        );
        exact = findExactPrivyWallet(wallets, {
          walletId: record.walletId,
          accountAddress: record.accountAddress!,
        });
      } catch {
        throw new WalletBindingResolutionUnavailableError();
      }
      if (exact === null) {
        throw new WalletBindingRequiredError();
      }

      const verifiedAtMilliseconds = now();
      if (
        !Number.isSafeInteger(verifiedAtMilliseconds) ||
        verifiedAtMilliseconds < 0
      ) {
        throw new WalletBindingResolutionUnavailableError();
      }
      const verifiedAt = new Date(verifiedAtMilliseconds);
      const expiresAt = new Date(
        verifiedAtMilliseconds + verifiedLeaseMilliseconds,
      );
      if (
        Number.isNaN(verifiedAt.getTime()) ||
        Number.isNaN(expiresAt.getTime())
      ) {
        throw new WalletBindingResolutionUnavailableError();
      }

      return Object.freeze({
        ownerUserId: record.ownerUserId,
        privyUserId: record.privyUserId,
        accountAddress: exact.accountAddress,
        accountKind: "master" as const,
        bindingVersion: record.bindingVersion,
        verifiedAt: verifiedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      } satisfies VerifiedPerpWalletBinding);
    },
  });
}
