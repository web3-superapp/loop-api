import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  accountSettingsFixedValues,
  AccountSettingsRepositoryUnavailableError,
  AccountSettingsVersionConflictError,
  type AccountSettingsRepository,
  type AccountSettingsValues,
} from "./account-settings-repository.js";

/**
 * Account-level settings (Decision 0037). `displayCurrency` and `language`
 * are product constants in this step; `reduceMotion` and theme stay on the
 * device. The resource still carries a CAS version so a later mutable field
 * joins the same slot.
 */

export const settingsPolicy = Object.freeze({
  configVersion: "accountSettingsV1",
  fixed: accountSettingsFixedValues,
  /** Local-only preferences the backend deliberately does not store. */
  localOnly: Object.freeze(["reduceMotion", "theme"] as const),
} as const);

export interface SettingsResource {
  readonly settings: AccountSettingsValues;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly policy: typeof settingsPolicy;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface SettingsService {
  get(input: {
    readonly principal: AuthenticatedLoopPrincipal;
  }): Promise<SettingsResource>;
  replace(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly body: unknown;
  }): Promise<SettingsResource>;
}

const maximumRecordVersion = 2_147_483_647;

function parseReplaceBody(body: unknown): {
  readonly expectedVersion: number;
  readonly settings: AccountSettingsValues;
} {
  if (typeof body !== "object" || body === null) {
    throw V2ApiError.invalidRequest();
  }
  const { expectedVersion, settings } = body as Record<string, unknown>;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0 ||
    expectedVersion > maximumRecordVersion ||
    typeof settings !== "object" ||
    settings === null
  ) {
    throw V2ApiError.invalidRequest();
  }
  const { displayCurrency, language } = settings as Record<string, unknown>;
  // Fixed values are read-only: any other value is a validation refusal,
  // never a silent overwrite.
  if (
    displayCurrency !== accountSettingsFixedValues.displayCurrency ||
    language !== accountSettingsFixedValues.language
  ) {
    throw V2ApiError.fromCode("VALIDATION_FAILED");
  }
  return Object.freeze({
    expectedVersion,
    settings: accountSettingsFixedValues,
  });
}

function translate(error: unknown): never {
  if (error instanceof AccountSettingsVersionConflictError) {
    throw V2ApiError.versionConflict();
  }
  if (error instanceof AccountSettingsRepositoryUnavailableError) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error;
}

export function createSettingsService(input: {
  readonly repository: AccountSettingsRepository;
}): SettingsService {
  function project(record: {
    readonly version: number;
    readonly updatedAt: string | null;
    readonly settings: AccountSettingsValues;
  }): SettingsResource {
    return Object.freeze({
      settings: record.settings,
      version: record.version,
      updatedAt: record.updatedAt,
      policy: settingsPolicy,
      contractVersion: v2ContractVersion,
    });
  }
  const service: SettingsService = {
    async get({ principal }) {
      try {
        return project(await input.repository.get(principal.userId));
      } catch (error) {
        return translate(error);
      }
    },
    async replace({ principal, body }) {
      const parsed = parseReplaceBody(body);
      try {
        return project(
          await input.repository.replace({
            ownerUserId: principal.userId,
            expectedVersion: parsed.expectedVersion,
            settings: parsed.settings,
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },
  };
  return Object.freeze(service);
}
