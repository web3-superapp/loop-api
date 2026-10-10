import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

/**
 * Decision 0116 / docs/16 §6: the EIP-712 claim voucher `LoopRewardClaim`
 * verifies. Domain name `LoopRewardClaim`, version `1`, the chain id, and
 * the contract address; type
 * `Claim(address wallet,uint256 cumulativeAmount,uint256 nonce,uint256 deadline)`.
 * The key never leaves this module and is never logged.
 */

export const miningClaimTypes = Object.freeze({
  Claim: [
    { name: "wallet", type: "address" },
    { name: "cumulativeAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const);

export interface MiningClaimVoucher {
  readonly wallet: `0x${string}`;
  readonly cumulativeAmount: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

export interface MiningClaimSigner {
  readonly address: string;
  sign(input: {
    readonly chainId: number;
    readonly contract: `0x${string}`;
    readonly voucher: MiningClaimVoucher;
  }): Promise<Hex>;
}

export function miningClaimDomain(chainId: number, contract: `0x${string}`) {
  return Object.freeze({
    name: "LoopRewardClaim",
    version: "1",
    chainId,
    verifyingContract: contract,
  });
}

export function createMiningClaimSigner(
  privateKey: `0x${string}`,
): MiningClaimSigner {
  const account = privateKeyToAccount(privateKey);
  return Object.freeze<MiningClaimSigner>({
    address: account.address.toLowerCase(),
    sign: (input) =>
      account.signTypedData({
        domain: miningClaimDomain(input.chainId, input.contract),
        types: miningClaimTypes,
        primaryType: "Claim",
        message: {
          wallet: input.voucher.wallet,
          cumulativeAmount: input.voucher.cumulativeAmount,
          nonce: input.voucher.nonce,
          deadline: input.voucher.deadline,
        },
      }),
  });
}
