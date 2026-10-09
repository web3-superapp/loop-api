import type { AccountWalletRepository } from "../../database/account-wallet-repository.js";
import { getCreate2Address } from "viem";
import type { HooksLaunchProjectConfigRepository } from "./hooks-launch-project-config.js";
import {
  createHooksLaunchDeploymentTypedData,
  hooksLaunchId,
  mineMemeAddressSaltAsync,
  mineHooksLaunchSaltAsync,
} from "./hooks-launch-deployment-crypto.js";

export interface HooksLaunchFactoryReader {
  readonly factoryAddress: string;
  readonly chainId: number;
  nonce(projectOwner: string): Promise<bigint>;
  tokenDeployment(request: {
    readonly name: string;
    readonly ticker: string;
  }): Promise<{ readonly deployer: string; readonly initCodeHash: string }>;
  hookDeployment(request: {
    readonly projectOwner: string;
    readonly configVersion: number;
    readonly configHash: string;
    readonly name: string;
    readonly ticker: string;
    readonly nftSaleStart: string;
    readonly buybackRecipient: string;
    readonly deadline: string;
    readonly memeSalt: string;
  }): Promise<{ readonly deployer: string; readonly initCodeHash: string }>;
}

export interface HooksLaunchDeploymentService {
  prepareSigningRequest(input: {
    readonly ownerUserId: string;
    readonly projectId: string;
    readonly walletId: string;
  }): Promise<{
    readonly request: {
      readonly projectOwner: string;
      readonly configVersion: number;
      readonly configHash: string;
      readonly name: string;
      readonly ticker: string;
      readonly nftSaleStart: string;
      readonly buybackRecipient: string;
      readonly deadline: string;
      readonly memeSalt: string;
      readonly nonce: string;
    };
    readonly typedData: ReturnType<typeof createHooksLaunchDeploymentTypedData>;
    readonly hookDeployer: string;
    readonly hookInitCodeHash: string;
    readonly hookSalt: string;
    readonly hookAddress: string;
    readonly memeDeployer: string;
    readonly memeInitCodeHash: string;
    readonly memeAddress: string;
  }>;
}

export function createHooksLaunchDeploymentService(input: {
  readonly configs: HooksLaunchProjectConfigRepository | null;
  readonly wallets: AccountWalletRepository | null;
  readonly reader: HooksLaunchFactoryReader | null;
  readonly now?: () => number;
  readonly signatureLifetimeSeconds: number;
  readonly maxSaltAttempts: number;
}): HooksLaunchDeploymentService {
  const now = input.now ?? (() => Math.floor(Date.now() / 1_000));
  let activePreparations = 0;
  const prepareSigningRequest: HooksLaunchDeploymentService["prepareSigningRequest"] =
    async (request) => {
      const { reader, configs, wallets } = input;
      if (
        reader === null ||
        configs === null ||
        wallets === null ||
        reader.chainId !== 97
      ) {
        throw new Error("Hooks launch deployment unavailable");
      }
      if (
        !Number.isSafeInteger(input.signatureLifetimeSeconds) ||
        input.signatureLifetimeSeconds < 60 ||
        input.signatureLifetimeSeconds > 3_600 ||
        !Number.isSafeInteger(input.maxSaltAttempts) ||
        input.maxSaltAttempts < 1
      ) {
        throw new Error("Hooks launch deployment policy invalid");
      }
      const wallet = await wallets.get(request.ownerUserId, request.walletId);
      if (wallet === null || wallet.status !== "active" || !wallet.isActive) {
        throw new Error("Hooks launch signing wallet unavailable");
      }
      const draft = await configs.getOwnedDraft({
        projectId: request.projectId,
        ownerUserId: request.ownerUserId,
      });
      if (draft === null) throw new Error("Hooks launch project not found");
      if (
        !Number.isSafeInteger(draft.version) ||
        draft.version < 1 ||
        draft.version > 0xffff_ffff
      ) {
        throw new Error("Hooks launch config version invalid");
      }
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new Error("Hooks launch clock unavailable");
      }
      const deadline = String(timestamp + input.signatureLifetimeSeconds);
      const projectOwner = wallet.address.toLowerCase();
      const requestFields = {
        projectOwner,
        configVersion: draft.version,
        configHash: draft.config.configHash.toLowerCase(),
        name: draft.config.name,
        ticker: draft.config.ticker.toUpperCase(),
        nftSaleStart: draft.config.nftSaleStartAt,
        buybackRecipient: draft.config.buybackRecipient.toLowerCase(),
        deadline,
      };
      const nonce = await reader.nonce(projectOwner);
      if (nonce < 0n || nonce >= 1n << 256n) {
        throw new Error("Hooks launch factory nonce invalid");
      }
      const launchId = hooksLaunchId({
        chainId: reader.chainId,
        factory: reader.factoryAddress,
        projectOwner,
        configVersion: draft.version,
        configHash: requestFields.configHash,
      });
      const tokenDeployment = await reader.tokenDeployment({
        name: requestFields.name,
        ticker: requestFields.ticker,
      });
      const meme = await mineMemeAddressSaltAsync({
        deployer: tokenDeployment.deployer,
        launchId,
        initCodeHash: tokenDeployment.initCodeHash,
        maxAttempts: input.maxSaltAttempts,
      });
      const requestWithMemeSalt = {
        ...requestFields,
        memeSalt: meme.salt,
      };
      const hook = await reader.hookDeployment(requestWithMemeSalt);
      const hookSalt = await mineHooksLaunchSaltAsync({
        deployer: hook.deployer,
        initCodeHash: hook.initCodeHash,
        maxAttempts: input.maxSaltAttempts,
      });
      const typedData = createHooksLaunchDeploymentTypedData({
        chainId: reader.chainId,
        verifyingContract: reader.factoryAddress,
        request: {
          ...requestWithMemeSalt,
          nonce: nonce.toString(),
        },
      });
      const hookAddress = getCreate2Address({
        from: hook.deployer as `0x${string}`,
        salt: hookSalt,
        bytecodeHash: hook.initCodeHash as `0x${string}`,
      });
      return Object.freeze({
        request: Object.freeze({
          ...requestFields,
          memeSalt: meme.salt,
          deadline,
          nonce: nonce.toString(),
        }),
        typedData,
        hookDeployer: hook.deployer,
        hookInitCodeHash: hook.initCodeHash,
        hookSalt,
        hookAddress,
        memeDeployer: tokenDeployment.deployer,
        memeInitCodeHash: tokenDeployment.initCodeHash,
        memeAddress: meme.address,
      });
    };
  return Object.freeze({
    async prepareSigningRequest(request) {
      // Bound CPU and RPC work per process; rejected callers can retry later.
      if (activePreparations >= 4)
        throw new Error("Hooks launch deployment busy; retry later");
      activePreparations += 1;
      try {
        return await prepareSigningRequest(request);
      } finally {
        activePreparations -= 1;
      }
    },
  } satisfies HooksLaunchDeploymentService);
}
