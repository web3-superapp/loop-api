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
/**
 * Reserved words of at least five letters also match as a token prefix or
 * suffix (`AdminAlice`, `superadmin`, `LoopSupportBot`); the short words
 * `loop`, `team`, and `mod` match only a whole token so `loopy`, `teams`, and
 * `modern` stay allowed.
 */
const affixMinimumLength = 5;
const affixReservedWords = aliasReservedWords.filter(
  (word) => word.length >= affixMinimumLength,
);
const tokenSeparatorPattern = /[^\p{L}\p{N}]+/u;
const digitPattern = /\p{Nd}/gu;
const whitespacePattern = /\s+/gu;
const nonAlphanumericPattern = /[^\p{L}\p{N}]+/gu;

/** NFKC + lower-case with every separator removed; used for blocked-term matching. */
export function compactAliasForPolicy(alias: string): string {
  return normalizeAliasForPolicy(alias).replace(nonAlphanumericPattern, "");
}

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

function hasReservedAffix(token: string): boolean {
  return affixReservedWords.some(
    (word) => token.startsWith(word) || token.endsWith(word),
  );
}

/** Remove one reserved word from the start or end of a token, if any. */
function stripOneReservedAffix(token: string): string {
  for (const word of aliasReservedWords) {
    if (token.length > word.length && token.startsWith(word)) {
      return token.slice(word.length);
    }
    if (token.length > word.length && token.endsWith(word)) {
      return token.slice(0, -word.length);
    }
  }
  return token;
}

/**
 * A token is reserved when it is a reserved word, carries a five-plus-letter
 * reserved word as prefix or suffix, or does so after surrounding reserved
 * words are peeled off one at a time (`loopsupportbot` → `supportbot`).
 */
function tokenIsReserved(token: string): boolean {
  let current = token;
  for (;;) {
    if (reservedWordSet.has(current) || hasReservedAffix(current)) {
      return true;
    }
    const stripped = stripOneReservedAffix(current);
    if (stripped === current) {
      return false;
    }
    current = stripped;
  }
}

/**
 * Reserved when, after NFKC/lower-case normalization, any alphanumeric token
 * with digits stripped equals a reserved word (`Admin`, `admin123`,
 * `x_official`, `LOOP Team`), starts or ends with a reserved word of at least
 * five letters after any surrounding reserved words are stripped
 * (`AdminAlice`, `superadmin`, `LoopSupportBot`), or when the separator-free,
 * digit-free form is a concatenation of reserved words (`loopadmin`,
 * `official-loop`). Short words only match whole tokens or as stripped
 * affixes, so `loopy`, `teams`, `modern`, and `badminton` stay allowed.
 */
export function isReservedAlias(alias: string): boolean {
  const normalized = normalizeAliasForPolicy(alias);
  const tokens = normalized
    .split(tokenSeparatorPattern)
    .map((token) => token.replace(digitPattern, ""))
    .filter((token) => token.length > 0);
  if (tokens.some(tokenIsReserved)) {
    return true;
  }
  return canSegmentIntoReservedWords(tokens.join(""));
}

/**
 * A term matches as a substring of the normalized alias, and also in compact
 * form (both sides NFKC + lower-case with whitespace and every separator
 * removed) so `rug pull` catches `rugpull`, `rug-pull`, and `Rug_Pull`.
 */
export function findBlockedTerm(
  alias: string,
  blockedTerms: readonly string[],
): string | null {
  const normalized = normalizeAliasForPolicy(alias);
  const compact = compactAliasForPolicy(alias);
  for (const term of blockedTerms) {
    const normalizedTerm = normalizeAliasForPolicy(term);
    const compactTerm = compactAliasForPolicy(term);
    if (
      normalizedTerm.length === 0 ||
      normalized.includes(normalizedTerm) ||
      (compactTerm.length > 0 && compact.includes(compactTerm))
    ) {
      return normalizedTerm.length === 0 ? null : term;
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
