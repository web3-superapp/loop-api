import { describe, expect, it } from "vitest";

import { InvalidChainIdentityError } from "../src/features/chain/chain-contract.js";
import {
  acceptTokenLogoUrl,
  observedLogoImage,
  observedLogoImageFromPairs,
  projectTokenLogo,
  projectTokenLogoForAddress,
  projectTokenLogoForAssetId,
  providerImageUrlFromPairs,
  toEip55Address,
  tokenLogoAllowedHosts,
  tokenLogoReasonCodes,
  trustWalletLogoUrl,
} from "../src/features/market/token-logo.js";
import { tokenLogoUrlPatternSource } from "../src/routes/v2/token-logo-schema.js";
import type { TokenPairSnapshot } from "../src/integrations/market/market-data-provider.js";

const trustWallet =
  "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain";
const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const wbnbChecksum = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const usdt = "0x55d398326f99059ff775485246999027b3197955";
const usdtChecksum = "0x55d398326f99059fF775485246999027B3197955";
const dexscreenerImage = `https://dd.dexscreener.com/ds-data/tokens/bsc/${wbnb}.png`;
const observedAt = "2026-09-23T08:00:00.000Z";

function pair(overrides: Partial<TokenPairSnapshot>): TokenPairSnapshot {
  return {
    pairAddress: "0x172fcd41e0913e95784454622d1c3724f546f849",
    dexId: "pancakeswap",
    labels: ["v3"],
    baseTokenAddress: wbnb,
    baseTokenSymbol: "WBNB",
    baseTokenName: "Wrapped BNB",
    quoteTokenAddress: usdt,
    quoteTokenSymbol: "USDT",
    priceUsd: "747.39",
    priceNative: null,
    liquidityUsd: "11937174.89",
    volumeH24: "219189066.89",
    priceChangeH24: "0.27",
    fdv: null,
    marketCap: null,
    buysH24: null,
    sellsH24: null,
    pairCreatedAt: null,
    imageUrl: null,
    ...overrides,
  };
}

describe("token logo (Decision 0072)", () => {
  describe("EIP-55 checksum", () => {
    it("re-encodes a lowercase address to its checksum form", () => {
      expect(toEip55Address(wbnb)).toBe(wbnbChecksum);
      expect(toEip55Address(usdt)).toBe(usdtChecksum);
    });

    it("accepts an already checksummed or upper-case address and yields the same form", () => {
      expect(toEip55Address(wbnbChecksum)).toBe(wbnbChecksum);
      expect(toEip55Address(wbnb.toUpperCase().replace("0X", "0x"))).toBe(
        wbnbChecksum,
      );
    });

    it("leaves an all-digit address unchanged and refuses a non-address", () => {
      expect(toEip55Address("0x0000000000000000000000000000000000000001")).toBe(
        "0x0000000000000000000000000000000000000001",
      );
      expect(() => toEip55Address("0x1234")).toThrow(InvalidChainIdentityError);
      expect(() => toEip55Address(`${wbnb}:4meme`)).toThrow(
        InvalidChainIdentityError,
      );
    });
  });

  describe("host allow-list", () => {
    it("names exactly the three permitted hosts", () => {
      expect([...tokenLogoAllowedHosts]).toEqual([
        "cdn.dexscreener.com",
        "dd.dexscreener.com",
        "raw.githubusercontent.com",
      ]);
    });

    it("accepts an https URL on each permitted host", () => {
      for (const host of tokenLogoAllowedHosts) {
        expect(acceptTokenLogoUrl(`https://${host}/x/y.png?size=lg`)).toBe(
          `https://${host}/x/y.png?size=lg`,
        );
      }
    });

    it("drops any other host, scheme, credentials, port, or malformed value", () => {
      for (const value of [
        "https://evil.example/logo.png",
        "https://dexscreener.com/logo.png",
        "https://dd.dexscreener.com.evil.example/logo.png",
        "https://evil.example/dd.dexscreener.com/logo.png",
        "http://dd.dexscreener.com/logo.png",
        "ftp://raw.githubusercontent.com/logo.png",
        "https://user:pw@dd.dexscreener.com/logo.png",
        "https://dd.dexscreener.com:8443/logo.png",
        "//dd.dexscreener.com/logo.png",
        "dd.dexscreener.com/logo.png",
        "javascript:alert(1)",
        "data:image/png;base64,AAAA",
        `https://dd.dexscreener.com/${"a".repeat(600)}.png`,
        "https://dd.dexscreener.com/logo one.png",
        "",
        "   ",
        null,
        undefined,
        42,
        { url: "https://dd.dexscreener.com/logo.png" },
      ]) {
        expect(acceptTokenLogoUrl(value), JSON.stringify(value)).toBeNull();
      }
    });

    it("publishes a pattern that agrees with the gate on the accepted and rejected forms", () => {
      const pattern = new RegExp(tokenLogoUrlPatternSource);
      expect(pattern.test(dexscreenerImage)).toBe(true);
      expect(
        pattern.test(`${trustWallet}/assets/${wbnbChecksum}/logo.png`),
      ).toBe(true);
      expect(pattern.test("https://evil.example/logo.png")).toBe(false);
      expect(pattern.test("http://dd.dexscreener.com/logo.png")).toBe(false);
      expect(pattern.test("https://dd.dexscreener.com.evil.example/x")).toBe(
        false,
      );
    });
  });

  describe("Trust Wallet rule", () => {
    it("builds the token and native URLs for BSC mainnet and nothing for another chain", () => {
      expect(trustWalletLogoUrl("eip155:56", wbnb)).toBe(
        `${trustWallet}/assets/${wbnbChecksum}/logo.png`,
      );
      expect(trustWalletLogoUrl("eip155:56", null)).toBe(
        `${trustWallet}/info/logo.png`,
      );
      expect(trustWalletLogoUrl("eip155:97", null)).toBeNull();
      expect(trustWalletLogoUrl("eip155:1", wbnb)).toBeNull();
    });
  });

  describe("projection", () => {
    it("prefers the Provider image and stamps its observation time", () => {
      expect(
        projectTokenLogo({
          chainId: "eip155:56",
          address: wbnb,
          providerImage: { url: dexscreenerImage, observedAt },
        }),
      ).toEqual({
        status: "available",
        url: dexscreenerImage,
        source: "dexscreener",
        observedAt,
      });
    });

    it("falls back to the rule URL without a Provider image, with observedAt null", () => {
      expect(projectTokenLogo({ chainId: "eip155:56", address: wbnb })).toEqual(
        {
          status: "available",
          url: `${trustWallet}/assets/${wbnbChecksum}/logo.png`,
          source: "trustwallet",
          observedAt: null,
        },
      );
      expect(projectTokenLogo({ chainId: "eip155:56", address: null })).toEqual(
        {
          status: "available",
          url: `${trustWallet}/info/logo.png`,
          source: "trustwallet",
          observedAt: null,
        },
      );
    });

    it("drops a Provider image off the allow-list and takes the rule URL instead", () => {
      expect(
        projectTokenLogo({
          chainId: "eip155:56",
          address: wbnb,
          providerImage: {
            url: "https://evil.example/logo.png",
            observedAt,
          },
        }),
      ).toEqual({
        status: "available",
        url: `${trustWallet}/assets/${wbnbChecksum}/logo.png`,
        source: "trustwallet",
        observedAt: null,
      });
    });

    it("is unavailable on a chain the rule does not cover, even with no image at all", () => {
      expect(projectTokenLogo({ chainId: "eip155:97", address: null })).toEqual(
        {
          status: "unavailable",
          reasonCode: tokenLogoReasonCodes.chainUnsupported,
        },
      );
      expect(projectTokenLogoForAssetId("eip155:97:native")).toEqual({
        status: "unavailable",
        reasonCode: "TOKEN_LOGO_CHAIN_UNSUPPORTED",
      });
    });

    it("still publishes a Provider image on another chain when it passes the gate", () => {
      expect(
        projectTokenLogo({
          chainId: "eip155:97",
          address: wbnb,
          providerImage: { url: dexscreenerImage, observedAt },
        }),
      ).toMatchObject({ status: "available", source: "dexscreener" });
    });

    it("is unavailable for a pool row without a base token address", () => {
      expect(projectTokenLogoForAddress("eip155:56", null)).toEqual({
        status: "unavailable",
        reasonCode: tokenLogoReasonCodes.addressUnknown,
      });
      expect(projectTokenLogoForAddress("eip155:56", wbnb)).toMatchObject({
        status: "available",
        source: "trustwallet",
      });
    });

    it("refuses a non-canonical address rather than guessing a URL", () => {
      expect(() =>
        projectTokenLogo({ chainId: "eip155:56", address: wbnbChecksum }),
      ).toThrow(InvalidChainIdentityError);
      expect(() => projectTokenLogoForAssetId("eip155:56:WBNB")).toThrow(
        InvalidChainIdentityError,
      );
    });
  });

  describe("image from a pair list", () => {
    it("takes the preferred pair's image when the asset is its base token", () => {
      const preferred = pair({ imageUrl: dexscreenerImage });
      expect(
        providerImageUrlFromPairs({
          tokenAddress: wbnb,
          pairs: [pair({ imageUrl: "https://cdn.dexscreener.com/other.png" })],
          preferredPair: preferred,
        }),
      ).toBe(dexscreenerImage);
    });

    it("never takes the image of a pair in which the asset is only the quote", () => {
      const quoteOnly = pair({
        baseTokenAddress: usdt,
        quoteTokenAddress: wbnb,
        imageUrl: dexscreenerImage,
      });
      expect(
        providerImageUrlFromPairs({
          tokenAddress: wbnb,
          pairs: [quoteOnly],
          preferredPair: quoteOnly,
        }),
      ).toBeNull();
    });

    it("scans the other base pairs when the preferred one has no admissible image", () => {
      expect(
        providerImageUrlFromPairs({
          tokenAddress: wbnb,
          pairs: [
            pair({ imageUrl: "https://evil.example/logo.png" }),
            pair({ pairAddress: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae" }),
            pair({
              pairAddress: "0x0000000000000000000000000000000000000abc",
              imageUrl: dexscreenerImage,
            }),
          ],
          preferredPair: pair({ imageUrl: null }),
        }),
      ).toBe(dexscreenerImage);
    });

    it("treats a row cached before the field existed as carrying no image", () => {
      const legacy = pair({});
      delete (legacy as { imageUrl?: string | null }).imageUrl;
      expect(
        providerImageUrlFromPairs({ tokenAddress: wbnb, pairs: [legacy] }),
      ).toBeNull();
    });

    it("stamps the observation time only when the fact was observed", () => {
      expect(
        observedLogoImageFromPairs({
          tokenAddress: wbnb,
          pairs: [pair({ imageUrl: dexscreenerImage })],
          observedAt,
        }),
      ).toEqual({ url: dexscreenerImage, observedAt });
      expect(
        observedLogoImageFromPairs({
          tokenAddress: wbnb,
          pairs: [pair({ imageUrl: dexscreenerImage })],
          observedAt: null,
        }),
      ).toBeNull();
      expect(observedLogoImage(dexscreenerImage, observedAt)).toEqual({
        url: dexscreenerImage,
        observedAt,
      });
      expect(observedLogoImage("https://evil.example/x.png", observedAt)).toBe(
        null,
      );
      expect(observedLogoImage(dexscreenerImage, null)).toBeNull();
    });
  });
});
