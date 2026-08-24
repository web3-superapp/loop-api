export interface AllocatePrivyAgentIdentityInput {
  readonly authorizationId: string;
  readonly ownerUserId: string;
  readonly privyUserId: string;
  readonly network: "testnet";
  readonly signal: AbortSignal;
}

/**
 * Allocator output remains unknown until the Privy wallet lifecycle, policy,
 * credential, and negative-revocation evidence is reviewed. Implementations
 * must never return a private key, recovery material, or signing credential.
 */
export interface PrivyAgentIdentityAllocator {
  allocate(input: AllocatePrivyAgentIdentityInput): Promise<unknown>;
}

export class PrivyAgentIdentityAllocatorUnavailableError extends Error {
  readonly code = "privy_agent_identity_allocator_unavailable";

  constructor() {
    super("Privy Agent identity allocation is unavailable");
    this.name = "PrivyAgentIdentityAllocatorUnavailableError";
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new PrivyAgentIdentityAllocatorUnavailableError());
}

export function createUnavailablePrivyAgentIdentityAllocator(): PrivyAgentIdentityAllocator {
  return Object.freeze({ allocate: unavailable });
}
