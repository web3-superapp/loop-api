import { createHash, randomUUID } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  V2ApiError,
  type V2ErrorCode,
  type V2ErrorDetailsSafe,
} from "../../core/http/v2-error.js";
import { isOpaqueId } from "../../core/ids/opaque-id.js";
import { canonicalJson } from "../../core/json/canonical-json.js";
import type { TestnetFaucetConfig } from "../../config.js";
import { faucetDecimalToRaw } from "../../config.js";
import type {
  AccountWalletRecord,
  AccountWalletRepository,
} from "../../database/account-wallet-repository.js";
import {
  bscTestnetChainId,
  type LaunchChainId,
} from "../chain/chain-contract.js";
import {
  testnetFaucetReasonCodes as reasons,
  TestnetFaucetIdempotencyConflictError,
  type TestnetFaucetChain,
  type TestnetFaucetCooldownPolicy,
  type TestnetFaucetFinalStatus,
  type TestnetFaucetGrantRecord,
  type TestnetFaucetRepository,
  type TestnetFaucetTransferOutcome,
} from "./testnet-faucet-contract.js";

/**
 * Decision 0128: `GET` / `POST /v2/testnet/faucet`. The POST checks the
 * wallet, the replay, the cooldown and the operator funds, reserves a
 * `pending` grant (idempotency record + address lock in one transaction),
 * then signs tBNB first and `MockUSD1.mint` second, each waiting for its
 * receipt. Grants are serialised in this process (one operator nonce
 * stream). Anything missing is 503 with the reason, never a fake success.
 */

type Resource = Record<string, unknown>;

export interface TestnetFaucetLogger {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

export interface TestnetFaucetServiceDependencies {
  readonly config: TestnetFaucetConfig;
  readonly launchChainId: LaunchChainId;
  readonly rpcConfigured: boolean;
  readonly repository: TestnetFaucetRepository | null;
  readonly wallets: AccountWalletRepository | null;
  /** Null while the key, the RPC, or the chain slot is missing. */
  readonly chain: TestnetFaucetChain | null;
  readonly logger: TestnetFaucetLogger;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
  /** How long a request waits for the in-process grant lock (default 2500). */
  readonly lockTimeoutMs?: number;
  /**
   * S169: wei kept on the operator on top of the grant. Non-zero only when
   * the operator key is the MEME pause key and the pause signer is composed
   * in this process (the app passes `config.operatorReserveWei` then).
   */
  readonly operatorReserveWei?: bigint;
}

export interface TestnetFaucetService {
  /** Null when available; otherwise the capability / 503 reason. */
  unavailableReason(): string | null;
  status(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly query: unknown;
  }): Promise<Resource>;
  grant(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly body: unknown;
    readonly idempotencyKey: string;
  }): Promise<Resource>;
}

const grantScope = "testnet_faucet_grant";
export const testnetFaucetGrantDigestVersion = "testnet_faucet_grant_v1";
export { grantScope as testnetFaucetGrantScope };

/** Operator balance must cover the transfer plus twice the two legs' gas. */
const gasSafetyMultiplier = 2n;
/** Plain transfer gas, the balance floor when the estimate reverted. */
const plainTransferGas = 21_000n;
const dayMs = 86_400_000;

/** The start of the UTC day of `at`. */
export function utcDayStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / dayMs) * dayMs);
}

/** The tBNB gas limit: 21 000 as estimated, else 20 % headroom. */
function nativeGasLimit(estimate: bigint): bigint {
  return estimate <= plainTransferGas ? estimate : (estimate * 12n) / 10n;
}

/**
 * Configuration-only reason, first match wins (Decision 0128 §5). Shared by
 * the capability projection and the routes.
 */
export function testnetFaucetConfigurationReason(input: {
  readonly config: TestnetFaucetConfig;
  readonly launchChainId: LaunchChainId;
  readonly rpcConfigured: boolean;
  readonly runtimeComposed: boolean;
}): string | null {
  if (!input.config.enabled) return reasons.disabled;
  if (input.launchChainId !== bscTestnetChainId) return reasons.wrongChain;
  if (input.config.operatorPrivateKey === null) {
    return reasons.operatorNotConfigured;
  }
  if (input.config.usd1Source === null) return reasons.usd1NotConfigured;
  if (!input.rpcConfigured) return reasons.rpcNotConfigured;
  if (!input.runtimeComposed) return reasons.runtimeUnavailable;
  return null;
}

function fail(
  code: V2ErrorCode,
  reasonCode: string,
  extra: V2ErrorDetailsSafe = {},
): never {
  throw V2ApiError.fromCode(code, { reasonCode, ...extra });
}

function unavailableWith(reasonCode: string): never {
  return fail("CAPABILITY_UNAVAILABLE", reasonCode);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parseWalletId(value: unknown, allowedKeys: readonly string[]): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw V2ApiError.invalidRequest();
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
    !isOpaqueId(record["walletId"])
  ) {
    throw V2ApiError.invalidRequest();
  }
  return record["walletId"];
}

interface Mutex {
  acquire(timeoutMs: number): Promise<(() => void) | null>;
}

/** FIFO lock; a waiter that times out leaves the queue without the lock. */
function createMutex(): Mutex {
  let locked = false;
  const waiters: { grant: () => void }[] = [];
  function release(): void {
    const next = waiters.shift();
    if (next === undefined) {
      locked = false;
    } else {
      next.grant();
    }
  }
  return {
    acquire(timeoutMs) {
      if (!locked) {
        locked = true;
        return Promise.resolve(release);
      }
      return new Promise((resolve) => {
        const entry = {
          grant: (): void => {
            clearTimeout(timer);
            resolve(release);
          },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(entry);
          if (index >= 0) waiters.splice(index, 1);
          resolve(null);
        }, timeoutMs);
        waiters.push(entry);
      });
    },
  };
}

export function createTestnetFaucetService(
  deps: TestnetFaucetServiceDependencies,
): TestnetFaucetService {
  const now = deps.now ?? ((): Date => new Date());
  const createUuid = deps.createUuid ?? randomUUID;
  const lockTimeoutMs = deps.lockTimeoutMs ?? 2_500;
  const operatorReserveWei = deps.operatorReserveWei ?? 0n;
  const mutex = createMutex();
  const { config } = deps;
  const policy: TestnetFaucetCooldownPolicy = Object.freeze({
    cooldownSeconds: config.cooldownSeconds,
    failedCooldownSeconds: config.failedCooldownSeconds,
    failedDailyLimit: config.failedDailyLimit,
  });

  function unavailableReason(): string | null {
    return testnetFaucetConfigurationReason({
      config,
      launchChainId: deps.launchChainId,
      rpcConfigured: deps.rpcConfigured,
      runtimeComposed:
        deps.repository !== null &&
        deps.wallets !== null &&
        deps.chain !== null,
    });
  }

  function runtime() {
    const reason = unavailableReason();
    if (reason !== null) unavailableWith(reason);
    return {
      repository: deps.repository as TestnetFaucetRepository,
      wallets: deps.wallets as AccountWalletRepository,
      chain: deps.chain as TestnetFaucetChain,
    };
  }

  async function ownedEmbeddedWallet(
    wallets: AccountWalletRepository,
    ownerUserId: string,
    walletId: string,
  ): Promise<AccountWalletRecord> {
    const wallet = await wallets
      .get(ownerUserId, walletId)
      .catch(() => unavailableWith(reasons.runtimeUnavailable));
    if (
      wallet === null ||
      wallet.status !== "active" ||
      wallet.kind !== "embedded" ||
      wallet.providerWalletId === null
    ) {
      fail("PERMISSION_DENIED", reasons.walletNotOwned);
    }
    return wallet;
  }

  /**
   * S156b: the USD1 MEME v2 trades in. The Factory's `usd1()` is immutable,
   * so the first successful read is kept for the process.
   */
  let factoryUsd1: string | null = null;
  async function resolveUsd1(chain: TestnetFaucetChain): Promise<string> {
    const source = config.usd1Source;
    if (source === null) return unavailableWith(reasons.usd1NotConfigured);
    if (source.kind !== "factory") return source.address;
    if (factoryUsd1 !== null) return factoryUsd1;
    const read = await chainRead(() =>
      chain.readFactoryUsd1(source.factoryAddress),
    );
    if (!/^0x[0-9a-f]{40}$/u.test(read) || /^0x0{40}$/u.test(read)) {
      unavailableWith(reasons.usd1Unavailable);
    }
    factoryUsd1 = read;
    return read;
  }

  function nextAvailableAt(grant: TestnetFaucetGrantRecord): string {
    return new Date(
      Date.parse(grant.grantedAt) + config.cooldownSeconds * 1_000,
    ).toISOString();
  }

  async function repositoryRead<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof V2ApiError) throw error;
      if (error instanceof TestnetFaucetIdempotencyConflictError) {
        throw V2ApiError.idempotencyConflict();
      }
      return unavailableWith(reasons.runtimeUnavailable);
    }
  }

  async function chainRead<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch {
      return unavailableWith(reasons.chainReadFailed);
    }
  }

  function grantedResource(grant: TestnetFaucetGrantRecord): Resource {
    return {
      walletId: grant.walletId,
      address: grant.address,
      bnb: {
        amount: grant.bnbAmount,
        transactionHash: grant.bnbTransactionHash,
      },
      usd1: {
        amount: grant.usd1Amount,
        transactionHash: grant.usd1TransactionHash,
      },
      grantedAt: grant.grantedAt,
      nextAvailableAt: nextAvailableAt(grant),
    };
  }

  /** The stored outcome of a grant, as the POST answers it (and replays it). */
  function outcomeOf(grant: TestnetFaucetGrantRecord): Resource {
    switch (grant.status) {
      case "granted":
        return grantedResource(grant);
      case "pending":
        return fail("RESOURCE_CONFLICT", reasons.inFlight);
      // S156 alignment: the client knows 502 / 503 here; a hash key is
      // present only for a transaction that went out.
      case "partial":
        return fail("CAPABILITY_UNAVAILABLE", reasons.partial, {
          ...sentHashes(grant),
          nextAvailableAt: nextAvailableAt(grant),
        });
      case "unknown":
        return fail("CAPABILITY_UNAVAILABLE", reasons.submissionUnknown, {
          ...sentHashes(grant),
          nextAvailableAt: nextAvailableAt(grant),
        });
      case "failed":
        return fail("PROVIDER_UNREACHABLE", reasons.transferFailed);
    }
  }

  function sentHashes(grant: TestnetFaucetGrantRecord): V2ErrorDetailsSafe {
    return {
      ...(grant.bnbTransactionHash === null
        ? {}
        : { bnbTransactionHash: grant.bnbTransactionHash }),
      ...(grant.usd1TransactionHash === null
        ? {}
        : { usd1TransactionHash: grant.usd1TransactionHash }),
    };
  }

  function cooldownError(nextAvailable: string): never {
    return fail("RATE_LIMITED", reasons.cooldown, {
      nextAvailableAt: nextAvailable,
    });
  }

  async function execute(
    rt: ReturnType<typeof runtime>,
    wallet: AccountWalletRecord,
    input: {
      readonly ownerUserId: string;
      readonly idempotencyKey: string;
      readonly requestSha256: string;
    },
  ): Promise<Resource> {
    const { repository, chain } = rt;
    const address = wallet.address.toLowerCase();
    const bnbAmountRaw = BigInt(config.bnbAmountWei);
    // S169: the global per-UTC-day caps. Grants are serialised by the
    // mutex, so the count read here cannot be overtaken in this process.
    const dayStart = utcDayStart(now());
    const totals = await repositoryRead(() => repository.dailyTotals(dayStart));
    if (
      totals.grants >= config.dailyMaxGrants ||
      BigInt(totals.bnbRaw) + bnbAmountRaw > BigInt(config.dailyMaxBnbWei)
    ) {
      deps.logger.warn(
        {
          event: "testnet_faucet.daily_limit",
          grants: totals.grants,
          bnbRaw: totals.bnbRaw,
          maxGrants: config.dailyMaxGrants,
          maxBnbWei: config.dailyMaxBnbWei,
        },
        "Testnet faucet daily limit reached",
      );
      fail("CAPABILITY_UNAVAILABLE", reasons.dailyLimit, {
        nextAvailableAt: new Date(dayStart.getTime() + dayMs).toISOString(),
      });
    }
    const usd1 = await resolveUsd1(chain);
    // Preflight: nothing is written when the chain cannot do the grant.
    const decimals = await chainRead(() => chain.readUsd1Decimals(usd1));
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      unavailableWith(reasons.usd1Unavailable);
    }
    let usd1AmountRaw: bigint;
    try {
      usd1AmountRaw = faucetDecimalToRaw(config.usd1Amount, decimals);
    } catch {
      return unavailableWith(reasons.usd1Unavailable);
    }
    const estimate = await chainRead(() =>
      chain.estimateMintGas({ usd1, to: address, amountRaw: usd1AmountRaw }),
    );
    if (estimate.kind === "reverted") {
      unavailableWith(reasons.usd1Unavailable);
    }
    const mintGas = (estimate.gas * 12n) / 10n;
    // S169: the tBNB gas is estimated (an EIP-7702 / contract recipient
    // needs more than 21 000 or refuses the value). A revert is recorded
    // as `failed` below without a broadcast; a transport error writes
    // nothing.
    const nativeEstimate = await chainRead(() =>
      chain.estimateNativeGas({ to: address, valueWei: bnbAmountRaw }),
    );
    const nativeGas =
      nativeEstimate.kind === "ok"
        ? nativeGasLimit(nativeEstimate.gas)
        : plainTransferGas;
    const [gasPrice, balance] = await chainRead(() =>
      Promise.all([chain.readGasPrice(), chain.readOperatorBalance()]),
    );
    const required =
      bnbAmountRaw +
      gasPrice * (nativeGas + mintGas) * gasSafetyMultiplier +
      operatorReserveWei;
    if (balance < required) {
      deps.logger.warn(
        {
          event: "testnet_faucet.operator_low",
          operatorAddress: chain.operatorAddress,
          balanceWei: balance.toString(),
          requiredWei: required.toString(),
          reserveWei: operatorReserveWei.toString(),
        },
        "Testnet faucet operator balance below the grant",
      );
      unavailableWith(reasons.operatorLow);
    }

    const reserved = await repositoryRead(() =>
      repository.reserve({
        ...input,
        grantId: createUuid(),
        walletId: wallet.walletId,
        address,
        chainId: bscTestnetChainId,
        bnbAmount: config.bnbAmount,
        bnbAmountRaw: bnbAmountRaw.toString(),
        usd1Amount: config.usd1Amount,
        usd1AmountRaw: usd1AmountRaw.toString(),
        usd1TokenAddress: usd1,
        operatorAddress: chain.operatorAddress,
        now: now(),
        policy,
      }),
    );
    if (reserved.kind === "replay") return outcomeOf(reserved.grant);
    if (reserved.kind === "cooldown") {
      return cooldownError(reserved.nextAvailableAt);
    }
    const grant = reserved.grant;

    // S169: a hash that cannot be stored is never broadcast (the chain
    // adapter stops); the error line keeps grantId / address / hash.
    const record =
      (leg: "bnb" | "usd1") =>
      async (transactionHash: string): Promise<void> => {
        try {
          await repository.recordTransactionHash({
            grantId: grant.grantId,
            leg,
            transactionHash,
          });
        } catch (error) {
          deps.logger.error(
            {
              event: "testnet_faucet.record_hash_failed",
              grantId: grant.grantId,
              address,
              leg,
              transactionHash,
              errorClass: error instanceof Error ? error.name : "UnknownError",
            },
            "Testnet faucet could not store a signed hash; not broadcast",
          );
          throw error;
        }
      };
    const bnb: TestnetFaucetTransferOutcome =
      nativeEstimate.kind === "reverted"
        ? { status: "not_sent" }
        : await chain
            .sendNative({
              to: address,
              valueWei: bnbAmountRaw,
              gas: nativeGas,
              onSigned: record("bnb"),
            })
            .catch((): TestnetFaucetTransferOutcome => ({
              status: "not_sent",
            }));

    let status: TestnetFaucetFinalStatus;
    let failureReasonCode: string | null;
    let usd1Hash: string | null = null;
    if (bnb.status === "not_sent" || bnb.status === "reverted") {
      status = "failed";
      failureReasonCode = reasons.transferFailed;
    } else if (bnb.status === "unconfirmed") {
      status = "unknown";
      failureReasonCode = reasons.submissionUnknown;
    } else {
      const mint = await chain
        .sendMint({
          usd1,
          to: address,
          amountRaw: usd1AmountRaw,
          gas: mintGas,
          onSigned: record("usd1"),
        })
        .catch((): TestnetFaucetTransferOutcome => ({ status: "not_sent" }));
      usd1Hash = mint.status === "not_sent" ? null : mint.transactionHash;
      if (mint.status === "confirmed") {
        status = "granted";
        failureReasonCode = null;
      } else {
        status = "partial";
        failureReasonCode = reasons.partial;
      }
    }
    const bnbHash = bnb.status === "not_sent" ? null : bnb.transactionHash;
    const finalized = await repositoryRead(async () => {
      try {
        return await repository.finalize({
          grantId: grant.grantId,
          status,
          bnbTransactionHash: bnbHash,
          usd1TransactionHash: usd1Hash,
          failureReasonCode,
          now: now(),
        });
      } catch (error) {
        // S169: the row stays `pending`; the worker's sweep closes it
        // after TESTNET_FAUCET_PENDING_TIMEOUT_SECONDS from the hash.
        deps.logger.error(
          {
            event: "testnet_faucet.finalize_failed",
            grantId: grant.grantId,
            walletId: grant.walletId,
            address,
            status,
            bnbTransactionHash: bnbHash,
            usd1TransactionHash: usd1Hash,
            errorClass: error instanceof Error ? error.name : "UnknownError",
          },
          "Testnet faucet could not record the grant outcome",
        );
        throw error;
      }
    });
    deps.logger.info(
      {
        event: "testnet_faucet.grant",
        grantId: finalized.grantId,
        walletId: finalized.walletId,
        address: finalized.address,
        status: finalized.status,
        bnbTransactionHash: finalized.bnbTransactionHash,
        usd1TransactionHash: finalized.usd1TransactionHash,
        failureReasonCode: finalized.failureReasonCode,
      },
      "Testnet faucet grant",
    );
    return outcomeOf(finalized);
  }

  const service: TestnetFaucetService = {
    unavailableReason,

    async status({ principal, query }) {
      const rt = runtime();
      const walletId = parseWalletId(query, ["walletId"]);
      const wallet = await ownedEmbeddedWallet(
        rt.wallets,
        principal.userId,
        walletId,
      );
      const address = wallet.address.toLowerCase();
      const [blockedUntil, sent] = await repositoryRead(() =>
        Promise.all([
          rt.repository.nextAvailableAt({
            address,
            ownerUserId: principal.userId,
            now: now(),
            policy,
          }),
          rt.repository.latestSentGrant(address),
        ]),
      );
      return {
        walletId: wallet.walletId,
        address,
        bnbAmount: config.bnbAmount,
        usd1Amount: config.usd1Amount,
        cooldownSeconds: config.cooldownSeconds,
        available: blockedUntil === null,
        nextAvailableAt: blockedUntil,
        lastGrant:
          sent === null
            ? null
            : {
                grantedAt: sent.grantedAt,
                bnbTransactionHash: sent.bnbTransactionHash,
                usd1TransactionHash: sent.usd1TransactionHash,
              },
      };
    },

    async grant({ principal, body, idempotencyKey }) {
      const rt = runtime();
      const walletId = parseWalletId(body, ["walletId"]);
      const wallet = await ownedEmbeddedWallet(
        rt.wallets,
        principal.userId,
        walletId,
      );
      const input = {
        ownerUserId: principal.userId,
        idempotencyKey,
        requestSha256: sha256({ walletId: wallet.walletId }),
      };
      const replay = await repositoryRead(() =>
        rt.repository.findReplay(input),
      );
      if (replay.kind === "conflict") throw V2ApiError.idempotencyConflict();
      if (replay.kind === "grant") return outcomeOf(replay.grant);
      const address = wallet.address.toLowerCase();
      const blockedUntil = await repositoryRead(() =>
        rt.repository.nextAvailableAt({
          address,
          ownerUserId: principal.userId,
          now: now(),
          policy,
        }),
      );
      if (blockedUntil !== null) cooldownError(blockedUntil);

      const release = await mutex.acquire(lockTimeoutMs);
      if (release === null) unavailableWith(reasons.busy);
      try {
        return await execute(rt, wallet, input);
      } finally {
        release();
      }
    },
  };
  return Object.freeze(service);
}
