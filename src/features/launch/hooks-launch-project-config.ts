import {
  InvalidHooksLaunchDraftError,
  parseHooksLaunchDraft,
  type HooksLaunchDraft,
} from "./hooks-launch-config.js";
import {
  readHooksLaunchFactoryTemplate,
  type HooksLaunchFactoryReader,
} from "./hooks-launch-deployment.js";
import type { HooksLaunchLoopDynamicParams } from "./hooks-launch-config.js";

/** Decision 0132: the reader surface a config save hashes against. */
export type HooksLaunchTemplateFactory = Pick<
  HooksLaunchFactoryReader,
  "nftSaleDuration" | "hookKind" | "loopDynamicTemplate" | "tickerTextRule"
>;

export interface HooksLaunchProjectConfigRecord {
  readonly projectId: string;
  readonly ownerUserId: string;
  readonly version: number;
  readonly templateVersion: string;
  readonly config: HooksLaunchDraft;
  readonly updatedAt: string;
}

export interface SaveHooksLaunchProjectConfigInput {
  readonly projectId: string;
  readonly ownerUserId: string;
  readonly expectedVersion: number;
  readonly templateVersion: string;
  readonly configHash: string;
  readonly config: HooksLaunchDraft;
  readonly updatedByUserId: string;
}

export interface HooksLaunchProjectConfigRepository {
  getOwnedDraft(input: {
    readonly projectId: string;
    readonly ownerUserId: string;
  }): Promise<HooksLaunchProjectConfigRecord | null>;
  saveOwnedDraft(
    input: SaveHooksLaunchProjectConfigInput,
  ): Promise<HooksLaunchProjectConfigRecord>;
  /**
   * Decision 0120: the owner's progress past the draft — when the operator
   * approved `configVersion` with the same configHash (`approvedAt`), and the
   * newest deployment task of the project (any version, any status).
   */
  getOwnedProgress(input: {
    readonly projectId: string;
    readonly ownerUserId: string;
    readonly configVersion: number;
  }): Promise<HooksLaunchProjectProgress>;
}

/** Decision 0122: the review rejection reasons (requirer ruling 7). */
export const hooksLaunchRejectionReasons = Object.freeze([
  "incomplete_materials",
  "name_or_ticker_conflict",
  "buyback_recipient_invalid",
  "community_binding_mismatch",
  "other",
] as const);
export type HooksLaunchRejectionReason =
  (typeof hooksLaunchRejectionReasons)[number];

/** Decision 0122: what the applicant sees of a reviewer rejection. */
export interface HooksLaunchRejection {
  readonly reasonCode: HooksLaunchRejectionReason;
  /** The reviewer's note (required for `other`), shown to the applicant. */
  readonly note: string | null;
  readonly at: string;
}

/** Decision 0120: see `HooksLaunchProjectConfigRepository.getOwnedProgress`. */
export interface HooksLaunchProjectProgress {
  readonly approvedAt: string | null;
  /**
   * Decision 0122: the reviewer rejected this version (same configHash);
   * null otherwise. A version is approved or rejected, never both.
   */
  readonly rejection: HooksLaunchRejection | null;
  readonly latestJobId: string | null;
}

export class HooksLaunchProjectNotFoundError extends Error {
  constructor() {
    super("Hooks launch project not found");
    this.name = "HooksLaunchProjectNotFoundError";
  }
}

export class HooksLaunchProjectVersionConflictError extends Error {
  constructor() {
    super("Hooks launch project config version conflict");
    this.name = "HooksLaunchProjectVersionConflictError";
  }
}

/**
 * Decision 0108: no repository (database not configured) fails closed.
 * Decision 0119: so does a missing / unreadable target Factory (`factory`),
 * because the configHash binds the Factory's `nftSaleDuration()`.
 * Decision 0122: and a missing fixed buyback recipient
 * (`LAUNCH2_BUYBACK_RECIPIENT`, `recipient`).
 */
export class HooksLaunchProjectConfigUnavailableError extends Error {
  constructor(
    readonly source: "repository" | "factory" | "recipient" = "repository",
  ) {
    super("Hooks config unavailable");
    this.name = "HooksLaunchProjectConfigUnavailableError";
  }
}

/**
 * Decision 0122 (requirer ruling 9): the buyback recipient is fixed by the
 * platform (`LAUNCH2_BUYBACK_RECIPIENT`); a config naming another address
 * is refused (422 `HOOKS_BUYBACK_RECIPIENT_FIXED`).
 */
export class HooksLaunchBuybackRecipientFixedError extends Error {
  constructor() {
    super("The buyback recipient is fixed by the platform");
    this.name = "HooksLaunchBuybackRecipientFixedError";
  }
}

/**
 * Decision 0164: the ticker is not on the pre-S242 factories' pattern and
 * the target Factory still enforces it (422 VALIDATION_FAILED,
 * `HOOKS_LAUNCH_TICKER_UNSUPPORTED_BY_FACTORY`, field `ticker`).
 */
export class HooksLaunchTickerUnsupportedByFactoryError extends Error {
  constructor() {
    super("The target launch factory does not support this ticker");
    this.name = "HooksLaunchTickerUnsupportedByFactoryError";
  }
}

/** The pre-S242 factories' `_validTicker` (every such ticker passes S242). */
const legacyFactoryTickerPattern = /^[A-Z0-9]{2,12}$/u;

/**
 * Decision 0164 (transition gate): whether the target Factory accepts
 * `ticker`. A `^[A-Z0-9]{2,12}$` ticker passes every generation without a
 * read; anything else needs a Factory whose on-chain probe answers `utf8`
 * (S242+). A reader without the probe counts as `ascii` (fail closed).
 * Rejects when the probe cannot be read — callers map that to their
 * Factory-unavailable error. Switching the configured Factory to an S242
 * one lifts the gate with no other change.
 */
export async function hooksLaunchFactorySupportsTicker(
  factory: Pick<HooksLaunchFactoryReader, "tickerTextRule"> | null,
  ticker: string,
): Promise<boolean> {
  if (legacyFactoryTickerPattern.test(ticker)) return true;
  if (factory?.tickerTextRule === undefined) return false;
  return (await factory.tickerTextRule()) === "utf8";
}

/**
 * Decision 0164: `hooksLaunchFactorySupportsTicker` for a config save —
 * unsupported throws `HooksLaunchTickerUnsupportedByFactoryError`, an
 * unreadable probe `HooksLaunchProjectConfigUnavailableError("factory")`.
 */
export async function assertHooksLaunchFactorySupportsTicker(
  factory: Pick<HooksLaunchFactoryReader, "tickerTextRule"> | null,
  ticker: string,
): Promise<void> {
  let supported: boolean;
  try {
    supported = await hooksLaunchFactorySupportsTicker(factory, ticker);
  } catch {
    throw new HooksLaunchProjectConfigUnavailableError("factory");
  }
  if (!supported) throw new HooksLaunchTickerUnsupportedByFactoryError();
}

/**
 * Decision 0122: throws `HooksLaunchProjectConfigUnavailableError("recipient")`
 * when no fixed recipient is configured (fail closed) and
 * `HooksLaunchBuybackRecipientFixedError` when `recipient` is another
 * address (case-insensitive).
 */
export function assertHooksLaunchFixedBuybackRecipient(
  fixed: string | null,
  recipient: unknown,
): void {
  if (fixed === null) {
    throw new HooksLaunchProjectConfigUnavailableError("recipient");
  }
  if (
    typeof recipient !== "string" ||
    recipient.toLowerCase() !== fixed.toLowerCase()
  ) {
    throw new HooksLaunchBuybackRecipientFixedError();
  }
}

/**
 * Decision 0119: the target Factory's sale period for a new configHash;
 * no Factory or a failed read is unavailable, never a constant fallback.
 */
export async function hooksLaunchFactorySaleDuration(
  factory: Pick<HooksLaunchFactoryReader, "nftSaleDuration"> | null,
): Promise<number> {
  if (factory === null) {
    throw new HooksLaunchProjectConfigUnavailableError("factory");
  }
  try {
    return (await factory.nftSaleDuration()).seconds;
  } catch {
    throw new HooksLaunchProjectConfigUnavailableError("factory");
  }
}

/**
 * Decision 0132: the hashing policy of a config save for the target
 * Factory — its `nftSaleDuration()` and, for a LoopDynamic Factory, its
 * verified Hook parameters (`parseHooksLaunchDraft({ loopDynamic })`).
 * OfficialTax: `loopDynamic` absent, byte-identical configHash. Any read
 * failure is unavailable, never a fallback.
 */
export async function hooksLaunchFactoryHashPolicy(
  factory: HooksLaunchTemplateFactory | null,
): Promise<{
  readonly nftSaleDurationSeconds: number;
  readonly loopDynamic?: HooksLaunchLoopDynamicParams;
}> {
  const nftSaleDurationSeconds = await hooksLaunchFactorySaleDuration(factory);
  if (factory === null || factory.hookKind !== "loopDynamic") {
    return { nftSaleDurationSeconds };
  }
  try {
    const template = await readHooksLaunchFactoryTemplate(factory);
    if (template.loopDynamic === undefined) throw new Error("no params");
    return { nftSaleDurationSeconds, loopDynamic: template.loopDynamic };
  } catch {
    throw new HooksLaunchProjectConfigUnavailableError("factory");
  }
}

export interface HooksLaunchProjectConfigService {
  /**
   * Decision 0120: HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS — the earliest
   * nftSaleStartAt a save accepts is now + this value.
   */
  readonly minimumLeadSeconds: number;
  /**
   * Decision 0122: `LAUNCH2_BUYBACK_RECIPIENT` (lower-case); null = not
   * configured, every save is unavailable.
   */
  readonly fixedBuybackRecipient: string | null;
  getDraft(input: {
    readonly ownerUserId: string;
    readonly projectId: string;
  }): Promise<HooksLaunchProjectConfigRecord | null>;
  /** Decision 0120: null when there is no draft. */
  getProgress(input: {
    readonly ownerUserId: string;
    readonly projectId: string;
    readonly configVersion: number;
  }): Promise<HooksLaunchProjectProgress>;
  saveDraft(input: {
    readonly ownerUserId: string;
    readonly projectId: string;
    readonly expectedVersion: number;
    readonly body: unknown;
  }): Promise<HooksLaunchProjectConfigRecord>;
}

export function createHooksLaunchProjectConfigService(input: {
  readonly repository: HooksLaunchProjectConfigRepository | null;
  /** The target Factory (Decision 0119); null fails `saveDraft` closed. */
  readonly factory: HooksLaunchTemplateFactory | null;
  readonly minimumLeadSeconds: number;
  /** Decision 0122: `LAUNCH2_BUYBACK_RECIPIENT`; null fails saves closed. */
  readonly fixedBuybackRecipient?: string | null;
  readonly now?: () => number;
}): HooksLaunchProjectConfigService {
  const fixedBuybackRecipient =
    input.fixedBuybackRecipient?.toLowerCase() ?? null;
  const now = input.now ?? (() => Math.floor(Date.now() / 1_000));

  function requireRepository(): HooksLaunchProjectConfigRepository {
    if (input.repository === null) {
      throw new HooksLaunchProjectConfigUnavailableError();
    }
    return input.repository;
  }

  return Object.freeze({
    minimumLeadSeconds: input.minimumLeadSeconds,
    fixedBuybackRecipient,
    async getProgress(request: {
      readonly ownerUserId: string;
      readonly projectId: string;
      readonly configVersion: number;
    }) {
      if (!/^[0-9a-f-]{36}$/i.test(request.projectId)) {
        throw new HooksLaunchProjectNotFoundError();
      }
      return requireRepository().getOwnedProgress({
        projectId: request.projectId,
        ownerUserId: request.ownerUserId,
        configVersion: request.configVersion,
      });
    },
    async getDraft(request: {
      readonly ownerUserId: string;
      readonly projectId: string;
    }) {
      if (!/^[0-9a-f-]{36}$/i.test(request.projectId)) {
        throw new HooksLaunchProjectNotFoundError();
      }
      return requireRepository().getOwnedDraft({
        projectId: request.projectId,
        ownerUserId: request.ownerUserId,
      });
    },
    async saveDraft(request: {
      readonly ownerUserId: string;
      readonly projectId: string;
      readonly expectedVersion: number;
      readonly body: unknown;
    }) {
      if (
        !/^[0-9a-f-]{36}$/i.test(request.projectId) ||
        !Number.isSafeInteger(request.expectedVersion) ||
        request.expectedVersion < 0 ||
        request.expectedVersion > 2_147_483_646
      ) {
        throw new InvalidHooksLaunchDraftError();
      }
      if (typeof request.body !== "object" || request.body === null) {
        throw new InvalidHooksLaunchDraftError();
      }
      // Decision 0122: the recipient is the platform's, never the owner's.
      assertHooksLaunchFixedBuybackRecipient(
        fixedBuybackRecipient,
        (request.body as Record<string, unknown>)["buybackRecipient"],
      );
      const config = parseHooksLaunchDraft(
        request.body as Parameters<typeof parseHooksLaunchDraft>[0],
        {
          nowUnixSeconds: String(now()),
          minimumLeadSeconds: input.minimumLeadSeconds,
          // Decision 0132: + the LoopDynamic Hook parameters, if any.
          ...(await hooksLaunchFactoryHashPolicy(input.factory)),
        },
      );
      // Decision 0164: refuse here, not at the deploy simulation, a ticker
      // the configured (pre-S242) Factory would reject.
      await assertHooksLaunchFactorySupportsTicker(
        input.factory,
        config.ticker,
      );
      return requireRepository().saveOwnedDraft({
        projectId: request.projectId,
        ownerUserId: request.ownerUserId,
        expectedVersion: request.expectedVersion,
        templateVersion: config.templateVersion,
        configHash: config.configHash,
        config,
        updatedByUserId: request.ownerUserId,
      });
    },
  });
}
