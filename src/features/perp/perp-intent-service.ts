import { createHash } from "node:crypto";

import { z } from "zod";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { IdempotencyConflictError } from "../../database/control-plane-repository.js";
import {
  PerpIntentClaimLimitExceededError,
  PerpIntentPrepareExpiredError,
  PerpIntentRepositoryUnavailableError,
  type PerpIntentRecord,
  type PerpIntentRepository,
} from "../../database/perp-intent-repository.js";
import {
  HyperliquidPerpIntentReviewerUnavailableError,
  type HyperliquidPerpIntentReviewer,
  type PerpIntentReviewItem,
} from "../../integrations/hyperliquid/perp-intent-reviewer.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";
import {
  PERP_INTENT_REVIEW_MAX_AGE_MS,
  PERP_MARKET_ORDER_REVIEW_MAX_AGE_MS,
  createPerpClientOrderId,
  canonicalizePerpIntentRequest,
  digestPerpIntentRequest,
  parsePerpIntentRequest,
  parsePerpIntentResource,
  parsePerpPublicReviewForRequest,
  type PerpIntentRequest,
  type PerpIntentResource,
  type PerpOrderTarget,
  type PerpPublicReview,
} from "./perp-intent-contract.js";
import {
  WalletBindingRequiredError,
  WalletBindingResolutionUnavailableError,
  type PerpWalletBindingResolver,
  type VerifiedPerpWalletBinding,
} from "./wallet-binding-resolver.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const lowercaseAddressPattern = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const bindingVersionPattern = /^[1-9][0-9]{0,18}$/;
const maximumBindingVersion = 9_223_372_036_854_775_807n;
const requestDigestPattern = /^[0-9a-f]{64}$/;

const principalSchema = z
  .object({
    userId: z.string().regex(uuidPattern),
    privyUserId: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/),
    streamUserId: z.string().min(1).max(63),
  })
  .strict();

const bindingSchema = z
  .object({
    ownerUserId: z.string().regex(uuidPattern),
    privyUserId: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/),
    accountAddress: z.string().regex(lowercaseAddressPattern),
    accountKind: z.enum(["master", "subaccount"]),
    bindingVersion: z.string().regex(bindingVersionPattern),
    verifiedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export interface PreparePerpIntentInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

export interface GetPerpIntentInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly intentId: string;
}

export interface SubmitPerpIntentInput extends GetPerpIntentInput {
  readonly signal: AbortSignal;
}

export interface CheckPerpMutationInput {
  readonly ownerUserId: string;
  readonly intentId: string;
  readonly action: PerpIntentRequest["action"];
  readonly signal: AbortSignal;
}

export interface PerpMutationGate {
  assertAllowed(input: CheckPerpMutationInput): Promise<void>;
}

export interface PerpIntentService {
  prepare(input: PreparePerpIntentInput): Promise<PerpIntentResource>;
  get(input: GetPerpIntentInput): Promise<PerpIntentResource>;
  submit(input: SubmitPerpIntentInput): Promise<PerpIntentResource>;
}

export interface CreatePerpIntentServiceInput {
  readonly repository: PerpIntentRepository;
  readonly bindingResolver: PerpWalletBindingResolver;
  readonly reviewer: HyperliquidPerpIntentReviewer;
  readonly mutationGate?: PerpMutationGate;
  readonly now?: () => Date;
}

export class InvalidPerpIntentRequestError extends Error {
  readonly code = "invalid_perp_intent_request";

  constructor() {
    super("The Perp intent request is invalid");
    this.name = "InvalidPerpIntentRequestError";
  }
}

export class PerpIntentIdempotencyConflictError extends Error {
  readonly code = "perp_intent_idempotency_conflict";

  constructor() {
    super("The Perp intent idempotency key conflicts");
    this.name = "PerpIntentIdempotencyConflictError";
  }
}

export class PerpIntentClaimRateLimitedError extends Error {
  readonly code = "perp_intent_claim_rate_limited";

  constructor() {
    super("The Perp intent claim budget is exhausted");
    this.name = "PerpIntentClaimRateLimitedError";
  }
}

export class PerpIntentWalletBindingRequiredError extends Error {
  readonly code = "perp_intent_wallet_binding_required";

  constructor() {
    super("A verified wallet binding is required");
    this.name = "PerpIntentWalletBindingRequiredError";
  }
}

export class PerpIntentNotFoundError extends Error {
  readonly code = "perp_intent_not_found";

  constructor() {
    super("The Perp intent was not found");
    this.name = "PerpIntentNotFoundError";
  }
}

export class PerpMutationDisabledError extends Error {
  readonly code = "perp_mutation_disabled";

  constructor() {
    super("Perp mutations are disabled");
    this.name = "PerpMutationDisabledError";
  }
}

export class PerpIntentStaleError extends Error {
  readonly code = "perp_intent_stale";

  constructor() {
    super("The Perp intent must be reviewed again");
    this.name = "PerpIntentStaleError";
  }
}

export class PerpIntentExpiredError extends Error {
  readonly code = "perp_intent_expired";

  constructor() {
    super("The Perp intent has expired");
    this.name = "PerpIntentExpiredError";
  }
}

export class PerpIntentUnavailableError extends Error {
  readonly code = "perp_intent_unavailable";

  constructor() {
    super("Perp intent preparation is unavailable");
    this.name = "PerpIntentUnavailableError";
  }
}

export class PerpIntentFailedError extends Error {
  readonly code = "perp_intent_failed";

  constructor() {
    super("Perp intent processing failed");
    this.name = "PerpIntentFailedError";
  }
}

export function createDisabledPerpMutationGate(): PerpMutationGate {
  return Object.freeze({
    assertAllowed(): Promise<never> {
      return Promise.reject(new PerpMutationDisabledError());
    },
  });
}

function assertPrincipal(
  principal: AuthenticatedLoopPrincipal,
): AuthenticatedLoopPrincipal {
  const parsed = principalSchema.safeParse(principal);

  if (!parsed.success) {
    throw new InvalidPerpIntentRequestError();
  }

  let expectedStreamUserId: string;
  try {
    expectedStreamUserId = deriveStreamUserId(parsed.data.userId);
  } catch {
    throw new InvalidPerpIntentRequestError();
  }

  if (parsed.data.streamUserId !== expectedStreamUserId) {
    throw new InvalidPerpIntentRequestError();
  }

  return parsed.data;
}

function assertExactInputKeys(
  value: object,
  expectedKeys: readonly string[],
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key))
  ) {
    throw new InvalidPerpIntentRequestError();
  }

  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new InvalidPerpIntentRequestError();
    }
  }
}

function assertCanonicalUuid(value: string): string {
  if (!uuidPattern.test(value)) {
    throw new InvalidPerpIntentRequestError();
  }
  return value;
}

function readNow(now: () => Date): Date {
  const value = now();
  if (Number.isNaN(value.getTime())) {
    throw new PerpIntentFailedError();
  }
  return value;
}

function parseBinding(
  value: unknown,
  principal: AuthenticatedLoopPrincipal,
  observedAt: Date,
): VerifiedPerpWalletBinding {
  if (value === null || Array.isArray(value)) {
    throw new PerpIntentWalletBindingRequiredError();
  }

  const parsed = bindingSchema.safeParse(value);
  if (!parsed.success) {
    throw new PerpIntentUnavailableError();
  }

  const binding = parsed.data;
  const verifiedAt = Date.parse(binding.verifiedAt);
  const expiresAt = Date.parse(binding.expiresAt);
  let bindingVersion: bigint;

  try {
    bindingVersion = BigInt(binding.bindingVersion);
  } catch {
    throw new PerpIntentUnavailableError();
  }

  if (
    binding.ownerUserId !== principal.userId ||
    binding.privyUserId !== principal.privyUserId ||
    bindingVersion > maximumBindingVersion ||
    verifiedAt > observedAt.getTime()
  ) {
    throw new PerpIntentUnavailableError();
  }

  if (
    binding.accountAddress === zeroAddress ||
    expiresAt <= observedAt.getTime()
  ) {
    throw new PerpIntentWalletBindingRequiredError();
  }

  return binding;
}

async function resolveBinding(
  resolver: PerpWalletBindingResolver,
  principal: AuthenticatedLoopPrincipal,
  signal: AbortSignal,
  now: () => Date,
): Promise<VerifiedPerpWalletBinding> {
  let value: unknown;
  try {
    value = await resolver.resolve({
      ownerUserId: principal.userId,
      privyUserId: principal.privyUserId,
      signal,
    });
  } catch (error) {
    if (error instanceof WalletBindingRequiredError) {
      throw new PerpIntentWalletBindingRequiredError();
    }
    if (error instanceof WalletBindingResolutionUnavailableError) {
      throw new PerpIntentUnavailableError();
    }
    throw error;
  }

  return parseBinding(value, principal, readNow(now));
}

function assertSameBindingAuthority(
  reviewedBinding: VerifiedPerpWalletBinding,
  currentBinding: VerifiedPerpWalletBinding,
): void {
  if (
    currentBinding.ownerUserId !== reviewedBinding.ownerUserId ||
    currentBinding.privyUserId !== reviewedBinding.privyUserId ||
    currentBinding.accountAddress !== reviewedBinding.accountAddress ||
    currentBinding.accountKind !== reviewedBinding.accountKind ||
    currentBinding.bindingVersion !== reviewedBinding.bindingVersion
  ) {
    throw new PerpIntentStaleError();
  }
}

function intentItems(
  request: PerpIntentRequest,
): readonly PerpIntentReviewItem[] {
  function targetFields(
    target: PerpOrderTarget,
  ): Pick<
    PerpIntentReviewItem,
    "targetKind" | "targetOrderId" | "targetClientOrderId"
  > &
    Pick<PerpIntentReviewItem, "generatedClientOrderId"> {
    return target.kind === "order_id"
      ? {
          targetKind: "order_id",
          targetOrderId: target.order_id,
          targetClientOrderId: null,
          generatedClientOrderId: null,
        }
      : {
          targetKind: "client_order_id",
          targetOrderId: null,
          targetClientOrderId: target.client_order_id,
          generatedClientOrderId: null,
        };
  }

  switch (request.action) {
    case "order":
      return Object.freeze([
        Object.freeze({
          index: 0,
          coin: request.coin,
          targetKind: null,
          targetOrderId: null,
          targetClientOrderId: null,
          generatedClientOrderId: createPerpClientOrderId(),
        }),
      ]);
    case "cancel":
      return Object.freeze([
        Object.freeze({
          index: 0,
          coin: request.coin,
          ...targetFields(request.target),
        }),
      ]);
    case "modify":
      return Object.freeze([
        Object.freeze({
          index: 0,
          coin: request.coin,
          ...targetFields(request.target),
          generatedClientOrderId: createPerpClientOrderId(),
        }),
      ]);
    case "batch_modify":
      return Object.freeze(
        request.modifications.map((modification, index) =>
          Object.freeze({
            index,
            coin: modification.coin,
            ...targetFields(modification.target),
            generatedClientOrderId: createPerpClientOrderId(),
          }),
        ),
      );
    case "update_leverage":
    case "update_isolated_margin":
      return Object.freeze([
        Object.freeze({
          index: 0,
          coin: request.coin,
          targetKind: null,
          targetOrderId: null,
          targetClientOrderId: null,
          generatedClientOrderId: null,
        }),
      ]);
  }
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (typeof value !== "object") {
    throw new PerpIntentFailedError();
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function reviewDigest(input: {
  readonly ownerUserId: string;
  readonly requestSha256: string;
  readonly binding: VerifiedPerpWalletBinding;
  readonly review: PerpPublicReview;
}): string {
  return createHash("sha256")
    .update("loop.perp.intent.review.v1\0", "utf8")
    .update(
      canonicalJson({
        owner_user_id: input.ownerUserId,
        account_address: input.binding.accountAddress,
        account_kind: input.binding.accountKind,
        binding_version: input.binding.bindingVersion,
        request_sha256: input.requestSha256,
        review: input.review,
      }),
      "utf8",
    )
    .digest("hex");
}

function assertReviewMatchesRequest(
  request: PerpIntentRequest,
  items: readonly PerpIntentReviewItem[],
  review: PerpPublicReview,
): void {
  let expected: unknown;

  switch (request.action) {
    case "order": {
      const generatedClientOrderId = items[0]?.generatedClientOrderId;
      if (typeof generatedClientOrderId !== "string") {
        throw new PerpIntentUnavailableError();
      }
      expected =
        request.order_type === "limit"
          ? { ...request, client_order_id: generatedClientOrderId }
          : {
              ...request,
              final_limit_price:
                review.action.action === "order" &&
                review.action.order_type === "market"
                  ? review.action.final_limit_price
                  : null,
              client_order_id: generatedClientOrderId,
            };
      break;
    }
    case "cancel":
    case "update_leverage":
    case "update_isolated_margin":
      expected = request;
      break;
    case "modify": {
      const generatedClientOrderId = items[0]?.generatedClientOrderId;
      if (typeof generatedClientOrderId !== "string") {
        throw new PerpIntentUnavailableError();
      }
      expected = {
        ...request,
        replacement_client_order_id: generatedClientOrderId,
      };
      break;
    }
    case "batch_modify":
      if (items.length !== request.modifications.length) {
        throw new PerpIntentUnavailableError();
      }
      expected = {
        action: "batch_modify",
        modifications: request.modifications.map((modification, index) => {
          const generatedClientOrderId = items[index]?.generatedClientOrderId;
          if (typeof generatedClientOrderId !== "string") {
            throw new PerpIntentUnavailableError();
          }
          return {
            ...modification,
            replacement_client_order_id: generatedClientOrderId,
          };
        }),
      };
      break;
  }

  if (canonicalJson(review.action) !== canonicalJson(expected)) {
    throw new PerpIntentUnavailableError();
  }
}

function toResource(record: PerpIntentRecord): PerpIntentResource {
  try {
    const review = parsePerpPublicReviewForRequest(
      record.canonicalAction,
      record.publicReview,
    );
    assertReviewMatchesRequest(record.canonicalAction, record.items, review);
    return parsePerpIntentResource({
      intent_id: record.id,
      action: record.action,
      state: record.state,
      review,
      expires_at: record.expiresAt,
      submission: {
        state:
          record.state === "expired" ? "requires_revalidation" : "disabled",
      },
      result: record.result,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    });
  } catch {
    throw new PerpIntentFailedError();
  }
}

function mapPersistenceError(error: unknown): never {
  if (error instanceof IdempotencyConflictError) {
    throw new PerpIntentIdempotencyConflictError();
  }
  if (error instanceof PerpIntentClaimLimitExceededError) {
    throw new PerpIntentClaimRateLimitedError();
  }
  if (error instanceof PerpIntentPrepareExpiredError) {
    throw new PerpIntentStaleError();
  }
  if (error instanceof PerpIntentRepositoryUnavailableError) {
    throw new PerpIntentUnavailableError();
  }
  throw error;
}

function assertPreparedRecordBinding(
  record: PerpIntentRecord,
  input: {
    readonly ownerUserId: string;
    readonly requestSha256: string;
    readonly request: PerpIntentRequest;
  },
): void {
  if (
    record.ownerUserId !== input.ownerUserId ||
    record.requestSha256 !== input.requestSha256
  ) {
    throw new PerpIntentIdempotencyConflictError();
  }

  try {
    if (
      record.action !== input.request.action ||
      canonicalizePerpIntentRequest(record.canonicalAction) !==
        canonicalizePerpIntentRequest(input.request)
    ) {
      throw new PerpIntentFailedError();
    }
  } catch (error) {
    if (error instanceof PerpIntentFailedError) {
      throw error;
    }
    throw new PerpIntentFailedError();
  }
}

async function findOwnedIntent(
  repository: PerpIntentRepository,
  ownerUserId: string,
  intentId: string,
): Promise<PerpIntentRecord> {
  let record: PerpIntentRecord | null;
  try {
    record = await repository.findOwned(ownerUserId, intentId);
  } catch (error) {
    return mapPersistenceError(error);
  }

  if (
    record === null ||
    record.ownerUserId !== ownerUserId ||
    record.id !== intentId
  ) {
    throw new PerpIntentNotFoundError();
  }
  return record;
}

export function createPerpIntentService(
  input: CreatePerpIntentServiceInput,
): PerpIntentService {
  const mutationGate = input.mutationGate ?? createDisabledPerpMutationGate();
  const now = input.now ?? (() => new Date());

  return Object.freeze({
    async prepare(
      requestInput: PreparePerpIntentInput,
    ): Promise<PerpIntentResource> {
      assertExactInputKeys(requestInput, [
        "principal",
        "idempotencyKey",
        "requestId",
        "body",
        "signal",
      ]);
      const principal = assertPrincipal(requestInput.principal);
      const idempotencyKey = assertCanonicalUuid(requestInput.idempotencyKey);
      const requestId = assertCanonicalUuid(requestInput.requestId);
      if (!(requestInput.signal instanceof AbortSignal)) {
        throw new InvalidPerpIntentRequestError();
      }

      let request: PerpIntentRequest;
      let requestSha256: string;
      try {
        request = parsePerpIntentRequest(requestInput.body);
        requestSha256 = digestPerpIntentRequest(request);
      } catch {
        throw new InvalidPerpIntentRequestError();
      }
      if (!requestDigestPattern.test(requestSha256)) {
        throw new PerpIntentFailedError();
      }

      let claim;
      try {
        claim = await input.repository.claimPrepare({
          ownerUserId: principal.userId,
          idempotencyKey,
          requestSha256,
        });
      } catch (error) {
        return mapPersistenceError(error);
      }
      if (claim.kind === "replay") {
        assertPreparedRecordBinding(claim.intent, {
          ownerUserId: principal.userId,
          requestSha256,
          request,
        });
        return toResource(claim.intent);
      }

      const binding = await resolveBinding(
        input.bindingResolver,
        principal,
        requestInput.signal,
        now,
      );
      const items = intentItems(request);
      let review: PerpPublicReview;
      try {
        const reviewValue = await input.reviewer.review({
          ownerUserId: principal.userId,
          accountAddress: binding.accountAddress,
          accountKind: binding.accountKind,
          bindingVersion: binding.bindingVersion,
          network: "testnet",
          market: "core_perps",
          dex: "",
          request,
          items,
          signal: requestInput.signal,
        });
        review = parsePerpPublicReviewForRequest(request, reviewValue);
        assertReviewMatchesRequest(request, items, review);
      } catch (error) {
        if (error instanceof HyperliquidPerpIntentReviewerUnavailableError) {
          throw new PerpIntentUnavailableError();
        }
        throw new PerpIntentUnavailableError();
      }

      const reviewObservedAt = Date.parse(review.source.fetched_at);
      const reviewExpiresAt = Date.parse(review.source.expires_at);
      const reviewedAt = readNow(now).getTime();
      const maximumAge =
        request.action === "order" && request.order_type === "market"
          ? PERP_MARKET_ORDER_REVIEW_MAX_AGE_MS
          : PERP_INTENT_REVIEW_MAX_AGE_MS;
      if (
        reviewObservedAt > reviewedAt ||
        reviewedAt - reviewObservedAt > maximumAge ||
        reviewExpiresAt <= reviewedAt ||
        reviewExpiresAt <= reviewObservedAt ||
        reviewExpiresAt - reviewObservedAt > maximumAge
      ) {
        throw new PerpIntentStaleError();
      }
      const currentBinding = await resolveBinding(
        input.bindingResolver,
        principal,
        requestInput.signal,
        now,
      );
      assertSameBindingAuthority(binding, currentBinding);

      try {
        const prepared = await input.repository.prepare({
          ownerUserId: principal.userId,
          idempotencyKey,
          requestSha256,
          requestId,
          accountAddress: currentBinding.accountAddress,
          accountKind: currentBinding.accountKind,
          bindingVersion: currentBinding.bindingVersion,
          action: request.action,
          canonicalAction: request,
          publicReview: review,
          reviewSha256: reviewDigest({
            ownerUserId: principal.userId,
            requestSha256,
            binding: currentBinding,
            review,
          }),
          factsObservedAt: review.source.fetched_at,
          expiresAt: review.source.expires_at,
          items,
        });
        assertPreparedRecordBinding(prepared.intent, {
          ownerUserId: principal.userId,
          requestSha256,
          request,
        });
        return toResource(prepared.intent);
      } catch (error) {
        return mapPersistenceError(error);
      }
    },

    async get(requestInput: GetPerpIntentInput): Promise<PerpIntentResource> {
      assertExactInputKeys(requestInput, ["principal", "intentId"]);
      const principal = assertPrincipal(requestInput.principal);
      const intentId = assertCanonicalUuid(requestInput.intentId);
      const record = await findOwnedIntent(
        input.repository,
        principal.userId,
        intentId,
      );
      return toResource(record);
    },

    async submit(
      requestInput: SubmitPerpIntentInput,
    ): Promise<PerpIntentResource> {
      assertExactInputKeys(requestInput, ["principal", "intentId", "signal"]);
      const principal = assertPrincipal(requestInput.principal);
      const intentId = assertCanonicalUuid(requestInput.intentId);
      if (!(requestInput.signal instanceof AbortSignal)) {
        throw new InvalidPerpIntentRequestError();
      }

      const record = await findOwnedIntent(
        input.repository,
        principal.userId,
        intentId,
      );
      if (record.state === "expired") {
        throw new PerpIntentExpiredError();
      }
      if (record.state !== "prepared") {
        return toResource(record);
      }
      if (Date.parse(record.expiresAt) <= readNow(now).getTime()) {
        throw new PerpIntentExpiredError();
      }

      await mutationGate.assertAllowed({
        ownerUserId: principal.userId,
        intentId,
        action: record.action,
        signal: requestInput.signal,
      });

      // No signer or Exchange adapter is composed in this slice. Even a custom
      // gate cannot turn the interface into a provider write.
      throw new PerpIntentUnavailableError();
    },
  });
}
