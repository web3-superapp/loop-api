import { concat, encodePacked, keccak256, type Hex } from "viem";

/**
 * Launch allowlist Merkle tree (06 §4.1, Decision 0077).
 *
 * - Leaf: `keccak256(abi.encodePacked(address))` — the 20 address bytes,
 *   not the 32-byte ABI word, and not OpenZeppelin `StandardMerkleTree`'s
 *   double-hashed `abi.encode` leaf.
 * - Node: `keccak256(min(a, b) ‖ max(a, b))` — the commutative ("sorted
 *   pair") hashing OpenZeppelin `MerkleProof.verify` expects.
 * - Layout: leaves sorted ascending by hash and de-duplicated; each layer
 *   pairs neighbours left to right; an unpaired last node is promoted to the
 *   next layer unchanged, so its proof simply has no element at that level.
 *
 * Every value leaves this module lowercase, `0x`-prefixed.
 */

const addressPattern = /^0x[0-9a-fA-F]{40}$/;

export class InvalidAllowlistAddressError extends Error {
  readonly code = "launch_allowlist_address_invalid";

  constructor() {
    super("An allowlist entry is not a 20-byte address");
    this.name = "InvalidAllowlistAddressError";
  }
}

export function normalizeAllowlistAddress(value: string): string {
  if (!addressPattern.test(value)) {
    throw new InvalidAllowlistAddressError();
  }
  return value.toLowerCase();
}

export function allowlistLeaf(address: string): string {
  return keccak256(
    encodePacked(["address"], [normalizeAllowlistAddress(address) as Hex]),
  ).toLowerCase();
}

export function hashSortedPair(a: string, b: string): string {
  const [left, right] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concat([left as Hex, right as Hex])).toLowerCase();
}

export interface LaunchMerkleTree {
  /** 0x + 64 hex. */
  readonly root: string;
  /** Sorted, de-duplicated lowercase member addresses. */
  readonly members: readonly string[];
  readonly leafCount: number;
  /** `null` when the address is not a member. */
  proofFor(address: string): readonly string[] | null;
}

export function buildLaunchMerkleTree(
  addresses: readonly string[],
): LaunchMerkleTree {
  const members = [...new Set(addresses.map(normalizeAllowlistAddress))].sort();
  if (members.length === 0) {
    throw new RangeError("An allowlist tree needs at least one member");
  }
  const leafByAddress = new Map(
    members.map((address) => [address, allowlistLeaf(address)]),
  );
  const layers: string[][] = [[...leafByAddress.values()].sort()];
  for (;;) {
    const current = layers[layers.length - 1] as string[];
    if (current.length === 1) {
      break;
    }
    const next: string[] = [];
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index] as string;
      const right = current[index + 1];
      next.push(right === undefined ? left : hashSortedPair(left, right));
    }
    layers.push(next);
  }
  const root = (layers[layers.length - 1] as string[])[0] as string;
  return Object.freeze({
    root,
    members: Object.freeze(members),
    leafCount: members.length,
    proofFor(address: string): readonly string[] | null {
      let normalized: string;
      try {
        normalized = normalizeAllowlistAddress(address);
      } catch {
        return null;
      }
      const leaf = leafByAddress.get(normalized);
      if (leaf === undefined) {
        return null;
      }
      let index = (layers[0] as string[]).indexOf(leaf);
      const proof: string[] = [];
      for (let level = 0; level < layers.length - 1; level += 1) {
        const layer = layers[level] as string[];
        const sibling = index % 2 === 0 ? layer[index + 1] : layer[index - 1];
        if (sibling !== undefined) {
          proof.push(sibling);
        }
        index = Math.floor(index / 2);
      }
      return Object.freeze(proof);
    },
  });
}

/** OpenZeppelin `MerkleProof.processProof` with commutative hashing. */
export function verifyLaunchMerkleProof(
  root: string,
  address: string,
  proof: readonly string[],
): boolean {
  let computed = allowlistLeaf(address);
  for (const node of proof) {
    computed = hashSortedPair(computed, node);
  }
  return computed === root.toLowerCase();
}

/** Column format (Decision 0076 ruling 6): 64 hex, no `0x`. */
export function bytes32ToColumn(value: string): string {
  const lowered = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(lowered)) {
    throw new RangeError("bytes32 expected");
  }
  return lowered.slice(2);
}

export function columnToBytes32(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new RangeError("64 hex characters expected");
  }
  return `0x${value}`;
}
