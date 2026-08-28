import { describe, expect, it, vi } from "vitest";

import {
  SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
  SpotAgentAuthorizationAuthorityStaleError,
  SpotAgentAuthorizationRepositoryUnavailableError,
  type SpotActiveAgentAuthorityReader,
} from "../src/database/spot-agent-authorization-repository.js";
import { createSpotIntentPrepareAuthorityResolver } from "../src/features/spot/spot-intent-prepare-authority-resolver.js";
import {
  SpotIntentPrepareAuthorityRequiredError,
  SpotIntentPrepareAuthorityUnavailableError,
} from "../src/features/spot/spot-intent-prepare.js";
import {
  WalletBindingRequiredError,
  WalletBindingResolutionUnavailableError,
  type WalletBindingAuthorityResolver,
} from "../src/features/wallet/wallet-binding-resolver.js";

const ownerUserId = "260a234f-36bd-4b61-88d1-546272a31e3c";
const otherOwnerUserId = "8f08d01b-3607-4c42-bbc6-8e90f4b202c9";
const privyUserId = "did:privy:spot-prepare-authority";
const walletId = "wallet-spot-prepare-authority";
const accountAddress = "0x1111111111111111111111111111111111111111";
const requestId = "1ad7f07b-4f84-4f98-9ad2-2a7d12f1e123";
const authorizationId = "5c841b16-63b7-4a2a-a6f6-8a36c8313ddd";
const agentIdentityId = "207ce6bd-e87b-4ec8-866c-a46e0807485c";

function walletAuthority(overrides: Record<string, unknown> = {}) {
  return {
    ownerUserId,
    privyUserId,
    walletId,
    accountAddress,
    accountKind: "master",
    bindingVersion: "7",
    verifiedAt: "2026-08-28T01:00:00.000Z",
    expiresAt: "2026-08-28T01:00:15.000Z",
    ...overrides,
  };
}

function activeAgent(overrides: Record<string, unknown> = {}) {
  return {
    authorizationId,
    agentIdentityId,
    agentValidUntil: "2026-08-29T01:00:00.000Z",
    ...overrides,
  };
}

function resolveInput(signal = new AbortController().signal) {
  return {
    ownerUserId,
    privyUserId,
    network: "testnet" as const,
    requestId,
    signal,
  };
}

function harness() {
  const calls: string[] = [];
  const resolveAuthority = vi.fn<
    WalletBindingAuthorityResolver["resolveAuthority"]
  >(() => {
    calls.push("wallet");
    return Promise.resolve(walletAuthority());
  });
  const findCurrentActive = vi.fn<
    SpotActiveAgentAuthorityReader["findCurrentActive"]
  >(() => {
    calls.push("agent");
    return Promise.resolve(activeAgent());
  });
  return {
    calls,
    findCurrentActive,
    resolveAuthority,
    resolver: createSpotIntentPrepareAuthorityResolver({
      walletBindingAuthorityResolver: { resolveAuthority },
      activeAgentAuthorityReader: { findCurrentActive },
    }),
  };
}

describe("Spot intent prepare authority resolver", () => {
  it("resolves fresh wallet authority before the exact active Agent", async () => {
    const input = harness();

    await expect(input.resolver.resolve(resolveInput())).resolves.toEqual({
      ownerUserId,
      privyUserId,
      walletId,
      accountAddress,
      accountKind: "master",
      bindingVersion: "7",
      agentIdentityId,
      verifiedAt: "2026-08-28T01:00:00.000Z",
      expiresAt: "2026-08-28T01:00:15.000Z",
    });
    expect(input.calls).toEqual(["wallet", "agent"]);
    expect(input.findCurrentActive).toHaveBeenCalledWith({
      ownerUserId,
      privyUserId,
      requestId,
      walletId,
      accountAddress,
      accountKind: "master",
      bindingVersion: "7",
      verifiedAt: "2026-08-28T01:00:00.000Z",
      expiresAt: "2026-08-28T01:00:15.000Z",
      policyVersion: SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
    });
    const result = await input.resolver.resolve(resolveInput());
    expect(result).not.toHaveProperty("authorizationId");
    expect(result).not.toHaveProperty("agentValidUntil");
    expect(result).not.toHaveProperty("agentAddress");
    expect(result).not.toHaveProperty("signerRef");
  });

  it.each([
    ["missing binding", new WalletBindingRequiredError()],
    ["missing stored wallet ID", null],
  ] as const)("requires refreshed authority for %s", async (_label, value) => {
    const input = harness();
    if (value instanceof Error) {
      input.resolveAuthority.mockRejectedValueOnce(value);
    } else {
      input.resolveAuthority.mockResolvedValueOnce(
        walletAuthority({ walletId: value }),
      );
    }

    await expect(input.resolver.resolve(resolveInput())).rejects.toBeInstanceOf(
      SpotIntentPrepareAuthorityRequiredError,
    );
    expect(input.findCurrentActive).not.toHaveBeenCalled();
  });

  it.each([
    [
      "wallet provider unavailable",
      new WalletBindingResolutionUnavailableError(),
    ],
    ["unknown wallet failure", new Error("sensitive wallet failure")],
  ] as const)("sanitizes %s", async (_label, error) => {
    const input = harness();
    input.resolveAuthority.mockRejectedValueOnce(error);

    await expect(input.resolver.resolve(resolveInput())).rejects.toBeInstanceOf(
      SpotIntentPrepareAuthorityUnavailableError,
    );
    expect(input.findCurrentActive).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong owner", { ownerUserId: otherOwnerUserId }],
    ["wrong Privy subject", { privyUserId: "did:privy:other" }],
    ["subaccount", { accountKind: "subaccount" }],
    ["zero address", { accountAddress: `0x${"0".repeat(40)}` }],
    ["invalid epoch", { bindingVersion: "0" }],
    [
      "future-to-past lease",
      {
        verifiedAt: "2026-08-28T01:00:15.000Z",
        expiresAt: "2026-08-28T01:00:00.000Z",
      },
    ],
    ["overlong lease", { expiresAt: "2026-08-28T01:00:15.001Z" }],
    ["extra authority field", { signerRef: "must-not-pass" }],
  ] as const)(
    "rejects malformed wallet authority: %s",
    async (_label, drift) => {
      const input = harness();
      input.resolveAuthority.mockResolvedValueOnce(walletAuthority(drift));

      await expect(
        input.resolver.resolve(resolveInput()),
      ).rejects.toBeInstanceOf(SpotIntentPrepareAuthorityUnavailableError);
      expect(input.findCurrentActive).not.toHaveBeenCalled();
    },
  );

  it("requires a current active Agent without exposing its internal record", async () => {
    const input = harness();
    input.findCurrentActive.mockResolvedValueOnce(null);

    await expect(input.resolver.resolve(resolveInput())).rejects.toBeInstanceOf(
      SpotIntentPrepareAuthorityRequiredError,
    );
  });

  it.each([
    ["stale Agent authority", new SpotAgentAuthorizationAuthorityStaleError()],
    [
      "repository unavailable",
      new SpotAgentAuthorizationRepositoryUnavailableError(),
    ],
    ["unknown Agent failure", new Error("sensitive database failure")],
  ] as const)("sanitizes %s", async (_label, error) => {
    const input = harness();
    input.findCurrentActive.mockRejectedValueOnce(error);

    await expect(input.resolver.resolve(resolveInput())).rejects.toBeInstanceOf(
      SpotIntentPrepareAuthorityUnavailableError,
    );
  });

  it.each([
    ["wrong authorization ID", { authorizationId: "not-a-uuid" }],
    ["wrong identity ID", { agentIdentityId: "not-a-uuid" }],
    ["malformed expiry", { agentValidUntil: "tomorrow" }],
    ["extra Agent field", { agentAddress: accountAddress }],
  ] as const)(
    "rejects malformed active Agent output: %s",
    async (_label, drift) => {
      const input = harness();
      input.findCurrentActive.mockResolvedValueOnce(activeAgent(drift));

      await expect(
        input.resolver.resolve(resolveInput()),
      ).rejects.toBeInstanceOf(SpotIntentPrepareAuthorityUnavailableError);
    },
  );

  it("propagates an outer abort before any dependency work", async () => {
    const input = harness();
    const controller = new AbortController();
    const reason = new Error("outer abort");
    controller.abort(reason);

    await expect(
      input.resolver.resolve(resolveInput(controller.signal)),
    ).rejects.toBe(reason);
    expect(input.resolveAuthority).not.toHaveBeenCalled();
    expect(input.findCurrentActive).not.toHaveBeenCalled();
  });

  it.each(["wallet", "agent"] as const)(
    "propagates an abort raised during the %s stage",
    async (stage) => {
      const input = harness();
      const controller = new AbortController();
      const reason = new Error(`${stage} abort`);
      if (stage === "wallet") {
        input.resolveAuthority.mockImplementationOnce(() => {
          controller.abort(reason);
          return Promise.reject(new Error("must be replaced by abort"));
        });
      } else {
        input.findCurrentActive.mockImplementationOnce(() => {
          controller.abort(reason);
          return Promise.resolve(activeAgent());
        });
      }

      await expect(
        input.resolver.resolve(resolveInput(controller.signal)),
      ).rejects.toBe(reason);
    },
  );

  it("rejects malformed resolver input without touching dependencies", async () => {
    const input = harness();

    await expect(
      input.resolver.resolve({
        ...resolveInput(),
        network: "mainnet",
      } as never),
    ).rejects.toBeInstanceOf(SpotIntentPrepareAuthorityUnavailableError);
    expect(input.resolveAuthority).not.toHaveBeenCalled();
    expect(input.findCurrentActive).not.toHaveBeenCalled();
  });
});
