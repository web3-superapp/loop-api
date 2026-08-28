import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  SPOT_AGENT_AUTHORIZATION_ADMISSION_MAX_MILLISECONDS,
  SPOT_AGENT_AUTHORIZATION_MAX_AGENT_LIFETIME_MILLISECONDS,
  SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
  SPOT_AGENT_AUTHORIZATION_SIGNING_TTL_MILLISECONDS,
  type ComputeSpotAgentAuthorizationSigningDigest,
  type IssueSpotAgentAuthorizationInput,
  type MaterializeSpotAgentAuthorizationForNonce,
  type SpotAgentAuthorizationMaterializationContext,
  type SpotAgentAuthorizationRecord,
} from "../src/database/spot-agent-authorization-repository.js";
import type { PrivyAgentIdentityAllocator } from "../src/integrations/privy/agent-identity-allocator.js";
import type { SpotAgentAuthorizationCreationResource } from "../src/features/spot/spot-agent-authorization-contract.js";
import {
  SpotAgentAuthorizationExpiredError,
  SpotAgentAuthorizationNotFoundError,
} from "../src/features/spot/spot-agent-authorization-service.js";
import {
  createSpotAgentAuthorizationWorkflow,
  type SpotAgentAuthorizationIssuePolicyGate,
  type SpotAgentAuthorizationIssueRepository,
} from "../src/features/spot/spot-agent-authorization-workflow.js";
import {
  SpotUnavailableError,
  SpotWalletBindingRequiredError,
} from "../src/features/spot/spot-errors.js";
import type { WalletBindingAuthorityResolver } from "../src/features/wallet/wallet-binding-resolver.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const foreignOwnerUserId = "22222222-2222-4222-8222-222222222222";
const privyUserId = "did:privy:spot-agent-owner";
const walletId = "privy-wallet-spot-agent-owner";
const accountAddress = `0x${"11".repeat(20)}`;
const changedAccountAddress = `0x${"22".repeat(20)}`;
const agentAddress = `0x${"33".repeat(20)}`;
const signerRef = "privy-server-wallet:spot-agent-generation-1";
const authorizationNonce = "1760000000789";
const requestId = "90000000-0000-4000-8000-000000000001";
const authorizationId = "90000000-0000-4000-8000-000000000002";
const foreignAuthorizationId = "90000000-0000-4000-8000-000000000003";
const now = new Date("2026-08-28T06:00:00.000Z");
const policyCheckedAt = new Date(now.getTime() - 100).toISOString();
const policyExpiresAt = new Date(now.getTime() + 10_000).toISOString();
const walletVerifiedAt = new Date(now.getTime() - 100).toISOString();
const walletExpiresAt = new Date(now.getTime() + 10_000).toISOString();

const dependencyUuids = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8",
] as const;

function digestTypedData(value: unknown): string {
  return `0x${createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")}`;
}

function typedData(
  context: SpotAgentAuthorizationMaterializationContext,
): SpotAgentAuthorizationCreationResource["signable_payload"]["typed_data"] {
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 421_614,
      verifyingContract: `0x${"0".repeat(40)}`,
    },
    types: {
      "HyperliquidTransaction:ApproveAgent": [
        { name: "hyperliquidChain", type: "string" },
        { name: "agentAddress", type: "address" },
        { name: "agentName", type: "string" },
        { name: "nonce", type: "uint64" },
      ],
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
    primaryType: "HyperliquidTransaction:ApproveAgent",
    message: {
      type: "approveAgent",
      agentAddress: context.agentAddress,
      agentName: context.agentName,
      nonce: Number(context.authorizationNonce),
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
    },
  };
}

const computeSigningDigest: ComputeSpotAgentAuthorizationSigningDigest =
  digestTypedData;

const materializeForNonce: MaterializeSpotAgentAuthorizationForNonce = (
  context,
) => {
  const value = typedData(context);
  return Object.freeze({
    typedData: value,
    signingDigest: digestTypedData(value),
  });
};

function authority(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    ownerUserId,
    privyUserId,
    walletId,
    accountAddress,
    accountKind: "master" as const,
    bindingVersion: "1",
    verifiedAt: walletVerifiedAt,
    expiresAt: walletExpiresAt,
    ...overrides,
  });
}

function allowedPolicy(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    ownerUserId,
    network: "testnet" as const,
    action: "approve_agent" as const,
    decision: "allow" as const,
    policyVersion: SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
    productEnabled: true,
    legalEligible: true,
    sanctionsEligible: true,
    killSwitchOpen: true,
    allocatorReady: true,
    signatureVerificationReady: true,
    relayReady: true,
    reconciliationReady: true,
    checkedAt: policyCheckedAt,
    expiresAt: policyExpiresAt,
    ...overrides,
  });
}

function authorizationResult(
  input: IssueSpotAgentAuthorizationInput,
  context: SpotAgentAuthorizationMaterializationContext,
  state: SpotAgentAuthorizationRecord["storedState"] = "prepared",
): Readonly<{
  record: SpotAgentAuthorizationRecord;
  signablePayload: {
    readonly format: "privy_eip712_json_v1";
    readonly agent_address: string;
    readonly agent_name: string;
    readonly nonce: string;
    readonly domain: {
      readonly name: "HyperliquidSignTransaction";
      readonly version: "1";
      readonly chain_id: 421_614;
      readonly verifying_contract: string;
    };
    readonly typed_data: ReturnType<typeof typedData>;
    readonly expires_at: string;
  };
}> {
  const createdAt = now.toISOString();
  const observedAt = state === "prepared" ? null : createdAt;
  const resultState = state === "reconciling" ? "unknown" : state;
  const result =
    state === "prepared" || state === "submitting" || state === "expired"
      ? null
      : {
          state: resultState as
            | "accepted"
            | "active"
            | "rejected"
            | "failed"
            | "unknown"
            | "operator_required",
          observed_at: observedAt ?? createdAt,
          reason_code: null,
        };
  const resource = Object.freeze({
    authorization_id: input.authorizationId,
    state,
    binding_epoch: input.bindingVersion,
    signing_state:
      state === "prepared"
        ? ("required" as const)
        : state === "expired"
          ? ("expired" as const)
          : ("consumed" as const),
    protocol_scope_warning:
      "hyperliquid_agent_authorization_is_protocol_broad" as const,
    expires_at: input.signingExpiresAt,
    result,
    created_at: createdAt,
    updated_at: createdAt,
  });
  const value = typedData(context);
  const signablePayload = Object.freeze({
    format: "privy_eip712_json_v1" as const,
    agent_address: input.agentAddress,
    agent_name: input.agentName,
    nonce: context.authorizationNonce,
    domain: Object.freeze({
      name: "HyperliquidSignTransaction" as const,
      version: "1" as const,
      chain_id: 421_614 as const,
      verifying_contract: `0x${"0".repeat(40)}`,
    }),
    typed_data: value,
    expires_at: input.signingExpiresAt,
  });
  const publicReview = Object.freeze({
    version: "spot_agent_authorization_review_v1" as const,
    provider: "hyperliquid" as const,
    network: "testnet" as const,
    action: "approve_agent" as const,
    account: Object.freeze({
      address: input.accountAddress,
      kind: "master" as const,
    }),
    binding_epoch: input.bindingVersion,
    agent: Object.freeze({
      address: input.agentAddress,
      name: input.agentName,
      valid_until: input.agentValidUntil,
    }),
    nonce: context.authorizationNonce,
    policy_version: SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
  });
  return Object.freeze({
    signablePayload,
    record: Object.freeze({
      id: input.authorizationId,
      ownerUserId: input.ownerUserId,
      requestSha256: "a".repeat(64),
      agentIdentityId: input.agentIdentityId,
      agentGeneration: input.agentGeneration,
      accountAddress: input.accountAddress,
      bindingVersion: input.bindingVersion,
      agentAddress: input.agentAddress,
      agentName: input.agentName,
      signerRef: input.signerRef,
      authorizationNonce: context.authorizationNonce,
      agentValidUntil: input.agentValidUntil,
      publicReview,
      reviewSha256: "b".repeat(64),
      typedDataPrimaryType: "HyperliquidTransaction:ApproveAgent" as const,
      signingDigest: digestTypedData(value),
      typedDataJsonSha256: "c".repeat(64),
      signingExpiresAt: input.signingExpiresAt,
      storedState: state,
      recordVersion: "0",
      createdAt,
      updatedAt: createdAt,
      resource,
    }),
  });
}

function existingAuthorization(
  state: SpotAgentAuthorizationRecord["storedState"] = "prepared",
): ReturnType<typeof authorizationResult> {
  const agentValidUntil = new Date(
    now.getTime() + 23 * 60 * 60 * 1_000,
  ).toISOString();
  const signingExpiresAt = new Date(
    now.getTime() + 4 * 60 * 1_000,
  ).toISOString();
  const input: IssueSpotAgentAuthorizationInput = {
    authorizationId,
    agentIdentityId: "90000000-0000-4000-8000-000000000004",
    agentGeneration: "1",
    ownerUserId,
    privyUserId,
    requestId,
    walletId,
    accountAddress,
    accountKind: "master",
    bindingVersion: "1",
    verifiedAt: walletVerifiedAt,
    expiresAt: walletExpiresAt,
    policyOwnerUserId: ownerUserId,
    policyNetwork: "testnet",
    policyAction: "approve_agent",
    policyCheckedAt,
    policyExpiresAt,
    admissionStartedAt: now.toISOString(),
    admissionExpiresAt: new Date(
      now.getTime() + SPOT_AGENT_AUTHORIZATION_ADMISSION_MAX_MILLISECONDS,
    ).toISOString(),
    agentAddress,
    agentName: `Loop-${agentAddress.slice(2, 13)} valid_until ${Date.parse(agentValidUntil)}`,
    signerRef,
    agentValidUntil,
    signingExpiresAt,
    policyVersion: SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
  };
  return authorizationResult(
    input,
    {
      authorizationId: input.authorizationId,
      ownerUserId,
      network: "testnet",
      action: "approve_agent",
      accountAddress,
      bindingVersion: "1",
      agentIdentityId: input.agentIdentityId,
      agentGeneration: "1",
      agentAddress,
      agentName: input.agentName,
      authorizationNonce,
      agentValidUntil,
      signingExpiresAt,
      policyVersion: SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
    },
    state,
  );
}

function workflowInput(signal = new AbortController().signal) {
  return Object.freeze({ ownerUserId, privyUserId, requestId, signal });
}

function signatureInput(
  signal = new AbortController().signal,
  inputAuthorizationId = authorizationId,
) {
  return Object.freeze({
    ownerUserId,
    privyUserId,
    authorizationId: inputAuthorizationId,
    requestId,
    signature: "0xdeadbeef",
    signal,
  });
}

function harness(
  options: {
    readonly authorities?: readonly unknown[];
    readonly policies?: readonly unknown[];
    readonly allocation?: unknown;
    readonly preflight?: Awaited<
      ReturnType<SpotAgentAuthorizationIssueRepository["preflightCurrent"]>
    >;
    readonly found?: SpotAgentAuthorizationRecord | null;
    readonly createUuids?: readonly string[];
    readonly timeoutMilliseconds?: number;
  } = {},
) {
  const events: string[] = [];
  const authorities = [...(options.authorities ?? [authority(), authority()])];
  const policies = [
    ...(options.policies ?? [allowedPolicy(), allowedPolicy()]),
  ];
  const allocation =
    options.allocation ?? Object.freeze({ agentAddress, signerRef });
  const uuidValues = [...(options.createUuids ?? dependencyUuids)];

  const resolveAuthority = vi.fn<
    WalletBindingAuthorityResolver["resolveAuthority"]
  >(() => {
    events.push(`authority#${resolveAuthority.mock.calls.length}`);
    return Promise.resolve(authorities.shift());
  });
  const evaluate = vi.fn<SpotAgentAuthorizationIssuePolicyGate["evaluate"]>(
    () => {
      events.push(`policy#${evaluate.mock.calls.length}`);
      return Promise.resolve(policies.shift());
    },
  );
  const allocate = vi.fn<PrivyAgentIdentityAllocator["allocate"]>(() => {
    events.push("allocator");
    return Promise.resolve(allocation);
  });
  const preflightCurrent = vi.fn<
    SpotAgentAuthorizationIssueRepository["preflightCurrent"]
  >(() => {
    events.push("preflight");
    return Promise.resolve(
      options.preflight ?? {
        kind: "issue_required" as const,
        created: false as const,
        agentGeneration: "1",
        reservedIdentity: null,
        authorization: null,
        signablePayload: null,
      },
    );
  });
  const issueOrReplayCurrent = vi.fn<
    SpotAgentAuthorizationIssueRepository["issueOrReplayCurrent"]
  >((input, materializer, digestComputer) => {
    events.push("issue");
    const context: SpotAgentAuthorizationMaterializationContext = {
      authorizationId: input.authorizationId,
      ownerUserId: input.ownerUserId,
      network: "testnet",
      action: "approve_agent",
      accountAddress: input.accountAddress,
      bindingVersion: input.bindingVersion,
      agentIdentityId: input.agentIdentityId,
      agentGeneration: input.agentGeneration,
      agentAddress: input.agentAddress,
      agentName: input.agentName,
      authorizationNonce,
      agentValidUntil: input.agentValidUntil,
      signingExpiresAt: input.signingExpiresAt,
      policyVersion: input.policyVersion,
    };
    const materialized = materializer(context);
    expect(digestComputer(materialized.typedData as never)).toBe(
      materialized.signingDigest,
    );
    const issued = authorizationResult(input, context);
    return Promise.resolve({
      kind: "issued" as const,
      created: true as const,
      authorization: issued.record,
      signablePayload: issued.signablePayload,
    });
  });
  const findOwned = vi.fn<SpotAgentAuthorizationIssueRepository["findOwned"]>(
    () => Promise.resolve(options.found ?? null),
  );
  const repository = {
    preflightCurrent,
    issueOrReplayCurrent,
    findOwned,
  } satisfies SpotAgentAuthorizationIssueRepository;
  const walletBindingAuthorityResolver = {
    resolveAuthority,
  } satisfies WalletBindingAuthorityResolver;
  const agentIdentityAllocator = {
    allocate,
  } satisfies PrivyAgentIdentityAllocator;
  const policyGate = {
    evaluate,
  } satisfies SpotAgentAuthorizationIssuePolicyGate;
  const createUuid = vi.fn(
    () => uuidValues.shift() ?? "invalid-exhausted-uuid",
  );
  const workflow = createSpotAgentAuthorizationWorkflow({
    repository,
    walletBindingAuthorityResolver,
    agentIdentityAllocator,
    policyGate,
    materializeForNonce,
    computeSigningDigest,
    createUuid,
    now: () => new Date(now),
    timeoutMilliseconds: options.timeoutMilliseconds ?? 1_000,
  });
  return {
    agentIdentityAllocator,
    allocate,
    createUuid,
    evaluate,
    events,
    findOwned,
    issueOrReplayCurrent,
    policyGate,
    preflightCurrent,
    repository,
    resolveAuthority,
    walletBindingAuthorityResolver,
    workflow,
  };
}

describe("Spot Agent authorization workflow", () => {
  it("stops at the first denied policy or missing wallet without allocating", async () => {
    const denied = harness({
      policies: [
        allowedPolicy({
          decision: "deny",
          productEnabled: false,
          killSwitchOpen: false,
        }),
      ],
    });
    await expect(denied.workflow.issue(workflowInput())).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
    expect(denied.events).toEqual(["policy#1"]);
    expect(denied.resolveAuthority).not.toHaveBeenCalled();
    expect(denied.preflightCurrent).not.toHaveBeenCalled();
    expect(denied.allocate).not.toHaveBeenCalled();

    const missingWallet = harness({
      authorities: [authority({ walletId: null })],
    });
    await expect(
      missingWallet.workflow.issue(workflowInput()),
    ).rejects.toBeInstanceOf(SpotWalletBindingRequiredError);
    expect(missingWallet.events).toEqual(["policy#1", "authority#1"]);
    expect(missingWallet.preflightCurrent).not.toHaveBeenCalled();
    expect(missingWallet.allocate).not.toHaveBeenCalled();
  });

  it("rejects a duplicate dependency UUID before its dependency call", async () => {
    const inputs = harness({ createUuids: [requestId] });

    await expect(inputs.workflow.issue(workflowInput())).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
    expect(inputs.events).toEqual([]);
    expect(inputs.evaluate).not.toHaveBeenCalled();
    expect(inputs.resolveAuthority).not.toHaveBeenCalled();
    expect(inputs.preflightCurrent).not.toHaveBeenCalled();
  });

  it("issues through the strict policy-authority-preflight-allocation-recheck order", async () => {
    const inputs = harness();
    const signal = new AbortController().signal;

    const resource = await inputs.workflow.issue(workflowInput(signal));

    expect(inputs.events).toEqual([
      "policy#1",
      "authority#1",
      "preflight",
      "allocator",
      "authority#2",
      "policy#2",
      "issue",
    ]);
    expect(inputs.evaluate).toHaveBeenCalledTimes(2);
    const dependencySignal = inputs.evaluate.mock.calls[0]?.[0].signal;
    expect(dependencySignal).toBeInstanceOf(AbortSignal);
    expect(dependencySignal).not.toBe(signal);
    expect(dependencySignal?.aborted).toBe(false);
    expect(inputs.evaluate).toHaveBeenNthCalledWith(1, {
      ownerUserId,
      network: "testnet",
      action: "approve_agent",
      requestId: dependencyUuids[0],
      signal: dependencySignal,
    });
    expect(inputs.evaluate).toHaveBeenNthCalledWith(2, {
      ownerUserId,
      network: "testnet",
      action: "approve_agent",
      requestId: dependencyUuids[3],
      signal: dependencySignal,
    });
    expect(inputs.resolveAuthority).toHaveBeenCalledTimes(2);
    expect(inputs.resolveAuthority).toHaveBeenNthCalledWith(1, {
      ownerUserId,
      privyUserId,
      signal: dependencySignal,
    });
    expect(inputs.resolveAuthority).toHaveBeenNthCalledWith(2, {
      ownerUserId,
      privyUserId,
      signal: dependencySignal,
    });
    expect(inputs.preflightCurrent).toHaveBeenCalledOnce();
    expect(inputs.preflightCurrent.mock.calls[0]?.[0]).toEqual({
      ownerUserId,
      privyUserId,
      requestId: dependencyUuids[1],
      walletId,
      accountAddress,
      accountKind: "master",
      bindingVersion: "1",
      verifiedAt: walletVerifiedAt,
      expiresAt: walletExpiresAt,
      policyOwnerUserId: ownerUserId,
      policyNetwork: "testnet",
      policyAction: "approve_agent",
      policyCheckedAt,
      policyExpiresAt,
      admissionStartedAt: now.toISOString(),
      admissionExpiresAt: new Date(now.getTime() + 1_000).toISOString(),
      policyVersion: SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
    });
    expect(inputs.preflightCurrent.mock.calls[0]?.[1]).toBe(
      materializeForNonce,
    );
    expect(inputs.preflightCurrent.mock.calls[0]?.[2]).toBe(
      computeSigningDigest,
    );
    expect(inputs.allocate).toHaveBeenCalledOnce();
    expect(inputs.allocate.mock.calls[0]?.[0]).toEqual({
      requestId: dependencyUuids[2],
      ownerUserId,
      privyUserId,
      network: "testnet",
      bindingVersion: "1",
      agentGeneration: "1",
      signal: dependencySignal,
    });
    expect(inputs.issueOrReplayCurrent).toHaveBeenCalledOnce();
    const issueInput = inputs.issueOrReplayCurrent.mock.calls[0]?.[0];
    expect(issueInput).toBeDefined();
    const expectedAgentValidUntil = new Date(
      now.getTime() +
        SPOT_AGENT_AUTHORIZATION_MAX_AGENT_LIFETIME_MILLISECONDS -
        15_000,
    ).toISOString();
    const expectedSigningExpiresAt = new Date(
      now.getTime() +
        SPOT_AGENT_AUTHORIZATION_SIGNING_TTL_MILLISECONDS -
        15_000,
    ).toISOString();
    const expectedAgentName = `Loop-${agentAddress.slice(2, 13)} valid_until ${Date.parse(expectedAgentValidUntil)}`;
    expect(issueInput).toEqual({
      authorizationId: dependencyUuids[4],
      agentIdentityId: dependencyUuids[5],
      ownerUserId,
      privyUserId,
      requestId,
      walletId,
      accountAddress,
      accountKind: "master",
      bindingVersion: "1",
      verifiedAt: walletVerifiedAt,
      expiresAt: walletExpiresAt,
      policyOwnerUserId: ownerUserId,
      policyNetwork: "testnet",
      policyAction: "approve_agent",
      policyCheckedAt,
      policyExpiresAt,
      admissionStartedAt: now.toISOString(),
      admissionExpiresAt: new Date(now.getTime() + 1_000).toISOString(),
      agentGeneration: "1",
      agentAddress,
      agentName: expectedAgentName,
      signerRef,
      agentValidUntil: expectedAgentValidUntil,
      signingExpiresAt: expectedSigningExpiresAt,
      policyVersion: SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
    });
    if (issueInput === undefined) {
      throw new Error("Expected one repository issue input");
    }
    const agentValidUntil = Date.parse(issueInput.agentValidUntil);
    const signingExpiresAt = Date.parse(issueInput.signingExpiresAt);
    expect(agentValidUntil).toBeGreaterThan(now.getTime());
    expect(agentValidUntil - now.getTime()).toBeLessThanOrEqual(
      SPOT_AGENT_AUTHORIZATION_MAX_AGENT_LIFETIME_MILLISECONDS,
    );
    expect(signingExpiresAt).toBeGreaterThan(now.getTime());
    expect(signingExpiresAt - now.getTime()).toBeLessThanOrEqual(
      SPOT_AGENT_AUTHORIZATION_SIGNING_TTL_MILLISECONDS,
    );
    expect(signingExpiresAt).toBeLessThan(agentValidUntil);
    expect(issueInput.agentName).toMatch(
      new RegExp(` valid_until ${agentValidUntil}$`),
    );
    expect(
      issueInput.agentName.slice(0, -` valid_until ${agentValidUntil}`.length)
        .length,
    ).toBeLessThanOrEqual(16);

    const generatedIds = [
      ...inputs.evaluate.mock.calls.map(([value]) => value.requestId),
      inputs.preflightCurrent.mock.calls[0]?.[0].requestId,
      inputs.allocate.mock.calls[0]?.[0].requestId,
      issueInput.authorizationId,
      issueInput.agentIdentityId,
    ];
    expect(generatedIds).toHaveLength(6);
    expect(new Set(generatedIds).size).toBe(generatedIds.length);
    expect(generatedIds).not.toContain(requestId);
    expect(resource).toMatchObject({
      authorization_id: issueInput.authorizationId,
      state: "prepared",
      signable_payload: {
        agent_address: agentAddress,
        nonce: authorizationNonce,
        typed_data: {
          message: { nonce: Number(authorizationNonce) },
        },
      },
    });
  });

  it("returns a current replay without allocating or issuing again", async () => {
    const existing = existingAuthorization();
    const secondPolicyCheckedAt = new Date(now.getTime() - 50).toISOString();
    const secondPolicyExpiresAt = new Date(now.getTime() + 9_000).toISOString();
    const inputs = harness({
      authorities: [authority(), authority()],
      policies: [
        allowedPolicy(),
        allowedPolicy({
          checkedAt: secondPolicyCheckedAt,
          expiresAt: secondPolicyExpiresAt,
        }),
      ],
      preflight: {
        kind: "replayed",
        created: false,
        authorization: existing.record,
        signablePayload: existing.signablePayload,
      },
    });

    await expect(inputs.workflow.issue(workflowInput())).resolves.toMatchObject(
      {
        authorization_id: authorizationId,
        state: "prepared",
        signable_payload: { nonce: authorizationNonce },
      },
    );
    expect(inputs.events).toEqual([
      "policy#1",
      "authority#1",
      "preflight",
      "authority#2",
      "policy#2",
      "preflight",
    ]);
    expect(inputs.resolveAuthority).toHaveBeenCalledTimes(2);
    expect(inputs.evaluate).toHaveBeenCalledTimes(2);
    expect(inputs.preflightCurrent).toHaveBeenCalledTimes(2);
    expect(inputs.preflightCurrent.mock.calls[1]?.[0]).toMatchObject({
      policyCheckedAt: secondPolicyCheckedAt,
      policyExpiresAt: secondPolicyExpiresAt,
      admissionStartedAt: now.toISOString(),
      admissionExpiresAt: new Date(now.getTime() + 1_000).toISOString(),
    });
    expect(inputs.allocate).not.toHaveBeenCalled();
    expect(inputs.issueOrReplayCurrent).not.toHaveBeenCalled();
  });

  it("fails closed when a replay does not use the exact address-derived Agent name", async () => {
    const existing = existingAuthorization();
    const malformedRecord = Object.freeze({
      ...existing.record,
      agentName: `Loop-test valid_until ${Date.parse(existing.record.agentValidUntil)}`,
    });
    const inputs = harness({
      preflight: {
        kind: "replayed",
        created: false,
        authorization: malformedRecord,
        signablePayload: existing.signablePayload,
      },
    });

    await expect(inputs.workflow.issue(workflowInput())).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
    expect(inputs.preflightCurrent).toHaveBeenCalledTimes(2);
    expect(inputs.allocate).not.toHaveBeenCalled();
    expect(inputs.issueOrReplayCurrent).not.toHaveBeenCalled();
  });

  it("fails closed when the confirmed replay handoff is already expired", async () => {
    const existing = existingAuthorization();
    const expiredAt = new Date(now.getTime() - 1).toISOString();
    const expiredRecord = Object.freeze({
      ...existing.record,
      signingExpiresAt: expiredAt,
      resource: Object.freeze({
        ...existing.record.resource,
        expires_at: expiredAt,
      }),
    });
    const inputs = harness({
      preflight: {
        kind: "replayed",
        created: false,
        authorization: expiredRecord,
        signablePayload: Object.freeze({
          ...existing.signablePayload,
          expires_at: expiredAt,
        }),
      },
    });

    await expect(inputs.workflow.issue(workflowInput())).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
    expect(inputs.preflightCurrent).toHaveBeenCalledTimes(2);
    expect(inputs.allocate).not.toHaveBeenCalled();
    expect(inputs.issueOrReplayCurrent).not.toHaveBeenCalled();
  });

  it("reuses an exact reserved identity after handoff expiry without allocating another Agent", async () => {
    const agentValidUntil = new Date(
      now.getTime() + 23 * 60 * 60 * 1_000,
    ).toISOString();
    const agentIdentityId = "90000000-0000-4000-8000-000000000005";
    const agentName = `Loop-${agentAddress.slice(2, 13)} valid_until ${Date.parse(agentValidUntil)}`;
    const inputs = harness({
      preflight: {
        kind: "issue_required",
        created: false,
        agentGeneration: "1",
        reservedIdentity: {
          agentIdentityId,
          agentGeneration: "1",
          agentAddress,
          agentName,
          signerRef,
          agentValidUntil,
        },
        authorization: null,
        signablePayload: null,
      },
    });

    await expect(inputs.workflow.issue(workflowInput())).resolves.toMatchObject(
      {
        state: "prepared",
        signable_payload: {
          agent_address: agentAddress,
          agent_name: agentName,
        },
      },
    );
    expect(inputs.events).toEqual([
      "policy#1",
      "authority#1",
      "preflight",
      "authority#2",
      "policy#2",
      "issue",
    ]);
    expect(inputs.allocate).not.toHaveBeenCalled();
    expect(inputs.issueOrReplayCurrent.mock.calls[0]?.[0]).toMatchObject({
      agentIdentityId,
      agentGeneration: "1",
      agentAddress,
      agentName,
      signerRef,
      agentValidUntil,
    });
  });

  it("fails closed when the second policy result changes after allocation", async () => {
    const inputs = harness({
      policies: [
        allowedPolicy(),
        allowedPolicy({ decision: "deny", killSwitchOpen: false }),
      ],
    });

    await expect(inputs.workflow.issue(workflowInput())).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
    expect(inputs.events).toEqual([
      "policy#1",
      "authority#1",
      "preflight",
      "allocator",
      "authority#2",
      "policy#2",
    ]);
    expect(inputs.issueOrReplayCurrent).not.toHaveBeenCalled();
  });

  it("fails closed when wallet authority changes after allocation", async () => {
    const inputs = harness({
      authorities: [
        authority(),
        authority({ accountAddress: changedAccountAddress }),
      ],
    });

    await expect(inputs.workflow.issue(workflowInput())).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
    expect(inputs.events).toEqual([
      "policy#1",
      "authority#1",
      "preflight",
      "allocator",
      "authority#2",
    ]);
    expect(inputs.evaluate).toHaveBeenCalledOnce();
    expect(inputs.issueOrReplayCurrent).not.toHaveBeenCalled();
  });

  it.each([
    [
      "extra private material",
      { agentAddress, signerRef, privateKey: "forbidden" },
    ],
    ["zero address", { agentAddress: `0x${"0".repeat(40)}`, signerRef }],
    ["owner address", { agentAddress: accountAddress, signerRef }],
    ["missing signer reference", { agentAddress }],
  ])("rejects allocator output with %s", async (_label, allocation) => {
    const inputs = harness({ allocation });

    await expect(inputs.workflow.issue(workflowInput())).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
    expect(inputs.events).toEqual([
      "policy#1",
      "authority#1",
      "preflight",
      "allocator",
    ]);
    expect(inputs.issueOrReplayCurrent).not.toHaveBeenCalled();
  });

  it("times out a non-cooperative allocator and honors an already-aborted request without issuing", async () => {
    const timedEvents: string[] = [];
    const neverAllocate = vi.fn<PrivyAgentIdentityAllocator["allocate"]>(() => {
      timedEvents.push("allocator");
      return new Promise(() => undefined);
    });
    const timed = harness({ timeoutMilliseconds: 10 });
    timed.agentIdentityAllocator.allocate = neverAllocate;
    const timedWorkflow = createSpotAgentAuthorizationWorkflow({
      repository: timed.repository,
      walletBindingAuthorityResolver: timed.walletBindingAuthorityResolver,
      agentIdentityAllocator: timed.agentIdentityAllocator,
      policyGate: timed.policyGate,
      materializeForNonce,
      computeSigningDigest,
      createUuid: timed.createUuid,
      now: () => new Date(now),
      timeoutMilliseconds: 10,
    });

    await expect(timedWorkflow.issue(workflowInput())).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
    expect(timedEvents).toEqual(["allocator"]);
    expect(timed.issueOrReplayCurrent).not.toHaveBeenCalled();

    const aborted = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      aborted.workflow.issue(workflowInput(controller.signal)),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    expect(aborted.preflightCurrent).not.toHaveBeenCalled();
    expect(aborted.issueOrReplayCurrent).not.toHaveBeenCalled();
  });

  it("passes the combined abort signal into a non-cooperative repository and stops waiting at the workflow deadline", async () => {
    let repositorySignal: AbortSignal | undefined;
    const neverIssue = vi.fn<
      SpotAgentAuthorizationIssueRepository["issueOrReplayCurrent"]
    >((_input, _materializer, _digestComputer, signal) => {
      repositorySignal = signal;
      return new Promise(() => undefined);
    });
    const inputs = harness({ timeoutMilliseconds: 10 });
    inputs.repository.issueOrReplayCurrent = neverIssue;

    await expect(inputs.workflow.issue(workflowInput())).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
    expect(neverIssue).toHaveBeenCalledOnce();
    expect(repositorySignal).toBeInstanceOf(AbortSignal);
    expect(repositorySignal?.aborted).toBe(true);
  });

  it("reads only an exact owner-scoped resource and hides missing or foreign rows", async () => {
    const existing = existingAuthorization();
    const owner = harness({ found: existing.record });
    await expect(
      owner.workflow.findOwned({ ownerUserId, authorizationId }),
    ).resolves.toEqual(existing.record.resource);
    expect(owner.findOwned).toHaveBeenCalledWith(ownerUserId, authorizationId);

    const missing = harness({ found: null });
    await expect(
      missing.workflow.findOwned({ ownerUserId, authorizationId }),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationNotFoundError);

    const foreign = harness({
      found: Object.freeze({
        ...existing.record,
        id: foreignAuthorizationId,
        ownerUserId: foreignOwnerUserId,
      }),
    });
    await expect(
      foreign.workflow.findOwned({ ownerUserId, authorizationId }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
  });

  it("keeps prepared signature submission unavailable and returns terminal status without relay", async () => {
    const prepared = existingAuthorization("prepared");
    const preparedInputs = harness({ found: prepared.record });
    await expect(
      preparedInputs.workflow.submitSignature(signatureInput()),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    expect(preparedInputs.allocate).not.toHaveBeenCalled();
    expect(preparedInputs.issueOrReplayCurrent).not.toHaveBeenCalled();

    const active = existingAuthorization("active");
    const activeInputs = harness({ found: active.record });
    await expect(
      activeInputs.workflow.submitSignature(signatureInput()),
    ).resolves.toEqual(active.record.resource);
    expect(activeInputs.allocate).not.toHaveBeenCalled();
    expect(activeInputs.evaluate).not.toHaveBeenCalled();
    expect(activeInputs.issueOrReplayCurrent).not.toHaveBeenCalled();

    const expired = existingAuthorization("expired");
    const expiredInputs = harness({ found: expired.record });
    await expect(
      expiredInputs.workflow.submitSignature(signatureInput()),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationExpiredError);
  });
});
