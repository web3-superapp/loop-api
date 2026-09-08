import { describe, expect, it, vi } from "vitest";

import {
  createPrivyBalanceReader,
  createPrivyWalletReader,
  createUnavailablePrivyBalanceReader,
  createUnavailablePrivyWalletReader,
  parsePrivyEthereumWallets,
  PrivyWalletLookupUnavailableError,
} from "../src/integrations/privy/wallet-reader.js";

const embeddedAddress = "0x00000000000000000000000000000000000000a1";
const externalAddress = "0x00000000000000000000000000000000000000b2";

describe("Privy wallet inventory reader", () => {
  it("classifies embedded and external Ethereum wallets and lowercases addresses", () => {
    const wallets = parsePrivyEthereumWallets({
      linked_accounts: [
        { type: "email", address: "user@example.test" },
        {
          type: "wallet",
          chain_type: "ethereum",
          address: embeddedAddress.toUpperCase().replace("0X", "0x"),
          id: "wallet_privy_1",
          connector_type: "embedded",
          wallet_client_type: "privy",
        },
        {
          type: "wallet",
          chain_type: "ethereum",
          address: externalAddress,
          connector_type: "injected",
          wallet_client: "unknown",
        },
        { type: "wallet", chain_type: "solana", address: "notEvm" },
      ],
    });

    expect(wallets).toEqual([
      {
        address: embeddedAddress,
        kind: "embedded",
        providerWalletId: "wallet_privy_1",
      },
      { address: externalAddress, kind: "external", providerWalletId: null },
    ]);
  });

  it("never claims an embedded capability without a Privy wallet ID", () => {
    const wallets = parsePrivyEthereumWallets({
      linked_accounts: [
        {
          type: "wallet",
          chain_type: "ethereum",
          address: embeddedAddress,
          connector_type: "embedded",
          wallet_client_type: "privy",
          id: null,
        },
      ],
    });
    expect(wallets).toEqual([
      { address: embeddedAddress, kind: "external", providerWalletId: null },
    ]);
  });

  it("deduplicates repeated addresses and fails closed on a malformed user", () => {
    const wallets = parsePrivyEthereumWallets({
      linked_accounts: [
        {
          type: "wallet",
          chain_type: "ethereum",
          address: externalAddress,
          wallet_client: "unknown",
        },
        {
          type: "wallet",
          chain_type: "ethereum",
          address: externalAddress,
          wallet_client: "unknown",
        },
      ],
    });
    expect(wallets).toHaveLength(1);
    expect(() => parsePrivyEthereumWallets({})).toThrow(
      PrivyWalletLookupUnavailableError,
    );
  });

  it("passes the caller's abort signal to the Privy lookup", async () => {
    const _get = vi.fn(() =>
      Promise.resolve({
        linked_accounts: [
          {
            type: "wallet",
            chain_type: "ethereum",
            address: externalAddress,
            wallet_client: "unknown",
          },
        ],
      }),
    );
    const reader = createPrivyWalletReader({ _get });
    const controller = new AbortController();
    await reader.listEthereumWallets({
      privyUserId: "did:privy:user",
      signal: controller.signal,
    });
    expect(_get).toHaveBeenCalledWith("did:privy:user", {
      signal: controller.signal,
      timeout: 4_000,
      maxRetries: 0,
    });
  });

  it("reads only BSC balances and fails closed on a malformed response", async () => {
    const get = vi.fn(() =>
      Promise.resolve({
        balances: [
          {
            asset: "BNB",
            chain: "bsc",
            raw_value: "7000000000000000000",
            raw_value_decimals: 18,
            display_values: {},
          },
          {
            asset: "eth",
            chain: "ethereum",
            raw_value: "1",
            raw_value_decimals: 18,
            display_values: {},
          },
        ],
      }),
    );
    const reader = createPrivyBalanceReader({ get });
    await expect(
      reader.readBscBalances({
        providerWalletId: "wallet_privy_1",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([
      { asset: "bnb", rawValue: "7000000000000000000", decimals: 18 },
    ]);

    const broken = createPrivyBalanceReader({
      get: vi.fn(() => Promise.resolve({ balances: "nope" })),
    });
    await expect(
      broken.readBscBalances({
        providerWalletId: "wallet_privy_1",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(PrivyWalletLookupUnavailableError);
  });

  it("rejects every lookup when Privy is not configured", async () => {
    await expect(
      createUnavailablePrivyWalletReader().listEthereumWallets({
        privyUserId: "did:privy:user",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(PrivyWalletLookupUnavailableError);
    await expect(
      createUnavailablePrivyBalanceReader().readBscBalances({
        providerWalletId: "wallet_privy_1",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(PrivyWalletLookupUnavailableError);
  });
});
