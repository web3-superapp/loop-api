/**
 * Decision 0137 (S179-api): the escrow exit-path items of loop-contracts S175
 * (`feat/S175-escrow-exit` 24d6f41, Decision 0011), copied verbatim from that
 * Foundry build (`protocol/out/<Contract>.sol/<Contract>.json`, `abi`). They
 * live apart from the generated module on purpose: S175 is not on
 * loop-contracts main yet (pending the requirer), `pnpm hooks:abi-sync` and
 * its check read main, and the testnet Factories in use have none of these
 * functions — every reader probes `LoopLaunchFactory.snapshotTimeout()` first
 * and treats a revert as "no exit paths" (fail closed). Once S175 merges the
 * items move into the generated selection and this file goes away.
 */

export const launch2ExitFactoryAbi = [
  {
    type: "function",
    name: "snapshotTimeout",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "refundDelay",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "view",
  },
] as const;

export const launch2ExitSnapshotRegistryAbi = [
  {
    type: "function",
    name: "snapshotTimeout",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "snapshotTimeoutAt",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "openedAfterTimeout",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "openedWithoutSnapshot",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "openPublicAfterTimeout",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "PublicRoundOpenedAfterTimeout",
    inputs: [
      {
        name: "launchId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "openedAt",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
      {
        name: "openedBlock",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
      {
        name: "totalMinted",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "SnapshotNotReady",
    inputs: [],
  },
  {
    type: "error",
    name: "SnapshotAlreadyPublished",
    inputs: [],
  },
] as const;

export const launch2ExitNftEscrowAbi = [
  {
    type: "function",
    name: "refundDelay",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "refundOpensAt",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "refundedCount",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "refunded",
    inputs: [
      {
        name: "tokenId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "refundQuote",
    inputs: [
      {
        name: "tokenId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "claimable",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "opensAt",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "claimRefund",
    inputs: [
      {
        name: "tokenId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "RefundClaimed",
    inputs: [
      {
        name: "tokenId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "owner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "remainingRecorded",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "Unauthorized",
    inputs: [],
  },
  {
    type: "error",
    name: "RefundNotOpen",
    inputs: [],
  },
  {
    type: "error",
    name: "AlreadyGraduated",
    inputs: [],
  },
  {
    type: "error",
    name: "AlreadyRefunded",
    inputs: [],
  },
  {
    type: "error",
    name: "NothingToRefund",
    inputs: [],
  },
  {
    type: "error",
    name: "InexactUsd1Transfer",
    inputs: [],
  },
  {
    type: "error",
    name: "ERC721NonexistentToken",
    inputs: [
      {
        name: "tokenId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
] as const;

export const launch2ExitProjectNftAbi = [
  {
    type: "function",
    name: "ownerOf",
    inputs: [
      {
        name: "tokenId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
] as const;
