import {
  decodeFunctionData,
  parseAbi,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Hex,
} from "viem";

import { launchpadAbiV1 } from "../../integrations/launch/launchpad-abi.v1.js";
import {
  curveEngineAbi,
  loopDynamicHookAbi,
  loopDynamicLaunchFactoryAbi,
  loopLaunchFactoryAbi,
  loopRouterAbi,
  loopRouterRegistryAbi,
  memeTokenAbi,
  nftEscrowAbi,
  officialPoolRouterAbi,
  projectNFTAbi,
} from "../../integrations/launch/hooks-launch-protocol-abi.generated.js";
import type {
  DappCallStandard,
  DappDecodedCall,
  DappRiskFlag,
} from "./intent-contract.js";

/**
 * Decision 0197 (S342): decode the calldata a DApp page asked the wallet to
 * send. Pure: the service supplies whether the target is an ERC-721 (an
 * ERC-165 probe) and whether it is a LOOP-known contract.
 *
 * - ERC-20 transfer / approve / increaseAllowance / transferFrom, ERC-721
 *   approve / transferFrom / safeTransferFrom (both overloads) /
 *   setApprovalForAll and Permit2 approve are decoded by selector for every
 *   target.
 * - LOOP contract methods (LoopRouter, the official pool router, the
 *   launch2 Factory / curve / NFT / hook / escrow, the Launch v1
 *   launchpad) are decoded only when the target is a LOOP-known contract,
 *   so a foreign contract that happens to share a selector is never given
 *   a LOOP name.
 * - Anything else: `functionName: null`, the selector, and the length.
 */

/** Canonical Permit2 (Uniswap), the same address on every EVM chain. */
export const permit2Address = "0x000000000022d473030f116ddee9f6b43ac78ba3";

/**
 * An approval amount at or above 2^128 is "effectively unlimited" for the
 * risk flag (no token's supply comes close; it covers uint256 max, uint160
 * max of Permit2 and the 2^255 floor the approve intent uses).
 */
export const dappUnlimitedApprovalFloor = 1n << 128n;

const maximumArgs = 16;
const maximumArgLength = 512;

const erc20Abi = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function transferFrom(address from, address to, uint256 amount)",
]);

const erc721Abi = parseAbi([
  "function approve(address to, uint256 tokenId)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
  "function setApprovalForAll(address operator, bool approved)",
]);

const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

export const erc165SupportsInterfaceData =
  // supportsInterface(0x80ac58cd) — the ERC-721 interface ID.
  "0x01ffc9a780ac58cd00000000000000000000000000000000000000000000000000000000" as const;

const selectors = Object.freeze({
  transfer: "0xa9059cbb",
  approve: "0x095ea7b3",
  increaseAllowance: "0x39509351",
  transferFrom: "0x23b872dd",
  safeTransferFrom: "0x42842e0e",
  safeTransferFromWithData: "0xb88d4fde",
  setApprovalForAll: "0xa22cb465",
  permit2Approve: "0x87517c45",
} as const);

/** Selectors whose decoding depends on whether the target is an ERC-721. */
export function needsErc721Probe(data: string): boolean {
  const selector = data.slice(0, 10).toLowerCase();
  return selector === selectors.approve || selector === selectors.transferFrom;
}

const loopAbis: readonly Abi[] = [
  loopRouterAbi,
  officialPoolRouterAbi,
  curveEngineAbi,
  projectNFTAbi,
  loopDynamicLaunchFactoryAbi,
  loopLaunchFactoryAbi,
  loopRouterRegistryAbi,
  loopDynamicHookAbi,
  nftEscrowAbi,
  memeTokenAbi,
  launchpadAbiV1,
];

/** selector → the first LOOP ABI function that has it (priority order). */
const loopFunctions: ReadonlyMap<string, AbiFunction> = (() => {
  const map = new Map<string, AbiFunction>();
  for (const abi of loopAbis) {
    for (const item of abi) {
      if (item.type !== "function") continue;
      if (item.stateMutability === "view" || item.stateMutability === "pure") {
        continue;
      }
      const selector = toFunctionSelector(item).toLowerCase();
      if (!map.has(selector)) map.set(selector, item);
    }
  }
  return map;
})();

function truncate(value: string): string {
  return value.length <= maximumArgLength
    ? value
    : value.slice(0, maximumArgLength);
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "string") return value.toLowerCase();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]),
    );
  }
  return value;
}

function formatArg(value: unknown): string {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return truncate(value.toLowerCase());
  return truncate(JSON.stringify(jsonSafe(value)));
}

function namedArgs(
  inputs: readonly AbiParameter[],
  values: readonly unknown[],
): Record<string, string> {
  const args: Record<string, string> = {};
  inputs.slice(0, maximumArgs).forEach((input, index) => {
    const name =
      input.name === undefined || input.name === "" || input.name in args
        ? `arg${String(index)}`
        : input.name;
    args[name] = formatArg(values[index]);
  });
  return args;
}

function decodeWith(
  abi: Abi,
  data: Hex,
): { readonly fn: AbiFunction; readonly values: readonly unknown[] } | null {
  try {
    const decoded = decodeFunctionData({ abi, data });
    const selector = data.slice(0, 10).toLowerCase();
    const fn = abi.find(
      (item): item is AbiFunction =>
        item.type === "function" &&
        item.name === decoded.functionName &&
        toFunctionSelector(item).toLowerCase() === selector,
    );
    if (fn === undefined) return null;
    return { fn, values: decoded.args ?? [] };
  } catch {
    return null;
  }
}

export interface DecodedDappCall {
  readonly call: DappDecodedCall;
  /** The address the call grants an allowance to / sends to, when decoded. */
  readonly counterparty: {
    readonly role: "spender" | "operator" | "recipient";
    readonly address: string;
  } | null;
  /** Flags derivable from the calldata alone. */
  readonly flags: readonly DappRiskFlag[];
}

function result(
  data: Hex,
  standard: DappCallStandard | null,
  fn: AbiFunction | null,
  values: readonly unknown[],
  counterparty: DecodedDappCall["counterparty"],
  flags: readonly DappRiskFlag[],
): DecodedDappCall {
  const dataLength = (data.length - 2) / 2;
  return Object.freeze({
    call: Object.freeze({
      functionName: fn?.name ?? null,
      selector: dataLength >= 4 ? data.slice(0, 10).toLowerCase() : null,
      standard,
      args: Object.freeze(fn === null ? {} : namedArgs(fn.inputs, values)),
      dataLength,
    }),
    counterparty,
    flags: Object.freeze([...flags]),
  });
}

function addressArg(value: unknown): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

export function decodeDappCall(input: {
  readonly data: Hex;
  readonly to: string;
  /** ERC-165 said the target is an ERC-721 (approve / transferFrom). */
  readonly targetIsErc721: boolean;
  /** The target is a LOOP-known contract. */
  readonly targetIsLoop: boolean;
}): DecodedDappCall {
  const data = input.data.toLowerCase() as Hex;
  if (data.length < 10) {
    return result(data, null, null, [], null, []);
  }
  const selector = data.slice(0, 10);
  const target = input.to.toLowerCase();

  if (selector === selectors.permit2Approve && target === permit2Address) {
    const decoded = decodeWith(permit2Abi, data);
    if (decoded !== null) {
      const amount = decoded.values[2] as bigint;
      const spender = addressArg(decoded.values[1]);
      return result(
        data,
        "permit2",
        decoded.fn,
        decoded.values,
        spender === null ? null : { role: "spender", address: spender },
        amount >= dappUnlimitedApprovalFloor ? ["UNLIMITED_APPROVAL"] : [],
      );
    }
  }

  if (
    selector === selectors.setApprovalForAll ||
    selector === selectors.safeTransferFrom ||
    selector === selectors.safeTransferFromWithData ||
    (input.targetIsErc721 &&
      (selector === selectors.approve || selector === selectors.transferFrom))
  ) {
    const decoded = decodeWith(erc721Abi, data);
    if (decoded !== null) {
      const name = decoded.fn.name;
      if (name === "setApprovalForAll") {
        const operator = addressArg(decoded.values[0]);
        return result(
          data,
          "erc721",
          decoded.fn,
          decoded.values,
          operator === null ? null : { role: "operator", address: operator },
          decoded.values[1] === true ? ["APPROVAL_FOR_ALL"] : [],
        );
      }
      if (name === "approve") {
        const spender = addressArg(decoded.values[0]);
        return result(
          data,
          "erc721",
          decoded.fn,
          decoded.values,
          spender === null ? null : { role: "spender", address: spender },
          [],
        );
      }
      const recipient = addressArg(decoded.values[1]);
      return result(
        data,
        "erc721",
        decoded.fn,
        decoded.values,
        recipient === null ? null : { role: "recipient", address: recipient },
        [],
      );
    }
  }

  if (
    selector === selectors.transfer ||
    selector === selectors.approve ||
    selector === selectors.increaseAllowance ||
    selector === selectors.transferFrom
  ) {
    const decoded = decodeWith(erc20Abi, data);
    if (decoded !== null) {
      const name = decoded.fn.name;
      if (name === "approve" || name === "increaseAllowance") {
        const spender = addressArg(decoded.values[0]);
        const amount = decoded.values[1] as bigint;
        return result(
          data,
          "erc20",
          decoded.fn,
          decoded.values,
          spender === null ? null : { role: "spender", address: spender },
          amount >= dappUnlimitedApprovalFloor ? ["UNLIMITED_APPROVAL"] : [],
        );
      }
      const recipient = addressArg(
        name === "transfer" ? decoded.values[0] : decoded.values[1],
      );
      return result(
        data,
        "erc20",
        decoded.fn,
        decoded.values,
        recipient === null ? null : { role: "recipient", address: recipient },
        [],
      );
    }
  }

  if (input.targetIsLoop) {
    const fn = loopFunctions.get(selector);
    if (fn !== undefined) {
      const decoded = decodeWith([fn], data);
      if (decoded !== null) {
        return result(data, "loop", decoded.fn, decoded.values, null, []);
      }
    }
  }

  return result(data, null, null, [], null, []);
}

/** True when the ERC-165 probe's return data says "supported". */
export function erc165Supported(returnData: string): boolean {
  return (
    returnData.length === 66 &&
    BigInt(returnData === "0x" ? "0x0" : returnData) === 1n
  );
}

/** Fixed display order of the risk flags. */
const flagOrder: readonly DappRiskFlag[] = [
  "UNLIMITED_APPROVAL",
  "APPROVAL_FOR_ALL",
  "PERMIT_SIGNATURE",
  "UNVERIFIED_CONTRACT",
  "SIMULATION_FAILED",
];

export function orderRiskFlags(
  flags: Iterable<DappRiskFlag>,
): readonly DappRiskFlag[] {
  const set = new Set(flags);
  return Object.freeze(flagOrder.filter((flag) => set.has(flag)));
}
