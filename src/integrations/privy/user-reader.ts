export interface ReadPrivyUserInput {
  readonly privyUserId: string;
  readonly signal: AbortSignal;
}

export interface PrivyUserReader {
  readCurrentUser(input: ReadPrivyUserInput): Promise<unknown>;
}

export interface PrivyUsersLookupClient {
  _get(
    privyUserId: string,
    options: {
      readonly signal: AbortSignal;
      readonly timeout: 4_000;
      readonly maxRetries: 0;
    },
  ): Promise<unknown>;
}

export class PrivyUserLookupUnavailableError extends Error {
  constructor() {
    super("Privy current-user lookup is unavailable");
    this.name = "PrivyUserLookupUnavailableError";
  }
}

/**
 * Narrow read-only adapter over Privy's server users API. Error classification
 * remains feature policy; this adapter deliberately preserves SDK errors and
 * the caller's abort signal.
 */
export function createPrivyUserReader(
  users: PrivyUsersLookupClient,
): PrivyUserReader {
  return Object.freeze({
    readCurrentUser(input: ReadPrivyUserInput): Promise<unknown> {
      return users._get(input.privyUserId, {
        signal: input.signal,
        timeout: 4_000,
        maxRetries: 0,
      });
    },
  });
}

export function createUnavailablePrivyUserReader(): PrivyUserReader {
  return Object.freeze({
    readCurrentUser(): Promise<never> {
      return Promise.reject(new PrivyUserLookupUnavailableError());
    },
  });
}
