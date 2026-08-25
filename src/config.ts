import { z } from "zod";

const serviceVersion = "0.1.0";

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const positiveIntegerString = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

const blankStringToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalCredential = (maximumLength: number) =>
  z.preprocess(
    blankStringToUndefined,
    z.string().trim().min(1).max(maximumLength).optional(),
  );

const optionalOpaqueSecret = (minimumLength: number, maximumLength: number) =>
  z.preprocess(
    blankStringToUndefined,
    z.string().min(minimumLength).max(maximumLength).optional(),
  );

const environmentSchema = z
  .object({
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
    PRIVY_APP_ID: optionalCredential(255),
    PRIVY_APP_SECRET: optionalCredential(4_096),
    STREAM_API_KEY: optionalCredential(255),
    STREAM_API_SECRET: optionalOpaqueSecret(1, 4_096),
    STREAM_TOKEN_QUOTA_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    STREAM_TOKEN_USER_LIMIT_PER_MINUTE: positiveIntegerString(1, 10_000),
    STREAM_TOKEN_IP_LIMIT_PER_MINUTE: positiveIntegerString(1, 100_000),
    PERP_READ_CURSOR_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    HYPERLIQUID_PRIVATE_READS_ENABLED: booleanString,
    HYPERLIQUID_INFO_QUOTA_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE: positiveIntegerString(1, 1_200),
    DATABASE_URL: z.string().trim().min(1),
    DATABASE_POOL_MAX: positiveIntegerString(1, 50),
    DATABASE_CONNECTION_TIMEOUT_MS: positiveIntegerString(250, 30_000),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveIntegerString(250, 60_000),
  })
  .superRefine((value, context) => {
    const hasAppId = value.PRIVY_APP_ID !== undefined;
    const hasAppSecret = value.PRIVY_APP_SECRET !== undefined;

    if (hasAppId !== hasAppSecret) {
      context.addIssue({
        code: "custom",
        message:
          "PRIVY_APP_ID and PRIVY_APP_SECRET must be configured together",
        path: ["PRIVY_APP_ID"],
      });
    }

    const hasStreamApiKey = value.STREAM_API_KEY !== undefined;
    const hasStreamApiSecret = value.STREAM_API_SECRET !== undefined;

    if (hasStreamApiKey !== hasStreamApiSecret) {
      context.addIssue({
        code: "custom",
        message:
          "STREAM_API_KEY and STREAM_API_SECRET must be configured together",
        path: ["STREAM_API_KEY"],
      });
    }

    if (value.HYPERLIQUID_PRIVATE_READS_ENABLED) {
      if (!hasAppId || !hasAppSecret) {
        context.addIssue({
          code: "custom",
          message:
            "Hyperliquid private reads require configured Privy credentials",
          path: ["HYPERLIQUID_PRIVATE_READS_ENABLED"],
        });
      }
      if (value.PERP_READ_CURSOR_HMAC_SECRET === undefined) {
        context.addIssue({
          code: "custom",
          message:
            "Hyperliquid private reads require PERP_READ_CURSOR_HMAC_SECRET",
          path: ["PERP_READ_CURSOR_HMAC_SECRET"],
        });
      }
      if (value.HYPERLIQUID_INFO_QUOTA_HMAC_SECRET === undefined) {
        context.addIssue({
          code: "custom",
          message:
            "Hyperliquid private reads require HYPERLIQUID_INFO_QUOTA_HMAC_SECRET",
          path: ["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"],
        });
      }
    }
  });

export interface PrivyConfig {
  readonly appId: string;
  readonly appSecret: string;
}

export interface StreamConfig {
  readonly apiKey: string;
  readonly apiSecret: string;
}

export interface StreamTokenQuotaConfig {
  readonly hmacSecret: string;
  readonly policyVersion: "stream_token_v1";
  readonly windowDurationSeconds: 60;
  readonly userCapacity: number;
  readonly ipCapacity: number;
}

export interface PerpReadCursorConfig {
  readonly hmacSecret: string;
  readonly ttlSeconds: 600;
}

export interface HyperliquidPrivateReadsConfig {
  readonly quotaHmacSecret: string;
  readonly policyVersion: "hyperliquid_info_v1";
  readonly windowDurationSeconds: 60;
  readonly weightCapacity: number;
}

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
  readonly privy: PrivyConfig | null;
  readonly stream: StreamConfig | null;
  readonly streamTokenQuota: StreamTokenQuotaConfig | null;
  readonly perpReadCursor: PerpReadCursorConfig | null;
  readonly hyperliquidPrivateReads: HyperliquidPrivateReadsConfig | null;
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
    PRIVY_APP_ID: environment["PRIVY_APP_ID"],
    PRIVY_APP_SECRET: environment["PRIVY_APP_SECRET"],
    STREAM_API_KEY: environment["STREAM_API_KEY"],
    STREAM_API_SECRET: environment["STREAM_API_SECRET"],
    STREAM_TOKEN_QUOTA_HMAC_SECRET:
      environment["STREAM_TOKEN_QUOTA_HMAC_SECRET"],
    STREAM_TOKEN_USER_LIMIT_PER_MINUTE:
      environment["STREAM_TOKEN_USER_LIMIT_PER_MINUTE"] ?? "10",
    STREAM_TOKEN_IP_LIMIT_PER_MINUTE:
      environment["STREAM_TOKEN_IP_LIMIT_PER_MINUTE"] ?? "60",
    PERP_READ_CURSOR_HMAC_SECRET: environment["PERP_READ_CURSOR_HMAC_SECRET"],
    HYPERLIQUID_PRIVATE_READS_ENABLED:
      environment["HYPERLIQUID_PRIVATE_READS_ENABLED"] ?? "false",
    HYPERLIQUID_INFO_QUOTA_HMAC_SECRET:
      environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"],
    HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE:
      environment["HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE"] ?? "960",
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
  const privy =
    parsed.data.PRIVY_APP_ID !== undefined &&
    parsed.data.PRIVY_APP_SECRET !== undefined
      ? Object.freeze({
          appId: parsed.data.PRIVY_APP_ID,
          appSecret: parsed.data.PRIVY_APP_SECRET,
        })
      : null;
  const stream =
    parsed.data.STREAM_API_KEY !== undefined &&
    parsed.data.STREAM_API_SECRET !== undefined
      ? Object.freeze({
          apiKey: parsed.data.STREAM_API_KEY,
          apiSecret: parsed.data.STREAM_API_SECRET,
        })
      : null;
  const streamTokenQuota =
    parsed.data.STREAM_TOKEN_QUOTA_HMAC_SECRET === undefined
      ? null
      : Object.freeze({
          hmacSecret: parsed.data.STREAM_TOKEN_QUOTA_HMAC_SECRET,
          policyVersion: "stream_token_v1" as const,
          windowDurationSeconds: 60 as const,
          userCapacity: parsed.data.STREAM_TOKEN_USER_LIMIT_PER_MINUTE,
          ipCapacity: parsed.data.STREAM_TOKEN_IP_LIMIT_PER_MINUTE,
        });
  const perpReadCursor =
    parsed.data.PERP_READ_CURSOR_HMAC_SECRET === undefined
      ? null
      : Object.freeze({
          hmacSecret: parsed.data.PERP_READ_CURSOR_HMAC_SECRET,
          ttlSeconds: 600 as const,
        });
  let hyperliquidPrivateReads: HyperliquidPrivateReadsConfig | null = null;
  if (parsed.data.HYPERLIQUID_PRIVATE_READS_ENABLED) {
    const quotaHmacSecret = parsed.data.HYPERLIQUID_INFO_QUOTA_HMAC_SECRET;
    if (quotaHmacSecret === undefined) {
      throw new ConfigurationError([
        "HYPERLIQUID_INFO_QUOTA_HMAC_SECRET: required when private reads are enabled",
      ]);
    }
    hyperliquidPrivateReads = Object.freeze({
      quotaHmacSecret,
      policyVersion: "hyperliquid_info_v1",
      windowDurationSeconds: 60,
      weightCapacity: parsed.data.HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE,
    });
  }

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
    privy,
    stream,
    streamTokenQuota,
    perpReadCursor,
    hyperliquidPrivateReads,
    serviceName: "loop-api",
    serviceVersion,
  });
}
