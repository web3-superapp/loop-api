import { describe, expect, it } from "vitest";

import {
  createUnavailablePerpWalletBindingResolver,
  WalletBindingRequiredError as PerpWalletBindingRequiredError,
  WalletBindingResolutionUnavailableError as PerpWalletBindingResolutionUnavailableError,
} from "../src/features/perp/wallet-binding-resolver.js";
import {
  createUnavailableWalletBindingAuthorityResolver,
  createUnavailableWalletBindingResolver,
  WalletBindingRequiredError,
  WalletBindingResolutionUnavailableError,
} from "../src/features/wallet/wallet-binding-resolver.js";

describe("provider-neutral wallet-binding resolver port", () => {
  it("keeps the Perp compatibility exports on the same runtime errors", () => {
    expect(PerpWalletBindingRequiredError).toBe(WalletBindingRequiredError);
    expect(PerpWalletBindingResolutionUnavailableError).toBe(
      WalletBindingResolutionUnavailableError,
    );
  });

  it.each([
    createUnavailableWalletBindingResolver,
    createUnavailablePerpWalletBindingResolver,
  ])("fails closed when no authority adapter is available", async (create) => {
    const resolver = create();
    await expect(
      resolver.resolve({
        ownerUserId: "2f79618d-fb9e-4e63-9553-244739148fb8",
        privyUserId: "did:privy:wallet-port",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(WalletBindingRequiredError);
  });

  it("distinguishes a missing enriched authority adapter from an absent binding", async () => {
    await expect(
      createUnavailableWalletBindingAuthorityResolver().resolveAuthority({
        ownerUserId: "2f79618d-fb9e-4e63-9553-244739148fb8",
        privyUserId: "did:privy:wallet-port",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(WalletBindingResolutionUnavailableError);
  });
});
