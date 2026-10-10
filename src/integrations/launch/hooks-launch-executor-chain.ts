import {
  BaseError,
  BlockNotFoundError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
  HttpRequestError,
  TimeoutError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  fallback,
  http,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

import {
  HooksLaunchChainRevertError,
  type HooksLaunchDeployCall,
  type HooksLaunchExecutorChain,
  type HooksLaunchReceipt,
  type HooksLaunchSendResult,
} from "../../features/launch/hooks-launch-executor.js";
import {
  hooksLaunchTemplateConstants,
  type HooksLaunchModules,
  type HooksLaunchOnChainFacts,
} from "../../features/launch/hooks-launch-verification.js";
import {
  buybackExecutorAbi,
  curveEngineAbi,
  launchPublicationGateAbi,
  loopLaunchFactoryAbi,
  memeTokenAbi,
  nftEscrowAbi,
  officialTaxHookAbi,
  officialV4GraduationAdapterAbi,
  projectNFTAbi,
  snapshotRegistryAbi,
} from "./hooks-launch-protocol-abi.generated.js";

/**
 * Decision 0112: the executor's BSC Testnet client. It signs exactly two
 * call shapes on the configured Factory — `deployLaunch` and
 * `activateLaunch` — with the executor key, locally (legacy transactions,
 * chain 97), so the transaction hash is known and persisted before the
 * bytes are sent. The key lives in this closure only; no result, error, or
 * log field carries it or an RPC URL.
 */

export class HooksLaunchExecutorChainRefusedError extends Error {
  constructor(readonly reasonCode: string) {
    super("The Hooks launch executor chain client cannot be created");
    this.name = "HooksLaunchExecutorChainRefusedError";
  }
}

const lower = (value: string): string => value.toLowerCase();

function revertReason(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk(
    (cause) => cause instanceof ContractFunctionRevertedError,
  );
  if (reverted instanceof ContractFunctionRevertedError) {
    return reverted.data?.errorName ?? reverted.reason ?? "EXECUTION_REVERTED";
  }
  const execution = error.walk(
    (cause) => cause instanceof ExecutionRevertedError,
  );
  return execution === null ? null : "EXECUTION_REVERTED";
}

/** Decision 0118: the snapshot publisher decodes reverts the same way. */
export const revertReasonOf = revertReason;

function isTransportFailure(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk(
      (cause) =>
        cause instanceof HttpRequestError || cause instanceof TimeoutError,
    ) !== null
  );
}

export function classifyHooksLaunchSendError(
  error: unknown,
): HooksLaunchSendResult {
  if (isTransportFailure(error)) throw error;
  const text = (
    error instanceof BaseError
      ? `${error.message} ${error.details}`
      : String(error)
  ).toLowerCase();
  if (
    /already known|known transaction|already imported|alreadyknown/u.test(text)
  )
    return "known";
  if (/nonce too low|nonce has already been used/u.test(text))
    return "nonce_too_low";
  if (/insufficient funds/u.test(text)) return "insufficient_funds";
  return "rejected";
}

export function createHooksLaunchExecutorChain(input: {
  readonly privateKey: `0x${string}`;
  readonly factoryAddress: string;
  readonly rpcUrls: readonly string[];
  /** Test seam (anvil); production uses the RPC URL list. */
  readonly transport?: Transport;
}): HooksLaunchExecutorChain {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(input.factoryAddress)) {
    throw new HooksLaunchExecutorChainRefusedError(
      "HOOKS_LAUNCH_FACTORY_UNAVAILABLE",
    );
  }
  if (input.rpcUrls.length === 0 && input.transport === undefined) {
    throw new HooksLaunchExecutorChainRefusedError(
      "HOOKS_EXECUTOR_RPC_NOT_CONFIGURED",
    );
  }
  const transport =
    input.transport ??
    fallback(
      input.rpcUrls.map((url) =>
        http(url, { timeout: 10_000, retryCount: 1, batch: { batchSize: 32 } }),
      ),
      { retryCount: 0 },
    );
  const account = privateKeyToAccount(input.privateKey);
  const client = createPublicClient({ chain: bscTestnet, transport });
  const factory = lower(input.factoryAddress) as Address;

  async function codeHash(address: string): Promise<string | null> {
    const code = await client.getCode({ address: address as Address });
    return code === undefined || code === "0x" ? null : lower(keccak256(code));
  }

  function read(
    target: string,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<unknown> {
    return client.readContract({
      address: target as Address,
      abi,
      functionName,
      args,
    });
  }

  const address = async (
    target: string,
    abi: Abi,
    name: string,
  ): Promise<string> => lower(String(await read(target, abi, name)));
  const big = async (
    target: string,
    abi: Abi,
    name: string,
    args: readonly unknown[] = [],
  ): Promise<bigint> => BigInt(String(await read(target, abi, name, args)));
  const num = async (target: string, abi: Abi, name: string): Promise<number> =>
    Number(await read(target, abi, name));
  const bool = async (
    target: string,
    abi: Abi,
    name: string,
  ): Promise<boolean> => (await read(target, abi, name)) === true;
  const str = async (target: string, abi: Abi, name: string): Promise<string> =>
    String(await read(target, abi, name));

  function deployArgs(call: HooksLaunchDeployCall) {
    return [
      {
        projectOwner: call.request.projectOwner as Address,
        configVersion: call.request.configVersion,
        configHash: call.request.configHash as Hex,
        name: call.request.name,
        ticker: call.request.ticker,
        nftSaleStart: call.request.nftSaleStart,
        buybackRecipient: call.request.buybackRecipient as Address,
        deadline: call.request.deadline,
        memeSalt: call.request.memeSalt as Hex,
      },
      call.hookSalt as Hex,
      call.signature as Hex,
    ] as const;
  }

  async function estimate(data: Hex): Promise<bigint> {
    try {
      return await client.estimateGas({
        account: account.address,
        to: factory,
        data,
        value: 0n,
      });
    } catch (error) {
      const reason = revertReason(error);
      if (reason !== null) throw new HooksLaunchChainRevertError(reason);
      // estimateGas surfaces a revert without decoded data; re-run as a
      // call so the contract error name reaches the audit trail.
      try {
        await client.call({ account: account.address, to: factory, data });
      } catch (callError) {
        const callReason = revertReason(callError);
        if (callReason !== null)
          throw new HooksLaunchChainRevertError(callReason);
      }
      throw error;
    }
  }

  async function sign(
    data: Hex,
    tx: {
      readonly nonce: bigint;
      readonly gas: bigint;
      readonly gasPrice: bigint;
    },
  ) {
    if (tx.nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Executor nonce out of range");
    }
    const rawTx = await account.signTransaction({
      chainId: 97,
      type: "legacy",
      to: factory,
      data,
      value: 0n,
      nonce: Number(tx.nonce),
      gas: tx.gas,
      gasPrice: tx.gasPrice,
    });
    return { txHash: lower(keccak256(rawTx)), rawTx: lower(rawTx) };
  }

  /**
   * Decision 0119: `nftSaleDuration()`; on a pre-S141 Factory the selector
   * does not exist and the call reverts — that (and only a contract revert)
   * reads as the legacy 604,800 s. RPC failures propagate.
   */
  async function nftSaleDuration(): Promise<{
    readonly seconds: bigint;
    readonly legacy: boolean;
  }> {
    try {
      return {
        seconds: await big(factory, loopLaunchFactoryAbi, "nftSaleDuration"),
        legacy: false,
      };
    } catch (error) {
      if (
        revertReason(error) === null &&
        !(
          error instanceof BaseError &&
          error.walk(
            (cause) => cause instanceof ContractFunctionZeroDataError,
          ) !== null
        )
      ) {
        throw error;
      }
      return {
        seconds: hooksLaunchTemplateConstants.legacyNftSaleDurationSeconds,
        legacy: true,
      };
    }
  }

  async function readModules(
    launchId: string,
  ): Promise<HooksLaunchModules | null> {
    let raw: unknown;
    try {
      raw = await read(factory, loopLaunchFactoryAbi, "launchModules", [
        launchId,
      ]);
    } catch (error) {
      if (revertReason(error) !== null) return null;
      throw error;
    }
    const m = raw as Record<string, unknown> & {
      poolKey: Record<string, unknown>;
    };
    const a = (key: string): string => lower(String(m[key]));
    return {
      projectOwner: a("projectOwner"),
      configVersion: Number(m["configVersion"]),
      configHash: a("configHash"),
      meme: a("meme"),
      nft: a("nft"),
      snapshots: a("snapshots"),
      escrow: a("escrow"),
      gate: a("gate"),
      curve: a("curve"),
      graduationAdapter: a("graduationAdapter"),
      officialHook: a("officialHook"),
      buybackAdapter: a("buybackAdapter"),
      priceRecorder: a("priceRecorder"),
      buybackExecutor: a("buybackExecutor"),
      poolKey: {
        currency0: lower(String(m.poolKey["currency0"])),
        currency1: lower(String(m.poolKey["currency1"])),
        fee: Number(m.poolKey["fee"]),
        tickSpacing: Number(m.poolKey["tickSpacing"]),
        hooks: lower(String(m.poolKey["hooks"])),
      },
    };
  }

  const chain: HooksLaunchExecutorChain = {
    executorAddress: lower(account.address),
    factoryAddress: factory,
    async chainId() {
      return client.getChainId();
    },
    codeHash,
    async deploymentExecutor() {
      return address(factory, loopLaunchFactoryAbi, "deploymentExecutor");
    },
    async activationBufferSeconds() {
      return big(factory, loopLaunchFactoryAbi, "activationBufferSeconds");
    },
    async ownerNonce(projectOwner) {
      return big(factory, loopLaunchFactoryAbi, "nonces", [projectOwner]);
    },
    async launchIdByOwnerVersion(projectOwner, configVersion) {
      const key = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "uint32" }],
          [projectOwner as Address, configVersion],
        ),
      );
      return lower(
        String(
          await read(factory, loopLaunchFactoryAbi, "launchIdByOwnerVersion", [
            key,
          ]),
        ),
      );
    },
    async latestBlock() {
      const block = await client.getBlock({ blockTag: "latest" });
      return { number: block.number, timestamp: block.timestamp };
    },
    async blockHash(blockNumber) {
      try {
        const block = await client.getBlock({ blockNumber });
        return lower(block.hash);
      } catch (error) {
        if (
          error instanceof BaseError &&
          error.walk((cause) => cause instanceof BlockNotFoundError) !== null
        )
          return null;
        throw error;
      }
    },
    async transactionCount(blockTag) {
      return BigInt(
        await client.getTransactionCount({
          address: account.address,
          blockTag,
        }),
      );
    },
    async gasPrice() {
      return client.getGasPrice();
    },
    async estimateDeploy(call) {
      return estimate(
        encodeFunctionData({
          abi: loopLaunchFactoryAbi,
          functionName: "deployLaunch",
          args: deployArgs(call),
        }),
      );
    },
    async estimateActivate(launchId, configHash) {
      return estimate(
        encodeFunctionData({
          abi: loopLaunchFactoryAbi,
          functionName: "activateLaunch",
          args: [launchId as Hex, configHash as Hex],
        }),
      );
    },
    async signDeploy(call, tx) {
      return sign(
        encodeFunctionData({
          abi: loopLaunchFactoryAbi,
          functionName: "deployLaunch",
          args: deployArgs(call),
        }),
        tx,
      );
    },
    async signActivate(launchId, configHash, tx) {
      return sign(
        encodeFunctionData({
          abi: loopLaunchFactoryAbi,
          functionName: "activateLaunch",
          args: [launchId as Hex, configHash as Hex],
        }),
        tx,
      );
    },
    async sendRaw(rawTx) {
      try {
        await client.sendRawTransaction({
          serializedTransaction: rawTx as Hex,
        });
        return "accepted";
      } catch (error) {
        return classifyHooksLaunchSendError(error);
      }
    },
    async receipt(txHash): Promise<HooksLaunchReceipt | null> {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
      } catch (error) {
        if (
          error instanceof BaseError &&
          error.walk(
            (cause) => cause instanceof TransactionReceiptNotFoundError,
          ) !== null
        )
          return null;
        throw error;
      }
      let launchDeployed: HooksLaunchReceipt["launchDeployed"] = null;
      for (const log of receipt.logs) {
        if (lower(log.address) !== factory) continue;
        try {
          const decoded = decodeEventLog({
            abi: loopLaunchFactoryAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "LaunchDeployed") {
            const args = decoded.args;
            launchDeployed = {
              launchId: lower(args.launchId),
              projectOwner: lower(args.projectOwner),
              configVersion: Number(args.configVersion),
              configHash: lower(args.configHash),
              meme: lower(args.meme),
              nft: lower(args.nft),
              curve: lower(args.curve),
              hook: lower(args.hook),
              hookSalt: lower(args.hookSalt),
            };
          }
        } catch {
          // Not a Factory event of this ABI; ignored.
        }
      }
      return {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: lower(receipt.blockHash),
        launchDeployed,
      };
    },
    async gatePublished(gate) {
      return bool(gate, launchPublicationGateAbi, "published");
    },
    async readLaunch(launchId): Promise<HooksLaunchOnChainFacts> {
      const F = loopLaunchFactoryAbi;
      const [
        factoryCodeHash,
        poolManager,
        usd1,
        platformTaxReceiver,
        feeVault,
        primaryKeeper,
        fallbackKeeper,
        pauseAuthority,
        resumeAuthority,
        activationBufferSeconds,
        saleDuration,
        deployerRows,
        modules,
      ] = await Promise.all([
        codeHash(factory),
        address(factory, F, "poolManager"),
        address(factory, F, "usd1"),
        address(factory, F, "platformTaxReceiver"),
        address(factory, F, "feeVault"),
        address(factory, F, "primaryKeeper"),
        address(factory, F, "fallbackKeeper"),
        address(factory, F, "pauseAuthority"),
        address(factory, F, "resumeAuthority"),
        big(factory, F, "activationBufferSeconds"),
        nftSaleDuration(),
        Promise.all(
          (
            [
              ["token", "tokenDeployer", "tokenDeployerCodeHash"],
              ["v4", "v4Deployer", "v4DeployerCodeHash"],
              ["sale", "saleDeployer", "saleDeployerCodeHash"],
              ["buyback", "buybackDeployer", "buybackDeployerCodeHash"],
            ] as const
          ).map(async ([name, addressFn, hashFn]) => {
            const deployer = await address(factory, F, addressFn);
            const [pinned, actual] = await Promise.all([
              str(factory, F, hashFn),
              codeHash(deployer),
            ]);
            return {
              name,
              address: deployer,
              pinnedCodeHash: lower(pinned),
              actualCodeHash: actual,
            };
          }),
        ),
        readModules(launchId),
      ]);
      const factoryFacts = {
        poolManager,
        usd1,
        platformTaxReceiver,
        feeVault,
        primaryKeeper,
        fallbackKeeper,
        pauseAuthority,
        resumeAuthority,
        activationBufferSeconds,
        nftSaleDuration: saleDuration.seconds,
        nftSaleDurationLegacy: saleDuration.legacy,
        deployers: deployerRows,
      };
      if (modules === null) {
        return {
          factoryCodeHash,
          factory: factoryFacts,
          modules: null,
          codeHashes: {},
          meme: null,
          curve: null,
          hook: null,
          gate: null,
          nft: null,
          escrow: null,
          buyback: null,
          adapter: null,
          snapshots: null,
        };
      }
      const moduleAddresses = [
        modules.meme,
        modules.nft,
        modules.snapshots,
        modules.escrow,
        modules.gate,
        modules.curve,
        modules.graduationAdapter,
        modules.officialHook,
        modules.buybackAdapter,
        modules.priceRecorder,
        modules.buybackExecutor,
      ];
      const hashes = await Promise.all(moduleAddresses.map(codeHash));
      const codeHashes: Record<string, string | null> = {};
      moduleAddresses.forEach((moduleAddress, index) => {
        codeHashes[moduleAddress] = hashes[index] ?? null;
      });
      const M = memeTokenAbi;
      const C = curveEngineAbi;
      const H = officialTaxHookAbi;
      const G = launchPublicationGateAbi;
      const N = projectNFTAbi;
      const E = nftEscrowAbi;
      const B = buybackExecutorAbi;
      const A = officialV4GraduationAdapterAbi;
      const S = snapshotRegistryAbi;
      const [
        meme,
        curve,
        hook,
        gate,
        nft,
        escrow,
        buyback,
        adapter,
        snapshots,
      ] = await Promise.all([
        (async () => ({
          totalSupply: await big(modules.meme, M, "totalSupply"),
          templateTotalSupply: await big(modules.meme, M, "TOTAL_SUPPLY"),
          name: await str(modules.meme, M, "name"),
          symbol: await str(modules.meme, M, "symbol"),
          decimals: await num(modules.meme, M, "decimals"),
          launchFactory: await address(modules.meme, M, "launchFactory"),
          graduationAuthority: await address(
            modules.meme,
            M,
            "graduationAuthority",
          ),
          curve: await address(modules.meme, M, "curve"),
          graduated: await bool(modules.meme, M, "graduated"),
          curveBalance: await big(modules.meme, M, "balanceOf", [
            modules.curve,
          ]),
          adapterBalance: await big(modules.meme, M, "balanceOf", [
            modules.graduationAdapter,
          ]),
        }))(),
        (async () => ({
          buyTaxBps: await big(modules.curve, C, "BUY_TAX_BPS"),
          sellTaxBps: await big(modules.curve, C, "SELL_TAX_BPS"),
          maxCumulativeBuy: await big(modules.curve, C, "MAX_CUMULATIVE_BUY"),
          earlyRoundDuration: await big(
            modules.curve,
            C,
            "EARLY_ROUND_DURATION",
          ),
          meme: await address(modules.curve, C, "meme"),
          usd1: await address(modules.curve, C, "usd1"),
          snapshots: await address(modules.curve, C, "snapshots"),
          graduationAdapter: await address(
            modules.curve,
            C,
            "graduationAdapter",
          ),
          publicationGate: await address(modules.curve, C, "publicationGate"),
          platformTaxReceiver: await address(
            modules.curve,
            C,
            "platformTaxReceiver",
          ),
          soldSupply: await big(modules.curve, C, "soldSupply"),
          accountedReserve: await big(modules.curve, C, "accountedReserve"),
          graduated: await bool(modules.curve, C, "graduated"),
        }))(),
        (async () => ({
          taxBps: await big(modules.officialHook, H, "TAX_BPS"),
          poolManager: await address(modules.officialHook, H, "poolManager"),
          feeVault: await address(modules.officialHook, H, "feeVault"),
          poolInitializer: await address(
            modules.officialHook,
            H,
            "poolInitializer",
          ),
          expectedInitialSqrtPriceX96: await big(
            modules.officialHook,
            H,
            "expectedInitialSqrtPriceX96",
          ),
          currency0: await address(modules.officialHook, H, "currency0"),
          currency1: await address(modules.officialHook, H, "currency1"),
          lpFee: await num(modules.officialHook, H, "lpFee"),
          tickSpacing: await num(modules.officialHook, H, "tickSpacing"),
        }))(),
        (async () => ({
          launchId: lower(await str(modules.gate, G, "launchId")),
          configHash: lower(await str(modules.gate, G, "configHash")),
          nftSaleStart: await big(modules.gate, G, "nftSaleStart"),
          activationBufferSeconds: await big(
            modules.gate,
            G,
            "activationBufferSeconds",
          ),
          deployExecutor: await address(modules.gate, G, "deployExecutor"),
          published: await bool(modules.gate, G, "published"),
        }))(),
        (async () => ({
          price: await big(modules.nft, N, "PRICE"),
          saleDuration: await big(modules.nft, N, "SALE_DURATION"),
          launchId: lower(await str(modules.nft, N, "launchId")),
          usd1: await address(modules.nft, N, "usd1"),
          publicationGate: await address(modules.nft, N, "publicationGate"),
          escrow: await address(modules.nft, N, "escrow"),
          saleStart: await big(modules.nft, N, "saleStart"),
          saleEnd: await big(modules.nft, N, "saleEnd"),
          totalMinted: await big(modules.nft, N, "totalMinted"),
        }))(),
        (async () => ({
          usd1: await address(modules.escrow, E, "usd1"),
          launchFactory: await address(modules.escrow, E, "launchFactory"),
          projectNft: await address(modules.escrow, E, "projectNft"),
          buybackExecutor: await address(modules.escrow, E, "buybackExecutor"),
        }))(),
        (async () => ({
          usd1: await address(modules.buybackExecutor, B, "usd1"),
          meme: await address(modules.buybackExecutor, B, "meme"),
          budget: await address(modules.buybackExecutor, B, "budget"),
          swapAdapter: await address(modules.buybackExecutor, B, "swapAdapter"),
          recipient: await address(modules.buybackExecutor, B, "recipient"),
          primaryKeeper: await address(
            modules.buybackExecutor,
            B,
            "primaryKeeper",
          ),
          fallbackKeeper: await address(
            modules.buybackExecutor,
            B,
            "fallbackKeeper",
          ),
          pauseAuthority: await address(
            modules.buybackExecutor,
            B,
            "pauseAuthority",
          ),
          resumeAuthority: await address(
            modules.buybackExecutor,
            B,
            "resumeAuthority",
          ),
        }))(),
        (async () => ({
          lpMemeAllocation: await big(
            modules.graduationAdapter,
            A,
            "LP_MEME_ALLOCATION",
          ),
          lpFee: await num(modules.graduationAdapter, A, "LP_FEE"),
          tickSpacing: await num(modules.graduationAdapter, A, "TICK_SPACING"),
          launchFactory: await address(
            modules.graduationAdapter,
            A,
            "launchFactory",
          ),
          poolManager: await address(
            modules.graduationAdapter,
            A,
            "poolManager",
          ),
          usd1: await address(modules.graduationAdapter, A, "usd1"),
          currency0: await address(modules.graduationAdapter, A, "currency0"),
          currency1: await address(modules.graduationAdapter, A, "currency1"),
          meme: await address(modules.graduationAdapter, A, "meme"),
          curve: await address(modules.graduationAdapter, A, "curve"),
          projectBound: await bool(
            modules.graduationAdapter,
            A,
            "projectBound",
          ),
          finalized: await bool(modules.graduationAdapter, A, "finalized"),
        }))(),
        (async () => ({
          launchId: lower(await str(modules.snapshots, S, "launchId")),
          nft: await address(modules.snapshots, S, "nft"),
          nftSaleEnd: await big(modules.snapshots, S, "nftSaleEnd"),
        }))(),
      ]);
      return {
        factoryCodeHash,
        factory: factoryFacts,
        modules,
        codeHashes,
        meme,
        curve,
        hook,
        gate,
        nft,
        escrow,
        buyback,
        adapter,
        snapshots,
      };
    },
  };
  return Object.freeze(chain);
}
