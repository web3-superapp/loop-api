import { describe, expect, it } from "vitest";

import {
  InvalidAgentAuthorizationContractError,
  digestAgentAuthorizationReview,
  parseAgentAuthorizationResource,
  parseAgentAuthorizationReview,
  parseAgentAuthorizationSignatureRequest,
} from "../src/features/perp/agent-authorization-contract.js";

const authorizationId = "10000000-0000-4000-8000-000000000001";
const accountAddress = "0x1111111111111111111111111111111111111111";
const signerWalletAddress = "0x2222222222222222222222222222222222222222";
const agentAddress = "0x3333333333333333333333333333333333333333";
const validUntil = "2026-08-26T12:00:00.000Z";
const expiresAt = "2026-08-25T12:05:00.000Z";
const createdAt = "2026-08-25T12:00:00.000Z";

const review = {
  version: "perp_agent_authorization_review_v1",
  provider: "hyperliquid",
  network: "testnet",
  action: "approve_agent",
  account: {
    address: accountAddress,
    kind: "master",
  },
  signer_wallet_address: signerWalletAddress,
  agent: {
    address: agentAddress,
    name: "loop-test-agent",
    valid_until: validUntil,
  },
} as const;

function preparedResource(): Record<string, unknown> {
  return {
    authorization_id: authorizationId,
    state: "prepared",
    review,
    signature: { state: "required" },
    expires_at: expiresAt,
    result: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe("Agent authorization contract", () => {
  it("parses and deeply freezes the exact sanitized review and resource", () => {
    const parsedReview = parseAgentAuthorizationReview(review);
    const resource = parseAgentAuthorizationResource(preparedResource());

    expect(parsedReview).toEqual(review);
    expect(resource).toEqual(preparedResource());
    expect(Object.isFrozen(resource)).toBe(true);
    expect(Object.isFrozen(resource.review)).toBe(true);
    expect(Object.isFrozen(resource.review.agent)).toBe(true);
    expect(Object.isFrozen(resource.signature)).toBe(true);
    expect(JSON.stringify(resource)).not.toContain("typed_data");
    expect(JSON.stringify(resource)).not.toContain("digest");
    expect(JSON.stringify(resource)).not.toContain("nonce");
  });

  it("rejects widened authority, Mainnet, zero or mixed-case addresses, and inconsistent status", () => {
    const invalidValues = [
      { ...preparedResource(), owner_user_id: authorizationId },
      {
        ...preparedResource(),
        review: { ...review, network: "mainnet" },
      },
      {
        ...preparedResource(),
        review: {
          ...review,
          signer_wallet_address: "0x0000000000000000000000000000000000000000",
        },
      },
      {
        ...preparedResource(),
        review: {
          ...review,
          agent: {
            ...review.agent,
            address: "0xA333333333333333333333333333333333333333",
          },
        },
      },
      {
        ...preparedResource(),
        state: "expired",
        signature: { state: "required" },
      },
      {
        ...preparedResource(),
        state: "active",
        signature: { state: "consumed" },
        result: null,
      },
    ];

    for (const value of invalidValues) {
      expect(() => parseAgentAuthorizationResource(value)).toThrow(
        InvalidAgentAuthorizationContractError,
      );
    }
  });

  it("accepts only one bounded opaque signature string", () => {
    const parsed = parseAgentAuthorizationSignatureRequest({
      signature: "0xdeadbeef",
    });

    expect(parsed).toEqual({ signature: "0xdeadbeef" });
    expect(Object.isFrozen(parsed)).toBe(true);

    const invalidValues: unknown[] = [
      null,
      {},
      { signature: "" },
      { signature: " contains-space" },
      { signature: "line\nbreak" },
      { signature: "x".repeat(1_025) },
      { signature: "0xdeadbeef", typed_data: {} },
      { signature: "0xdeadbeef", digest: `0x${"a".repeat(64)}` },
      { signature: "0xdeadbeef", nonce: "1" },
      Object.create({ signature: "0xdeadbeef" }),
    ];

    for (const value of invalidValues) {
      expect(() => parseAgentAuthorizationSignatureRequest(value)).toThrow(
        InvalidAgentAuthorizationContractError,
      );
    }
  });

  it("rejects accessors and symbols without invoking them", () => {
    let reads = 0;
    const value = Object.defineProperty({}, "signature", {
      enumerable: true,
      get() {
        reads += 1;
        return "0xdeadbeef";
      },
    });
    const symbolValue = {
      signature: "0xdeadbeef",
      [Symbol("authority")]: true,
    };

    expect(() => parseAgentAuthorizationSignatureRequest(value)).toThrow(
      InvalidAgentAuthorizationContractError,
    );
    expect(() => parseAgentAuthorizationSignatureRequest(symbolValue)).toThrow(
      InvalidAgentAuthorizationContractError,
    );
    expect(reads).toBe(0);
  });

  it("uses a deterministic domain-separated digest for the sanitized review", () => {
    const first = digestAgentAuthorizationReview(review);
    const second = digestAgentAuthorizationReview({
      action: "approve_agent",
      network: "testnet",
      provider: "hyperliquid",
      version: "perp_agent_authorization_review_v1",
      agent: {
        valid_until: validUntil,
        name: "loop-test-agent",
        address: agentAddress,
      },
      signer_wallet_address: signerWalletAddress,
      account: { kind: "master", address: accountAddress },
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });
});
