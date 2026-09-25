/**
 * LoopLaunchpad ABI v1 (Decision 0076), transcribed from
 * `LOOP/docs/06-Launch合约接口需求.md` §3 (14 events) and §4.1/§4.2 (9
 * functions, 4 structs). `launchpad-abi.v1.json` is the published copy of
 * exactly this array; `test/launch-contract-abi.test.ts` keeps them equal.
 * Never edit v1: a 06 change is a new version file.
 */
export const launchpadAbiV1 = [
  {
    type: "event",
    name: "SaleStateChanged",
    anonymous: false,
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "fromState",
        type: "uint8",
        indexed: false,
        internalType: "uint8",
      },
      {
        name: "toState",
        type: "uint8",
        indexed: false,
        internalType: "uint8",
      },
      {
        name: "at",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
    ],
  },
  {
    type: "event",
    name: "Purchased",
    anonymous: false,
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "buyer",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "roundId",
        type: "uint16",
        indexed: false,
        internalType: "uint16",
      },
      {
        name: "usd1Amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "tokenAmount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "walletCumulativeUsd1",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "purchaseIndex",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
  },
  {
    type: "event",
    name: "SaleFinalized",
    anonymous: false,
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "outcome",
        type: "uint8",
        indexed: false,
        internalType: "uint8",
      },
      {
        name: "totalRaisedUsd1",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "totalTokensSold",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
  },
  {
    type: "event",
    name: "BudgetsFrozen",
    anonymous: false,
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "usd1ToLiquidity",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "tokenToLiquidity",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "usd1ToProject",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "protocolFeeUsd1",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
  },
  {
    type: "event",
    name: "RefundLiabilityFrozen",
    anonymous: false,
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "wallet",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "usd1Amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
  },
  {
    type: "event",
    name: "Refunded",
    anonymous: false,
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "wallet",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "usd1Amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "cumulativeRefunded",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
  },
  {
    type: "event",
    name: "VestingScheduleCreated",
    anonymous: false,
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "tgeBps",
        type: "uint16",
        indexed: false,
        internalType: "uint16",
      },
      {
        name: "cliffSeconds",
        type: "uint32",
        indexed: false,
        internalType: "uint32",
      },
      {
        name: "durationSeconds",
        type: "uint32",
        indexed: false,
        internalType: "uint32",
      },
      {
        name: "tgeAt",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    anonymous: false,
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "wallet",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "tokenAmount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "cumulativeClaimed",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
  },
  {
    type: "event",
    name: "PoolPrepared",
    anonymous: false,
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "pool",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "feeTier",
        type: "uint24",
        indexed: false,
        internalType: "uint24",
      },
      {
        name: "initialSqrtPriceX96",
        type: "uint160",
        indexed: false,
        internalType: "uint160",
      },
      {
        name: "tickLower",
        type: "int24",
        indexed: false,
        internalType: "int24",
      },
      {
        name: "tickUpper",
        type: "int24",
        indexed: false,
        internalType: "int24",
      },
    ],
  },
  {
    type: "event",
    name: "LiquidityAdded",
    anonymous: false,
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "pool",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "lpTokenId",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "usd1Amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "tokenAmount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
  },
  {
    type: "event",
    name: "LPNFTLocked",
    anonymous: false,
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "locker",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "lpTokenId",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "unlockAt",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
    ],
  },
  {
    type: "event",
    name: "LiquidityRetryScheduled",
    anonymous: false,
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "reasonCode",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
      {
        name: "retryAfter",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
    ],
  },
  {
    type: "event",
    name: "Paused",
    anonymous: false,
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "by",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
  },
  {
    type: "event",
    name: "Unpaused",
    anonymous: false,
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "by",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
  },
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "roundId",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "usd1Amount",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "minTokenAmount",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "deadline",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "eligibilityProof",
        type: "bytes32[]",
        internalType: "bytes32[]",
      },
    ],
    outputs: [
      {
        name: "tokenAmount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "tokenAmount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "claimRefund",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "usd1Amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "getState",
    stateMutability: "view",
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          {
            name: "saleState",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "entitlementState",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "liquidityState",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "operationalState",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "configVersion",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "stateTupleDigest",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
        internalType: "struct LoopLaunchpad.State",
      },
    ],
  },
  {
    type: "function",
    name: "getRounds",
    stateMutability: "view",
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          {
            name: "roundId",
            type: "uint16",
            internalType: "uint16",
          },
          {
            name: "startAt",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "endAt",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "priceUsd1PerToken",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "roundCapUsd1",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "walletRoundCapUsd1",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "allowlistRoot",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "raisedUsd1",
            type: "uint256",
            internalType: "uint256",
          },
        ],
        internalType: "struct LoopLaunchpad.Round[]",
      },
    ],
  },
  {
    type: "function",
    name: "getSaleConfig",
    stateMutability: "view",
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          {
            name: "projectToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "usd1",
            type: "address",
            internalType: "address",
          },
          {
            name: "softCapUsd1",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "hardCapUsd1",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "walletProjectCapUsd1",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "minPurchaseUsd1",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "protocolFeeBps",
            type: "uint16",
            internalType: "uint16",
          },
          {
            name: "liquidityBps",
            type: "uint16",
            internalType: "uint16",
          },
          {
            name: "tgeBps",
            type: "uint16",
            internalType: "uint16",
          },
          {
            name: "cliffSeconds",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "vestingSeconds",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "poolFeeTier",
            type: "uint24",
            internalType: "uint24",
          },
          {
            name: "lpLockSeconds",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "configVersion",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
        internalType: "struct LoopLaunchpad.SaleConfig",
      },
    ],
  },
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "roundId",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "usd1Amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "tokenAmount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "getPosition",
    stateMutability: "view",
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "wallet",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          {
            name: "cumulativeUsd1",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "purchasedTokens",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "entitledTokens",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "claimableTokens",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "claimedTokens",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "refundableUsd1",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "refundedUsd1",
            type: "uint256",
            internalType: "uint256",
          },
        ],
        internalType: "struct LoopLaunchpad.Position",
      },
    ],
  },
  {
    type: "function",
    name: "getRoundPosition",
    stateMutability: "view",
    inputs: [
      {
        name: "saleId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "roundId",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "wallet",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "cumulativeUsd1",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
] as const;
