import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddress,
  type Address,
  type Hex,
} from "viem";

import {
  isNormalizedEvmAddress,
  normalizeEvmAddress,
} from "../../features/chain/chain-contract.js";
import { erc20WriteAbi } from "./erc20-abi.js";

/**
 * Exact calldata construction for the three write shapes LOOP supports
 * (Decision 0035): a native transfer, an ERC-20 `transfer`, and an ERC-20
 * `approve`. The client never supplies calldata, a destination contract, or a
 * spender that the server has not itself encoded from reviewed arguments; a
 * decoded projection of the same bytes is what the approval guard displays.
 */

export const maxUint256 = (1n << 256n) - 1n;

export class InvalidTransactionArgumentError extends Error {
  readonly code = "invalid_transaction_argument";

  constructor() {
    super("The transaction argument is not canonical");
    this.name = "InvalidTransactionArgumentError";
  }
}

export interface BuiltCall {
  /** Lowercase destination address (recipient or token contract). */
  readonly to: string;
  /** Hex calldata, `0x` for a plain native transfer. */
  readonly data: Hex;
  /** Native value in wei. */
  readonly value: bigint;
}

function requireAmount(value: bigint): bigint {
  if (value < 0n || value > maxUint256) {
    throw new InvalidTransactionArgumentError();
  }
  return value;
}

function requireAddress(value: string): Address {
  if (!isNormalizedEvmAddress(value)) {
    throw new InvalidTransactionArgumentError();
  }
  return value as Address;
}

export function buildNativeTransfer(input: {
  readonly to: string;
  readonly value: bigint;
}): BuiltCall {
  const to = requireAddress(input.to);
  return Object.freeze({
    to,
    data: "0x",
    value: requireAmount(input.value),
  });
}

export function buildErc20Transfer(input: {
  readonly token: string;
  readonly to: string;
  readonly value: bigint;
}): BuiltCall {
  const token = requireAddress(input.token);
  const to = requireAddress(input.to);
  return Object.freeze({
    to: token,
    data: encodeFunctionData({
      abi: erc20WriteAbi,
      functionName: "transfer",
      args: [getAddress(to), requireAmount(input.value)],
    }),
    value: 0n,
  });
}

export function buildErc20Approve(input: {
  readonly token: string;
  readonly spender: string;
  readonly value: bigint;
}): BuiltCall {
  const token = requireAddress(input.token);
  const spender = requireAddress(input.spender);
  return Object.freeze({
    to: token,
    data: encodeFunctionData({
      abi: erc20WriteAbi,
      functionName: "approve",
      args: [getAddress(spender), requireAmount(input.value)],
    }),
    value: 0n,
  });
}

export type DecodedErc20Call =
  | {
      readonly functionName: "transfer";
      readonly to: string;
      readonly value: bigint;
    }
  | {
      readonly functionName: "approve";
      readonly spender: string;
      readonly value: bigint;
      readonly isUnlimited: boolean;
    };

/**
 * Decodes calldata back into the reviewed arguments. Anything that is not
 * exactly one of the two supported selectors is rejected rather than shown as
 * an opaque blob.
 */
export function decodeErc20Call(data: Hex): DecodedErc20Call {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: erc20WriteAbi, data });
  } catch {
    throw new InvalidTransactionArgumentError();
  }
  if (decoded.functionName === "transfer") {
    const [to, value] = decoded.args;
    return Object.freeze({
      functionName: "transfer" as const,
      to: normalizeEvmAddress(to),
      value,
    });
  }
  const [spender, value] = decoded.args;
  return Object.freeze({
    functionName: "approve" as const,
    spender: normalizeEvmAddress(spender),
    value,
    isUnlimited: value === maxUint256,
  });
}

/**
 * EIP-55 checksum of an address for display. The lowercase form remains the
 * only stored and compared representation.
 */
export function checksumAddress(value: string): string {
  if (!isAddress(value, { strict: false })) {
    throw new InvalidTransactionArgumentError();
  }
  return getAddress(value);
}

/**
 * Accepts a user-entered address. A mixed-case value must be a valid EIP-55
 * checksum: a typo in a checksummed address is refused, never normalised.
 */
export function parseRecipientAddress(value: unknown): string {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new InvalidTransactionArgumentError();
  }
  const hasUpper = /[A-F]/.test(value.slice(2));
  const hasLower = /[a-f]/.test(value.slice(2));
  if (hasUpper && hasLower && !isAddress(value, { strict: true })) {
    throw new InvalidTransactionArgumentError();
  }
  return normalizeEvmAddress(value);
}

export function toHexQuantity(value: bigint): Hex {
  if (value < 0n) {
    throw new InvalidTransactionArgumentError();
  }
  return `0x${value.toString(16)}`;
}

export function fromHexQuantity(value: string): bigint {
  if (!/^0x(0|[1-9a-f][0-9a-f]*)$/.test(value)) {
    throw new InvalidTransactionArgumentError();
  }
  return BigInt(value);
}
