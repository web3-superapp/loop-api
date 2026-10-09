import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  SPOT_AGENT_AUTHORIZATION_ADMISSION_MAX_MILLISECONDS,
  SPOT_AGENT_AUTHORIZATION_AUTHORITY_LEASE_MILLISECONDS,
  SPOT_AGENT_AUTHORIZATION_BASE_NAME_MAX_CHARACTERS,
  SPOT_AGENT_AUTHORIZATION_MAX_AGENT_LIFETIME_MILLISECONDS,
  SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
  SPOT_AGENT_AUTHORIZATION_SIGNING_TTL_MILLISECONDS,
  SpotAgentAuthorizationAuthorityStaleError,
  SpotAgentAuthorizationNonceUnavailableError,
  SpotAgentAuthorizationPrepareExpiredError,
  SpotAgentAuthorizationRepositoryUnavailableError,
  type ComputeSpotAgentAuthorizationSigningDigest,
  type IssueSpotAgentAuthorizationResult,
  type MaterializeSpotAgentAuthorizationForNonce,
  type PreflightSpotAgentAuthorizationResult,
  type ReservedSpotAgentIdentity,
  type SpotAgentAuthorizationRecord,
  type SpotAgentAuthorizationRepository,
} from "../../database/spot-agent-authorization-repository.js";
import {
  PrivyAgentIdentityAllocatorUnavailableError,
  type PrivyAgentIdentityAllocator,
} from "../../integrations/privy/agent-identity-allocator.js";
import {
  WalletBindingRequiredError,
  WalletBindingResolutionUnavailableError,
  type WalletBindingAuthorityResolver,
} from "../wallet/wallet-binding-resolver.js";
import {
  parseSpotAgentAuthorizationCreationResource,
  parseSpotAgentAuthorizationResource,
  parseSpotAgentAuthorizationSignatureRequest,
  type SpotAgentAuthorizationCreationResource,
  type SpotAgentAuthorizationResource,
} from "./spot-agent-authorization-contract.js";
import {
  SpotAgentAuthorizationExpiredError,
  SpotAgentAuthorizationNotFoundError,
  type SpotAgentAuthorizationWorkflow,
} from "./spot-agent-authorization-service.js";
import { parseSpotContract } from "./spot-contract-support.js";
import {
  SpotUnavailableError,
  SpotWalletBindingRequiredError,
} from "./spot-errors.js";

const maximumPostgresBigint = 9_223_372_036_854_775_807n;
const zeroAddress = `0x${"0".repeat(40)}`;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalTimestampSchema = z
  .string()
  .max(24)
  .datetime({ offset: false, precision: 3 })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const opaqueProviderIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim())
  .refine((value) =>
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
    }),
  );
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/)
  .refine((value) => value !== zeroAddress);
const bindingVersionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= maximumPostgresBigint);
const agentNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/)
  .refine((value) => value === value.trim());

const workflowInputSchema = z
  .object({
    ownerUserId: z.string().regex(uuidPattern),
    privyUserId: opaqueProviderIdSchema,
    requestId: z.string().regex(uuidPattern),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();

const walletAuthoritySchema = z
  .object({
    ownerUserId: z.string().regex(uuidPattern),
    privyUserId: opaqueProviderIdSchema,
    walletId: opaqueProviderIdSchema.nullable(),
    accountAddress: addressSchema,
    accountKind: z.literal("master"),
    bindingVersion: bindingVersionSchema,
    verifiedAt: canonicalTimestampSchema,
    expiresAt: canonicalTimestampSchema,
  })
  .strict();

const policyEvidenceSchema = z
  .object({
    ownerUserId: z.string().regex(uuidPattern),
    network: z.literal("testnet"),
    action: z.literal("approve_agent"),
    decision: z.literal("allow"),
    policyVersion: z.literal(SPOT_AGENT_AUTHORIZATION_POLICY_VERSION),
    productEnabled: z.literal(true),
    legalEligible: z.literal(true),
    sanctionsEligible: z.literal(true),
    killSwitchOpen: z.literal(true),
    allocatorReady: z.literal(true),
    signatureVerificationReady: z.literal(true),
    relayReady: z.literal(true),
    reconciliationReady: z.literal(true),
    checkedAt: canonicalTimestampSchema,
    expiresAt: canonicalTimestampSchema,
  })
  .strict();

const allocatorOutputSchema = z
  .object({
    agentAddress: addressSchema,
    signerRef: opaqueProviderIdSchema,
  })
  .strict();

const reservedIdentitySchema = z
  .object({
    agentIdentityId: z.string().regex(uuidPattern),
    agentGeneration: bindingVersionSchema,
    agentAddress: addressSchema,
    agentName: agentNameSchema,
    signerRef: opaqueProviderIdSchema,
    agentValidUntil: canonicalTimestampSchema,
  })
  .strict();

const issueRequiredSchema = z
  .object({
    kind: z.literal("issue_required"),
    created: z.literal(false),
    agentGeneration: bindingVersionSchema,
    reservedIdentity: reservedIdentitySchema.nullable(),
    authorization: z.null(),
    signablePayload: z.null(),
  })
  .strict();

type SpotAgentWalletAuthority = Readonly<
  z.output<typeof walletAuthoritySchema> & { readonly walletId: string }
>;
type AllocatedSpotAgentIdentity = Readonly<
  z.output<typeof allocatorOutputSchema>
>;
type SpotAgentAuthorizationPolicyEvidence = Readonly<
  z.output<typeof policyEvidenceSchema>
>;

export type SpotAgentAuthorizationIssueRepository = Pick<
  SpotAgentAuthorizationRepository,
  "preflightCurrent" | "issueOrReplayCurrent" | "findOwned"
>;

export interface SpotAgentAuthorizationIssuePolicyGate {
  evaluate(input: {
    readonly ownerUserId: string;
    readonly network: "testnet";
    readonly action: "approve_agent";
    readonly requestId: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export interface CreateSpotAgentAuthorizationWorkflowInput {
  readonly repository: SpotAgentAuthorizationIssueRepository;
  readonly walletBindingAuthorityResolver: WalletBindingAuthorityResolver;
  readonly agentIdentityAllocator: PrivyAgentIdentityAllocator;
  readonly policyGate: SpotAgentAuthorizationIssuePolicyGate;
  readonly materializeForNonce: MaterializeSpotAgentAuthorizationForNonce;
  readonly computeSigningDigest: ComputeSpotAgentAuthorizationSigningDigest;
  readonly createUuid?: () => string;
  readonly now?: () => Date;
  readonly timeoutMilliseconds?: number;
}

function unavailable(): never {
  throw new SpotUnavailableError();
}

function signalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function readNow(now: () => Date): number {
  let value: unknown;
  try {
    value = now();
  } catch {
    return unavailable();
  }
  if (!(value instanceof Date)) {
    return unavailable();
  }
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    return unavailable();
  }
  return milliseconds;
}

function timestamp(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    return unavailable();
  }
  const value = new Date(milliseconds);
  if (Number.isNaN(value.getTime())) {
    return unavailable();
  }
  return value.toISOString();
}

function freshUuid(createUuid: () => string, used: Set<string>): string {
  let value: unknown;
  try {
    value = createUuid();
  } catch {
    return unavailable();
  }
  if (
    typeof value !== "string" ||
    !uuidPattern.test(value) ||
    used.has(value)
  ) {
    return unavailable();
  }
  used.add(value);
  return value;
}

function awaitWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new SpotUnavailableError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new SpotUnavailableError()));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() =>
          reject(error instanceof Error ? error : new SpotUnavailableError()),
        ),
    );
  });
}

function assertFreshWindow(
  observedAtMilliseconds: number,
  checkedAt: string,
  expiresAt: string,
): void {
  const checkedAtMilliseconds = Date.parse(checkedAt);
  const expiresAtMilliseconds = Date.parse(expiresAt);
  if (
    !Number.isSafeInteger(checkedAtMilliseconds) ||
    !Number.isSafeInteger(expiresAtMilliseconds) ||
    checkedAtMilliseconds > observedAtMilliseconds ||
    expiresAtMilliseconds <= observedAtMilliseconds ||
    expiresAtMilliseconds <= checkedAtMilliseconds ||
    expiresAtMilliseconds - checkedAtMilliseconds >
      SPOT_AGENT_AUTHORIZATION_AUTHORITY_LEASE_MILLISECONDS
  ) {
    return unavailable();
  }
}

async function evaluatePolicy(
  options: CreateSpotAgentAuthorizationWorkflowInput,
  input: Readonly<{
    ownerUserId: string;
    requestId: string;
    signal: AbortSignal;
  }>,
  now: () => Date,
): Promise<SpotAgentAuthorizationPolicyEvidence> {
  let raw: unknown;
  try {
    raw = await awaitWithAbort(
      options.policyGate.evaluate({
        ownerUserId: input.ownerUserId,
        network: "testnet",
        action: "approve_agent",
        requestId: input.requestId,
        signal: input.signal,
      }),
      input.signal,
    );
  } catch {
    return unavailable();
  }
  let policy: z.output<typeof policyEvidenceSchema>;
  try {
    policy = parseSpotContract(policyEvidenceSchema, raw);
  } catch {
    return unavailable();
  }
  if (policy.ownerUserId !== input.ownerUserId) {
    return unavailable();
  }
  assertFreshWindow(readNow(now), policy.checkedAt, policy.expiresAt);
  return Object.freeze({ ...policy });
}

async function resolveWalletAuthority(
  options: CreateSpotAgentAuthorizationWorkflowInput,
  input: Readonly<{
    ownerUserId: string;
    privyUserId: string;
    signal: AbortSignal;
  }>,
  now: () => Date,
): Promise<SpotAgentWalletAuthority> {
  let raw: unknown;
  try {
    raw = await awaitWithAbort(
      options.walletBindingAuthorityResolver.resolveAuthority({
        ownerUserId: input.ownerUserId,
        privyUserId: input.privyUserId,
        signal: input.signal,
      }),
      input.signal,
    );
  } catch (error) {
    if (error instanceof WalletBindingRequiredError) {
      throw new SpotWalletBindingRequiredError();
    }
    if (error instanceof WalletBindingResolutionUnavailableError) {
      return unavailable();
    }
    return unavailable();
  }
  let authority: z.output<typeof walletAuthoritySchema>;
  try {
    authority = parseSpotContract(walletAuthoritySchema, raw);
  } catch {
    return unavailable();
  }
  if (
    authority.ownerUserId !== input.ownerUserId ||
    authority.privyUserId !== input.privyUserId
  ) {
    return unavailable();
  }
  if (authority.walletId === null) {
    throw new SpotWalletBindingRequiredError();
  }
  assertFreshWindow(readNow(now), authority.verifiedAt, authority.expiresAt);
  return Object.freeze({ ...authority, walletId: authority.walletId });
}

function sameWalletAuthority(
  left: SpotAgentWalletAuthority,
  right: SpotAgentWalletAuthority,
): boolean {
  return (
    left.ownerUserId === right.ownerUserId &&
    left.privyUserId === right.privyUserId &&
    left.walletId === right.walletId &&
    left.accountAddress === right.accountAddress &&
    left.bindingVersion === right.bindingVersion
  );
}

function translateRepositoryError(error: unknown): never {
  if (error instanceof SpotAgentAuthorizationPrepareExpiredError) {
    throw new SpotAgentAuthorizationExpiredError();
  }
  if (
    error instanceof SpotAgentAuthorizationAuthorityStaleError ||
    error instanceof SpotAgentAuthorizationNonceUnavailableError ||
    error instanceof SpotAgentAuthorizationRepositoryUnavailableError
  ) {
    return unavailable();
  }
  return unavailable();
}

function preflightInput(
  authority: SpotAgentWalletAuthority,
  policy: SpotAgentAuthorizationPolicyEvidence,
  admissionStartedAt: string,
  admissionExpiresAt: string,
  requestId: string,
) {
  return Object.freeze({
    ownerUserId: authority.ownerUserId,
    privyUserId: authority.privyUserId,
    requestId,
    walletId: authority.walletId,
    accountAddress: authority.accountAddress,
    accountKind: authority.accountKind,
    bindingVersion: authority.bindingVersion,
    verifiedAt: authority.verifiedAt,
    expiresAt: authority.expiresAt,
    policyOwnerUserId: policy.ownerUserId,
    policyNetwork: policy.network,
    policyAction: policy.action,
    policyCheckedAt: policy.checkedAt,
    policyExpiresAt: policy.expiresAt,
    admissionStartedAt,
    admissionExpiresAt,
    policyVersion: SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
  });
}

function admissionExpiry(
  authority: SpotAgentWalletAuthority,
  policy: SpotAgentAuthorizationPolicyEvidence,
  workflowDeadlineMilliseconds: number,
  now: () => Date,
): string {
  const expiresAtMilliseconds = Math.min(
    Date.parse(authority.expiresAt),
    Date.parse(policy.expiresAt),
    workflowDeadlineMilliseconds,
  );
  if (
    !Number.isSafeInteger(expiresAtMilliseconds) ||
    expiresAtMilliseconds <= readNow(now)
  ) {
    return unavailable();
  }
  return timestamp(expiresAtMilliseconds);
}

async function runPreflight(
  options: CreateSpotAgentAuthorizationWorkflowInput,
  authority: SpotAgentWalletAuthority,
  policy: SpotAgentAuthorizationPolicyEvidence,
  admissionStartedAt: string,
  workflowDeadlineMilliseconds: number,
  requestId: string,
  signal: AbortSignal,
  now: () => Date,
): Promise<PreflightSpotAgentAuthorizationResult> {
  if (signal.aborted) {
    return unavailable();
  }
  try {
    const result = await awaitWithAbort(
      options.repository.preflightCurrent(
        preflightInput(
          authority,
          policy,
          admissionStartedAt,
          admissionExpiry(authority, policy, workflowDeadlineMilliseconds, now),
          requestId,
        ),
        options.materializeForNonce,
        options.computeSigningDigest,
        signal,
      ),
      signal,
    );
    if (signalAborted(signal)) {
      return unavailable();
    }
    return result;
  } catch (error) {
    return translateRepositoryError(error);
  }
}

function canonicalAgentName(agentAddress: string, validUntil: string): string {
  const validUntilMilliseconds = Date.parse(validUntil);
  if (!Number.isSafeInteger(validUntilMilliseconds)) {
    return unavailable();
  }
  const baseName = `Loop-${agentAddress.slice(2, 13)}`;
  if (baseName.length > SPOT_AGENT_AUTHORIZATION_BASE_NAME_MAX_CHARACTERS) {
    return unavailable();
  }
  return `${baseName} valid_until ${validUntilMilliseconds}`;
}

function parseReservedIdentity(
  value: ReservedSpotAgentIdentity,
  expectedGeneration: string,
  ownerAddress: string,
  observedAtMilliseconds: number,
): ReservedSpotAgentIdentity {
  let identity: z.output<typeof reservedIdentitySchema>;
  try {
    identity = parseSpotContract(reservedIdentitySchema, value);
  } catch {
    return unavailable();
  }
  const validUntilMilliseconds = Date.parse(identity.agentValidUntil);
  const signingExpiresAt =
    observedAtMilliseconds +
    SPOT_AGENT_AUTHORIZATION_SIGNING_TTL_MILLISECONDS -
    SPOT_AGENT_AUTHORIZATION_AUTHORITY_LEASE_MILLISECONDS;
  if (
    identity.agentGeneration !== expectedGeneration ||
    identity.agentAddress === ownerAddress ||
    identity.agentName !==
      canonicalAgentName(identity.agentAddress, identity.agentValidUntil) ||
    !Number.isSafeInteger(validUntilMilliseconds) ||
    validUntilMilliseconds <= signingExpiresAt
  ) {
    return unavailable();
  }
  return identity;
}

async function allocateAgentIdentity(
  options: CreateSpotAgentAuthorizationWorkflowInput,
  input: Readonly<{
    ownerUserId: string;
    privyUserId: string;
    requestId: string;
    bindingVersion: string;
    agentGeneration: string;
    ownerAddress: string;
    signal: AbortSignal;
  }>,
): Promise<AllocatedSpotAgentIdentity> {
  let raw: unknown;
  try {
    raw = await awaitWithAbort(
      options.agentIdentityAllocator.allocate({
        requestId: input.requestId,
        ownerUserId: input.ownerUserId,
        privyUserId: input.privyUserId,
        network: "testnet",
        bindingVersion: input.bindingVersion,
        agentGeneration: input.agentGeneration,
        signal: input.signal,
      }),
      input.signal,
    );
  } catch (error) {
    if (error instanceof PrivyAgentIdentityAllocatorUnavailableError) {
      return unavailable();
    }
    return unavailable();
  }
  let identity: z.output<typeof allocatorOutputSchema>;
  try {
    identity = parseSpotContract(allocatorOutputSchema, raw);
  } catch {
    return unavailable();
  }
  if (identity.agentAddress === input.ownerAddress) {
    return unavailable();
  }
  return identity;
}

function creationFromResult(
  result: Extract<
    IssueSpotAgentAuthorizationResult,
    { kind: "issued" | "replayed" }
  >,
  authority: SpotAgentWalletAuthority,
  now: () => Date,
  expected?: Readonly<{
    agentIdentityId?: string;
    agentGeneration?: string;
    agentAddress?: string;
    agentName?: string;
    signerRef?: string;
    agentValidUntil?: string;
    authorizationId?: string;
  }>,
): SpotAgentAuthorizationCreationResource {
  const record = result.authorization;
  const signingExpiresAtMilliseconds = Date.parse(record.signingExpiresAt);
  if (
    !Number.isSafeInteger(signingExpiresAtMilliseconds) ||
    record.ownerUserId !== authority.ownerUserId ||
    record.accountAddress !== authority.accountAddress ||
    record.bindingVersion !== authority.bindingVersion ||
    record.agentName !==
      canonicalAgentName(record.agentAddress, record.agentValidUntil) ||
    (expected?.agentIdentityId !== undefined &&
      record.agentIdentityId !== expected.agentIdentityId) ||
    (expected?.agentGeneration !== undefined &&
      record.agentGeneration !== expected.agentGeneration) ||
    (expected?.agentAddress !== undefined &&
      record.agentAddress !== expected.agentAddress) ||
    (expected?.agentName !== undefined &&
      record.agentName !== expected.agentName) ||
    (expected?.signerRef !== undefined &&
      record.signerRef !== expected.signerRef) ||
    (expected?.agentValidUntil !== undefined &&
      record.agentValidUntil !== expected.agentValidUntil) ||
    (expected?.authorizationId !== undefined &&
      record.id !== expected.authorizationId)
  ) {
    return unavailable();
  }
  let status: SpotAgentAuthorizationResource;
  let creation: SpotAgentAuthorizationCreationResource;
  try {
    status = parseSpotAgentAuthorizationResource(record.resource);
    creation = parseSpotAgentAuthorizationCreationResource({
      ...status,
      signable_payload: result.signablePayload,
    });
  } catch {
    return unavailable();
  }
  if (
    creation.authorization_id !== record.id ||
    creation.binding_epoch !== record.bindingVersion ||
    creation.signable_payload.agent_address !== record.agentAddress ||
    creation.signable_payload.agent_name !== record.agentName ||
    creation.signable_payload.nonce !== record.authorizationNonce ||
    creation.signable_payload.expires_at !== record.signingExpiresAt
  ) {
    return unavailable();
  }
  if (signingExpiresAtMilliseconds <= readNow(now)) {
    return unavailable();
  }
  return creation;
}

async function findOwnedRecord(
  repository: SpotAgentAuthorizationIssueRepository,
  ownerUserId: string,
  authorizationId: string,
): Promise<SpotAgentAuthorizationRecord> {
  let record: SpotAgentAuthorizationRecord | null;
  try {
    record = await repository.findOwned(ownerUserId, authorizationId);
  } catch (error) {
    return translateRepositoryError(error);
  }
  if (record === null) {
    throw new SpotAgentAuthorizationNotFoundError();
  }
  let resource: SpotAgentAuthorizationResource;
  try {
    resource = parseSpotAgentAuthorizationResource(record.resource);
  } catch {
    return unavailable();
  }
  if (
    record.ownerUserId !== ownerUserId ||
    record.id !== authorizationId ||
    resource.authorization_id !== authorizationId
  ) {
    return unavailable();
  }
  return record;
}

function parseWorkflowInput(value: unknown) {
  const parsed = workflowInputSchema.safeParse(value);
  if (!parsed.success || parsed.data.signal.aborted) {
    return unavailable();
  }
  return parsed.data;
}

export function createSpotAgentAuthorizationWorkflow(
  options: CreateSpotAgentAuthorizationWorkflowInput,
): SpotAgentAuthorizationWorkflow {
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 8_000;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > SPOT_AGENT_AUTHORIZATION_ADMISSION_MAX_MILLISECONDS ||
    typeof options.materializeForNonce !== "function" ||
    typeof options.computeSigningDigest !== "function"
  ) {
    return unavailable();
  }
  const createUuid = options.createUuid ?? randomUUID;
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    async issue(
      rawInput: Parameters<SpotAgentAuthorizationWorkflow["issue"]>[0],
    ) {
      const input = parseWorkflowInput(rawInput);
      const admissionStartedAtMilliseconds = readNow(now);
      const workflowDeadlineMilliseconds =
        admissionStartedAtMilliseconds + timeoutMilliseconds;
      if (!Number.isSafeInteger(workflowDeadlineMilliseconds)) {
        return unavailable();
      }
      const admissionStartedAt = timestamp(admissionStartedAtMilliseconds);
      const signal = AbortSignal.any([
        input.signal,
        AbortSignal.timeout(timeoutMilliseconds),
      ]);
      const usedRequestIds = new Set([input.requestId]);

      const firstPolicy = await evaluatePolicy(
        options,
        {
          ownerUserId: input.ownerUserId,
          requestId: freshUuid(createUuid, usedRequestIds),
          signal,
        },
        now,
      );
      const firstAuthority = await resolveWalletAuthority(
        options,
        {
          ownerUserId: input.ownerUserId,
          privyUserId: input.privyUserId,
          signal,
        },
        now,
      );

      let preflight: PreflightSpotAgentAuthorizationResult | undefined;
      for (let pass = 0; pass < 4; pass += 1) {
        const candidate = await runPreflight(
          options,
          firstAuthority,
          firstPolicy,
          admissionStartedAt,
          workflowDeadlineMilliseconds,
          freshUuid(createUuid, usedRequestIds),
          signal,
          now,
        );
        if (candidate.kind === "expired") {
          continue;
        }
        preflight = candidate;
        break;
      }
      if (preflight === undefined) {
        return unavailable();
      }

      if (preflight.kind === "replayed") {
        const currentAuthority = await resolveWalletAuthority(
          options,
          {
            ownerUserId: input.ownerUserId,
            privyUserId: input.privyUserId,
            signal,
          },
          now,
        );
        if (!sameWalletAuthority(firstAuthority, currentAuthority)) {
          return unavailable();
        }
        const currentPolicy = await evaluatePolicy(
          options,
          {
            ownerUserId: input.ownerUserId,
            requestId: freshUuid(createUuid, usedRequestIds),
            signal,
          },
          now,
        );
        const confirmed = await runPreflight(
          options,
          currentAuthority,
          currentPolicy,
          admissionStartedAt,
          workflowDeadlineMilliseconds,
          freshUuid(createUuid, usedRequestIds),
          signal,
          now,
        );
        if (confirmed.kind !== "replayed" || signalAborted(signal)) {
          return unavailable();
        }
        return creationFromResult(confirmed, currentAuthority, now, {
          authorizationId: preflight.authorization.id,
          agentIdentityId: preflight.authorization.agentIdentityId,
          agentGeneration: preflight.authorization.agentGeneration,
          agentAddress: preflight.authorization.agentAddress,
          agentName: preflight.authorization.agentName,
          signerRef: preflight.authorization.signerRef,
          agentValidUntil: preflight.authorization.agentValidUntil,
        });
      }

      let required: z.output<typeof issueRequiredSchema>;
      try {
        required = parseSpotContract(issueRequiredSchema, preflight);
      } catch {
        return unavailable();
      }

      let allocated: AllocatedSpotAgentIdentity | null = null;
      if (required.reservedIdentity === null) {
        allocated = await allocateAgentIdentity(options, {
          ownerUserId: input.ownerUserId,
          privyUserId: input.privyUserId,
          requestId: freshUuid(createUuid, usedRequestIds),
          bindingVersion: firstAuthority.bindingVersion,
          agentGeneration: required.agentGeneration,
          ownerAddress: firstAuthority.accountAddress,
          signal,
        });
      }

      const currentAuthority = await resolveWalletAuthority(
        options,
        {
          ownerUserId: input.ownerUserId,
          privyUserId: input.privyUserId,
          signal,
        },
        now,
      );
      if (!sameWalletAuthority(firstAuthority, currentAuthority)) {
        return unavailable();
      }
      const currentPolicy = await evaluatePolicy(
        options,
        {
          ownerUserId: input.ownerUserId,
          requestId: freshUuid(createUuid, usedRequestIds),
          signal,
        },
        now,
      );

      const observedAtMilliseconds = readNow(now);
      const signingExpiresAt = timestamp(
        observedAtMilliseconds +
          SPOT_AGENT_AUTHORIZATION_SIGNING_TTL_MILLISECONDS -
          SPOT_AGENT_AUTHORIZATION_AUTHORITY_LEASE_MILLISECONDS,
      );
      const authorizationId = freshUuid(createUuid, usedRequestIds);
      let identity: ReservedSpotAgentIdentity;
      if (required.reservedIdentity === null) {
        if (allocated === null) {
          return unavailable();
        }
        const agentValidUntil = timestamp(
          observedAtMilliseconds +
            SPOT_AGENT_AUTHORIZATION_MAX_AGENT_LIFETIME_MILLISECONDS -
            SPOT_AGENT_AUTHORIZATION_AUTHORITY_LEASE_MILLISECONDS,
        );
        identity = Object.freeze({
          agentIdentityId: freshUuid(createUuid, usedRequestIds),
          agentGeneration: required.agentGeneration,
          agentAddress: allocated.agentAddress,
          agentName: canonicalAgentName(
            allocated.agentAddress,
            agentValidUntil,
          ),
          signerRef: allocated.signerRef,
          agentValidUntil,
        });
      } else {
        identity = parseReservedIdentity(
          required.reservedIdentity,
          required.agentGeneration,
          currentAuthority.accountAddress,
          observedAtMilliseconds,
        );
        if (usedRequestIds.has(identity.agentIdentityId)) {
          return unavailable();
        }
        usedRequestIds.add(identity.agentIdentityId);
      }
      if (signalAborted(signal)) {
        return unavailable();
      }

      let issued: IssueSpotAgentAuthorizationResult;
      try {
        issued = await awaitWithAbort(
          options.repository.issueOrReplayCurrent(
            {
              authorizationId,
              agentIdentityId: identity.agentIdentityId,
              agentGeneration: identity.agentGeneration,
              ownerUserId: input.ownerUserId,
              privyUserId: input.privyUserId,
              requestId: input.requestId,
              walletId: currentAuthority.walletId,
              accountAddress: currentAuthority.accountAddress,
              accountKind: currentAuthority.accountKind,
              bindingVersion: currentAuthority.bindingVersion,
              verifiedAt: currentAuthority.verifiedAt,
              expiresAt: currentAuthority.expiresAt,
              policyOwnerUserId: currentPolicy.ownerUserId,
              policyNetwork: currentPolicy.network,
              policyAction: currentPolicy.action,
              policyCheckedAt: currentPolicy.checkedAt,
              policyExpiresAt: currentPolicy.expiresAt,
              admissionStartedAt,
              admissionExpiresAt: admissionExpiry(
                currentAuthority,
                currentPolicy,
                workflowDeadlineMilliseconds,
                now,
              ),
              agentAddress: identity.agentAddress,
              agentName: identity.agentName,
              signerRef: identity.signerRef,
              agentValidUntil: identity.agentValidUntil,
              signingExpiresAt,
              policyVersion: SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
            },
            options.materializeForNonce,
            options.computeSigningDigest,
            signal,
          ),
          signal,
        );
      } catch (error) {
        if (error instanceof SpotAgentAuthorizationAuthorityStaleError) {
          const recovered = await runPreflight(
            options,
            currentAuthority,
            currentPolicy,
            admissionStartedAt,
            workflowDeadlineMilliseconds,
            freshUuid(createUuid, usedRequestIds),
            signal,
            now,
          );
          if (recovered.kind === "replayed") {
            return creationFromResult(recovered, currentAuthority, now, {
              agentGeneration: identity.agentGeneration,
              agentAddress: identity.agentAddress,
              signerRef: identity.signerRef,
            });
          }
          return unavailable();
        }
        return translateRepositoryError(error);
      }

      if (issued.kind === "expired") {
        throw new SpotAgentAuthorizationExpiredError();
      }
      if (signalAborted(signal)) {
        return unavailable();
      }
      return creationFromResult(
        issued,
        currentAuthority,
        now,
        issued.kind === "issued"
          ? {
              authorizationId,
              agentIdentityId: identity.agentIdentityId,
              agentGeneration: identity.agentGeneration,
              agentAddress: identity.agentAddress,
              agentName: identity.agentName,
              signerRef: identity.signerRef,
              agentValidUntil: identity.agentValidUntil,
            }
          : {
              agentGeneration: identity.agentGeneration,
              agentAddress: identity.agentAddress,
              signerRef: identity.signerRef,
            },
      );
    },

    async findOwned(
      rawInput: Parameters<SpotAgentAuthorizationWorkflow["findOwned"]>[0],
    ): Promise<SpotAgentAuthorizationResource> {
      const parsed = z
        .object({
          ownerUserId: z.string().regex(uuidPattern),
          authorizationId: z.string().regex(uuidPattern),
        })
        .strict()
        .safeParse(rawInput);
      if (!parsed.success) {
        return unavailable();
      }
      const record = await findOwnedRecord(
        options.repository,
        parsed.data.ownerUserId,
        parsed.data.authorizationId,
      );
      try {
        return parseSpotAgentAuthorizationResource(record.resource);
      } catch {
        return unavailable();
      }
    },

    async submitSignature(
      rawInput: Parameters<
        SpotAgentAuthorizationWorkflow["submitSignature"]
      >[0],
    ): Promise<SpotAgentAuthorizationResource> {
      const parsed = workflowInputSchema
        .extend({
          authorizationId: z.string().regex(uuidPattern),
          signature: z.string(),
        })
        .strict()
        .safeParse(rawInput);
      if (!parsed.success || parsed.data.signal.aborted) {
        return unavailable();
      }
      try {
        parseSpotAgentAuthorizationSignatureRequest({
          signature: parsed.data.signature,
        });
      } catch {
        return unavailable();
      }
      const record = await findOwnedRecord(
        options.repository,
        parsed.data.ownerUserId,
        parsed.data.authorizationId,
      );
      let resource: SpotAgentAuthorizationResource;
      try {
        resource = parseSpotAgentAuthorizationResource(record.resource);
      } catch {
        return unavailable();
      }
      if (resource.state === "expired") {
        throw new SpotAgentAuthorizationExpiredError();
      }
      if (resource.state === "prepared") {
        if (Date.parse(resource.expires_at) <= readNow(now)) {
          throw new SpotAgentAuthorizationExpiredError();
        }
        return unavailable();
      }
      return resource;
    },
  });
}
