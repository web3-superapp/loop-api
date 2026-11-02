import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Hex,
} from "viem";

import {
  isNormalizedEvmAddress,
  normalizeEvmAddress,
} from "../../features/chain/chain-contract.js";
import { InvalidTransactionArgumentError, maxUint256 } from "./tx-builder.js";

/**
 * Decision 0194 (S339): the ERC-721 surface of a LOOP Launch project NFT
 * send. The server encodes `safeTransferFrom(from, to, tokenId)` itself from
 * the reviewed arguments and reads `ownerOf(tokenId)` before it builds
 * anything; the client never supplies calldata.
 */
export const erc721SendAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
]);

/** `safeTransferFrom(address,address,uint256)`. */
export const erc721SafeTransferFromSelector = "0x42842e0e" as const;

function requireTokenId(value: bigint): bigint {
  if (value < 0n || value > maxUint256) {
    throw new InvalidTransactionArgumentError();
  }
  return value;
}

function requireAddress(value: string): `0x${string}` {
  if (!isNormalizedEvmAddress(value)) {
    throw new InvalidTransactionArgumentError();
  }
  return getAddress(value);
}

export function encodeErc721OwnerOf(tokenId: bigint): Hex {
  return encodeFunctionData({
    abi: erc721SendAbi,
    functionName: "ownerOf",
    args: [requireTokenId(tokenId)],
  });
}

/** The lowercase owner `ownerOf` returned, or null when it is not decodable. */
export function decodeErc721OwnerOf(returnData: Hex): string | null {
  try {
    const owner = decodeFunctionResult({
      abi: erc721SendAbi,
      functionName: "ownerOf",
      data: returnData,
    });
    return normalizeEvmAddress(owner);
  } catch {
    return null;
  }
}

export interface BuiltErc721Transfer {
  /** Lowercase NFT contract. */
  readonly to: string;
  readonly data: Hex;
  readonly value: 0n;
}

export function buildErc721SafeTransfer(input: {
  readonly contract: string;
  readonly from: string;
  readonly to: string;
  readonly tokenId: bigint;
}): BuiltErc721Transfer {
  const contract = requireAddress(input.contract);
  return Object.freeze({
    to: contract.toLowerCase(),
    data: encodeFunctionData({
      abi: erc721SendAbi,
      functionName: "safeTransferFrom",
      args: [
        requireAddress(input.from),
        requireAddress(input.to),
        requireTokenId(input.tokenId),
      ],
    }),
    value: 0n,
  });
}

export interface DecodedErc721SafeTransfer {
  readonly from: string;
  readonly to: string;
  readonly tokenId: bigint;
}

/** Decodes exactly `safeTransferFrom(address,address,uint256)`; anything else throws. */
export function decodeErc721SafeTransfer(data: Hex): DecodedErc721SafeTransfer {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: erc721SendAbi, data });
  } catch {
    throw new InvalidTransactionArgumentError();
  }
  if (decoded.functionName !== "safeTransferFrom") {
    throw new InvalidTransactionArgumentError();
  }
  const [from, to, tokenId] = decoded.args;
  return Object.freeze({
    from: normalizeEvmAddress(from),
    to: normalizeEvmAddress(to),
    tokenId,
  });
}
