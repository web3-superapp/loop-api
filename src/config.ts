import { z } from "zod";

import { parseDecimalAmount } from "./features/chain/chain-contract.js";
import {
  compareClientVersions,
  isValidClientVersion,
} from "./features/session/client-version.js";

const serviceVersion = "0.1.0";

/**
 * V2 module IDs accepted by V2_MODULES_ENABLED. The order is the registration
 * order used by `registerV2Routes`. Adding an ID requires a numbered decision.
 */
export const v2ModuleIds = Object.freeze([
  "community",
  "communication",
  "search",
  "market",
  "chain",
  "wallet",
  "swap",
  "sendApprovals",
  "launch",
  "mining",
  "notifications",
  "profile",
  "watchlist",
] as const);

export type V2ModuleId = (typeof v2ModuleIds)[number];

const v2ModuleIdSet: ReadonlySet<string> = new Set(v2ModuleIds);
const v2ConfigVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const rfc3339WithOffsetPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

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

/**
 * Market Provider keys shared by the API and worker processes (Decision 0034).
 * DexScreener needs no credential and is on by default; GoPlus needs its key
 * pair; GeckoTerminal stays off until its commercial terms are verified.
 * Throttles can only be lowered below each Provider's documented limit.
 */
const marketEnvironmentShape = {
  MARKET_PROVIDER_DEXSCREENER_ENABLED: booleanString,
  MARKET_PROVIDER_GECKOTERMINAL_ENABLED: booleanString,
  MARKET_DEXSCREENER_RATE_LIMIT_PER_MINUTE: positiveIntegerString(1, 300),
  MARKET_GECKOTERMINAL_RATE_LIMIT_PER_MINUTE: positiveIntegerString(1, 30),
  MARKET_GOPLUS_RATE_LIMIT_PER_MINUTE: positiveIntegerString(1, 300),
  MARKET_PRICE_TTL_SECONDS: positiveIntegerString(5, 3_600),
  MARKET_SECURITY_TTL_SECONDS: positiveIntegerString(60, 86_400),
  MARKET_CANDLES_TTL_SECONDS: positiveIntegerString(15, 3_600),
  MARKET_STALE_GRACE_SECONDS: positiveIntegerString(0, 86_400),
  GOPLUS_APP_KEY: optionalCredential(255),
  GOPLUS_APP_SECRET: optionalOpaqueSecret(1, 4_096),
} as const;

function refineMarketEnvironment(
  value: {
    readonly GOPLUS_APP_KEY?: string | undefined;
    readonly GOPLUS_APP_SECRET?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (
    (value.GOPLUS_APP_KEY !== undefined) !==
    (value.GOPLUS_APP_SECRET !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      message:
        "GOPLUS_APP_KEY and GOPLUS_APP_SECRET must be configured together",
      path: ["GOPLUS_APP_KEY"],
    });
  }
}

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
    V2_SESSION_ENABLED: booleanString,
    V2_MODULES_ENABLED: optionalCredential(1_024),
    V2_CLIENT_POLICY_CONFIG_VERSION: optionalCredential(128),
    V2_CLIENT_POLICY_EFFECTIVE_AT: optionalCredential(64),
    V2_CLIENT_POLICY_MIN_VERSION_IOS: optionalCredential(64),
    V2_CLIENT_POLICY_MIN_VERSION_ANDROID: optionalCredential(64),
    V2_CLIENT_POLICY_STORE_URL_IOS: optionalCredential(2_048),
    V2_CLIENT_POLICY_STORE_URL_ANDROID: optionalCredential(2_048),
    V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_IOS: optionalCredential(64),
    V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_ANDROID: optionalCredential(64),
    V2_TERMS_REQUIRED_VERSION: optionalCredential(128),
    V2_ALIAS_BLOCKED_TERMS: optionalCredential(8_192),
    V2_CURSOR_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    V2_COMMUNITY_CHANNEL_MEMBER_CAP: positiveIntegerString(1, 200_000),
    PRIVY_APP_ID: optionalCredential(255),
    PRIVY_APP_SECRET: optionalCredential(4_096),
    STREAM_API_KEY: optionalCredential(255),
    STREAM_API_SECRET: optionalOpaqueSecret(1, 4_096),
    STREAM_TOKEN_QUOTA_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    STREAM_TOKEN_USER_LIMIT_PER_MINUTE: positiveIntegerString(1, 10_000),
    STREAM_TOKEN_IP_LIMIT_PER_MINUTE: positiveIntegerString(1, 100_000),
    SOCIAL_CURSOR_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    SOCIAL_QUOTA_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    PERP_READ_CURSOR_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    HYPERLIQUID_PRIVATE_READS_ENABLED: booleanString,
    HYPERLIQUID_INFO_QUOTA_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE: positiveIntegerString(1, 1_200),
    BSC_RPC_URLS: optionalCredential(4_096),
    BSC_CONFIRMATIONS: positiveIntegerString(1, 1_000),
    BSC_REORG_DEPTH_BLOCKS: positiveIntegerString(1, 1_000),
    BSC_USD1_TOKEN_ADDRESS: optionalCredential(64),
    BSC_USD1_VERIFIED: booleanString,
    WALLET_GAS_RESERVE_BNB: z.string().trim().min(1).max(32),
    ...marketEnvironmentShape,
    DATABASE_URL: z.string().trim().min(1),
    DATABASE_POOL_MAX: positiveIntegerString(1, 50),
    DATABASE_CONNECTION_TIMEOUT_MS: positiveIntegerString(250, 30_000),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveIntegerString(250, 60_000),
  })
  .superRefine((value, context) => {
    refineMarketEnvironment(value, context);
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

    const hasSocialCursorSecret = value.SOCIAL_CURSOR_HMAC_SECRET !== undefined;
    const hasSocialQuotaSecret = value.SOCIAL_QUOTA_HMAC_SECRET !== undefined;

    if (hasSocialCursorSecret !== hasSocialQuotaSecret) {
      context.addIssue({
        code: "custom",
        message:
          "SOCIAL_CURSOR_HMAC_SECRET and SOCIAL_QUOTA_HMAC_SECRET must be configured together",
        path: ["SOCIAL_CURSOR_HMAC_SECRET"],
      });
    }

    const versionPolicyKeys = [
      "V2_CLIENT_POLICY_MIN_VERSION_IOS",
      "V2_CLIENT_POLICY_MIN_VERSION_ANDROID",
      "V2_CLIENT_POLICY_STORE_URL_IOS",
      "V2_CLIENT_POLICY_STORE_URL_ANDROID",
    ] as const;
    const configuredVersionPolicyKeys = versionPolicyKeys.filter(
      (key) => value[key] !== undefined,
    );
    const versionPolicyConfigured =
      configuredVersionPolicyKeys.length === versionPolicyKeys.length;

    if (configuredVersionPolicyKeys.length > 0 && !versionPolicyConfigured) {
      context.addIssue({
        code: "custom",
        message: `${versionPolicyKeys.join(", ")} must be configured together`,
        path: ["V2_CLIENT_POLICY_MIN_VERSION_IOS"],
      });
    }

    for (const key of [
      "V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_IOS",
      "V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_ANDROID",
    ] as const) {
      if (value[key] !== undefined && !versionPolicyConfigured) {
        context.addIssue({
          code: "custom",
          message: "requires the complete V2 client version policy",
          path: [key],
        });
      }
    }

    const anyGateConfigured =
      configuredVersionPolicyKeys.length > 0 ||
      value.V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_IOS !== undefined ||
      value.V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_ANDROID !== undefined ||
      value.V2_TERMS_REQUIRED_VERSION !== undefined;
    if (
      anyGateConfigured &&
      (value.V2_CLIENT_POLICY_CONFIG_VERSION === undefined ||
        value.V2_CLIENT_POLICY_EFFECTIVE_AT === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "V2_CLIENT_POLICY_CONFIG_VERSION and V2_CLIENT_POLICY_EFFECTIVE_AT are required whenever a client policy gate is configured",
        path: ["V2_CLIENT_POLICY_CONFIG_VERSION"],
      });
    }

    for (const key of [
      "V2_CLIENT_POLICY_MIN_VERSION_IOS",
      "V2_CLIENT_POLICY_MIN_VERSION_ANDROID",
      "V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_IOS",
      "V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_ANDROID",
    ] as const) {
      const candidate = value[key];
      if (candidate !== undefined && !isValidClientVersion(candidate)) {
        context.addIssue({
          code: "custom",
          message: "must be a valid SemVer 2.0 version",
          path: [key],
        });
      }
    }

    if (
      value.V2_CLIENT_POLICY_CONFIG_VERSION !== undefined &&
      !v2ConfigVersionPattern.test(value.V2_CLIENT_POLICY_CONFIG_VERSION)
    ) {
      context.addIssue({
        code: "custom",
        message: "must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        path: ["V2_CLIENT_POLICY_CONFIG_VERSION"],
      });
    }

    if (
      value.V2_CLIENT_POLICY_EFFECTIVE_AT !== undefined &&
      (!rfc3339WithOffsetPattern.test(value.V2_CLIENT_POLICY_EFFECTIVE_AT) ||
        !Number.isFinite(Date.parse(value.V2_CLIENT_POLICY_EFFECTIVE_AT)))
    ) {
      context.addIssue({
        code: "custom",
        message: "must be an RFC 3339 date-time with an explicit timezone",
        path: ["V2_CLIENT_POLICY_EFFECTIVE_AT"],
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

const reconciliationWorkerEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    LOG_LEVEL: z.enum([
      "fatal",
      "error",
      "warn",
      "info",
      "debug",
      "trace",
      "silent",
    ]),
    HYPERLIQUID_RECONCILIATION_READS_ENABLED: booleanString,
    HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED: booleanString,
    SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED: booleanString,
    ISSUANCE_RATE_RECORD_CLEANUP_ENABLED: booleanString,
    COMMUNITY_CHANNEL_SYNC_ENABLED: booleanString,
    STREAM_API_KEY: optionalCredential(255),
    STREAM_API_SECRET: optionalOpaqueSecret(1, 4_096),
    HYPERLIQUID_INFO_QUOTA_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE: positiveIntegerString(1, 1_200),
    BSC_INDEXER_ENABLED: booleanString,
    BSC_INDEXER_START_BLOCK: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    BSC_RPC_URLS: optionalCredential(4_096),
    BSC_CONFIRMATIONS: positiveIntegerString(1, 1_000),
    BSC_REORG_DEPTH_BLOCKS: positiveIntegerString(1, 1_000),
    ALERT_EVALUATOR_ENABLED: booleanString,
    ALERT_NOTIFICATION_DEDUPE_SECONDS: positiveIntegerString(60, 86_400),
    ...marketEnvironmentShape,
    DATABASE_URL: z.string().trim().min(1),
    DATABASE_POOL_MAX: positiveIntegerString(1, 50),
    DATABASE_CONNECTION_TIMEOUT_MS: positiveIntegerString(250, 30_000),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveIntegerString(250, 60_000),
  })
  .superRefine((value, context) => {
    refineMarketEnvironment(value, context);
    if (
      value.ALERT_EVALUATOR_ENABLED &&
      !value.MARKET_PROVIDER_DEXSCREENER_ENABLED
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The alert evaluator lane requires MARKET_PROVIDER_DEXSCREENER_ENABLED",
        path: ["ALERT_EVALUATOR_ENABLED"],
      });
    }
    if (value.BSC_INDEXER_ENABLED && value.BSC_RPC_URLS === undefined) {
      context.addIssue({
        code: "custom",
        message: "The BSC indexer lane requires BSC_RPC_URLS",
        path: ["BSC_INDEXER_ENABLED"],
      });
    }
    if (
      value.HYPERLIQUID_INFO_QUOTA_HMAC_SECRET === undefined &&
      (value.HYPERLIQUID_RECONCILIATION_READS_ENABLED ||
        value.HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED)
    ) {
      context.addIssue({
        code: "custom",
        message: value.HYPERLIQUID_RECONCILIATION_READS_ENABLED
          ? "Hyperliquid reconciliation reads require HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"
          : "Hyperliquid Spot reconciliation reads require HYPERLIQUID_INFO_QUOTA_HMAC_SECRET",
        path: ["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"],
      });
    }
    if (
      (value.STREAM_API_KEY !== undefined) !==
      (value.STREAM_API_SECRET !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "STREAM_API_KEY and STREAM_API_SECRET must be configured together",
        path: ["STREAM_API_KEY"],
      });
    }
    if (
      value.COMMUNITY_CHANNEL_SYNC_ENABLED &&
      (value.STREAM_API_KEY === undefined ||
        value.STREAM_API_SECRET === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "COMMUNITY_CHANNEL_SYNC_ENABLED requires STREAM_API_KEY and STREAM_API_SECRET",
        path: ["COMMUNITY_CHANNEL_SYNC_ENABLED"],
      });
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

export interface SocialConfig {
  readonly cursorHmacSecret: string;
  readonly quotaHmacSecret: string;
  readonly cursorTtlSeconds: 600;
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

export interface V2PlatformValues<T> {
  readonly ios: T;
  readonly android: T;
}

/**
 * Two version floors per platform. A client below `forceUpdateBelow` must
 * update before continuing; a client below `minimumSupportedVersions` but at
 * or above `forceUpdateBelow` sees a dismissible update prompt. When no
 * explicit hard floor is configured, both floors are the same value.
 */
export interface V2ClientVersionPolicyConfig {
  readonly minimumSupportedVersions: V2PlatformValues<string>;
  readonly forceUpdateBelow: V2PlatformValues<string>;
  readonly storeUrls: V2PlatformValues<string>;
}

export interface V2ClientPolicyConfig {
  readonly configVersion: string | null;
  readonly effectiveAt: string | null;
  readonly versionPolicy: V2ClientVersionPolicyConfig | null;
  readonly termsRequiredVersion: string | null;
}

/**
 * BSC read configuration. Present only when at least one RPC endpoint URL is
 * configured; absent means every chain read fails closed. A present value is
 * not proof that an endpoint is reachable or that it actually serves chain 56:
 * `eth_chainId` is verified at runtime before any read is published.
 */
export interface BscChainConfig {
  readonly chainId: "eip155:56";
  readonly chainReference: 56;
  readonly rpcUrls: readonly string[];
  readonly confirmations: number;
  readonly reorgDepthBlocks: number;
  /** Present only when the address is configured and independently verified. */
  readonly usd1TokenAddress: string | null;
}

/**
 * Native amount held back from `spendableBalance` so a later transfer or Swap
 * can still pay gas. It is a display-side product policy, not a chain fact,
 * and is published with its own config version.
 */
export interface WalletGasReserveConfig {
  readonly configVersion: "walletGasReserveV1";
  readonly decimalBnb: string;
  readonly rawWei: string;
}

export interface BscIndexerConfig {
  readonly startBlockNumber: number | null;
}

export interface GoplusConfig {
  readonly appKey: string;
  readonly appSecret: string;
  readonly rateLimitPerMinute: number;
}

/**
 * Market Provider configuration (Decision 0034). A disabled or uncredentialed
 * Provider is `null`/`false` here and every fact it would have supplied is
 * published as `unavailable`; nothing is inferred from another source.
 */
export interface MarketConfig {
  readonly dexscreener: {
    readonly enabled: boolean;
    readonly rateLimitPerMinute: number;
  };
  readonly geckoterminal: {
    readonly enabled: boolean;
    readonly rateLimitPerMinute: number;
  };
  readonly goplus: GoplusConfig | null;
  readonly priceTtlSeconds: number;
  readonly securityTtlSeconds: number;
  readonly candlesTtlSeconds: number;
  /** Seconds past TTL during which a cached fact may still be served as stale. */
  readonly staleGraceSeconds: number;
}

export interface AlertEvaluatorConfig {
  readonly notificationDedupeSeconds: number;
}

export interface V2CursorConfig {
  readonly hmacSecret: string;
  readonly ttlSeconds: 600;
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
  readonly v2SessionEnabled: boolean;
  readonly v2ModulesEnabled: ReadonlySet<V2ModuleId>;
  readonly v2ClientPolicy: V2ClientPolicyConfig;
  readonly v2Cursor: V2CursorConfig | null;
  /** NFKC lower-cased operator-blocked alias substrings; empty by default. */
  readonly v2AliasBlockedTerms: readonly string[];
  /**
   * Stream channel member ceiling recorded on a newly provisioned official
   * community channel (Decision 0032). Above it the LOOP membership still
   * stands and the channel member is parked as `capacityPending`.
   */
  readonly v2CommunityChannelMemberCap: number;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly databaseStatementTimeoutMs: number;
  readonly privy: PrivyConfig | null;
  readonly stream: StreamConfig | null;
  readonly streamTokenQuota: StreamTokenQuotaConfig | null;
  readonly social: SocialConfig | null;
  readonly perpReadCursor: PerpReadCursorConfig | null;
  readonly hyperliquidPrivateReads: HyperliquidPrivateReadsConfig | null;
  readonly bscChain: BscChainConfig | null;
  /**
   * Chain read policy that applies whether or not an endpoint is configured,
   * so an unavailable read client still reports the operator's numbers.
   */
  readonly bscConfirmations: number;
  readonly bscReorgDepthBlocks: number;
  readonly walletGasReserve: WalletGasReserveConfig;
  readonly market: MarketConfig;
  readonly serviceName: "loop-api";
  readonly serviceVersion: string;
}

export interface ReconciliationWorkerConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly logLevel:
    "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly databaseStatementTimeoutMs: number;
  readonly hyperliquidReconciliationReads: HyperliquidPrivateReadsConfig | null;
  readonly hyperliquidSpotReconciliationReads: HyperliquidPrivateReadsConfig | null;
  readonly spotAgentLifecycleMaintenanceEnabled: boolean;
  readonly issuanceRateRecordCleanupEnabled: boolean;
  readonly bscChain: BscChainConfig | null;
  readonly bscIndexer: BscIndexerConfig | null;
  /**
   * `community-channel-sync` lane (Decision 0032). Default off; enabling it
   * requires the complete Stream credential pair, which is why this process
   * now parses Stream configuration at all.
   */
  readonly communityChannelSync: StreamConfig | null;
  readonly market: MarketConfig;
  /** `alert_evaluator` lane (Decision 0034); default off. */
  readonly alertEvaluator: AlertEvaluatorConfig | null;
  readonly serviceName: "loop-reconciliation-worker";
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

function parseStoreUrl(fieldName: string, value: string): string {
  const url = parseUrl(fieldName, value);
  if (url.protocol !== "https:") {
    throw new ConfigurationError([`${fieldName}: protocol must be https`]);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError([`${fieldName}: credentials are not allowed`]);
  }
  return url.toString();
}

function parseV2ModulesEnabled(value: string | undefined): Set<V2ModuleId> {
  const modules = new Set<V2ModuleId>();
  if (value === undefined) {
    return modules;
  }
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    if (!v2ModuleIdSet.has(entry)) {
      throw new ConfigurationError([
        `V2_MODULES_ENABLED: unknown module ID; allowed values are ${v2ModuleIds.join(", ")}`,
      ]);
    }
    const moduleId = entry as V2ModuleId;
    if (modules.has(moduleId)) {
      throw new ConfigurationError([
        `V2_MODULES_ENABLED: duplicate module ID ${moduleId}`,
      ]);
    }
    modules.add(moduleId);
  }
  return modules;
}

const maximumAliasBlockedTerms = 256;
const maximumAliasBlockedTermLength = 64;
const forbiddenAliasTermCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/**
 * Comma-separated operator blocklist for V2 aliases. Each term is trimmed,
 * NFKC-normalised, lower-cased, and matched as a substring of the normalised
 * alias. Blank entries are ignored; control characters are a startup error.
 */
function parseV2AliasBlockedTerms(
  value: string | undefined,
): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  const terms = new Set<string>();
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim().normalize("NFKC").toLowerCase();
    if (entry.length === 0) {
      continue;
    }
    if (
      Array.from(entry).length > maximumAliasBlockedTermLength ||
      forbiddenAliasTermCharacters.test(entry)
    ) {
      throw new ConfigurationError([
        `V2_ALIAS_BLOCKED_TERMS: each term must be 1-${maximumAliasBlockedTermLength} code points without control characters`,
      ]);
    }
    terms.add(entry);
  }
  if (terms.size > maximumAliasBlockedTerms) {
    throw new ConfigurationError([
      `V2_ALIAS_BLOCKED_TERMS: at most ${maximumAliasBlockedTerms} terms are supported`,
    ]);
  }
  return Object.freeze([...terms]);
}

function parseV2ClientPolicy(data: {
  readonly V2_CLIENT_POLICY_CONFIG_VERSION?: string | undefined;
  readonly V2_CLIENT_POLICY_EFFECTIVE_AT?: string | undefined;
  readonly V2_CLIENT_POLICY_MIN_VERSION_IOS?: string | undefined;
  readonly V2_CLIENT_POLICY_MIN_VERSION_ANDROID?: string | undefined;
  readonly V2_CLIENT_POLICY_STORE_URL_IOS?: string | undefined;
  readonly V2_CLIENT_POLICY_STORE_URL_ANDROID?: string | undefined;
  readonly V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_IOS?: string | undefined;
  readonly V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_ANDROID?: string | undefined;
  readonly V2_TERMS_REQUIRED_VERSION?: string | undefined;
}): V2ClientPolicyConfig {
  let versionPolicy: V2ClientVersionPolicyConfig | null = null;
  const minimumIos = data.V2_CLIENT_POLICY_MIN_VERSION_IOS;
  const minimumAndroid = data.V2_CLIENT_POLICY_MIN_VERSION_ANDROID;
  const storeIos = data.V2_CLIENT_POLICY_STORE_URL_IOS;
  const storeAndroid = data.V2_CLIENT_POLICY_STORE_URL_ANDROID;

  if (
    minimumIos !== undefined &&
    minimumAndroid !== undefined &&
    storeIos !== undefined &&
    storeAndroid !== undefined
  ) {
    const forceUpdateBelowIos =
      data.V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_IOS ?? minimumIos;
    const forceUpdateBelowAndroid =
      data.V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_ANDROID ?? minimumAndroid;
    if (compareClientVersions(forceUpdateBelowIos, minimumIos) > 0) {
      throw new ConfigurationError([
        "V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_IOS: must not exceed V2_CLIENT_POLICY_MIN_VERSION_IOS",
      ]);
    }
    if (compareClientVersions(forceUpdateBelowAndroid, minimumAndroid) > 0) {
      throw new ConfigurationError([
        "V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_ANDROID: must not exceed V2_CLIENT_POLICY_MIN_VERSION_ANDROID",
      ]);
    }
    versionPolicy = Object.freeze({
      minimumSupportedVersions: Object.freeze({
        ios: minimumIos,
        android: minimumAndroid,
      }),
      forceUpdateBelow: Object.freeze({
        ios: forceUpdateBelowIos,
        android: forceUpdateBelowAndroid,
      }),
      storeUrls: Object.freeze({
        ios: parseStoreUrl("V2_CLIENT_POLICY_STORE_URL_IOS", storeIos),
        android: parseStoreUrl(
          "V2_CLIENT_POLICY_STORE_URL_ANDROID",
          storeAndroid,
        ),
      }),
    });
  }

  return Object.freeze({
    configVersion: data.V2_CLIENT_POLICY_CONFIG_VERSION ?? null,
    effectiveAt:
      data.V2_CLIENT_POLICY_EFFECTIVE_AT === undefined
        ? null
        : new Date(data.V2_CLIENT_POLICY_EFFECTIVE_AT).toISOString(),
    versionPolicy,
    termsRequiredVersion: data.V2_TERMS_REQUIRED_VERSION ?? null,
  });
}

const maximumBscRpcEndpoints = 8;

/**
 * Comma-separated RPC endpoint list. Endpoint URLs are Provider configuration:
 * they are validated here and never published in an API response, a capability
 * projection, or a log field.
 */
function parseBscRpcUrls(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  const urls: string[] = [];
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    if (entry.length === 0) {
      continue;
    }
    const url = parseUrl("BSC_RPC_URLS", entry);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ConfigurationError([
        "BSC_RPC_URLS: protocol must be http or https",
      ]);
    }
    if (url.username !== "" || url.password !== "") {
      throw new ConfigurationError([
        "BSC_RPC_URLS: credentials are not allowed in an endpoint URL",
      ]);
    }
    const normalized = url.toString();
    if (!urls.includes(normalized)) {
      urls.push(normalized);
    }
  }
  if (urls.length > maximumBscRpcEndpoints) {
    throw new ConfigurationError([
      `BSC_RPC_URLS: at most ${maximumBscRpcEndpoints} endpoints are supported`,
    ]);
  }
  return Object.freeze(urls);
}

const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;

/**
 * The USD1 slot needs both an address and an explicit verification flag. A
 * configured address alone never enters the registry as `verified`.
 */
function parseVerifiedUsd1Address(
  address: string | undefined,
  verified: boolean,
): string | null {
  if (address === undefined) {
    if (verified) {
      throw new ConfigurationError([
        "BSC_USD1_VERIFIED: requires BSC_USD1_TOKEN_ADDRESS",
      ]);
    }
    return null;
  }
  if (!evmAddressPattern.test(address)) {
    throw new ConfigurationError([
      "BSC_USD1_TOKEN_ADDRESS: must be a 0x-prefixed 20-byte address",
    ]);
  }
  return verified ? address.toLowerCase() : null;
}

function parseBscChainConfig(data: {
  readonly BSC_RPC_URLS?: string | undefined;
  readonly BSC_CONFIRMATIONS: number;
  readonly BSC_REORG_DEPTH_BLOCKS: number;
  readonly BSC_USD1_TOKEN_ADDRESS?: string | undefined;
  readonly BSC_USD1_VERIFIED?: boolean | undefined;
}): BscChainConfig | null {
  const rpcUrls = parseBscRpcUrls(data.BSC_RPC_URLS);
  if (rpcUrls.length === 0) {
    return null;
  }
  return Object.freeze({
    chainId: "eip155:56" as const,
    chainReference: 56 as const,
    rpcUrls,
    confirmations: data.BSC_CONFIRMATIONS,
    reorgDepthBlocks: data.BSC_REORG_DEPTH_BLOCKS,
    usd1TokenAddress: parseVerifiedUsd1Address(
      data.BSC_USD1_TOKEN_ADDRESS,
      data.BSC_USD1_VERIFIED ?? false,
    ),
  });
}

const maximumGasReserveWei = 1_000_000_000_000_000_000n;

/**
 * The reserve is configured in BNB and converted with exact integer
 * arithmetic. A value above one whole BNB is a configuration error, not a
 * product choice: it would hide most of a normal balance.
 */
function parseWalletGasReserve(value: string): WalletGasReserveConfig {
  let rawWei: bigint;
  try {
    rawWei = parseDecimalAmount(value, 18);
  } catch {
    throw new ConfigurationError([
      "WALLET_GAS_RESERVE_BNB: must be a non-negative decimal with at most 18 fraction digits",
    ]);
  }
  if (rawWei > maximumGasReserveWei) {
    throw new ConfigurationError([
      "WALLET_GAS_RESERVE_BNB: must not exceed 1 BNB",
    ]);
  }
  return Object.freeze({
    configVersion: "walletGasReserveV1" as const,
    decimalBnb: value,
    rawWei: rawWei.toString(10),
  });
}

function marketEnvironmentDefaults(
  environment: NodeJS.ProcessEnv,
): Record<keyof typeof marketEnvironmentShape, string | undefined> {
  return {
    MARKET_PROVIDER_DEXSCREENER_ENABLED:
      environment["MARKET_PROVIDER_DEXSCREENER_ENABLED"] ?? "true",
    MARKET_PROVIDER_GECKOTERMINAL_ENABLED:
      environment["MARKET_PROVIDER_GECKOTERMINAL_ENABLED"] ?? "false",
    MARKET_DEXSCREENER_RATE_LIMIT_PER_MINUTE:
      environment["MARKET_DEXSCREENER_RATE_LIMIT_PER_MINUTE"] ?? "300",
    MARKET_GECKOTERMINAL_RATE_LIMIT_PER_MINUTE:
      environment["MARKET_GECKOTERMINAL_RATE_LIMIT_PER_MINUTE"] ?? "30",
    MARKET_GOPLUS_RATE_LIMIT_PER_MINUTE:
      environment["MARKET_GOPLUS_RATE_LIMIT_PER_MINUTE"] ?? "30",
    MARKET_PRICE_TTL_SECONDS: environment["MARKET_PRICE_TTL_SECONDS"] ?? "30",
    MARKET_SECURITY_TTL_SECONDS:
      environment["MARKET_SECURITY_TTL_SECONDS"] ?? "600",
    MARKET_CANDLES_TTL_SECONDS:
      environment["MARKET_CANDLES_TTL_SECONDS"] ?? "60",
    MARKET_STALE_GRACE_SECONDS:
      environment["MARKET_STALE_GRACE_SECONDS"] ?? "900",
    GOPLUS_APP_KEY: environment["GOPLUS_APP_KEY"],
    GOPLUS_APP_SECRET: environment["GOPLUS_APP_SECRET"],
  };
}

function parseMarketConfig(data: {
  readonly MARKET_PROVIDER_DEXSCREENER_ENABLED: boolean;
  readonly MARKET_PROVIDER_GECKOTERMINAL_ENABLED: boolean;
  readonly MARKET_DEXSCREENER_RATE_LIMIT_PER_MINUTE: number;
  readonly MARKET_GECKOTERMINAL_RATE_LIMIT_PER_MINUTE: number;
  readonly MARKET_GOPLUS_RATE_LIMIT_PER_MINUTE: number;
  readonly MARKET_PRICE_TTL_SECONDS: number;
  readonly MARKET_SECURITY_TTL_SECONDS: number;
  readonly MARKET_CANDLES_TTL_SECONDS: number;
  readonly MARKET_STALE_GRACE_SECONDS: number;
  readonly GOPLUS_APP_KEY?: string | undefined;
  readonly GOPLUS_APP_SECRET?: string | undefined;
}): MarketConfig {
  return Object.freeze({
    dexscreener: Object.freeze({
      enabled: data.MARKET_PROVIDER_DEXSCREENER_ENABLED,
      rateLimitPerMinute: data.MARKET_DEXSCREENER_RATE_LIMIT_PER_MINUTE,
    }),
    geckoterminal: Object.freeze({
      enabled: data.MARKET_PROVIDER_GECKOTERMINAL_ENABLED,
      rateLimitPerMinute: data.MARKET_GECKOTERMINAL_RATE_LIMIT_PER_MINUTE,
    }),
    goplus:
      data.GOPLUS_APP_KEY !== undefined && data.GOPLUS_APP_SECRET !== undefined
        ? Object.freeze({
            appKey: data.GOPLUS_APP_KEY,
            appSecret: data.GOPLUS_APP_SECRET,
            rateLimitPerMinute: data.MARKET_GOPLUS_RATE_LIMIT_PER_MINUTE,
          })
        : null,
    priceTtlSeconds: data.MARKET_PRICE_TTL_SECONDS,
    securityTtlSeconds: data.MARKET_SECURITY_TTL_SECONDS,
    candlesTtlSeconds: data.MARKET_CANDLES_TTL_SECONDS,
    staleGraceSeconds: data.MARKET_STALE_GRACE_SECONDS,
  });
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
    V2_SESSION_ENABLED:
      environment["V2_SESSION_ENABLED"] ??
      (rawNodeEnv === "production" ? "false" : "true"),
    V2_MODULES_ENABLED: environment["V2_MODULES_ENABLED"],
    V2_CLIENT_POLICY_CONFIG_VERSION:
      environment["V2_CLIENT_POLICY_CONFIG_VERSION"],
    V2_CLIENT_POLICY_EFFECTIVE_AT: environment["V2_CLIENT_POLICY_EFFECTIVE_AT"],
    V2_CLIENT_POLICY_MIN_VERSION_IOS:
      environment["V2_CLIENT_POLICY_MIN_VERSION_IOS"],
    V2_CLIENT_POLICY_MIN_VERSION_ANDROID:
      environment["V2_CLIENT_POLICY_MIN_VERSION_ANDROID"],
    V2_CLIENT_POLICY_STORE_URL_IOS:
      environment["V2_CLIENT_POLICY_STORE_URL_IOS"],
    V2_CLIENT_POLICY_STORE_URL_ANDROID:
      environment["V2_CLIENT_POLICY_STORE_URL_ANDROID"],
    V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_IOS:
      environment["V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_IOS"],
    V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_ANDROID:
      environment["V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_ANDROID"],
    V2_TERMS_REQUIRED_VERSION: environment["V2_TERMS_REQUIRED_VERSION"],
    V2_ALIAS_BLOCKED_TERMS: environment["V2_ALIAS_BLOCKED_TERMS"],
    V2_CURSOR_HMAC_SECRET: environment["V2_CURSOR_HMAC_SECRET"],
    V2_COMMUNITY_CHANNEL_MEMBER_CAP:
      environment["V2_COMMUNITY_CHANNEL_MEMBER_CAP"] ?? "3000",
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
    SOCIAL_CURSOR_HMAC_SECRET: environment["SOCIAL_CURSOR_HMAC_SECRET"],
    SOCIAL_QUOTA_HMAC_SECRET: environment["SOCIAL_QUOTA_HMAC_SECRET"],
    PERP_READ_CURSOR_HMAC_SECRET: environment["PERP_READ_CURSOR_HMAC_SECRET"],
    HYPERLIQUID_PRIVATE_READS_ENABLED:
      environment["HYPERLIQUID_PRIVATE_READS_ENABLED"] ?? "false",
    HYPERLIQUID_INFO_QUOTA_HMAC_SECRET:
      environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"],
    HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE:
      environment["HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE"] ?? "960",
    BSC_RPC_URLS: environment["BSC_RPC_URLS"],
    BSC_CONFIRMATIONS: environment["BSC_CONFIRMATIONS"] ?? "15",
    BSC_REORG_DEPTH_BLOCKS: environment["BSC_REORG_DEPTH_BLOCKS"] ?? "64",
    BSC_USD1_TOKEN_ADDRESS: environment["BSC_USD1_TOKEN_ADDRESS"],
    BSC_USD1_VERIFIED: environment["BSC_USD1_VERIFIED"] ?? "false",
    WALLET_GAS_RESERVE_BNB: environment["WALLET_GAS_RESERVE_BNB"] ?? "0.005",
    ...marketEnvironmentDefaults(environment),
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
  const v2ModulesEnabled = parseV2ModulesEnabled(
    parsed.data.V2_MODULES_ENABLED,
  );
  const v2ClientPolicy = parseV2ClientPolicy(parsed.data);
  const v2AliasBlockedTerms = parseV2AliasBlockedTerms(
    parsed.data.V2_ALIAS_BLOCKED_TERMS,
  );
  const v2Cursor =
    parsed.data.V2_CURSOR_HMAC_SECRET === undefined
      ? null
      : Object.freeze({
          hmacSecret: parsed.data.V2_CURSOR_HMAC_SECRET,
          ttlSeconds: 600 as const,
        });
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
  const social =
    parsed.data.SOCIAL_CURSOR_HMAC_SECRET !== undefined &&
    parsed.data.SOCIAL_QUOTA_HMAC_SECRET !== undefined
      ? Object.freeze({
          cursorHmacSecret: parsed.data.SOCIAL_CURSOR_HMAC_SECRET,
          quotaHmacSecret: parsed.data.SOCIAL_QUOTA_HMAC_SECRET,
          cursorTtlSeconds: 600 as const,
        })
      : null;
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
    v2SessionEnabled: parsed.data.V2_SESSION_ENABLED,
    v2ModulesEnabled,
    v2ClientPolicy,
    v2Cursor,
    v2AliasBlockedTerms,
    databaseUrl: databaseUrl.toString(),
    databasePoolMax: parsed.data.DATABASE_POOL_MAX,
    databaseConnectionTimeoutMs: parsed.data.DATABASE_CONNECTION_TIMEOUT_MS,
    databaseStatementTimeoutMs: parsed.data.DATABASE_STATEMENT_TIMEOUT_MS,
    v2CommunityChannelMemberCap: parsed.data.V2_COMMUNITY_CHANNEL_MEMBER_CAP,
    privy,
    stream,
    streamTokenQuota,
    social,
    perpReadCursor,
    hyperliquidPrivateReads,
    bscChain: parseBscChainConfig(parsed.data),
    bscConfirmations: parsed.data.BSC_CONFIRMATIONS,
    bscReorgDepthBlocks: parsed.data.BSC_REORG_DEPTH_BLOCKS,
    walletGasReserve: parseWalletGasReserve(parsed.data.WALLET_GAS_RESERVE_BNB),
    market: parseMarketConfig(parsed.data),
    serviceName: "loop-api",
    serviceVersion,
  });
}

/**
 * The reconciliation process deliberately has no HTTP or provider credential
 * configuration. Its read-only provider capabilities have independent,
 * default-off switches and never inherit the API process's private-read flag.
 */
export function loadReconciliationWorkerConfig(
  environment: NodeJS.ProcessEnv,
): ReconciliationWorkerConfig {
  const parsed = reconciliationWorkerEnvironmentSchema.safeParse({
    NODE_ENV: environment["NODE_ENV"] ?? "development",
    LOG_LEVEL: environment["LOG_LEVEL"] ?? "info",
    HYPERLIQUID_RECONCILIATION_READS_ENABLED:
      environment["HYPERLIQUID_RECONCILIATION_READS_ENABLED"] ?? "false",
    HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED:
      environment["HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED"] ?? "false",
    SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED:
      environment["SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED"] ?? "true",
    ISSUANCE_RATE_RECORD_CLEANUP_ENABLED:
      environment["ISSUANCE_RATE_RECORD_CLEANUP_ENABLED"] ?? "true",
    COMMUNITY_CHANNEL_SYNC_ENABLED:
      environment["COMMUNITY_CHANNEL_SYNC_ENABLED"] ?? "false",
    STREAM_API_KEY: environment["STREAM_API_KEY"],
    STREAM_API_SECRET: environment["STREAM_API_SECRET"],
    HYPERLIQUID_INFO_QUOTA_HMAC_SECRET:
      environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"],
    HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE:
      environment["HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE"] ?? "960",
    BSC_INDEXER_ENABLED: environment["BSC_INDEXER_ENABLED"] ?? "false",
    BSC_INDEXER_START_BLOCK: environment["BSC_INDEXER_START_BLOCK"],
    BSC_RPC_URLS: environment["BSC_RPC_URLS"],
    BSC_CONFIRMATIONS: environment["BSC_CONFIRMATIONS"] ?? "15",
    BSC_REORG_DEPTH_BLOCKS: environment["BSC_REORG_DEPTH_BLOCKS"] ?? "64",
    ALERT_EVALUATOR_ENABLED: environment["ALERT_EVALUATOR_ENABLED"] ?? "false",
    ALERT_NOTIFICATION_DEDUPE_SECONDS:
      environment["ALERT_NOTIFICATION_DEDUPE_SECONDS"] ?? "3600",
    ...marketEnvironmentDefaults(environment),
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

  const databaseUrl = parseUrl("DATABASE_URL", parsed.data.DATABASE_URL);
  assertDatabaseUrl(databaseUrl);
  let reconciliationReadCapability: HyperliquidPrivateReadsConfig | null = null;
  if (
    parsed.data.HYPERLIQUID_RECONCILIATION_READS_ENABLED ||
    parsed.data.HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED
  ) {
    const quotaHmacSecret = parsed.data.HYPERLIQUID_INFO_QUOTA_HMAC_SECRET;
    if (quotaHmacSecret === undefined) {
      throw new ConfigurationError([
        "HYPERLIQUID_INFO_QUOTA_HMAC_SECRET: required when reconciliation reads are enabled",
      ]);
    }
    reconciliationReadCapability = Object.freeze({
      quotaHmacSecret,
      policyVersion: "hyperliquid_info_v1",
      windowDurationSeconds: 60,
      weightCapacity: parsed.data.HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE,
    });
  }

  return Object.freeze({
    nodeEnv: parsed.data.NODE_ENV,
    logLevel: parsed.data.LOG_LEVEL,
    databaseUrl: databaseUrl.toString(),
    databasePoolMax: parsed.data.DATABASE_POOL_MAX,
    databaseConnectionTimeoutMs: parsed.data.DATABASE_CONNECTION_TIMEOUT_MS,
    databaseStatementTimeoutMs: parsed.data.DATABASE_STATEMENT_TIMEOUT_MS,
    hyperliquidReconciliationReads: parsed.data
      .HYPERLIQUID_RECONCILIATION_READS_ENABLED
      ? reconciliationReadCapability
      : null,
    hyperliquidSpotReconciliationReads: parsed.data
      .HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED
      ? reconciliationReadCapability
      : null,
    spotAgentLifecycleMaintenanceEnabled:
      parsed.data.SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED,
    issuanceRateRecordCleanupEnabled:
      parsed.data.ISSUANCE_RATE_RECORD_CLEANUP_ENABLED,
    bscChain: parseBscChainConfig({
      ...parsed.data,
      BSC_USD1_VERIFIED: false,
    }),
    bscIndexer: parsed.data.BSC_INDEXER_ENABLED
      ? Object.freeze({
          startBlockNumber: parsed.data.BSC_INDEXER_START_BLOCK ?? null,
        })
      : null,
    communityChannelSync:
      parsed.data.COMMUNITY_CHANNEL_SYNC_ENABLED &&
      parsed.data.STREAM_API_KEY !== undefined &&
      parsed.data.STREAM_API_SECRET !== undefined
        ? Object.freeze({
            apiKey: parsed.data.STREAM_API_KEY,
            apiSecret: parsed.data.STREAM_API_SECRET,
          })
        : null,
    market: parseMarketConfig(parsed.data),
    alertEvaluator: parsed.data.ALERT_EVALUATOR_ENABLED
      ? Object.freeze({
          notificationDedupeSeconds:
            parsed.data.ALERT_NOTIFICATION_DEDUPE_SECONDS,
        })
      : null,
    serviceName: "loop-reconciliation-worker",
    serviceVersion,
  });
}
