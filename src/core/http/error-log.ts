/**
 * Operator-only summary of an unexpected error (Decision 0082): the class
 * name, a redacted and bounded message, and the first stack frames. It goes
 * to the server log at error level and never into a response body.
 *
 * Redaction removes what a Provider error message can carry that must not
 * reach a log line: URL paths and query strings (RPC keys often live there),
 * credentials in URL userinfo, bearer tokens, `key=`/`token=` style pairs,
 * and full EVM addresses or long hex payloads.
 */

export interface ErrorLogSummary {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly errorStack: readonly string[];
}

export const errorLogStackFrameLimit = 10;
const errorLogMessageLimit = 600;

const urlPattern =
  /\b([a-z][a-z0-9+.-]*):\/\/(?:[^\s/@]*@)?([^\s/?#"'<>]+)[^\s"'<>]*/gi;
const bearerPattern = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;
const secretPairPattern =
  /\b((?:api[_-]?key|apikey|key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi;
const longHexPattern = /\b0x[0-9a-fA-F]{40,}\b/g;

export function redactErrorText(text: string): string {
  const redacted = text
    .replace(urlPattern, (match: string, scheme: string, host: string) =>
      // Source locations in stack frames are kept as they are.
      scheme.toLowerCase() === "file"
        ? match
        : `${scheme}://${host}/[redacted]`,
    )
    .replace(bearerPattern, "Bearer [redacted]")
    .replace(secretPairPattern, "$1[redacted]")
    .replace(longHexPattern, "0x[redacted]");
  return redacted.length > errorLogMessageLimit
    ? `${redacted.slice(0, errorLogMessageLimit)}…`
    : redacted;
}

export function summarizeErrorForLog(error: unknown): ErrorLogSummary {
  if (!(error instanceof Error)) {
    return Object.freeze({
      errorName: typeof error,
      errorMessage: "",
      errorStack: Object.freeze([]),
    });
  }
  const frames = (error.stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, errorLogStackFrameLimit)
    .map((line) => redactErrorText(line));
  return Object.freeze({
    errorName: error.name,
    errorMessage: redactErrorText(error.message),
    errorStack: Object.freeze(frames),
  });
}
