import type { PerpWalletAccountKind } from "../../features/perp/wallet-binding-resolver.js";

export interface IssueHyperliquidAgentAuthorizationInput {
  readonly authorizationId: string;
  readonly ownerUserId: string;
  readonly privyUserId: string;
  readonly network: "testnet";
  readonly action: "approve_agent";
  readonly signal: AbortSignal;
}

export interface SubmitHyperliquidAgentAuthorizationSignatureInput {
  readonly authorizationId: string;
  readonly ownerUserId: string;
  readonly requestId: string;
  readonly accountAddress: string;
  readonly accountKind: PerpWalletAccountKind;
  readonly signerWalletAddress: string;
  readonly agentAddress: string;
  readonly agentName: string;
  readonly agentValidUntil: string;
  readonly signingDigest: string;
  readonly signature: string;
  readonly network: "testnet";
  readonly action: "approve_agent";
  readonly signal: AbortSignal;
}

/**
 * Both outputs deliberately remain unknown. No exact official typed-data
 * payload or externally signed relay continuation is available in the local
 * authority. This type is not composed into the current runtime; a future
 * reviewed adapter also requires atomic persistence and transport journaling
 * before it may become an injectable effectful dependency.
 */
export interface HyperliquidAgentAuthorizationHandoff {
  issue(input: IssueHyperliquidAgentAuthorizationInput): Promise<unknown>;
  submitSignature(
    input: SubmitHyperliquidAgentAuthorizationSignatureInput,
  ): Promise<unknown>;
}

export class HyperliquidAgentAuthorizationHandoffUnavailableError extends Error {
  readonly code = "hyperliquid_agent_authorization_handoff_unavailable";

  constructor() {
    super("Hyperliquid Agent authorization handoff is unavailable");
    this.name = "HyperliquidAgentAuthorizationHandoffUnavailableError";
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(
    new HyperliquidAgentAuthorizationHandoffUnavailableError(),
  );
}

export function createUnavailableHyperliquidAgentAuthorizationHandoff(): HyperliquidAgentAuthorizationHandoff {
  return Object.freeze({ issue: unavailable, submitSignature: unavailable });
}
