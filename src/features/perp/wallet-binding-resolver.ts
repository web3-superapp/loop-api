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
