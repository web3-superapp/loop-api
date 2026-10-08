import { randomBytes } from "node:crypto";

import { keccak256, type Hex } from "viem";

/**
 * Offline CREATE2 prediction of a LoopMemeToken clone (Decision 0101).
 *
 * `LoopMemeCurve.createToken` deploys `Clones.cloneDeterministic(impl, salt)`
 * (OpenZeppelin 5.6), whose creation code is the 55-byte EIP-1167 minimal
 * proxy with the implementation address embedded. The address is
 * `keccak256(0xff ++ deployer ++ salt ++ keccak256(initCode))[12:]` with the
 * curve as deployer. Pure computation: it never reads the chain.
 */

const eip1167Prefix = "3d602d80600a3d3981f3363d3d373d3d3d363d73";
const eip1167Suffix = "5af43d82803e903d91602b57fd5bf3";
const addressPattern = /^0x[0-9a-f]{40}$/u;
const bytes32Pattern = /^0x[0-9a-f]{64}$/u;

function bareAddress(value: string, field: string): string {
  const lower = value.toLowerCase();
  if (!addressPattern.test(lower)) {
    throw new RangeError(`${field} must be a 20-byte address`);
  }
  return lower.slice(2);
}

/** keccak256 of the EIP-1167 creation code for `implementation`. */
export function memeCloneInitCodeHash(implementation: string): Hex {
  return keccak256(
    `0x${eip1167Prefix}${bareAddress(implementation, "implementation")}${eip1167Suffix}`,
  );
}

/** Lowercase 0x + 40 hex address of the clone `salt` deploys. */
export function predictMemeTokenAddress(input: {
  readonly deployer: string;
  readonly implementation: string;
  readonly salt: string;
  /** Precomputed `memeCloneInitCodeHash(implementation)` for a hot loop. */
  readonly initCodeHash?: Hex;
}): string {
  const salt = input.salt.toLowerCase();
  if (!bytes32Pattern.test(salt)) {
    throw new RangeError("salt must be bytes32");
  }
  const initCodeHash = (
    input.initCodeHash ?? memeCloneInitCodeHash(input.implementation)
  ).slice(2);
  const digest = keccak256(
    `0xff${bareAddress(input.deployer, "deployer")}${salt.slice(2)}${initCodeHash}`,
  );
  return `0x${digest.slice(-40)}`;
}

export interface MinedMemeSalt {
  readonly salt: string;
  readonly predictedAddress: string;
}

/**
 * Draws random salts until `count` predicted addresses end in `suffix`
 * (lowercase hex) or `maximumAttempts` is spent. A 4-hex suffix needs
 * 65,536 draws per hit on average. The hot loop hashes one preallocated
 * 85-byte buffer (`0xff ++ deployer ++ salt ++ initCodeHash`) per draw.
 */
export function mineMemeSalts(input: {
  readonly deployer: string;
  readonly implementation: string;
  readonly suffix: string;
  readonly count: number;
  readonly maximumAttempts: number;
  readonly random?: (bytes: number) => Buffer;
}): readonly MinedMemeSalt[] {
  const suffix = input.suffix.toLowerCase();
  if (!/^[0-9a-f]{0,8}$/u.test(suffix)) {
    throw new RangeError("suffix must be 0-8 hex characters");
  }
  const random = input.random ?? randomBytes;
  const initCodeHash = memeCloneInitCodeHash(input.implementation);
  const buffer = Buffer.alloc(85);
  buffer[0] = 0xff;
  Buffer.from(bareAddress(input.deployer, "deployer"), "hex").copy(buffer, 1);
  Buffer.from(initCodeHash.slice(2), "hex").copy(buffer, 53);
  const found: MinedMemeSalt[] = [];
  for (
    let attempt = 0;
    attempt < input.maximumAttempts && found.length < input.count;
    attempt += 1
  ) {
    random(32).copy(buffer, 21);
    const digest = Buffer.from(keccak256(buffer, "bytes"));
    const tail = digest.subarray(32 - Math.ceil(suffix.length / 2));
    if (tail.toString("hex").endsWith(suffix)) {
      const salt = `0x${buffer.subarray(21, 53).toString("hex")}`;
      found.push(
        Object.freeze({
          salt,
          predictedAddress: `0x${digest.subarray(12).toString("hex")}`,
        }),
      );
    }
  }
  return Object.freeze(found);
}

/** A fresh random salt (no vanity suffix) and its predicted address. */
export function randomMemeSalt(input: {
  readonly deployer: string;
  readonly implementation: string;
  readonly random?: (bytes: number) => Buffer;
}): MinedMemeSalt {
  const salt = `0x${(input.random ?? randomBytes)(32).toString("hex")}`;
  return Object.freeze({
    salt,
    predictedAddress: predictMemeTokenAddress({
      deployer: input.deployer,
      implementation: input.implementation,
      salt,
    }),
  });
}
