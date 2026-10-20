/**
 * Decision 0154 / 0164: the MEME / launch token's identity text — the name
 * **and the ticker (code)**, one rule for both — accepts any language or
 * script: Chinese, English, mixed, kana, Hangul, emoji, spaces inside, `$`,
 * lower case, a leading digit. Decision 0164 (S243, loop-contracts Decision
 * 0016) aligns it with four.meme: after NFC and `trim()`, **1–20 UTF-16
 * units** (JavaScript `string.length`), never upper-cased, never required
 * to be unique. What stays refused is not a language but a hazard:
 *
 * - control characters (`\p{Cc}`), surrogates, line / paragraph separators
 *   and format characters (`\p{Cf}`, which include the bidi overrides used
 *   for spoofing), except the zero-width joiner U+200D (only between two
 *   characters) and the emoji tag characters U+E0020–U+E007F that emoji
 *   sequences such as 👨‍👩‍👧 and 🏴󠁧󠁢󠁳󠁣󠁴󠁿 need;
 * - every space but U+0020 and the ideographic U+3000 (NBSP, U+2000–200A,
 *   …), the invisible fillers and variation selectors the factory's
 *   `LaunchText` floor refuses (U+034F, U+115F/1160, U+17B4/17B5,
 *   U+180B–180F, U+2800, U+3164, U+FFA0) and the noncharacters
 *   U+FDD0–FDEF / U+xFFFE–xFFFF — so whatever passes here also passes the
 *   factory;
 * - leading / trailing whitespace (trimmed, never stored);
 * - non-NFC spellings (normalised to NFC, so one visible text has one byte
 *   sequence, one config hash and one signed request);
 * - Decision 0168 (S255 audit L-6), product rules the factory floor does
 *   not have: text with no visible character (at least one of
 *   `[\p{L}\p{N}\p{S}\p{P}]` is required — `TEXT_NOT_VISIBLE`), a tag
 *   character U+E0020–U+E007F outside a 🏴 (U+1F3F4) … U+E007F flag
 *   sequence (`TAG_OUTSIDE_FLAG`), and a leading combining mark `\p{M}`
 *   (variation selectors included — `LEADING_COMBINING_MARK`).
 *
 * 20 UTF-16 units are at most 60 UTF-8 bytes (a BMP unit is ≤ 3 bytes, a
 * surrogate pair 4), inside the factory's 80-byte floor
 * (`MAX_NAME_BYTES` / `MAX_TICKER_BYTES`), which is checked last anyway.
 */
export const launchTokenTextMaxUtf16Units = 20;
/** The S242 factories' on-chain floor for both name and ticker. */
export const launchTokenTextMaxUtf8Bytes = 80;
/** Raw (untrimmed) request bound; the rule applies after trimming. */
export const launchTokenTextMaxRawLength = 256;
export const launchTokenDescriptionMaxCodePoints = 2_000;
/** Human-readable rule for route schemas (a regex cannot express it). */
export const launchTokenTextRuleDescription =
  "Decision 0164 (four.meme rule, same for name and ticker): any language or script (Chinese, Japanese, Korean, emoji, mixed, spaces inside, `$`, lower case, leading digit); NFC-normalised and trimmed, then 1–20 UTF-16 code units (JavaScript string length) and at most 80 UTF-8 bytes; never upper-cased and not unique. Decision 0168: must contain at least one visible letter, digit, symbol or punctuation character (detailsSafe.reasonCode TEXT_NOT_VISIBLE), tag characters only inside a 🏴 flag sequence (TAG_OUTSIDE_FLAG), and must not start with a combining mark or variation selector (LEADING_COMBINING_MARK); these three refusals answer 400 INVALID_REQUEST with detailsSafe { reasonCode, field } on /v2/launch routes. Refused: control, bidi-override and other format characters (except the emoji zero-width joiner between characters and the emoji tag characters), line / paragraph separators, spaces other than U+0020 / U+3000, invisible fillers and noncharacters.";

const forbiddenFormatCharacters = /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
// U+200D zero-width joiner, U+E0020–U+E007F emoji tag characters.
const allowedFormatCharacters = /[\u200d\u{e0020}-\u{e007f}]/gu;
const controlCharacters = /\p{Cc}/u;
// Every control character but the line feed and the tab.
const controlCharactersExceptLayout = /(?![\n\t])\p{Cc}/u;
// Decision 0164: what the factory's `LaunchText` floor refuses outside the
// categories above — spaces other than U+0020 / U+3000, invisible fillers,
// variation-selector-like marks, the braille blank and noncharacters.
const otherSpaces = /(?![ \u3000])\p{Zs}/u;
const forbiddenIdentityCodePoints: ReadonlySet<number> = new Set([
  0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180c, 0x180d, 0x180e,
  0x180f, 0x2800, 0x3164, 0xffa0,
  // Unassigned inside the factory's refused U+205F–U+206F block.
  0x2065,
]);

function hasForbiddenIdentityCharacter(value: string): boolean {
  if (otherSpaces.test(value)) return true;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      forbiddenIdentityCodePoints.has(codePoint) ||
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      // U+xFFFE / U+xFFFF of every plane.
      (codePoint & 0xfffe) === 0xfffe
    ) {
      return true;
    }
  }
  return false;
}

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

/**
 * Decision 0168 (S255 audit L-6): why an otherwise valid name / ticker is
 * refused for not being visibly anything.
 */
export const launchTokenTextReasonCodes = Object.freeze({
  /** No `[\p{L}\p{N}\p{S}\p{P}]` character at all. */
  notVisible: "TEXT_NOT_VISIBLE",
  /** A tag character U+E0020–U+E007F outside a 🏴 … U+E007F flag. */
  tagOutsideFlag: "TAG_OUTSIDE_FLAG",
  /** Starts with a combining mark `\p{M}` (variation selectors too). */
  leadingCombiningMark: "LEADING_COMBINING_MARK",
} as const);
export type LaunchTokenTextReasonCode =
  (typeof launchTokenTextReasonCodes)[keyof typeof launchTokenTextReasonCodes];

const visibleCharacter = /[\p{L}\p{N}\p{S}\p{P}]/u;
// A subdivision flag: U+1F3F4 WAVING BLACK FLAG, one or more tag
// characters U+E0020–U+E007E, then U+E007F CANCEL TAG.
const tagFlagSequence = /\u{1f3f4}[\u{e0020}-\u{e007e}]+\u{e007f}/gu;
const tagCharacter = /[\u{e0020}-\u{e007f}]/u;
const leadingCombiningMark = /^\p{M}/u;

/**
 * Decision 0168: the visibility rule on a canonical value, or `null` when it
 * holds. Checked in this order, so an all-invisible text always reports
 * `TEXT_NOT_VISIBLE`.
 */
export function launchTokenTextVisibilityViolation(
  value: string,
): LaunchTokenTextReasonCode | null {
  if (!visibleCharacter.test(value))
    return launchTokenTextReasonCodes.notVisible;
  if (tagCharacter.test(value.replace(tagFlagSequence, "\u{1f3f4}"))) {
    return launchTokenTextReasonCodes.tagOutsideFlag;
  }
  if (leadingCombiningMark.test(value)) {
    return launchTokenTextReasonCodes.leadingCombiningMark;
  }
  return null;
}

/**
 * The factory's `LaunchText` floor as mirrored here (no product length):
 * no control / format / separator / filler character, a zero-width joiner
 * only between two characters, no leading / trailing whitespace, NFC, 1–80
 * UTF-8 bytes.
 */
function isFloorIdentityText(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= maximumRawLength &&
    value === value.normalize("NFC") &&
    value === value.trim() &&
    !value.startsWith("\u200d") &&
    !value.endsWith("\u200d") &&
    !controlCharacters.test(value) &&
    !hasForbiddenFormat(value) &&
    !hasForbiddenIdentityCharacter(value) &&
    utf8ByteLength(value) <= launchTokenTextMaxUtf8Bytes
  );
}

/** The floor plus the Decision 0168 visibility rule. */
function isCanonicalIdentityText(value: string): boolean {
  return (
    isFloorIdentityText(value) &&
    launchTokenTextVisibilityViolation(value) === null
  );
}

/**
 * Decision 0164: the NFC, trimmed name or ticker, or `null` when it breaks a
 * rule above (including the 1–20 UTF-16 unit product length). The one
 * function for both fields of every entry (launch project, Hooks config
 * draft, MEME create).
 */
export function normalizeLaunchTokenText(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > maximumRawLength) return null;
  const value = raw.normalize("NFC").trim();
  if (
    value.length > launchTokenTextMaxUtf16Units ||
    !isCanonicalIdentityText(value)
  ) {
    return null;
  }
  return value;
}

/**
 * Decision 0168: the `detailsSafe.reasonCode` for a refused name / ticker —
 * a visibility code when the text passes every other rule (floor and 1–20
 * UTF-16 units) and only the visibility rule refuses it, else `null` (a
 * plain invalid request, as before). Only meaningful when
 * `normalizeLaunchTokenText(raw)` returned `null`.
 */
export function launchTokenTextRejectionReason(
  raw: unknown,
): LaunchTokenTextReasonCode | null {
  if (typeof raw !== "string" || raw.length > maximumRawLength) return null;
  const value = raw.normalize("NFC").trim();
  if (
    value.length > launchTokenTextMaxUtf16Units ||
    !isFloorIdentityText(value)
  ) {
    return null;
  }
  return launchTokenTextVisibilityViolation(value);
}

/** Decision 0164: the name and the ticker share one rule. */
export const normalizeLaunchTokenName = normalizeLaunchTokenText;
export const normalizeLaunchTokenTicker = normalizeLaunchTokenText;

/**
 * Decision 0164: whether an already-stored / already-signed name or ticker
 * is byte-for-byte what the factory will accept — canonical (NFC, trimmed,
 * character rule, and since Decision 0168 the visibility rule, so a draft
 * stored before 0168 with invisible-only text can no longer be signed or
 * submitted) and 1–80 UTF-8 bytes — without the 20-unit product
 * length, so a draft saved under the Decision 0154 rule (≤ 64 characters
 * and bytes) can still be reviewed, signed and submitted. Values are
 * compared as they are: never upper-cased (`symbol()` returns the signed
 * bytes unchanged).
 */
export function isOnChainLaunchTokenText(value: unknown): value is string {
  return typeof value === "string" && isCanonicalIdentityText(value);
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
