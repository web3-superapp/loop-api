import { privateKeyToAccount } from "viem/accounts";

import {
  createHooksLaunchDeploymentTypedData,
  hooksLaunchId,
} from "../../src/features/launch/hooks-launch-deployment-crypto.js";
import type {
  HooksLaunchExecutorChain,
  HooksLaunchExecutorContext,
  HooksLaunchExecutorEventInput,
  HooksLaunchExecutorRepository,
  HooksLaunchExecutorTask,
  HooksLaunchReceipt,
  HooksLaunchSendResult,
  HooksLaunchTaskPatch,
} from "../../src/features/launch/hooks-launch-executor.js";
import type { HooksLaunchDeploymentStatus } from "../../src/features/launch/hooks-launch-deployment-status.js";
import { hooksLaunchBindingHash } from "../../src/features/launch/hooks-launch-submission.js";
import {
  expectedGraduationSqrtPriceX96,
  hooksLaunchTemplateConstants as c,
  type HooksLaunchExpectedDeployment,
  type HooksLaunchOnChainFacts,
} from "../../src/features/launch/hooks-launch-verification.js";

/** Decision 0112 unit fixtures: a signed task, its facts, and fakes. */

export const factoryAddress = "0x1111111111111111111111111111111111111111";
export const factoryCodeHash = `0x${"fa".repeat(32)}`;
export const executorAddress = "0x2222222222222222222222222222222222222222";
export const ownerAccount = privateKeyToAccount(`0x${"01".repeat(32)}`);
export const projectOwner = ownerAccount.address.toLowerCase();
export const memeAddress = `0x${"ab".repeat(18)}6666`;
export const hookAddress = `0x${"cd".repeat(18)}20cc`;
export const usd1 = "0x0000000000000000000000000000000000000001";
export const configHash = `0x${"c0".repeat(32)}`;
export const nowSeconds = 1_800_000_000;
export const nftSaleStart = BigInt(nowSeconds + 2 * 86_400);
export const buybackRecipient = "0x3333333333333333333333333333333333333333";
export const hookSalt = `0x${"00".repeat(31)}07`;
export const launchId = hooksLaunchId({
  chainId: 97,
  factory: factoryAddress,
  projectOwner,
  configVersion: 1,
  configHash,
}).toLowerCase();

export async function signedPayload(deadline: number) {
  const request = {
    configHash,
    projectOwner,
    configVersion: 1,
    name: "Project",
    ticker: "MEME",
    nftSaleStart: nftSaleStart.toString(),
    buybackRecipient,
    deadline: String(deadline),
    memeSalt: `0x${"00".repeat(31)}09`,
    nonce: "0",
  };
  const typed = createHooksLaunchDeploymentTypedData({
    chainId: 97,
    verifyingContract: factoryAddress,
    request,
  });
  const message = {
    ...typed.message,
    nftSaleStart: BigInt(request.nftSaleStart),
    deadline: BigInt(request.deadline),
    nonce: 0n,
  };
  const signature = await ownerAccount.signTypedData({ ...typed, message });
  return { walletId: "wallet-1", request, hookSalt, signature };
}

export function bindingHash(
  payload: Awaited<ReturnType<typeof signedPayload>>,
): string {
  return hooksLaunchBindingHash({
    factoryAddress,
    request: payload.request,
    hookSalt: payload.hookSalt,
    memeAddress,
    hookAddress,
  });
}

export function expectedDeployment(): HooksLaunchExpectedDeployment {
  return {
    factoryAddress,
    factoryCodeHash,
    launchId,
    projectOwner,
    configVersion: 1,
    configHash,
    name: "Project",
    ticker: "MEME",
    nftSaleStart,
    buybackRecipient,
    hookSalt,
    predictedMemeAddress: memeAddress,
    predictedHookAddress: hookAddress,
  };
}

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
export const modules = {
  nft: a(0x101),
  snapshots: a(0x102),
  escrow: a(0x103),
  gate: a(0x104),
  curve: a(0x105),
  graduationAdapter: a(0x106),
  buybackAdapter: a(0x107),
  priceRecorder: a(0x108),
  buybackExecutor: a(0x109),
};
const roles = {
  poolManager: a(0x201),
  platformTaxReceiver: a(0x202),
  feeVault: a(0x203),
  primaryKeeper: a(0x204),
  fallbackKeeper: a(0x205),
  pauseAuthority: a(0x206),
  resumeAuthority: a(0x207),
};

/**
 * Facts that pass every check for `expectedDeployment()`, for a Factory
 * whose `nftSaleDuration()` is `saleDuration` (Decision 0119; default the
 * 7-day mainnet period). `legacy` models a pre-S141 Factory (604,800 s).
 */
export function passingFacts(
  options: { readonly saleDuration?: bigint; readonly legacy?: boolean } = {},
): HooksLaunchOnChainFacts {
  const saleDuration = options.saleDuration ?? 604_800n;
  const moduleList = [
    memeAddress,
    hookAddress,
    ...Object.values(modules),
  ] as const;
  const codeHashes: Record<string, string> = {};
  moduleList.forEach((address, index) => {
    codeHashes[address] = `0x${(index + 1).toString(16).padStart(64, "0")}`;
  });
  return {
    factoryCodeHash,
    factory: {
      ...roles,
      usd1,
      activationBufferSeconds: 3_600n,
      nftSaleDuration: saleDuration,
      nftSaleDurationLegacy: options.legacy ?? false,
      deployers: (["token", "v4", "sale", "buyback"] as const).map(
        (name, index) => ({
          name,
          address: a(0x300 + index),
          pinnedCodeHash: `0x${"d".repeat(63)}${index}`,
          actualCodeHash: `0x${"d".repeat(63)}${index}`,
        }),
      ),
    },
    modules: {
      projectOwner,
      configVersion: 1,
      configHash,
      meme: memeAddress,
      officialHook: hookAddress,
      ...modules,
      poolKey: {
        currency0: usd1,
        currency1: memeAddress,
        fee: 2_500,
        tickSpacing: 60,
        hooks: hookAddress,
      },
    },
    codeHashes,
    meme: {
      totalSupply: c.memeTotalSupply,
      templateTotalSupply: c.memeTotalSupply,
      name: "Project",
      symbol: "MEME",
      decimals: 18,
      launchFactory: factoryAddress,
      graduationAuthority: modules.graduationAdapter,
      curve: modules.curve,
      graduated: false,
      curveBalance: c.curveSaleSupply,
      adapterBalance: c.initialLiquiditySupply,
    },
    curve: {
      buyTaxBps: 1_000n,
      sellTaxBps: 1_000n,
      maxCumulativeBuy: c.perAddressCap,
      earlyRoundDuration: 3_600n,
      meme: memeAddress,
      usd1,
      snapshots: modules.snapshots,
      graduationAdapter: modules.graduationAdapter,
      publicationGate: modules.gate,
      platformTaxReceiver: roles.platformTaxReceiver,
      soldSupply: 0n,
      accountedReserve: 0n,
      graduated: false,
    },
    hook: {
      taxBps: 200n,
      poolManager: roles.poolManager,
      feeVault: roles.feeVault,
      poolInitializer: modules.graduationAdapter,
      expectedInitialSqrtPriceX96: expectedGraduationSqrtPriceX96({
        memeIsCurrency0: false,
      }),
      currency0: usd1,
      currency1: memeAddress,
      lpFee: 2_500,
      tickSpacing: 60,
    },
    gate: {
      launchId,
      configHash,
      nftSaleStart,
      activationBufferSeconds: 3_600n,
      deployExecutor: factoryAddress,
      published: false,
    },
    nft: {
      price: c.nftPrice,
      saleDuration,
      launchId,
      usd1,
      publicationGate: modules.gate,
      escrow: modules.escrow,
      saleStart: nftSaleStart,
      saleEnd: nftSaleStart + saleDuration,
      totalMinted: 0n,
    },
    escrow: {
      usd1,
      launchFactory: factoryAddress,
      projectNft: modules.nft,
      buybackExecutor: modules.buybackExecutor,
    },
    buyback: {
      usd1,
      meme: memeAddress,
      budget: modules.escrow,
      swapAdapter: modules.buybackAdapter,
      recipient: buybackRecipient,
      ...roles,
    },
    adapter: {
      lpMemeAllocation: c.initialLiquiditySupply,
      lpFee: 2_500,
      tickSpacing: 60,
      launchFactory: factoryAddress,
      poolManager: roles.poolManager,
      usd1,
      currency0: usd1,
      currency1: memeAddress,
      meme: memeAddress,
      curve: modules.curve,
      projectBound: true,
      finalized: false,
    },
    snapshots: {
      launchId,
      nft: modules.nft,
      nftSaleEnd: nftSaleStart + saleDuration,
    },
  };
}

export function launchDeployedEvent() {
  return {
    launchId,
    projectOwner,
    configVersion: 1,
    configHash,
    meme: memeAddress,
    nft: modules.nft,
    curve: modules.curve,
    hook: hookAddress,
    hookSalt,
  };
}

type Syncified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => R | Promise<R>
    : T[K];
};

/** Wraps a synchronous fake so every method returns a Promise. */
function asyncify<T extends object>(impl: Syncified<T>): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(impl)) {
    result[key] =
      typeof value === "function"
        ? (...args: unknown[]) =>
            Promise.resolve().then(() =>
              (value as (...a: unknown[]) => unknown)(...args),
            )
        : value;
  }
  return result as T;
}

/** In-memory repository with the migration-000059 transition rules. */
export function fakeRepository(input: {
  readonly payload: Awaited<ReturnType<typeof signedPayload>>;
  readonly latestConfig?: HooksLaunchExecutorContext["latestConfig"];
}) {
  const task: {
    -readonly [K in keyof HooksLaunchExecutorTask]: HooksLaunchExecutorTask[K];
  } = {
    jobId: "00000000-0000-4000-8000-0000000000aa",
    projectId: "00000000-0000-4000-8000-0000000000bb",
    configVersion: 1,
    chainId: 97,
    factoryAddress,
    projectOwner,
    ownerNonce: "0",
    bindingHash: bindingHash(input.payload),
    memeAddress,
    hookAddress,
    status: "awaiting_executor",
    claimedBy: null,
    attemptCount: 0,
    executorAddress: null,
    txHash: null,
    txNonce: null,
    rawTx: null,
    blockNumber: null,
    blockHash: null,
    confirmations: null,
    launchId: null,
    activationTxHash: null,
    activationTxNonce: null,
    activationRawTx: null,
    activationBlockNumber: null,
    activationBlockHash: null,
    activationAttemptCount: 0,
    failureCode: null,
    failureRetryable: null,
  };
  const events: (HooksLaunchExecutorEventInput & {
    readonly from: HooksLaunchDeploymentStatus | null;
    readonly to: HooksLaunchDeploymentStatus;
  })[] = [];
  const reservations: {
    nonce: bigint;
    txHash: string;
    state: "pending" | "released";
    purpose: "deploy" | "activate";
  }[] = [];
  let retryReady = true;
  const snapshot = (): HooksLaunchExecutorTask => ({ ...task });
  const repository = asyncify<HooksLaunchExecutorRepository>({
    acquire(request) {
      if (request.exclude.includes(task.jobId)) return null;
      if (request.factoryAddress !== task.factoryAddress) return null;
      if (task.status === "awaiting_executor" || task.status === "failed") {
        if (
          task.status === "failed" &&
          (task.failureRetryable !== true ||
            task.attemptCount >= request.maxAttempts ||
            !retryReady)
        )
          return null;
        events.push({
          from: task.status,
          to: "claimed",
          kind: task.status === "failed" ? "retry_claimed" : "claimed",
        });
        task.status = "claimed";
        task.attemptCount += 1;
        task.failureCode = null;
        task.failureRetryable = null;
        task.claimedBy = request.executorId;
        return snapshot();
      }
      if (task.status === "reorged") {
        events.push({
          from: "reorged",
          to: "claimed",
          kind: "reclaimed_after_reorg",
        });
        task.status = "claimed";
        task.claimedBy = request.executorId;
        task.activationTxHash = null;
        task.activationRawTx = null;
        task.activationTxNonce = null;
        return snapshot();
      }
      if (
        ["claimed", "broadcast", "confirmed", "verified"].includes(task.status)
      ) {
        task.claimedBy = request.executorId;
        return snapshot();
      }
      return null;
    },
    get() {
      return snapshot();
    },
    context() {
      return {
        latestConfig: input.latestConfig ?? {
          version: 1,
          configHash,
          approvedHash: configHash,
        },
        authorizations: [{ signedPayload: input.payload }],
      };
    },
    transition(request) {
      if (task.status !== request.from || task.claimedBy !== request.executorId)
        return null;
      task.status = request.to;
      const patch: HooksLaunchTaskPatch = request.patch;
      for (const [key, value] of Object.entries(patch)) {
        if (
          value === undefined ||
          key === "deployedAddresses" ||
          key === "verification" ||
          key === "activatedAt"
        )
          continue;
        (task as Record<string, unknown>)[key] = value;
      }
      if (request.event !== null) {
        events.push({ from: request.from, to: request.to, ...request.event });
      }
      return snapshot();
    },
    async reserveAndRecord(request) {
      if (task.claimedBy !== request.executorId) return null;
      if (request.purpose === "deploy" && task.status !== "claimed")
        return null;
      let nonce = request.chainPendingNonce;
      while (
        reservations.some((r) => r.state === "pending" && r.nonce === nonce)
      )
        nonce += 1n;
      const signed = await request.sign(nonce);
      reservations.push({
        nonce,
        txHash: signed.txHash,
        state: "pending",
        purpose: request.purpose,
      });
      if (request.purpose === "deploy") {
        events.push({
          from: "claimed",
          to: "broadcast",
          kind: "broadcast",
          txHash: signed.txHash,
        });
        task.status = "broadcast";
        task.txHash = signed.txHash;
        task.rawTx = signed.rawTx;
        task.txNonce = nonce;
        task.executorAddress = request.executorAddress;
        task.blockHash = null;
        task.blockNumber = null;
        task.confirmations = null;
      } else {
        events.push({
          from: "verified",
          to: "verified",
          kind: "activation_broadcast",
          txHash: signed.txHash,
        });
        task.activationTxHash = signed.txHash;
        task.activationRawTx = signed.rawTx;
        task.activationTxNonce = nonce;
        task.activationBlockHash = null;
        task.activationBlockNumber = null;
        task.activationAttemptCount += 1;
      }
      return snapshot();
    },
    reservationPending(txHash) {
      return reservations.some(
        (r) => r.txHash === txHash && r.state === "pending",
      );
    },
    releaseReservation(txHash) {
      for (const r of reservations)
        if (r.txHash === txHash) r.state = "released";
    },
  });
  return {
    repository,
    task,
    events,
    reservations,
    setRetryReady(value: boolean) {
      retryReady = value;
    },
  };
}

/** A scriptable chain: transactions mine on `mine()` unless held. */
export function fakeChain() {
  const state = {
    chainId: 97,
    factoryHash: factoryCodeHash as string | null,
    authorized: executorAddress,
    ownerNonce: 0n,
    existingLaunch: `0x${"0".repeat(64)}`,
    head: 100n,
    timestamp: BigInt(nowSeconds),
    gasPrice: 1_000_000_000n,
    estimate: 11_000_000n as bigint | Error,
    activateEstimate: 60_000n as bigint | Error,
    sendResult: "accepted" as HooksLaunchSendResult,
    executorNonce: 0n,
    facts: passingFacts(),
    published: false,
    /** Mined transactions by hash. */
    receipts: new Map<string, HooksLaunchReceipt>(),
    pending: [] as {
      readonly hash: string;
      readonly kind: "deploy" | "activate";
      readonly nonce: bigint;
    }[],
    revertNext: false,
    sent: [] as string[],
    blockHashes: new Map<bigint, string>(),
  };
  let counter = 0;
  const blockHash = (n: bigint, salt = "") =>
    `0x${(n.toString(16) + salt).padStart(64, "0")}`.slice(0, 66);
  function mine(blocks = 1): void {
    for (let i = 0; i < blocks; i += 1) {
      state.head += 1n;
      state.timestamp += 3n;
      state.blockHashes.set(state.head, blockHash(state.head));
      for (const tx of state.pending.splice(0)) {
        const reverted = state.revertNext;
        state.revertNext = false;
        state.executorNonce = tx.nonce + 1n;
        state.receipts.set(tx.hash, {
          status: reverted ? "reverted" : "success",
          blockNumber: state.head,
          blockHash: state.blockHashes.get(state.head)!,
          launchDeployed:
            tx.kind === "deploy" && !reverted ? launchDeployedEvent() : null,
        });
        if (!reverted && tx.kind === "activate") state.published = true;
        if (!reverted && tx.kind === "deploy") state.ownerNonce = 1n;
      }
    }
  }
  /** Drops the last `depth` blocks and their transactions (back to pending). */
  function reorg(depth: number): void {
    for (let i = 0; i < depth; i += 1) {
      const removed = state.head;
      for (const [hash, receipt] of [...state.receipts]) {
        if (receipt.blockNumber === removed) {
          state.receipts.delete(hash);
        }
      }
      state.blockHashes.delete(removed);
      state.head -= 1n;
    }
    state.executorNonce = 0n;
    state.ownerNonce = 0n;
    state.published = false;
  }
  const decoded = new Map<
    string,
    { kind: "deploy" | "activate"; nonce: bigint }
  >();
  const chain = asyncify<HooksLaunchExecutorChain>({
    executorAddress,
    factoryAddress,
    chainId: () => state.chainId,
    codeHash: () => state.factoryHash,
    deploymentExecutor: () => state.authorized,
    activationBufferSeconds: () => 3_600n,
    ownerNonce: () => state.ownerNonce,
    launchIdByOwnerVersion: () => state.existingLaunch,
    latestBlock: () => ({
      number: state.head,
      timestamp: state.timestamp,
    }),
    blockHash: (n) => state.blockHashes.get(n) ?? null,
    transactionCount: (tag) =>
      tag === "pending"
        ? state.executorNonce + BigInt(state.pending.length)
        : state.executorNonce,
    gasPrice: () => state.gasPrice,
    estimateDeploy: () => {
      if (state.estimate instanceof Error) throw state.estimate;
      return state.estimate;
    },
    estimateActivate: () => {
      if (state.activateEstimate instanceof Error) throw state.activateEstimate;
      return state.activateEstimate;
    },
    signDeploy: (_call, tx) => {
      counter += 1;
      const hash = `0x${counter.toString(16).padStart(64, "0")}`;
      decoded.set(hash, { kind: "deploy", nonce: tx.nonce });
      return {
        txHash: hash,
        rawTx: `0x0d${counter.toString(16).padStart(4, "0")}`,
      };
    },
    signActivate: (_id, _hash, tx) => {
      counter += 1;
      const hash = `0x${counter.toString(16).padStart(64, "0")}`;
      decoded.set(hash, { kind: "activate", nonce: tx.nonce });
      return {
        txHash: hash,
        rawTx: `0x0a${counter.toString(16).padStart(4, "0")}`,
      };
    },
    sendRaw: (raw) => {
      state.sent.push(raw);
      if (state.sendResult !== "accepted") return state.sendResult;
      const counterHex = raw.slice(4);
      const hash = `0x${counterHex.replace(/^0+/u, "").padStart(64, "0")}`;
      const info = decoded.get(hash)!;
      if (
        !state.receipts.has(hash) &&
        !state.pending.some((tx) => tx.hash === hash)
      ) {
        state.pending.push({ hash, ...info });
      }
      return "accepted";
    },
    receipt: (hash) => state.receipts.get(hash) ?? null,
    readLaunch: () => state.facts,
    gatePublished: () => state.published,
  });
  state.blockHashes.set(state.head, blockHash(state.head));
  return { chain, state, mine, reorg };
}
