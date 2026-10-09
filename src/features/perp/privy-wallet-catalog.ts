import { z } from "zod";

const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;

const userEnvelopeSchema = z
  .object({
    id: z.string().min(1).max(255),
    linked_accounts: z.array(z.unknown()).max(256),
  })
  .passthrough();

const eligibleWalletSchema = z
  .object({
    type: z.literal("wallet"),
    chain_type: z.literal("ethereum"),
    wallet_client_type: z.literal("privy"),
    connector_type: z.literal("embedded"),
    id: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\x21-\x7e]+$/)
      .nullable(),
    address: z.string().regex(evmAddressPattern),
  })
  .passthrough();

export interface PrivyEmbeddedEthereumWallet {
  readonly walletId: string | null;
  readonly accountAddress: string;
  readonly accountKind: "master";
}

export class PrivyWalletCatalogUnavailableError extends Error {
  constructor() {
    super("The Privy wallet catalog is unavailable");
    this.name = "PrivyWalletCatalogUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePrivyEmbeddedEthereumWallets(
  value: unknown,
  expectedPrivyUserId: string,
): readonly PrivyEmbeddedEthereumWallet[] {
  const user = userEnvelopeSchema.safeParse(value);
  if (!user.success || user.data.id !== expectedPrivyUserId) {
    throw new PrivyWalletCatalogUnavailableError();
  }

  const wallets: PrivyEmbeddedEthereumWallet[] = [];
  const addresses = new Set<string>();
  const walletIds = new Set<string>();

  for (const account of user.data.linked_accounts) {
    if (!isRecord(account)) {
      throw new PrivyWalletCatalogUnavailableError();
    }
    if (
      account["type"] !== "wallet" ||
      account["chain_type"] !== "ethereum" ||
      account["wallet_client_type"] !== "privy" ||
      account["connector_type"] !== "embedded"
    ) {
      continue;
    }

    const parsed = eligibleWalletSchema.safeParse(account);
    if (!parsed.success) {
      throw new PrivyWalletCatalogUnavailableError();
    }

    const accountAddress = parsed.data.address.toLowerCase();
    if (accountAddress === zeroAddress) {
      throw new PrivyWalletCatalogUnavailableError();
    }
    if (
      addresses.has(accountAddress) ||
      (parsed.data.id !== null && walletIds.has(parsed.data.id))
    ) {
      throw new PrivyWalletCatalogUnavailableError();
    }

    addresses.add(accountAddress);
    if (parsed.data.id !== null) {
      walletIds.add(parsed.data.id);
    }
    wallets.push(
      Object.freeze({
        walletId: parsed.data.id,
        accountAddress,
        accountKind: "master" as const,
      }),
    );
  }

  return Object.freeze(wallets);
}

export function findExactPrivyWallet(
  wallets: readonly PrivyEmbeddedEthereumWallet[],
  selection: {
    readonly walletId: string | null;
    readonly accountAddress: string;
  },
): PrivyEmbeddedEthereumWallet | null {
  const matches = wallets.filter(
    (wallet) =>
      wallet.accountAddress === selection.accountAddress &&
      (selection.walletId === null || wallet.walletId === selection.walletId),
  );
  if (matches.length > 1) {
    throw new PrivyWalletCatalogUnavailableError();
  }
  return matches[0] ?? null;
}
