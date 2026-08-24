import { z } from "zod";

const serviceVersion = "0.1.0";

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const positiveIntegerString = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  HOST: z.string().trim().min(1).max(255),
  PORT: positiveIntegerString(1, 65_535),
  PUBLIC_BASE_URL: z.string().url(),
  API_DOCS_ENABLED: booleanString,
  TRUST_PROXY: booleanString,
  LOG_LEVEL: z.enum([
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
  ]),
  DATABASE_URL: z.string().trim().min(1),
  DATABASE_POOL_MAX: positiveIntegerString(1, 50),
  DATABASE_CONNECTION_TIMEOUT_MS: positiveIntegerString(250, 30_000),
  DATABASE_STATEMENT_TIMEOUT_MS: positiveIntegerString(250, 60_000),
});

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly publicBaseUrl: string;
  readonly apiDocsEnabled: boolean;
  readonly trustProxy: boolean;
  readonly logLevel:
    "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly databaseStatementTimeoutMs: number;
  readonly serviceName: "loop-api";
  readonly serviceVersion: string;
}

export class ConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid LOOP API configuration: ${issues.join("; ")}`);
    this.name = "ConfigurationError";
  }
}

function parseUrl(fieldName: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new ConfigurationError([`${fieldName}: must be a valid URL`]);
  }
}

function assertPublicBaseUrl(nodeEnv: AppConfig["nodeEnv"], url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError([
      "PUBLIC_BASE_URL: protocol must be http or https",
    ]);
  }

  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError([
      "PUBLIC_BASE_URL: credentials are not allowed",
    ]);
  }

  if (nodeEnv === "production" && url.protocol !== "https:") {
    throw new ConfigurationError([
      "PUBLIC_BASE_URL: production requires https",
    ]);
  }
}

function assertDatabaseUrl(url: URL): void {
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigurationError([
      "DATABASE_URL: protocol must be postgres or postgresql",
    ]);
  }

  if (url.hostname === "" || url.username === "" || url.pathname.length <= 1) {
    throw new ConfigurationError([
      "DATABASE_URL: host, user, and database name are required",
    ]);
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const rawNodeEnv = environment["NODE_ENV"] ?? "development";
  const parsed = environmentSchema.safeParse({
    NODE_ENV: rawNodeEnv,
    HOST: environment["HOST"] ?? "127.0.0.1",
    PORT: environment["PORT"] ?? "3000",
    PUBLIC_BASE_URL: environment["PUBLIC_BASE_URL"] ?? "http://127.0.0.1:3000",
    API_DOCS_ENABLED:
      environment["API_DOCS_ENABLED"] ??
      (rawNodeEnv === "production" ? "false" : "true"),
    TRUST_PROXY: environment["TRUST_PROXY"] ?? "false",
    LOG_LEVEL: environment["LOG_LEVEL"] ?? "info",
    DATABASE_URL: environment["DATABASE_URL"],
    DATABASE_POOL_MAX: environment["DATABASE_POOL_MAX"] ?? "10",
    DATABASE_CONNECTION_TIMEOUT_MS:
      environment["DATABASE_CONNECTION_TIMEOUT_MS"] ?? "3000",
    DATABASE_STATEMENT_TIMEOUT_MS:
      environment["DATABASE_STATEMENT_TIMEOUT_MS"] ?? "5000",
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`,
    );
    throw new ConfigurationError(issues);
  }

  const publicBaseUrl = parseUrl(
    "PUBLIC_BASE_URL",
    parsed.data.PUBLIC_BASE_URL,
  );
  const databaseUrl = parseUrl("DATABASE_URL", parsed.data.DATABASE_URL);
  assertPublicBaseUrl(parsed.data.NODE_ENV, publicBaseUrl);
  assertDatabaseUrl(databaseUrl);

  return Object.freeze({
    nodeEnv: parsed.data.NODE_ENV,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    publicBaseUrl: publicBaseUrl.toString(),
    apiDocsEnabled: parsed.data.API_DOCS_ENABLED,
    trustProxy: parsed.data.TRUST_PROXY,
    logLevel: parsed.data.LOG_LEVEL,
    databaseUrl: databaseUrl.toString(),
    databasePoolMax: parsed.data.DATABASE_POOL_MAX,
    databaseConnectionTimeoutMs: parsed.data.DATABASE_CONNECTION_TIMEOUT_MS,
    databaseStatementTimeoutMs: parsed.data.DATABASE_STATEMENT_TIMEOUT_MS,
    serviceName: "loop-api",
    serviceVersion,
  });
}
