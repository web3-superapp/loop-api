import { ConfigurationError } from "../../config.js";

/**
 * Decision 0168 (S255 audit I-20): the launch token text rule
 * (`launch-token-text.ts`) is a strict subset of the factory's on-chain
 * `LaunchText` floor only when the runtime's Unicode tables are at least
 * Unicode 14 — before that U+0890 / U+0891 are not `\p{Cf}`, so the backend
 * would accept text the factory refuses. Node 24.19 ships Unicode 17.
 */
export const minimumLaunchTextUnicodeMajor = 14;

/**
 * The runtime's Unicode major version, from `process.versions.unicode`, or
 * `null` when absent or unparseable.
 */
export function runtimeUnicodeMajor(
  versions: Readonly<Record<string, string | undefined>>,
): number | null {
  const match = /^(\d+)\./u.exec(versions["unicode"] ?? "");
  return match === null ? null : Number(match[1]);
}

/**
 * Throws a `ConfigurationError` (the process refuses to start) unless the
 * runtime reports Unicode ≥ 14 **and** its regex tables classify U+0890 as
 * a format character.
 */
export function assertLaunchTextUnicodeRuntime(
  versions: Readonly<Record<string, string | undefined>> = process.versions,
  formatProbe: () => boolean = () => /\p{Cf}/u.test("࢐"),
): void {
  const major = runtimeUnicodeMajor(versions);
  if (
    major === null ||
    major < minimumLaunchTextUnicodeMajor ||
    !formatProbe()
  ) {
    throw new ConfigurationError([
      `Node's Unicode tables must be ${minimumLaunchTextUnicodeMajor} or newer for the launch token text rule (found ${versions["unicode"] ?? "unknown"}); run the pinned Node 24.19`,
    ]);
  }
}
