/**
 * Decision 0138: the creator's saved project profile (the Hooks launch
 * config's `description` / `links`) projected onto launch2 instance rows
 * for the App's launchpad banner and NFT mint page.
 */

/** The raw profile read with the instance; null when no config row joins. */
export interface Launch2ProjectProfile {
  readonly description: string | null;
  readonly links: readonly string[];
}

export const launch2SummaryMaxCharacters = 60;
export const launch2SummaryEllipsis = "…";
export const launch2MaxLinks = 5;
export const launch2MaxLinkLength = 2048;

/**
 * Trim, collapse whitespace runs to one space, keep the first 60 Unicode
 * code points (plus "…" when cut); empty → null.
 */
export function launch2ProjectSummary(
  description: string | null | undefined,
): string | null {
  if (typeof description !== "string") return null;
  const collapsed = description.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return null;
  const characters = Array.from(collapsed);
  if (characters.length <= launch2SummaryMaxCharacters) return collapsed;
  return (
    characters.slice(0, launch2SummaryMaxCharacters).join("").trimEnd() +
    launch2SummaryEllipsis
  );
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > launch2MaxLinkLength) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** The saved links verbatim, http(s) only, at most 5, in saved order. */
export function launch2ProjectLinks(
  links: readonly unknown[] | null | undefined,
): readonly string[] {
  if (!Array.isArray(links)) return Object.freeze([]);
  return Object.freeze(links.filter(isHttpUrl).slice(0, launch2MaxLinks));
}

export function launch2ProjectProfileProjection(
  profile: Launch2ProjectProfile | null | undefined,
): { readonly summary: string | null; readonly links: readonly string[] } {
  return Object.freeze({
    summary: launch2ProjectSummary(profile?.description),
    links: launch2ProjectLinks(profile?.links),
  });
}
