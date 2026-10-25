/**
 * Canonical chain, asset, and address identity for the V2 BSC surface
 * (Decision 0033).
 *
 * A CAIP-2 chain ID is `eip155:<reference>`; a CAIP-19 asset ID is
 * `<chainId>:<0x lowercase address>` for a token and `<chainId>:native` for the
 * chain's native asset. Symbols, names, and tickers are display facts only:
 * they never key a record and never appear in a request path.
 */

export const bscChainReference = 56 as const;
export const bscChainId = "eip155:56" as const;
export const bscNativeAssetId = "eip155:56:native" as const;
export const bscNativeSymbol = "BNB" as const;
export const bscNativeDecimals = 18 as const;

/**
 * BSC testnet identity (Decision 0038). It exists only as the possible target
 * of the `launch` chain slot; the `primary` slot is always `eip155:56`, and no
 * registry, market, or indexer surface describes this chain.
 */
export const bscTestnetChainReference = 97 as const;
export const bscTestnetChainId = "eip155:97" as const;
export const bscTestnetNativeAssetId = "eip155:97:native" as const;
export const bscTestnetNativeSymbol = "tBNB" as const;

/** The chains the `launch` slot may name (Decision 0038). */
export const launchChainIds = Object.freeze([
  bscChainId,
  bscTestnetChainId,
] as const);
export type LaunchChainId = (typeof launchChainIds)[number];
export const launchChainReferences = Object.freeze([
  bscChainReference,
  bscTestnetChainReference,
] as const);
export type LaunchChainReference = (typeof launchChainReferences)[number];

export function isLaunchChainId(value: unknown): value is LaunchChainId {
  return (
    typeof value === "string" &&
    (launchChainIds as readonly string[]).includes(value)
  );
}

export function launchChainReferenceFor(
  chainId: LaunchChainId,
): LaunchChainReference {
  return chainId === bscTestnetChainId
    ? bscTestnetChainReference
    : bscChainReference;
}

export function launchChainIdFor(
  reference: LaunchChainReference,
): LaunchChainId {
  return reference === bscTestnetChainReference
    ? bscTestnetChainId
    : bscChainId;
}

/**
 * Decision 0150: the exact phrase `LAUNCH_MAINNET_ACK` must equal before
 * any launch-slot action path (Hooks Factory / LoopDynamic / pool router
 * keys, the four server-signed write lanes, the MEME v2 and Mining claim
 * device-signed prepares) may run on BSC Mainnet (`LAUNCH_CHAIN_ID=56`).
 * Blank keeps every one of them closed exactly as before 0150.
 */
export const launchMainnetAckPhrase =
  "I_UNDERSTAND_THIS_IS_BSC_MAINNET_WITH_REAL_FUNDS" as const;

/** Decision 0150: the launch slot as an action path sees it. */
export interface LaunchSlotPolicy {
  readonly chainReference: LaunchChainReference;
  /** True only with `LAUNCH_CHAIN_ID=56` and the exact ack phrase. */
  readonly mainnetAcknowledged: boolean;
}

/** The pre-0150 slot every action path assumed (BSC Testnet). */
export const testnetLaunchSlot: LaunchSlotPolicy = Object.freeze({
  chainReference: bscTestnetChainReference,
  mainnetAcknowledged: false,
});

export const launchSlotReasonCodes = Object.freeze({
  /** Decision 0150: chain 56 without `LAUNCH_MAINNET_ACK`. */
  mainnetNotAcknowledged: "LAUNCH_MAINNET_NOT_ACKNOWLEDGED",
} as const);

/**
 * Decision 0150: whether a launch-slot action path may act on its slot:
 * BSC Testnet always (unchanged), BSC Mainnet only when acknowledged.
 */
export function launchSlotActionsOpen(slot: LaunchSlotPolicy): boolean {
  // The reference is 56 or 97: anything but the testnet is mainnet.
  return (
    slot.chainReference === bscTestnetChainReference || slot.mainnetAcknowledged
  );
}

/**
 * Decision 0150: the action-path check against the chain a node reports:
 * `wrong_chain` when it is not the configured slot, `not_acknowledged` for
 * an unacknowledged mainnet slot, else null.
 */
export function launchSlotRefusal(
  slot: LaunchSlotPolicy,
  observedChainReference: number,
): "wrong_chain" | "not_acknowledged" | null {
  if (observedChainReference !== slot.chainReference) return "wrong_chain";
  return launchSlotActionsOpen(slot) ? null : "not_acknowledged";
}

export function nativeSymbolForLaunchChain(
  chainId: LaunchChainId,
): typeof bscNativeSymbol | typeof bscTestnetNativeSymbol {
  return chainId === bscTestnetChainId
    ? bscTestnetNativeSymbol
    : bscNativeSymbol;
}

/**
 * Reason codes of the `launch` chain slot (Decision 0038). They are distinct
 * from the primary `BSC_*` codes so a client can never confuse "the Launch
 * testnet is unreachable" with "BSC mainnet is unreachable".
 */
export const launchChainReasonCodes = Object.freeze({
  notConfigured: "LAUNCH_CHAIN_RPC_NOT_CONFIGURED",
  verificationPending: "LAUNCH_CHAIN_VERIFICATION_PENDING",
  unreachable: "LAUNCH_CHAIN_RPC_UNREACHABLE",
  mismatched: "LAUNCH_CHAIN_ID_MISMATCH",
} as const);

export const chainIdPatternSource = "^eip155:[1-9][0-9]{0,9}$";
export const assetIdPatternSource =
  "^eip155:[1-9][0-9]{0,9}:(native|0x[0-9a-f]{40})$";
export const evmAddressPatternSource = "^0x[0-9a-f]{40}$";
export const anyCaseEvmAddressPatternSource = "^0x[0-9a-fA-F]{40}$";
export const transactionHashPatternSource = "^0x[0-9a-f]{64}$";
export const blockHashPatternSource = "^0x[0-9a-f]{64}$";
/** Canonical unsigned integer string in an asset's smallest unit. */
export const rawAmountPatternSource = "^(0|[1-9][0-9]{0,77})$";
/** Canonical non-negative decimal string; never a JavaScript number. */
export const decimalAmountPatternSource = "^(0|[1-9][0-9]{0,77})(\\.[0-9]+)?$";
export const reasonCodePatternSource = "^[A-Z][A-Z0-9_]{0,63}$";

const chainIdPattern = new RegExp(chainIdPatternSource);
const assetIdPattern = new RegExp(assetIdPatternSource);
const anyCaseAddressPattern = new RegExp(anyCaseEvmAddressPatternSource);
const lowercaseAddressPattern = new RegExp(evmAddressPatternSource);

export const assetStatuses = Object.freeze([
  "pending",
  "verified",
  "blocked",
] as const);
export type AssetStatus = (typeof assetStatuses)[number];

/**
 * `swappable` stays false until the Swap module (D15) is delivered; a registry
 * row is never evidence that an asset can be traded.
 */
export const assetCapabilityValues = Object.freeze([
  "viewable",
  "swappable",
  "temporarily_unavailable",
  "blocked",
] as const);
export type AssetCapabilityValue = (typeof assetCapabilityValues)[number];

export const walletKinds = Object.freeze(["embedded", "external"] as const);
export type WalletKind = (typeof walletKinds)[number];

/**
 * Decision 0185: an account holds at most this many active external wallets
 * (wallets linked through Privy `siwe.link`). Embedded wallets do not count.
 * A wallet Privy reports beyond the limit is archived with
 * `external_limit_exceeded`, so it never mines and never attributes trades.
 */
export const externalWalletLimit = 3;

/**
 * Decision 0185: why an `account_wallets` row is archived. `unlinked` =
 * Privy no longer reports it; `external_limit_exceeded` = over
 * `externalWalletLimit`; `address_conflict` = the address is already an
 * active wallet of another LOOP account.
 */
export const walletArchivedReasons = Object.freeze([
  "unlinked",
  "external_limit_exceeded",
  "address_conflict",
] as const);
export type WalletArchivedReason = (typeof walletArchivedReasons)[number];

export class InvalidChainIdentityError extends Error {
  readonly code = "invalid_chain_identity";

  constructor() {
    super("The chain identity value is not canonical");
    this.name = "InvalidChainIdentityError";
  }
}

export function isChainId(value: unknown): value is string {
  return typeof value === "string" && chainIdPattern.test(value);
}

export function isAssetId(value: unknown): value is string {
  return typeof value === "string" && assetIdPattern.test(value);
}

export function parseAssetId(value: unknown): string {
  if (!isAssetId(value)) {
    throw new InvalidChainIdentityError();
  }
  return value;
}

/**
 * Normalises an EVM address to its lowercase form. Mixed-case checksums are
 * accepted as input because wallets and explorers produce them, but only the
 * lowercase form is ever stored, compared, or published.
 */
export function normalizeEvmAddress(value: unknown): string {
  if (typeof value !== "string" || !anyCaseAddressPattern.test(value)) {
    throw new InvalidChainIdentityError();
  }
  return value.toLowerCase();
}

export function isNormalizedEvmAddress(value: unknown): value is string {
  return typeof value === "string" && lowercaseAddressPattern.test(value);
}

export function assetIdForAddress(chainId: string, address: string): string {
  if (!isChainId(chainId)) {
    throw new InvalidChainIdentityError();
  }
  return `${chainId}:${normalizeEvmAddress(address)}`;
}

export function nativeAssetId(chainId: string): string {
  if (!isChainId(chainId)) {
    throw new InvalidChainIdentityError();
  }
  return `${chainId}:native`;
}

export interface ParsedAssetId {
  readonly chainId: string;
  readonly reference: number;
  readonly address: string | null;
}

export function decomposeAssetId(value: unknown): ParsedAssetId {
  const assetId = parseAssetId(value);
  const lastSeparator = assetId.lastIndexOf(":");
  const chainId = assetId.slice(0, lastSeparator);
  const tail = assetId.slice(lastSeparator + 1);
  const reference = Number.parseInt(chainId.slice("eip155:".length), 10);
  if (!Number.isSafeInteger(reference) || reference <= 0) {
    throw new InvalidChainIdentityError();
  }
  return Object.freeze({
    chainId,
    reference,
    address: tail === "native" ? null : tail,
  });
}

/**
 * EIP-681 payment request for a plain native transfer target. Only the address
 * and chain ID are encoded: no amount, calldata, or Provider URL.
 */
export function eip681Uri(address: string, chainReference: number): string {
  if (!Number.isSafeInteger(chainReference) || chainReference <= 0) {
    throw new InvalidChainIdentityError();
  }
  return `ethereum:${normalizeEvmAddress(address)}@${String(chainReference)}`;
}

export function parseRawAmount(value: bigint): string {
  if (value < 0n) {
    throw new InvalidChainIdentityError();
  }
  return value.toString(10);
}

/**
 * Formats a smallest-unit integer as an exact decimal string. The conversion
 * is pure integer arithmetic: no JavaScript floating-point value is ever
 * produced for a balance, price, or amount.
 */
export function formatDecimalAmount(raw: bigint, decimals: number): string {
  if (raw < 0n) {
    throw new InvalidChainIdentityError();
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new InvalidChainIdentityError();
  }
  if (decimals === 0) {
    return raw.toString(10);
  }
  const digits = raw.toString(10).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/**
 * Parses an exact decimal string into a smallest-unit integer. It is pure
 * string arithmetic: no JavaScript floating-point value is produced, so a
 * configured amount cannot silently lose precision.
 */
export function parseDecimalAmount(value: string, decimals: number): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new InvalidChainIdentityError();
  }
  const match = /^(0|[1-9][0-9]{0,30})(?:\.([0-9]{1,36}))?$/.exec(value);
  if (match === null) {
    throw new InvalidChainIdentityError();
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new InvalidChainIdentityError();
  }
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
}

export function subtractFloorZero(left: bigint, right: bigint): bigint {
  const difference = left - right;
  return difference < 0n ? 0n : difference;
}
