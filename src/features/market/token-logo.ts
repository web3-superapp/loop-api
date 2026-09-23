import { getAddress } from "viem";

import {
  bscChainId,
  decomposeAssetId,
  InvalidChainIdentityError,
  isNormalizedEvmAddress,
} from "../chain/chain-contract.js";
import type { TokenPairSnapshot } from "../../integrations/market/market-data-provider.js";

/**
 * Token logo projection (Decision 0072).
 *
 * A logo is a display fact, never an identifier: it hangs off an asset row
 * that is already keyed by its CAIP-19 `assetId`. Exactly two origins are
 * admitted and the URL is published only when it points at one of the
 * allow-listed hosts over HTTPS:
 *
 * - `dexscreener`: the `info.imageUrl` DexScreener reports on a pair whose
 *   *base* token is the asset. It arrives inside the pair fact the row is
 *   already priced from, so it shares that fact's cache row, TTL, and
 *   `fetchedAt`; no request is ever made for a logo alone.
 * - `trustwallet`: the fixed URL rule of the Trust Wallet assets repository
 *   for a BSC token or the native coin. It is a rule, not an observation —
 *   the server never probes whether the file exists, so `observedAt` is
 *   `null` and the client falls back to its monogram on a load failure.
 *
 * Anything else — another host, plain HTTP, credentials or a port in the
 * URL, an address that cannot be checksummed — is dropped before it reaches
 * a response. The projection is `unavailable` only when no rule URL can be
 * built either: no token address (a Provider pool row without a base token)
 * or a chain the rule does not cover.
 */

export const tokenLogoSources = Object.freeze([
  "dexscreener",
  "trustwallet",
] as const);
export type TokenLogoSource = (typeof tokenLogoSources)[number];

/** The only hosts a logo URL may name; everything else is discarded. */
export const tokenLogoAllowedHosts = Object.freeze([
  "cdn.dexscreener.com",
  "dd.dexscreener.com",
  "raw.githubusercontent.com",
] as const);

export const tokenLogoMaximumUrlLength = 512;

export const tokenLogoReasonCodes = Object.freeze({
  /** The row names no token address, so no rule URL can be formed. */
  addressUnknown: "TOKEN_LOGO_ADDRESS_UNKNOWN",
  /** The Trust Wallet rule covers BSC mainnet only. */
  chainUnsupported: "TOKEN_LOGO_CHAIN_UNSUPPORTED",
} as const);

export const trustWalletAssetsBaseUrl =
  "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain";

export type TokenLogoProjection =
  | Readonly<{
      status: "available";
      url: string;
      source: TokenLogoSource;
      /** When the URL was observed from a Provider; `null` for a rule URL. */
      observedAt: string | null;
    }>
  | Readonly<{ status: "unavailable"; reasonCode: string }>;

/** A Provider-observed image URL together with when it was observed. */
export interface ObservedLogoImage {
  readonly url: string;
  readonly observedAt: string;
}

const allowedHosts: ReadonlySet<string> = new Set(tokenLogoAllowedHosts);

/**
 * The URL itself when it is an absolute `https://` URL on an allow-listed
 * host without credentials, port, or excessive length; `null` for anything
 * else. Applied at the adapter boundary so a cache row never holds a URL
 * this codebase would not publish, and again at projection so a row cached
 * before this rule is held to the same standard.
 */
export function acceptTokenLogoUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > tokenLogoMaximumUrlLength ||
    /[\s\p{Cc}]/u.test(trimmed)
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    !allowedHosts.has(parsed.hostname)
  ) {
    return null;
  }
  const href = parsed.href;
  return href.length > tokenLogoMaximumUrlLength ? null : href;
}

/**
 * The EIP-55 mixed-case checksum form of a lowercase (or any-case) EVM
 * address. Trust Wallet keys its asset folders by this form, so the
 * lowercase address this codebase stores must be re-encoded on the way out.
 */
export function toEip55Address(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new InvalidChainIdentityError();
  }
  return getAddress(address);
}

/**
 * The Trust Wallet rule URL for a BSC mainnet asset, or `null` when the rule
 * does not cover the chain. The file is not probed.
 */
export function trustWalletLogoUrl(
  chainId: string,
  address: string | null,
): string | null {
  if (chainId !== bscChainId) {
    return null;
  }
  if (address === null) {
    return `${trustWalletAssetsBaseUrl}/info/logo.png`;
  }
  return `${trustWalletAssetsBaseUrl}/assets/${toEip55Address(address)}/logo.png`;
}

export interface ProjectTokenLogoInput {
  /** CAIP-2 chain of the asset. */
  readonly chainId: string;
  /** Lowercase token address, or `null` for the chain's native asset. */
  readonly address: string | null;
  /**
   * The image DexScreener reported on a pair whose base token is this
   * asset, if any. A proxy's image (WBNB for native BNB) must not be passed
   * here: the proxy's picture is not the asset's.
   */
  readonly providerImage?: ObservedLogoImage | null;
}

export function projectTokenLogo(
  input: ProjectTokenLogoInput,
): TokenLogoProjection {
  if (input.address !== null && !isNormalizedEvmAddress(input.address)) {
    throw new InvalidChainIdentityError();
  }
  const observed = input.providerImage ?? null;
  if (observed !== null) {
    const url = acceptTokenLogoUrl(observed.url);
    if (url !== null) {
      return Object.freeze({
        status: "available",
        url,
        source: "dexscreener",
        observedAt: observed.observedAt,
      });
    }
  }
  if (input.chainId !== bscChainId) {
    return Object.freeze({
      status: "unavailable",
      reasonCode: tokenLogoReasonCodes.chainUnsupported,
    });
  }
  const url = trustWalletLogoUrl(input.chainId, input.address);
  if (url === null) {
    return Object.freeze({
      status: "unavailable",
      reasonCode: tokenLogoReasonCodes.chainUnsupported,
    });
  }
  return Object.freeze({
    status: "available",
    url,
    source: "trustwallet",
    observedAt: null,
  });
}

/** The logo of an asset named only by its canonical `assetId`. */
export function projectTokenLogoForAssetId(
  assetId: string,
  providerImage: ObservedLogoImage | null = null,
): TokenLogoProjection {
  const parsed = decomposeAssetId(assetId);
  return projectTokenLogo({
    chainId: parsed.chainId,
    address: parsed.address,
    providerImage,
  });
}

/** The logo of a pool row that may name no base token at all. */
export function projectTokenLogoForAddress(
  chainId: string,
  address: string | null | undefined,
): TokenLogoProjection {
  if (address === null || address === undefined) {
    return Object.freeze({
      status: "unavailable",
      reasonCode: tokenLogoReasonCodes.addressUnknown,
    });
  }
  return projectTokenLogo({ chainId, address, providerImage: null });
}

/**
 * The image DexScreener reported for `tokenAddress` inside a pair list: the
 * preferred pair's image when that pair's base token is the asset, else the
 * first base pair that carries one. A pair in which the asset is only the
 * quote describes the other token's picture and is never used.
 */
export function providerImageUrlFromPairs(input: {
  readonly tokenAddress: string;
  readonly pairs: readonly TokenPairSnapshot[];
  readonly preferredPair?: TokenPairSnapshot | null;
}): string | null {
  const candidates = [
    ...(input.preferredPair === null || input.preferredPair === undefined
      ? []
      : [input.preferredPair]),
    ...input.pairs,
  ];
  for (const pair of candidates) {
    if (pair.baseTokenAddress !== input.tokenAddress) {
      continue;
    }
    const url = acceptTokenLogoUrl(pair.imageUrl);
    if (url !== null) {
      return url;
    }
  }
  return null;
}

/** `providerImageUrlFromPairs` stamped with the pair fact's observation time. */
export function observedLogoImageFromPairs(input: {
  readonly tokenAddress: string;
  readonly pairs: readonly TokenPairSnapshot[];
  readonly preferredPair?: TokenPairSnapshot | null;
  readonly observedAt: string | null;
}): ObservedLogoImage | null {
  if (input.observedAt === null) {
    return null;
  }
  const url = providerImageUrlFromPairs(input);
  return url === null
    ? null
    : Object.freeze({ url, observedAt: input.observedAt });
}

/** An already-gated URL stamped with its observation time, or `null`. */
export function observedLogoImage(
  url: string | null | undefined,
  observedAt: string | null,
): ObservedLogoImage | null {
  if (observedAt === null) {
    return null;
  }
  const accepted = acceptTokenLogoUrl(url);
  return accepted === null
    ? null
    : Object.freeze({ url: accepted, observedAt });
}
