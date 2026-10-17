/**
 * Decision 0154: the MEME / launch token's free-text identity (name and
 * description) accepts any language or script — Chinese, English, mixed,
 * emoji. What stays refused is not a language but a hazard:
 *
 * - control characters (`\p{Cc}`; the description keeps `\n` and `\t`),
 *   surrogates, line / paragraph separators and format characters
 *   (`\p{Cf}`, which include the bidi overrides used for spoofing), except
 *   the zero-width joiner and the emoji tag characters that emoji sequences
 *   such as 👨‍👩‍👧 and 🏴󠁧󠁢󠁳󠁣󠁴󠁿 need;
 * - leading / trailing whitespace (trimmed, never stored);
 * - non-NFC spellings (normalised to NFC, so one visible name has one
 *   byte sequence, one config hash and one signed request).
 *
 * Lengths count Unicode characters (code points). The name has a second,
 * on-chain bound: `LoopLaunchFactoryCore._validateRequest` reverts when
 * `bytes(name).length > 64`, and UTF-8 spends 1 byte on ASCII, 3 on a CJK
 * character and 4 on an emoji, so a name is at most 64 characters **and**
 * at most 64 UTF-8 bytes — 64 English letters, 21 Chinese characters or
 * 16 emoji.
 *
 * The ticker is not free text: the deployed factories accept only
 * `^[A-Z0-9]{2,12}$` (`_validTicker`), so it stays on that pattern until a
 * redeployed factory says otherwise.
 */
export const launchTokenNameMaxCodePoints = 64;
export const launchTokenNameMaxUtf8Bytes = 64;
export const launchTokenDescriptionMaxCodePoints = 2_000;

const forbiddenFormatCharacters = /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
// U+200D zero-width joiner, U+E0020–U+E007F emoji tag characters.
const allowedFormatCharacters = /[\u200d\u{e0020}-\u{e007f}]/gu;
const controlCharacters = /\p{Cc}/u;
// Every control character but the line feed and the tab.
const controlCharactersExceptLayout = /(?![\n\t])\p{Cc}/u;

// Bounds the work done on a hostile input before normalisation.
const maximumRawLength = 16_384;
const utf8 = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return utf8.encode(value).length;
}

function hasForbiddenFormat(value: string): boolean {
  return forbiddenFormatCharacters.test(
    value.replace(allowedFormatCharacters, ""),
  );
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** The NFC, trimmed name, or `null` when it breaks a rule above. */
export function normalizeLaunchTokenName(raw: string): string | null {
  if (raw.length > maximumRawLength) return null;
  const value = raw.normalize("NFC").trim();
  const length = codePointLength(value);
  if (
    length < 1 ||
    length > launchTokenNameMaxCodePoints ||
    utf8ByteLength(value) > launchTokenNameMaxUtf8Bytes ||
    controlCharacters.test(value) ||
    hasForbiddenFormat(value)
  ) {
    return null;
  }
  return value;
}

/**
 * The NFC, trimmed description (CRLF / CR folded to LF), or `null` when it
 * breaks a rule above. An empty result is returned as `""`; callers decide
 * whether empty is allowed.
 */
export function normalizeLaunchTokenDescription(raw: string): string | null {
  if (raw.length > maximumRawLength) return null;
  const value = raw.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (
    codePointLength(value) > launchTokenDescriptionMaxCodePoints ||
    controlCharactersExceptLayout.test(value) ||
    hasForbiddenFormat(value)
  ) {
    return null;
  }
  return value;
}
