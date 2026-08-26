export type WalletAccountKind = "master" | "subaccount";

/**
 * A wallet binding is provider authority, not a Perp or Spot resource. Feature
 * services must still parse and revalidate the unknown resolver output before
 * using it for a read, review, signature, or provider write.
 */
export interface VerifiedWalletBinding {
  readonly ownerUserId: string;
  readonly privyUserId: string;
  readonly accountAddress: string;
  readonly accountKind: WalletAccountKind;
  readonly bindingVersion: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
}

export interface ResolveWalletBindingInput {
  readonly ownerUserId: string;
  readonly privyUserId: string;
  readonly signal: AbortSignal;
}

export interface WalletBindingResolver {
  resolve(input: ResolveWalletBindingInput): Promise<unknown>;
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
  // Absence of a resolver is not evidence that a wallet is eligible. The
  // neutral default therefore remains fail-closed for every product domain.
  return Promise.reject(new WalletBindingRequiredError());
}

export function createUnavailableWalletBindingResolver(): WalletBindingResolver {
  return Object.freeze({ resolve: unavailable });
}
