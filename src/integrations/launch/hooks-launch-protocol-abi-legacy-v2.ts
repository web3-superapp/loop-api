/**
 * Decision 0122: the BuybackExecutor ABI of the **v2 Factory generation**
 * (price-protected buyback; loop-contracts `bf9f170`, BSC Testnet Factory
 * `0x6A69…D9c0`). Frozen copy of what `pnpm hooks:abi-sync` generated from
 * that build before S144 removed the price protection; it is the only way to
 * decode the old `BuybackCompleted(usd1Spent, memeDelivered, minMemeOut,
 * referencePrice, spotPrice)` logs and the three-value `quoteNextOrder()` of
 * instances deployed by that Factory. Never edited: `test/launch2-generation.test.ts`
 * pins its event topic and function selectors. The current generation lives
 * in `hooks-launch-protocol-abi.generated.ts`.
 */
export const legacyV2BuybackExecutorAbi = [
  {
    type: "function",
    name: "MIN_SUCCESS_INTERVAL",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ORDER_AMOUNT",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "budget",
    inputs: [],
    outputs: [
      { name: "", type: "address", internalType: "contract INftBuybackBudget" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "execute",
    inputs: [],
    outputs: [
      { name: "memeDelivered", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "fallbackKeeper",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "lastSuccessfulAt",
    inputs: [],
    outputs: [{ name: "", type: "uint64", internalType: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "meme",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "contract IERC20" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pause",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "pauseAuthority",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "paused",
    inputs: [],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "primaryKeeper",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "quoteNextOrder",
    inputs: [],
    outputs: [
      { name: "amountIn", type: "uint256", internalType: "uint256" },
      { name: "expectedNetOut", type: "uint256", internalType: "uint256" },
      { name: "minMemeOut", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "recipient",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "resumeAuthority",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "swapAdapter",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract IOfficialPoolBuyAdapter",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "usd1",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "contract IERC20" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "BuybackCompleted",
    inputs: [
      {
        name: "usd1Spent",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "memeDelivered",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "minMemeOut",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "referencePrice",
        type: "uint192",
        indexed: false,
        internalType: "uint192",
      },
      {
        name: "spotPrice",
        type: "uint192",
        indexed: false,
        internalType: "uint192",
      },
      {
        name: "successfulAt",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "BuybackPausedEvent",
    inputs: [
      {
        name: "authority",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "timestamp",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "BuybackResumed",
    inputs: [
      {
        name: "authority",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "timestamp",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
    ],
    anonymous: false,
  },
  { type: "error", name: "BuybackPaused", inputs: [] },
  { type: "error", name: "InvalidConfiguration", inputs: [] },
  { type: "error", name: "LaunchNotGraduated", inputs: [] },
  { type: "error", name: "LockedPrincipalInsufficient", inputs: [] },
  { type: "error", name: "NoBudget", inputs: [] },
  { type: "error", name: "OutputBelowProtection", inputs: [] },
  { type: "error", name: "PartialFill", inputs: [] },
  { type: "error", name: "RecipientBalanceMismatch", inputs: [] },
  { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
  { type: "error", name: "ReferenceUnavailable", inputs: [] },
  {
    type: "error",
    name: "SafeERC20FailedOperation",
    inputs: [{ name: "token", type: "address", internalType: "address" }],
  },
  { type: "error", name: "SpotOutsideProtection", inputs: [] },
  { type: "error", name: "TooSoon", inputs: [] },
  { type: "error", name: "Unauthorized", inputs: [] },
] as const;
