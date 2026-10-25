import * as cryptoModule from "node:crypto";

import { z } from "zod";

import {
  bscChainId,
  bscChainReference,
  bscTestnetChainId,
  bscTestnetChainReference,
  launchMainnetAckPhrase,
  parseDecimalAmount,
  type LaunchChainId,
  type LaunchChainReference,
} from "./features/chain/chain-contract.js";
import {
  Launch2LegacyFactoriesInvalidError,
  launch2FactoryEntries,
  parseLaunch2LegacyFactories,
  type Launch2FactoryGeneration,
} from "./features/launch2/launch2-generation.js";
import {
  publicClientIpHeaderNames,
  type PublicClientIpHeaderName,
} from "./core/http/client-ip.js";
import type { LaunchContractConfig } from "./integrations/launch/launch-contract-adapter.js";
import {
  memeContractReasonCodes,
  type MemeContractConfig,
  type MemeContractReasonCode,
} from "./integrations/meme/meme-contract-adapter.js";
import {
  compareClientVersions,
  isValidClientVersion,
} from "./features/session/client-version.js";
import {
  defaultAdminLoginPolicy,
  type AdminLoginPolicy,
} from "./features/admin/admin-login-attempts.js";

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
  "referral",
  "notifications",
  "profile",
  "watchlist",
  "security",
  "settings",
  "support",
  "meme",
  "launch2",
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

const optionalPositiveIntegerString = (minimum: number, maximum: number) =>
  z.preprocess(
    blankStringToUndefined,
    positiveIntegerString(minimum, maximum).optional(),
  );

/**
 * Operator evidence reference for the Decision 0005/0032 audio-room role
 * pre-condition (Decision 0039). It is published verbatim in
 * `voiceRooms.evidence.reference` and in one startup log line, so it must be
 * a short printable label (an archive name, never a URL with credentials and
 * never a secret): 1–120 characters after trimming, no control, format,
 * surrogate, private-use, or unassigned code points.
 */
const evidenceReferencePattern = /^\P{C}+$/u;

const optionalEvidenceReference = z.preprocess(
  blankStringToUndefined,
  z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(evidenceReferencePattern, {
      message: "must not contain control or non-printable characters",
    })
    .optional(),
);

/**
 * Launch chain slot keys shared by the API and worker processes (Decision
 * 0038). `LAUNCH_CHAIN_ID=56` reuses the primary chain configuration and
 * refuses every `LAUNCH_BSC_*` override; `97` reads its own endpoint list.
 */
const launchChainEnvironmentShape = {
  LAUNCH_CHAIN_ID: z.enum(["56", "97"]),
  // Decision 0150: the mainnet switch. Blank (default) keeps every
  // launch-slot action path closed on 56 exactly as before; only the exact
  // phrase opens them (each write lane still needs its own switch and
  // BSC_WRITES_ENABLED=true). Never trimmed: anything else refuses boot.
  LAUNCH_MAINNET_ACK: z.preprocess(
    blankStringToUndefined,
    z.string().max(128).optional(),
  ),
  LAUNCH_BSC_RPC_URLS: optionalCredential(4_096),
  LAUNCH_BSC_CONFIRMATIONS: optionalPositiveIntegerString(1, 1_000),
  LAUNCH_BSC_REORG_DEPTH_BLOCKS: optionalPositiveIntegerString(1, 1_000),
  // Decision 0076: the Launch contract on the launch slot. All four blank, or
  // all four set; anything in between refuses to boot.
  LAUNCH_CONTRACT_ADDRESS: optionalCredential(64),
  LAUNCH_CONTRACT_VERSION: optionalCredential(64),
  LAUNCH_CONTRACT_START_BLOCK: optionalCredential(32),
  LAUNCH_USD1_ADDRESS: optionalCredential(64),
} as const;

function launchChainEnvironmentDefaults(
  environment: NodeJS.ProcessEnv,
): Record<keyof typeof launchChainEnvironmentShape, string | undefined> {
  return {
    LAUNCH_CHAIN_ID: environment["LAUNCH_CHAIN_ID"] ?? "56",
    LAUNCH_MAINNET_ACK: environment["LAUNCH_MAINNET_ACK"],
    LAUNCH_BSC_RPC_URLS: environment["LAUNCH_BSC_RPC_URLS"],
    LAUNCH_BSC_CONFIRMATIONS: environment["LAUNCH_BSC_CONFIRMATIONS"],
    LAUNCH_BSC_REORG_DEPTH_BLOCKS: environment["LAUNCH_BSC_REORG_DEPTH_BLOCKS"],
    LAUNCH_CONTRACT_ADDRESS: environment["LAUNCH_CONTRACT_ADDRESS"],
    LAUNCH_CONTRACT_VERSION: environment["LAUNCH_CONTRACT_VERSION"],
    LAUNCH_CONTRACT_START_BLOCK: environment["LAUNCH_CONTRACT_START_BLOCK"],
    LAUNCH_USD1_ADDRESS: environment["LAUNCH_USD1_ADDRESS"],
  };
}

/**
 * Decision 0116: hourly Mining settlement keys shared by the API and worker
 * processes. Every key has a default; a blank claim address keeps the
 * claim routes 503 (MINING_CLAIM_CONTRACT_NOT_CONFIGURED).
 */
const miningSettlementEnvironmentShape = {
  MINING_REWARD_CLAIM_ADDRESS: optionalCredential(64),
  MINING_CLAIM_USDT_ADDRESS: optionalCredential(64),
  MINING_CLAIM_CONFIRMATIONS: positiveIntegerString(1, 100),
  MINING_SETTLEMENT_INDEXER_GRACE_SECONDS: positiveIntegerString(0, 3_600),
  // Decision 0184: narrow Mining Power (hourly settlement attribution and
  // snapshot balance inputs) to LOOP embedded wallets. Default off: embedded
  // and linked external wallets both count until the requester confirms.
  MINING_EMBEDDED_WALLET_ONLY: booleanString,
} as const;

function miningSettlementEnvironmentDefaults(
  environment: NodeJS.ProcessEnv,
): Record<keyof typeof miningSettlementEnvironmentShape, string | undefined> {
  return {
    MINING_REWARD_CLAIM_ADDRESS: environment["MINING_REWARD_CLAIM_ADDRESS"],
    MINING_CLAIM_USDT_ADDRESS: environment["MINING_CLAIM_USDT_ADDRESS"],
    MINING_CLAIM_CONFIRMATIONS:
      environment["MINING_CLAIM_CONFIRMATIONS"] ?? "3",
    MINING_SETTLEMENT_INDEXER_GRACE_SECONDS:
      environment["MINING_SETTLEMENT_INDEXER_GRACE_SECONDS"] ?? "120",
    MINING_EMBEDDED_WALLET_ONLY:
      environment["MINING_EMBEDDED_WALLET_ONLY"] ?? "false",
  };
}

export interface MiningSettlementSharedConfig {
  readonly claimContractAddress: string | null;
  readonly usdtAddress: string | null;
  readonly claimConfirmations: number;
  readonly indexerGraceSeconds: number;
  /**
   * Decision 0184 (`MINING_EMBEDDED_WALLET_ONLY`, default false): when true
   * only `account_wallets.kind = 'embedded'` wallets mine; when false every
   * active wallet (embedded and linked external) does.
   */
  readonly embeddedWalletOnly: boolean;
}

function parseMiningSettlementShared(data: {
  readonly MINING_REWARD_CLAIM_ADDRESS?: string | undefined;
  readonly MINING_CLAIM_USDT_ADDRESS?: string | undefined;
  readonly MINING_CLAIM_CONFIRMATIONS: number;
  readonly MINING_SETTLEMENT_INDEXER_GRACE_SECONDS: number;
  readonly MINING_EMBEDDED_WALLET_ONLY: boolean;
}): MiningSettlementSharedConfig {
  const issues: string[] = [];
  for (const key of [
    "MINING_REWARD_CLAIM_ADDRESS",
    "MINING_CLAIM_USDT_ADDRESS",
  ] as const) {
    const value = data[key];
    if (value !== undefined && !/^0x[0-9a-fA-F]{40}$/u.test(value)) {
      issues.push(`${key}: must be a 0x-prefixed 20-byte address`);
    }
  }
  if (issues.length > 0) throw new ConfigurationError(issues);
  return Object.freeze({
    claimContractAddress:
      data.MINING_REWARD_CLAIM_ADDRESS?.toLowerCase() ?? null,
    usdtAddress: data.MINING_CLAIM_USDT_ADDRESS?.toLowerCase() ?? null,
    claimConfirmations: data.MINING_CLAIM_CONFIRMATIONS,
    indexerGraceSeconds: data.MINING_SETTLEMENT_INDEXER_GRACE_SECONDS,
    embeddedWalletOnly: data.MINING_EMBEDDED_WALLET_ONLY,
  });
}

export interface MiningSettlementApiConfig extends MiningSettlementSharedConfig {
  /** EIP-712 voucher signer; null keeps claim/prepare 503. Never logged. */
  readonly signerPrivateKey: `0x${string}` | null;
  /** Manual settlement of a completed hour from the console (never in production). */
  readonly testTrigger: boolean;
}

export interface MiningSettlementWorkerConfig extends MiningSettlementSharedConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly catchupHours: number;
}

const launchContractKeys = [
  "LAUNCH_CONTRACT_ADDRESS",
  "LAUNCH_CONTRACT_VERSION",
  "LAUNCH_CONTRACT_START_BLOCK",
  "LAUNCH_USD1_ADDRESS",
] as const;

type LaunchContractEnvironment = {
  readonly [Key in (typeof launchContractKeys)[number]]?: string | undefined;
};

/**
 * Decision 0076: the four Launch contract keys are one unit. A partial set
 * would publish a contract whose settlement token or start block is unknown,
 * so it refuses to boot and names every missing key (the 0038 discipline).
 */
function refineLaunchContractEnvironment(
  value: LaunchContractEnvironment,
  context: z.RefinementCtx,
): void {
  const present = launchContractKeys.filter((key) => value[key] !== undefined);
  if (present.length === 0 || present.length === launchContractKeys.length) {
    return;
  }
  for (const key of launchContractKeys) {
    if (value[key] === undefined) {
      context.addIssue({
        code: "custom",
        message:
          "is required when any of LAUNCH_CONTRACT_ADDRESS, LAUNCH_CONTRACT_VERSION, LAUNCH_CONTRACT_START_BLOCK, LAUNCH_USD1_ADDRESS is set",
        path: [key],
      });
    }
  }
}

/**
 * Decision 0150: true only with `LAUNCH_CHAIN_ID=56` and
 * `LAUNCH_MAINNET_ACK` equal to the exact phrase. Every "BSC Testnet only"
 * rule below is relaxed to "BSC Testnet, or BSC Mainnet acknowledged".
 */
function launchMainnetAcknowledged(value: {
  readonly LAUNCH_CHAIN_ID: "56" | "97";
  readonly LAUNCH_MAINNET_ACK?: string | undefined;
}): boolean {
  return (
    value.LAUNCH_CHAIN_ID === "56" &&
    value.LAUNCH_MAINNET_ACK === launchMainnetAckPhrase
  );
}

/** Decision 0150: the launch slot admits its action paths (97, or 56 + ack). */
function launchSlotActionsPermitted(value: {
  readonly LAUNCH_CHAIN_ID: "56" | "97";
  readonly LAUNCH_MAINNET_ACK?: string | undefined;
}): boolean {
  return value.LAUNCH_CHAIN_ID === "97" || launchMainnetAcknowledged(value);
}

/**
 * Decision 0150: a server-signed launch-slot write lane (`key` = its
 * enable switch). On 97 nothing changes; on 56 without the ack the pre-0150
 * refusal is returned verbatim; on 56 with the ack the lane also needs the
 * one repository-wide write switch `BSC_WRITES_ENABLED=true`.
 */
function launchSlotWriteLaneIssues(
  key: string,
  data: {
    readonly LAUNCH_CHAIN_ID: "56" | "97";
    readonly LAUNCH_MAINNET_ACK?: string | undefined;
    readonly BSC_WRITES_ENABLED?: boolean | undefined;
  },
): readonly string[] {
  if (data.LAUNCH_CHAIN_ID === "97") return [];
  if (!launchMainnetAcknowledged(data)) {
    return [
      `${key}: permitted only when LAUNCH_CHAIN_ID=97 (BSC Mainnet signing stays closed)`,
    ];
  }
  return data.BSC_WRITES_ENABLED === true
    ? []
    : [
        `${key}: on LAUNCH_CHAIN_ID=56 also requires BSC_WRITES_ENABLED=true (Decision 0150)`,
      ];
}

function refineLaunchChainEnvironment(
  value: {
    readonly LAUNCH_CHAIN_ID: "56" | "97";
    readonly LAUNCH_MAINNET_ACK?: string | undefined;
    readonly LAUNCH_BSC_RPC_URLS?: string | undefined;
    readonly LAUNCH_BSC_CONFIRMATIONS?: number | undefined;
    readonly LAUNCH_BSC_REORG_DEPTH_BLOCKS?: number | undefined;
  },
  context: z.RefinementCtx,
): void {
  // Decision 0150: the ack is the exact phrase or blank, and only with 56
  // (a testnet environment never carries the mainnet phrase).
  if (value.LAUNCH_MAINNET_ACK !== undefined) {
    if (value.LAUNCH_MAINNET_ACK !== launchMainnetAckPhrase) {
      context.addIssue({
        code: "custom",
        message:
          "must be blank or exactly the Decision 0150 acknowledgement phrase",
        path: ["LAUNCH_MAINNET_ACK"],
      });
    } else if (value.LAUNCH_CHAIN_ID !== "56") {
      context.addIssue({
        code: "custom",
        message: "is permitted only when LAUNCH_CHAIN_ID=56",
        path: ["LAUNCH_MAINNET_ACK"],
      });
    }
  }
  if (value.LAUNCH_CHAIN_ID !== "56") {
    return;
  }
  for (const key of [
    "LAUNCH_BSC_RPC_URLS",
    "LAUNCH_BSC_CONFIRMATIONS",
    "LAUNCH_BSC_REORG_DEPTH_BLOCKS",
  ] as const) {
    if (value[key] !== undefined) {
      context.addIssue({
        code: "custom",
        message:
          "must be blank while LAUNCH_CHAIN_ID=56: the launch slot reuses the primary BSC configuration",
        path: [key],
      });
    }
  }
}

/**
 * Decision 0122: parses `LAUNCH2_LEGACY_FACTORIES` for the worker; any
 * problem is a configuration error (boot refused), never a silent skip.
 * Decision 0133: a legacy entry must differ from the OfficialTax Factory
 * and from the LoopDynamic Factory (and those two from each other); either
 * one alone is enough to check against.
 */
function parseLaunch2LegacyFactoriesEnvironment(
  value: string | undefined,
  currentFactory: string | undefined,
  dynamicFactory: string | undefined,
): readonly {
  readonly address: string;
  readonly generation: Launch2FactoryGeneration;
}[] {
  try {
    const legacy = parseLaunch2LegacyFactories(value);
    if (currentFactory !== undefined || dynamicFactory !== undefined) {
      launch2FactoryEntries({
        current: currentFactory ?? null,
        legacy,
        dynamic: dynamicFactory ?? null,
      });
    }
    return legacy;
  } catch (error) {
    if (error instanceof Launch2LegacyFactoriesInvalidError) {
      throw new ConfigurationError([
        `LAUNCH2_LEGACY_FACTORIES: ${error.message}`,
      ]);
    }
    throw error;
  }
}

/** Decision 0108: Hooks launch switches (API process only). */
export interface HooksLaunchConfig {
  readonly enabled: boolean;
  /** Lower-case BSC Testnet Factory address; null keeps signing unavailable. */
  readonly factoryAddress: string | null;
  /** Lower-case expected Factory runtime code hash. */
  readonly factoryCodeHash: string | null;
  /**
   * Decision 0117: minimum seconds between "now" and a config's
   * `nftSaleStartAt` (`HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS`, default 86,400;
   * floor 4,200 = the Gate's 3,600 s activation buffer + 600 s for the
   * executor to deploy, confirm, verify and activate).
   */
  readonly minimumSaleLeadSeconds: number;
  /**
   * Decision 0122 (requirer ruling 9): `LAUNCH2_BUYBACK_RECIPIENT`, the one
   * buyback recipient every Hooks config must name (lower-case). Null =
   * not configured: saves, signing requests and submissions are 503
   * `HOOKS_BUYBACK_RECIPIENT_UNAVAILABLE`.
   */
  readonly fixedBuybackRecipient: string | null;
  /**
   * Decision 0132: `HOOKS_LAUNCH_HOOK_KIND` — the official-pool Hook kind
   * new Hooks launches are saved, approved and signed for. `loopDynamic`
   * targets `dynamicFactory` (null = config saves / signing 503
   * `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`, never the OfficialTax Factory).
   */
  readonly hookKind: "officialTax" | "loopDynamic";
  /**
   * Decision 0132: `LAUNCH2_DYNAMIC_FACTORY_ADDRESS` / `_CODE_HASH`
   * (lower-case, one unit, BSC Testnet only).
   */
  readonly dynamicFactory: {
    readonly address: string;
    readonly codeHash: string;
  } | null;
}

/** Decision 0117: the Gate activation buffer (3,600 s) + 600 s executor margin. */
export const hooksLaunchMinimumSaleLeadFloorSeconds = 3_600 + 600;
/** Decision 0117: production default (unchanged from Decision 0108). */
export const hooksLaunchDefaultSaleLeadSeconds = 86_400;

/**
 * Decision 0108: the Hooks Factory address and its runtime code hash are one
 * unit, BSC Testnet only (`LAUNCH_CHAIN_ID=97`). A partial or malformed pair
 * refuses boot.
 */
function refineHooksLaunchFactoryEnvironment(
  value: {
    readonly LAUNCH_CHAIN_ID: "56" | "97";
    readonly LAUNCH_MAINNET_ACK?: string | undefined;
    readonly HOOKS_LAUNCH_FACTORY_ADDRESS?: string | undefined;
    readonly HOOKS_LAUNCH_FACTORY_CODE_HASH?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  const address = value.HOOKS_LAUNCH_FACTORY_ADDRESS;
  const codeHash = value.HOOKS_LAUNCH_FACTORY_CODE_HASH;
  if (address === undefined && codeHash === undefined) return;
  if (address === undefined || codeHash === undefined) {
    context.addIssue({
      code: "custom",
      message:
        "HOOKS_LAUNCH_FACTORY_ADDRESS and HOOKS_LAUNCH_FACTORY_CODE_HASH must be configured together",
      path: [
        address === undefined
          ? "HOOKS_LAUNCH_FACTORY_ADDRESS"
          : "HOOKS_LAUNCH_FACTORY_CODE_HASH",
      ],
    });
  }
  if (!launchSlotActionsPermitted(value)) {
    context.addIssue({
      code: "custom",
      message: "is permitted only when LAUNCH_CHAIN_ID=97",
      path: ["HOOKS_LAUNCH_FACTORY_ADDRESS"],
    });
  }
  if (address !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    context.addIssue({
      code: "custom",
      message: "must be a 0x-prefixed 20-byte contract address",
      path: ["HOOKS_LAUNCH_FACTORY_ADDRESS"],
    });
  }
  if (codeHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(codeHash)) {
    context.addIssue({
      code: "custom",
      message: "must be a 0x-prefixed 32-byte runtime code hash",
      path: ["HOOKS_LAUNCH_FACTORY_CODE_HASH"],
    });
  }
}

/**
 * Decision 0124: `LAUNCH2_POOL_ROUTER_ADDRESS` and
 * `LAUNCH2_POOL_ROUTER_CODE_HASH` are one unit, BSC Testnet only
 * (`LAUNCH_CHAIN_ID=97`). A partial or malformed pair refuses boot; neither
 * keeps the official-pool routes unavailable.
 */
function refineLaunch2PoolRouterEnvironment(
  value: {
    readonly LAUNCH_CHAIN_ID: "56" | "97";
    readonly LAUNCH_MAINNET_ACK?: string | undefined;
    readonly LAUNCH2_POOL_ROUTER_ADDRESS?: string | undefined;
    readonly LAUNCH2_POOL_ROUTER_CODE_HASH?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  const address = value.LAUNCH2_POOL_ROUTER_ADDRESS;
  const codeHash = value.LAUNCH2_POOL_ROUTER_CODE_HASH;
  if (address === undefined && codeHash === undefined) return;
  if (address === undefined || codeHash === undefined) {
    context.addIssue({
      code: "custom",
      message:
        "LAUNCH2_POOL_ROUTER_ADDRESS and LAUNCH2_POOL_ROUTER_CODE_HASH must be configured together",
      path: [
        address === undefined
          ? "LAUNCH2_POOL_ROUTER_ADDRESS"
          : "LAUNCH2_POOL_ROUTER_CODE_HASH",
      ],
    });
  }
  if (!launchSlotActionsPermitted(value)) {
    context.addIssue({
      code: "custom",
      message: "is permitted only when LAUNCH_CHAIN_ID=97",
      path: ["LAUNCH2_POOL_ROUTER_ADDRESS"],
    });
  }
  if (address !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    context.addIssue({
      code: "custom",
      message: "must be a 0x-prefixed 20-byte contract address",
      path: ["LAUNCH2_POOL_ROUTER_ADDRESS"],
    });
  }
  if (codeHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(codeHash)) {
    context.addIssue({
      code: "custom",
      message: "must be a 0x-prefixed 32-byte runtime code hash",
      path: ["LAUNCH2_POOL_ROUTER_CODE_HASH"],
    });
  }
}

function blankAsUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * Decision 0131: an address + runtime code hash pair (both or neither, BSC
 * Testnet only, well-formed). Used for the LoopDynamic LoopRouter and
 * Factory.
 */
function refineAddressCodeHashPair(
  value: Readonly<Record<string, unknown>> & {
    readonly LAUNCH_CHAIN_ID: "56" | "97";
    readonly LAUNCH_MAINNET_ACK?: string | undefined;
  },
  context: z.RefinementCtx,
  addressKey: string,
  codeHashKey: string,
): void {
  const address = value[addressKey] as string | undefined;
  const codeHash = value[codeHashKey] as string | undefined;
  if (address === undefined && codeHash === undefined) return;
  if (address === undefined || codeHash === undefined) {
    context.addIssue({
      code: "custom",
      message: `${addressKey} and ${codeHashKey} must be configured together`,
      path: [address === undefined ? addressKey : codeHashKey],
    });
  }
  if (!launchSlotActionsPermitted(value)) {
    context.addIssue({
      code: "custom",
      message: "is permitted only when LAUNCH_CHAIN_ID=97",
      path: [addressKey],
    });
  }
  if (address !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    context.addIssue({
      code: "custom",
      message: "must be a 0x-prefixed 20-byte contract address",
      path: [addressKey],
    });
  }
  if (codeHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(codeHash)) {
    context.addIssue({
      code: "custom",
      message: "must be a 0x-prefixed 32-byte runtime code hash",
      path: [codeHashKey],
    });
  }
}

/**
 * MEME curve launchpad keys shared by the API and worker processes
 * (Decision 0101). Every key is optional: while any of the four contract
 * keys is blank the `meme` capability is unavailable
 * (`MEME_CONTRACT_NOT_CONFIGURED`) and every `/v2/meme/*` route answers 503.
 * A present but malformed value refuses boot.
 */
const memeEnvironmentShape = {
  MEME_CONTRACT_ADDRESS: optionalCredential(64),
  MEME_CONTRACT_VERSION: optionalCredential(64),
  MEME_CONTRACT_START_BLOCK: optionalCredential(32),
  MEME_TOKEN_IMPLEMENTATION: optionalCredential(64),
  MEME_SALT_POOL_TARGET: positiveIntegerString(0, 1_000),
  MEME_VANITY_SUFFIX: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{0,8}$/u, { message: "must be 0-8 hex characters" }),
  MEME_CREATE_DAILY_LIMIT: positiveIntegerString(1, 1_000),
  /**
   * Decision 0151: classic MEME launch creation (drafts and create
   * Intents) answers 410 MEME_CLASSIC_LAUNCH_RETIRED unless this is
   * `true`. Reads, buy / sell, and reports are untouched.
   */
  MEME_CLASSIC_CREATE_ENABLED: booleanString,
} as const;

function memeEnvironmentDefaults(
  environment: NodeJS.ProcessEnv,
): Record<keyof typeof memeEnvironmentShape, string | undefined> {
  return {
    MEME_CONTRACT_ADDRESS: environment["MEME_CONTRACT_ADDRESS"],
    MEME_CONTRACT_VERSION: environment["MEME_CONTRACT_VERSION"],
    MEME_CONTRACT_START_BLOCK: environment["MEME_CONTRACT_START_BLOCK"],
    MEME_TOKEN_IMPLEMENTATION: environment["MEME_TOKEN_IMPLEMENTATION"],
    MEME_SALT_POOL_TARGET: environment["MEME_SALT_POOL_TARGET"] ?? "50",
    MEME_VANITY_SUFFIX: environment["MEME_VANITY_SUFFIX"] ?? "6666",
    MEME_CREATE_DAILY_LIMIT: environment["MEME_CREATE_DAILY_LIMIT"] ?? "3",
    MEME_CLASSIC_CREATE_ENABLED:
      environment["MEME_CLASSIC_CREATE_ENABLED"] ?? "false",
  };
}

/**
 * Market Provider keys shared by the API and worker processes (Decision 0034).
 * DexScreener needs no credential and is on by default; GoPlus needs its key
 * pair; GeckoTerminal stays off until its commercial terms are verified.
 * Throttles can only be lowered below each Provider's documented limit.
 */
const marketEnvironmentShape = {
  MARKET_PROVIDER_DEXSCREENER_ENABLED: booleanString,
  MARKET_PROVIDER_GECKOTERMINAL_ENABLED: booleanString,
  MARKET_DEXSCREENER_BUDGET_API: positiveIntegerString(1, 300),
  MARKET_DEXSCREENER_BUDGET_WORKER: positiveIntegerString(1, 300),
  MARKET_GECKOTERMINAL_RATE_LIMIT_PER_MINUTE: positiveIntegerString(1, 30),
  /**
   * Worker-process share of the GeckoTerminal limit (Decision 0074). Both
   * processes throttle themselves; the sum is not refined to 30 because the
   * API already yields `stale` facts under a Provider 429.
   */
  MARKET_GECKOTERMINAL_BUDGET_WORKER: positiveIntegerString(1, 30),
  MARKET_GOPLUS_RATE_LIMIT_PER_MINUTE: positiveIntegerString(1, 300),
  MARKET_PRICE_TTL_SECONDS: positiveIntegerString(5, 3_600),
  MARKET_SECURITY_TTL_SECONDS: positiveIntegerString(60, 86_400),
  MARKET_CANDLES_TTL_SECONDS: positiveIntegerString(15, 3_600),
  /** Row sparkline cache TTL (Decision 0074); read by the API, refreshed by the worker lane. */
  MARKET_SPARKLINE_TTL_SECONDS: positiveIntegerString(60, 3_600),
  MARKET_STALE_GRACE_SECONDS: positiveIntegerString(0, 86_400),
  MARKET_UNLISTED_PRICE_TTL_SECONDS: positiveIntegerString(5, 3_600),
  MARKET_UNLISTED_METADATA_TTL_SECONDS: positiveIntegerString(60, 86_400),
  GOPLUS_APP_KEY: optionalCredential(255),
  GOPLUS_APP_SECRET: optionalOpaqueSecret(1, 4_096),
} as const;

/**
 * Community AI Provider keys (Decision 0066, amended 2026-09-23). The key is
 * `COMMUNITY_AI_API_KEY`, falling back to `ANTHROPIC_API_KEY`; without either
 * the whole module is `null` here, the `communityAi` capability stays
 * `deferred`, and every AI route answers CAPABILITY_UNAVAILABLE. There is no
 * fixture answer and no second Provider. `COMMUNITY_AI_BASE_URL` selects the
 * Anthropic-compatible endpoint (origin only; the adapter appends
 * `/v1/messages`), defaulting to Anthropic itself.
 */
export const defaultCommunityAiBaseUrl = "https://api.anthropic.com";

const communityAiEnvironmentShape = {
  ANTHROPIC_API_KEY: optionalOpaqueSecret(8, 512),
  COMMUNITY_AI_API_KEY: optionalOpaqueSecret(8, 512),
  COMMUNITY_AI_BASE_URL: z.string().trim().min(1).max(2_048),
  COMMUNITY_AI_MODEL: z.string().trim().min(1).max(128),
  COMMUNITY_AI_TIMEOUT_MS: positiveIntegerString(1_000, 60_000),
  COMMUNITY_AI_BRIEF_TIMEOUT_MS: positiveIntegerString(5_000, 120_000),
  COMMUNITY_AI_MAX_OUTPUT_TOKENS: positiveIntegerString(64, 4_096),
  COMMUNITY_AI_USER_RATE_LIMIT_PER_MINUTE: positiveIntegerString(1, 60),
  COMMUNITY_AI_COMMUNITY_DAILY_LIMIT: positiveIntegerString(1, 10_000),
  COMMUNITY_AI_BRIEF_CACHE_SECONDS: positiveIntegerString(60, 86_400),
} as const;

function communityAiEnvironmentDefaults(
  environment: NodeJS.ProcessEnv,
): Record<keyof typeof communityAiEnvironmentShape, string | undefined> {
  return {
    ANTHROPIC_API_KEY: environment["ANTHROPIC_API_KEY"],
    COMMUNITY_AI_API_KEY: environment["COMMUNITY_AI_API_KEY"],
    COMMUNITY_AI_BASE_URL:
      environment["COMMUNITY_AI_BASE_URL"] ?? defaultCommunityAiBaseUrl,
    COMMUNITY_AI_MODEL: environment["COMMUNITY_AI_MODEL"] ?? "claude-sonnet-5",
    // Below the 15 s HTTP deadlines with room for knowledge assembly, so a
    // slow model ends in a 503, not a closed socket (Decision 0066 (2)).
    COMMUNITY_AI_TIMEOUT_MS: environment["COMMUNITY_AI_TIMEOUT_MS"] ?? "11000",
    // The background brief answers no request, so it is not bound by the HTTP
    // deadlines and gets a ceiling of its own (S76c).
    COMMUNITY_AI_BRIEF_TIMEOUT_MS:
      environment["COMMUNITY_AI_BRIEF_TIMEOUT_MS"] ?? "30000",
    COMMUNITY_AI_MAX_OUTPUT_TOKENS:
      environment["COMMUNITY_AI_MAX_OUTPUT_TOKENS"] ?? "800",
    COMMUNITY_AI_USER_RATE_LIMIT_PER_MINUTE:
      environment["COMMUNITY_AI_USER_RATE_LIMIT_PER_MINUTE"] ?? "6",
    COMMUNITY_AI_COMMUNITY_DAILY_LIMIT:
      environment["COMMUNITY_AI_COMMUNITY_DAILY_LIMIT"] ?? "200",
    COMMUNITY_AI_BRIEF_CACHE_SECONDS:
      environment["COMMUNITY_AI_BRIEF_CACHE_SECONDS"] ?? "3600",
  };
}

/**
 * The Provider origin: https, no credentials, no path, no query, no fragment.
 * A trailing slash is normalised away (`URL.origin` also lower-cases the host
 * and drops a default port), so `https://api.onlyrouter.ai/` and
 * `https://api.onlyrouter.ai` are the same configuration. A path such as
 * `/v1` is refused rather than silently doubled into `/v1/v1/messages`.
 */
function parseCommunityAiBaseUrl(fieldName: string, value: string): string {
  const url = parseUrl(fieldName, value);
  if (url.protocol !== "https:") {
    throw new ConfigurationError([`${fieldName}: protocol must be https`]);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError([`${fieldName}: credentials are not allowed`]);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ConfigurationError([
      `${fieldName}: must be an origin without path, query, or fragment`,
    ]);
  }
  return url.origin;
}

function parseCommunityAiConfig(data: {
  readonly ANTHROPIC_API_KEY?: string | undefined;
  readonly COMMUNITY_AI_API_KEY?: string | undefined;
  readonly COMMUNITY_AI_BASE_URL: string;
  readonly COMMUNITY_AI_MODEL: string;
  readonly COMMUNITY_AI_TIMEOUT_MS: number;
  readonly COMMUNITY_AI_BRIEF_TIMEOUT_MS: number;
  readonly COMMUNITY_AI_MAX_OUTPUT_TOKENS: number;
  readonly COMMUNITY_AI_USER_RATE_LIMIT_PER_MINUTE: number;
  readonly COMMUNITY_AI_COMMUNITY_DAILY_LIMIT: number;
  readonly COMMUNITY_AI_BRIEF_CACHE_SECONDS: number;
}): CommunityAiConfig | null {
  // The endpoint is validated even when no key is present: a malformed
  // COMMUNITY_AI_BASE_URL is a startup error, not something a later key
  // discovers.
  const baseUrl = parseCommunityAiBaseUrl(
    "COMMUNITY_AI_BASE_URL",
    data.COMMUNITY_AI_BASE_URL,
  );
  const apiKey = data.COMMUNITY_AI_API_KEY ?? data.ANTHROPIC_API_KEY;
  if (apiKey === undefined) {
    return null;
  }
  return Object.freeze({
    apiKey,
    baseUrl,
    model: data.COMMUNITY_AI_MODEL,
    timeoutMs: data.COMMUNITY_AI_TIMEOUT_MS,
    briefTimeoutMs: data.COMMUNITY_AI_BRIEF_TIMEOUT_MS,
    maximumOutputTokens: data.COMMUNITY_AI_MAX_OUTPUT_TOKENS,
    userRateLimitPerMinute: data.COMMUNITY_AI_USER_RATE_LIMIT_PER_MINUTE,
    communityDailyLimit: data.COMMUNITY_AI_COMMUNITY_DAILY_LIMIT,
    briefCacheSeconds: data.COMMUNITY_AI_BRIEF_CACHE_SECONDS,
  });
}

function refineMarketEnvironment(
  value: {
    readonly GOPLUS_APP_KEY?: string | undefined;
    readonly GOPLUS_APP_SECRET?: string | undefined;
    readonly MARKET_DEXSCREENER_BUDGET_API: number;
    readonly MARKET_DEXSCREENER_BUDGET_WORKER: number;
  },
  context: z.RefinementCtx,
): void {
  if (
    value.MARKET_DEXSCREENER_BUDGET_API +
      value.MARKET_DEXSCREENER_BUDGET_WORKER >
    300
  ) {
    context.addIssue({
      code: "custom",
      message:
        "MARKET_DEXSCREENER_BUDGET_API + MARKET_DEXSCREENER_BUDGET_WORKER must not exceed the documented 300 requests per minute",
      path: ["MARKET_DEXSCREENER_BUDGET_API"],
    });
  }
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
    /**
     * Decision 0089 §8 (S96c): `proxy` publishes every `logo.url` as this
     * API's logo proxy; `upstream` publishes the Decision 0072 origin URL for
     * clients (TestFlight build 7) that refuse any other logo host. Anything
     * else refuses to start.
     */
    TOKEN_LOGO_URL_MODE: z.enum(["proxy", "upstream"]),
    /**
     * Decision 0173: where a project NFT picture goes. `local` (default)
     * stores it like the other media; `filebase` also pins it to IPFS
     * through the Filebase IPFS RPC API (FILEBASE_RPC_ENDPOINT +
     * FILEBASE_RPC_TOKEN, both required then).
     */
    NFT_IMAGE_STORAGE: z.enum(["local", "filebase"]),
    FILEBASE_RPC_ENDPOINT: z.preprocess(
      blankStringToUndefined,
      z.string().url().optional(),
    ),
    FILEBASE_RPC_TOKEN: optionalCredential(4_096),
    /** Decision 0173: the public IPFS gateway, `<base>/<cid>`. */
    IPFS_GATEWAY_BASE_URL: z.string().url(),
    API_DOCS_ENABLED: booleanString,
    TRUST_PROXY: booleanString,
    /** Decision 0147 revision S211: `/public/*` requests per minute per visitor. */
    PUBLIC_RATE_LIMIT_PER_MINUTE: positiveIntegerString(10, 10_000),
    /** Decision 0147 revision S211: forwarded headers the public limiter reads. */
    PUBLIC_CLIENT_IP_HEADERS: z.string().trim().min(1).max(200),
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
    FIREBASE_SERVICE_ACCOUNT_JSON_PATH: optionalCredential(1_024),
    STREAM_API_KEY: optionalCredential(255),
    STREAM_API_SECRET: optionalOpaqueSecret(1, 4_096),
    STREAM_TOKEN_QUOTA_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    STREAM_TOKEN_USER_LIMIT_PER_MINUTE: positiveIntegerString(1, 10_000),
    STREAM_TOKEN_IP_LIMIT_PER_MINUTE: positiveIntegerString(1, 100_000),
    STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF: optionalEvidenceReference,
    SOCIAL_CURSOR_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    SOCIAL_QUOTA_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    PERP_READ_CURSOR_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    HYPERLIQUID_PRIVATE_READS_ENABLED: booleanString,
    HYPERLIQUID_INFO_QUOTA_HMAC_SECRET: optionalOpaqueSecret(32, 4_096),
    HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE: positiveIntegerString(1, 1_200),
    BSC_RPC_URLS: optionalCredential(4_096),
    BSC_CONFIRMATIONS: positiveIntegerString(1, 1_000),
    BSC_REORG_DEPTH_BLOCKS: positiveIntegerString(1, 1_000),
    BSC_LOG_ADDRESS_CHUNK_SIZE: positiveIntegerString(1, 100),
    BSC_USD1_TOKEN_ADDRESS: optionalCredential(64),
    BSC_USD1_VERIFIED: booleanString,
    BSC_WRITES_ENABLED: booleanString,
    BSC_WRITE_CANARY_ASSETS: optionalCredential(4_096),
    BSC_WRITE_CANARY_MAX_USD: z.string().trim().min(1).max(32),
    BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST: optionalCredential(4_096),
    BSC_WRITE_CANARY_DAILY_MAX_USD: optionalCredential(32),
    LOOP_SWAP_FEE_BPS: positiveIntegerString(0, 1_000),
    WALLET_GAS_RESERVE_BNB: z.string().trim().min(1).max(32),
    MINING_MOCK_HOLDINGS_ENABLED: booleanString,
    PASSKEY_ANDROID_PACKAGE: optionalCredential(255),
    PASSKEY_ANDROID_CERT_SHA256: optionalCredential(4_096),
    PASSKEY_IOS_TEAM_ID: optionalCredential(32),
    PASSKEY_IOS_BUNDLE_ID: optionalCredential(255),
    ANDROID_RELEASE_CERT_SHA256: optionalCredential(1_024),
    APP_DOWNLOAD_URL: optionalCredential(2_048),
    APP_STORE_URL_IOS: optionalCredential(2_048),
    APP_STORE_URL_ANDROID: optionalCredential(2_048),
    COMMUNITY_CHAT_REAL_IDENTITY: booleanString,
    RECOMMENDED_COMMUNITY_IDS: optionalCredential(4_096),
    // Decision 0105: hosts an intel promotion `imageUrl` may point at.
    INTEL_PROMOTION_IMAGE_HOSTS: optionalCredential(2_048),
    // Decision 0102: the operator console. All three or the `/admin/*`
    // surface is not mounted.
    ADMIN_USERNAME: optionalCredential(64),
    ADMIN_PASSWORD_HASH: optionalCredential(512),
    ADMIN_SESSION_SECRET: optionalOpaqueSecret(32, 512),
    // Decision 0110: login lock per username and per client address.
    ADMIN_LOGIN_USERNAME_MAX_FAILURES: positiveIntegerString(1, 100),
    ADMIN_LOGIN_USERNAME_LOCK_SECONDS: positiveIntegerString(1, 86_400),
    ADMIN_LOGIN_IP_MAX_FAILURES: positiveIntegerString(1, 10_000),
    ADMIN_LOGIN_IP_WINDOW_SECONDS: positiveIntegerString(1, 86_400),
    ADMIN_LOGIN_IP_LOCK_SECONDS: positiveIntegerString(1, 86_400),
    // Decision 0105: the console's MEME pause/unpause signs with its own
    // operator key; the API process never loads the deployer key.
    MEME_OPERATOR_PRIVATE_KEY: optionalOpaqueSecret(64, 66),
    // Decision 0116: the claim voucher signer and the console test trigger.
    MINING_REWARD_SIGNER_PRIVATE_KEY: optionalOpaqueSecret(64, 66),
    MINING_SETTLEMENT_TEST_TRIGGER: booleanString,
    // Decision 0128: the testnet faucet (tBNB + MockUSD1), BSC Testnet only.
    TESTNET_FAUCET_ENABLED: booleanString,
    TESTNET_FAUCET_BNB_AMOUNT: z.string().trim().min(1).max(40),
    TESTNET_FAUCET_USD1_AMOUNT: z.string().trim().min(1).max(40),
    TESTNET_FAUCET_COOLDOWN_SECONDS: positiveIntegerString(60, 2_592_000),
    TESTNET_FAUCET_OPERATOR_PRIVATE_KEY: optionalOpaqueSecret(64, 66),
    // S156b: explicit override of the USD1 the faucet mints (default: the
    // Hooks Factory's usd1(), i.e. the MEME v2 / launch2 USD1).
    TESTNET_FAUCET_USD1_ADDRESS: optionalCredential(64),
    // S169: operator reserve (shared MEME pause key), global daily caps,
    // failed-retry cooldown, and the pending sweep timeout.
    TESTNET_FAUCET_OPERATOR_RESERVE_BNB: z.string().trim().min(1).max(40),
    TESTNET_FAUCET_DAILY_MAX_GRANTS: positiveIntegerString(1, 100_000),
    TESTNET_FAUCET_DAILY_MAX_BNB: z.string().trim().min(1).max(40),
    TESTNET_FAUCET_FAILED_COOLDOWN_SECONDS: positiveIntegerString(30, 86_400),
    TESTNET_FAUCET_PENDING_TIMEOUT_SECONDS: positiveIntegerString(120, 86_400),
    ...miningSettlementEnvironmentShape,
    ...launchChainEnvironmentShape,
    ...memeEnvironmentShape,
    ...marketEnvironmentShape,
    ...communityAiEnvironmentShape,
    DATABASE_URL: z.string().trim().min(1),
    DATABASE_POOL_MAX: positiveIntegerString(1, 50),
    DATABASE_CONNECTION_TIMEOUT_MS: positiveIntegerString(250, 30_000),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveIntegerString(250, 60_000),
    // Decision 0085: in-memory reuse of one Launch sale snapshot (ms); 0
    // disables it. Default 1500, about half a BSC block interval.
    LAUNCH_SNAPSHOT_CACHE_TTL_MS: positiveIntegerString(0, 10_000),
    // Decision 0077 S83b7b: publish the overview `graduated` available
    // branch. `off` (default) keeps the pre-S83b7b bytes for clients that
    // only decode the unavailable branch. Anything but off/on refuses boot.
    LAUNCH_GRADUATED_LIST: z.enum(["off", "on"]),
    // Decision 0108: Hooks launch configuration / signing / deployment tasks
    // (ported from the requirer branch). `off` (default) keeps every
    // `/v2/launch/projects/{projectId}/hooks-*` route at 503.
    HOOKS_LAUNCH_ENABLED: z.enum(["off", "on"]),
    // Decision 0108: the BSC Testnet Hooks Factory and its expected runtime
    // code hash. Both blank (default) or both set, and only with
    // LAUNCH_CHAIN_ID=97. No address is shipped in source.
    HOOKS_LAUNCH_FACTORY_ADDRESS: optionalCredential(64),
    HOOKS_LAUNCH_FACTORY_CODE_HASH: optionalCredential(66),
    // Decision 0117: minimum NFT sale-start lead a saved config must keep.
    // Default 86400 (production semantics); floor 4200 = the Gate's 3600 s
    // activation buffer + 600 s executor margin; ceiling 30 days.
    HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS: positiveIntegerString(
      hooksLaunchMinimumSaleLeadFloorSeconds,
      2_592_000,
    ),
    // Decision 0122: the fixed buyback recipient of every Hooks config.
    // Blank = Hooks config saves / signing / submissions stay unavailable.
    LAUNCH2_BUYBACK_RECIPIENT: z
      .string()
      .trim()
      .regex(/^0x[0-9a-fA-F]{40}$/u, "must be a 0x-prefixed 20-byte address")
      .optional(),
    // Decision 0114: MEME v2 (`launch2`) quote lifetime and default
    // slippage. The routes exist only with `launch2` in V2_MODULES_ENABLED.
    LAUNCH2_QUOTE_TTL_SECONDS: positiveIntegerString(10, 600),
    LAUNCH2_DEFAULT_SLIPPAGE_BPS: positiveIntegerString(0, 5_000),
    // Decision 0126: the on-chain deadline a curve / pool prepare encodes,
    // counted from the prepare (the approve and the trade are two device
    // signatures). The quote TTL above stays the quote's freshness.
    LAUNCH2_POOL_TRADE_DEADLINE_SECONDS: positiveIntegerString(60, 600),
    // Decision 0166: off|on (default off; any other value refuses boot).
    // off omits the Decision 0162 `account` key from the launch2 trades /
    // activity and skips the wallet → account lookup; on emits it. Turn on
    // only once every supported client (build >= 31) decodes the key.
    LAUNCH2_TRADER_ACCOUNT_EMIT: z.enum(["off", "on"]),
    // Decision 0173: off|on (default off). off omits the optional
    // `nftImageUrl` key from the launch2 instance summary / detail and
    // GET /v2/launch2/me/positions rows; on emits it (null when none). Turn
    // on only once every supported client decodes the key.
    LAUNCH2_NFT_IMAGE_EMIT: z.enum(["off", "on"]),
    // Decision 0174: off|on (default off). off omits the optional
    // `priceUsd1` / `valueUsd1` / `priceSource` keys from the
    // GET /v2/launch2/me/positions rows; on emits them (null when there is
    // no price). Turn on only once every supported client decodes them.
    LAUNCH2_POSITION_VALUE_EMIT: z.enum(["off", "on"]),
    // Decision 0176: off|on (default off). off omits the optional
    // `avgCostUsd1` / `costBasisUsd1` / `realizedPnlUsd1` /
    // `unrealizedPnlUsd1` / `costCoverage` keys from the
    // GET /v2/launch2/me/positions rows and the instance detail's `viewer`;
    // on emits them. Turn on only once every supported client decodes them.
    LAUNCH2_PNL_EMIT: z.enum(["off", "on"]),
    // Decision 0166: off|on (default off). off keeps GET /v2/referral in its
    // pre-0162 shape (no inviteLink / stats, boost always unavailable); on
    // emits them. Turn on only once every supported client is at build >= 31.
    REFERRAL_CENTER_EMIT: z.enum(["off", "on"]),
    // Decision 0167: off|on (default off). off keeps
    // GET /v2/wallets/{walletId}/activity byte-identical to before (ERC-20
    // rows of the primary chain only, the block / log cursor); on merges the
    // wallet's MEME v2 (launch2) activity on the Launch chain into the same
    // list and adds the `launch2` block. Turn on only once every supported
    // client decodes the new row shape (build >= 32).
    WALLET_ACTIVITY_LAUNCH2_EMIT: z.enum(["off", "on"]),
    // Decision 0169: off|on (default off). off keeps
    // GET /v2/profiles/{id}/holdings and /trades byte-identical (primary
    // chain only); on mixes the owner's MEME v2 (launch2) holdings / activity
    // on the Launch chain into `items` and adds the optional `launch2` block.
    // Turn on only once every supported client decodes them (build >= 34).
    PROFILE_LAUNCH2_EMIT: z.enum(["off", "on"]),
    // Decision 0175: off|on (default off). off keeps every /v2 community
    // projection byte-identical; on adds the optional `label` key (the
    // operator-set custom community label, or null) next to
    // `verificationStatus`. Turn on only once every supported client decodes
    // the key.
    COMMUNITY_LABEL_EMIT: z.enum(["off", "on"]),
    // Decision 0186: off|on (default off). off keeps the market list rows
    // (category items, overview watchlist / trending items) byte-identical;
    // on adds the optional `sparkline24h` key (decimal strings or null).
    // Turn on only once every supported client decodes the key.
    MARKET_ROW_SPARKLINE24H_EMIT: z.enum(["off", "on"]),
    // Decision 0177: off|on (default off). off hides the four fine inbox
    // events (launch.graduated, launch.badge_minted, social.friend_request,
    // social.friend_accepted) from the feed, unread counts and read-all
    // (rows are still written). Turn on only once every supported client
    // decodes the new feed `type` values.
    NOTIFICATION_INBOX_EMIT: z.enum(["off", "on"]),
    // Decision 0178: off|on (default off). off hides the four launch review
    // / deployment progress events (launch.review_approved,
    // launch.review_rejected, launch.activated, launch.deploy_failed) from
    // the feed, unread counts, read-all and the single read (rows are still
    // written). Turn on only once every supported client decodes them.
    LAUNCH_REVIEW_INBOX_EMIT: z.enum(["off", "on"]),
    // Decision 0185: off|on (default off). off keeps GET /v2/wallets and
    // PUT /v2/wallets/active byte-identical; on adds the optional
    // `externalWalletLimit` key and the per-wallet `archivedReason` key.
    // POST /v2/wallets/sync (new) always carries them. Turn on only once
    // every supported client decodes the keys.
    WALLET_LINK_POLICY_EMIT: z.enum(["off", "on"]),
    // Decision 0185: true|false (default false; any other value refuses
    // boot). false = a trader / holder address that belongs to an account
    // only through an *external* wallet is never shown next to that account
    // (trade feeds stay bare chain addresses) and another viewer's read of a
    // public profile uses the owner's embedded wallet, never an external one.
    EXTERNAL_WALLET_ADDRESS_PUBLIC: booleanString,
    // Decision 0124: the official-pool swap router (OfficialPoolRouter) and
    // its runtime code hash, one unit, BSC Testnet only. Blank = the pool
    // quote / prepare stay 503 POOL_ROUTER_NOT_CONFIGURED.
    LAUNCH2_POOL_ROUTER_ADDRESS: optionalCredential(64),
    LAUNCH2_POOL_ROUTER_CODE_HASH: optionalCredential(66),
    // Decision 0131: which official-pool Hook kind new Hooks launches use
    // (officialTax default). Decision 0132: loopDynamic saves, reviews and
    // signs for the LoopDynamic Factory below (blank = those stay 503).
    HOOKS_LAUNCH_HOOK_KIND: z.enum(["officialTax", "loopDynamic"]),
    LAUNCH2_DYNAMIC_FACTORY_ADDRESS: optionalCredential(64),
    LAUNCH2_DYNAMIC_FACTORY_CODE_HASH: optionalCredential(66),
    // Decision 0131: the shared LoopRouter of LoopDynamic pools and its
    // runtime code hash (one unit, BSC Testnet only), plus the optional
    // trusted-router list every LoopDynamic Hook must point at. Blank keeps
    // LoopDynamic quotes / prepares / reads 503.
    LAUNCH2_DYNAMIC_ROUTER_ADDRESS: optionalCredential(64),
    LAUNCH2_DYNAMIC_ROUTER_CODE_HASH: optionalCredential(66),
    LAUNCH2_DYNAMIC_ROUTER_REGISTRY_ADDRESS: z
      .string()
      .trim()
      .regex(/^0x[0-9a-fA-F]{40}$/u, "must be a 0x-prefixed 20-byte address")
      .optional(),
    // Decision 0153: the API resolves a LoopDynamic instance's router from
    // its own Factory; the trusted older LoopDynamic Factories are the v3
    // entries of the worker's list (same value, same validation).
    LAUNCH2_LEGACY_FACTORIES: optionalCredential(2_048),
    // Decision 0153: further accepted LoopRouter runtime code hashes (older
    // Factories' routers), comma-separated; blank = only
    // LAUNCH2_DYNAMIC_ROUTER_CODE_HASH.
    LAUNCH2_DYNAMIC_LEGACY_ROUTER_CODE_HASHES: z.preprocess(
      blankStringToUndefined,
      z
        .string()
        .trim()
        .regex(
          /^0x[0-9a-fA-F]{64}(\s*,\s*0x[0-9a-fA-F]{64})*$/u,
          "must be comma-separated 0x-prefixed 32-byte hashes",
        )
        .optional(),
    ),
  })
  .superRefine((value, context) => {
    refineAddressCodeHashPair(
      value,
      context,
      "LAUNCH2_DYNAMIC_ROUTER_ADDRESS",
      "LAUNCH2_DYNAMIC_ROUTER_CODE_HASH",
    );
    refineAddressCodeHashPair(
      value,
      context,
      "LAUNCH2_DYNAMIC_FACTORY_ADDRESS",
      "LAUNCH2_DYNAMIC_FACTORY_CODE_HASH",
    );
    refineMarketEnvironment(value, context);
    refineLaunchChainEnvironment(value, context);
    refineLaunchContractEnvironment(value, context);
    refineHooksLaunchFactoryEnvironment(value, context);
    refineLaunch2PoolRouterEnvironment(value, context);
    // Decision 0128: the faucet signs on BSC Testnet only. Deliberately not
    // bound to NODE_ENV: staging is production on chain 97.
    if (value.TESTNET_FAUCET_ENABLED && value.LAUNCH_CHAIN_ID !== "97") {
      context.addIssue({
        code: "custom",
        message:
          "TESTNET_FAUCET_ENABLED is permitted only when LAUNCH_CHAIN_ID=97 (BSC Mainnet signing stays closed)",
        path: ["TESTNET_FAUCET_ENABLED"],
      });
    }
    // Decision 0061: the seeded holdings are a Development instrument. A
    // production process refuses to start rather than compute a number from
    // a balance nobody observed on chain.
    if (value.MINING_MOCK_HOLDINGS_ENABLED && value.NODE_ENV === "production") {
      context.addIssue({
        code: "custom",
        message:
          "MINING_MOCK_HOLDINGS_ENABLED must not be set under NODE_ENV=production",
        path: ["MINING_MOCK_HOLDINGS_ENABLED"],
      });
    }
    if (value.BSC_WRITES_ENABLED) {
      if (value.BSC_RPC_URLS === undefined) {
        context.addIssue({
          code: "custom",
          message: "BSC_WRITES_ENABLED requires BSC_RPC_URLS",
          path: ["BSC_WRITES_ENABLED"],
        });
      }
      if (value.BSC_WRITE_CANARY_ASSETS === undefined) {
        context.addIssue({
          code: "custom",
          message:
            "BSC_WRITES_ENABLED requires a BSC_WRITE_CANARY_ASSETS allowlist",
          path: ["BSC_WRITE_CANARY_ASSETS"],
        });
      }
    }
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
    // S169: the `testnet_faucet_pending_sweep` lane (Decision 0128 §9).
    // Decision 0150: the repository-wide write switch, read here only as
    // the extra mainnet gate of the server-signed launch-slot lanes (56 +
    // LAUNCH_MAINNET_ACK). BSC Testnet lanes do not consult it.
    BSC_WRITES_ENABLED: booleanString,
    TESTNET_FAUCET_ENABLED: booleanString,
    TESTNET_FAUCET_PENDING_TIMEOUT_SECONDS: positiveIntegerString(120, 86_400),
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
    LAUNCH_INDEXER_ENABLED: booleanString,
    MEME_INDEXER_ENABLED: booleanString,
    LAUNCH2_INDEXER_ENABLED: booleanString,
    LAUNCH2_INDEXER_POLL_INTERVAL_MS: positiveIntegerString(1_000, 600_000),
    // Decision 0122: read-only older Factories (`v2:0x…,…`) the
    // launch2_event lane keeps indexing beside HOOKS_LAUNCH_FACTORY_ADDRESS.
    LAUNCH2_LEGACY_FACTORIES: optionalCredential(2_048),
    // Decision 0126: the lane attributes official-pool swaps to wallets
    // through this router's Swap events (same unit as the API's pair).
    LAUNCH2_POOL_ROUTER_ADDRESS: optionalCredential(64),
    LAUNCH2_POOL_ROUTER_CODE_HASH: optionalCredential(66),
    // Decision 0131: the LoopDynamic Factory the lane indexes beside the
    // OfficialTax one (one unit, BSC Testnet only), the Hook kind of new
    // launches (Decision 0132: loopDynamic = the executor targets this pair),
    // and the default-off `poke()` keeper of armed LoopDynamic rounds.
    HOOKS_LAUNCH_HOOK_KIND: z.enum(["officialTax", "loopDynamic"]),
    LAUNCH2_DYNAMIC_FACTORY_ADDRESS: optionalCredential(64),
    LAUNCH2_DYNAMIC_FACTORY_CODE_HASH: optionalCredential(66),
    LAUNCH2_DYNAMIC_POKE_ENABLED: booleanString,
    LAUNCH2_DYNAMIC_POKE_PRIVATE_KEY: optionalOpaqueSecret(64, 66),
    LAUNCH2_DYNAMIC_POKE_INTERVAL_SECONDS: positiveIntegerString(15, 3_600),
    MEME_GRADUATION_EXECUTOR_ENABLED: booleanString,
    MEME_GRADUATION_DELAY_SECONDS: positiveIntegerString(0, 600),
    LAUNCH_DEPLOYER_PRIVATE_KEY: optionalOpaqueSecret(64, 66),
    BSC_INDEXER_START_BLOCK: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    BSC_INDEXER_WALLET_TOPIC_CHUNK_SIZE: positiveIntegerString(1, 1_000),
    BSC_RPC_URLS: optionalCredential(4_096),
    BSC_CONFIRMATIONS: positiveIntegerString(1, 1_000),
    BSC_REORG_DEPTH_BLOCKS: positiveIntegerString(1, 1_000),
    BSC_LOG_ADDRESS_CHUNK_SIZE: positiveIntegerString(1, 100),
    ALERT_EVALUATOR_ENABLED: booleanString,
    ALERT_NOTIFICATION_DEDUPE_SECONDS: positiveIntegerString(60, 86_400),
    MARKET_SPARKLINE_WARM_ENABLED: booleanString,
    MARKET_SPARKLINE_WARM_INTERVAL_MS: positiveIntegerString(1_000, 60_000),
    TOKEN_LOGO_PREWARM_ENABLED: booleanString,
    TOKEN_LOGO_PREWARM_INTERVAL_MS: positiveIntegerString(60_000, 86_400_000),
    TOKEN_LOGO_PREWARM_HOT_LIMIT: z.coerce.number().int().min(0).max(200),
    VOICE_ROOM_REAPER_ENABLED: booleanString,
    COMMUNITY_CHAT_REAL_IDENTITY: booleanString,
    PUBLIC_BASE_URL: z.string().url(),
    VOICE_ROOM_REAPER_INTERVAL_MS: positiveIntegerString(5_000, 3_600_000),
    VOICE_ROOM_IDLE_END_MINUTES: positiveIntegerString(1, 1_440),
    VOICE_ROOM_MAX_LIVE_HOURS: positiveIntegerString(1, 168),
    // Decision 0172: the friend_direct_channel lane (default on) and its
    // one-time backfill sweep (default off).
    FRIEND_DIRECT_CHANNEL_ENABLED: booleanString,
    FRIEND_DIRECT_CHANNEL_INTERVAL_MS: positiveIntegerString(1_000, 600_000),
    FRIEND_CHANNEL_BACKFILL_ENABLED: booleanString,
    // Decision 0177: the notification_inbox lane (default on) and the emit
    // switch that lets it push the four fine inbox events (default off).
    NOTIFICATION_INBOX_ENABLED: booleanString,
    NOTIFICATION_INBOX_INTERVAL_MS: positiveIntegerString(1_000, 600_000),
    NOTIFICATION_INBOX_EMIT: z.enum(["off", "on"]),
    // Decision 0178: lets the notification_inbox lane push the four launch
    // review / deployment progress events (default off).
    LAUNCH_REVIEW_INBOX_EMIT: z.enum(["off", "on"]),
    COMMUNITY_MEMBER_BUY_FEED_ENABLED: booleanString,
    COMMUNITY_MEMBER_BUY_FEED_INTERVAL_MS: positiveIntegerString(
      5_000,
      600_000,
    ),
    SQUARE_FEED_INGEST_ENABLED: booleanString,
    SQUARE_FEED_INGEST_INTERVAL_MS: positiveIntegerString(5_000, 3_600_000),
    // Decision 0145: the wallet_networth_snapshot lane, default on.
    WALLET_NETWORTH_SNAPSHOT_ENABLED: booleanString,
    WALLET_NETWORTH_SNAPSHOT_INTERVAL_MS: positiveIntegerString(
      60_000,
      86_400_000,
    ),
    WALLET_NETWORTH_SNAPSHOT_BATCH: positiveIntegerString(1, 1_000),
    // Decision 0149: the fiat_fx_rate lane, default on.
    FIAT_FX_RATE_ENABLED: booleanString,
    FIAT_FX_PROVIDER_URL: z.string().trim().min(1).max(512),
    FIAT_FX_REFRESH_SECONDS: positiveIntegerString(60, 86_400),
    BSC_USD1_TOKEN_ADDRESS: optionalCredential(64),
    BSC_USD1_VERIFIED: booleanString,
    WALLET_INTENT_RECONCILE_ENABLED: booleanString,
    MINING_SNAPSHOT_ENABLED: booleanString,
    // Decision 0116: the mining_hourly_settlement lane, default off.
    MINING_SETTLEMENT_ENABLED: booleanString,
    MINING_SETTLEMENT_POLL_INTERVAL_MS: positiveIntegerString(5_000, 3_600_000),
    MINING_SETTLEMENT_CATCHUP_HOURS: positiveIntegerString(1, 720),
    ...miningSettlementEnvironmentShape,
    MINING_MOCK_HOLDINGS_ENABLED: booleanString,
    PRIVY_APP_ID: optionalCredential(255),
    PRIVY_APP_SECRET: optionalCredential(4_096),
    FIREBASE_SERVICE_ACCOUNT_JSON_PATH: optionalCredential(1_024),
    ...launchChainEnvironmentShape,
    ...memeEnvironmentShape,
    ...marketEnvironmentShape,
    HOOKS_LAUNCH_FACTORY_ADDRESS: optionalCredential(64),
    HOOKS_LAUNCH_FACTORY_CODE_HASH: optionalCredential(66),
    HOOKS_LAUNCH_EXECUTOR_ENABLED: z.enum(["off", "on"]),
    HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: optionalOpaqueSecret(64, 66),
    HOOKS_LAUNCH_EXECUTOR_CONFIRMATIONS: positiveIntegerString(1, 64),
    HOOKS_LAUNCH_EXECUTOR_POLL_INTERVAL_MS: positiveIntegerString(
      1_000,
      600_000,
    ),
    HOOKS_LAUNCH_EXECUTOR_LEASE_SECONDS: positiveIntegerString(30, 3_600),
    HOOKS_LAUNCH_EXECUTOR_MAX_ATTEMPTS: positiveIntegerString(1, 10),
    HOOKS_LAUNCH_EXECUTOR_RETRY_DELAY_SECONDS: positiveIntegerString(
      10,
      86_400,
    ),
    HOOKS_LAUNCH_EXECUTOR_GAS_LIMIT_CAP: positiveIntegerString(
      1_000_000,
      30_000_000,
    ),
    HOOKS_LAUNCH_EXECUTOR_MAX_GAS_PRICE_GWEI: positiveIntegerString(1, 1_000),
    LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED: booleanString,
    LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: optionalOpaqueSecret(1, 1_024),
    LAUNCH2_SNAPSHOT_SUBMITTER_PRIVATE_KEY: optionalOpaqueSecret(64, 66),
    LAUNCH2_SNAPSHOT_PUBLISHER_POLL_INTERVAL_MS: positiveIntegerString(
      1_000,
      600_000,
    ),
    LAUNCH2_SNAPSHOT_PUBLISHER_CONFIRMATIONS: positiveIntegerString(1, 64),
    LAUNCH2_SNAPSHOT_PUBLISHER_MAX_GAS_PRICE_GWEI: positiveIntegerString(
      1,
      1_000,
    ),
    // Decision 0121: the launch2_buyback_keeper lane, default off.
    LAUNCH2_BUYBACK_KEEPER_ENABLED: booleanString,
    LAUNCH2_BUYBACK_KEEPER_PRIVATE_KEY: optionalOpaqueSecret(64, 66),
    LAUNCH2_BUYBACK_KEEPER_INTERVAL_SECONDS: positiveIntegerString(10, 3_600),
    LAUNCH2_BUYBACK_KEEPER_CONFIRMATIONS: positiveIntegerString(1, 64),
    DATABASE_URL: z.string().trim().min(1),
    DATABASE_POOL_MAX: positiveIntegerString(1, 50),
    DATABASE_CONNECTION_TIMEOUT_MS: positiveIntegerString(250, 30_000),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveIntegerString(250, 60_000),
  })
  .superRefine((value, context) => {
    refineMarketEnvironment(value, context);
    refineLaunchChainEnvironment(value, context);
    refineLaunchContractEnvironment(value, context);
    refineHooksLaunchFactoryEnvironment(value, context);
    refineLaunch2PoolRouterEnvironment(value, context);
    refineAddressCodeHashPair(
      value,
      context,
      "LAUNCH2_DYNAMIC_FACTORY_ADDRESS",
      "LAUNCH2_DYNAMIC_FACTORY_CODE_HASH",
    );
    // Decision 0061: the seeded holdings are a Development instrument. A
    // production process refuses to start rather than compute a number from
    // a balance nobody observed on chain.
    if (value.MINING_MOCK_HOLDINGS_ENABLED && value.NODE_ENV === "production") {
      context.addIssue({
        code: "custom",
        message:
          "MINING_MOCK_HOLDINGS_ENABLED must not be set under NODE_ENV=production",
        path: ["MINING_MOCK_HOLDINGS_ENABLED"],
      });
    }
    // Privy credentials only matter to this process when the wallet-intent
    // lane is on; a partial pair is then an error, otherwise it is ignored.
    if (
      value.WALLET_INTENT_RECONCILE_ENABLED &&
      (value.PRIVY_APP_ID !== undefined) !==
        (value.PRIVY_APP_SECRET !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "PRIVY_APP_ID and PRIVY_APP_SECRET must be configured together",
        path: ["PRIVY_APP_ID"],
      });
    }
    if (
      value.WALLET_INTENT_RECONCILE_ENABLED &&
      value.BSC_RPC_URLS === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "The wallet-intent reconciliation lane requires BSC_RPC_URLS",
        path: ["WALLET_INTENT_RECONCILE_ENABLED"],
      });
    }
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
  /**
   * Token addresses per `eth_getLogs` request (Decision 0078,
   * `BSC_LOG_ADDRESS_CHUNK_SIZE`, 1-100, default 8).
   */
  readonly logAddressChunkSize: number;
  /** Present only when the address is configured and independently verified. */
  readonly usd1TokenAddress: string | null;
}

/**
 * The `launch` chain slot (Decision 0038). Always present: with
 * `LAUNCH_CHAIN_ID=56` it mirrors the primary slot (`sharedWithPrimary`), with
 * `97` it names the BSC testnet and carries its own endpoint list, which may
 * be empty (the slot then fails closed with LAUNCH_CHAIN_RPC_NOT_CONFIGURED).
 * Like `BscChainConfig`, a present endpoint is not proof of reachability or of
 * the chain it serves; `eth_chainId` is verified at runtime.
 */
export interface LaunchChainConfig {
  readonly chainId: LaunchChainId;
  readonly chainReference: LaunchChainReference;
  readonly rpcUrls: readonly string[];
  readonly confirmations: number;
  readonly reorgDepthBlocks: number;
  /** Always the primary `BSC_LOG_ADDRESS_CHUNK_SIZE` (Decision 0078). */
  readonly logAddressChunkSize: number;
  readonly sharedWithPrimary: boolean;
  /**
   * Decision 0150: `LAUNCH_CHAIN_ID=56` with the exact `LAUNCH_MAINNET_ACK`
   * phrase. Always false on 97 (the ack is refused there).
   */
  readonly mainnetAcknowledged: boolean;
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

/**
 * Passkey relying-party association (Decision 0063). The API origin is the
 * relying party for LOOP passkeys, so it must publish the two static files the
 * platform credential managers fetch before they will bind a credential
 * created under this origin to the app.
 *
 * The two halves are independent and both are fail-closed: without signing
 * fingerprints there is no `assetlinks.json`, and without an Apple Team ID
 * there is no `apple-app-site-association`. An empty or placeholder file would
 * let a wrong association look configured, which is worse than a 404.
 */
export interface PasskeyRelyingPartyConfig {
  readonly android: PasskeyAndroidConfig | null;
  readonly ios: PasskeyIosConfig | null;
}

export interface PasskeyAndroidConfig {
  readonly packageName: string;
  /**
   * Signing-certificate SHA-256 fingerprints, uppercase hex byte pairs joined
   * by colons, in configuration order. Every keystore that signs a build which
   * must reach these credentials needs an entry (debug, profile, release).
   */
  readonly certificateFingerprints: readonly string[];
}

export interface PasskeyIosConfig {
  /** `<TEAMID>.<BUNDLEID>`, the value Apple calls an application identifier. */
  readonly appId: string;
}

/**
 * Universal Links / App Links for shared LOOP ID links (Decision 0090). The
 * Android package and the Development debug keystore fingerprint are fixed
 * public facts of the LOOP app build; the iOS application identifier
 * (Decision 0106), the release signing fingerprint(s), and the optional
 * download link for the landing pages come from the environment.
 */
export interface AppLinksConfig {
  /**
   * `<TEAMID>.<BUNDLEID>` identifiers claimed for `/u/*` and `/c/*`, derived
   * from `PASSKEY_IOS_TEAM_ID` + `PASSKEY_IOS_BUNDLE_ID` (Decision 0106).
   * Empty when no Team ID is configured: no iOS app is claimed at all.
   */
  readonly iosAppIds: readonly string[];
  readonly androidPackage: string;
  /** Debug keystore first, then `ANDROID_RELEASE_CERT_SHA256` entries. */
  readonly androidCertificateFingerprints: readonly string[];
  /** `APP_DOWNLOAD_URL`; `null` hides the download link on the landing page. */
  readonly downloadUrl: string | null;
  /**
   * Decision 0162: `APP_STORE_URL_IOS` / `APP_STORE_URL_ANDROID` (https) for
   * the `/i/{code}` invite page; `null` hides that store button.
   */
  readonly iosStoreUrl: string | null;
  readonly androidStoreUrl: string | null;
}

/**
 * Decision 0179: the cross-origin web registration surface `/v2/web/*`.
 * `origins` empty (default) = the surface is not mounted at all.
 */
export interface WebSurfaceConfig {
  /** `WEB_ORIGINS`: normalised origins (`URL.origin`), unique, in order. */
  readonly origins: readonly string[];
  /** `WEB_BASE_URL` without a trailing slash; null keeps `/i/{code}` local. */
  readonly baseUrl: string | null;
  /** `WEB_APP_LINKS_IOS` / `_ANDROID` / `_TESTFLIGHT` (https or null). */
  readonly appLinks: {
    readonly ios: string | null;
    readonly android: string | null;
    readonly testflight: string | null;
  };
}

export interface BscIndexerConfig {
  readonly startBlockNumber: number | null;
  /**
   * Wallet addresses per topic OR array of one `eth_getLogs` request
   * (Decision 0075, `BSC_INDEXER_WALLET_TOPIC_CHUNK_SIZE`, 1-1000, default
   * 200).
   */
  readonly walletTopicChunkSize: number;
}

/**
 * BSC write admission (Decision 0035). Present only when
 * `BSC_WRITES_ENABLED=true`; absent means every prepare, broadcast report, and
 * Provider execute fails closed with CAPABILITY_UNAVAILABLE. Enabling writes
 * additionally requires an explicit canary asset allowlist and a per-intent USD
 * ceiling; an intent whose value cannot be priced is never admitted.
 */
export interface BscWriteConfig {
  readonly configVersion: "bscWriteCanaryV1";
  readonly canaryAssetIds: readonly string[];
  /** Canonical decimal USD ceiling per intent (default 20). */
  readonly canaryMaxUsd: string;
  /**
   * Rolling 24-hour USD ceiling across every intent of one account that may
   * still spend (Decision 0065). `null` means no cumulative ceiling.
   */
  readonly canaryDailyMaxUsd: string | null;
  /**
   * Lowercase counterparty allowlist (send recipient, approve/revoke
   * spender). Empty means every counterparty is admitted; the per-intent and
   * daily ceilings are then the only quantitative guards.
   */
  readonly canaryCounterpartyAddresses: readonly string[];
  /** Platform fee slot for Privy Swap; `null` sends no fee_configuration. */
  readonly swapFeeBps: number | null;
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
    /** Per-process minute budgets; api + worker never exceed the documented 300. */
    readonly budgetApiPerMinute: number;
    readonly budgetWorkerPerMinute: number;
  };
  readonly geckoterminal: {
    readonly enabled: boolean;
    /** The API process throttle. */
    readonly rateLimitPerMinute: number;
    /** The worker process throttle (Decision 0074); the two share one egress. */
    readonly budgetWorkerPerMinute: number;
  };
  readonly goplus: GoplusConfig | null;
  readonly priceTtlSeconds: number;
  readonly securityTtlSeconds: number;
  readonly candlesTtlSeconds: number;
  /** Row sparkline row TTL (Decision 0074). */
  readonly sparklineTtlSeconds: number;
  /** Seconds past TTL during which a cached fact may still be served as stale. */
  readonly staleGraceSeconds: number;
  /**
   * Unregistered-address lookup (Decision 0058): price-class facts and the
   * identity (symbol/name/decimals) of a token the registry does not know.
   */
  readonly unlistedPriceTtlSeconds: number;
  readonly unlistedMetadataTtlSeconds: number;
}

/**
 * Community AI runtime (Decision 0066). `null` means no API key was supplied
 * (neither `COMMUNITY_AI_API_KEY` nor `ANTHROPIC_API_KEY`): the capability is
 * `deferred` and no answer is ever produced.
 */
export interface CommunityAiConfig {
  /** Never logged, never echoed, never part of an error body. */
  readonly apiKey: string;
  /**
   * Anthropic-compatible Provider origin (`https://api.anthropic.com` or an
   * Anthropic-compatible gateway such as `https://api.onlyrouter.ai`). Never
   * published to a client; the adapter appends `/v1/messages`.
   */
  readonly baseUrl: string;
  readonly model: string;
  /** Per-request Provider ceiling for `ask`; below the HTTP deadlines. */
  readonly timeoutMs: number;
  /** Ceiling for one background brief generation; independent of HTTP. */
  readonly briefTimeoutMs: number;
  readonly maximumOutputTokens: number;
  readonly userRateLimitPerMinute: number;
  readonly communityDailyLimit: number;
  readonly briefCacheSeconds: number;
}

export interface AlertEvaluatorConfig {
  readonly notificationDedupeSeconds: number;
}

export interface V2CursorConfig {
  readonly hmacSecret: string;
  readonly ttlSeconds: 600;
}

export interface PushConfig {
  /** Absolute or process-relative path; never the credential itself. */
  readonly serviceAccountJsonPath: string;
}

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly publicBaseUrl: string;
  /** Which URL `logo.url` carries (Decision 0089 §8). */
  readonly tokenLogoUrlMode: "proxy" | "upstream";
  /**
   * Decision 0173: NFT_IMAGE_STORAGE. `filebase` carries the RPC endpoint
   * and bearer token (a secret: never logged or returned).
   */
  readonly nftImageStorage:
    | { readonly mode: "local" }
    | {
        readonly mode: "filebase";
        readonly rpcEndpoint: string;
        readonly rpcToken: string;
      };
  /** Decision 0173: IPFS_GATEWAY_BASE_URL without a trailing slash. */
  readonly ipfsGatewayBaseUrl: string;
  readonly apiDocsEnabled: boolean;
  readonly trustProxy: boolean;
  /**
   * Decision 0147 revision S211: the public surface's rate limit (requests
   * per one-minute window per visitor, per process) and the forwarded
   * headers (in order) that name the visitor when `trustProxy` is on.
   */
  readonly publicRateLimit: {
    readonly perMinute: number;
    readonly clientIpHeaders: readonly PublicClientIpHeaderName[];
  };
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
  /**
   * Operator confirmation of the Decision 0005/0032 audio-room role evidence
   * (Decision 0039): the archived Stream Dashboard reference proving the
   * `user` role cannot create an `audio_room` call. `null` keeps
   * `voiceRooms.evidence` pending; a value publishes it as `confirmed`. It
   * never changes availability, which the communication runtime decides.
   */
  readonly streamAudioRoomUserRoleEvidenceRef: string | null;
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
  /** The `launch` chain slot (Decision 0038); never null. */
  readonly launchChain: LaunchChainConfig;
  /** The Launch contract on that slot (Decision 0076); null keeps it unavailable. */
  readonly launchContract: LaunchContractConfig | null;
  /**
   * Decision 0085: how long (ms) one successful sale snapshot is reused by
   * the Launch detail/eligibility reads. 0 disables the cache.
   */
  readonly launchSnapshotCacheTtlMs: number;
  /**
   * Decision 0077 S83b7b: whether `GET /v2/launch/overview` may publish the
   * `graduated` available branch. False keeps it byte-identical to before
   * (`LAUNCH_CONTRACT_BASELINE_PENDING`) even with a configured contract.
   */
  readonly launchGraduatedListEnabled: boolean;
  /** Decision 0166: REFERRAL_CENTER_EMIT === "on" (default off). */
  readonly referralCenterEmit: boolean;
  /** Decision 0167: WALLET_ACTIVITY_LAUNCH2_EMIT === "on" (default off). */
  readonly walletActivityLaunch2Emit: boolean;
  /** Decision 0169: PROFILE_LAUNCH2_EMIT === "on" (default off). */
  readonly profileLaunch2Emit: boolean;
  /** Decision 0175: COMMUNITY_LABEL_EMIT === "on" (default off). */
  readonly communityLabelEmit: boolean;
  /** Decision 0186: MARKET_ROW_SPARKLINE24H_EMIT === "on" (default off). */
  readonly marketRowSparkline24hEmit: boolean;
  /** Decision 0177: NOTIFICATION_INBOX_EMIT === "on" (default off). */
  readonly notificationInboxEmit: boolean;
  /** Decision 0178: LAUNCH_REVIEW_INBOX_EMIT === "on" (default off). */
  readonly launchReviewInboxEmit: boolean;
  /** Decision 0185: WALLET_LINK_POLICY_EMIT === "on" (default off). */
  readonly walletLinkPolicyEmit: boolean;
  /** Decision 0185: EXTERNAL_WALLET_ADDRESS_PUBLIC (default false). */
  readonly externalWalletAddressPublic: boolean;
  /**
   * Decision 0108: Hooks launch configuration, signing preparation, and
   * deployment tasks. `enabled` false keeps every hooks route at 503; a null
   * Factory keeps signing preparation and submission unavailable.
   */
  readonly hooksLaunch: HooksLaunchConfig;
  /** MEME curve launchpad (Decision 0101); `contract` null keeps it unavailable. */
  readonly meme: MemeConfig;
  /**
   * Decision 0114: MEME v2 read model. The Factory comes from `hooksLaunch`
   * (HOOKS_LAUNCH_FACTORY_ADDRESS); these are the quote knobs.
   */
  readonly launch2: {
    readonly quoteTtlSeconds: number;
    readonly defaultSlippageBps: number;
    /** Decision 0126: LAUNCH2_POOL_TRADE_DEADLINE_SECONDS (default 180). */
    readonly tradeDeadlineSeconds: number;
    /**
     * Decision 0166: LAUNCH2_TRADER_ACCOUNT_EMIT === "on". False (default)
     * omits the trader `account` key and skips the directory lookup.
     */
    readonly traderAccountEmit: boolean;
    /**
     * Decision 0173: LAUNCH2_NFT_IMAGE_EMIT === "on". False (default) omits
     * the `nftImageUrl` key from the instance / position projections.
     */
    readonly nftImageEmit: boolean;
    /**
     * Decision 0174: LAUNCH2_POSITION_VALUE_EMIT === "on". False (default)
     * omits the price / value keys from the position rows.
     */
    readonly positionValueEmit: boolean;
    /**
     * Decision 0176: LAUNCH2_PNL_EMIT === "on". False (default) omits the
     * cost / PnL keys from the position rows and the detail's viewer.
     */
    readonly pnlEmit: boolean;
    /**
     * Decision 0124: LAUNCH2_POOL_ROUTER_ADDRESS / _CODE_HASH (lower-case);
     * null keeps the official-pool quote / prepare unavailable.
     */
    readonly poolRouter: {
      readonly address: string;
      readonly codeHash: string;
    } | null;
    /**
     * Decision 0131: HOOKS_LAUNCH_HOOK_KIND (default officialTax) — the
     * official-pool Hook kind of new Hooks launches.
     */
    readonly hookKind: "officialTax" | "loopDynamic";
    /**
     * Decision 0131: LAUNCH2_DYNAMIC_ROUTER_ADDRESS / _CODE_HASH (LoopRouter,
     * lower-case); null keeps the LoopDynamic routes / branches 503.
     */
    readonly dynamicRouter: {
      readonly address: string;
      readonly codeHash: string;
    } | null;
    /** Decision 0131: LAUNCH2_DYNAMIC_ROUTER_REGISTRY_ADDRESS (lower-case). */
    readonly dynamicRouterRegistry: string | null;
    /**
     * Decision 0153: the v3 entries of LAUNCH2_LEGACY_FACTORIES (lower-case)
     * — the older LoopDynamic Factories whose instances stay readable and
     * tradable through their own Factory's LoopRouter.
     */
    readonly dynamicLegacyFactories: readonly string[];
    /** Decision 0153: LAUNCH2_DYNAMIC_LEGACY_ROUTER_CODE_HASHES (lower-case). */
    readonly dynamicLegacyRouterCodeHashes: readonly string[];
  };
  /**
   * Decision 0061: whether the `mining-snapshot` lane counts the
   * Development seed's `mock_seed` balances. Default false; the schema
   * refuses it under `NODE_ENV=production`. Only `pnpm mining:snapshot`
   * reads it out of this config; the API process never computes a snapshot.
   */
  readonly miningMockHoldingsEnabled: boolean;
  /** Decision 0116: hourly settlement (claim signer, contract, test trigger). */
  readonly miningSettlement: MiningSettlementApiConfig;
  /**
   * Decision 0135: chain guard alert outlets (a console manual resolve is
   * announced from the API process); absent / null = none.
   */
  readonly chainGuardAlerts?: ChainGuardAlertConfig | null;
  /**
   * Decision 0136: `CHAIN_GUARD_ENABLED` (the worker's switch) also makes
   * the launch2 routes refuse writes under a chain guard hold; absent /
   * false = no hold is applied (behaviour before 0136).
   */
  readonly chainGuardEnabled?: boolean;
  readonly walletGasReserve: WalletGasReserveConfig;
  /** Passkey association files published at `/.well-known` (Decision 0063). */
  readonly passkeyRelyingParty: PasskeyRelyingPartyConfig;
  /** Universal Links / App Links for `/u/{loopId}` (Decision 0090). */
  readonly appLinks: AppLinksConfig;
  /** Decision 0179: web registration surface (CORS allowlist, links). */
  readonly web: WebSurfaceConfig;
  /** `null` keeps every funds-moving path closed. */
  readonly bscWrites: BscWriteConfig | null;
  readonly market: MarketConfig;
  /** Community AI Provider (Decision 0066); null keeps `communityAi` deferred. */
  readonly communityAi: CommunityAiConfig | null;
  /**
   * Push channel credential slot (Decision 0067): the path of the Firebase
   * service-account JSON. `null` keeps `pushNotifications` unavailable with
   * `PUSH_RUNTIME_DEFERRED` and refuses push-token registration. The file is
   * read at composition time; its contents never enter this config.
   */
  readonly push: PushConfig | null;
  /**
   * Decision 0095: `true` (default) hides the Decision 0055 persona
   * (`community.chat.viewerPersona` is null) so members show as their real
   * Stream user. `false` restores Decision 0055.
   */
  readonly communityChatRealIdentity: boolean;
  /**
   * Decision 0095: the communities `GET /v2/communities/recommended` lists,
   * in order; the first five are pre-selected. Empty when unset.
   */
  readonly recommendedCommunityIds: readonly string[];
  /**
   * Decision 0105: `INTEL_PROMOTION_IMAGE_HOSTS`, lower-case host names an
   * intel promotion `imageUrl` (https) may use. Empty = only `null`.
   */
  readonly intelPromotionImageHosts: readonly string[];
  /**
   * Decision 0102: the operator console credentials. Null unless all three
   * `ADMIN_*` variables are set; null leaves `/admin/*` unmounted (404).
   */
  readonly admin: AdminConsoleConfig | null;
  /**
   * Decision 0105: the key the console's MEME pause/unpause signs with
   * (`MEME_OPERATOR_PRIVATE_KEY`), separate from the deployer key of the
   * graduation fallback. Null = pause unavailable
   * (MEME_OPERATOR_KEY_MISSING). Never logged.
   */
  readonly memeOperator: {
    readonly privateKey: `0x${string}`;
  } | null;
  /** Decision 0128: the testnet faucet; `enabled` false keeps it 503. */
  readonly testnetFaucet: TestnetFaucetConfig;
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
   * The `launch` chain slot (Decision 0038), parsed with the same rules as
   * the API process so one environment file is accepted or refused
   * identically. No worker lane consumes it yet: the slot has no indexer
   * lane until the 02 contract document lands.
   */
  readonly launchChain: LaunchChainConfig;
  /** Decision 0076, parsed identically; the `launch_event` lane reads it. */
  readonly launchContract: LaunchContractConfig | null;
  /**
   * `launch_event` lane switch (Decision 0077), default false like
   * BSC_INDEXER_ENABLED. On, with the four contract keys blank, the lane
   * idles with LAUNCH_CONTRACT_BASELINE_PENDING.
   */
  readonly launchIndexerEnabled: boolean;
  /**
   * MEME launchpad lanes (Decision 0101): `meme_event` indexer, salt pool,
   * receipt reconcile (all behind `MEME_INDEXER_ENABLED`, default false)
   * and the graduation fallback executor (`MEME_GRADUATION_EXECUTOR_ENABLED`,
   * default false; signs `graduate` with `LAUNCH_DEPLOYER_PRIVATE_KEY`).
   */
  readonly meme: MemeConfig;
  readonly memeIndexerEnabled: boolean;
  /**
   * Decision 0114: the `launch2_event` lane (`LAUNCH2_INDEXER_ENABLED`,
   * default false). Decision 0133: the lane needs the OfficialTax Factory
   * (`factoryAddress`, HOOKS_LAUNCH_FACTORY_ADDRESS) **or** the LoopDynamic
   * one (`dynamicFactoryAddress`); only with both null does it stay idle
   * with LAUNCH2_FACTORY_NOT_CONFIGURED.
   */
  readonly launch2Indexer: {
    readonly factoryAddress: string | null;
    /** Decision 0122: HOOKS_LAUNCH_FACTORY_CODE_HASH (generation lookup). */
    readonly factoryCodeHash: string | null;
    /**
     * Decision 0122: `LAUNCH2_LEGACY_FACTORIES` — older Factories indexed
     * read-only, each with its bytecode generation. Malformed, duplicated,
     * or equal to HOOKS_LAUNCH_FACTORY_ADDRESS or (Decision 0133)
     * LAUNCH2_DYNAMIC_FACTORY_ADDRESS refuses boot.
     */
    readonly legacyFactories: readonly {
      readonly address: string;
      readonly generation: Launch2FactoryGeneration;
    }[];
    readonly pollIntervalMs: number;
    /**
     * Decision 0126: LAUNCH2_POOL_ROUTER_ADDRESS (lower-case) — the lane
     * reads its Swap(payer, recipient) logs to attribute pool swaps; null
     * leaves pool swaps unattributed.
     */
    readonly poolRouterAddress: string | null;
    /**
     * Decision 0131: LAUNCH2_DYNAMIC_FACTORY_ADDRESS (lower-case) — the
     * LoopDynamic Factory indexed beside the current one; null = none.
     * Decision 0133: may be the only Factory (no HOOKS_LAUNCH_FACTORY_*).
     */
    readonly dynamicFactoryAddress: string | null;
  } | null;
  /**
   * Decision 0131: the LoopDynamic `poke()` keeper. Present only with
   * `LAUNCH2_DYNAMIC_POKE_ENABLED=true`; enabling it without a well-formed
   * key or off BSC Testnet refuses boot. The key is never logged.
   */
  readonly launch2DynamicPoke: {
    readonly privateKey: `0x${string}`;
    readonly intervalSeconds: number;
  } | null;
  /**
   * Present only while the executor is enabled; the key is never logged.
   * `delaySeconds` (MEME_GRADUATION_DELAY_SECONDS, default 15, 0-600,
   * Decision 0103) is how long a curve stays `full` before the fallback
   * signs `graduate(token)`.
   */
  readonly memeGraduationExecutor: {
    readonly privateKey: `0x${string}`;
    readonly delaySeconds: number;
  } | null;
  /**
   * Hooks deployment executor (Decision 0112). Present only with
   * `HOOKS_LAUNCH_EXECUTOR_ENABLED=on`; enabling it without a well-formed
   * `HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY`, without the Factory pair, or off
   * BSC Testnet refuses boot. The key is never logged.
   */
  readonly hooksLaunchExecutor: HooksLaunchExecutorConfig | null;
  /**
   * MEME v2 snapshot publisher (Decision 0118). Present only with
   * `LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED=true`; enabling it with fewer than
   * two distinct signer keys, without a submitter key (own or the Hooks
   * executor's), or off BSC Testnet refuses boot. Keys are never logged.
   */
  readonly launch2SnapshotPublisher: Launch2SnapshotPublisherConfig | null;
  /**
   * MEME v2 buyback keeper (Decision 0121). Present only with
   * `LAUNCH2_BUYBACK_KEEPER_ENABLED=true`; enabling it without a
   * well-formed keeper key, without HOOKS_LAUNCH_FACTORY_ADDRESS, or off
   * BSC Testnet refuses boot (the worker then reads the Factory keepers and
   * refuses boot when the key is neither). The key is never logged.
   */
  readonly launch2BuybackKeeper: Launch2BuybackKeeperConfig | null;
  /**
   * Decision 0134: the read-only `chain_guard` lane. Present only with
   * `CHAIN_GUARD_ENABLED=true`; absent or null keeps it off (and the three
   * signing lanes unguarded).
   */
  readonly chainGuard?: ChainGuardConfig | null;
  /** Decision 0135: chain guard alert outlets; absent / null = none. */
  readonly chainGuardAlerts?: ChainGuardAlertConfig | null;
  /**
   * `community-channel-sync` lane (Decision 0032). Default off; enabling it
   * requires the complete Stream credential pair, which is why this process
   * now parses Stream configuration at all.
   */
  readonly communityChannelSync: StreamConfig | null;
  readonly market: MarketConfig;
  /** `alert_evaluator` lane (Decision 0034); default off. */
  readonly alertEvaluator: AlertEvaluatorConfig | null;
  /**
   * S169 (Decision 0128 §9): the `testnet_faucet_pending_sweep` lane, on
   * with TESTNET_FAUCET_ENABLED. Grants still `pending` after
   * `pendingTimeoutSeconds` are closed as `unknown` (the tBNB hash is on
   * chain) or `failed` (it is not). Read-only; it never signs. Absent or
   * null keeps it off.
   */
  readonly testnetFaucetSweep?: {
    readonly pendingTimeoutSeconds: number;
    readonly intervalMs: number;
  } | null;
  /**
   * Decision 0143 `square_feed_ingest` lane (`SQUARE_FEED_INGEST_ENABLED`,
   * default true; `SQUARE_FEED_INGEST_INTERVAL_MS`, default 60 000). Database
   * only: member buys ≥ 10 USD1, LoopDynamic claims and graduations become
   * square posts. `usd1Address` is the verified USD1 (a stable quote beside
   * USDT / USDC). Absent or null keeps it off.
   */
  readonly squareFeedIngest?: {
    readonly intervalMs: number;
    readonly usd1Address: string | null;
  } | null;
  /**
   * Decision 0145 `wallet_networth_snapshot` lane
   * (`WALLET_NETWORTH_SNAPSHOT_ENABLED`, default true;
   * `WALLET_NETWORTH_SNAPSHOT_INTERVAL_MS`, default 3 600 000;
   * `WALLET_NETWORTH_SNAPSHOT_BATCH`, default 200). Absent or null keeps it
   * off.
   */
  readonly walletNetWorthSnapshot?: {
    readonly intervalMs: number;
    readonly batchSize: number;
  } | null;
  /**
   * Decision 0149 `fiat_fx_rate` lane (`FIAT_FX_RATE_ENABLED`, default
   * true; `FIAT_FX_PROVIDER_URL`, default the ECB reference rate via
   * Frankfurter; `FIAT_FX_REFRESH_SECONDS`, default 3600, 60–86 400).
   * Absent or null keeps it off.
   */
  readonly fiatFxRate?: {
    readonly providerUrl: string;
    /** Provider key from the URL, lower case (`ecb`). */
    readonly source: string;
    readonly base: "USD";
    readonly quote: "CNY";
    readonly refreshMs: number;
  } | null;
  /**
   * `market_sparkline_warm` lane (Decision 0074); default on. It only ever
   * runs when the GeckoTerminal Provider is enabled, which the runtime
   * checks against `market.geckoterminal.enabled`.
   */
  readonly sparklineWarm: { readonly intervalMs: number } | null;
  /**
   * `token_logo_prewarm` lane (Decision 0161 §2); default on
   * (`TOKEN_LOGO_PREWARM_ENABLED`). One pass every `intervalMs`
   * (`TOKEN_LOGO_PREWARM_INTERVAL_MS`, default 6 h, 1 min – 24 h);
   * `hotLimit` (`TOKEN_LOGO_PREWARM_HOT_LIMIT`, default 200, 0–200) caps the
   * GeckoTerminal volume-ranked hot list (0 skips it).
   */
  readonly tokenLogoPrewarm?: {
    readonly intervalMs: number;
    readonly hotLimit: number;
  } | null;
  /**
   * `voice_room_reaper` lane (Decision 0094); default on. It ends live
   * voice rooms nobody is in (`VOICE_ROOM_IDLE_END_MINUTES`, default 10) and
   * any room live longer than `VOICE_ROOM_MAX_LIVE_HOURS` (default 12).
   * `stream` is the Stream credential pair, parsed independently of the
   * community-channel-sync switch; without it the lane stays off, because
   * it can neither observe presence nor end the call.
   */
  readonly voiceRoomReaper: {
    readonly intervalMs: number;
    readonly idleEndMinutes: number;
    readonly maxLiveHours: number;
    readonly stream: StreamConfig | null;
  } | null;
  /**
   * `friend_direct_channel` lane (Decision 0172); default on
   * (`FRIEND_DIRECT_CHANNEL_ENABLED`). It runs the `direct_get_or_create`
   * chat operation for every accepted friend pair in
   * `friend_direct_channel_jobs`. `backfillEnabled`
   * (`FRIEND_CHANNEL_BACKFILL_ENABLED`, default off) also enqueues, each
   * tick, up to 200 friendship pairs that have no direct channel. `stream`
   * is the Stream credential pair; without it the lane stays off.
   */
  readonly friendDirectChannel: {
    readonly intervalMs: number;
    readonly backfillEnabled: boolean;
    readonly stream: StreamConfig | null;
  } | null;
  /**
   * `notification_inbox` lane (Decision 0177); default on
   * (`NOTIFICATION_INBOX_ENABLED`). It writes the MEME v2 graduation and
   * badge-minted notifications from the read model, and — only while
   * `NOTIFICATION_INBOX_EMIT` is on — pushes the fresh fine inbox events.
   */
  readonly notificationInbox: {
    readonly intervalMs: number;
    readonly emit: boolean;
    /** Decision 0178: `LAUNCH_REVIEW_INBOX_EMIT === "on"` (default off). */
    readonly launchReviewEmit: boolean;
  } | null;
  /**
   * `community_member_buy_feed` lane (Decision 0097); default on. It turns
   * swaps of a verified community's bound asset by its members into
   * `loop_feed_bot` messages in the community channel. `stream` is the
   * Stream credential pair, parsed independently of the
   * community-channel-sync switch; without it the lane stays off.
   * `usd1Address` is the verified USD1 (`BSC_USD1_TOKEN_ADDRESS` +
   * `BSC_USD1_VERIFIED`), the same quote set as the public trades read.
   */
  readonly communityMemberBuyFeed: {
    readonly intervalMs: number;
    readonly usd1Address: string | null;
    readonly stream: StreamConfig | null;
  } | null;
  /**
   * `wallet-intent-reconcile` lane (Decision 0035); default off. It reads
   * receipts over RPC and, when Privy credentials are present, Privy wallet
   * action status. It never signs, broadcasts, or replays a write.
   */
  readonly walletIntentReconcile: {
    readonly privy: PrivyConfig | null;
  } | null;
  /**
   * `mining-snapshot` lane (Decision 0036); default off. Even when enabled
   * it stays idle until a Mining formula version is `approved`, which only
   * the operator script can do outside production.
   */
  readonly miningSnapshotEnabled: boolean;
  /** Decision 0116: `mining_hourly_settlement` lane (default off). */
  readonly miningSettlement: MiningSettlementWorkerConfig;
  /**
   * Decision 0061: whether that lane counts the Development seed's
   * `mock_seed` balances. Default false; refused under
   * `NODE_ENV=production`.
   */
  readonly miningMockHoldingsEnabled: boolean;
  /**
   * Push channel credential slot (Decision 0067). The `alert_evaluator` lane
   * sends `price_alert_triggered` only when it is configured; otherwise the
   * trigger stays an in-app feed row.
   */
  readonly push: PushConfig | null;
  /**
   * Decision 0095: `true` (default) stops the community channel sync from
   * generating, attaching, or re-projecting Decision 0055 personas; members
   * show as their real Stream user. `false` restores Decision 0055.
   */
  readonly communityChatRealIdentity: boolean;
  /**
   * Decision 0095: the API origin the Stream user `image` URL is built on
   * when the community channel sync upserts a joiner. Same key as the API.
   */
  readonly publicBaseUrl: string;
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
function parseBscRpcUrls(
  value: string | undefined,
  fieldName: "BSC_RPC_URLS" | "LAUNCH_BSC_RPC_URLS" = "BSC_RPC_URLS",
): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  const urls: string[] = [];
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    if (entry.length === 0) {
      continue;
    }
    const url = parseUrl(fieldName, entry);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ConfigurationError([
        `${fieldName}: protocol must be http or https`,
      ]);
    }
    if (url.username !== "" || url.password !== "") {
      throw new ConfigurationError([
        `${fieldName}: credentials are not allowed in an endpoint URL`,
      ]);
    }
    const normalized = url.toString();
    if (!urls.includes(normalized)) {
      urls.push(normalized);
    }
  }
  if (urls.length > maximumBscRpcEndpoints) {
    throw new ConfigurationError([
      `${fieldName}: at most ${maximumBscRpcEndpoints} endpoints are supported`,
    ]);
  }
  return Object.freeze(urls);
}

/** Mirrors the LAUNCH_BSC_CONFIRMATIONS and LAUNCH_BSC_REORG_DEPTH_BLOCKS defaults. */
export const defaultLaunchChainConfirmations = 5;
export const defaultLaunchChainReorgDepthBlocks = 15;

/**
 * Parses the launch chain slot (Decision 0038). With `LAUNCH_CHAIN_ID=56` the
 * primary endpoint list and read policy are copied so the slot can never
 * describe a second, differently configured mainnet client; the schema
 * refinement has already refused any `LAUNCH_BSC_*` override in that case.
 */
export function parseLaunchChainConfig(
  data: {
    readonly LAUNCH_CHAIN_ID: "56" | "97";
    readonly LAUNCH_MAINNET_ACK?: string | undefined;
    readonly LAUNCH_BSC_RPC_URLS?: string | undefined;
    readonly LAUNCH_BSC_CONFIRMATIONS?: number | undefined;
    readonly LAUNCH_BSC_REORG_DEPTH_BLOCKS?: number | undefined;
  },
  primary: {
    readonly rpcUrls: readonly string[];
    readonly confirmations: number;
    readonly reorgDepthBlocks: number;
    readonly logAddressChunkSize: number;
  },
): LaunchChainConfig {
  if (data.LAUNCH_CHAIN_ID === "56") {
    return Object.freeze({
      chainId: bscChainId,
      chainReference: bscChainReference,
      rpcUrls: primary.rpcUrls,
      confirmations: primary.confirmations,
      reorgDepthBlocks: primary.reorgDepthBlocks,
      logAddressChunkSize: primary.logAddressChunkSize,
      sharedWithPrimary: true,
      mainnetAcknowledged: launchMainnetAcknowledged(data),
    });
  }
  return Object.freeze({
    chainId: bscTestnetChainId,
    chainReference: bscTestnetChainReference,
    rpcUrls: parseBscRpcUrls(data.LAUNCH_BSC_RPC_URLS, "LAUNCH_BSC_RPC_URLS"),
    confirmations:
      data.LAUNCH_BSC_CONFIRMATIONS ?? defaultLaunchChainConfirmations,
    reorgDepthBlocks:
      data.LAUNCH_BSC_REORG_DEPTH_BLOCKS ?? defaultLaunchChainReorgDepthBlocks,
    logAddressChunkSize: primary.logAddressChunkSize,
    sharedWithPrimary: false,
    mainnetAcknowledged: false,
  });
}

/**
 * The launch chain ID as an operator script reads it from the same
 * environment file the API uses (Decision 0038). The rule is exactly the
 * one `loadConfig` applies through `launchChainEnvironmentShape`: an unset
 * key is the default (56); otherwise only the exact strings "56" and "97"
 * are accepted — a blank or padded value is refused, never defaulted, so
 * the script and the API can never disagree about which chain a launch is
 * stamped with.
 */
export function parseLaunchChainIdEnvironment(
  value: string | undefined,
): LaunchChainId {
  const parsed = launchChainEnvironmentShape.LAUNCH_CHAIN_ID.safeParse(
    value ?? "56",
  );
  if (!parsed.success) {
    throw new ConfigurationError(["LAUNCH_CHAIN_ID: must be 56 or 97"]);
  }
  return parsed.data === "97" ? bscTestnetChainId : bscChainId;
}

const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;
const semanticVersionPattern =
  /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const blockNumberPattern = /^(0|[1-9][0-9]{0,18})$/;

/**
 * Parses the Decision 0076 contract keys after the schema refinement has
 * already refused a partial set. The address and the USD1 address are stored
 * lowercase; the start block must fit a PostgreSQL `bigint` checkpoint. The
 * ABI major is not checked here: an unsupported major is a runtime
 * `LAUNCH_CONTRACT_VERSION_UNSUPPORTED`, not a boot failure.
 */
export function parseLaunchContractConfig(
  data: LaunchContractEnvironment,
): LaunchContractConfig | null {
  const address = data.LAUNCH_CONTRACT_ADDRESS;
  const version = data.LAUNCH_CONTRACT_VERSION;
  const startBlock = data.LAUNCH_CONTRACT_START_BLOCK;
  const usd1Address = data.LAUNCH_USD1_ADDRESS;
  if (
    address === undefined ||
    version === undefined ||
    startBlock === undefined ||
    usd1Address === undefined
  ) {
    return null;
  }
  const issues: string[] = [];
  if (!evmAddressPattern.test(address)) {
    issues.push(
      "LAUNCH_CONTRACT_ADDRESS: must be a 0x-prefixed 20-byte address",
    );
  }
  if (!evmAddressPattern.test(usd1Address)) {
    issues.push("LAUNCH_USD1_ADDRESS: must be a 0x-prefixed 20-byte address");
  }
  const versionMatch = semanticVersionPattern.exec(version);
  if (versionMatch === null) {
    issues.push(
      "LAUNCH_CONTRACT_VERSION: must be a semantic version MAJOR.MINOR.PATCH",
    );
  }
  if (
    !blockNumberPattern.test(startBlock) ||
    BigInt(startBlock) > 9_223_372_036_854_775_807n
  ) {
    issues.push(
      "LAUNCH_CONTRACT_START_BLOCK: must be a non-negative integer block number",
    );
  }
  if (
    issues.length === 0 &&
    address.toLowerCase() === usd1Address.toLowerCase()
  ) {
    issues.push(
      "LAUNCH_USD1_ADDRESS: must differ from LAUNCH_CONTRACT_ADDRESS",
    );
  }
  if (issues.length > 0 || versionMatch === null) {
    throw new ConfigurationError(issues);
  }
  return Object.freeze({
    address: address.toLowerCase(),
    version,
    versionMajor: Number(versionMatch[1]),
    startBlock: BigInt(startBlock),
    usd1Address: usd1Address.toLowerCase(),
  });
}

export interface MemeConfig {
  readonly contract: MemeContractConfig | null;
  /** Why `contract` is null (`null` once configured). */
  readonly unconfiguredReason: MemeContractReasonCode | null;
  readonly saltPoolTarget: number;
  /** Lowercase hex; empty disables the vanity suffix. */
  readonly vanitySuffix: string;
  readonly createDailyLimit: number;
  /** Decision 0151: `MEME_CLASSIC_CREATE_ENABLED` (default false). */
  readonly classicCreateEnabled: boolean;
}

/**
 * Decision 0101: the four `MEME_*` contract keys plus the launch slot's
 * `LAUNCH_USD1_ADDRESS` (the curve's quote asset, docs/10 §1). Any key
 * blank keeps the contract null (`MEME_CONTRACT_NOT_CONFIGURED`, or
 * `MEME_USD1_NOT_CONFIGURED` while only the Launch USD1 is missing); a
 * malformed present value refuses boot.
 */
export function parseMemeConfig(
  data: {
    readonly MEME_CONTRACT_ADDRESS?: string | undefined;
    readonly MEME_CONTRACT_VERSION?: string | undefined;
    readonly MEME_CONTRACT_START_BLOCK?: string | undefined;
    readonly MEME_TOKEN_IMPLEMENTATION?: string | undefined;
    readonly MEME_SALT_POOL_TARGET: number;
    readonly MEME_VANITY_SUFFIX: string;
    readonly MEME_CREATE_DAILY_LIMIT: number;
    readonly MEME_CLASSIC_CREATE_ENABLED: boolean;
  },
  launchContract: LaunchContractConfig | null,
): MemeConfig {
  const address = data.MEME_CONTRACT_ADDRESS;
  const version = data.MEME_CONTRACT_VERSION;
  const startBlock = data.MEME_CONTRACT_START_BLOCK;
  const implementation = data.MEME_TOKEN_IMPLEMENTATION;
  const issues: string[] = [];
  if (address !== undefined && !evmAddressPattern.test(address)) {
    issues.push("MEME_CONTRACT_ADDRESS: must be a 0x-prefixed 20-byte address");
  }
  if (implementation !== undefined && !evmAddressPattern.test(implementation)) {
    issues.push(
      "MEME_TOKEN_IMPLEMENTATION: must be a 0x-prefixed 20-byte address",
    );
  }
  const versionMatch =
    version === undefined ? null : semanticVersionPattern.exec(version);
  if (version !== undefined && versionMatch === null) {
    issues.push(
      "MEME_CONTRACT_VERSION: must be a semantic version MAJOR.MINOR.PATCH",
    );
  }
  if (
    startBlock !== undefined &&
    (!blockNumberPattern.test(startBlock) ||
      BigInt(startBlock) > 9_223_372_036_854_775_807n)
  ) {
    issues.push(
      "MEME_CONTRACT_START_BLOCK: must be a non-negative integer block number",
    );
  }
  if (
    address !== undefined &&
    implementation !== undefined &&
    address.toLowerCase() === implementation.toLowerCase()
  ) {
    issues.push(
      "MEME_TOKEN_IMPLEMENTATION: must differ from MEME_CONTRACT_ADDRESS",
    );
  }
  if (issues.length > 0) {
    throw new ConfigurationError(issues);
  }
  const shared = {
    saltPoolTarget: data.MEME_SALT_POOL_TARGET,
    vanitySuffix: data.MEME_VANITY_SUFFIX.toLowerCase(),
    createDailyLimit: data.MEME_CREATE_DAILY_LIMIT,
    classicCreateEnabled: data.MEME_CLASSIC_CREATE_ENABLED,
  };
  if (
    address === undefined ||
    version === undefined ||
    startBlock === undefined ||
    implementation === undefined ||
    versionMatch === null
  ) {
    return Object.freeze({
      contract: null,
      unconfiguredReason: memeContractReasonCodes.notConfigured,
      ...shared,
    });
  }
  if (launchContract === null) {
    return Object.freeze({
      contract: null,
      unconfiguredReason: memeContractReasonCodes.usd1NotConfigured,
      ...shared,
    });
  }
  return Object.freeze({
    contract: Object.freeze({
      address: address.toLowerCase(),
      version,
      versionMajor: Number(versionMatch[1]),
      startBlock: BigInt(startBlock),
      tokenImplementation: implementation.toLowerCase(),
      usd1Address: launchContract.usd1Address,
    }),
    unconfiguredReason: null,
    ...shared,
  });
}

const privateKeyPattern = /^(0x)?[0-9a-fA-F]{64}$/u;

/** Decision 0103: default wait before the fallback signs `graduate`. */
export const MEME_GRADUATION_DEFAULT_DELAY_SECONDS = 15;

/**
 * Decision 0116: the API's settlement keys. A malformed signer key refuses
 * boot; the test trigger is refused under NODE_ENV=production.
 */
export function parseMiningSettlementApi(data: {
  readonly NODE_ENV: string;
  readonly MINING_REWARD_SIGNER_PRIVATE_KEY?: string | undefined;
  readonly MINING_SETTLEMENT_TEST_TRIGGER: boolean;
  readonly MINING_REWARD_CLAIM_ADDRESS?: string | undefined;
  readonly MINING_CLAIM_USDT_ADDRESS?: string | undefined;
  readonly MINING_CLAIM_CONFIRMATIONS: number;
  readonly MINING_SETTLEMENT_INDEXER_GRACE_SECONDS: number;
  readonly MINING_EMBEDDED_WALLET_ONLY: boolean;
}): MiningSettlementApiConfig {
  const shared = parseMiningSettlementShared(data);
  const key = data.MINING_REWARD_SIGNER_PRIVATE_KEY?.trim();
  if (key !== undefined && key !== "" && !privateKeyPattern.test(key)) {
    throw new ConfigurationError([
      "MINING_REWARD_SIGNER_PRIVATE_KEY: must be a 32-byte hex key",
    ]);
  }
  if (data.MINING_SETTLEMENT_TEST_TRIGGER && data.NODE_ENV === "production") {
    throw new ConfigurationError([
      "MINING_SETTLEMENT_TEST_TRIGGER: must not be set under NODE_ENV=production",
    ]);
  }
  return Object.freeze({
    ...shared,
    signerPrivateKey:
      key === undefined || key === ""
        ? null
        : ((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`),
    testTrigger: data.MINING_SETTLEMENT_TEST_TRIGGER,
  });
}

/**
 * Decision 0105: the operator console's pause/unpause key. Blank → null
 * (pause unavailable, MEME_OPERATOR_KEY_MISSING); malformed refuses boot.
 * The key never enters a log line or an error message.
 */
export function parseMemeOperator(data: {
  readonly MEME_OPERATOR_PRIVATE_KEY?: string | undefined;
}): { readonly privateKey: `0x${string}` } | null {
  const key = data.MEME_OPERATOR_PRIVATE_KEY?.trim();
  if (key === undefined || key === "") {
    return null;
  }
  if (!privateKeyPattern.test(key)) {
    throw new ConfigurationError([
      "MEME_OPERATOR_PRIVATE_KEY: must be a 32-byte hex key",
    ]);
  }
  return Object.freeze({
    privateKey: (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`,
  });
}

export interface TestnetFaucetConfig {
  readonly enabled: boolean;
  /** Canonical decimal string published as `bnbAmount`. */
  readonly bnbAmount: string;
  /** The same amount in wei (decimal integer string). */
  readonly bnbAmountWei: string;
  /** Canonical decimal string published as `usd1Amount`; raw follows `decimals()`. */
  readonly usd1Amount: string;
  readonly cooldownSeconds: number;
  /** TESTNET_FAUCET_OPERATOR_PRIVATE_KEY, else MEME_OPERATOR_PRIVATE_KEY; never logged. */
  readonly operatorPrivateKey: `0x${string}` | null;
  /**
   * Which USD1 the faucet mints (S156b): `explicit` =
   * TESTNET_FAUCET_USD1_ADDRESS; `factory` = `usd1()` of the Hooks Factory
   * (HOOKS_LAUNCH_FACTORY_ADDRESS, else — Decision 0133 — the LoopDynamic
   * Factory LAUNCH2_DYNAMIC_FACTORY_ADDRESS; both share
   * `LoopLaunchFactoryCore.usd1()`), the USD1 every MEME v2 / launch2
   * instance trades in, read on chain at grant time; `launch` =
   * LAUNCH_USD1_ADDRESS, only while launch2 has no Factory. Null = none.
   */
  readonly usd1Source: TestnetFaucetUsd1Source | null;
  /**
   * S169: which variable the operator key came from. `meme` = the
   * fallback to MEME_OPERATOR_PRIVATE_KEY, the console's pause/unpause key.
   */
  readonly operatorKeySource: "faucet" | "meme" | null;
  /**
   * TESTNET_FAUCET_OPERATOR_RESERVE_BNB (default 0.05): kept on the operator
   * when its key is shared with the MEME pause signer in the same process,
   * so a pause transaction always has gas. Canonical decimal and wei.
   */
  readonly operatorReserveBnb: string;
  readonly operatorReserveWei: string;
  /** TESTNET_FAUCET_DAILY_MAX_GRANTS (default 200), per UTC day. */
  readonly dailyMaxGrants: number;
  /** TESTNET_FAUCET_DAILY_MAX_BNB (default 2), per UTC day; canonical and wei. */
  readonly dailyMaxBnb: string;
  readonly dailyMaxBnbWei: string;
  /** TESTNET_FAUCET_FAILED_COOLDOWN_SECONDS (default 300) after a failed grant. */
  readonly failedCooldownSeconds: number;
  /** Failed grants per owner per UTC day before 429 (fixed, 5). */
  readonly failedDailyLimit: number;
  /** TESTNET_FAUCET_PENDING_TIMEOUT_SECONDS (default 900), the sweep's age. */
  readonly pendingTimeoutSeconds: number;
}

/** S169: failed grants one owner may cause per UTC day. */
export const testnetFaucetFailedDailyLimit = 5;
/** S169: the pending sweep lane's period. */
export const testnetFaucetSweepIntervalMs = 60_000;

/** S169 defaults of the faucet limit variables (API process). */
function testnetFaucetLimitEnvironmentDefaults(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    TESTNET_FAUCET_OPERATOR_RESERVE_BNB:
      environment["TESTNET_FAUCET_OPERATOR_RESERVE_BNB"] ?? "0.05",
    TESTNET_FAUCET_DAILY_MAX_GRANTS:
      environment["TESTNET_FAUCET_DAILY_MAX_GRANTS"] ?? "200",
    TESTNET_FAUCET_DAILY_MAX_BNB:
      environment["TESTNET_FAUCET_DAILY_MAX_BNB"] ?? "2",
    TESTNET_FAUCET_FAILED_COOLDOWN_SECONDS:
      environment["TESTNET_FAUCET_FAILED_COOLDOWN_SECONDS"] ?? "300",
    TESTNET_FAUCET_PENDING_TIMEOUT_SECONDS:
      environment["TESTNET_FAUCET_PENDING_TIMEOUT_SECONDS"] ?? "900",
  };
}

export type TestnetFaucetUsd1Source =
  | { readonly kind: "explicit"; readonly address: string }
  | { readonly kind: "factory"; readonly factoryAddress: string }
  | { readonly kind: "launch"; readonly address: string };

const faucetDecimalPattern = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$/u;

/** Strips trailing fraction zeros: "0.020" → "0.02", "500.0" → "500". */
function canonicalFaucetDecimal(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/u, "");
  return trimmed === "" ? whole : `${whole}.${trimmed}`;
}

/** Exact decimal → integer units with `decimals` places (no float). */
export function faucetDecimalToRaw(value: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new RangeError("too many fraction digits");
  }
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

function parseFaucetAmount(
  name: string,
  value: string,
  maximum: bigint,
  issues: string[],
): string {
  if (!faucetDecimalPattern.test(value)) {
    issues.push(
      `${name}: must be a positive decimal with at most 18 fraction digits`,
    );
    return "0";
  }
  const canonical = canonicalFaucetDecimal(value);
  const raw = faucetDecimalToRaw(canonical, 18);
  if (raw <= 0n || raw > maximum * 10n ** 18n) {
    issues.push(`${name}: must be greater than 0 and at most ${maximum}`);
  }
  return canonical;
}

/**
 * Decision 0128: the testnet faucet. Amounts and the operator key are
 * validated whether or not it is enabled (a malformed value refuses boot);
 * the chain-97 rule is the schema refinement. A missing key or USD1 address
 * is not a boot failure: the capability reports it. The key never enters a
 * log line or an error message.
 */
export function parseTestnetFaucet(data: {
  readonly TESTNET_FAUCET_ENABLED: boolean;
  readonly TESTNET_FAUCET_BNB_AMOUNT: string;
  readonly TESTNET_FAUCET_USD1_AMOUNT: string;
  readonly TESTNET_FAUCET_COOLDOWN_SECONDS: number;
  readonly TESTNET_FAUCET_OPERATOR_PRIVATE_KEY?: string | undefined;
  readonly MEME_OPERATOR_PRIVATE_KEY?: string | undefined;
  readonly LAUNCH_USD1_ADDRESS?: string | undefined;
  readonly TESTNET_FAUCET_USD1_ADDRESS?: string | undefined;
  readonly HOOKS_LAUNCH_FACTORY_ADDRESS?: string | undefined;
  /** Decision 0133: the `usd1()` source when there is no OfficialTax Factory. */
  readonly LAUNCH2_DYNAMIC_FACTORY_ADDRESS?: string | undefined;
  readonly TESTNET_FAUCET_OPERATOR_RESERVE_BNB?: string | undefined;
  readonly TESTNET_FAUCET_DAILY_MAX_GRANTS?: number | undefined;
  readonly TESTNET_FAUCET_DAILY_MAX_BNB?: string | undefined;
  readonly TESTNET_FAUCET_FAILED_COOLDOWN_SECONDS?: number | undefined;
  readonly TESTNET_FAUCET_PENDING_TIMEOUT_SECONDS?: number | undefined;
}): TestnetFaucetConfig {
  const issues: string[] = [];
  const bnbAmount = parseFaucetAmount(
    "TESTNET_FAUCET_BNB_AMOUNT",
    data.TESTNET_FAUCET_BNB_AMOUNT,
    1n,
    issues,
  );
  const usd1Amount = parseFaucetAmount(
    "TESTNET_FAUCET_USD1_AMOUNT",
    data.TESTNET_FAUCET_USD1_AMOUNT,
    1_000_000n,
    issues,
  );
  const operatorReserveBnb = parseFaucetAmount(
    "TESTNET_FAUCET_OPERATOR_RESERVE_BNB",
    data.TESTNET_FAUCET_OPERATOR_RESERVE_BNB ?? "0.05",
    10n,
    issues,
  );
  const dailyMaxBnb = parseFaucetAmount(
    "TESTNET_FAUCET_DAILY_MAX_BNB",
    data.TESTNET_FAUCET_DAILY_MAX_BNB ?? "2",
    1_000n,
    issues,
  );
  const ownKey = data.TESTNET_FAUCET_OPERATOR_PRIVATE_KEY?.trim() ?? "";
  if (ownKey !== "" && !privateKeyPattern.test(ownKey)) {
    issues.push(
      "TESTNET_FAUCET_OPERATOR_PRIVATE_KEY: must be a 32-byte hex key",
    );
  }
  const explicitUsd1 = data.TESTNET_FAUCET_USD1_ADDRESS?.trim() ?? "";
  if (explicitUsd1 !== "" && !/^0x[0-9a-fA-F]{40}$/u.test(explicitUsd1)) {
    issues.push(
      "TESTNET_FAUCET_USD1_ADDRESS: must be a 0x-prefixed 20-byte address",
    );
  }
  if (issues.length > 0) {
    throw new ConfigurationError(issues);
  }
  // The fallback key is validated by parseMemeOperator.
  const key =
    ownKey !== "" ? ownKey : (data.MEME_OPERATOR_PRIVATE_KEY?.trim() ?? "");
  const launchUsd1 = data.LAUNCH_USD1_ADDRESS?.trim() ?? "";
  const officialTaxFactory = data.HOOKS_LAUNCH_FACTORY_ADDRESS?.trim() ?? "";
  const evm = /^0x[0-9a-fA-F]{40}$/u;
  // Decision 0133: the OfficialTax Factory first (unchanged), else the
  // LoopDynamic one; both expose the same `usd1()`.
  const factory = evm.test(officialTaxFactory)
    ? officialTaxFactory
    : (data.LAUNCH2_DYNAMIC_FACTORY_ADDRESS?.trim() ?? "");
  const usd1Source: TestnetFaucetUsd1Source | null =
    explicitUsd1 !== ""
      ? { kind: "explicit", address: explicitUsd1.toLowerCase() }
      : evm.test(factory)
        ? { kind: "factory", factoryAddress: factory.toLowerCase() }
        : evm.test(launchUsd1)
          ? { kind: "launch", address: launchUsd1.toLowerCase() }
          : null;
  const operatorPrivateKey =
    key !== "" && privateKeyPattern.test(key) ? normalizedKey(key) : null;
  return Object.freeze({
    enabled: data.TESTNET_FAUCET_ENABLED,
    bnbAmount,
    bnbAmountWei: faucetDecimalToRaw(bnbAmount, 18).toString(),
    usd1Amount,
    cooldownSeconds: data.TESTNET_FAUCET_COOLDOWN_SECONDS,
    operatorPrivateKey,
    usd1Source: usd1Source === null ? null : Object.freeze(usd1Source),
    operatorKeySource:
      operatorPrivateKey === null ? null : ownKey !== "" ? "faucet" : "meme",
    operatorReserveBnb,
    operatorReserveWei: faucetDecimalToRaw(operatorReserveBnb, 18).toString(),
    dailyMaxGrants: data.TESTNET_FAUCET_DAILY_MAX_GRANTS ?? 200,
    dailyMaxBnb,
    dailyMaxBnbWei: faucetDecimalToRaw(dailyMaxBnb, 18).toString(),
    failedCooldownSeconds: data.TESTNET_FAUCET_FAILED_COOLDOWN_SECONDS ?? 300,
    failedDailyLimit: testnetFaucetFailedDailyLimit,
    pendingTimeoutSeconds: data.TESTNET_FAUCET_PENDING_TIMEOUT_SECONDS ?? 900,
  });
}

/**
 * Decision 0101: the graduation fallback executor signs `graduate(token)`
 * with the testnet deployer key. Enabled without a well-formed key refuses
 * boot; the key never enters a log line or an error message. Decision 0103:
 * the wait before signing is MEME_GRADUATION_DELAY_SECONDS (default 15).
 */
export function parseMemeGraduationExecutor(data: {
  readonly MEME_GRADUATION_EXECUTOR_ENABLED: boolean;
  readonly MEME_GRADUATION_DELAY_SECONDS?: number | undefined;
  readonly LAUNCH_DEPLOYER_PRIVATE_KEY?: string | undefined;
}): {
  readonly privateKey: `0x${string}`;
  readonly delaySeconds: number;
} | null {
  if (!data.MEME_GRADUATION_EXECUTOR_ENABLED) {
    return null;
  }
  const key = data.LAUNCH_DEPLOYER_PRIVATE_KEY?.trim();
  if (key === undefined || !privateKeyPattern.test(key)) {
    throw new ConfigurationError([
      "LAUNCH_DEPLOYER_PRIVATE_KEY: a 32-byte hex key is required when MEME_GRADUATION_EXECUTOR_ENABLED=true",
    ]);
  }
  return Object.freeze({
    privateKey: (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`,
    delaySeconds:
      data.MEME_GRADUATION_DELAY_SECONDS ??
      MEME_GRADUATION_DEFAULT_DELAY_SECONDS,
  });
}

export interface HooksLaunchExecutorConfig {
  readonly privateKey: `0x${string}`;
  /**
   * Decision 0132: the Hook kind of the target Factory. `loopDynamic`: the
   * `LAUNCH2_DYNAMIC_FACTORY_*` pair below is the target.
   */
  readonly hookKind: "officialTax" | "loopDynamic";
  readonly factoryAddress: string;
  readonly factoryCodeHash: string;
  readonly confirmations: number;
  readonly pollIntervalMs: number;
  readonly leaseSeconds: number;
  readonly maxAttempts: number;
  readonly retryDelaySeconds: number;
  readonly gasLimitCap: number;
  readonly maxGasPriceGwei: number;
}

/**
 * Decision 0112: the Hooks deployment executor signs `deployLaunch` /
 * `activateLaunch` on the BSC Testnet Factory. `off` (default) → null.
 * `on` refuses boot unless the executor key, the Factory address + code
 * hash pair, and `LAUNCH_CHAIN_ID=97` are all present. The key never enters
 * a log line or an error message.
 */
export function parseHooksLaunchExecutor(data: {
  readonly LAUNCH_CHAIN_ID: "56" | "97";
  /** Decision 0150: the mainnet ack and the repository-wide write switch. */
  readonly LAUNCH_MAINNET_ACK?: string | undefined;
  readonly BSC_WRITES_ENABLED?: boolean | undefined;
  /** Decision 0131 (absent = officialTax). */
  readonly HOOKS_LAUNCH_HOOK_KIND?: "officialTax" | "loopDynamic";
  readonly HOOKS_LAUNCH_EXECUTOR_ENABLED: "off" | "on";
  readonly HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY?: string | undefined;
  readonly HOOKS_LAUNCH_FACTORY_ADDRESS?: string | undefined;
  readonly HOOKS_LAUNCH_FACTORY_CODE_HASH?: string | undefined;
  /** Decision 0132: the LoopDynamic Factory pair (loopDynamic target). */
  readonly LAUNCH2_DYNAMIC_FACTORY_ADDRESS?: string | undefined;
  readonly LAUNCH2_DYNAMIC_FACTORY_CODE_HASH?: string | undefined;
  readonly HOOKS_LAUNCH_EXECUTOR_CONFIRMATIONS: number;
  readonly HOOKS_LAUNCH_EXECUTOR_POLL_INTERVAL_MS: number;
  readonly HOOKS_LAUNCH_EXECUTOR_LEASE_SECONDS: number;
  readonly HOOKS_LAUNCH_EXECUTOR_MAX_ATTEMPTS: number;
  readonly HOOKS_LAUNCH_EXECUTOR_RETRY_DELAY_SECONDS: number;
  readonly HOOKS_LAUNCH_EXECUTOR_GAS_LIMIT_CAP: number;
  readonly HOOKS_LAUNCH_EXECUTOR_MAX_GAS_PRICE_GWEI: number;
}): HooksLaunchExecutorConfig | null {
  if (data.HOOKS_LAUNCH_EXECUTOR_ENABLED !== "on") {
    return null;
  }
  const issues: string[] = [];
  const key = data.HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY?.trim();
  if (key === undefined || key === "" || !privateKeyPattern.test(key)) {
    issues.push(
      "HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: a 32-byte hex key is required when HOOKS_LAUNCH_EXECUTOR_ENABLED=on",
    );
  }
  issues.push(
    ...launchSlotWriteLaneIssues("HOOKS_LAUNCH_EXECUTOR_ENABLED", data),
  );
  // Decision 0132: a loopDynamic executor deploys on the LoopDynamic
  // Factory (and verifies LoopDynamic modules); the OfficialTax pair is not
  // its target.
  const dynamic = data.HOOKS_LAUNCH_HOOK_KIND === "loopDynamic";
  const factoryAddress = dynamic
    ? data.LAUNCH2_DYNAMIC_FACTORY_ADDRESS
    : data.HOOKS_LAUNCH_FACTORY_ADDRESS;
  const factoryCodeHash = dynamic
    ? data.LAUNCH2_DYNAMIC_FACTORY_CODE_HASH
    : data.HOOKS_LAUNCH_FACTORY_CODE_HASH;
  if (factoryAddress === undefined || factoryCodeHash === undefined) {
    issues.push(
      dynamic
        ? "HOOKS_LAUNCH_EXECUTOR_ENABLED: HOOKS_LAUNCH_HOOK_KIND=loopDynamic requires LAUNCH2_DYNAMIC_FACTORY_ADDRESS and LAUNCH2_DYNAMIC_FACTORY_CODE_HASH (Decision 0132)"
        : "HOOKS_LAUNCH_EXECUTOR_ENABLED: requires HOOKS_LAUNCH_FACTORY_ADDRESS and HOOKS_LAUNCH_FACTORY_CODE_HASH",
    );
  }
  if (
    issues.length > 0 ||
    key === undefined ||
    factoryAddress === undefined ||
    factoryCodeHash === undefined
  ) {
    throw new ConfigurationError(issues);
  }
  return Object.freeze({
    privateKey: (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`,
    hookKind: dynamic ? ("loopDynamic" as const) : ("officialTax" as const),
    factoryAddress: factoryAddress.toLowerCase(),
    factoryCodeHash: factoryCodeHash.toLowerCase(),
    confirmations: data.HOOKS_LAUNCH_EXECUTOR_CONFIRMATIONS,
    pollIntervalMs: data.HOOKS_LAUNCH_EXECUTOR_POLL_INTERVAL_MS,
    leaseSeconds: data.HOOKS_LAUNCH_EXECUTOR_LEASE_SECONDS,
    maxAttempts: data.HOOKS_LAUNCH_EXECUTOR_MAX_ATTEMPTS,
    retryDelaySeconds: data.HOOKS_LAUNCH_EXECUTOR_RETRY_DELAY_SECONDS,
    gasLimitCap: data.HOOKS_LAUNCH_EXECUTOR_GAS_LIMIT_CAP,
    maxGasPriceGwei: data.HOOKS_LAUNCH_EXECUTOR_MAX_GAS_PRICE_GWEI,
  });
}

export interface Launch2SnapshotPublisherConfig {
  /** 2 or 3 distinct snapshot signer keys, in configured order. */
  readonly signerPrivateKeys: readonly `0x${string}`[];
  readonly submitterPrivateKey: `0x${string}`;
  /** `own` = LAUNCH2_SNAPSHOT_SUBMITTER_PRIVATE_KEY; `executor` = reused. */
  readonly submitterSource: "own" | "executor";
  readonly pollIntervalMs: number;
  readonly confirmations: number;
  readonly maxGasPriceGwei: number;
}

function normalizedKey(key: string): `0x${string}` {
  return (
    key.startsWith("0x") ? key.toLowerCase() : `0x${key.toLowerCase()}`
  ) as `0x${string}`;
}

/**
 * Decision 0118: the snapshot publisher signs EIP-712 `Snapshot` digests
 * with 2 of the 3 registered signer keys and submits `publishSnapshot` from
 * the submitter account (its own key, else the Hooks executor key).
 * `false` (default) → null. `true` refuses boot without ≥ 2 distinct
 * well-formed signer keys (at most 3), without a submitter key, or off
 * `LAUNCH_CHAIN_ID=97`. No key enters a log line or an error message.
 */
export function parseLaunch2SnapshotPublisher(data: {
  readonly LAUNCH_CHAIN_ID: "56" | "97";
  readonly LAUNCH_MAINNET_ACK?: string | undefined;
  readonly BSC_WRITES_ENABLED?: boolean | undefined;
  readonly LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED: boolean;
  readonly LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS?: string | undefined;
  readonly LAUNCH2_SNAPSHOT_SUBMITTER_PRIVATE_KEY?: string | undefined;
  readonly HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY?: string | undefined;
  readonly LAUNCH2_SNAPSHOT_PUBLISHER_POLL_INTERVAL_MS: number;
  readonly LAUNCH2_SNAPSHOT_PUBLISHER_CONFIRMATIONS: number;
  readonly LAUNCH2_SNAPSHOT_PUBLISHER_MAX_GAS_PRICE_GWEI: number;
}): Launch2SnapshotPublisherConfig | null {
  if (!data.LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED) {
    return null;
  }
  const issues: string[] = [];
  const signerKeys = (data.LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
  if (signerKeys.some((key) => !privateKeyPattern.test(key))) {
    issues.push(
      "LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: every entry must be a 32-byte hex key",
    );
  }
  const distinct = [...new Set(signerKeys.map(normalizedKey))];
  if (distinct.length < 2 || distinct.length > 3) {
    issues.push(
      "LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: 2 or 3 distinct comma-separated keys are required when LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED=true",
    );
  }
  const own = data.LAUNCH2_SNAPSHOT_SUBMITTER_PRIVATE_KEY?.trim();
  const executor = data.HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY?.trim();
  const submitter = own !== undefined && own !== "" ? own : (executor ?? "");
  if (submitter === "" || !privateKeyPattern.test(submitter)) {
    issues.push(
      "LAUNCH2_SNAPSHOT_SUBMITTER_PRIVATE_KEY: a 32-byte hex key (or HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY) is required when LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED=true",
    );
  }
  issues.push(
    ...launchSlotWriteLaneIssues("LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED", data),
  );
  if (issues.length > 0) {
    throw new ConfigurationError(issues);
  }
  return Object.freeze({
    signerPrivateKeys: Object.freeze(distinct),
    submitterPrivateKey: normalizedKey(submitter),
    submitterSource: own !== undefined && own !== "" ? "own" : "executor",
    pollIntervalMs: data.LAUNCH2_SNAPSHOT_PUBLISHER_POLL_INTERVAL_MS,
    confirmations: data.LAUNCH2_SNAPSHOT_PUBLISHER_CONFIRMATIONS,
    maxGasPriceGwei: data.LAUNCH2_SNAPSHOT_PUBLISHER_MAX_GAS_PRICE_GWEI,
  });
}

export interface Launch2BuybackKeeperConfig {
  readonly privateKey: `0x${string}`;
  /** The preferred Factory: OfficialTax, else LoopDynamic (Decision 0133). */
  readonly factoryAddress: string;
  /**
   * Decision 0141: every configured Factory (OfficialTax first, then a
   * complete LoopDynamic pair); each instance is checked against its own.
   */
  readonly factoryAddresses: readonly string[];
  /** Tick interval (≥ 10 = `BuybackExecutor.MIN_SUCCESS_INTERVAL`). */
  readonly intervalSeconds: number;
  readonly confirmations: number;
}

/**
 * Decision 0131: the LoopDynamic `poke()` keeper (permissionless call; any
 * funded testnet account). `false` (default) → null; `true` refuses boot
 * without a 32-byte hex key or off `LAUNCH_CHAIN_ID=97`.
 */
export function parseLaunch2DynamicPoke(data: {
  readonly LAUNCH_CHAIN_ID: "56" | "97";
  readonly LAUNCH_MAINNET_ACK?: string | undefined;
  readonly BSC_WRITES_ENABLED?: boolean | undefined;
  readonly LAUNCH2_DYNAMIC_POKE_ENABLED: boolean;
  readonly LAUNCH2_DYNAMIC_POKE_PRIVATE_KEY?: string | undefined;
  readonly LAUNCH2_DYNAMIC_POKE_INTERVAL_SECONDS: number;
}): {
  readonly privateKey: `0x${string}`;
  readonly intervalSeconds: number;
} | null {
  if (!data.LAUNCH2_DYNAMIC_POKE_ENABLED) return null;
  const issues: string[] = [];
  const key = data.LAUNCH2_DYNAMIC_POKE_PRIVATE_KEY?.trim() ?? "";
  if (key === "" || !privateKeyPattern.test(key)) {
    issues.push(
      "LAUNCH2_DYNAMIC_POKE_PRIVATE_KEY: a 32-byte hex key is required when LAUNCH2_DYNAMIC_POKE_ENABLED=true",
    );
  }
  issues.push(
    ...launchSlotWriteLaneIssues("LAUNCH2_DYNAMIC_POKE_ENABLED", data),
  );
  if (issues.length > 0) throw new ConfigurationError(issues);
  return Object.freeze({
    privateKey: normalizedKey(key),
    intervalSeconds: data.LAUNCH2_DYNAMIC_POKE_INTERVAL_SECONDS,
  });
}

/**
 * Decision 0121: the buyback keeper signs `BuybackExecutor.execute()` from
 * a Factory keeper account. `false` (default) → null. `true` refuses boot
 * without a 32-byte hex key, without a Factory to verify the keepers
 * against (HOOKS_LAUNCH_FACTORY_ADDRESS, else — Decision 0133 — the
 * LoopDynamic LAUNCH2_DYNAMIC_FACTORY_ADDRESS), or off `LAUNCH_CHAIN_ID=97`. The
 * interval floor (10 s) is enforced by the schema. No key enters a log
 * line or an error message.
 */
export function parseLaunch2BuybackKeeper(data: {
  readonly LAUNCH_CHAIN_ID: "56" | "97";
  readonly LAUNCH_MAINNET_ACK?: string | undefined;
  readonly BSC_WRITES_ENABLED?: boolean | undefined;
  readonly LAUNCH2_BUYBACK_KEEPER_ENABLED: boolean;
  readonly LAUNCH2_BUYBACK_KEEPER_PRIVATE_KEY?: string | undefined;
  readonly HOOKS_LAUNCH_FACTORY_ADDRESS?: string | undefined;
  readonly LAUNCH2_DYNAMIC_FACTORY_ADDRESS?: string | undefined;
  readonly LAUNCH2_DYNAMIC_FACTORY_CODE_HASH?: string | undefined;
  readonly LAUNCH2_BUYBACK_KEEPER_INTERVAL_SECONDS: number;
  readonly LAUNCH2_BUYBACK_KEEPER_CONFIRMATIONS: number;
}): Launch2BuybackKeeperConfig | null {
  if (!data.LAUNCH2_BUYBACK_KEEPER_ENABLED) {
    return null;
  }
  const issues: string[] = [];
  const key = data.LAUNCH2_BUYBACK_KEEPER_PRIVATE_KEY?.trim() ?? "";
  if (key === "" || !privateKeyPattern.test(key)) {
    issues.push(
      "LAUNCH2_BUYBACK_KEEPER_PRIVATE_KEY: a 32-byte hex key is required when LAUNCH2_BUYBACK_KEEPER_ENABLED=true",
    );
  }
  // Decision 0133: the OfficialTax Factory (unchanged), else the
  // LoopDynamic one (complete pair); both have primary / fallback keepers.
  const officialTaxFactory = data.HOOKS_LAUNCH_FACTORY_ADDRESS?.trim() ?? "";
  const factory = /^0x[0-9a-fA-F]{40}$/u.test(officialTaxFactory)
    ? officialTaxFactory
    : data.LAUNCH2_DYNAMIC_FACTORY_CODE_HASH === undefined
      ? ""
      : (data.LAUNCH2_DYNAMIC_FACTORY_ADDRESS?.trim() ?? "");
  const dynamicFactory =
    data.LAUNCH2_DYNAMIC_FACTORY_CODE_HASH === undefined
      ? ""
      : (data.LAUNCH2_DYNAMIC_FACTORY_ADDRESS?.trim() ?? "");
  const factoryAddresses = [
    ...new Set(
      [factory, dynamicFactory]
        .filter((address) => /^0x[0-9a-fA-F]{40}$/u.test(address))
        .map((address) => address.toLowerCase()),
    ),
  ];
  if (!/^0x[0-9a-fA-F]{40}$/u.test(factory)) {
    issues.push(
      "LAUNCH2_BUYBACK_KEEPER_ENABLED: requires HOOKS_LAUNCH_FACTORY_ADDRESS or LAUNCH2_DYNAMIC_FACTORY_ADDRESS (the keeper is verified against the Factory keepers)",
    );
  }
  issues.push(
    ...launchSlotWriteLaneIssues("LAUNCH2_BUYBACK_KEEPER_ENABLED", data),
  );
  if (data.LAUNCH2_BUYBACK_KEEPER_INTERVAL_SECONDS < 10) {
    issues.push(
      "LAUNCH2_BUYBACK_KEEPER_INTERVAL_SECONDS: must be at least 10 (BuybackExecutor.MIN_SUCCESS_INTERVAL)",
    );
  }
  if (issues.length > 0) {
    throw new ConfigurationError(issues);
  }
  return Object.freeze({
    privateKey: normalizedKey(key),
    factoryAddress: factory.toLowerCase(),
    factoryAddresses: Object.freeze(factoryAddresses),
    intervalSeconds: data.LAUNCH2_BUYBACK_KEEPER_INTERVAL_SECONDS,
    confirmations: data.LAUNCH2_BUYBACK_KEEPER_CONFIRMATIONS,
  });
}

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
  readonly BSC_LOG_ADDRESS_CHUNK_SIZE: number;
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
    logAddressChunkSize: data.BSC_LOG_ADDRESS_CHUNK_SIZE,
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

/** Decision 0149: default fiat FX provider (ECB reference rate via Frankfurter). */
export const defaultFiatFxProviderUrl =
  "https://api.frankfurter.dev/v2/providers/ecb/rate/USD/CNY";

/**
 * Decision 0149: `FIAT_FX_PROVIDER_URL` must be https and name one provider
 * (`/providers/{key}/`), whose key becomes the published `source`.
 */
function parseFiatFxProviderUrl(value: string): {
  readonly providerUrl: string;
  readonly source: string;
} {
  let url: URL | null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  const source =
    url === null
      ? null
      : (/\/providers\/([A-Za-z]{2,16})\//.exec(url.pathname)?.[1] ?? null);
  if (
    url === null ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    source === null
  ) {
    throw new ConfigurationError([
      "FIAT_FX_PROVIDER_URL: must be an https URL naming one provider (/providers/{key}/)",
    ]);
  }
  return Object.freeze({
    providerUrl: url.toString(),
    source: source.toLowerCase(),
  });
}

export const defaultPasskeyAndroidPackage = "com.cywd.loop";
/**
 * Decision 0106: the iOS app moved to a new Apple account and bundle ID. The
 * Team ID has no default; without `PASSKEY_IOS_TEAM_ID` no iOS app identifier
 * is published anywhere.
 */
export const defaultPasskeyIosBundleId = "com.cywd.loopapp";

const passkeyAndroidPackagePattern =
  /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const passkeyIosBundleIdPattern = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const passkeyIosTeamIdPattern = /^[A-Z0-9]{10}$/;
/** 32 uppercase hex byte pairs joined by colons: one SHA-256 fingerprint. */
const passkeySha256FingerprintPattern = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;
const maximumPasskeyFingerprints = 10;

/**
 * Comma-separated signing-certificate SHA-256 fingerprints: 32 colon-separated
 * hex byte pairs each, upper-cased, unique, at most ten.
 */
function parseCertificateFingerprints(
  fieldName: string,
  raw: string | undefined,
  existing: readonly string[] = [],
): string[] {
  const fingerprints: string[] = [];
  for (const rawEntry of (raw ?? "").split(",")) {
    const entry = rawEntry.trim().toUpperCase();
    if (entry.length === 0) {
      continue;
    }
    if (!passkeySha256FingerprintPattern.test(entry)) {
      throw new ConfigurationError([
        `${fieldName}: every entry must be 32 colon-separated uppercase hex byte pairs`,
      ]);
    }
    if (fingerprints.includes(entry) || existing.includes(entry)) {
      throw new ConfigurationError([`${fieldName}: entries must be unique`]);
    }
    fingerprints.push(entry);
  }
  if (fingerprints.length > maximumPasskeyFingerprints) {
    throw new ConfigurationError([
      `${fieldName}: at most ${maximumPasskeyFingerprints.toString(10)} fingerprints are accepted`,
    ]);
  }
  return fingerprints;
}

/**
 * Android package claiming `/u/*` and `/c/*` (Decision 0090). The iOS app
 * identifier is no longer a constant: Decision 0106 derives it from
 * `PASSKEY_IOS_TEAM_ID` + `PASSKEY_IOS_BUNDLE_ID`.
 */
export const appLinksAndroidPackage = "com.cywd.loop";
/** Development debug keystore of the LOOP Android build (Decision 0090). */
export const appLinksAndroidDebugFingerprint =
  "AE:60:82:E6:21:F5:9D:3E:63:96:F8:CB:4B:8D:86:28:7C:F6:2B:29:06:D5:2C:2E:5D:8E:A7:D4:DB:5E:3E:FA";

function parseAppLinksConfig(
  data: {
    readonly ANDROID_RELEASE_CERT_SHA256?: string | undefined;
    readonly APP_DOWNLOAD_URL?: string | undefined;
    readonly APP_STORE_URL_IOS?: string | undefined;
    readonly APP_STORE_URL_ANDROID?: string | undefined;
  },
  ios: PasskeyIosConfig | null,
): AppLinksConfig {
  const release = parseCertificateFingerprints(
    "ANDROID_RELEASE_CERT_SHA256",
    data.ANDROID_RELEASE_CERT_SHA256,
    [appLinksAndroidDebugFingerprint],
  );
  const httpsUrl = (name: string, value: string | undefined): string | null => {
    if (value === undefined) return null;
    const url = parseUrl(name, value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new ConfigurationError([
        `${name}: must be an https URL without credentials`,
      ]);
    }
    return url.toString();
  };
  const downloadUrl = httpsUrl("APP_DOWNLOAD_URL", data.APP_DOWNLOAD_URL);
  const iosStoreUrl = httpsUrl("APP_STORE_URL_IOS", data.APP_STORE_URL_IOS);
  const androidStoreUrl = httpsUrl(
    "APP_STORE_URL_ANDROID",
    data.APP_STORE_URL_ANDROID,
  );
  return Object.freeze({
    iosAppIds: Object.freeze(ios === null ? [] : [ios.appId]),
    androidPackage: appLinksAndroidPackage,
    androidCertificateFingerprints: Object.freeze([
      appLinksAndroidDebugFingerprint,
      ...release,
    ]),
    downloadUrl,
    iosStoreUrl,
    androidStoreUrl,
  });
}

/**
 * Both association files are published only from values an operator typed in
 * full. Nothing here is derived, normalized upward, or defaulted into
 * existence: a malformed fingerprint or Team ID stops the process instead of
 * publishing a file that would advertise an association nobody verified.
 */
function parsePasskeyRelyingPartyConfig(data: {
  readonly PASSKEY_ANDROID_PACKAGE?: string | undefined;
  readonly PASSKEY_ANDROID_CERT_SHA256?: string | undefined;
  readonly PASSKEY_IOS_TEAM_ID?: string | undefined;
  readonly PASSKEY_IOS_BUNDLE_ID?: string | undefined;
}): PasskeyRelyingPartyConfig {
  const packageName =
    data.PASSKEY_ANDROID_PACKAGE ?? defaultPasskeyAndroidPackage;
  if (!passkeyAndroidPackagePattern.test(packageName)) {
    throw new ConfigurationError([
      "PASSKEY_ANDROID_PACKAGE: must be a dotted Android package name",
    ]);
  }
  const fingerprints = parseCertificateFingerprints(
    "PASSKEY_ANDROID_CERT_SHA256",
    data.PASSKEY_ANDROID_CERT_SHA256,
  );

  const bundleId = data.PASSKEY_IOS_BUNDLE_ID ?? defaultPasskeyIosBundleId;
  if (!passkeyIosBundleIdPattern.test(bundleId)) {
    throw new ConfigurationError([
      "PASSKEY_IOS_BUNDLE_ID: must be a dotted bundle identifier",
    ]);
  }
  const teamId = data.PASSKEY_IOS_TEAM_ID?.toUpperCase();
  if (teamId !== undefined && !passkeyIosTeamIdPattern.test(teamId)) {
    throw new ConfigurationError([
      "PASSKEY_IOS_TEAM_ID: must be a ten-character Apple Team ID",
    ]);
  }

  return Object.freeze({
    android:
      fingerprints.length === 0
        ? null
        : Object.freeze({
            packageName,
            certificateFingerprints: Object.freeze(fingerprints),
          }),
    ios:
      teamId === undefined
        ? null
        : Object.freeze({ appId: `${teamId}.${bundleId}` }),
  });
}

const canaryAssetIdPattern = /^eip155:[1-9][0-9]{0,9}:(native|0x[0-9a-f]{40})$/;
const canaryMaxUsdPattern = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,6})?$/;
const canaryAddressPattern = /^0x[0-9a-f]{40}$/;

/**
 * Write admission is off unless explicitly enabled, and enabling it requires
 * both an asset allowlist of canonical asset IDs and a positive USD ceiling.
 */
function parseBscWriteConfig(data: {
  readonly BSC_WRITES_ENABLED: boolean;
  readonly BSC_WRITE_CANARY_ASSETS?: string | undefined;
  readonly BSC_WRITE_CANARY_MAX_USD: string;
  readonly BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST?: string | undefined;
  readonly BSC_WRITE_CANARY_DAILY_MAX_USD?: string | undefined;
  readonly LOOP_SWAP_FEE_BPS: number;
}): BscWriteConfig | null {
  if (!data.BSC_WRITES_ENABLED) {
    return null;
  }
  const assetIds: string[] = [];
  for (const rawEntry of (data.BSC_WRITE_CANARY_ASSETS ?? "").split(",")) {
    const entry = rawEntry.trim().toLowerCase();
    if (entry.length === 0) {
      continue;
    }
    if (!canaryAssetIdPattern.test(entry)) {
      throw new ConfigurationError([
        "BSC_WRITE_CANARY_ASSETS: every entry must be a canonical eip155 asset ID",
      ]);
    }
    if (!assetIds.includes(entry)) {
      assetIds.push(entry);
    }
  }
  if (assetIds.length === 0) {
    throw new ConfigurationError([
      "BSC_WRITE_CANARY_ASSETS: at least one canary asset is required when writes are enabled",
    ]);
  }
  const maxUsd = data.BSC_WRITE_CANARY_MAX_USD;
  if (!canaryMaxUsdPattern.test(maxUsd) || /^0(\.0+)?$/.test(maxUsd)) {
    throw new ConfigurationError([
      "BSC_WRITE_CANARY_MAX_USD: must be a positive decimal with at most 6 fraction digits",
    ]);
  }
  const dailyMaxUsdRaw = data.BSC_WRITE_CANARY_DAILY_MAX_USD?.trim();
  const dailyMaxUsd =
    dailyMaxUsdRaw === undefined || dailyMaxUsdRaw.length === 0
      ? null
      : dailyMaxUsdRaw;
  if (
    dailyMaxUsd !== null &&
    (!canaryMaxUsdPattern.test(dailyMaxUsd) || /^0(\.0+)?$/.test(dailyMaxUsd))
  ) {
    throw new ConfigurationError([
      "BSC_WRITE_CANARY_DAILY_MAX_USD: must be a positive decimal with at most 6 fraction digits",
    ]);
  }
  const counterparties: string[] = [];
  for (const rawEntry of (
    data.BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST ?? ""
  ).split(",")) {
    const entry = rawEntry.trim().toLowerCase();
    if (entry.length === 0) {
      continue;
    }
    if (!canaryAddressPattern.test(entry)) {
      throw new ConfigurationError([
        "BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST: every entry must be a 0x-prefixed 20-byte address",
      ]);
    }
    if (!counterparties.includes(entry)) {
      counterparties.push(entry);
    }
  }
  return Object.freeze({
    configVersion: "bscWriteCanaryV1" as const,
    canaryAssetIds: Object.freeze(assetIds),
    canaryMaxUsd: maxUsd,
    canaryDailyMaxUsd: dailyMaxUsd,
    canaryCounterpartyAddresses: Object.freeze(counterparties),
    swapFeeBps: data.LOOP_SWAP_FEE_BPS === 0 ? null : data.LOOP_SWAP_FEE_BPS,
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
    MARKET_DEXSCREENER_BUDGET_API:
      environment["MARKET_DEXSCREENER_BUDGET_API"] ?? "120",
    MARKET_DEXSCREENER_BUDGET_WORKER:
      environment["MARKET_DEXSCREENER_BUDGET_WORKER"] ?? "120",
    MARKET_GECKOTERMINAL_RATE_LIMIT_PER_MINUTE:
      environment["MARKET_GECKOTERMINAL_RATE_LIMIT_PER_MINUTE"] ?? "30",
    MARKET_GECKOTERMINAL_BUDGET_WORKER:
      environment["MARKET_GECKOTERMINAL_BUDGET_WORKER"] ?? "10",
    MARKET_GOPLUS_RATE_LIMIT_PER_MINUTE:
      environment["MARKET_GOPLUS_RATE_LIMIT_PER_MINUTE"] ?? "30",
    MARKET_UNLISTED_PRICE_TTL_SECONDS:
      environment["MARKET_UNLISTED_PRICE_TTL_SECONDS"] ?? "60",
    MARKET_UNLISTED_METADATA_TTL_SECONDS:
      environment["MARKET_UNLISTED_METADATA_TTL_SECONDS"] ?? "3600",
    MARKET_PRICE_TTL_SECONDS: environment["MARKET_PRICE_TTL_SECONDS"] ?? "30",
    MARKET_SECURITY_TTL_SECONDS:
      environment["MARKET_SECURITY_TTL_SECONDS"] ?? "600",
    MARKET_CANDLES_TTL_SECONDS:
      environment["MARKET_CANDLES_TTL_SECONDS"] ?? "60",
    MARKET_SPARKLINE_TTL_SECONDS:
      environment["MARKET_SPARKLINE_TTL_SECONDS"] ?? "300",
    MARKET_STALE_GRACE_SECONDS:
      environment["MARKET_STALE_GRACE_SECONDS"] ?? "900",
    GOPLUS_APP_KEY: environment["GOPLUS_APP_KEY"],
    GOPLUS_APP_SECRET: environment["GOPLUS_APP_SECRET"],
  };
}

function parseMarketConfig(data: {
  readonly MARKET_PROVIDER_DEXSCREENER_ENABLED: boolean;
  readonly MARKET_PROVIDER_GECKOTERMINAL_ENABLED: boolean;
  readonly MARKET_DEXSCREENER_BUDGET_API: number;
  readonly MARKET_DEXSCREENER_BUDGET_WORKER: number;
  readonly MARKET_GECKOTERMINAL_RATE_LIMIT_PER_MINUTE: number;
  readonly MARKET_GECKOTERMINAL_BUDGET_WORKER: number;
  readonly MARKET_GOPLUS_RATE_LIMIT_PER_MINUTE: number;
  readonly MARKET_PRICE_TTL_SECONDS: number;
  readonly MARKET_SECURITY_TTL_SECONDS: number;
  readonly MARKET_CANDLES_TTL_SECONDS: number;
  readonly MARKET_SPARKLINE_TTL_SECONDS: number;
  readonly MARKET_STALE_GRACE_SECONDS: number;
  readonly MARKET_UNLISTED_PRICE_TTL_SECONDS: number;
  readonly MARKET_UNLISTED_METADATA_TTL_SECONDS: number;
  readonly GOPLUS_APP_KEY?: string | undefined;
  readonly GOPLUS_APP_SECRET?: string | undefined;
}): MarketConfig {
  return Object.freeze({
    dexscreener: Object.freeze({
      enabled: data.MARKET_PROVIDER_DEXSCREENER_ENABLED,
      budgetApiPerMinute: data.MARKET_DEXSCREENER_BUDGET_API,
      budgetWorkerPerMinute: data.MARKET_DEXSCREENER_BUDGET_WORKER,
    }),
    geckoterminal: Object.freeze({
      enabled: data.MARKET_PROVIDER_GECKOTERMINAL_ENABLED,
      rateLimitPerMinute: data.MARKET_GECKOTERMINAL_RATE_LIMIT_PER_MINUTE,
      budgetWorkerPerMinute: data.MARKET_GECKOTERMINAL_BUDGET_WORKER,
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
    sparklineTtlSeconds: data.MARKET_SPARKLINE_TTL_SECONDS,
    staleGraceSeconds: data.MARKET_STALE_GRACE_SECONDS,
    unlistedPriceTtlSeconds: data.MARKET_UNLISTED_PRICE_TTL_SECONDS,
    unlistedMetadataTtlSeconds: data.MARKET_UNLISTED_METADATA_TTL_SECONDS,
  });
}

export interface AdminConsoleConfig {
  readonly username: string;
  /** Argon2id PHC string (`pnpm admin:hash-password`). */
  readonly passwordHash: string;
  readonly sessionSecret: string;
  /** `Secure` cookie attribute: on unless PUBLIC_BASE_URL is plain http. */
  readonly cookieSecure: boolean;
  /** Decision 0110: `ADMIN_LOGIN_*` (defaults 5 / 900 / 50 / 900 / 900). */
  readonly loginPolicy: AdminLoginPolicy;
}

export const adminUsernamePattern = /^[A-Za-z0-9._@-]{1,64}$/u;
const adminPasswordHashPattern =
  /^\$argon2id\$v=19\$m=[0-9]{1,8},t=[0-9]{1,3},p=[0-9]{1,3}\$[A-Za-z0-9+/]{11,64}\$[A-Za-z0-9+/]{16,128}$/u;

/**
 * Decision 0102: all three `ADMIN_*` variables or none. Any one missing
 * leaves the console unmounted; a present but malformed value refuses boot
 * (the hash must be an argon2id PHC string, the secret 32+ characters).
 */
export function parseAdminConsoleConfig(data: {
  readonly ADMIN_USERNAME?: string | undefined;
  readonly ADMIN_PASSWORD_HASH?: string | undefined;
  readonly ADMIN_SESSION_SECRET?: string | undefined;
  readonly ADMIN_LOGIN_USERNAME_MAX_FAILURES?: number | undefined;
  readonly ADMIN_LOGIN_USERNAME_LOCK_SECONDS?: number | undefined;
  readonly ADMIN_LOGIN_IP_MAX_FAILURES?: number | undefined;
  readonly ADMIN_LOGIN_IP_WINDOW_SECONDS?: number | undefined;
  readonly ADMIN_LOGIN_IP_LOCK_SECONDS?: number | undefined;
  readonly PUBLIC_BASE_URL: string;
}): AdminConsoleConfig | null {
  const issues: string[] = [];
  if (
    data.ADMIN_USERNAME !== undefined &&
    !adminUsernamePattern.test(data.ADMIN_USERNAME)
  ) {
    issues.push("ADMIN_USERNAME: 1-64 characters of A-Z a-z 0-9 . _ @ -");
  }
  if (
    data.ADMIN_PASSWORD_HASH !== undefined &&
    !adminPasswordHashPattern.test(data.ADMIN_PASSWORD_HASH)
  ) {
    issues.push(
      "ADMIN_PASSWORD_HASH: must be an argon2id PHC string from pnpm admin:hash-password",
    );
  }
  if (issues.length > 0) {
    throw new ConfigurationError(issues);
  }
  if (
    data.ADMIN_USERNAME === undefined ||
    data.ADMIN_PASSWORD_HASH === undefined ||
    data.ADMIN_SESSION_SECRET === undefined
  ) {
    return null;
  }
  // Decision 0109: console accounts hash and verify with Node's built-in
  // argon2id; a runtime without it refuses to boot instead of refusing
  // every login.
  if (typeof (cryptoModule as { argon2?: unknown }).argon2 !== "function") {
    throw new ConfigurationError([
      "ADMIN_*: this Node.js runtime has no crypto.argon2 (Node 24.7+ is required)",
    ]);
  }
  return Object.freeze({
    username: data.ADMIN_USERNAME,
    passwordHash: data.ADMIN_PASSWORD_HASH,
    sessionSecret: data.ADMIN_SESSION_SECRET,
    cookieSecure: !data.PUBLIC_BASE_URL.startsWith("http://"),
    loginPolicy: Object.freeze({
      usernameMaximumFailures:
        data.ADMIN_LOGIN_USERNAME_MAX_FAILURES ??
        defaultAdminLoginPolicy.usernameMaximumFailures,
      usernameLockSeconds:
        data.ADMIN_LOGIN_USERNAME_LOCK_SECONDS ??
        defaultAdminLoginPolicy.usernameLockSeconds,
      ipMaximumFailures:
        data.ADMIN_LOGIN_IP_MAX_FAILURES ??
        defaultAdminLoginPolicy.ipMaximumFailures,
      ipWindowSeconds:
        data.ADMIN_LOGIN_IP_WINDOW_SECONDS ??
        defaultAdminLoginPolicy.ipWindowSeconds,
      ipLockSeconds:
        data.ADMIN_LOGIN_IP_LOCK_SECONDS ??
        defaultAdminLoginPolicy.ipLockSeconds,
    }),
  });
}

export const maximumRecommendedCommunityIds = 50;
const recommendedCommunityIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * `RECOMMENDED_COMMUNITY_IDS` (Decision 0095): comma-separated canonical
 * lower-case UUIDv4 community IDs, duplicates dropped, order kept. Anything
 * else refuses to start rather than silently recommending nothing.
 */
function parseRecommendedCommunityIds(
  value: string | undefined,
): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  const ids: string[] = [];
  for (const raw of value.split(",")) {
    const id = raw.trim();
    if (id === "") {
      continue;
    }
    if (!recommendedCommunityIdPattern.test(id)) {
      throw new ConfigurationError([
        "RECOMMENDED_COMMUNITY_IDS: every entry must be a canonical lower-case UUIDv4 community ID",
      ]);
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  if (ids.length > maximumRecommendedCommunityIds) {
    throw new ConfigurationError([
      `RECOMMENDED_COMMUNITY_IDS: at most ${maximumRecommendedCommunityIds} communities`,
    ]);
  }
  return Object.freeze(ids);
}

const intelPromotionImageHostPattern =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/** Decision 0105: comma-separated lower-case DNS names, at most 20. */
export function parseIntelPromotionImageHosts(
  value: string | undefined,
): readonly string[] {
  const hosts: string[] = [];
  for (const raw of (value ?? "").split(",")) {
    const host = raw.trim();
    if (host === "") {
      continue;
    }
    if (!intelPromotionImageHostPattern.test(host)) {
      throw new ConfigurationError([
        "INTEL_PROMOTION_IMAGE_HOSTS: every entry must be a lower-case DNS host name (no scheme, port, or path)",
      ]);
    }
    if (!hosts.includes(host)) {
      hosts.push(host);
    }
  }
  if (hosts.length > 20) {
    throw new ConfigurationError([
      "INTEL_PROMOTION_IMAGE_HOSTS: at most 20 hosts",
    ]);
  }
  return Object.freeze(hosts);
}

function parsePushConfig(data: {
  readonly FIREBASE_SERVICE_ACCOUNT_JSON_PATH?: string | undefined;
}): PushConfig | null {
  const path = data.FIREBASE_SERVICE_ACCOUNT_JSON_PATH;
  return path === undefined
    ? null
    : Object.freeze({ serviceAccountJsonPath: path });
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

const maximumWebOrigins = 16;
const localWebOriginHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Decision 0179: one `WEB_ORIGINS` entry. Like the Provider origins
 * (`parseCommunityAiBaseUrl`): no credentials, path, query, or fragment; a
 * trailing slash is normalised away and `URL.origin` lower-cases the host and
 * drops a default port. https only — except `http://localhost` /
 * `127.0.0.1` / `[::1]` outside production, for a local Next.js dev server.
 */
function parseWebOrigin(value: string, nodeEnv: AppConfig["nodeEnv"]): string {
  const url = parseUrl("WEB_ORIGINS", value);
  const localHttp =
    url.protocol === "http:" &&
    nodeEnv !== "production" &&
    localWebOriginHosts.has(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new ConfigurationError([
      "WEB_ORIGINS: protocol must be https (http only for localhost outside production)",
    ]);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError(["WEB_ORIGINS: credentials are not allowed"]);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ConfigurationError([
      "WEB_ORIGINS: entries must be origins without path, query, or fragment",
    ]);
  }
  return url.origin;
}

function parseWebHttpsUrl(
  name: string,
  raw: string | undefined,
): string | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  if (value.length > 2_048) {
    throw new ConfigurationError([`${name}: at most 2048 characters`]);
  }
  const url = parseUrl(name, value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new ConfigurationError([
      `${name}: must be an https URL without credentials`,
    ]);
  }
  return url.toString();
}

/**
 * Decision 0179: `WEB_ORIGINS` (comma list, empty = surface not mounted),
 * `WEB_BASE_URL` (the website root; `/i/{code}` redirects there when set),
 * and the three store links `GET /v2/web/meta` publishes.
 */
export function parseWebSurfaceConfig(
  environment: NodeJS.ProcessEnv,
  nodeEnv: AppConfig["nodeEnv"],
): WebSurfaceConfig {
  const rawOrigins = environment["WEB_ORIGINS"]?.trim() ?? "";
  const origins: string[] = [];
  if (rawOrigins !== "") {
    for (const entry of rawOrigins.split(",")) {
      const trimmed = entry.trim();
      if (trimmed === "") {
        throw new ConfigurationError(["WEB_ORIGINS: empty entry"]);
      }
      const origin = parseWebOrigin(trimmed, nodeEnv);
      if (origins.includes(origin)) {
        throw new ConfigurationError(["WEB_ORIGINS: entries must be unique"]);
      }
      origins.push(origin);
    }
  }
  if (origins.length > maximumWebOrigins) {
    throw new ConfigurationError([
      `WEB_ORIGINS: at most ${maximumWebOrigins.toString(10)} origins`,
    ]);
  }
  const rawBase = environment["WEB_BASE_URL"]?.trim() ?? "";
  let baseUrl: string | null = null;
  if (rawBase !== "") {
    const url = parseUrl("WEB_BASE_URL", rawBase);
    const localHttp =
      url.protocol === "http:" &&
      nodeEnv !== "production" &&
      localWebOriginHosts.has(url.hostname);
    if (
      (url.protocol !== "https:" && !localHttp) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new ConfigurationError([
        "WEB_BASE_URL: must be an https URL without credentials, query, or fragment",
      ]);
    }
    baseUrl = `${url.origin}${url.pathname}`.replace(/\/+$/u, "");
  }
  return Object.freeze({
    origins: Object.freeze(origins),
    baseUrl,
    appLinks: Object.freeze({
      ios: parseWebHttpsUrl(
        "WEB_APP_LINKS_IOS",
        environment["WEB_APP_LINKS_IOS"],
      ),
      android: parseWebHttpsUrl(
        "WEB_APP_LINKS_ANDROID",
        environment["WEB_APP_LINKS_ANDROID"],
      ),
      testflight: parseWebHttpsUrl(
        "WEB_APP_LINKS_TESTFLIGHT",
        environment["WEB_APP_LINKS_TESTFLIGHT"],
      ),
    }),
  });
}

/**
 * Decision 0147 revision S211: `none`, or a comma list of distinct names
 * from `publicClientIpHeaderNames`, read in the order given.
 */
export function parsePublicClientIpHeaders(
  value: string,
): readonly PublicClientIpHeaderName[] {
  if (value === "none") return Object.freeze([]);
  const names = value.split(",").map((name) => name.trim().toLowerCase());
  const known: readonly string[] = publicClientIpHeaderNames;
  if (
    names.some((name) => !known.includes(name)) ||
    new Set(names).size !== names.length
  ) {
    throw new ConfigurationError([
      `PUBLIC_CLIENT_IP_HEADERS: must be none or distinct names from ${publicClientIpHeaderNames.join(", ")}`,
    ]);
  }
  return Object.freeze(names as PublicClientIpHeaderName[]);
}

/**
 * Decision 0173: NFT_IMAGE_STORAGE / FILEBASE_RPC_* / IPFS_GATEWAY_BASE_URL.
 * https only; `filebase` without both RPC values refuses to start.
 */
function parseNftImageStorage(data: {
  readonly NFT_IMAGE_STORAGE: "local" | "filebase";
  readonly FILEBASE_RPC_ENDPOINT?: string | undefined;
  readonly FILEBASE_RPC_TOKEN?: string | undefined;
  readonly IPFS_GATEWAY_BASE_URL: string;
}): {
  readonly storage: AppConfig["nftImageStorage"];
  readonly gatewayBaseUrl: string;
} {
  const issues: string[] = [];
  const gateway = new URL(data.IPFS_GATEWAY_BASE_URL);
  if (gateway.protocol !== "https:" || gateway.username || gateway.password) {
    issues.push("IPFS_GATEWAY_BASE_URL: must be https without credentials");
  }
  if (gateway.search !== "" || gateway.hash !== "") {
    issues.push("IPFS_GATEWAY_BASE_URL: no query or fragment");
  }
  let storage: AppConfig["nftImageStorage"] = Object.freeze({
    mode: "local" as const,
  });
  if (data.NFT_IMAGE_STORAGE === "filebase") {
    const endpoint = data.FILEBASE_RPC_ENDPOINT;
    const token = data.FILEBASE_RPC_TOKEN;
    if (endpoint === undefined || token === undefined) {
      issues.push(
        "FILEBASE_RPC_ENDPOINT and FILEBASE_RPC_TOKEN: required when NFT_IMAGE_STORAGE=filebase",
      );
    } else {
      const url = new URL(endpoint);
      if (url.protocol !== "https:" || url.username || url.password) {
        issues.push("FILEBASE_RPC_ENDPOINT: must be https without credentials");
      }
      storage = Object.freeze({
        mode: "filebase" as const,
        rpcEndpoint: endpoint.replace(/\/+$/u, ""),
        rpcToken: token,
      });
    }
  }
  if (issues.length > 0) throw new ConfigurationError(issues);
  return Object.freeze({
    storage,
    gatewayBaseUrl: data.IPFS_GATEWAY_BASE_URL.replace(/\/+$/u, ""),
  });
}

export function loadConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const rawNodeEnv = environment["NODE_ENV"] ?? "development";
  const parsed = environmentSchema.safeParse({
    NODE_ENV: rawNodeEnv,
    HOST: environment["HOST"] ?? "127.0.0.1",
    PORT: environment["PORT"] ?? "3000",
    PUBLIC_BASE_URL: environment["PUBLIC_BASE_URL"] ?? "http://127.0.0.1:3000",
    TOKEN_LOGO_URL_MODE: environment["TOKEN_LOGO_URL_MODE"] ?? "proxy",
    NFT_IMAGE_STORAGE: environment["NFT_IMAGE_STORAGE"] || "local",
    FILEBASE_RPC_ENDPOINT: environment["FILEBASE_RPC_ENDPOINT"],
    FILEBASE_RPC_TOKEN: environment["FILEBASE_RPC_TOKEN"],
    IPFS_GATEWAY_BASE_URL:
      environment["IPFS_GATEWAY_BASE_URL"] || "https://ipfs.filebase.io/ipfs",
    API_DOCS_ENABLED:
      environment["API_DOCS_ENABLED"] ??
      (rawNodeEnv === "production" ? "false" : "true"),
    TRUST_PROXY: environment["TRUST_PROXY"] ?? "false",
    PUBLIC_RATE_LIMIT_PER_MINUTE:
      environment["PUBLIC_RATE_LIMIT_PER_MINUTE"] ?? "120",
    PUBLIC_CLIENT_IP_HEADERS:
      environment["PUBLIC_CLIENT_IP_HEADERS"] ?? "x-forwarded-for",
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
    FIREBASE_SERVICE_ACCOUNT_JSON_PATH:
      environment["FIREBASE_SERVICE_ACCOUNT_JSON_PATH"],
    STREAM_API_KEY: environment["STREAM_API_KEY"],
    STREAM_API_SECRET: environment["STREAM_API_SECRET"],
    STREAM_TOKEN_QUOTA_HMAC_SECRET:
      environment["STREAM_TOKEN_QUOTA_HMAC_SECRET"],
    STREAM_TOKEN_USER_LIMIT_PER_MINUTE:
      environment["STREAM_TOKEN_USER_LIMIT_PER_MINUTE"] ?? "10",
    STREAM_TOKEN_IP_LIMIT_PER_MINUTE:
      environment["STREAM_TOKEN_IP_LIMIT_PER_MINUTE"] ?? "60",
    STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF:
      environment["STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF"],
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
    BSC_LOG_ADDRESS_CHUNK_SIZE:
      environment["BSC_LOG_ADDRESS_CHUNK_SIZE"] ?? "8",
    BSC_USD1_TOKEN_ADDRESS: environment["BSC_USD1_TOKEN_ADDRESS"],
    BSC_USD1_VERIFIED: environment["BSC_USD1_VERIFIED"] ?? "false",
    BSC_WRITES_ENABLED: environment["BSC_WRITES_ENABLED"] ?? "false",
    BSC_WRITE_CANARY_ASSETS: environment["BSC_WRITE_CANARY_ASSETS"],
    BSC_WRITE_CANARY_MAX_USD: environment["BSC_WRITE_CANARY_MAX_USD"] ?? "20",
    BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST:
      environment["BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST"],
    BSC_WRITE_CANARY_DAILY_MAX_USD:
      environment["BSC_WRITE_CANARY_DAILY_MAX_USD"],
    LOOP_SWAP_FEE_BPS: environment["LOOP_SWAP_FEE_BPS"] ?? "0",
    WALLET_GAS_RESERVE_BNB: environment["WALLET_GAS_RESERVE_BNB"] ?? "0.005",
    MINING_MOCK_HOLDINGS_ENABLED:
      environment["MINING_MOCK_HOLDINGS_ENABLED"] ?? "false",
    PASSKEY_ANDROID_PACKAGE:
      environment["PASSKEY_ANDROID_PACKAGE"] ?? defaultPasskeyAndroidPackage,
    PASSKEY_ANDROID_CERT_SHA256: environment["PASSKEY_ANDROID_CERT_SHA256"],
    PASSKEY_IOS_TEAM_ID: environment["PASSKEY_IOS_TEAM_ID"],
    PASSKEY_IOS_BUNDLE_ID:
      environment["PASSKEY_IOS_BUNDLE_ID"] ?? defaultPasskeyIosBundleId,
    ANDROID_RELEASE_CERT_SHA256: environment["ANDROID_RELEASE_CERT_SHA256"],
    APP_DOWNLOAD_URL: environment["APP_DOWNLOAD_URL"],
    APP_STORE_URL_IOS: environment["APP_STORE_URL_IOS"],
    APP_STORE_URL_ANDROID: environment["APP_STORE_URL_ANDROID"],
    COMMUNITY_CHAT_REAL_IDENTITY:
      environment["COMMUNITY_CHAT_REAL_IDENTITY"] ?? "true",
    RECOMMENDED_COMMUNITY_IDS: environment["RECOMMENDED_COMMUNITY_IDS"],
    INTEL_PROMOTION_IMAGE_HOSTS: environment["INTEL_PROMOTION_IMAGE_HOSTS"],
    ADMIN_USERNAME: environment["ADMIN_USERNAME"],
    ADMIN_PASSWORD_HASH: environment["ADMIN_PASSWORD_HASH"],
    ADMIN_SESSION_SECRET: environment["ADMIN_SESSION_SECRET"],
    ADMIN_LOGIN_USERNAME_MAX_FAILURES:
      environment["ADMIN_LOGIN_USERNAME_MAX_FAILURES"] ?? "5",
    ADMIN_LOGIN_USERNAME_LOCK_SECONDS:
      environment["ADMIN_LOGIN_USERNAME_LOCK_SECONDS"] ?? "900",
    ADMIN_LOGIN_IP_MAX_FAILURES:
      environment["ADMIN_LOGIN_IP_MAX_FAILURES"] ?? "50",
    ADMIN_LOGIN_IP_WINDOW_SECONDS:
      environment["ADMIN_LOGIN_IP_WINDOW_SECONDS"] ?? "900",
    ADMIN_LOGIN_IP_LOCK_SECONDS:
      environment["ADMIN_LOGIN_IP_LOCK_SECONDS"] ?? "900",
    MEME_OPERATOR_PRIVATE_KEY: environment["MEME_OPERATOR_PRIVATE_KEY"],
    MINING_REWARD_SIGNER_PRIVATE_KEY:
      environment["MINING_REWARD_SIGNER_PRIVATE_KEY"],
    MINING_SETTLEMENT_TEST_TRIGGER:
      environment["MINING_SETTLEMENT_TEST_TRIGGER"] ?? "false",
    TESTNET_FAUCET_ENABLED: environment["TESTNET_FAUCET_ENABLED"] ?? "false",
    TESTNET_FAUCET_BNB_AMOUNT:
      environment["TESTNET_FAUCET_BNB_AMOUNT"] ?? "0.02",
    TESTNET_FAUCET_USD1_AMOUNT:
      environment["TESTNET_FAUCET_USD1_AMOUNT"] ?? "500",
    TESTNET_FAUCET_COOLDOWN_SECONDS:
      environment["TESTNET_FAUCET_COOLDOWN_SECONDS"] ?? "86400",
    TESTNET_FAUCET_OPERATOR_PRIVATE_KEY:
      environment["TESTNET_FAUCET_OPERATOR_PRIVATE_KEY"],
    TESTNET_FAUCET_USD1_ADDRESS: environment["TESTNET_FAUCET_USD1_ADDRESS"],
    ...testnetFaucetLimitEnvironmentDefaults(environment),
    ...miningSettlementEnvironmentDefaults(environment),
    ...launchChainEnvironmentDefaults(environment),
    ...memeEnvironmentDefaults(environment),
    ...marketEnvironmentDefaults(environment),
    ...communityAiEnvironmentDefaults(environment),
    DATABASE_URL: environment["DATABASE_URL"],
    DATABASE_POOL_MAX: environment["DATABASE_POOL_MAX"] ?? "10",
    DATABASE_CONNECTION_TIMEOUT_MS:
      environment["DATABASE_CONNECTION_TIMEOUT_MS"] ?? "3000",
    DATABASE_STATEMENT_TIMEOUT_MS:
      environment["DATABASE_STATEMENT_TIMEOUT_MS"] ?? "5000",
    LAUNCH_SNAPSHOT_CACHE_TTL_MS:
      environment["LAUNCH_SNAPSHOT_CACHE_TTL_MS"] ?? "1500",
    LAUNCH_GRADUATED_LIST: environment["LAUNCH_GRADUATED_LIST"] ?? "off",
    HOOKS_LAUNCH_ENABLED: environment["HOOKS_LAUNCH_ENABLED"] ?? "off",
    HOOKS_LAUNCH_FACTORY_ADDRESS: environment["HOOKS_LAUNCH_FACTORY_ADDRESS"],
    HOOKS_LAUNCH_FACTORY_CODE_HASH:
      environment["HOOKS_LAUNCH_FACTORY_CODE_HASH"],
    HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS:
      environment["HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS"] ??
      String(hooksLaunchDefaultSaleLeadSeconds),
    LAUNCH2_BUYBACK_RECIPIENT:
      environment["LAUNCH2_BUYBACK_RECIPIENT"]?.trim() === ""
        ? undefined
        : environment["LAUNCH2_BUYBACK_RECIPIENT"],
    LAUNCH2_QUOTE_TTL_SECONDS: environment["LAUNCH2_QUOTE_TTL_SECONDS"] ?? "60",
    LAUNCH2_POOL_TRADE_DEADLINE_SECONDS:
      environment["LAUNCH2_POOL_TRADE_DEADLINE_SECONDS"] ?? "180",
    LAUNCH2_TRADER_ACCOUNT_EMIT:
      environment["LAUNCH2_TRADER_ACCOUNT_EMIT"] ?? "off",
    LAUNCH2_NFT_IMAGE_EMIT: environment["LAUNCH2_NFT_IMAGE_EMIT"] ?? "off",
    LAUNCH2_POSITION_VALUE_EMIT:
      environment["LAUNCH2_POSITION_VALUE_EMIT"] ?? "off",
    LAUNCH2_PNL_EMIT: environment["LAUNCH2_PNL_EMIT"] ?? "off",
    REFERRAL_CENTER_EMIT: environment["REFERRAL_CENTER_EMIT"] ?? "off",
    WALLET_ACTIVITY_LAUNCH2_EMIT:
      environment["WALLET_ACTIVITY_LAUNCH2_EMIT"] ?? "off",
    PROFILE_LAUNCH2_EMIT: environment["PROFILE_LAUNCH2_EMIT"] ?? "off",
    COMMUNITY_LABEL_EMIT: environment["COMMUNITY_LABEL_EMIT"] ?? "off",
    MARKET_ROW_SPARKLINE24H_EMIT:
      environment["MARKET_ROW_SPARKLINE24H_EMIT"] ?? "off",
    NOTIFICATION_INBOX_EMIT: environment["NOTIFICATION_INBOX_EMIT"] ?? "off",
    LAUNCH_REVIEW_INBOX_EMIT: environment["LAUNCH_REVIEW_INBOX_EMIT"] ?? "off",
    WALLET_LINK_POLICY_EMIT: environment["WALLET_LINK_POLICY_EMIT"] ?? "off",
    EXTERNAL_WALLET_ADDRESS_PUBLIC:
      environment["EXTERNAL_WALLET_ADDRESS_PUBLIC"] ?? "false",
    LAUNCH2_DEFAULT_SLIPPAGE_BPS:
      environment["LAUNCH2_DEFAULT_SLIPPAGE_BPS"] ?? "100",
    LAUNCH2_POOL_ROUTER_ADDRESS:
      environment["LAUNCH2_POOL_ROUTER_ADDRESS"]?.trim() === ""
        ? undefined
        : environment["LAUNCH2_POOL_ROUTER_ADDRESS"],
    LAUNCH2_POOL_ROUTER_CODE_HASH:
      environment["LAUNCH2_POOL_ROUTER_CODE_HASH"]?.trim() === ""
        ? undefined
        : environment["LAUNCH2_POOL_ROUTER_CODE_HASH"],
    HOOKS_LAUNCH_HOOK_KIND:
      environment["HOOKS_LAUNCH_HOOK_KIND"]?.trim() || "officialTax",
    LAUNCH2_DYNAMIC_ROUTER_ADDRESS: blankAsUndefined(
      environment["LAUNCH2_DYNAMIC_ROUTER_ADDRESS"],
    ),
    LAUNCH2_DYNAMIC_ROUTER_CODE_HASH: blankAsUndefined(
      environment["LAUNCH2_DYNAMIC_ROUTER_CODE_HASH"],
    ),
    LAUNCH2_DYNAMIC_ROUTER_REGISTRY_ADDRESS: blankAsUndefined(
      environment["LAUNCH2_DYNAMIC_ROUTER_REGISTRY_ADDRESS"],
    ),
    LAUNCH2_DYNAMIC_FACTORY_ADDRESS: blankAsUndefined(
      environment["LAUNCH2_DYNAMIC_FACTORY_ADDRESS"],
    ),
    LAUNCH2_DYNAMIC_FACTORY_CODE_HASH: blankAsUndefined(
      environment["LAUNCH2_DYNAMIC_FACTORY_CODE_HASH"],
    ),
    LAUNCH2_LEGACY_FACTORIES: environment["LAUNCH2_LEGACY_FACTORIES"],
    LAUNCH2_DYNAMIC_LEGACY_ROUTER_CODE_HASHES:
      environment["LAUNCH2_DYNAMIC_LEGACY_ROUTER_CODE_HASHES"],
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

  const bscChain = parseBscChainConfig(parsed.data);
  const nftImage = parseNftImageStorage(parsed.data);

  const passkeyRelyingParty = parsePasskeyRelyingPartyConfig(parsed.data);
  return Object.freeze({
    nodeEnv: parsed.data.NODE_ENV,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    publicBaseUrl: publicBaseUrl.toString(),
    tokenLogoUrlMode: parsed.data.TOKEN_LOGO_URL_MODE,
    nftImageStorage: nftImage.storage,
    ipfsGatewayBaseUrl: nftImage.gatewayBaseUrl,
    apiDocsEnabled: parsed.data.API_DOCS_ENABLED,
    trustProxy: parsed.data.TRUST_PROXY,
    publicRateLimit: Object.freeze({
      perMinute: parsed.data.PUBLIC_RATE_LIMIT_PER_MINUTE,
      clientIpHeaders: parsePublicClientIpHeaders(
        parsed.data.PUBLIC_CLIENT_IP_HEADERS,
      ),
    }),
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
    streamAudioRoomUserRoleEvidenceRef:
      parsed.data.STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF ?? null,
    social,
    perpReadCursor,
    hyperliquidPrivateReads,
    bscChain,
    bscConfirmations: parsed.data.BSC_CONFIRMATIONS,
    bscReorgDepthBlocks: parsed.data.BSC_REORG_DEPTH_BLOCKS,
    launchChain: parseLaunchChainConfig(parsed.data, {
      rpcUrls: bscChain?.rpcUrls ?? Object.freeze([]),
      confirmations: parsed.data.BSC_CONFIRMATIONS,
      reorgDepthBlocks: parsed.data.BSC_REORG_DEPTH_BLOCKS,
      logAddressChunkSize: parsed.data.BSC_LOG_ADDRESS_CHUNK_SIZE,
    }),
    launchContract: parseLaunchContractConfig(parsed.data),
    launchSnapshotCacheTtlMs: parsed.data.LAUNCH_SNAPSHOT_CACHE_TTL_MS,
    launchGraduatedListEnabled: parsed.data.LAUNCH_GRADUATED_LIST === "on",
    referralCenterEmit: parsed.data.REFERRAL_CENTER_EMIT === "on",
    walletActivityLaunch2Emit:
      parsed.data.WALLET_ACTIVITY_LAUNCH2_EMIT === "on",
    profileLaunch2Emit: parsed.data.PROFILE_LAUNCH2_EMIT === "on",
    communityLabelEmit: parsed.data.COMMUNITY_LABEL_EMIT === "on",
    marketRowSparkline24hEmit:
      parsed.data.MARKET_ROW_SPARKLINE24H_EMIT === "on",
    notificationInboxEmit: parsed.data.NOTIFICATION_INBOX_EMIT === "on",
    launchReviewInboxEmit: parsed.data.LAUNCH_REVIEW_INBOX_EMIT === "on",
    walletLinkPolicyEmit: parsed.data.WALLET_LINK_POLICY_EMIT === "on",
    externalWalletAddressPublic: parsed.data.EXTERNAL_WALLET_ADDRESS_PUBLIC,
    hooksLaunch: {
      enabled: parsed.data.HOOKS_LAUNCH_ENABLED === "on",
      factoryAddress:
        parsed.data.HOOKS_LAUNCH_FACTORY_ADDRESS?.toLowerCase() ?? null,
      factoryCodeHash:
        parsed.data.HOOKS_LAUNCH_FACTORY_CODE_HASH?.toLowerCase() ?? null,
      minimumSaleLeadSeconds: parsed.data.HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS,
      fixedBuybackRecipient:
        parsed.data.LAUNCH2_BUYBACK_RECIPIENT?.toLowerCase() ?? null,
      hookKind: parsed.data.HOOKS_LAUNCH_HOOK_KIND,
      dynamicFactory:
        parsed.data.LAUNCH2_DYNAMIC_FACTORY_ADDRESS === undefined ||
        parsed.data.LAUNCH2_DYNAMIC_FACTORY_CODE_HASH === undefined
          ? null
          : Object.freeze({
              address:
                parsed.data.LAUNCH2_DYNAMIC_FACTORY_ADDRESS.toLowerCase(),
              codeHash:
                parsed.data.LAUNCH2_DYNAMIC_FACTORY_CODE_HASH.toLowerCase(),
            }),
    },
    meme: parseMemeConfig(parsed.data, parseLaunchContractConfig(parsed.data)),
    launch2: Object.freeze({
      quoteTtlSeconds: parsed.data.LAUNCH2_QUOTE_TTL_SECONDS,
      defaultSlippageBps: parsed.data.LAUNCH2_DEFAULT_SLIPPAGE_BPS,
      tradeDeadlineSeconds: parsed.data.LAUNCH2_POOL_TRADE_DEADLINE_SECONDS,
      traderAccountEmit: parsed.data.LAUNCH2_TRADER_ACCOUNT_EMIT === "on",
      nftImageEmit: parsed.data.LAUNCH2_NFT_IMAGE_EMIT === "on",
      positionValueEmit: parsed.data.LAUNCH2_POSITION_VALUE_EMIT === "on",
      pnlEmit: parsed.data.LAUNCH2_PNL_EMIT === "on",
      poolRouter:
        parsed.data.LAUNCH2_POOL_ROUTER_ADDRESS === undefined ||
        parsed.data.LAUNCH2_POOL_ROUTER_CODE_HASH === undefined
          ? null
          : Object.freeze({
              address: parsed.data.LAUNCH2_POOL_ROUTER_ADDRESS.toLowerCase(),
              codeHash: parsed.data.LAUNCH2_POOL_ROUTER_CODE_HASH.toLowerCase(),
            }),
      hookKind: parsed.data.HOOKS_LAUNCH_HOOK_KIND,
      dynamicRouter:
        parsed.data.LAUNCH2_DYNAMIC_ROUTER_ADDRESS === undefined ||
        parsed.data.LAUNCH2_DYNAMIC_ROUTER_CODE_HASH === undefined
          ? null
          : Object.freeze({
              address: parsed.data.LAUNCH2_DYNAMIC_ROUTER_ADDRESS.toLowerCase(),
              codeHash:
                parsed.data.LAUNCH2_DYNAMIC_ROUTER_CODE_HASH.toLowerCase(),
            }),
      dynamicRouterRegistry:
        parsed.data.LAUNCH2_DYNAMIC_ROUTER_REGISTRY_ADDRESS?.toLowerCase() ??
        null,
      dynamicLegacyFactories: Object.freeze(
        parseLaunch2LegacyFactoriesEnvironment(
          parsed.data.LAUNCH2_LEGACY_FACTORIES,
          parsed.data.HOOKS_LAUNCH_FACTORY_ADDRESS,
          parsed.data.LAUNCH2_DYNAMIC_FACTORY_ADDRESS,
        )
          // v2 predates the LoopDynamic Factory.
          .filter((entry) => entry.generation !== "v2")
          .map((entry) => entry.address),
      ),
      dynamicLegacyRouterCodeHashes: Object.freeze(
        (parsed.data.LAUNCH2_DYNAMIC_LEGACY_ROUTER_CODE_HASHES ?? "")
          .split(",")
          .map((hash) => hash.trim().toLowerCase())
          .filter((hash) => hash !== ""),
      ),
    }),
    miningMockHoldingsEnabled: parsed.data.MINING_MOCK_HOLDINGS_ENABLED,
    miningSettlement: parseMiningSettlementApi(parsed.data),
    chainGuardAlerts: parseChainGuardAlertConfig(environment),
    chainGuardEnabled: parseChainGuardEnabled(environment),
    walletGasReserve: parseWalletGasReserve(parsed.data.WALLET_GAS_RESERVE_BNB),
    passkeyRelyingParty,
    appLinks: parseAppLinksConfig(parsed.data, passkeyRelyingParty.ios),
    web: parseWebSurfaceConfig(environment, parsed.data.NODE_ENV),
    bscWrites: parseBscWriteConfig(parsed.data),
    market: parseMarketConfig(parsed.data),
    communityAi: parseCommunityAiConfig(parsed.data),
    push: parsePushConfig(parsed.data),
    communityChatRealIdentity: parsed.data.COMMUNITY_CHAT_REAL_IDENTITY,
    recommendedCommunityIds: parseRecommendedCommunityIds(
      parsed.data.RECOMMENDED_COMMUNITY_IDS,
    ),
    intelPromotionImageHosts: parseIntelPromotionImageHosts(
      parsed.data.INTEL_PROMOTION_IMAGE_HOSTS,
    ),
    admin: parseAdminConsoleConfig(parsed.data),
    memeOperator: parseMemeOperator(parsed.data),
    testnetFaucet: parseTestnetFaucet(parsed.data),
    serviceName: "loop-api",
    serviceVersion,
  });
}

/**
 * The reconciliation process deliberately has no HTTP or provider credential
 * configuration. Its read-only provider capabilities have independent,
 * default-off switches and never inherit the API process's private-read flag.
 */
/**
 * Decision 0150 (stricter on mainnet): on `LAUNCH_CHAIN_ID=56` with the ack,
 * the three server-signed lanes that honour CHAIN_GUARD_HOLD (Hooks
 * executor, buyback keeper, poke keeper) refuse boot unless the chain guard
 * lane is on too, so a USD1 pause / freeze always stops them. BSC Testnet
 * keeps the pre-0150 rule (the guard is optional there).
 */
function assertMainnetLaneChainGuard(
  data: {
    readonly LAUNCH_CHAIN_ID: "56" | "97";
    readonly LAUNCH_MAINNET_ACK?: string | undefined;
    readonly HOOKS_LAUNCH_EXECUTOR_ENABLED: "off" | "on";
    readonly LAUNCH2_BUYBACK_KEEPER_ENABLED: boolean;
    readonly LAUNCH2_DYNAMIC_POKE_ENABLED: boolean;
  },
  environment: NodeJS.ProcessEnv,
): void {
  if (!launchMainnetAcknowledged(data)) return;
  const lanes = [
    data.HOOKS_LAUNCH_EXECUTOR_ENABLED === "on"
      ? "HOOKS_LAUNCH_EXECUTOR_ENABLED"
      : null,
    data.LAUNCH2_BUYBACK_KEEPER_ENABLED
      ? "LAUNCH2_BUYBACK_KEEPER_ENABLED"
      : null,
    data.LAUNCH2_DYNAMIC_POKE_ENABLED ? "LAUNCH2_DYNAMIC_POKE_ENABLED" : null,
  ].filter((lane): lane is string => lane !== null);
  if (lanes.length === 0 || parseChainGuardEnabled(environment)) return;
  throw new ConfigurationError(
    lanes.map(
      (lane) =>
        `${lane}: on LAUNCH_CHAIN_ID=56 also requires CHAIN_GUARD_ENABLED=true (Decision 0150)`,
    ),
  );
}

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
    BSC_WRITES_ENABLED: environment["BSC_WRITES_ENABLED"] ?? "false",
    TESTNET_FAUCET_ENABLED: environment["TESTNET_FAUCET_ENABLED"] ?? "false",
    TESTNET_FAUCET_PENDING_TIMEOUT_SECONDS:
      environment["TESTNET_FAUCET_PENDING_TIMEOUT_SECONDS"] ?? "900",
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
    LAUNCH_INDEXER_ENABLED: environment["LAUNCH_INDEXER_ENABLED"] ?? "false",
    MEME_INDEXER_ENABLED: environment["MEME_INDEXER_ENABLED"] ?? "false",
    LAUNCH2_INDEXER_ENABLED: environment["LAUNCH2_INDEXER_ENABLED"] ?? "false",
    LAUNCH2_INDEXER_POLL_INTERVAL_MS:
      environment["LAUNCH2_INDEXER_POLL_INTERVAL_MS"] ?? "3000",
    LAUNCH2_LEGACY_FACTORIES: environment["LAUNCH2_LEGACY_FACTORIES"],
    LAUNCH2_POOL_ROUTER_ADDRESS:
      environment["LAUNCH2_POOL_ROUTER_ADDRESS"]?.trim() === ""
        ? undefined
        : environment["LAUNCH2_POOL_ROUTER_ADDRESS"],
    LAUNCH2_POOL_ROUTER_CODE_HASH:
      environment["LAUNCH2_POOL_ROUTER_CODE_HASH"]?.trim() === ""
        ? undefined
        : environment["LAUNCH2_POOL_ROUTER_CODE_HASH"],
    HOOKS_LAUNCH_HOOK_KIND:
      environment["HOOKS_LAUNCH_HOOK_KIND"]?.trim() || "officialTax",
    LAUNCH2_DYNAMIC_FACTORY_ADDRESS: blankAsUndefined(
      environment["LAUNCH2_DYNAMIC_FACTORY_ADDRESS"],
    ),
    LAUNCH2_DYNAMIC_FACTORY_CODE_HASH: blankAsUndefined(
      environment["LAUNCH2_DYNAMIC_FACTORY_CODE_HASH"],
    ),
    LAUNCH2_DYNAMIC_POKE_ENABLED:
      environment["LAUNCH2_DYNAMIC_POKE_ENABLED"] ?? "false",
    LAUNCH2_DYNAMIC_POKE_PRIVATE_KEY:
      environment["LAUNCH2_DYNAMIC_POKE_PRIVATE_KEY"],
    LAUNCH2_DYNAMIC_POKE_INTERVAL_SECONDS:
      environment["LAUNCH2_DYNAMIC_POKE_INTERVAL_SECONDS"] ?? "60",
    MEME_GRADUATION_EXECUTOR_ENABLED:
      environment["MEME_GRADUATION_EXECUTOR_ENABLED"] ?? "false",
    MEME_GRADUATION_DELAY_SECONDS:
      environment["MEME_GRADUATION_DELAY_SECONDS"] ?? "15",
    LAUNCH_DEPLOYER_PRIVATE_KEY: environment["LAUNCH_DEPLOYER_PRIVATE_KEY"],
    BSC_INDEXER_START_BLOCK: environment["BSC_INDEXER_START_BLOCK"],
    BSC_INDEXER_WALLET_TOPIC_CHUNK_SIZE:
      environment["BSC_INDEXER_WALLET_TOPIC_CHUNK_SIZE"] ?? "200",
    BSC_RPC_URLS: environment["BSC_RPC_URLS"],
    BSC_CONFIRMATIONS: environment["BSC_CONFIRMATIONS"] ?? "15",
    BSC_REORG_DEPTH_BLOCKS: environment["BSC_REORG_DEPTH_BLOCKS"] ?? "64",
    BSC_LOG_ADDRESS_CHUNK_SIZE:
      environment["BSC_LOG_ADDRESS_CHUNK_SIZE"] ?? "8",
    ALERT_EVALUATOR_ENABLED: environment["ALERT_EVALUATOR_ENABLED"] ?? "false",
    ALERT_NOTIFICATION_DEDUPE_SECONDS:
      environment["ALERT_NOTIFICATION_DEDUPE_SECONDS"] ?? "3600",
    MARKET_SPARKLINE_WARM_ENABLED:
      environment["MARKET_SPARKLINE_WARM_ENABLED"] ?? "true",
    MARKET_SPARKLINE_WARM_INTERVAL_MS:
      environment["MARKET_SPARKLINE_WARM_INTERVAL_MS"] ?? "4000",
    TOKEN_LOGO_PREWARM_ENABLED:
      environment["TOKEN_LOGO_PREWARM_ENABLED"] ?? "true",
    TOKEN_LOGO_PREWARM_INTERVAL_MS:
      environment["TOKEN_LOGO_PREWARM_INTERVAL_MS"] ?? "21600000",
    TOKEN_LOGO_PREWARM_HOT_LIMIT:
      environment["TOKEN_LOGO_PREWARM_HOT_LIMIT"] ?? "200",
    VOICE_ROOM_REAPER_ENABLED:
      environment["VOICE_ROOM_REAPER_ENABLED"] ?? "true",
    COMMUNITY_CHAT_REAL_IDENTITY:
      environment["COMMUNITY_CHAT_REAL_IDENTITY"] ?? "true",
    PUBLIC_BASE_URL: environment["PUBLIC_BASE_URL"] ?? "http://127.0.0.1:3000",
    VOICE_ROOM_REAPER_INTERVAL_MS:
      environment["VOICE_ROOM_REAPER_INTERVAL_MS"] ?? "60000",
    VOICE_ROOM_IDLE_END_MINUTES:
      environment["VOICE_ROOM_IDLE_END_MINUTES"] ?? "10",
    VOICE_ROOM_MAX_LIVE_HOURS: environment["VOICE_ROOM_MAX_LIVE_HOURS"] ?? "12",
    FRIEND_DIRECT_CHANNEL_ENABLED:
      environment["FRIEND_DIRECT_CHANNEL_ENABLED"] ?? "true",
    NOTIFICATION_INBOX_ENABLED:
      environment["NOTIFICATION_INBOX_ENABLED"] ?? "true",
    NOTIFICATION_INBOX_INTERVAL_MS:
      environment["NOTIFICATION_INBOX_INTERVAL_MS"] ?? "10000",
    NOTIFICATION_INBOX_EMIT: environment["NOTIFICATION_INBOX_EMIT"] ?? "off",
    LAUNCH_REVIEW_INBOX_EMIT: environment["LAUNCH_REVIEW_INBOX_EMIT"] ?? "off",
    FRIEND_DIRECT_CHANNEL_INTERVAL_MS:
      environment["FRIEND_DIRECT_CHANNEL_INTERVAL_MS"] ?? "5000",
    FRIEND_CHANNEL_BACKFILL_ENABLED:
      environment["FRIEND_CHANNEL_BACKFILL_ENABLED"] ?? "false",
    SQUARE_FEED_INGEST_ENABLED:
      environment["SQUARE_FEED_INGEST_ENABLED"] ?? "true",
    SQUARE_FEED_INGEST_INTERVAL_MS:
      environment["SQUARE_FEED_INGEST_INTERVAL_MS"] ?? "60000",
    WALLET_NETWORTH_SNAPSHOT_ENABLED:
      environment["WALLET_NETWORTH_SNAPSHOT_ENABLED"] ?? "true",
    WALLET_NETWORTH_SNAPSHOT_INTERVAL_MS:
      environment["WALLET_NETWORTH_SNAPSHOT_INTERVAL_MS"] ?? "3600000",
    WALLET_NETWORTH_SNAPSHOT_BATCH:
      environment["WALLET_NETWORTH_SNAPSHOT_BATCH"] ?? "200",
    FIAT_FX_RATE_ENABLED: environment["FIAT_FX_RATE_ENABLED"] ?? "true",
    FIAT_FX_PROVIDER_URL:
      environment["FIAT_FX_PROVIDER_URL"] ?? defaultFiatFxProviderUrl,
    FIAT_FX_REFRESH_SECONDS: environment["FIAT_FX_REFRESH_SECONDS"] ?? "3600",
    COMMUNITY_MEMBER_BUY_FEED_ENABLED:
      environment["COMMUNITY_MEMBER_BUY_FEED_ENABLED"] ?? "true",
    COMMUNITY_MEMBER_BUY_FEED_INTERVAL_MS:
      environment["COMMUNITY_MEMBER_BUY_FEED_INTERVAL_MS"] ?? "15000",
    BSC_USD1_TOKEN_ADDRESS: environment["BSC_USD1_TOKEN_ADDRESS"],
    BSC_USD1_VERIFIED: environment["BSC_USD1_VERIFIED"] ?? "false",
    WALLET_INTENT_RECONCILE_ENABLED:
      environment["WALLET_INTENT_RECONCILE_ENABLED"] ?? "false",
    MINING_SNAPSHOT_ENABLED: environment["MINING_SNAPSHOT_ENABLED"] ?? "false",
    MINING_SETTLEMENT_ENABLED:
      environment["MINING_SETTLEMENT_ENABLED"] ?? "false",
    MINING_SETTLEMENT_POLL_INTERVAL_MS:
      environment["MINING_SETTLEMENT_POLL_INTERVAL_MS"] ?? "60000",
    MINING_SETTLEMENT_CATCHUP_HOURS:
      environment["MINING_SETTLEMENT_CATCHUP_HOURS"] ?? "48",
    ...miningSettlementEnvironmentDefaults(environment),
    MINING_MOCK_HOLDINGS_ENABLED:
      environment["MINING_MOCK_HOLDINGS_ENABLED"] ?? "false",
    PRIVY_APP_ID: environment["PRIVY_APP_ID"],
    PRIVY_APP_SECRET: environment["PRIVY_APP_SECRET"],
    FIREBASE_SERVICE_ACCOUNT_JSON_PATH:
      environment["FIREBASE_SERVICE_ACCOUNT_JSON_PATH"],
    ...launchChainEnvironmentDefaults(environment),
    ...memeEnvironmentDefaults(environment),
    ...marketEnvironmentDefaults(environment),
    HOOKS_LAUNCH_FACTORY_ADDRESS: environment["HOOKS_LAUNCH_FACTORY_ADDRESS"],
    HOOKS_LAUNCH_FACTORY_CODE_HASH:
      environment["HOOKS_LAUNCH_FACTORY_CODE_HASH"],
    HOOKS_LAUNCH_EXECUTOR_ENABLED:
      environment["HOOKS_LAUNCH_EXECUTOR_ENABLED"] ?? "off",
    HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY:
      environment["HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY"],
    HOOKS_LAUNCH_EXECUTOR_CONFIRMATIONS:
      environment["HOOKS_LAUNCH_EXECUTOR_CONFIRMATIONS"] ?? "3",
    HOOKS_LAUNCH_EXECUTOR_POLL_INTERVAL_MS:
      environment["HOOKS_LAUNCH_EXECUTOR_POLL_INTERVAL_MS"] ?? "5000",
    HOOKS_LAUNCH_EXECUTOR_LEASE_SECONDS:
      environment["HOOKS_LAUNCH_EXECUTOR_LEASE_SECONDS"] ?? "120",
    HOOKS_LAUNCH_EXECUTOR_MAX_ATTEMPTS:
      environment["HOOKS_LAUNCH_EXECUTOR_MAX_ATTEMPTS"] ?? "3",
    HOOKS_LAUNCH_EXECUTOR_RETRY_DELAY_SECONDS:
      environment["HOOKS_LAUNCH_EXECUTOR_RETRY_DELAY_SECONDS"] ?? "60",
    HOOKS_LAUNCH_EXECUTOR_GAS_LIMIT_CAP:
      environment["HOOKS_LAUNCH_EXECUTOR_GAS_LIMIT_CAP"] ?? "16000000",
    HOOKS_LAUNCH_EXECUTOR_MAX_GAS_PRICE_GWEI:
      environment["HOOKS_LAUNCH_EXECUTOR_MAX_GAS_PRICE_GWEI"] ?? "20",
    LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED:
      environment["LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED"] ?? "false",
    LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS:
      environment["LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS"],
    LAUNCH2_SNAPSHOT_SUBMITTER_PRIVATE_KEY:
      environment["LAUNCH2_SNAPSHOT_SUBMITTER_PRIVATE_KEY"],
    LAUNCH2_SNAPSHOT_PUBLISHER_POLL_INTERVAL_MS:
      environment["LAUNCH2_SNAPSHOT_PUBLISHER_POLL_INTERVAL_MS"] ?? "5000",
    LAUNCH2_SNAPSHOT_PUBLISHER_CONFIRMATIONS:
      environment["LAUNCH2_SNAPSHOT_PUBLISHER_CONFIRMATIONS"] ?? "12",
    LAUNCH2_SNAPSHOT_PUBLISHER_MAX_GAS_PRICE_GWEI:
      environment["LAUNCH2_SNAPSHOT_PUBLISHER_MAX_GAS_PRICE_GWEI"] ?? "20",
    LAUNCH2_BUYBACK_KEEPER_ENABLED:
      environment["LAUNCH2_BUYBACK_KEEPER_ENABLED"] ?? "false",
    LAUNCH2_BUYBACK_KEEPER_PRIVATE_KEY:
      environment["LAUNCH2_BUYBACK_KEEPER_PRIVATE_KEY"],
    LAUNCH2_BUYBACK_KEEPER_INTERVAL_SECONDS:
      environment["LAUNCH2_BUYBACK_KEEPER_INTERVAL_SECONDS"] ?? "15",
    LAUNCH2_BUYBACK_KEEPER_CONFIRMATIONS:
      environment["LAUNCH2_BUYBACK_KEEPER_CONFIRMATIONS"] ?? "12",
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

  const workerBscChain = parseBscChainConfig({
    ...parsed.data,
    BSC_USD1_VERIFIED: false,
  });
  assertMainnetLaneChainGuard(parsed.data, environment);

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
    bscChain: workerBscChain,
    bscIndexer: parsed.data.BSC_INDEXER_ENABLED
      ? Object.freeze({
          startBlockNumber: parsed.data.BSC_INDEXER_START_BLOCK ?? null,
          walletTopicChunkSize: parsed.data.BSC_INDEXER_WALLET_TOPIC_CHUNK_SIZE,
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
    launchChain: parseLaunchChainConfig(parsed.data, {
      rpcUrls: workerBscChain?.rpcUrls ?? Object.freeze([]),
      confirmations: parsed.data.BSC_CONFIRMATIONS,
      reorgDepthBlocks: parsed.data.BSC_REORG_DEPTH_BLOCKS,
      logAddressChunkSize: parsed.data.BSC_LOG_ADDRESS_CHUNK_SIZE,
    }),
    launchContract: parseLaunchContractConfig(parsed.data),
    launchIndexerEnabled: parsed.data.LAUNCH_INDEXER_ENABLED,
    meme: parseMemeConfig(parsed.data, parseLaunchContractConfig(parsed.data)),
    memeIndexerEnabled: parsed.data.MEME_INDEXER_ENABLED,
    launch2Indexer: parsed.data.LAUNCH2_INDEXER_ENABLED
      ? Object.freeze({
          factoryAddress:
            parsed.data.HOOKS_LAUNCH_FACTORY_ADDRESS?.toLowerCase() ?? null,
          factoryCodeHash:
            parsed.data.HOOKS_LAUNCH_FACTORY_CODE_HASH?.toLowerCase() ?? null,
          legacyFactories: parseLaunch2LegacyFactoriesEnvironment(
            parsed.data.LAUNCH2_LEGACY_FACTORIES,
            parsed.data.HOOKS_LAUNCH_FACTORY_ADDRESS,
            parsed.data.LAUNCH2_DYNAMIC_FACTORY_CODE_HASH === undefined
              ? undefined
              : parsed.data.LAUNCH2_DYNAMIC_FACTORY_ADDRESS,
          ),
          pollIntervalMs: parsed.data.LAUNCH2_INDEXER_POLL_INTERVAL_MS,
          poolRouterAddress:
            parsed.data.LAUNCH2_POOL_ROUTER_ADDRESS === undefined ||
            parsed.data.LAUNCH2_POOL_ROUTER_CODE_HASH === undefined
              ? null
              : parsed.data.LAUNCH2_POOL_ROUTER_ADDRESS.toLowerCase(),
          dynamicFactoryAddress:
            parsed.data.LAUNCH2_DYNAMIC_FACTORY_ADDRESS === undefined ||
            parsed.data.LAUNCH2_DYNAMIC_FACTORY_CODE_HASH === undefined
              ? null
              : parsed.data.LAUNCH2_DYNAMIC_FACTORY_ADDRESS.toLowerCase(),
        })
      : null,
    launch2DynamicPoke: parseLaunch2DynamicPoke(parsed.data),
    memeGraduationExecutor: parseMemeGraduationExecutor(parsed.data),
    hooksLaunchExecutor: parseHooksLaunchExecutor(parsed.data),
    launch2SnapshotPublisher: parseLaunch2SnapshotPublisher(parsed.data),
    launch2BuybackKeeper: parseLaunch2BuybackKeeper(parsed.data),
    chainGuard: parseChainGuardEnabled(environment)
      ? parseChainGuardConfig(environment)
      : null,
    chainGuardAlerts: parseChainGuardAlertConfig(environment),
    market: parseMarketConfig(parsed.data),
    push: parsePushConfig(parsed.data),
    alertEvaluator: parsed.data.ALERT_EVALUATOR_ENABLED
      ? Object.freeze({
          notificationDedupeSeconds:
            parsed.data.ALERT_NOTIFICATION_DEDUPE_SECONDS,
        })
      : null,
    sparklineWarm: parsed.data.MARKET_SPARKLINE_WARM_ENABLED
      ? Object.freeze({
          intervalMs: parsed.data.MARKET_SPARKLINE_WARM_INTERVAL_MS,
        })
      : null,
    tokenLogoPrewarm: parsed.data.TOKEN_LOGO_PREWARM_ENABLED
      ? Object.freeze({
          intervalMs: parsed.data.TOKEN_LOGO_PREWARM_INTERVAL_MS,
          hotLimit: parsed.data.TOKEN_LOGO_PREWARM_HOT_LIMIT,
        })
      : null,
    voiceRoomReaper: parsed.data.VOICE_ROOM_REAPER_ENABLED
      ? Object.freeze({
          intervalMs: parsed.data.VOICE_ROOM_REAPER_INTERVAL_MS,
          idleEndMinutes: parsed.data.VOICE_ROOM_IDLE_END_MINUTES,
          maxLiveHours: parsed.data.VOICE_ROOM_MAX_LIVE_HOURS,
          stream:
            parsed.data.STREAM_API_KEY !== undefined &&
            parsed.data.STREAM_API_SECRET !== undefined
              ? Object.freeze({
                  apiKey: parsed.data.STREAM_API_KEY,
                  apiSecret: parsed.data.STREAM_API_SECRET,
                })
              : null,
        })
      : null,
    notificationInbox: parsed.data.NOTIFICATION_INBOX_ENABLED
      ? Object.freeze({
          intervalMs: parsed.data.NOTIFICATION_INBOX_INTERVAL_MS,
          emit: parsed.data.NOTIFICATION_INBOX_EMIT === "on",
          launchReviewEmit: parsed.data.LAUNCH_REVIEW_INBOX_EMIT === "on",
        })
      : null,
    friendDirectChannel: parsed.data.FRIEND_DIRECT_CHANNEL_ENABLED
      ? Object.freeze({
          intervalMs: parsed.data.FRIEND_DIRECT_CHANNEL_INTERVAL_MS,
          backfillEnabled: parsed.data.FRIEND_CHANNEL_BACKFILL_ENABLED,
          stream:
            parsed.data.STREAM_API_KEY !== undefined &&
            parsed.data.STREAM_API_SECRET !== undefined
              ? Object.freeze({
                  apiKey: parsed.data.STREAM_API_KEY,
                  apiSecret: parsed.data.STREAM_API_SECRET,
                })
              : null,
        })
      : null,
    communityMemberBuyFeed: parsed.data.COMMUNITY_MEMBER_BUY_FEED_ENABLED
      ? Object.freeze({
          intervalMs: parsed.data.COMMUNITY_MEMBER_BUY_FEED_INTERVAL_MS,
          usd1Address: parseVerifiedUsd1Address(
            parsed.data.BSC_USD1_TOKEN_ADDRESS,
            parsed.data.BSC_USD1_VERIFIED,
          ),
          stream:
            parsed.data.STREAM_API_KEY !== undefined &&
            parsed.data.STREAM_API_SECRET !== undefined
              ? Object.freeze({
                  apiKey: parsed.data.STREAM_API_KEY,
                  apiSecret: parsed.data.STREAM_API_SECRET,
                })
              : null,
        })
      : null,
    walletNetWorthSnapshot: parsed.data.WALLET_NETWORTH_SNAPSHOT_ENABLED
      ? Object.freeze({
          intervalMs: parsed.data.WALLET_NETWORTH_SNAPSHOT_INTERVAL_MS,
          batchSize: parsed.data.WALLET_NETWORTH_SNAPSHOT_BATCH,
        })
      : null,
    fiatFxRate: parsed.data.FIAT_FX_RATE_ENABLED
      ? Object.freeze({
          ...parseFiatFxProviderUrl(parsed.data.FIAT_FX_PROVIDER_URL),
          base: "USD",
          quote: "CNY",
          refreshMs: parsed.data.FIAT_FX_REFRESH_SECONDS * 1_000,
        })
      : null,
    squareFeedIngest: parsed.data.SQUARE_FEED_INGEST_ENABLED
      ? Object.freeze({
          intervalMs: parsed.data.SQUARE_FEED_INGEST_INTERVAL_MS,
          usd1Address: parseVerifiedUsd1Address(
            parsed.data.BSC_USD1_TOKEN_ADDRESS,
            parsed.data.BSC_USD1_VERIFIED,
          ),
        })
      : null,
    testnetFaucetSweep: parsed.data.TESTNET_FAUCET_ENABLED
      ? Object.freeze({
          pendingTimeoutSeconds:
            parsed.data.TESTNET_FAUCET_PENDING_TIMEOUT_SECONDS,
          intervalMs: testnetFaucetSweepIntervalMs,
        })
      : null,
    walletIntentReconcile: parsed.data.WALLET_INTENT_RECONCILE_ENABLED
      ? Object.freeze({
          privy:
            parsed.data.PRIVY_APP_ID !== undefined &&
            parsed.data.PRIVY_APP_SECRET !== undefined
              ? Object.freeze({
                  appId: parsed.data.PRIVY_APP_ID,
                  appSecret: parsed.data.PRIVY_APP_SECRET,
                })
              : null,
        })
      : null,
    miningSnapshotEnabled: parsed.data.MINING_SNAPSHOT_ENABLED,
    miningSettlement: Object.freeze({
      ...parseMiningSettlementShared(parsed.data),
      enabled: parsed.data.MINING_SETTLEMENT_ENABLED,
      pollIntervalMs: parsed.data.MINING_SETTLEMENT_POLL_INTERVAL_MS,
      catchupHours: parsed.data.MINING_SETTLEMENT_CATCHUP_HOURS,
    }),
    miningMockHoldingsEnabled: parsed.data.MINING_MOCK_HOLDINGS_ENABLED,
    communityChatRealIdentity: parsed.data.COMMUNITY_CHAT_REAL_IDENTITY,
    publicBaseUrl: parseUrl(
      "PUBLIC_BASE_URL",
      parsed.data.PUBLIC_BASE_URL,
    ).toString(),
    serviceName: "loop-reconciliation-worker",
    serviceVersion,
  });
}

/**
 * Decision 0134: the `chain_guard` lane and `pnpm chain:preflight`. Every
 * key is optional; an address that is malformed refuses boot. A check whose
 * expected value is absent (implementation, fee controller) is reported as
 * not configured, never treated as passing.
 */
export interface ChainGuardConfig {
  readonly intervalSeconds: number;
  /** CHAIN_GUARD_USD1_ADDRESS, else LAUNCH_USD1_ADDRESS; null: Factory `usd1()`. */
  readonly usd1Address: string | null;
  readonly expectedImplementation: string | null;
  readonly poolManagerAddress: string | null;
  readonly expectedProtocolFeeController: string | null;
  readonly protocolFeeAlertPips: number;
  /** CHAIN_GUARD_MIN_BNB as a decimal string and in wei. */
  readonly minBnb: string;
  readonly minBnbWei: bigint;
  /** HOOKS_LAUNCH_FACTORY_ADDRESS + LAUNCH2_DYNAMIC_FACTORY_ADDRESS. */
  readonly factories: readonly string[];
  readonly poolRouterAddress: string | null;
  readonly watch: readonly {
    readonly address: string;
    readonly label: string;
  }[];
  readonly balanceAccounts: readonly {
    readonly address: string;
    readonly label: string;
  }[];
}

const chainGuardAddressPattern = /^0x[0-9a-fA-F]{40}$/u;
const chainGuardLabelPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const chainGuardMinBnbPattern = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,18}))?$/u;

function chainGuardLabelledAddresses(
  key: string,
  raw: string | undefined,
  issues: string[],
): { readonly address: string; readonly label: string }[] {
  const entries: { address: string; label: string }[] = [];
  for (const rawEntry of (raw ?? "").split(",")) {
    const entry = rawEntry.trim();
    if (entry === "") continue;
    const separator = entry.lastIndexOf(":");
    const label = separator < 0 ? "" : entry.slice(0, separator).trim();
    const address = separator < 0 ? entry : entry.slice(separator + 1).trim();
    if (
      !chainGuardLabelPattern.test(label) ||
      !chainGuardAddressPattern.test(address)
    ) {
      issues.push(`${key}: each entry must be label:0x-address`);
      continue;
    }
    entries.push({ address: address.toLowerCase(), label });
  }
  return entries;
}

export function parseChainGuardConfig(
  environment: NodeJS.ProcessEnv,
): ChainGuardConfig {
  const issues: string[] = [];
  const address = (key: string): string | null => {
    const value = environment[key]?.trim() ?? "";
    if (value === "") return null;
    if (!chainGuardAddressPattern.test(value)) {
      issues.push(`${key}: must be a 0x-prefixed 20-byte address`);
      return null;
    }
    return value.toLowerCase();
  };
  const integer = (
    key: string,
    fallbackValue: number,
    minimum: number,
    maximum: number,
  ): number => {
    const value = environment[key]?.trim() ?? "";
    if (value === "") return fallbackValue;
    const parsed = /^[0-9]{1,9}$/u.test(value) ? Number(value) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      issues.push(`${key}: must be an integer from ${minimum} to ${maximum}`);
      return fallbackValue;
    }
    return parsed;
  };
  const intervalSeconds = integer(
    "CHAIN_GUARD_INTERVAL_SECONDS",
    60,
    15,
    3_600,
  );
  const protocolFeeAlertPips = integer(
    "CHAIN_GUARD_PROTOCOL_FEE_ALERT_PIPS",
    500,
    1,
    1_000,
  );
  const minBnb = environment["CHAIN_GUARD_MIN_BNB"]?.trim() || "0.05";
  const minMatch = chainGuardMinBnbPattern.exec(minBnb);
  let minBnbWei = 0n;
  if (minMatch === null) {
    issues.push(
      "CHAIN_GUARD_MIN_BNB: must be a decimal BNB amount (≤ 18 decimals)",
    );
  } else {
    minBnbWei =
      BigInt(minMatch[1] as string) * 10n ** 18n +
      BigInt((minMatch[2] ?? "").padEnd(18, "0"));
  }
  const usd1Address =
    address("CHAIN_GUARD_USD1_ADDRESS") ?? address("LAUNCH_USD1_ADDRESS");
  const factories = [
    address("HOOKS_LAUNCH_FACTORY_ADDRESS"),
    address("LAUNCH2_DYNAMIC_FACTORY_ADDRESS"),
  ].filter((value): value is string => value !== null);
  const config = Object.freeze({
    intervalSeconds,
    usd1Address,
    expectedImplementation: address("CHAIN_GUARD_USD1_IMPLEMENTATION"),
    poolManagerAddress: address("CHAIN_GUARD_POOL_MANAGER_ADDRESS"),
    expectedProtocolFeeController: address(
      "CHAIN_GUARD_PROTOCOL_FEE_CONTROLLER",
    ),
    protocolFeeAlertPips,
    minBnb,
    minBnbWei,
    factories: Object.freeze([...new Set(factories)]),
    poolRouterAddress: address("LAUNCH2_POOL_ROUTER_ADDRESS"),
    watch: Object.freeze(
      chainGuardLabelledAddresses(
        "CHAIN_GUARD_WATCH_ADDRESSES",
        environment["CHAIN_GUARD_WATCH_ADDRESSES"],
        issues,
      ),
    ),
    balanceAccounts: Object.freeze(
      chainGuardLabelledAddresses(
        "CHAIN_GUARD_BALANCE_ACCOUNTS",
        environment["CHAIN_GUARD_BALANCE_ACCOUNTS"],
        issues,
      ),
    ),
  });
  if (issues.length > 0) throw new ConfigurationError(issues);
  return config;
}

/**
 * Decision 0135: where chain guard alerts go besides the worker log — a
 * generic JSON webhook and / or a Telegram bot chat. Both optional; the
 * values are secrets (never logged; a refusal names only the key).
 */
export interface ChainGuardAlertConfig {
  readonly webhookUrl: string | null;
  readonly telegram: {
    readonly botToken: string;
    readonly chatId: string;
  } | null;
}

const chainGuardTelegramTokenPattern = /^[0-9]{1,20}:[A-Za-z0-9_-]{20,100}$/u;
const chainGuardTelegramChatPattern =
  /^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,63})$/u;

function chainGuardWebhookUrl(raw: string, issues: string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    issues.push("CHAIN_GUARD_WEBHOOK_URL: must be an absolute URL");
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    !(url.protocol === "https:" || (url.protocol === "http:" && local)) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    issues.push(
      "CHAIN_GUARD_WEBHOOK_URL: must be https (http only for localhost), without credentials",
    );
    return null;
  }
  return url.toString();
}

/** Decision 0135: null when neither outlet is configured. */
export function parseChainGuardAlertConfig(
  environment: NodeJS.ProcessEnv,
): ChainGuardAlertConfig | null {
  const issues: string[] = [];
  const rawUrl = environment["CHAIN_GUARD_WEBHOOK_URL"]?.trim() ?? "";
  const webhookUrl =
    rawUrl === "" ? null : chainGuardWebhookUrl(rawUrl, issues);
  const token = environment["CHAIN_GUARD_TELEGRAM_BOT_TOKEN"]?.trim() ?? "";
  const chatId = environment["CHAIN_GUARD_TELEGRAM_CHAT_ID"]?.trim() ?? "";
  let telegram: ChainGuardAlertConfig["telegram"] = null;
  if (token !== "" || chatId !== "") {
    if (token === "" || chatId === "") {
      issues.push(
        "CHAIN_GUARD_TELEGRAM_BOT_TOKEN and CHAIN_GUARD_TELEGRAM_CHAT_ID: set both or neither",
      );
    } else if (!chainGuardTelegramTokenPattern.test(token)) {
      issues.push("CHAIN_GUARD_TELEGRAM_BOT_TOKEN: must be a Bot API token");
    } else if (!chainGuardTelegramChatPattern.test(chatId)) {
      issues.push(
        "CHAIN_GUARD_TELEGRAM_CHAT_ID: must be a numeric chat id or @channel",
      );
    } else {
      telegram = Object.freeze({ botToken: token, chatId });
    }
  }
  if (issues.length > 0) throw new ConfigurationError(issues);
  if (webhookUrl === null && telegram === null) return null;
  return Object.freeze({ webhookUrl, telegram });
}

/** Decision 0134: CHAIN_GUARD_ENABLED (`true` / `false`, default false). */
export function parseChainGuardEnabled(
  environment: NodeJS.ProcessEnv,
): boolean {
  const value = environment["CHAIN_GUARD_ENABLED"]?.trim() ?? "";
  if (value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new ConfigurationError(["CHAIN_GUARD_ENABLED: must be true or false"]);
}

/** The launch slot's RPC endpoints for an operator script (Decision 0134). */
export function parseLaunchSlotRpcUrls(
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  return parseLaunchChainIdEnvironment(environment["LAUNCH_CHAIN_ID"]) ===
    bscTestnetChainId
    ? parseBscRpcUrls(environment["LAUNCH_BSC_RPC_URLS"], "LAUNCH_BSC_RPC_URLS")
    : parseBscRpcUrls(environment["BSC_RPC_URLS"]);
}
