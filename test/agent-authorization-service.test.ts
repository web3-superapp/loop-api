import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedLoopPrincipal } from "../src/core/http/authentication.js";
import type {
  AgentAuthorizationRecord,
  AgentAuthorizationRepository,
} from "../src/database/agent-authorization-repository.js";
import {
  AgentAuthorizationExpiredError,
  AgentAuthorizationMutationDisabledError,
  AgentAuthorizationNotFoundError,
  AgentAuthorizationUnavailableError,
  createAgentAuthorizationService,
  type AgentAuthorizationMutationGate,
} from "../src/features/perp/agent-authorization-service.js";

const ownerUserId = "10000000-0000-4000-8000-000000000001";
const foreignOwnerUserId = "10000000-0000-4000-8000-000000000002";
const authorizationId = "20000000-0000-4000-8000-000000000001";
const agentIdentityId = "30000000-0000-4000-8000-000000000001";
const requestId = "40000000-0000-4000-8000-000000000001";
const now = new Date("2026-08-25T12:00:00.000Z");
const expiresAt = "2026-08-25T12:05:00.000Z";
const validUntil = "2026-08-26T12:00:00.000Z";
const accountAddress = "0x1111111111111111111111111111111111111111";
const signerWalletAddress = "0x2222222222222222222222222222222222222222";
const agentAddress = "0x3333333333333333333333333333333333333333";

const principal: AuthenticatedLoopPrincipal = {
  userId: ownerUserId,
  privyUserId: "did:privy:agent-owner",
  streamUserId: `loop_${ownerUserId.replaceAll("-", "")}`,
};

function fixedRecord(
  overrides: Partial<AgentAuthorizationRecord> = {},
): AgentAuthorizationRecord {
  return {
    id: authorizationId,
    ownerUserId,
    requestSha256: "a".repeat(64),
    agentIdentityId,
    accountAddress,
    accountKind: "master",
    bindingVersion: "7",
    signerWalletAddress,
    agentAddress,
    agentName: "loop-test-agent",
    agentValidUntil: validUntil,
    publicReview: {
      version: "perp_agent_authorization_review_v1",
      provider: "hyperliquid",
      network: "testnet",
      action: "approve_agent",
      account: { address: accountAddress, kind: "master" },
      signer_wallet_address: signerWalletAddress,
      agent: {
        address: agentAddress,
        name: "loop-test-agent",
        valid_until: validUntil,
      },
    },
    reviewSha256: "b".repeat(64),
    typedDataPrimaryType: "TestOnlyOpaquePrimaryType",
    signingDigest: `0x${"c".repeat(64)}`,
    typedDataJsonSha256: "d".repeat(64),
    signingExpiresAt: expiresAt,
    state: "prepared",
    result: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

const signatureBody = { signature: "0xdeadbeef" };

function harness(
  options: {
    readonly gate?: AgentAuthorizationMutationGate;
    readonly record?: AgentAuthorizationRecord | null;
  } = {},
) {
  const persistIssued = vi.fn<AgentAuthorizationRepository["persistIssued"]>();
  const findOwned = vi.fn<AgentAuthorizationRepository["findOwned"]>(() =>
    Promise.resolve(
      options.record === undefined ? fixedRecord() : options.record,
    ),
  );
  const repository = {
    persistIssued,
    findOwned,
  } satisfies AgentAuthorizationRepository;
  const service = createAgentAuthorizationService({
    repository,
    ...(options.gate === undefined ? {} : { mutationGate: options.gate }),
    now: () => now,
  });
  return {
    findOwned,
    persistIssued,
    repository,
    service,
  };
}

function issueInput() {
  return {
    principal,
    requestId,
    signal: new AbortController().signal,
  };
}

function signatureInput(body: unknown = signatureBody) {
  return {
    principal,
    authorizationId,
    requestId,
    body,
    signal: new AbortController().signal,
  };
}

const allowGate: AgentAuthorizationMutationGate = {
  assertAllowed: () => Promise.resolve(),
};

describe("Agent authorization service", () => {
  it("denies issuance by default before persistence", async () => {
    const inputs = harness();

    await expect(inputs.service.issue(issueInput())).rejects.toBeInstanceOf(
      AgentAuthorizationMutationDisabledError,
    );
    expect(inputs.findOwned).not.toHaveBeenCalled();
    expect(inputs.persistIssued).not.toHaveBeenCalled();
  });

  it("fails unavailable with an allow gate and creates no non-signable record", async () => {
    const inputs = harness({ gate: allowGate });

    await expect(inputs.service.issue(issueInput())).rejects.toBeInstanceOf(
      AgentAuthorizationUnavailableError,
    );
    expect(inputs.findOwned).not.toHaveBeenCalled();
    expect(inputs.persistIssued).not.toHaveBeenCalled();
  });

  it("returns an owner-bound sanitized status and hides foreign existence", async () => {
    const ownerInputs = harness();
    await expect(
      ownerInputs.service.get({ principal, authorizationId }),
    ).resolves.toMatchObject({
      authorization_id: authorizationId,
      state: "prepared",
      signature: { state: "required" },
      result: null,
    });

    const foreignInputs = harness({
      record: fixedRecord({ ownerUserId: foreignOwnerUserId }),
    });
    await expect(
      foreignInputs.service.get({ principal, authorizationId }),
    ).rejects.toBeInstanceOf(AgentAuthorizationNotFoundError);

    const missingInputs = harness({ record: null });
    await expect(
      missingInputs.service.get({ principal, authorizationId }),
    ).rejects.toBeInstanceOf(AgentAuthorizationNotFoundError);
  });

  it("denies a current prepared signature by default without persistence", async () => {
    const inputs = harness();

    await expect(
      inputs.service.submitSignature(signatureInput()),
    ).rejects.toBeInstanceOf(AgentAuthorizationMutationDisabledError);
    expect(inputs.findOwned).toHaveBeenCalledOnce();
    expect(inputs.persistIssued).not.toHaveBeenCalled();
  });

  it("rejects stored or elapsed expiry before the mutation gate", async () => {
    const gate = {
      assertAllowed: vi.fn<AgentAuthorizationMutationGate["assertAllowed"]>(),
    };
    const storedExpired = harness({
      gate,
      record: fixedRecord({
        state: "expired",
        signingExpiresAt: "2026-08-25T11:59:59.000Z",
      }),
    });
    const elapsed = harness({
      gate,
      record: fixedRecord({
        signingExpiresAt: "2026-08-25T11:59:59.000Z",
      }),
    });

    await expect(
      storedExpired.service.submitSignature(signatureInput()),
    ).rejects.toBeInstanceOf(AgentAuthorizationExpiredError);
    await expect(
      elapsed.service.submitSignature(signatureInput()),
    ).rejects.toBeInstanceOf(AgentAuthorizationExpiredError);
    expect(gate.assertAllowed).not.toHaveBeenCalled();
  });

  it.each([
    "submitting",
    "accepted",
    "active",
    "rejected",
    "failed",
    "unknown",
    "reconciling",
  ] as const)(
    "returns current %s status without another relay",
    async (state) => {
      let result: AgentAuthorizationRecord["result"] = null;
      if (
        state === "active" ||
        state === "rejected" ||
        state === "failed" ||
        state === "unknown" ||
        state === "reconciling"
      ) {
        result = {
          state: state === "reconciling" ? "unknown" : state,
          observed_at: now.toISOString(),
          reason_code: null,
        };
      }
      const inputs = harness({ record: fixedRecord({ state, result }) });

      await expect(
        inputs.service.submitSignature(signatureInput()),
      ).resolves.toMatchObject({
        authorization_id: authorizationId,
        state,
        signature: { state: "consumed" },
      });
      expect(inputs.persistIssued).not.toHaveBeenCalled();
    },
  );

  it("fails an allowed relay locally without forwarding or persisting the signature", async () => {
    const inputs = harness({ gate: allowGate });

    await expect(
      inputs.service.submitSignature(signatureInput()),
    ).rejects.toBeInstanceOf(AgentAuthorizationUnavailableError);
    expect(inputs.persistIssued).not.toHaveBeenCalled();
  });

  it("rejects widened signature input before owner lookup", async () => {
    const inputs = harness();

    await expect(
      inputs.service.submitSignature(
        signatureInput({
          signature: "0xdeadbeef",
          typed_data: {},
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_agent_authorization_request" });
    expect(inputs.findOwned).not.toHaveBeenCalled();
  });
});
