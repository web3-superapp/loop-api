import { createHash } from "node:crypto";

import { z } from "zod";

import {
  InvalidMarketDecimalError,
  normalizeDecimalString,
} from "../../features/market/market-contract.js";
import { normalizeEvmAddress } from "../../features/chain/chain-contract.js";
import {
  MarketProviderError,
  type ProviderObservation,
  type ProviderReadOptions,
  type SecurityFactsProvider,
  type TokenSecurityFact,
  type TokenSecuritySnapshot,
} from "./market-data-provider.js";
import {
  createProviderHttpKernel,
  createRateLimiter,
  malformed,
  nodeProviderFetch,
  type ProviderFetch,
  type ProviderHttpKernel,
} from "./provider-http.js";

/**
 * GoPlus Token Security adapter (Decision 0034; provider-lock
 * `goplus_service`, VERIFIED, credentialed).
 *
 * The adapter exists only when `GOPLUS_APP_KEY` and `GOPLUS_APP_SECRET` are
 * both configured. It obtains a short-lived access token through the
 * documented signed request (`sign = sha1(app_key + time + app_secret)`) and
 * reads `token_security/56`. Each returned flag becomes one labelled fact;
 * LOOP never turns the set into a score, rating, or verdict.
 */

export const goplusBaseUrl = "https://api.gopluslabs.io";
export const goplusDefaultRateLimitPerMinute = 30;
export const goplusChainReference = "56";

const flagFacts = Object.freeze({
  is_open_source: "openSource",
  is_proxy: "proxy",
  is_mintable: "mintable",
  can_take_back_ownership: "ownershipTakeBack",
  owner_change_balance: "ownerChangeBalance",
  hidden_owner: "hiddenOwner",
  selfdestruct: "selfDestruct",
  external_call: "externalCall",
  is_honeypot: "honeypot",
  transfer_pausable: "transferPausable",
  is_blacklisted: "blacklist",
  is_whitelisted: "whitelist",
  is_anti_whale: "antiWhale",
  trading_cooldown: "tradingCooldown",
  cannot_sell_all: "cannotSellAll",
  is_in_dex: "listedOnDex",
} as const);

const decimalFacts = Object.freeze({
  buy_tax: "buyTax",
  sell_tax: "sellTax",
} as const);

const flagValue = z.union([z.literal("0"), z.literal("1")]);

const tokenResultSchema = z
  .object({
    holder_count: z.string().optional(),
  })
  .catchall(z.unknown());

const tokenSecurityResponseSchema = z
  .object({
    code: z.union([z.string(), z.number()]),
    result: z.record(z.string(), tokenResultSchema).nullable().optional(),
  })
  .passthrough();

const accessTokenResponseSchema = z
  .object({
    code: z.union([z.string(), z.number()]),
    result: z
      .object({
        access_token: z.string().min(1).max(4_096),
        expires_in: z.union([z.string(), z.number()]),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

function optionalDecimal(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    return malformed();
  }
  try {
    return normalizeDecimalString(value);
  } catch (error) {
    if (error instanceof InvalidMarketDecimalError) {
      return malformed();
    }
    throw error;
  }
}

export function normalizeGoplusTokenSecurity(
  json: unknown,
  tokenAddress: string,
): TokenSecuritySnapshot {
  const parsed = tokenSecurityResponseSchema.safeParse(json);
  if (!parsed.success || String(parsed.data.code) !== "1") {
    return malformed();
  }
  const entry = parsed.data.result?.[tokenAddress];
  if (entry === undefined) {
    return Object.freeze({
      tokenAddress,
      facts: Object.freeze([]),
      holderCount: null,
    });
  }
  const facts: TokenSecurityFact[] = [];
  for (const [field, fact] of Object.entries(flagFacts)) {
    const raw = entry[field];
    if (raw === undefined || raw === "") {
      continue;
    }
    const flag = flagValue.safeParse(raw);
    if (!flag.success) {
      return malformed();
    }
    facts.push(
      Object.freeze({ fact, value: flag.data === "1" ? "true" : "false" }),
    );
  }
  for (const [field, fact] of Object.entries(decimalFacts)) {
    const value = optionalDecimal(entry[field]);
    if (value !== null) {
      facts.push(Object.freeze({ fact, value }));
    }
  }
  const holderCount = optionalDecimal(entry.holder_count);
  if (holderCount !== null && !/^(0|[1-9][0-9]*)$/.test(holderCount)) {
    return malformed();
  }
  return Object.freeze({
    tokenAddress,
    facts: Object.freeze(facts),
    holderCount,
  });
}

export interface CreateGoplusAdapterInput {
  readonly appKey: string;
  readonly appSecret: string;
  readonly rateLimitPerMinute?: number;
  readonly fetch?: ProviderFetch;
  readonly baseUrl?: string;
  readonly now?: () => Date;
  readonly kernel?: ProviderHttpKernel;
}

export function goplusSignature(
  appKey: string,
  time: number,
  appSecret: string,
): string {
  return createHash("sha1")
    .update(`${appKey}${String(time)}${appSecret}`, "utf8")
    .digest("hex");
}

export function createGoplusAdapter(
  input: CreateGoplusAdapterInput,
): SecurityFactsProvider {
  const kernel =
    input.kernel ??
    createProviderHttpKernel({
      fetch: input.fetch ?? nodeProviderFetch,
      rateLimiter: createRateLimiter({
        capacityPerMinute:
          input.rateLimitPerMinute ?? goplusDefaultRateLimitPerMinute,
      }),
    });
  const baseUrl = (input.baseUrl ?? goplusBaseUrl).replace(/\/$/, "");
  const now = input.now ?? ((): Date => new Date());
  let accessToken: {
    readonly value: string;
    readonly expiresAtMs: number;
  } | null = null;

  async function ensureAccessToken(
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const nowMs = now().getTime();
    if (accessToken !== null && accessToken.expiresAtMs - 60_000 > nowMs) {
      return accessToken.value;
    }
    const time = Math.floor(nowMs / 1_000);
    const result = await kernel.requestJson({
      url: `${baseUrl}/api/v1/token`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_key: input.appKey,
        sign: goplusSignature(input.appKey, time, input.appSecret),
        time,
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    const parsed = accessTokenResponseSchema.safeParse(result.json);
    if (
      !parsed.success ||
      String(parsed.data.code) !== "1" ||
      parsed.data.result === null ||
      parsed.data.result === undefined
    ) {
      throw new MarketProviderError(
        "market_provider_rejected",
        "MARKET_PROVIDER_REQUEST_REJECTED",
      );
    }
    const expiresIn = Number.parseInt(
      String(parsed.data.result.expires_in),
      10,
    );
    accessToken = Object.freeze({
      value: parsed.data.result.access_token,
      expiresAtMs:
        nowMs +
        (Number.isSafeInteger(expiresIn) && expiresIn > 0 ? expiresIn : 300) *
          1_000,
    });
    return accessToken.value;
  }

  return Object.freeze({
    source: "goplus" as const,
    async readTokenSecurity(
      rawTokenAddress: string,
      options: ProviderReadOptions = {},
    ): Promise<ProviderObservation<TokenSecuritySnapshot>> {
      const tokenAddress = normalizeEvmAddress(rawTokenAddress);
      const token = await ensureAccessToken(options.signal);
      const result = await kernel.requestJson({
        url: `${baseUrl}/api/v1/token_security/${goplusChainReference}?contract_addresses=${tokenAddress}`,
        headers: { authorization: token },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return Object.freeze({
        value: normalizeGoplusTokenSecurity(result.json, tokenAddress),
        source: "goplus" as const,
        fetchedAt: now().toISOString(),
        rawDigest: result.rawDigest,
      });
    },
  });
}
