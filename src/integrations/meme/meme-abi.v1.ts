/**
 * LoopMemeCurve ABI v1 (Decision 0101): the ABI loop-contracts delivered in
 * `abi/LoopMemeCurve.abi.json` (S115, loop-contracts 37cb992, contract
 * version 1.0.0), which implements docs/10 §3 plus the residual events and
 * functions of loop-contracts Decision 0001 §3. `meme-abi.v1.json` is the
 * published copy of exactly this array; `test/meme-contract-abi.test.ts`
 * keeps them equal. Never edit v1: a contract change is a new version file.
 */
export const memeCurveAbiV1 = [
  {
    inputs: [
      {
        internalType: "address",
        name: "initialOwner",
        type: "address",
      },
      {
        internalType: "contract IERC20",
        name: "usd1_",
        type: "address",
      },
      {
        internalType: "address",
        name: "treasury_",
        type: "address",
      },
      {
        internalType: "contract INonfungiblePositionManager",
        name: "positionManager_",
        type: "address",
      },
      {
        internalType: "address",
        name: "tokenImplementation_",
        type: "address",
      },
    ],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    inputs: [],
    name: "BelowMinBuy",
    type: "error",
  },
  {
    inputs: [],
    name: "CurveFull",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "uint8",
        name: "status",
        type: "uint8",
      },
    ],
    name: "CurveNotTrading",
    type: "error",
  },
  {
    inputs: [],
    name: "Expired",
    type: "error",
  },
  {
    inputs: [],
    name: "FailedDeployment",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "uint256",
        name: "balance",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "needed",
        type: "uint256",
      },
    ],
    name: "InsufficientBalance",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "string",
        name: "what",
        type: "string",
      },
    ],
    name: "InvalidConfig",
    type: "error",
  },
  {
    inputs: [],
    name: "NoResidual",
    type: "error",
  },
  {
    inputs: [],
    name: "NotFull",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "owner",
        type: "address",
      },
    ],
    name: "OwnableInvalidOwner",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "account",
        type: "address",
      },
    ],
    name: "OwnableUnauthorizedAccount",
    type: "error",
  },
  {
    inputs: [],
    name: "ReentrancyGuardReentrantCall",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "token",
        type: "address",
      },
    ],
    name: "SafeERC20FailedOperation",
    type: "error",
  },
  {
    inputs: [],
    name: "SaltUsed",
    type: "error",
  },
  {
    inputs: [],
    name: "SameBlockRoundTrip",
    type: "error",
  },
  {
    inputs: [],
    name: "Slippage",
    type: "error",
  },
  {
    inputs: [],
    name: "TokenUnknown",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "uint256",
        name: "cap",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "wouldHold",
        type: "uint256",
      },
    ],
    name: "WalletCapExceeded",
    type: "error",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "realUsd1",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint64",
        name: "at",
        type: "uint64",
      },
    ],
    name: "CurveFull",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "pool",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "usd1ToPool",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "tokensToPool",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "lpTokenId",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "feeUsd1",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint64",
        name: "at",
        type: "uint64",
      },
    ],
    name: "Graduated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "usd1Left",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "tokensLeft",
        type: "uint256",
      },
    ],
    name: "GraduationResidual",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "previousOwner",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "newOwner",
        type: "address",
      },
    ],
    name: "OwnershipTransferStarted",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "previousOwner",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "newOwner",
        type: "address",
      },
    ],
    name: "OwnershipTransferred",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "by",
        type: "address",
      },
    ],
    name: "Paused",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "pool",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "usd1ToPool",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "tokensToPool",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "lpTokenId",
        type: "uint256",
      },
    ],
    name: "ResidualInjected",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "creator",
        type: "address",
      },
      {
        indexed: false,
        internalType: "bytes32",
        name: "salt",
        type: "bytes32",
      },
      {
        indexed: false,
        internalType: "bytes32",
        name: "metadataHash",
        type: "bytes32",
      },
      {
        indexed: false,
        internalType: "string",
        name: "name",
        type: "string",
      },
      {
        indexed: false,
        internalType: "string",
        name: "symbol",
        type: "string",
      },
      {
        indexed: false,
        internalType: "uint64",
        name: "at",
        type: "uint64",
      },
    ],
    name: "TokenCreated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "wallet",
        type: "address",
      },
      {
        indexed: false,
        internalType: "bool",
        name: "isBuy",
        type: "bool",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "usd1Amount",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "tokenAmount",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "feeUsd1",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "vUsd1After",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "vTokenAfter",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "soldAfter",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint64",
        name: "at",
        type: "uint64",
      },
    ],
    name: "Trade",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: "address",
        name: "from",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "to",
        type: "address",
      },
    ],
    name: "TreasuryChanged",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "by",
        type: "address",
      },
    ],
    name: "Unpaused",
    type: "event",
  },
  {
    inputs: [],
    name: "CONTRACT_VERSION",
    outputs: [
      {
        internalType: "string",
        name: "",
        type: "string",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "acceptOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "usd1In",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "minTokensOut",
        type: "uint256",
      },
      {
        internalType: "uint64",
        name: "deadline",
        type: "uint64",
      },
    ],
    name: "buy",
    outputs: [
      {
        internalType: "uint256",
        name: "tokensOut",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "refundUsd1",
        type: "uint256",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "bytes32",
        name: "salt",
        type: "bytes32",
      },
      {
        internalType: "string",
        name: "name",
        type: "string",
      },
      {
        internalType: "string",
        name: "symbol",
        type: "string",
      },
      {
        internalType: "bytes32",
        name: "metadataHash",
        type: "bytes32",
      },
      {
        internalType: "uint256",
        name: "initialBuyUsd1",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "minTokensOut",
        type: "uint256",
      },
    ],
    name: "createToken",
    outputs: [
      {
        internalType: "address",
        name: "token",
        type: "address",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "token",
        type: "address",
      },
    ],
    name: "getCurve",
    outputs: [
      {
        components: [
          {
            internalType: "uint256",
            name: "vUsd1",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "vToken",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "realUsd1",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "sold",
            type: "uint256",
          },
          {
            internalType: "uint64",
            name: "createdAt",
            type: "uint64",
          },
          {
            internalType: "address",
            name: "creator",
            type: "address",
          },
          {
            internalType: "uint8",
            name: "status",
            type: "uint8",
          },
          {
            internalType: "address",
            name: "pool",
            type: "address",
          },
          {
            internalType: "uint64",
            name: "graduatedAt",
            type: "uint64",
          },
        ],
        internalType: "struct LoopMemeCurve.CurveState",
        name: "s",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "token",
        type: "address",
      },
    ],
    name: "getResidual",
    outputs: [
      {
        internalType: "uint256",
        name: "usd1Left",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "tokensLeft",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "token",
        type: "address",
      },
    ],
    name: "graduate",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        internalType: "int24",
        name: "tickLower",
        type: "int24",
      },
      {
        internalType: "int24",
        name: "tickUpper",
        type: "int24",
      },
    ],
    name: "injectResidual",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "params",
    outputs: [
      {
        internalType: "uint256",
        name: "v0",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "t0",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "saleSupply",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "poolSupply",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "tradeFeeBps",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "graduationFeeUsd1",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "walletCapBps",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "minBuyUsd1",
        type: "uint256",
      },
      {
        internalType: "uint24",
        name: "poolFee",
        type: "uint24",
      },
      {
        internalType: "address",
        name: "usd1Address",
        type: "address",
      },
      {
        internalType: "address",
        name: "treasuryAddress",
        type: "address",
      },
      {
        internalType: "address",
        name: "positionManagerAddress",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "token",
        type: "address",
      },
    ],
    name: "pause",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "pendingOwner",
    outputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "positionManager",
    outputs: [
      {
        internalType: "contract INonfungiblePositionManager",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "bytes32",
        name: "salt",
        type: "bytes32",
      },
    ],
    name: "predictTokenAddress",
    outputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "usd1In",
        type: "uint256",
      },
    ],
    name: "quoteBuy",
    outputs: [
      {
        internalType: "uint256",
        name: "tokensOut",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "fee",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "refund",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "tokensIn",
        type: "uint256",
      },
    ],
    name: "quoteSell",
    outputs: [
      {
        internalType: "uint256",
        name: "usd1Out",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "fee",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "renounceOwnership",
    outputs: [],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "tokensIn",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "minUsd1Out",
        type: "uint256",
      },
      {
        internalType: "uint64",
        name: "deadline",
        type: "uint64",
      },
    ],
    name: "sell",
    outputs: [
      {
        internalType: "uint256",
        name: "usd1Out",
        type: "uint256",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "newTreasury",
        type: "address",
      },
    ],
    name: "setTreasury",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "tokenImplementation",
    outputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "newOwner",
        type: "address",
      },
    ],
    name: "transferOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "treasury",
    outputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "token",
        type: "address",
      },
    ],
    name: "unpause",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "usd1",
    outputs: [
      {
        internalType: "contract IERC20",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;
