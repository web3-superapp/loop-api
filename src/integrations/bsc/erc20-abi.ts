import { parseAbi, parseAbiItem } from "viem";

/**
 * The minimum ERC-20 identity surface the Asset Registry reads on chain. LOOP
 * never trusts a symbol, name, or decimals value supplied by a client or by an
 * off-chain catalogue.
 */
export const erc20IdentityAbi = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

export const erc20BalanceAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
]);

export const erc20TransferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/**
 * Allowance surface for the approvals inventory (Decision 0035). `allowance`
 * is read through Multicall3; `Approval` logs are indexed by the transfer lane
 * in the same segment as `Transfer` logs.
 */
export const erc20AllowanceAbi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
]);

export const erc20ApprovalEvent = parseAbiItem(
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
);

/**
 * The only two ERC-20 write selectors LOOP ever encodes. Arbitrary calldata
 * is never accepted from a client; every intent's `data` is produced here from
 * reviewed arguments (Decision 0035).
 */
export const erc20WriteAbi = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

/**
 * PancakeSwap V3 pool identity. A pool row is only created after these reads
 * succeed and both tokens are already in the Asset Registry.
 */
export const pancakeV3PoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);

export const pancakeV3SwapEvent = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)",
);

export const pancakeV3MintEvent = parseAbiItem(
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
);

export const pancakeV3BurnEvent = parseAbiItem(
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
);
