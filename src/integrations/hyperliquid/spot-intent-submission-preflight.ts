import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  SPOT_INTENT_SUBMISSION_ACCOUNT_EVIDENCE_LEASE_MILLISECONDS,
  SPOT_INTENT_SUBMISSION_ATTEMPT_MILLISECONDS,
  SPOT_INTENT_SUBMISSION_AUTHORITY_LEASE_MILLISECONDS,
  SPOT_INTENT_SUBMISSION_METADATA_LEASE_MILLISECONDS,
} from "../../database/spot-intent-repository.js";
import {
  compareExactUnsignedDecimals,
  exactUnsignedDecimalSumEquals,
} from "../../features/spot/spot-exact-decimal.js";
import {
  SpotIntentExpiredError,
  SpotIntentStaleError,
} from "../../features/spot/spot-intent-service.js";
import type {
  SpotIntentSubmissionEvidence,
  SpotIntentSubmissionPolicyGate,
  SpotIntentSubmissionPreflight,
  SpotIntentSubmissionSubject,
} from "../../features/spot/spot-intent-submission.js";
import {
  parseSpotIntentPrepareAuthority,
  sameSpotIntentPrepareAuthority,
  SpotIntentPrepareAuthorityRequiredError,
  type SpotIntentPrepareAuthority,
  type SpotIntentPrepareAuthorityResolver,
} from "../../features/spot/spot-intent-prepare.js";
import {
  SpotUnavailableError,
  SpotWalletBindingRequiredError,
} from "../../features/spot/spot-errors.js";
import {
  HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
  type HyperliquidSpotInfoReader,
} from "./spot-info-contract.js";
import {
  canonicalizeExactUnsignedDecimal,
  hasAtMostExactUnsignedDecimalPlaces,
} from "./spot-order-precision.js";

const maximumPostgresBigint = 9_223_372_036_854_775_807n;
const maximumPostgresInteger = 2_147_483_647;
const zeroAddress = `0x${"0".repeat(40)}`;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalTimestampSchema = z
  .string()
  .max(24)
  .datetime({ offset: false, precision: 3 })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const positiveDecimalSchema = z
  .string()
  .max(128)
  .regex(/^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/);
const nonnegativeDecimalSchema = z
  .string()
  .max(128)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const signedDecimalSchema = z
  .string()
  .max(128)
  .regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/)
  .refine((value) => value !== zeroAddress);
const tokenIdSchema = z.string().regex(/^0x[0-9a-f]{32}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const bindingVersionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= maximumPostgresBigint);
const policyVersionSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const providerCoinSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(
    /^(?:[A-Z0-9][A-Z0-9._-]{0,30}\/[A-Z0-9][A-Z0-9._-]{0,30}|@(?:0|[1-9][0-9]{0,9}))$/,
  );
const displayIdentitySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._:/+-]{0,63}$/);
const safeIntegerSchema = z.number().int().min(0).max(maximumPostgresInteger);
const opaqueProviderIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim())
  .refine((value) =>
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
    }),
  );

const subjectSchema = z
  .object({
    ownerUserId: z.string().regex(uuidPattern),
    intentId: z.string().regex(uuidPattern),
    network: z.literal("testnet"),
    marketId: z.string().regex(uuidPattern),
    providerCoin: providerCoinSchema,
    baseTokenIndex: safeIntegerSchema,
    baseTokenId: tokenIdSchema,
    baseDisplayIdentity: displayIdentitySchema,
    quoteTokenIndex: safeIntegerSchema,
    quoteTokenId: tokenIdSchema,
    quoteDisplayIdentity: displayIdentitySchema,
    spotPairIndex: safeIntegerSchema,
    exchangeOrderAsset: safeIntegerSchema,
    metadataVersion: sha256Schema,
    metadataSha256: sha256Schema,
    policyVersion: policyVersionSchema,
    accountAddress: addressSchema,
    bindingVersion: bindingVersionSchema,
    agentIdentityId: z.string().regex(uuidPattern),
    reviewSha256: sha256Schema,
    side: z.enum(["buy", "sell"]),
    computedBaseSize: positiveDecimalSchema,
    maximumSpendOrMinimumReceive: z
      .object({
        kind: z.enum(["maximum_spend", "minimum_receive"]),
        value: positiveDecimalSchema,
      })
      .strict(),
    feeRate: nonnegativeDecimalSchema,
    expiresAt: canonicalTimestampSchema,
  })
  .strict()
  .superRefine((subject, context) => {
    if (
      subject.baseTokenIndex === subject.quoteTokenIndex ||
      subject.baseTokenId === subject.quoteTokenId ||
      subject.baseDisplayIdentity === subject.quoteDisplayIdentity ||
      subject.quoteTokenId !== HYPERLIQUID_TESTNET_USDC_TOKEN_ID ||
      subject.quoteDisplayIdentity !== "USDC" ||
      subject.exchangeOrderAsset !== 10_000 + subject.spotPairIndex ||
      subject.metadataVersion !== subject.metadataSha256 ||
      subject.maximumSpendOrMinimumReceive.kind !==
        (subject.side === "buy" ? "maximum_spend" : "minimum_receive")
    ) {
      context.addIssue({ code: "custom" });
    }
  });

const preflightInputSchema = z
  .object({
    ownerUserId: z.string().regex(uuidPattern),
    privyUserId: opaqueProviderIdSchema,
    intentId: z.string().regex(uuidPattern),
    marketId: z.string().regex(uuidPattern),
    network: z.literal("testnet"),
    action: z.literal("spot_ioc_order"),
    expectedReviewSha256: sha256Schema,
    subject: subjectSchema,
    requestId: z.string().regex(uuidPattern),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();

const tokenSchema = z
  .object({
    tokenIndex: safeIntegerSchema,
    tokenId: tokenIdSchema,
    symbol: displayIdentitySchema,
    fullName: z.string().min(1).max(255).nullable(),
    sizeDecimals: z.number().int().min(0).max(8),
    weiDecimals: z.number().int().min(0).max(18),
  })
  .strict()
  .refine((token) => token.sizeDecimals <= token.weiDecimals);

const marketContextSchema = z
  .object({
    previousDayPrice: nonnegativeDecimalSchema,
    dayNotionalVolume: nonnegativeDecimalSchema,
    markPrice: nonnegativeDecimalSchema,
    midPrice: nonnegativeDecimalSchema,
    circulatingSupply: nonnegativeDecimalSchema,
    totalSupply: nonnegativeDecimalSchema,
    dayBaseVolume: nonnegativeDecimalSchema,
  })
  .strict();

const metadataSnapshotSchema = z
  .object({
    markets: z
      .array(
        z
          .object({
            marketId: z.string().regex(uuidPattern),
            coin: providerCoinSchema,
            base: tokenSchema,
            quote: tokenSchema,
            spotPairIndex: safeIntegerSchema,
            exchangeOrderAsset: safeIntegerSchema,
            context: marketContextSchema,
          })
          .strict(),
      )
      .min(1)
      .max(128),
    metadataVersion: sha256Schema,
    source: z
      .object({
        provider: z.literal("hyperliquid"),
        network: z.literal("testnet"),
        dataset: z.literal("spotMetaAndAssetCtxs"),
        fetchedAt: canonicalTimestampSchema,
        expiresAt: canonicalTimestampSchema,
      })
      .strict(),
  })
  .strict();

const balancesSnapshotSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            token: tokenSchema,
            total: nonnegativeDecimalSchema,
            hold: nonnegativeDecimalSchema,
            available: nonnegativeDecimalSchema,
            entryNotional: signedDecimalSchema,
          })
          .strict(),
      )
      .max(1_024),
    source: z
      .object({
        provider: z.literal("hyperliquid"),
        network: z.literal("testnet"),
        dataset: z.literal("spotClearinghouseState"),
        fetchedAt: canonicalTimestampSchema,
        expiresAt: canonicalTimestampSchema,
        metadataVersion: sha256Schema,
      })
      .strict(),
  })
  .strict();

const feesSnapshotSchema = z
  .object({
    accountSpotMakerRate: signedDecimalSchema,
    accountSpotTakerRate: nonnegativeDecimalSchema,
    source: z
      .object({
        provider: z.literal("hyperliquid"),
        network: z.literal("testnet"),
        dataset: z.literal("userFees"),
        fetchedAt: canonicalTimestampSchema,
        expiresAt: canonicalTimestampSchema,
      })
      .strict(),
  })
  .strict();

const policyEvidenceSchema = z
  .object({
    ownerUserId: z.string().regex(uuidPattern),
    intentId: z.string().regex(uuidPattern),
    network: z.literal("testnet"),
    action: z.literal("spot_ioc_order"),
    decision: z.literal("allow"),
    policyVersion: policyVersionSchema,
    productEnabled: z.literal(true),
    legalEligible: z.literal(true),
    sanctionsEligible: z.literal(true),
    killSwitchOpen: z.literal(true),
    signerReady: z.literal(true),
    reconciliationReady: z.literal(true),
    checkedAt: canonicalTimestampSchema,
    expiresAt: canonicalTimestampSchema,
  })
  .strict();

export interface CreateHyperliquidSpotIntentSubmissionPreflightInput {
  readonly authorityResolver: SpotIntentPrepareAuthorityResolver;
  readonly infoReader: HyperliquidSpotInfoReader;
  readonly policyGate: SpotIntentSubmissionPolicyGate;
  readonly createUuid?: () => string;
  readonly now?: () => Date;
  readonly timeoutMilliseconds?: number;
}

function unavailable(): never {
  throw new SpotUnavailableError();
}

function stale(): never {
  throw new SpotIntentStaleError();
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

function timestampMilliseconds(value: string): number {
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0
    ? milliseconds
    : unavailable();
}

function assertEvidenceWindow(
  observedAtMilliseconds: number,
  fetchedAt: string,
  expiresAt: string,
  maximumLifetimeMilliseconds: number,
  mustCoverAttempt: boolean,
): void {
  const fetched = timestampMilliseconds(fetchedAt);
  const expires = timestampMilliseconds(expiresAt);
  const attemptDeadline =
    observedAtMilliseconds + SPOT_INTENT_SUBMISSION_ATTEMPT_MILLISECONDS;
  if (
    !Number.isSafeInteger(attemptDeadline) ||
    fetched > observedAtMilliseconds ||
    observedAtMilliseconds >= expires ||
    fetched >= expires ||
    expires - fetched > maximumLifetimeMilliseconds ||
    (mustCoverAttempt && attemptDeadline >= expires)
  ) {
    return unavailable();
  }
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

async function resolveAuthority(
  options: CreateHyperliquidSpotIntentSubmissionPreflightInput,
  input: Readonly<{
    ownerUserId: string;
    privyUserId: string;
    requestId: string;
    signal: AbortSignal;
  }>,
  observedAtMilliseconds: number,
): Promise<SpotIntentPrepareAuthority> {
  let raw: unknown;
  try {
    raw = await awaitWithAbort(
      options.authorityResolver.resolve({
        ownerUserId: input.ownerUserId,
        privyUserId: input.privyUserId,
        network: "testnet",
        requestId: input.requestId,
        signal: input.signal,
      }),
      input.signal,
    );
  } catch (error) {
    if (error instanceof SpotIntentPrepareAuthorityRequiredError) {
      throw new SpotWalletBindingRequiredError();
    }
    return unavailable();
  }
  try {
    return parseSpotIntentPrepareAuthority(
      raw,
      {
        ownerUserId: input.ownerUserId,
        privyUserId: input.privyUserId,
      },
      observedAtMilliseconds,
    );
  } catch (error) {
    if (error instanceof SpotIntentPrepareAuthorityRequiredError) {
      throw new SpotWalletBindingRequiredError();
    }
    return unavailable();
  }
}

function assertAuthorityMatchesSubject(
  authority: SpotIntentPrepareAuthority,
  subject: SpotIntentSubmissionSubject,
): void {
  if (
    authority.ownerUserId !== subject.ownerUserId ||
    authority.accountAddress !== subject.accountAddress ||
    authority.bindingVersion !== subject.bindingVersion ||
    authority.agentIdentityId !== subject.agentIdentityId
  ) {
    return stale();
  }
}

function parseMetadataEvidence(
  raw: unknown,
  subject: SpotIntentSubmissionSubject,
  observedAtMilliseconds: number,
): Readonly<{
  marketEvidence: SpotIntentSubmissionEvidence["marketEvidence"];
  baseSizeDecimals: number;
  baseWeiDecimals: number;
  quoteWeiDecimals: number;
}> {
  const parsed = metadataSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return unavailable();
  }
  const snapshot = parsed.data;
  const marketIds = new Set(snapshot.markets.map((market) => market.marketId));
  const pairIndexes = new Set(
    snapshot.markets.map((market) => market.spotPairIndex),
  );
  if (
    marketIds.size !== snapshot.markets.length ||
    pairIndexes.size !== snapshot.markets.length
  ) {
    return unavailable();
  }
  const matches = snapshot.markets.filter(
    (market) => market.marketId === subject.marketId,
  );
  if (matches.length !== 1) {
    return stale();
  }
  const market = matches[0]!;
  if (
    snapshot.metadataVersion !== subject.metadataVersion ||
    market.coin !== subject.providerCoin ||
    market.base.tokenIndex !== subject.baseTokenIndex ||
    market.base.tokenId !== subject.baseTokenId ||
    market.base.symbol !== subject.baseDisplayIdentity ||
    market.quote.tokenIndex !== subject.quoteTokenIndex ||
    market.quote.tokenId !== subject.quoteTokenId ||
    market.quote.symbol !== subject.quoteDisplayIdentity ||
    market.spotPairIndex !== subject.spotPairIndex ||
    market.exchangeOrderAsset !== subject.exchangeOrderAsset
  ) {
    return stale();
  }
  if (
    market.quote.tokenId !== HYPERLIQUID_TESTNET_USDC_TOKEN_ID ||
    market.quote.symbol !== "USDC" ||
    market.quote.sizeDecimals !== 8 ||
    market.quote.weiDecimals !== 8
  ) {
    return unavailable();
  }
  assertEvidenceWindow(
    observedAtMilliseconds,
    snapshot.source.fetchedAt,
    snapshot.source.expiresAt,
    SPOT_INTENT_SUBMISSION_METADATA_LEASE_MILLISECONDS,
    true,
  );
  return Object.freeze({
    marketEvidence: Object.freeze({
      provider: "hyperliquid" as const,
      network: "testnet" as const,
      dataset: "spotMetaAndAssetCtxs" as const,
      marketId: subject.marketId,
      providerCoin: market.coin,
      baseTokenIndex: market.base.tokenIndex,
      baseTokenId: market.base.tokenId,
      quoteTokenIndex: market.quote.tokenIndex,
      quoteTokenId: market.quote.tokenId,
      spotPairIndex: market.spotPairIndex,
      exchangeOrderAsset: market.exchangeOrderAsset,
      metadataVersion: snapshot.metadataVersion,
      metadataSha256: snapshot.metadataVersion,
      fetchedAt: snapshot.source.fetchedAt,
      expiresAt: snapshot.source.expiresAt,
    }),
    baseSizeDecimals: market.base.sizeDecimals,
    baseWeiDecimals: market.base.weiDecimals,
    quoteWeiDecimals: market.quote.weiDecimals,
  });
}

function parseBalanceEvidence(
  raw: unknown,
  subject: SpotIntentSubmissionSubject,
  observedAtMilliseconds: number,
  tokenDecimals: Readonly<{
    baseSizeDecimals: number;
    baseWeiDecimals: number;
    quoteWeiDecimals: number;
  }>,
): SpotIntentSubmissionEvidence["accountEvidence"]["balance"] {
  const parsed = balancesSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return unavailable();
  }
  const snapshot = parsed.data;
  if (snapshot.source.metadataVersion !== subject.metadataVersion) {
    return stale();
  }
  assertEvidenceWindow(
    observedAtMilliseconds,
    snapshot.source.fetchedAt,
    snapshot.source.expiresAt,
    SPOT_INTENT_SUBMISSION_ACCOUNT_EVIDENCE_LEASE_MILLISECONDS,
    false,
  );
  const seenIndexes = new Set<number>();
  const seenIds = new Set<string>();
  for (const item of snapshot.items) {
    if (
      seenIndexes.has(item.token.tokenIndex) ||
      seenIds.has(item.token.tokenId) ||
      !exactUnsignedDecimalSumEquals(item.total, item.hold, item.available) ||
      !hasAtMostExactUnsignedDecimalPlaces(
        item.total,
        item.token.weiDecimals,
      ) ||
      !hasAtMostExactUnsignedDecimalPlaces(item.hold, item.token.weiDecimals) ||
      !hasAtMostExactUnsignedDecimalPlaces(
        item.available,
        item.token.weiDecimals,
      )
    ) {
      return unavailable();
    }
    seenIndexes.add(item.token.tokenIndex);
    seenIds.add(item.token.tokenId);
  }
  const target =
    subject.side === "buy"
      ? Object.freeze({
          tokenIndex: subject.quoteTokenIndex,
          tokenId: subject.quoteTokenId,
          symbol: subject.quoteDisplayIdentity,
          weiDecimals: tokenDecimals.quoteWeiDecimals,
          required: subject.maximumSpendOrMinimumReceive.value,
        })
      : Object.freeze({
          tokenIndex: subject.baseTokenIndex,
          tokenId: subject.baseTokenId,
          symbol: subject.baseDisplayIdentity,
          weiDecimals: tokenDecimals.baseWeiDecimals,
          required: subject.computedBaseSize,
        });
  const matches = snapshot.items.filter(
    (item) =>
      item.token.tokenIndex === target.tokenIndex ||
      item.token.tokenId === target.tokenId,
  );
  if (matches.length !== 1) {
    return unavailable();
  }
  const item = matches[0]!;
  if (
    item.token.tokenIndex !== target.tokenIndex ||
    item.token.tokenId !== target.tokenId ||
    item.token.symbol !== target.symbol ||
    item.token.weiDecimals !== target.weiDecimals ||
    (subject.side === "sell" &&
      item.token.sizeDecimals !== tokenDecimals.baseSizeDecimals) ||
    !hasAtMostExactUnsignedDecimalPlaces(
      target.required,
      subject.side === "sell"
        ? tokenDecimals.baseSizeDecimals
        : target.weiDecimals,
    )
  ) {
    return unavailable();
  }
  const available = canonicalizeExactUnsignedDecimal(item.available);
  if (
    available === null ||
    compareExactUnsignedDecimals(available, target.required) < 0
  ) {
    return unavailable();
  }
  return Object.freeze({
    dataset: "spotClearinghouseState" as const,
    tokenIndex: target.tokenIndex,
    tokenId: target.tokenId,
    available,
    fetchedAt: snapshot.source.fetchedAt,
    expiresAt: snapshot.source.expiresAt,
  });
}

function parseFeeEvidence(
  raw: unknown,
  subject: SpotIntentSubmissionSubject,
  observedAtMilliseconds: number,
): SpotIntentSubmissionEvidence["accountEvidence"]["fees"] {
  const parsed = feesSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return unavailable();
  }
  assertEvidenceWindow(
    observedAtMilliseconds,
    parsed.data.source.fetchedAt,
    parsed.data.source.expiresAt,
    SPOT_INTENT_SUBMISSION_ACCOUNT_EVIDENCE_LEASE_MILLISECONDS,
    false,
  );
  const currentTakerRate = canonicalizeExactUnsignedDecimal(
    parsed.data.accountSpotTakerRate,
  );
  const reviewedMaximumRate = canonicalizeExactUnsignedDecimal(subject.feeRate);
  if (currentTakerRate === null || reviewedMaximumRate === null) {
    return unavailable();
  }
  if (compareExactUnsignedDecimals(currentTakerRate, reviewedMaximumRate) > 0) {
    return stale();
  }
  return Object.freeze({
    dataset: "userFees" as const,
    currentTakerRate,
    fetchedAt: parsed.data.source.fetchedAt,
    expiresAt: parsed.data.source.expiresAt,
  });
}

function parsePolicyEvidence(
  raw: unknown,
  subject: SpotIntentSubmissionSubject,
  observedAtMilliseconds: number,
): SpotIntentSubmissionEvidence["policyEvidence"] {
  const parsed = policyEvidenceSchema.safeParse(raw);
  if (!parsed.success) {
    return unavailable();
  }
  const policy = parsed.data;
  if (
    policy.ownerUserId !== subject.ownerUserId ||
    policy.intentId !== subject.intentId ||
    policy.policyVersion !== subject.policyVersion
  ) {
    return unavailable();
  }
  assertEvidenceWindow(
    observedAtMilliseconds,
    policy.checkedAt,
    policy.expiresAt,
    SPOT_INTENT_SUBMISSION_AUTHORITY_LEASE_MILLISECONDS,
    true,
  );
  return Object.freeze({ ...policy });
}

export function createHyperliquidSpotIntentSubmissionPreflight(
  options: CreateHyperliquidSpotIntentSubmissionPreflightInput,
): SpotIntentSubmissionPreflight {
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 8_000;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > 14_000
  ) {
    return unavailable();
  }
  const createUuid = options.createUuid ?? randomUUID;
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    async prepare(
      rawInput: Parameters<SpotIntentSubmissionPreflight["prepare"]>[0],
    ) {
      const parsed = preflightInputSchema.safeParse(rawInput);
      if (!parsed.success || parsed.data.signal.aborted) {
        return unavailable();
      }
      const input = parsed.data;
      const subject: SpotIntentSubmissionSubject = input.subject;
      if (
        input.ownerUserId !== subject.ownerUserId ||
        input.intentId !== subject.intentId ||
        input.marketId !== subject.marketId ||
        input.expectedReviewSha256 !== subject.reviewSha256
      ) {
        return stale();
      }
      const observedAtMilliseconds = readNow(now);
      const reviewExpiresAt = timestampMilliseconds(subject.expiresAt);
      if (reviewExpiresAt <= observedAtMilliseconds) {
        throw new SpotIntentExpiredError();
      }
      if (
        observedAtMilliseconds + SPOT_INTENT_SUBMISSION_ATTEMPT_MILLISECONDS >=
        reviewExpiresAt
      ) {
        return stale();
      }

      const deadlineSignal = AbortSignal.any([
        input.signal,
        AbortSignal.timeout(timeoutMilliseconds),
      ]);
      const usedRequestIds = new Set([input.requestId]);
      try {
        const firstAuthority = await resolveAuthority(
          options,
          {
            ownerUserId: input.ownerUserId,
            privyUserId: input.privyUserId,
            requestId: freshUuid(createUuid, usedRequestIds),
            signal: deadlineSignal,
          },
          readNow(now),
        );
        assertAuthorityMatchesSubject(firstAuthority, subject);

        const rawMetadata = await awaitWithAbort(
          options.infoReader.readMetadata({ signal: deadlineSignal }),
          deadlineSignal,
        );
        const metadata = parseMetadataEvidence(
          rawMetadata,
          subject,
          readNow(now),
        );

        const policyRequestId = freshUuid(createUuid, usedRequestIds);
        const [rawBalances, rawFees, rawPolicy] = await awaitWithAbort(
          Promise.all([
            options.infoReader.readBalances({
              accountAddress: firstAuthority.accountAddress,
              signal: deadlineSignal,
            }),
            options.infoReader.readUserFees({
              accountAddress: firstAuthority.accountAddress,
              signal: deadlineSignal,
            }),
            options.policyGate.evaluate({
              subject,
              requestId: policyRequestId,
              signal: deadlineSignal,
            }),
          ]),
          deadlineSignal,
        );
        const accountObservedAt = readNow(now);
        const balance = parseBalanceEvidence(
          rawBalances,
          subject,
          accountObservedAt,
          metadata,
        );
        const fees = parseFeeEvidence(rawFees, subject, accountObservedAt);
        const policyEvidence = parsePolicyEvidence(
          rawPolicy,
          subject,
          accountObservedAt,
        );

        const currentAuthority = await resolveAuthority(
          options,
          {
            ownerUserId: input.ownerUserId,
            privyUserId: input.privyUserId,
            requestId: freshUuid(createUuid, usedRequestIds),
            signal: deadlineSignal,
          },
          readNow(now),
        );
        if (!sameSpotIntentPrepareAuthority(firstAuthority, currentAuthority)) {
          return stale();
        }
        assertAuthorityMatchesSubject(currentAuthority, subject);
        assertEvidenceWindow(
          readNow(now),
          currentAuthority.verifiedAt,
          currentAuthority.expiresAt,
          SPOT_INTENT_SUBMISSION_AUTHORITY_LEASE_MILLISECONDS,
          true,
        );

        return Object.freeze({
          walletEvidence: Object.freeze({
            ownerUserId: currentAuthority.ownerUserId,
            privyUserId: currentAuthority.privyUserId,
            walletId: currentAuthority.walletId,
            accountAddress: currentAuthority.accountAddress,
            accountKind: currentAuthority.accountKind,
            bindingVersion: currentAuthority.bindingVersion,
            verifiedAt: currentAuthority.verifiedAt,
            expiresAt: currentAuthority.expiresAt,
          }),
          marketEvidence: metadata.marketEvidence,
          accountEvidence: Object.freeze({
            provider: "hyperliquid" as const,
            network: "testnet" as const,
            accountAddress: currentAuthority.accountAddress,
            metadataVersion: subject.metadataVersion,
            balance,
            fees,
          }),
          policyEvidence,
        } satisfies SpotIntentSubmissionEvidence);
      } catch (error) {
        if (
          error instanceof SpotIntentExpiredError ||
          error instanceof SpotIntentStaleError ||
          error instanceof SpotWalletBindingRequiredError
        ) {
          throw error;
        }
        return unavailable();
      }
    },
  });
}
