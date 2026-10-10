import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
  numberToHex,
} from "viem";

import { hooksLaunchTemplateHash } from "./hooks-launch-config.js";

const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const hookPermissionMask = 0x3fffn;
const requiredHookPermissionBits = 0x20ccn;

export const hooksLaunchDeploymentTypes = {
  LaunchRequest: [
    { name: "configHash", type: "bytes32" },
    { name: "projectOwner", type: "address" },
    { name: "configVersion", type: "uint32" },
    { name: "name", type: "string" },
    { name: "ticker", type: "string" },
    { name: "nftSaleStart", type: "uint64" },
    { name: "buybackRecipient", type: "address" },
    { name: "deadline", type: "uint64" },
    { name: "memeSalt", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "templateHash", type: "bytes32" },
  ],
} as const;

/**
 * Decision 0120: the standard EIP-712 domain type for the four fields the
 * `LOOP Launch Factory` domain uses, in the order EIP-712 fixes. The
 * signing-request response lists it in `typedData.types` so a wallet that
 * treats a missing `EIP712Domain` as an empty struct hashes the same domain
 * separator; the digest is unchanged (it is what every EIP-712 library
 * derives from the domain object anyway).
 */
export const hooksLaunchEip712DomainType = Object.freeze([
  Object.freeze({ name: "name", type: "string" }),
  Object.freeze({ name: "version", type: "string" }),
  Object.freeze({ name: "chainId", type: "uint256" }),
  Object.freeze({ name: "verifyingContract", type: "address" }),
] as const);

/** The typed data as handed to a wallet: `types` include `EIP712Domain`. */
export function withHooksLaunchEip712Domain<
  T extends { readonly types: Readonly<Record<string, unknown>> },
>(typedData: T) {
  return Object.freeze({
    ...typedData,
    types: Object.freeze({
      EIP712Domain: hooksLaunchEip712DomainType,
      ...typedData.types,
    }),
  });
}

export function hooksLaunchDeploymentDomain(
  chainId: number,
  verifyingContract: string,
) {
  if (
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !addressPattern.test(verifyingContract)
  ) {
    throw new Error("Invalid Hooks launch signing domain");
  }
  return Object.freeze({
    name: "LOOP Launch Factory",
    version: "1",
    chainId,
    verifyingContract: verifyingContract as Address,
  });
}

export interface HooksLaunchTypedRequestInput {
  readonly configHash: string;
  readonly projectOwner: string;
  readonly configVersion: number;
  readonly name: string;
  readonly ticker: string;
  readonly nftSaleStart: string;
  readonly buybackRecipient: string;
  readonly deadline: string;
  readonly memeSalt: string;
  readonly nonce: string;
}

export function createHooksLaunchDeploymentTypedData(input: {
  readonly chainId: number;
  readonly verifyingContract: string;
  readonly request: HooksLaunchTypedRequestInput;
}) {
  const { request } = input;
  const uint64Max = (1n << 64n) - 1n;
  const uint256Max = (1n << 256n) - 1n;
  if (
    !bytes32Pattern.test(request.configHash) ||
    !addressPattern.test(request.projectOwner) ||
    !Number.isSafeInteger(request.configVersion) ||
    request.configVersion < 1 ||
    request.configVersion > 0xffff_ffff ||
    request.name.length === 0 ||
    request.name.length > 64 ||
    !/^[A-Z0-9]{2,12}$/.test(request.ticker) ||
    !addressPattern.test(request.buybackRecipient) ||
    !/^(0|[1-9][0-9]*)$/.test(request.nftSaleStart) ||
    !/^(0|[1-9][0-9]*)$/.test(request.deadline) ||
    !bytes32Pattern.test(request.memeSalt) ||
    !/^(0|[1-9][0-9]*)$/.test(request.nonce)
  ) {
    throw new Error("Invalid Hooks launch signing request");
  }
  const start = BigInt(request.nftSaleStart);
  const deadline = BigInt(request.deadline);
  const nonce = BigInt(request.nonce);
  if (start > uint64Max || deadline > uint64Max || nonce > uint256Max) {
    throw new Error("Hooks launch signing value out of range");
  }

  return Object.freeze({
    domain: hooksLaunchDeploymentDomain(input.chainId, input.verifyingContract),
    types: hooksLaunchDeploymentTypes,
    primaryType: "LaunchRequest" as const,
    message: Object.freeze({
      configHash: request.configHash as Hex,
      projectOwner: request.projectOwner as Address,
      configVersion: request.configVersion,
      name: request.name,
      ticker: request.ticker,
      nftSaleStart: request.nftSaleStart,
      buybackRecipient: request.buybackRecipient as Address,
      deadline: request.deadline,
      memeSalt: request.memeSalt as Hex,
      nonce: request.nonce,
      templateHash: hooksLaunchTemplateHash,
    }),
  });
}

/** Mine a user-facing salt for the project token address; the CREATE2 salt is
 * additionally bound to the immutable launch ID to prevent cross-project reuse. */
function* searchMemeAddressSalt(input: {
  readonly deployer: string;
  readonly launchId: string;
  readonly initCodeHash: string;
  readonly maxAttempts: number;
}): Generator<void, { readonly salt: Hex; readonly address: Address }, void> {
  if (
    !addressPattern.test(input.deployer) ||
    !bytes32Pattern.test(input.launchId) ||
    !bytes32Pattern.test(input.initCodeHash) ||
    !Number.isSafeInteger(input.maxAttempts) ||
    input.maxAttempts < 1 ||
    input.maxAttempts > 10_000_000
  ) {
    throw new Error("Invalid MEME vanity salt search input");
  }
  const deployer = input.deployer.toLowerCase().slice(2);
  const launchId = input.launchId as Hex;
  const initCodeHash = input.initCodeHash as Hex;
  const create2Prefix = `0xff${deployer}` as Hex;
  for (let attempt = 0; attempt < input.maxAttempts; attempt += 1) {
    if (attempt % 256 === 0) yield;
    const vanitySalt = numberToHex(BigInt(attempt), { size: 32 });
    const salt = keccak256(concatHex([launchId, vanitySalt]));
    const digest = keccak256(concatHex([create2Prefix, salt, initCodeHash]));
    if (digest.endsWith("6666")) {
      return Object.freeze({
        salt: vanitySalt,
        address: `0x${digest.slice(-40)}`,
      });
    }
  }
  throw new Error("Unable to mine MEME 6666 address within search budget");
}

export function hooksLaunchId(input: {
  readonly chainId: number;
  readonly factory: string;
  readonly projectOwner: string;
  readonly configVersion: number;
  readonly configHash: string;
}): Hex {
  if (
    !Number.isSafeInteger(input.chainId) ||
    input.chainId <= 0 ||
    !addressPattern.test(input.factory) ||
    !addressPattern.test(input.projectOwner) ||
    !Number.isSafeInteger(input.configVersion) ||
    input.configVersion < 1 ||
    input.configVersion > 0xffff_ffff ||
    !bytes32Pattern.test(input.configHash)
  ) {
    throw new Error("Invalid Hooks launch ID input");
  }
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint32" },
        { type: "bytes32" },
      ],
      [
        BigInt(input.chainId),
        input.factory as Address,
        input.projectOwner as Address,
        input.configVersion,
        input.configHash as Hex,
      ],
    ),
  );
}

function* searchHooksLaunchSalt(input: {
  readonly deployer: string;
  readonly initCodeHash: string;
  readonly maxAttempts: number;
}): Generator<void, Hex, void> {
  if (
    !addressPattern.test(input.deployer) ||
    !bytes32Pattern.test(input.initCodeHash) ||
    !Number.isSafeInteger(input.maxAttempts) ||
    input.maxAttempts < 1 ||
    input.maxAttempts > 10_000_000
  ) {
    throw new Error("Invalid Hook salt search input");
  }
  const deployer = input.deployer.toLowerCase().slice(2);
  const initCodeHash = input.initCodeHash as Hex;
  const create2Prefix = `0xff${deployer}` as Hex;
  for (let attempt = 0; attempt < input.maxAttempts; attempt += 1) {
    if (attempt % 256 === 0) yield;
    const salt = numberToHex(BigInt(attempt), { size: 32 });
    const digest = keccak256(concatHex([create2Prefix, salt, initCodeHash]));
    if (
      (BigInt(`0x${digest.slice(-4)}`) & hookPermissionMask) ===
      requiredHookPermissionBits
    ) {
      return salt;
    }
  }
  throw new Error("Unable to mine Hook permission salt within search budget");
}

function drainSearch<T>(search: Generator<void, T, void>): T {
  let step = search.next();
  while (!step.done) step = search.next();
  return step.value;
}

async function drainSearchAsync<T>(
  search: Generator<void, T, void>,
): Promise<T> {
  let step = search.next();
  while (!step.done) {
    await yieldToEventLoop();
    step = search.next();
  }
  return step.value;
}

export function mineMemeAddressSalt(
  input: Parameters<typeof searchMemeAddressSalt>[0],
) {
  return drainSearch(searchMemeAddressSalt(input));
}

export function mineHooksLaunchSalt(
  input: Parameters<typeof searchHooksLaunchSalt>[0],
) {
  return drainSearch(searchHooksLaunchSalt(input));
}

/** Server variants yield every 256 attempts; synchronous tools share the exact math. */
export function mineMemeAddressSaltAsync(
  input: Parameters<typeof searchMemeAddressSalt>[0],
) {
  return drainSearchAsync(searchMemeAddressSalt(input));
}

export function mineHooksLaunchSaltAsync(
  input: Parameters<typeof searchHooksLaunchSalt>[0],
) {
  return drainSearchAsync(searchHooksLaunchSalt(input));
}
