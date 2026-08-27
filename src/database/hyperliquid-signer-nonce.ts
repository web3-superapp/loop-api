/**
 * Hyperliquid accepts signer nonces only inside a bounded wall-clock window.
 * Keep this provider-wide bound neutral: owner-wallet authorization and Spot
 * Agent order allocation share the same protocol rule without sharing a
 * domain repository implementation.
 */
export const HYPERLIQUID_SIGNER_NONCE_FUTURE_WINDOW_MILLISECONDS = 86_400_000;
