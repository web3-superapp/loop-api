/**
 * Decision 0152: the LoopDynamic / curve ABI items of the **pre-S209
 * generation** (loop-contracts `528b5c7` and earlier; BSC Testnet
 * LoopDynamic Factory `0xd05E…8c4D` and older). Frozen copy of what
 * `pnpm hooks:abi-sync` generated from `b325c3f` before loop-contracts
 * Decision 0015 moved the 2 % buy fee to the USD1 input and made the curve
 * purchase cap a Factory parameter. Instances deployed by those Factories
 * keep emitting / answering these:
 *
 * - `BuyFeeCharged(address indexed buyer, uint256 grossMeme, uint256 fee)`
 *   (topic0 `0x123655f5…6dfc`, fee in MEME); the current generation's
 *   `BuyFeeCharged(uint256 indexed round, address indexed buyer, uint256
 *   grossQuote, uint256 fee)` (USD1) has another topic0, so both decode
 *   side by side and the argument names tell them apart;
 * - `CurveEngine.MAX_CUMULATIVE_BUY()` (selector `0xe358ee7c`), the
 *   constant 5,000,000 MEME cap; S209 curves answer `maxCumulativeBuy()`.
 *
 * Never edited: `test/launch2-s209-generation.test.ts` pins the topic and
 * the selector. The current generation lives in
 * `hooks-launch-protocol-abi.generated.ts`.
 */
export const legacyS200LoopDynamicHookAbi = [
  {
    type: "event",
    name: "BuyFeeCharged",
    inputs: [
      {
        name: "buyer",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "grossMeme",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      { name: "fee", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
] as const;

export const legacyS200CurveEngineAbi = [
  {
    type: "function",
    name: "MAX_CUMULATIVE_BUY",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
] as const;
