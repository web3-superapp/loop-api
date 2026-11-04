import type { Abi } from "viem";

import { hooksLaunchProjectTermsTupleComponents } from "../../features/launch/hooks-launch-project-terms.js";

/**
 * Decision 0199 (S359, loop-contracts Decision 0019): hand-written
 * fragments of an S359 Factory's per-launch terms surface, until the
 * generated protocol ABI (`hooks-launch-protocol-abi.generated.ts`) is
 * re-synced from the S359 build (`pnpm hooks:abi-sync`):
 *
 * - `DEFAULT_NFT_PRICE()` — the probe: answers on an S359 Factory (100e18),
 *   reverts (missing function) on older ones;
 * - the `LaunchRequest` tuple with `nftPrice` / `maxCumulativeBuy`
 *   appended (`hooksLaunchProjectTermsTupleComponents`, the alignment
 *   point) for `deployLaunch`, `previewHookInitCodeHash` and
 *   `previewLoopHookInitCodeHash`;
 * - `LaunchNftPrice(bytes32 indexed launchId, address indexed nft, uint256
 *   price)`;
 * - the module getters: `ProjectNFT.PRICE()` (kept by S359),
 *   `BuybackExecutor.orderAmount()` (S359) / `ORDER_AMOUNT()` (kept name).
 */
const launchRequestTuple = {
  name: "request",
  type: "tuple",
  components: [
    { name: "projectOwner", type: "address" },
    { name: "configVersion", type: "uint32" },
    { name: "configHash", type: "bytes32" },
    { name: "name", type: "string" },
    { name: "ticker", type: "string" },
    { name: "nftSaleStart", type: "uint64" },
    { name: "buybackRecipient", type: "address" },
    { name: "deadline", type: "uint64" },
    { name: "memeSalt", type: "bytes32" },
    ...hooksLaunchProjectTermsTupleComponents,
  ],
} as const;

export const hooksLaunchFactoryTermsAbi = [
  {
    type: "function",
    name: "DEFAULT_NFT_PRICE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "deployLaunch",
    stateMutability: "nonpayable",
    inputs: [
      launchRequestTuple,
      { name: "hookSalt", type: "bytes32" },
      { name: "projectSignature", type: "bytes" },
    ],
    outputs: [{ name: "launchId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "previewHookInitCodeHash",
    stateMutability: "view",
    inputs: [launchRequestTuple],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "previewLoopHookInitCodeHash",
    stateMutability: "view",
    inputs: [launchRequestTuple],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "event",
    name: "LaunchNftPrice",
    anonymous: false,
    inputs: [
      { name: "launchId", type: "bytes32", indexed: true },
      { name: "nft", type: "address", indexed: true },
      { name: "price", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

export const hooksLaunchModuleTermsAbi = [
  {
    type: "function",
    name: "PRICE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "orderAmount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "ORDER_AMOUNT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const satisfies Abi;
