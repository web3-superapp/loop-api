import {
  InvalidHooksLaunchDraftError,
  parseHooksLaunchDraft,
  type HooksLaunchDraft,
} from "./hooks-launch-config.js";
import type { HooksLaunchFactoryReader } from "./hooks-launch-deployment.js";

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
 */
export class HooksLaunchProjectConfigUnavailableError extends Error {
  constructor(readonly source: "repository" | "factory" = "repository") {
    super("Hooks config unavailable");
    this.name = "HooksLaunchProjectConfigUnavailableError";
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

export interface HooksLaunchProjectConfigService {
  getDraft(input: {
    readonly ownerUserId: string;
    readonly projectId: string;
  }): Promise<HooksLaunchProjectConfigRecord | null>;
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
  readonly factory: Pick<HooksLaunchFactoryReader, "nftSaleDuration"> | null;
  readonly minimumLeadSeconds: number;
  readonly now?: () => number;
}): HooksLaunchProjectConfigService {
  const now = input.now ?? (() => Math.floor(Date.now() / 1_000));

  function requireRepository(): HooksLaunchProjectConfigRepository {
    if (input.repository === null) {
      throw new HooksLaunchProjectConfigUnavailableError();
    }
    return input.repository;
  }

  return Object.freeze({
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
      const config = parseHooksLaunchDraft(
        request.body as Parameters<typeof parseHooksLaunchDraft>[0],
        {
          nowUnixSeconds: String(now()),
          minimumLeadSeconds: input.minimumLeadSeconds,
          nftSaleDurationSeconds: await hooksLaunchFactorySaleDuration(
            input.factory,
          ),
        },
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
