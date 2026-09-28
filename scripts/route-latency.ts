import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * Server-side route latency from API logs (Decision 0088).
 *
 * Reads the JSON "Request completed" lines the API writes on every response
 * (`method`, `route` template, `responseTimeMs`; raw pino JSON or the
 * pino-pretty form of the development stack) from one or more log files,
 * or from stdin when no file is named, and prints p50 / p95 / max / count per
 * `METHOD route`, slowest p95 first. ANSI colour codes and any prefix before
 * the JSON object (pino-pretty, launchd timestamps) are ignored; health
 * probes are skipped. Only the route template is read, never a path with
 * IDs, a header, or a body, so the output is safe to paste.
 *
 *   pnpm route-latency ~/Library/Logs/LOOP/api.log
 *   pnpm route-latency --top 40 --route /v2/communities api.log
 *   ssh host 'cat /opt/loop/logs/api.log' | pnpm route-latency
 *
 * The percentile rule matches `ops/route-latency.py` so numbers stay
 * comparable: p50 = sorted[floor(n / 2)], p95 = sorted[max(0, floor(0.95 n) - 1)].
 */

export interface RouteLatencyRow {
  readonly method: string;
  readonly route: string;
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface RouteLatencyOptions {
  /** Keep only routes whose template contains this text. */
  readonly routeFilter?: string;
}

// eslint-disable-next-line no-control-regex
const ansiPattern = /\u001b\[[0-9;]*m/g;

/** One completed request, or `null` for every other line. */
export function parseCompletedRequest(
  line: string,
): { method: string; route: string; responseTimeMs: number } | null {
  const start = line.indexOf("{");
  if (start < 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(start).replace(ansiPattern, "").trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const method = record["method"];
  const route = record["route"];
  const responseTimeMs = record["responseTimeMs"];
  // Raw pino JSON carries `msg`; pino-pretty (the development stack) prints
  // the message before the object instead.
  const message =
    record["msg"] ??
    line.slice(0, start).replace(ansiPattern, "").trim().split(": ").at(-1);
  if (
    message !== "Request completed" ||
    typeof method !== "string" ||
    typeof route !== "string" ||
    typeof responseTimeMs !== "number" ||
    !Number.isFinite(responseTimeMs) ||
    route.startsWith("/health")
  ) {
    return null;
  }
  return { method, route, responseTimeMs };
}

export function summarizeRouteLatency(
  lines: Iterable<string>,
  options: RouteLatencyOptions = {},
): readonly RouteLatencyRow[] {
  const samples = new Map<string, number[]>();
  for (const line of lines) {
    const request = parseCompletedRequest(line);
    if (request === null) {
      continue;
    }
    if (
      options.routeFilter !== undefined &&
      !request.route.includes(options.routeFilter)
    ) {
      continue;
    }
    const key = `${request.method} ${request.route}`;
    const list = samples.get(key);
    if (list === undefined) {
      samples.set(key, [request.responseTimeMs]);
    } else {
      list.push(request.responseTimeMs);
    }
  }
  const rows: RouteLatencyRow[] = [];
  for (const [key, values] of samples) {
    values.sort((left, right) => left - right);
    const count = values.length;
    const separator = key.indexOf(" ");
    rows.push({
      method: key.slice(0, separator),
      route: key.slice(separator + 1),
      count,
      p50Ms: values[Math.floor(count / 2)] ?? 0,
      p95Ms: values[Math.max(0, Math.floor(count * 0.95) - 1)] ?? 0,
      maxMs: values[count - 1] ?? 0,
    });
  }
  return rows.sort(
    (left, right) =>
      right.p95Ms - left.p95Ms ||
      right.p50Ms - left.p50Ms ||
      right.count - left.count,
  );
}

export function formatRouteLatency(
  rows: readonly RouteLatencyRow[],
  top: number,
): string {
  const header = `${"p95ms".padStart(7)} ${"p50ms".padStart(7)} ${"maxms".padStart(7)} ${"n".padStart(5)}  route`;
  const body = rows
    .slice(0, top)
    .map(
      (row) =>
        `${row.p95Ms.toFixed(0).padStart(7)} ${row.p50Ms.toFixed(0).padStart(7)} ${row.maxMs.toFixed(0).padStart(7)} ${String(row.count).padStart(5)}  ${row.method} ${row.route}`,
    );
  return `${[header, ...body].join("\n")}\n`;
}

interface Arguments {
  readonly files: readonly string[];
  readonly top: number;
  readonly routeFilter?: string;
}

export function parseArguments(argv: readonly string[]): Arguments {
  const files: string[] = [];
  let top = 25;
  let routeFilter: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--top") {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError("--top needs a positive integer");
      }
      top = value;
      index += 1;
    } else if (argument === "--route") {
      const value = argv[index + 1];
      if (value === undefined || value === "") {
        throw new RangeError("--route needs a route fragment");
      }
      routeFilter = value;
      index += 1;
    } else {
      files.push(argument);
    }
  }
  return {
    files,
    top,
    ...(routeFilter === undefined ? {} : { routeFilter }),
  };
}

async function readLines(files: readonly string[]): Promise<string[]> {
  const sources =
    files.length === 0
      ? [process.stdin]
      : files.map((file) => createReadStream(file, { encoding: "utf8" }));
  const lines: string[] = [];
  for (const source of sources) {
    for await (const line of createInterface({
      input: source,
      crlfDelay: Number.POSITIVE_INFINITY,
    })) {
      lines.push(line);
    }
  }
  return lines;
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    const rows = summarizeRouteLatency(
      await readLines(parsed.files),
      parsed.routeFilter === undefined
        ? {}
        : { routeFilter: parsed.routeFilter },
    );
    process.stdout.write(formatRouteLatency(rows, parsed.top));
  } catch (error) {
    process.stderr.write(
      `route-latency: ${error instanceof Error ? error.message : "failed"}\n`,
    );
    process.exitCode = 1;
  }
}
