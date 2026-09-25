import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";

import {
  allowlistLeaf,
  buildLaunchMerkleTree,
  bytes32ToColumn,
  columnToBytes32,
  verifyLaunchMerkleProof,
} from "../src/features/launch/launch-merkle.js";

/**
 * Decision 0077 Merkle tree. The reference below is written independently
 * of the module: leaves hashed from raw bytes (no encodePacked helper),
 * a recursive tree over the sorted leaves, and OpenZeppelin's
 * `MerkleProof.processProof` loop with `Hashes.commutativeKeccak256`.
 * `@openzeppelin/merkle-tree`'s StandardMerkleTree is not used: its leaf is
 * keccak256(keccak256(abi.encode(...))), not keccak256(abi.encodePacked(address)).
 */

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.slice(2);
  return Uint8Array.from(
    Array.from({ length: clean.length / 2 }, (_, index) =>
      Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16),
    ),
  );
}

function referenceLeaf(address: string): string {
  // abi.encodePacked(address) is exactly the 20 address bytes.
  return keccak256(hexToBytes(address.toLowerCase())).toLowerCase();
}

function referencePair(a: string, b: string): string {
  const [x, y] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return keccak256(
    new Uint8Array([...hexToBytes(x), ...hexToBytes(y)]),
  ).toLowerCase();
}

function referenceRoot(leaves: readonly string[]): string {
  if (leaves.length === 1) {
    return leaves[0] as string;
  }
  const next: string[] = [];
  for (let index = 0; index < leaves.length; index += 2) {
    const right = leaves[index + 1];
    next.push(
      right === undefined
        ? (leaves[index] as string)
        : referencePair(leaves[index] as string, right),
    );
  }
  return referenceRoot(next);
}

function ozProcessProof(leaf: string, proof: readonly string[]): string {
  let computed = leaf;
  for (const node of proof) {
    computed = referencePair(computed, node);
  }
  return computed;
}

function address(n: number): string {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

describe("Launch allowlist Merkle tree (Decision 0077)", () => {
  it("hashes the leaf as keccak256(abi.encodePacked(address)) — known vector", () => {
    // keccak256 of twenty zero bytes, the packed encoding of address(0).
    expect(allowlistLeaf(address(0))).toBe(
      "0x5380c7b7ae81a58eb98d9c78de4a1fd7fd9535fc953ed2be602daaa41767312a",
    );
    expect(allowlistLeaf("0xAbCdEf0000000000000000000000000000000001")).toBe(
      referenceLeaf("0xabcdef0000000000000000000000000000000001"),
    );
  });

  it("a single member is its own root with an empty proof", () => {
    const tree = buildLaunchMerkleTree([address(7)]);
    expect(tree.root).toBe(referenceLeaf(address(7)));
    expect(tree.proofFor(address(7))).toEqual([]);
    expect(verifyLaunchMerkleProof(tree.root, address(7), [])).toBe(true);
  });

  it("two members: root = keccak256(sorted(leafA, leafB))", () => {
    const tree = buildLaunchMerkleTree([address(2), address(1)]);
    expect(tree.root).toBe(
      referencePair(referenceLeaf(address(1)), referenceLeaf(address(2))),
    );
    expect(tree.proofFor(address(1))).toEqual([referenceLeaf(address(2))]);
  });

  it("matches the independent reference and OpenZeppelin verification for 1..40 members", () => {
    for (let size = 1; size <= 40; size += 1) {
      const members = Array.from({ length: size }, (_, index) =>
        address(0x1000 + index * 7919),
      );
      const tree = buildLaunchMerkleTree([...members].reverse());
      const sortedLeaves = members.map(referenceLeaf).sort();
      expect(tree.root, `size ${String(size)}`).toBe(
        referenceRoot(sortedLeaves),
      );
      for (const member of members) {
        const proof = tree.proofFor(member);
        expect(proof).not.toBeNull();
        expect(ozProcessProof(referenceLeaf(member), proof ?? [])).toBe(
          tree.root,
        );
        expect(verifyLaunchMerkleProof(tree.root, member, proof ?? [])).toBe(
          true,
        );
      }
      expect(tree.proofFor(address(3))).toBeNull();
    }
  });

  it("de-duplicates, lowercases, refuses a malformed address, and rejects a foreign proof", () => {
    const upper = "0xABCDEF0000000000000000000000000000000002";
    const tree = buildLaunchMerkleTree([
      upper,
      upper.toLowerCase(),
      address(9),
    ]);
    expect(tree.members).toEqual([address(9), upper.toLowerCase()].sort());
    expect(tree.leafCount).toBe(2);
    expect(() => buildLaunchMerkleTree(["0x1234"])).toThrow();
    expect(() => buildLaunchMerkleTree([])).toThrow(RangeError);
    const proof = tree.proofFor(address(9)) ?? [];
    expect(verifyLaunchMerkleProof(tree.root, address(10), proof)).toBe(false);
  });

  it("converts digests between the column (no 0x) and wire (0x) formats once", () => {
    const wire = `0x${"Ab".repeat(32)}`;
    expect(bytes32ToColumn(wire)).toBe("ab".repeat(32));
    expect(columnToBytes32("ab".repeat(32))).toBe(wire.toLowerCase());
    expect(() => bytes32ToColumn("0x12")).toThrow(RangeError);
    expect(() => columnToBytes32(`0x${"ab".repeat(32)}`)).toThrow(RangeError);
  });
});
