import { z } from "zod";

import type { PerpWalletBindingRepository } from "../../database/perp-wallet-binding-repository.js";
import type { PrivyUserReader } from "../../integrations/privy/user-reader.js";
import {
  findExactPrivyWallet,
  parsePrivyEmbeddedEthereumWallets,
} from "./privy-wallet-catalog.js";
import { parsePerpWalletBindingRecord } from "./wallet-binding-record.js";
import {
  createUnavailableWalletBindingResolver,
  WalletBindingRequiredError,
  WalletBindingResolutionUnavailableError,
  type ResolveWalletBindingInput,
  type VerifiedWalletBinding,
  type VerifiedWalletBindingAuthority,
  type WalletAccountKind,
  type WalletBindingAuthorityResolver,
  type WalletBindingResolver,
} from "../wallet/wallet-binding-resolver.js";

export { WalletBindingRequiredError, WalletBindingResolutionUnavailableError };

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

export type PerpWalletAccountKind = WalletAccountKind;
export type VerifiedPerpWalletBinding = VerifiedWalletBinding;
export type ResolvePerpWalletBindingInput = ResolveWalletBindingInput;
export type PerpWalletBindingResolver = WalletBindingResolver;

export function createUnavailablePerpWalletBindingResolver(): PerpWalletBindingResolver {
  return createUnavailableWalletBindingResolver();
}

export function createPerpWalletBindingResolver(options: {
  readonly repository: PerpWalletBindingRepository;
  readonly userReader: PrivyUserReader;
  readonly now?: () => number;
}): PerpWalletBindingResolver & WalletBindingAuthorityResolver {
  const now = options.now ?? Date.now;
  async function resolveAuthority(
    input: ResolvePerpWalletBindingInput,
  ): Promise<VerifiedWalletBindingAuthority> {
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
      walletId: record.walletId,
      accountAddress: exact.accountAddress,
      accountKind: "master" as const,
      bindingVersion: record.bindingVersion,
      verifiedAt: verifiedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    } satisfies VerifiedWalletBindingAuthority);
  }

  return Object.freeze({
    async resolve(input: ResolvePerpWalletBindingInput): Promise<unknown> {
      const authority = await resolveAuthority(input);
      return Object.freeze({
        ownerUserId: authority.ownerUserId,
        privyUserId: authority.privyUserId,
        accountAddress: authority.accountAddress,
        accountKind: authority.accountKind,
        bindingVersion: authority.bindingVersion,
        verifiedAt: authority.verifiedAt,
        expiresAt: authority.expiresAt,
      } satisfies VerifiedPerpWalletBinding);
    },
    resolveAuthority,
  });
}
