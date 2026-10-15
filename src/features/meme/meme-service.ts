import { createHash, randomUUID } from "node:crypto";

import type { BscWriteConfig, MemeConfig } from "../../config.js";
import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
} from "../../core/http/v2-cursor.js";
import {
  V2ApiError,
  type V2ErrorDetailsSafe,
} from "../../core/http/v2-error.js";
import { isOpaqueId } from "../../core/ids/opaque-id.js";
import type { AccountWalletRepository } from "../../database/account-wallet-repository.js";
import {
  BscChainMismatchError,
  BscReadUnavailableError,
  type BscChainCallClient,
} from "../../integrations/bsc/rpc-client.js";
import {
  MemeContractUnavailableError,
  type MemeContractAdapter,
  type MemeContractSnapshot,
} from "../../integrations/meme/meme-contract-adapter.js";
import {
  assetIdForAddress,
  bscChainId,
  parseDecimalAmount,
} from "../chain/chain-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  MemeMetadataInvalidError,
  memeBestTradeWindows,
  memeCandleIntervals,
  memeCreateRequestParts,
  memeListTabs,
  memeMetadataHash,
  memeReasonCodes,
  memeRules,
  parseMemeTokenMetadata,
  type MemeBestTradeWindow,
  type MemeCandleInterval,
  type MemeListTab,
} from "./meme-contract.js";
import { randomMemeSalt } from "./meme-create2.js";
import { mediaAbsoluteUrl } from "../media/media-contract.js";
import {
  MemeSellExceedsSoldError,
  exceedsRelativeDifference,
  formatE18,
  memeMinBuyUsd1,
  memePriceE18,
  memePriceImpactBps,
  memeWalletCap,
  quoteMemeBuy,
  quoteMemeSell,
  type MemeCurveState,
} from "./meme-curve-math.js";
import {
  prepareMemeIntent,
  readMemeIntent,
  reportMemeIntentBroadcast,
  type MemeIntentResource,
} from "./meme-intent-service.js";
import {
  explorerBaseFor,
  projectMemeCurve,
  projectMemeGraduation,
  projectMemeTokenRow,
  shareBpsOf,
  type MemeDexQuote,
  type MemeDexQuoteReader,
} from "./meme-projection.js";
import {
  memePoolMarketCapRaw,
  type MemePoolPriceReader,
} from "./meme-pool-price.js";
import {
  MemeCreateRateLimitedError,
  MemeIdempotencyConflictError,
  MemeImageNotOwnedError,
  MemeRepositoryUnavailableError,
  type MemeRepository,
  type MemeTokenListRecord,
  type MemeTokenRecord,
} from "./meme-repository.js";

/**
 * MEME curve launchpad service (Decision 0101). Lists, details, trades,
 * K-lines, and holders come from the `meme_event` lane's PostgreSQL
 * projection; the viewer block and quotes read the launch slot at one
 * block; creation and Intents follow Decision 0077. Without the contract
 * configuration every method is CAPABILITY_UNAVAILABLE with the reason.
 */

export interface MemeServiceLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface MemeServiceDependencies {
  readonly config: MemeConfig;
  readonly repository: MemeRepository;
  readonly contract: MemeContractAdapter;
  readonly cursorCodec: V2CursorCodec | null;
  readonly wallets: AccountWalletRepository | null;
  /** The launch slot's call client (balances, allowances, simulation). */
  readonly readClient: BscChainCallClient;
  readonly writes: BscWriteConfig | null;
  readonly publicBaseUrl: string;
  readonly dexQuotes?: MemeDexQuoteReader | null;
  /** Decision 0103: slot0 fallback for graduated tokens without a quote. */
  readonly poolPrices?: MemePoolPriceReader | null;
  readonly logger?: MemeServiceLogger;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
}

export interface MemeService {
  listTokens(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly tab?: unknown;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<Record<string, unknown>>;
  getToken(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly memeTokenId: string;
  }): Promise<Record<string, unknown>>;
  /** Decision 0142: the weekly best realized trades (5-minute cache). */
  listBestTrades(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly window?: unknown;
  }): Promise<Record<string, unknown>>;
  listTrades(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly memeTokenId: string;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<Record<string, unknown>>;
  listCandles(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly memeTokenId: string;
    readonly interval?: unknown;
    readonly limit?: unknown;
  }): Promise<Record<string, unknown>>;
  listHolders(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly memeTokenId: string;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<Record<string, unknown>>;
  quote(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly tokenId?: unknown;
    readonly side?: unknown;
    readonly amount?: unknown;
    readonly walletId?: unknown;
  }): Promise<Record<string, unknown>>;
  createToken(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly body: unknown;
    readonly idempotencyKey: string;
  }): Promise<Record<string, unknown>>;
  prepareIntent(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly memeTokenId: string;
    readonly body: unknown;
    readonly idempotencyKey: string;
  }): Promise<MemeIntentResource>;
  reportIntent(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly memeTokenId: string;
    readonly memeIntentId: string;
    readonly body: unknown;
  }): Promise<MemeIntentResource>;
  getIntent(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly memeIntentId: string;
  }): Promise<MemeIntentResource>;
}

const listCursorRoute = "memeTokens";
const tradesCursorRoute = "memeTrades";
const holdersCursorRoute = "memeHolders";
const decimalAmountPattern = /^(0|[1-9][0-9]{0,40})(\.[0-9]{1,18})?$/u;

function unavailableWith(reasonCode: string): never {
  throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", { reasonCode });
}

function refuse(
  code:
    | "DATA_STALE"
    | "VALIDATION_FAILED"
    | "POLICY_BLOCKED"
    | "INSUFFICIENT_BALANCE"
    | "NOT_FOUND",
  reasonCode: string,
  extra: V2ErrorDetailsSafe = {},
): never {
  throw V2ApiError.fromCode(code, { reasonCode, ...extra });
}

export function memeTokenNotFound(): never {
  return refuse("NOT_FOUND", memeReasonCodes.tokenNotFound);
}

/** Maps chain and repository outages to 503; passes refusals through. */
export function translateMemeError(error: unknown): never {
  if (error instanceof V2ApiError) {
    throw error;
  }
  if (error instanceof MemeContractUnavailableError) {
    return unavailableWith(error.reasonCode);
  }
  if (
    error instanceof BscReadUnavailableError ||
    error instanceof BscChainMismatchError
  ) {
    return unavailableWith("MEME_CONTRACT_READ_FAILED");
  }
  if (error instanceof MemeRepositoryUnavailableError) {
    return unavailableWith("MEME_REPOSITORY_UNAVAILABLE");
  }
  throw error;
}

function parseLimit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9][0-9]{0,3}$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw V2ApiError.invalidRequest();
  }
  return parsed;
}

function parseDecimal(value: unknown): bigint {
  if (typeof value !== "string" || !decimalAmountPattern.test(value)) {
    throw V2ApiError.invalidRequest();
  }
  return parseDecimalAmount(value, 18);
}

interface CachedEntry<T> {
  readonly promise: Promise<T>;
  readonly expiresAt: number;
}

export function createMemeService(deps: MemeServiceDependencies): MemeService {
  const now = deps.now ?? ((): Date => new Date());
  const createUuid = deps.createUuid ?? randomUUID;
  const chainCache = new Map<string, CachedEntry<unknown>>();
  let hotCache: {
    readonly expiresAt: number;
    readonly ids: readonly { memeTokenId: string; volumeRaw: string }[];
  } | null = null;

  let bestTradesCache: {
    readonly expiresAt: number;
    readonly resource: Record<string, unknown>;
  } | null = null;

  function contractOrUnavailable() {
    const contract = deps.config.contract;
    if (contract === null) {
      return unavailableWith(
        deps.config.unconfiguredReason ?? "MEME_CONTRACT_NOT_CONFIGURED",
      );
    }
    return contract;
  }

  function cursorCodec(): V2CursorCodec {
    if (deps.cursorCodec === null) {
      return unavailableWith("MEME_CURSOR_NOT_CONFIGURED");
    }
    return deps.cursorCodec;
  }

  /** Reuses a successful chain read for `chainReadCacheMs` (S83b8). */
  function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const at = now().getTime();
    const hit = chainCache.get(key);
    if (hit !== undefined && at < hit.expiresAt) {
      return hit.promise as Promise<T>;
    }
    for (const [staleKey, entry] of chainCache) {
      if (entry.expiresAt <= at) {
        chainCache.delete(staleKey);
      }
    }
    const promise = read();
    chainCache.set(key, {
      promise,
      expiresAt: at + memeRules.chainReadCacheMs,
    });
    promise.catch(() => {
      chainCache.delete(key);
    });
    return promise;
  }

  async function visibleToken(
    principal: AuthenticatedLoopPrincipal,
    memeTokenId: string,
  ): Promise<MemeTokenRecord> {
    contractOrUnavailable();
    if (!isOpaqueId(memeTokenId)) {
      return memeTokenNotFound();
    }
    let record: MemeTokenRecord | null;
    try {
      record = await deps.repository.getToken(memeTokenId);
    } catch (error) {
      return translateMemeError(error);
    }
    if (
      record === null ||
      ((record.status === "draft" || record.status === "pending_chain") &&
        record.creatorUserId !== principal.userId)
    ) {
      return memeTokenNotFound();
    }
    return record;
  }

  async function dexQuotesFor(
    records: readonly MemeTokenRecord[],
  ): Promise<ReadonlyMap<string, MemeDexQuote | { reasonCode: string }>> {
    const graduated = records.filter(
      (record) => record.status === "graduated" && record.tokenAddress !== null,
    );
    if (graduated.length === 0) {
      return new Map();
    }
    const quotes = new Map(await dexScreenerQuotesFor(graduated));
    // Decision 0103: no DexScreener price → the pool's own slot0. A failed
    // read keeps the DexScreener reason (MEME_DEX_CHAIN_NOT_PRICED on 97).
    const poolPrices = deps.poolPrices ?? null;
    if (poolPrices !== null) {
      await Promise.all(
        graduated.map(async (record) => {
          const token = record.tokenAddress as string;
          const existing = quotes.get(token);
          if (
            record.poolAddress === null ||
            (existing !== undefined && "priceUsd" in existing)
          ) {
            return;
          }
          const pool = await poolPrices({
            tokenAddress: token,
            poolAddress: record.poolAddress,
          });
          if (pool !== null) {
            quotes.set(token, {
              priceUsd: formatE18(pool.priceE18),
              marketCapUsd: formatE18(memePoolMarketCapRaw(pool.priceE18)),
              observedAt: pool.observedAt,
              source: "pool_slot0",
            });
          }
        }),
      );
    }
    return quotes;
  }

  async function dexScreenerQuotesFor(
    graduated: readonly MemeTokenRecord[],
  ): Promise<ReadonlyMap<string, MemeDexQuote | { reasonCode: string }>> {
    const chainId = graduated[0]?.chainId ?? bscChainId;
    if (chainId !== bscChainId) {
      return new Map(
        graduated.map((record) => [
          record.tokenAddress as string,
          { reasonCode: memeReasonCodes.chainNotPriced },
        ]),
      );
    }
    if (deps.dexQuotes === undefined || deps.dexQuotes === null) {
      return new Map();
    }
    try {
      return await deps.dexQuotes(
        chainId,
        graduated.map((record) => record.tokenAddress as string),
      );
    } catch {
      return new Map();
    }
  }

  async function rows(
    records: readonly MemeTokenListRecord[],
  ): Promise<Record<string, unknown>[]> {
    const dex = await dexQuotesFor(records);
    const context = {
      publicBaseUrl: deps.publicBaseUrl,
      now: now(),
      dexQuotes: dex,
    };
    return records.map((record) =>
      Object.freeze(projectMemeTokenRow(record, context)),
    );
  }

  async function hotRanking(contract: {
    readonly address: string;
  }): Promise<readonly { memeTokenId: string; volumeRaw: string }[]> {
    const at = now().getTime();
    if (hotCache !== null && at < hotCache.expiresAt) {
      return hotCache.ids;
    }
    const ids = await deps.repository.rankHotTokens({
      chainId: deps.contract.chainId,
      contractAddress: contract.address,
      since: new Date(at - memeRules.hotWindowSeconds * 1000).toISOString(),
      limit: memeRules.hotCandidateLimit,
    });
    hotCache = { expiresAt: at + memeRules.hotCacheMs, ids };
    return ids;
  }

  /** Chain view of the curve, or the indexed snapshot when unreadable. */
  async function curveBasis(record: MemeTokenRecord): Promise<{
    readonly curve: MemeCurveState;
    readonly status: string;
    readonly snapshot: MemeContractSnapshot | null;
  }> {
    const token = record.tokenAddress as string;
    try {
      const read = await cached(`curve:${token}`, () =>
        deps.contract.getCurve(token),
      );
      return {
        curve: { vUsd1: read.value.vUsd1, vToken: read.value.vToken },
        status: read.value.status,
        snapshot: read.snapshot,
      };
    } catch {
      return {
        curve: { vUsd1: BigInt(record.vUsd1), vToken: BigInt(record.vToken) },
        status:
          record.status === "trading"
            ? "TRADING"
            : record.status === "full"
              ? "FULL"
              : record.status === "graduated"
                ? "GRADUATED"
                : "PAUSED",
        snapshot: null,
      };
    }
  }

  async function viewerWallet(principal: AuthenticatedLoopPrincipal) {
    if (deps.wallets === null) {
      return null;
    }
    const wallets = await deps.wallets.list(principal.userId);
    return (
      wallets.find((wallet) => wallet.isActive && wallet.status === "active") ??
      null
    );
  }

  async function readViewerFunds(input: {
    readonly walletAddress: string;
    readonly token: string;
    readonly usd1: string;
    readonly spender: string;
  }): Promise<{
    readonly balance: bigint;
    readonly usd1Balance: bigint;
    readonly allowanceUsd1: bigint;
    readonly allowanceToken: bigint;
  }> {
    return cached(`funds:${input.walletAddress}:${input.token}`, async () => {
      const chainId = deps.contract.chainId;
      const tokenAsset = assetIdForAddress(chainId, input.token);
      const usd1Asset = assetIdForAddress(chainId, input.usd1);
      const [balances, allowances] = await Promise.all([
        deps.readClient.readBalances(input.walletAddress, [
          { assetId: tokenAsset, address: input.token },
          { assetId: usd1Asset, address: input.usd1 },
        ]),
        deps.readClient.readAllowances(input.walletAddress, [
          { assetId: usd1Asset, token: input.usd1, spender: input.spender },
          { assetId: tokenAsset, token: input.token, spender: input.spender },
        ]),
      ]);
      const balance = balances.balances.find(
        (item) => item.assetId === tokenAsset,
      )?.rawValue;
      const usd1Balance = balances.balances.find(
        (item) => item.assetId === usd1Asset,
      )?.rawValue;
      const allowanceUsd1 = allowances.allowances[0]?.rawValue;
      const allowanceToken = allowances.allowances[1]?.rawValue;
      if (
        balance === undefined ||
        balance === null ||
        usd1Balance === undefined ||
        usd1Balance === null ||
        allowanceUsd1 === undefined ||
        allowanceUsd1 === null ||
        allowanceToken === undefined ||
        allowanceToken === null
      ) {
        throw new BscReadUnavailableError("MEME_CONTRACT_READ_FAILED");
      }
      return { balance, usd1Balance, allowanceUsd1, allowanceToken };
    });
  }

  function decodeCursor(
    principal: AuthenticatedLoopPrincipal,
    route: string,
    filter: string,
    cursor: unknown,
  ): Readonly<Record<string, string | number | boolean>> {
    if (typeof cursor !== "string") {
      throw V2ApiError.invalidRequest();
    }
    try {
      return cursorCodec().decode({
        ownerId: principal.userId,
        route,
        filter,
        cursor,
      });
    } catch (error) {
      if (error instanceof InvalidV2CursorError) {
        throw V2ApiError.invalidRequest();
      }
      throw error;
    }
  }

  function encodeCursor(
    principal: AuthenticatedLoopPrincipal,
    route: string,
    filter: string,
    continuation: Readonly<Record<string, string | number | boolean>>,
  ): string {
    return cursorCodec().encode({
      ownerId: principal.userId,
      route,
      filter,
      continuation,
    });
  }

  const service: MemeService = {
    async listTokens(input) {
      const contract = contractOrUnavailable();
      const tab: MemeListTab =
        input.tab === undefined
          ? "new"
          : typeof input.tab === "string" &&
              (memeListTabs as readonly string[]).includes(input.tab)
            ? (input.tab as MemeListTab)
            : (() => {
                throw V2ApiError.invalidRequest();
              })();
      if (input.cursor !== undefined && input.limit !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      const filter = `tab=${tab}`;
      let limit = parseLimit(
        input.limit,
        memeRules.listDefaultLimit,
        memeRules.listMaximumLimit,
      );
      let after: { value: string; memeTokenId: string } | null = null;
      if (input.cursor !== undefined) {
        const continuation = decodeCursor(
          input.principal,
          listCursorRoute,
          filter,
          input.cursor,
        );
        const value = continuation["value"];
        const id = continuation["memeTokenId"];
        const size = continuation["limit"];
        if (
          typeof value !== "string" ||
          typeof id !== "string" ||
          typeof size !== "number" ||
          !Number.isInteger(size) ||
          size < 1 ||
          size > memeRules.listMaximumLimit
        ) {
          throw V2ApiError.invalidRequest();
        }
        after = { value, memeTokenId: id };
        limit = size;
      }
      const observedAt = now().toISOString();
      let records: readonly MemeTokenListRecord[];
      let keyOf: (record: MemeTokenListRecord) => string;
      let hotContinuation:
        | { readonly value: string; readonly memeTokenId: string }
        | null
        | undefined;
      try {
        if (tab === "hot") {
          const ranking = await hotRanking(contract);
          let start = 0;
          if (after !== null) {
            const afterId = after.memeTokenId;
            const index = ranking.findIndex(
              (item) => item.memeTokenId === afterId,
            );
            // The ranking is a 60-second snapshot; a cursor from an older
            // snapshot restarts after the same token, or at the end.
            start = index === -1 ? ranking.length : index + 1;
          }
          // Decision 0102: the ranking is cached for 60 seconds; a token
          // hidden since then leaves the page at once. Decision 0105: the
          // page keeps reading the ranking until it holds `limit` visible
          // tokens or the ranking ends, so hidden ones never shorten it.
          const visible: MemeTokenListRecord[] = [];
          let position = start;
          let lastExamined: (typeof ranking)[number] | null = null;
          while (visible.length < limit && position < ranking.length) {
            const chunk = ranking.slice(
              position,
              position + (limit - visible.length),
            );
            position += chunk.length;
            const byId = new Map(
              (
                await deps.repository.listTokensByIds({
                  memeTokenIds: chunk.map((item) => item.memeTokenId),
                  now: observedAt,
                })
              ).map((record) => [record.memeTokenId, record]),
            );
            for (const item of chunk) {
              lastExamined = item;
              const record = byId.get(item.memeTokenId);
              if (record !== undefined && record.listing !== "hidden") {
                visible.push(record);
              }
            }
          }
          records = visible;
          // The next page starts after the last ranking entry read, and
          // exists while the ranking has entries left.
          hotContinuation =
            position < ranking.length && lastExamined !== null
              ? {
                  value: lastExamined.volumeRaw,
                  memeTokenId: lastExamined.memeTokenId,
                }
              : null;
          const volumes = new Map(
            ranking.map((item) => [item.memeTokenId, item.volumeRaw]),
          );
          keyOf = (record) => volumes.get(record.memeTokenId) ?? "0";
        } else {
          records = await deps.repository.listTokens({
            chainId: deps.contract.chainId,
            contractAddress: contract.address,
            tab,
            limit: limit + 1,
            after,
            now: observedAt,
          });
          keyOf =
            tab === "new"
              ? (record) => record.chainCreatedAt ?? record.createdAt
              : tab === "graduating"
                ? (record) => record.sold
                : (record) => record.graduatedAt ?? record.updatedAt;
        }
      } catch (error) {
        return translateMemeError(error);
      }
      const page = records.slice(0, limit);
      const last = page.at(-1);
      const continuation =
        hotContinuation !== undefined
          ? hotContinuation
          : records.length > limit && last !== undefined
            ? { value: keyOf(last), memeTokenId: last.memeTokenId }
            : null;
      const nextCursor =
        continuation === null
          ? null
          : encodeCursor(input.principal, listCursorRoute, filter, {
              value: continuation.value,
              memeTokenId: continuation.memeTokenId,
              limit,
            });
      return Object.freeze({
        tab,
        items: await rows(page),
        nextCursor,
        rules: Object.freeze({
          configVersion: memeRules.configVersion,
          effectiveAt: memeRules.effectiveAt,
          graduatingProgressBps: memeRules.graduatingProgressBps,
          hotWindowSeconds: memeRules.hotWindowSeconds,
        }),
        observedAt,
        contractVersion: v2ContractVersion,
      });
    },

    async listBestTrades(input) {
      const contract = contractOrUnavailable();
      const window: MemeBestTradeWindow =
        input.window === undefined
          ? "7d"
          : typeof input.window === "string" &&
              (memeBestTradeWindows as readonly string[]).includes(input.window)
            ? (input.window as MemeBestTradeWindow)
            : (() => {
                throw V2ApiError.invalidRequest();
              })();
      const at = now();
      if (
        bestTradesCache !== null &&
        at.getTime() < bestTradesCache.expiresAt
      ) {
        return bestTradesCache.resource;
      }
      const observedAt = at.toISOString();
      let records;
      try {
        records = await deps.repository.rankBestTrades({
          chainId: deps.contract.chainId,
          contractAddress: contract.address,
          since: new Date(
            at.getTime() - memeRules.bestTradesWindowSeconds * 1000,
          ).toISOString(),
          until: observedAt,
          limit: memeRules.bestTradesLimit,
        });
      } catch (error) {
        return translateMemeError(error);
      }
      const resource = Object.freeze({
        window,
        items: records.map((record, index) =>
          Object.freeze({
            rank: index + 1,
            user: Object.freeze({
              userId: record.publicProfileId,
              loopId: record.loopId,
              alias: record.alias,
              avatar: record.avatarRef,
            }),
            token: Object.freeze({
              memeTokenId: record.memeTokenId,
              symbol: record.symbol,
              logoUrl:
                record.imageMediaId === null
                  ? null
                  : mediaAbsoluteUrl(deps.publicBaseUrl, record.imageMediaId),
            }),
            realizedUsd1: formatE18(BigInt(record.realizedRaw)),
            observedAt,
          }),
        ),
        observedAt,
        contractVersion: v2ContractVersion,
      });
      bestTradesCache = {
        expiresAt: at.getTime() + memeRules.bestTradesCacheMs,
        resource,
      };
      return resource;
    },

    async getToken(input) {
      const contract = contractOrUnavailable();
      const record = await visibleToken(input.principal, input.memeTokenId);
      const observedAt = now().toISOString();
      let stats;
      try {
        stats = await deps.repository.tokenStats({
          memeTokenId: record.memeTokenId,
          now: observedAt,
        });
      } catch (error) {
        return translateMemeError(error);
      }
      const [head] = await rows([{ ...record, ...stats }]);
      let viewer: Record<string, unknown> | null = null;
      let viewerUnavailable: Record<string, unknown> | null = null;
      if (record.tokenAddress !== null) {
        try {
          const wallet = await viewerWallet(input.principal);
          if (wallet === null) {
            viewerUnavailable = {
              reasonCode: memeReasonCodes.viewerWalletMissing,
            };
          } else {
            const funds = await readViewerFunds({
              walletAddress: wallet.address,
              token: record.tokenAddress,
              usd1: contract.usd1Address,
              spender: contract.address,
            });
            const remaining = memeWalletCap - funds.balance;
            viewer = {
              walletId: wallet.walletId,
              balance: funds.balance.toString(10),
              usd1Balance: funds.usd1Balance.toString(10),
              walletCapRemaining:
                record.status === "graduated"
                  ? null
                  : (remaining < 0n ? 0n : remaining).toString(10),
              allowanceUsd1: funds.allowanceUsd1.toString(10),
              allowanceToken: funds.allowanceToken.toString(10),
            };
          }
        } catch (error) {
          viewerUnavailable = {
            reasonCode:
              error instanceof MemeContractUnavailableError
                ? error.reasonCode
                : "MEME_CONTRACT_READ_FAILED",
          };
        }
      }
      return Object.freeze({
        memeToken: Object.freeze({
          ...head,
          description: record.description,
          links: record.links,
          metadataHash: record.metadataHash,
          salt: record.salt,
          predictedAddress: record.predictedAddress,
          vanity: record.vanity,
          curve: projectMemeCurve(record),
          contract: {
            address: contract.address,
            version: contract.version,
            chainId: deps.contract.chainId,
            chainReference: deps.contract.chainReference,
            explorerUrl:
              record.tokenAddress === null
                ? null
                : `${explorerBaseFor(deps.contract.chainId)}/token/${record.tokenAddress}`,
          },
          viewer,
          ...(viewerUnavailable === null ? {} : { viewerUnavailable }),
          graduation: projectMemeGraduation(record),
          listing: record.listing,
          listingReason:
            record.listing === "hidden"
              ? {
                  // Decision 0105: the operator's lower-case code is
                  // published as an upper-case catalog code.
                  reasonCode:
                    record.listingReasonCode === null
                      ? null
                      : `OPERATOR_${record.listingReasonCode.toUpperCase()}`,
                  reasonText: record.listingReasonText,
                }
              : null,
          source: {
            source: "loop_indexer",
            observedAt,
          },
        }),
        contractVersion: v2ContractVersion,
      });
    },

    async listTrades(input) {
      const record = await visibleToken(input.principal, input.memeTokenId);
      if (input.cursor !== undefined && input.limit !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      const filter = `token=${record.memeTokenId}`;
      let limit = parseLimit(
        input.limit,
        memeRules.pageDefaultLimit,
        memeRules.pageMaximumLimit,
      );
      let after: { blockNumber: string; logIndex: number } | null = null;
      if (input.cursor !== undefined) {
        const c = decodeCursor(
          input.principal,
          tradesCursorRoute,
          filter,
          input.cursor,
        );
        if (
          typeof c["blockNumber"] !== "string" ||
          !/^(0|[1-9][0-9]{0,18})$/u.test(c["blockNumber"]) ||
          typeof c["logIndex"] !== "number" ||
          typeof c["limit"] !== "number" ||
          !Number.isInteger(c["limit"]) ||
          c["limit"] < 1 ||
          c["limit"] > memeRules.pageMaximumLimit
        ) {
          throw V2ApiError.invalidRequest();
        }
        after = { blockNumber: c["blockNumber"], logIndex: c["logIndex"] };
        limit = c["limit"];
      }
      let trades;
      try {
        trades = await deps.repository.listTrades({
          memeTokenId: record.memeTokenId,
          limit: limit + 1,
          after,
        });
      } catch (error) {
        return translateMemeError(error);
      }
      const page = trades.slice(0, limit);
      const last = page.at(-1);
      return Object.freeze({
        memeTokenId: record.memeTokenId,
        items: page.map((trade) =>
          Object.freeze({
            txHash: trade.transactionHash,
            logIndex: trade.logIndex,
            blockNumber: trade.blockNumber,
            wallet: trade.wallet,
            account: trade.account,
            isBuy: trade.isBuy,
            usd1Amount: trade.usd1Amount,
            tokenAmount: trade.tokenAmount,
            feeUsd1: trade.feeUsd1,
            priceAfter: formatE18(BigInt(trade.priceAfterE18)),
            at: trade.tradedAt,
          }),
        ),
        nextCursor:
          trades.length > limit && last !== undefined
            ? encodeCursor(input.principal, tradesCursorRoute, filter, {
                blockNumber: last.blockNumber,
                logIndex: last.logIndex,
                limit,
              })
            : null,
        source: { source: "loop_indexer", observedAt: now().toISOString() },
        contractVersion: v2ContractVersion,
      });
    },

    async listCandles(input) {
      const record = await visibleToken(input.principal, input.memeTokenId);
      const interval: MemeCandleInterval =
        input.interval === undefined
          ? "15m"
          : typeof input.interval === "string" &&
              Object.hasOwn(memeCandleIntervals, input.interval)
            ? (input.interval as MemeCandleInterval)
            : (() => {
                throw V2ApiError.invalidRequest();
              })();
      const limit = parseLimit(
        input.limit,
        memeRules.candleDefaultLimit,
        memeRules.candleMaximumLimit,
      );
      let candles;
      try {
        candles = await deps.repository.listCandles({
          memeTokenId: record.memeTokenId,
          intervalSeconds: memeCandleIntervals[interval],
          limit,
          until: record.status === "graduated" ? record.graduatedAt : null,
        });
      } catch (error) {
        return translateMemeError(error);
      }
      return Object.freeze({
        memeTokenId: record.memeTokenId,
        interval,
        items: candles.map((candle) =>
          Object.freeze({
            openTime: candle.openTime,
            open: formatE18(BigInt(candle.openE18)),
            high: formatE18(BigInt(candle.highE18)),
            low: formatE18(BigInt(candle.lowE18)),
            close: formatE18(BigInt(candle.closeE18)),
            volumeUsd1: formatE18(BigInt(candle.volumeUsd1Raw)),
            tradeCount: candle.tradeCount,
          }),
        ),
        frozenAt: record.status === "graduated" ? record.graduatedAt : null,
        source: { source: "loop_indexer", observedAt: now().toISOString() },
        contractVersion: v2ContractVersion,
      });
    },

    async listHolders(input) {
      const record = await visibleToken(input.principal, input.memeTokenId);
      if (input.cursor !== undefined && input.limit !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      const filter = `token=${record.memeTokenId}`;
      let limit = parseLimit(
        input.limit,
        memeRules.pageDefaultLimit,
        memeRules.pageMaximumLimit,
      );
      let after: { balance: string; wallet: string } | null = null;
      if (input.cursor !== undefined) {
        const c = decodeCursor(
          input.principal,
          holdersCursorRoute,
          filter,
          input.cursor,
        );
        if (
          typeof c["balance"] !== "string" ||
          !/^(0|[1-9][0-9]{0,77})$/u.test(c["balance"]) ||
          typeof c["wallet"] !== "string" ||
          !/^0x[0-9a-f]{40}$/u.test(c["wallet"]) ||
          typeof c["limit"] !== "number" ||
          !Number.isInteger(c["limit"]) ||
          c["limit"] < 1 ||
          c["limit"] > memeRules.pageMaximumLimit
        ) {
          throw V2ApiError.invalidRequest();
        }
        after = { balance: c["balance"], wallet: c["wallet"] };
        limit = c["limit"];
      }
      let holders;
      try {
        holders = await deps.repository.listHolders({
          memeTokenId: record.memeTokenId,
          limit: limit + 1,
          after,
        });
      } catch (error) {
        return translateMemeError(error);
      }
      const page = holders.slice(0, limit);
      const last = page.at(-1);
      return Object.freeze({
        memeTokenId: record.memeTokenId,
        holderCount: record.holderCount,
        frozenAt: record.status === "graduated" ? record.graduatedAt : null,
        items: page.map((holder) =>
          Object.freeze({
            wallet: holder.wallet,
            account: holder.account,
            balance: holder.balance,
            shareBps: shareBpsOf(BigInt(holder.balance)),
            isCreator:
              record.creatorWallet !== null &&
              holder.wallet === record.creatorWallet,
            isViewer: holder.ownerUserId === input.principal.userId,
          }),
        ),
        nextCursor:
          holders.length > limit && last !== undefined
            ? encodeCursor(input.principal, holdersCursorRoute, filter, {
                balance: last.balance,
                wallet: last.wallet,
                limit,
              })
            : null,
        source: { source: "loop_indexer", observedAt: now().toISOString() },
        contractVersion: v2ContractVersion,
      });
    },

    async quote(input) {
      const contract = contractOrUnavailable();
      if (typeof input.tokenId !== "string") {
        throw V2ApiError.invalidRequest();
      }
      if (input.side !== "buy" && input.side !== "sell") {
        throw V2ApiError.invalidRequest();
      }
      const side = input.side;
      const amount = parseDecimal(input.amount);
      if (amount <= 0n) {
        throw V2ApiError.invalidRequest();
      }
      if (input.walletId !== undefined && !isOpaqueId(input.walletId)) {
        throw V2ApiError.invalidRequest();
      }
      const record = await visibleToken(input.principal, input.tokenId);
      if (record.tokenAddress === null) {
        refuse("DATA_STALE", memeReasonCodes.tokenNotOnChain);
      }
      const basis = await curveBasis(record);
      if (basis.status === "FULL") {
        refuse("DATA_STALE", memeReasonCodes.curveFull);
      }
      if (basis.status !== "TRADING") {
        refuse("DATA_STALE", memeReasonCodes.curveNotTrading, {
          status: basis.status,
        });
      }
      let holding: bigint | null = null;
      if (typeof input.walletId === "string" && deps.wallets !== null) {
        const wallet = await deps.wallets.get(
          input.principal.userId,
          input.walletId,
        );
        if (wallet === null || wallet.status !== "active") {
          throw V2ApiError.notFound();
        }
        try {
          const funds = await readViewerFunds({
            walletAddress: wallet.address,
            token: record.tokenAddress,
            usd1: contract.usd1Address,
            spender: contract.address,
          });
          holding = funds.balance;
        } catch {
          holding = null;
        }
      }
      const curve = basis.curve;
      let out: bigint;
      let fee: bigint;
      let refund: bigint | null = null;
      let after: MemeCurveState;
      let walletCapHit = false;
      let walletCapRemaining: string | null = null;
      if (side === "buy") {
        const q = quoteMemeBuy(curve, amount);
        out = q.tokensOut;
        fee = q.fee;
        refund = q.refund;
        after = { vUsd1: q.newVUsd1, vToken: q.newVToken };
        const held = holding ?? 0n;
        walletCapHit = held + out > memeWalletCap;
        if (holding !== null) {
          const remaining = memeWalletCap - holding;
          walletCapRemaining = (remaining < 0n ? 0n : remaining).toString(10);
        }
      } else {
        try {
          const q = quoteMemeSell(curve, amount);
          out = q.usd1Out;
          fee = q.fee;
          after = { vUsd1: q.newVUsd1, vToken: q.newVToken };
        } catch (error) {
          if (error instanceof MemeSellExceedsSoldError) {
            return refuse(
              "VALIDATION_FAILED",
              memeReasonCodes.sellExceedsBalance,
            );
          }
          throw error;
        }
      }
      if (basis.snapshot !== null) {
        void crossCheck({
          token: record.tokenAddress,
          side,
          amount,
          out,
          snapshot: basis.snapshot,
        });
      }
      return Object.freeze({
        quote: Object.freeze({
          memeTokenId: record.memeTokenId,
          side,
          amountIn: amount.toString(10),
          out: out.toString(10),
          fee: fee.toString(10),
          ...(refund === null ? {} : { refund: refund.toString(10) }),
          priceImpactBps: memePriceImpactBps(curve, after),
          priceBefore: formatE18(memePriceE18(curve)),
          priceAfter: formatE18(memePriceE18(after)),
          minOutAtDefaultSlippage: (
            (out * BigInt(10_000 - memeRules.defaultSlippageBps)) /
            10_000n
          ).toString(10),
          walletCapHit,
          walletCapRemaining,
          belowMinBuy: side === "buy" && amount < memeMinBuyUsd1,
        }),
        basis: Object.freeze({
          source: basis.snapshot === null ? "loop_indexer" : "chain",
          blockNumber:
            basis.snapshot === null
              ? null
              : basis.snapshot.blockNumber.toString(10),
          observedAt: now().toISOString(),
        }),
        contractVersion: v2ContractVersion,
      });
    },

    async createToken(input) {
      const contract = contractOrUnavailable();
      let metadata;
      try {
        metadata = parseMemeTokenMetadata(input.body);
      } catch (error) {
        if (error instanceof MemeMetadataInvalidError) {
          return refuse("VALIDATION_FAILED", memeReasonCodes.metadataInvalid, {
            field: error.field,
          });
        }
        throw error;
      }
      const memeTokenId = createUuid();
      const requestSha256 = createHash("sha256")
        .update(
          [
            `loop:v2:meme:create:${v2ContractVersion}`,
            ...memeCreateRequestParts(metadata),
          ].join("\0"),
          "utf8",
        )
        .digest("hex");
      const at = now();
      let outcome;
      try {
        outcome = await deps.repository.createDraft({
          ownerUserId: input.principal.userId,
          idempotencyKey: input.idempotencyKey,
          requestSha256,
          dailyLimit: deps.config.createDailyLimit,
          limitWindowStart: new Date(
            at.getTime() - 24 * 60 * 60 * 1000,
          ).toISOString(),
          draft: {
            memeTokenId,
            chainId: deps.contract.chainId,
            contractAddress: contract.address,
            contractVersion: contract.version,
            name: metadata.name,
            symbol: metadata.symbol,
            description: metadata.description,
            imageMediaId: metadata.imageMediaId,
            links: metadata.links,
            metadataHash: memeMetadataHash({ metadata, memeTokenId }),
          },
          saltScope: {
            chainId: deps.contract.chainId,
            contractAddress: contract.address,
            tokenImplementation: contract.tokenImplementation,
            suffix: deps.config.vanitySuffix,
          },
          fallbackSalt: randomMemeSalt({
            deployer: contract.address,
            implementation: contract.tokenImplementation,
          }),
        });
      } catch (error) {
        if (error instanceof MemeCreateRateLimitedError) {
          throw V2ApiError.fromCode("RATE_LIMITED", {
            reasonCode: memeReasonCodes.createRateLimited,
            dailyLimit: error.limit,
          });
        }
        if (error instanceof MemeImageNotOwnedError) {
          return refuse("VALIDATION_FAILED", memeReasonCodes.imageNotOwned);
        }
        if (error instanceof MemeIdempotencyConflictError) {
          throw V2ApiError.idempotencyConflict();
        }
        return translateMemeError(error);
      }
      if (!outcome.token.vanity) {
        deps.logger?.warn(
          {
            memeTokenId: outcome.token.memeTokenId,
            reasonCode: memeReasonCodes.saltUnavailable,
          },
          "MEME salt pool had no free vanity salt; a random salt was used",
        );
      }
      return service.getToken({
        principal: input.principal,
        memeTokenId: outcome.token.memeTokenId,
      });
    },

    prepareIntent(input) {
      const contract = contractOrUnavailable();
      return prepareMemeIntent(
        {
          ...deps,
          contractConfig: contract,
          now,
          createUuid,
          visibleToken: (memeTokenId) =>
            visibleToken(input.principal, memeTokenId),
        },
        input,
      );
    },

    reportIntent(input) {
      contractOrUnavailable();
      return reportMemeIntentBroadcast({ ...deps, now }, input);
    },

    getIntent(input) {
      contractOrUnavailable();
      return readMemeIntent({ ...deps, now }, input);
    },
  };

  /**
   * Decision 0101: the recomputation is the quote; the chain's
   * `quoteBuy` / `quoteSell` at the same block is the audit. A drift above
   * 0.1% is logged (numbers only), never answered.
   */
  async function crossCheck(input: {
    readonly token: string;
    readonly side: "buy" | "sell";
    readonly amount: bigint;
    readonly out: bigint;
    readonly snapshot: MemeContractSnapshot;
  }): Promise<void> {
    try {
      const chainOut =
        input.side === "buy"
          ? (
              await deps.contract.quoteBuy(
                { token: input.token, usd1In: input.amount },
                input.snapshot,
              )
            ).value.tokensOut
          : (
              await deps.contract.quoteSell(
                { token: input.token, tokensIn: input.amount },
                input.snapshot,
              )
            ).value.usd1Out;
      if (
        exceedsRelativeDifference(
          chainOut,
          input.out,
          memeRules.quoteDriftWarningBps,
        )
      ) {
        deps.logger?.warn(
          {
            reasonCode: "MEME_QUOTE_DRIFT",
            side: input.side,
            blockNumber: input.snapshot.blockNumber.toString(10),
            recomputed: input.out.toString(10),
            chain: chainOut.toString(10),
          },
          "MEME quote recomputation differs from the chain by more than 0.1%",
        );
      }
    } catch {
      // The audit is best-effort; the answer never depends on it.
    }
  }

  return Object.freeze(service);
}

export function createUnavailableMemeService(
  reasonCode = "MEME_RUNTIME_UNAVAILABLE",
): MemeService {
  const fail = (): Promise<never> =>
    Promise.reject(
      V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", { reasonCode }),
    );
  return Object.freeze({
    listTokens: fail,
    getToken: fail,
    listBestTrades: fail,
    listTrades: fail,
    listCandles: fail,
    listHolders: fail,
    quote: fail,
    createToken: fail,
    prepareIntent: fail,
    reportIntent: fail,
    getIntent: fail,
  });
}
