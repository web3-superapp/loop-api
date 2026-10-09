/**
 * Account-level settings storage (Decision 0037). The row is a
 * compare-and-swap slot: `version` 0 means no row exists and the fixed
 * defaults apply without a write.
 */

export const accountSettingsFixedValues = Object.freeze({
  displayCurrency: "USD",
  language: "zh-CN",
} as const);

export interface AccountSettingsValues {
  readonly displayCurrency: typeof accountSettingsFixedValues.displayCurrency;
  readonly language: typeof accountSettingsFixedValues.language;
}

export interface AccountSettingsRecord {
  readonly version: number;
  readonly updatedAt: string | null;
  readonly settings: AccountSettingsValues;
}

export interface ReplaceAccountSettingsInput {
  readonly ownerUserId: string;
  readonly expectedVersion: number;
  readonly settings: AccountSettingsValues;
}

export interface AccountSettingsRepository {
  get(ownerUserId: string): Promise<AccountSettingsRecord>;
  /**
   * CAS replacement. `expectedVersion === current` commits version + 1;
   * `expectedVersion === current - 1` with identical content is the
   * lost-response retry and returns the committed record; anything else is
   * `AccountSettingsVersionConflictError`.
   */
  replace(input: ReplaceAccountSettingsInput): Promise<AccountSettingsRecord>;
}

export class AccountSettingsVersionConflictError extends Error {
  constructor() {
    super("The account settings version does not match");
    this.name = "AccountSettingsVersionConflictError";
  }
}

export class AccountSettingsRepositoryUnavailableError extends Error {
  constructor() {
    super("The account settings repository is unavailable");
    this.name = "AccountSettingsRepositoryUnavailableError";
  }
}

export const defaultAccountSettingsRecord: AccountSettingsRecord =
  Object.freeze({
    version: 0,
    updatedAt: null,
    settings: accountSettingsFixedValues,
  });

function unavailable(): Promise<never> {
  return Promise.reject(new AccountSettingsRepositoryUnavailableError());
}

export function createUnavailableAccountSettingsRepository(): AccountSettingsRepository {
  return Object.freeze({ get: unavailable, replace: unavailable });
}
