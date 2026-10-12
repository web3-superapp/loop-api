/**
 * Decision 0128: the testnet faucet contract — reason codes, the grant
 * record, and the two ports (PostgreSQL grants, the BSC Testnet operator
 * chain). Nothing here signs or reads a chain.
 */

export const testnetFaucetCapabilityId = "testnetFaucet" as const;

export const testnetFaucetReasonCodes = Object.freeze({
  disabled: "TESTNET_FAUCET_DISABLED",
  wrongChain: "TESTNET_FAUCET_WRONG_CHAIN",
  operatorNotConfigured: "TESTNET_FAUCET_OPERATOR_NOT_CONFIGURED",
  usd1NotConfigured: "TESTNET_FAUCET_USD1_NOT_CONFIGURED",
  rpcNotConfigured: "TESTNET_FAUCET_RPC_NOT_CONFIGURED",
  runtimeUnavailable: "TESTNET_FAUCET_RUNTIME_UNAVAILABLE",
  operatorLow: "TESTNET_FAUCET_OPERATOR_LOW",
  usd1Unavailable: "TESTNET_FAUCET_USD1_UNAVAILABLE",
  chainReadFailed: "TESTNET_FAUCET_CHAIN_READ_FAILED",
  busy: "TESTNET_FAUCET_BUSY",
  walletNotOwned: "TESTNET_FAUCET_WALLET_NOT_OWNED",
  cooldown: "TESTNET_FAUCET_COOLDOWN",
  inFlight: "TESTNET_FAUCET_IN_FLIGHT",
  partial: "TESTNET_FAUCET_PARTIAL",
  transferFailed: "TESTNET_FAUCET_TRANSFER_FAILED",
  submissionUnknown: "TESTNET_FAUCET_SUBMISSION_UNKNOWN",
} as const);

export type TestnetFaucetReasonCode =
  (typeof testnetFaucetReasonCodes)[keyof typeof testnetFaucetReasonCodes];

export const testnetFaucetGrantStatuses = Object.freeze([
  "pending",
  "granted",
  "partial",
  "unknown",
  "failed",
] as const);

export type TestnetFaucetGrantStatus =
  (typeof testnetFaucetGrantStatuses)[number];

export interface TestnetFaucetGrantRecord {
  readonly grantId: string;
  readonly ownerUserId: string;
  readonly walletId: string;
  /** Lower-case; the cooldown key. */
  readonly address: string;
  readonly bnbAmount: string;
  readonly bnbAmountRaw: string;
  readonly usd1Amount: string;
  readonly usd1AmountRaw: string;
  readonly status: TestnetFaucetGrantStatus;
  readonly bnbTransactionHash: string | null;
  readonly usd1TransactionHash: string | null;
  readonly failureReasonCode: string | null;
  readonly grantedAt: string;
  readonly completedAt: string | null;
}

export interface TestnetFaucetReserveInput {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly grantId: string;
  readonly walletId: string;
  readonly address: string;
  readonly chainId: string;
  readonly bnbAmount: string;
  readonly bnbAmountRaw: string;
  readonly usd1Amount: string;
  readonly usd1AmountRaw: string;
  readonly usd1TokenAddress: string;
  readonly operatorAddress: string;
  readonly now: Date;
  readonly cooldownSeconds: number;
}

export type TestnetFaucetReserveResult =
  | { readonly kind: "reserved"; readonly grant: TestnetFaucetGrantRecord }
  | { readonly kind: "replay"; readonly grant: TestnetFaucetGrantRecord }
  | { readonly kind: "cooldown"; readonly blocking: TestnetFaucetGrantRecord };

export type TestnetFaucetReplayLookup =
  | { readonly kind: "none" }
  | { readonly kind: "conflict" }
  | { readonly kind: "grant"; readonly grant: TestnetFaucetGrantRecord };

export type TestnetFaucetFinalStatus = Exclude<
  TestnetFaucetGrantStatus,
  "pending"
>;

export interface TestnetFaucetRepository {
  /**
   * The newest grant of `address` that is not `failed` and was reserved
   * after `since` (the cooldown window start); null when none holds it.
   */
  latestBlockingGrant(
    address: string,
    since: Date,
  ): Promise<TestnetFaucetGrantRecord | null>;
  /** The newest grant of `address` whose tBNB transfer was sent. */
  latestSentGrant(address: string): Promise<TestnetFaucetGrantRecord | null>;
  findReplay(input: {
    readonly ownerUserId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
  }): Promise<TestnetFaucetReplayLookup>;
  /**
   * One transaction: owner lock, idempotency claim (conflict →
   * `TestnetFaucetIdempotencyConflictError`), replay, address advisory
   * lock, cooldown re-check, `pending` insert.
   */
  reserve(
    input: TestnetFaucetReserveInput,
  ): Promise<TestnetFaucetReserveResult>;
  /** Stores a signed hash before it is broadcast. */
  recordTransactionHash(input: {
    readonly grantId: string;
    readonly leg: "bnb" | "usd1";
    readonly transactionHash: string;
  }): Promise<void>;
  finalize(input: {
    readonly grantId: string;
    readonly status: TestnetFaucetFinalStatus;
    readonly bnbTransactionHash: string | null;
    readonly usd1TransactionHash: string | null;
    readonly failureReasonCode: string | null;
    readonly now: Date;
  }): Promise<TestnetFaucetGrantRecord>;
}

export class TestnetFaucetIdempotencyConflictError extends Error {
  constructor() {
    super("The faucet idempotency key is bound to another request");
    this.name = "TestnetFaucetIdempotencyConflictError";
  }
}

export class TestnetFaucetRepositoryUnavailableError extends Error {
  constructor() {
    super("The faucet repository is unavailable");
    this.name = "TestnetFaucetRepositoryUnavailableError";
  }
}

/** Outcome of one signed operator transaction. */
export type TestnetFaucetTransferOutcome =
  | { readonly status: "confirmed"; readonly transactionHash: string }
  | { readonly status: "reverted"; readonly transactionHash: string }
  /** Broadcast; no receipt within the wait. It may still land. */
  | { readonly status: "unconfirmed"; readonly transactionHash: string }
  /** Never reached the node (prepare / sign / broadcast failed). */
  | { readonly status: "not_sent" };

export type TestnetFaucetMintEstimate =
  { readonly kind: "ok"; readonly gas: bigint } | { readonly kind: "reverted" };

/**
 * The operator account on BSC Testnet. Reads throw on transport failure;
 * sends never throw (the outcome says what happened). `onSigned` runs with
 * the locally computed hash before the broadcast.
 */
export interface TestnetFaucetChain {
  readonly operatorAddress: string;
  readUsd1Decimals(usd1: string): Promise<number>;
  estimateMintGas(input: {
    readonly usd1: string;
    readonly to: string;
    readonly amountRaw: bigint;
  }): Promise<TestnetFaucetMintEstimate>;
  readGasPrice(): Promise<bigint>;
  readOperatorBalance(): Promise<bigint>;
  sendNative(input: {
    readonly to: string;
    readonly valueWei: bigint;
    readonly onSigned: (transactionHash: string) => Promise<void>;
  }): Promise<TestnetFaucetTransferOutcome>;
  sendMint(input: {
    readonly usd1: string;
    readonly to: string;
    readonly amountRaw: bigint;
    readonly gas: bigint;
    readonly onSigned: (transactionHash: string) => Promise<void>;
  }): Promise<TestnetFaucetTransferOutcome>;
}
