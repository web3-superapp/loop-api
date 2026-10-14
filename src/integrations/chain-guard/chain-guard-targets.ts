import { privateKeyToAccount } from "viem/accounts";

import type { ChainGuardConfig } from "../../config.js";
import type { ChainGuardTargets } from "../../features/chain-guard/chain-guard-collect.js";

/**
 * Decision 0134: the chain guard's static targets. The signer accounts are
 * the addresses of the keys this process is configured with (executor,
 * buyback keeper, snapshot submitter, poke keeper), derived locally; a key
 * never leaves this function and is never logged.
 */

const keyPattern = /^(0x)?[0-9a-fA-F]{64}$/u;

export function chainGuardSignerAccounts(
  keys: readonly {
    readonly label: string;
    readonly privateKey: string | null | undefined;
  }[],
): { readonly address: string; readonly label: string }[] {
  const accounts: { address: string; label: string }[] = [];
  for (const entry of keys) {
    const key = entry.privateKey?.trim() ?? "";
    if (!keyPattern.test(key)) continue;
    const normalized = (
      key.startsWith("0x") ? key : `0x${key}`
    ) as `0x${string}`;
    accounts.push({
      address: privateKeyToAccount(normalized).address.toLowerCase(),
      label: entry.label,
    });
  }
  return accounts;
}

export function chainGuardTargets(input: {
  readonly config: ChainGuardConfig;
  readonly chainId: string;
  readonly chainReference: number;
  readonly signers: readonly {
    readonly address: string;
    readonly label: string;
  }[];
}): ChainGuardTargets {
  return Object.freeze({
    chainId: input.chainId,
    chainReference: input.chainReference,
    usd1Address: input.config.usd1Address,
    factories: input.config.factories,
    poolManagerAddress: input.config.poolManagerAddress,
    poolRouterAddress: input.config.poolRouterAddress,
    watch: input.config.watch,
    balanceAccounts: Object.freeze([
      ...input.signers,
      ...input.config.balanceAccounts,
    ]),
  });
}
