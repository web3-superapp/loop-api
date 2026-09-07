/**
 * Alias reserved-word and blocked-term policy for V2 profile writes
 * (Decision 0030). Character safety and length are validated separately by
 * the profile contract; this module only answers whether a normalized alias
 * impersonates LOOP staff/system identities or contains an operator-blocked
 * term.
 */

export const aliasReservedWords = Object.freeze([
  "loop",
  "admin",
  "official",
  "support",
  "system",
  "mod",
  "moderator",
  "team",
] as const);

export type AliasPolicyVerdict =
  | { readonly status: "allowed" }
  | { readonly status: "reserved" }
  | { readonly status: "blocked" };

export interface AliasPolicy {
  readonly blockedTerms: readonly string[];
  evaluate(alias: string): AliasPolicyVerdict;
}

const reservedWordSet: ReadonlySet<string> = new Set(aliasReservedWords);
const tokenSeparatorPattern = /[^\p{L}\p{N}]+/u;
const digitPattern = /\p{Nd}/gu;
const whitespacePattern = /\s+/gu;

/** NFKC + lower-case + trim + single-space fold; shared by reserved and blocked matching. */
export function normalizeAliasForPolicy(alias: string): string {
  return alias
    .normalize("NFKC")
    .toLowerCase()
    .replace(whitespacePattern, " ")
    .trim();
}

function canSegmentIntoReservedWords(compact: string): boolean {
  if (compact.length === 0) {
    return false;
  }
  const reachable: boolean[] = new Array<boolean>(compact.length + 1).fill(
    false,
  );
  reachable[0] = true;
  for (let end = 1; end <= compact.length; end += 1) {
    for (const word of aliasReservedWords) {
      const start = end - word.length;
      if (
        start >= 0 &&
        reachable[start] === true &&
        compact.slice(start, end) === word
      ) {
        reachable[end] = true;
        break;
      }
    }
  }
  return reachable[compact.length] === true;
}

/**
 * Reserved when, after NFKC/lower-case normalization, any alphanumeric token
 * with digits stripped equals a reserved word (`Admin`, `admin123`,
 * `x_official`, `LOOP Team`), or when the separator-free, digit-free form is
 * a concatenation of reserved words (`loopadmin`, `official-loop`).
 */
export function isReservedAlias(alias: string): boolean {
  const normalized = normalizeAliasForPolicy(alias);
  const tokens = normalized
    .split(tokenSeparatorPattern)
    .map((token) => token.replace(digitPattern, ""))
    .filter((token) => token.length > 0);
  if (tokens.some((token) => reservedWordSet.has(token))) {
    return true;
  }
  return canSegmentIntoReservedWords(tokens.join(""));
}

export function findBlockedTerm(
  alias: string,
  blockedTerms: readonly string[],
): string | null {
  const normalized = normalizeAliasForPolicy(alias);
  const compact = normalized.replace(whitespacePattern, "");
  for (const term of blockedTerms) {
    if (normalized.includes(term) || compact.includes(term)) {
      return term;
    }
  }
  return null;
}

export function createAliasPolicy(input: {
  readonly blockedTerms: readonly string[];
}): AliasPolicy {
  const blockedTerms = Object.freeze(
    [...new Set(input.blockedTerms.map(normalizeAliasForPolicy))].filter(
      (term) => term.length > 0,
    ),
  );
  return Object.freeze({
    blockedTerms,
    evaluate(alias: string): AliasPolicyVerdict {
      if (isReservedAlias(alias)) {
        return { status: "reserved" };
      }
      if (findBlockedTerm(alias, blockedTerms) !== null) {
        return { status: "blocked" };
      }
      return { status: "allowed" };
    },
  });
}
