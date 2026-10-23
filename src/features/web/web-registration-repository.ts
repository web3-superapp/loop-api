/**
 * Decision 0179: read side of the web registration surface. Writes go
 * through the existing account (`InternalUserRepository`), profile, and
 * referral services; this boundary only projects what the website shows.
 */

export interface WebAccountSummary {
  readonly loopId: string;
  /** `user_profiles.alias` of an active profile; null while pending. */
  readonly username: string | null;
  /** V2 profile activation time; null while the profile is pending. */
  readonly activatedAt: string | null;
  /**
   * The account's wallet from LOOP's own inventory (Decision 0033): the
   * selected wallet, else the earliest active one; null when none is known.
   */
  readonly walletAddress: string | null;
  /** A depth-1 referral edge exists (bound once, ever). */
  readonly inviteBound: boolean;
}

export interface WebInviter {
  readonly userId: string;
  readonly loopId: string;
  /** Alias of an active profile; null otherwise. */
  readonly username: string | null;
}

export interface WebRegistrationRepository {
  /** Null only when the account does not exist. */
  getAccountSummary(userId: string): Promise<WebAccountSummary | null>;
  /** The owner of a canonical invite code; null when no account owns it. */
  findInviterByCode(code: string): Promise<WebInviter | null>;
  /** The direct (depth 1) inviter of `inviteeUserId`; null when unbound. */
  getDirectInviter(inviteeUserId: string): Promise<WebInviter | null>;
}

export class WebRegistrationRepositoryUnavailableError extends Error {
  readonly code = "web_registration_repository_unavailable";

  constructor(options?: { readonly cause?: unknown }) {
    super("The web registration repository is unavailable", options);
    this.name = "WebRegistrationRepositoryUnavailableError";
  }
}

export function createUnavailableWebRegistrationRepository(): WebRegistrationRepository {
  const unavailable = (): Promise<never> =>
    Promise.reject(new WebRegistrationRepositoryUnavailableError());
  return Object.freeze({
    getAccountSummary: unavailable,
    findInviterByCode: unavailable,
    getDirectInviter: unavailable,
  });
}
