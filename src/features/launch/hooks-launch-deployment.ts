import type { AccountWalletRepository } from "../../database/account-wallet-repository.js";
import { getCreate2Address } from "viem";
import {
  HooksLaunchBuybackRecipientFixedError,
  assertHooksLaunchFixedBuybackRecipient,
  type HooksLaunchProjectConfigRepository,
} from "./hooks-launch-project-config.js";
import {
  createHooksLaunchDeploymentTypedData,
  withHooksLaunchEip712Domain,
  hooksLaunchId,
  mineMemeAddressSaltAsync,
  mineHooksLaunchSaltAsync,
} from "./hooks-launch-deployment-crypto.js";
import {
  hooksLaunchTemplateHash,
  type HooksLaunchLoopDynamicParams,
} from "./hooks-launch-config.js";

export interface HooksLaunchFactoryReader {
  readonly factoryAddress: string;
  readonly chainId: number;
  /**
   * Decision 0132: the target Factory's Hook kind (absent = officialTax).
   * `loopDynamic` readers also answer `loopDynamicTemplate()`.
   */
  readonly hookKind?: "officialTax" | "loopDynamic";
  /**
   * Decision 0132: a LoopDynamic Factory's Hook parameters and its
   * `TEMPLATE_HASH`, verified equal to
   * `hooksLaunchLoopDynamicTemplateHash(params)` (immutable; cached).
   */
  loopDynamicTemplate?(): Promise<{
    readonly params: HooksLaunchLoopDynamicParams;
    readonly templateHash: string;
  }>;
  nonce(projectOwner: string): Promise<bigint>;
  /**
   * Decision 0127: the Factory's `launchIdByOwnerVersion(keccak(owner,
   * version))` — the zero bytes32 while that pair is unused.
   */
  ownerVersionLaunchId(
    projectOwner: string,
    configVersion: number,
  ): Promise<string>;
  /**
   * Decision 0119: the Factory's immutable `nftSaleDuration()`; a pre-S141
   * Factory without the function reads as 604,800 s with `legacy: true`.
   */
  nftSaleDuration(): Promise<{
    readonly seconds: number;
    readonly legacy: boolean;
  }>;
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

/**
 * Decision 0108: typed preparation failures so the route never classifies
 * by message text. `unavailable` covers missing configuration, Factory/RPC
 * reads, and an exhausted salt search; `busy` is admission control.
 * `template_mismatch` (Decision 0119): the saved config's
 * `fixedEconomics.nftSaleDurationSeconds` is not the target Factory's
 * `nftSaleDuration()`, so its configHash binds another template.
 */
export class HooksLaunchDeploymentError extends Error {
  constructor(
    readonly kind:
      | "not_found"
      | "invalid"
      | "unavailable"
      | "busy"
      | "template_mismatch"
      /** Decision 0122: the draft names another buyback recipient. */
      | "recipient_fixed"
      /** Decision 0122: LAUNCH2_BUYBACK_RECIPIENT is not configured. */
      | "recipient_unavailable"
      /**
       * Decision 0127: this wallet already deployed this config version
       * (another project of the owner, saved before versions were
       * allocated per owner); saving the config again allocates a new one.
       */
      | "version_used",
    message: string,
  ) {
    super(message);
    this.name = "HooksLaunchDeploymentError";
  }
}

/**
 * Decision 0119: the project-signed configHash covers
 * `fixedEconomics.nftSaleDurationSeconds`; it must be the target Factory's
 * `nftSaleDuration()` or the signature would approve a sale period the
 * chain does not run. A Factory read failure propagates (unavailable).
 */
export async function assertHooksLaunchFactoryTemplate(
  reader: Pick<
    HooksLaunchFactoryReader,
    "nftSaleDuration" | "hookKind" | "loopDynamicTemplate"
  >,
  config: {
    readonly fixedEconomics?: { readonly nftSaleDurationSeconds?: unknown };
    readonly templateHash?: unknown;
    readonly poolHookKind?: unknown;
  },
  mismatch: () => Error,
): Promise<void> {
  const factory = await reader.nftSaleDuration();
  if (config.fixedEconomics?.nftSaleDurationSeconds !== factory.seconds) {
    throw mismatch();
  }
  // Decision 0132: the configHash also binds the Hook kind's template. A
  // LoopDynamic config is never signed for an OfficialTax Factory, and a
  // LoopDynamic Factory only signs configs hashed for its own parameters.
  if (reader.hookKind === "loopDynamic") {
    const template = await readHooksLaunchFactoryTemplate(reader);
    if (
      config.poolHookKind !== "loopDynamic" ||
      typeof config.templateHash !== "string" ||
      config.templateHash.toLowerCase() !== template.templateHash
    ) {
      throw mismatch();
    }
  } else if (config.poolHookKind === "loopDynamic") {
    throw mismatch();
  }
}

/** Decision 0132: what a config save hashes for the target Factory. */
export interface HooksLaunchFactoryTemplate {
  readonly hookKind: "officialTax" | "loopDynamic";
  /** Lower-case `TEMPLATE_HASH` the project signs. */
  readonly templateHash: string;
  /** Present for a LoopDynamic Factory only. */
  readonly loopDynamic?: HooksLaunchLoopDynamicParams;
}

/**
 * Decision 0132: the target Factory's template. OfficialTax: the constant
 * `keccak256("hooks_launch_v1")` (no chain read, unchanged). LoopDynamic:
 * the verified on-chain parameters; a reader that cannot answer throws
 * (the caller maps it to unavailable).
 */
export async function readHooksLaunchFactoryTemplate(
  reader: Pick<HooksLaunchFactoryReader, "hookKind" | "loopDynamicTemplate">,
): Promise<HooksLaunchFactoryTemplate> {
  if (reader.hookKind !== "loopDynamic") {
    return { hookKind: "officialTax", templateHash: hooksLaunchTemplateHash };
  }
  if (reader.loopDynamicTemplate === undefined) {
    throw new Error("LoopDynamic Factory template unavailable");
  }
  const read = await reader.loopDynamicTemplate();
  if (!/^0x[0-9a-fA-F]{64}$/u.test(read.templateHash)) {
    throw new Error("LoopDynamic Factory template unavailable");
  }
  return {
    hookKind: "loopDynamic",
    templateHash: read.templateHash.toLowerCase(),
    loopDynamic: read.params,
  };
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
    /** Decision 0120: `types` also carry the standard `EIP712Domain`. */
    readonly typedData: ReturnType<
      typeof withHooksLaunchEip712Domain<
        ReturnType<typeof createHooksLaunchDeploymentTypedData>
      >
    >;
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
  /** Decision 0122: `LAUNCH2_BUYBACK_RECIPIENT`; null fails closed. */
  readonly fixedBuybackRecipient?: string | null;
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
        throw new HooksLaunchDeploymentError(
          "unavailable",
          "Hooks launch deployment unavailable",
        );
      }
      if (
        !Number.isSafeInteger(input.signatureLifetimeSeconds) ||
        input.signatureLifetimeSeconds < 60 ||
        input.signatureLifetimeSeconds > 3_600 ||
        !Number.isSafeInteger(input.maxSaltAttempts) ||
        input.maxSaltAttempts < 1
      ) {
        throw new HooksLaunchDeploymentError(
          "unavailable",
          "Hooks launch deployment policy invalid",
        );
      }
      const wallet = await wallets.get(request.ownerUserId, request.walletId);
      if (wallet === null || wallet.status !== "active" || !wallet.isActive) {
        throw new HooksLaunchDeploymentError(
          "invalid",
          "Hooks launch signing wallet unavailable",
        );
      }
      const draft = await configs.getOwnedDraft({
        projectId: request.projectId,
        ownerUserId: request.ownerUserId,
      });
      if (draft === null) {
        throw new HooksLaunchDeploymentError(
          "not_found",
          "Hooks launch project not found",
        );
      }
      if (
        !Number.isSafeInteger(draft.version) ||
        draft.version < 1 ||
        draft.version > 0xffff_ffff
      ) {
        throw new HooksLaunchDeploymentError(
          "invalid",
          "Hooks launch config version invalid",
        );
      }
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new HooksLaunchDeploymentError(
          "unavailable",
          "Hooks launch clock unavailable",
        );
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
      // Decision 0122: an older draft naming another recipient is never
      // signed; the owner saves a new version with the fixed address.
      try {
        assertHooksLaunchFixedBuybackRecipient(
          input.fixedBuybackRecipient ?? null,
          draft.config.buybackRecipient,
        );
      } catch (error) {
        throw new HooksLaunchDeploymentError(
          error instanceof HooksLaunchBuybackRecipientFixedError
            ? "recipient_fixed"
            : "recipient_unavailable",
          "Hooks launch buyback recipient is fixed by the platform",
        );
      }
      await assertHooksLaunchFactoryTemplate(
        reader,
        draft.config,
        () =>
          new HooksLaunchDeploymentError(
            "template_mismatch",
            "Hooks launch config template differs from the Factory",
          ),
      );
      // Decision 0127: never hand out a signature the Factory would reject
      // with VersionAlreadyUsed.
      const usedBy = await reader.ownerVersionLaunchId(
        projectOwner,
        draft.version,
      );
      if (!/^0x[0-9a-f]{64}$/.test(usedBy.toLowerCase())) {
        throw new HooksLaunchDeploymentError(
          "unavailable",
          "Hooks launch factory owner version unreadable",
        );
      }
      if (!/^0x0{64}$/.test(usedBy.toLowerCase())) {
        throw new HooksLaunchDeploymentError(
          "version_used",
          "Hooks launch config version already deployed by this wallet",
        );
      }
      const nonce = await reader.nonce(projectOwner);
      if (nonce < 0n || nonce >= 1n << 256n) {
        throw new HooksLaunchDeploymentError(
          "unavailable",
          "Hooks launch factory nonce invalid",
        );
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
      // Decision 0132: LoopDynamic Hooks carry bits 0x10C4 (salt ≠ 0).
      const loopDynamic = reader.hookKind === "loopDynamic";
      const hookSalt = await mineHooksLaunchSaltAsync({
        deployer: hook.deployer,
        initCodeHash: hook.initCodeHash,
        maxAttempts: input.maxSaltAttempts,
        ...(loopDynamic ? { hookKind: "loopDynamic" as const } : {}),
      });
      const template = loopDynamic
        ? await readHooksLaunchFactoryTemplate(reader)
        : null;
      const typedData = createHooksLaunchDeploymentTypedData({
        chainId: reader.chainId,
        verifyingContract: reader.factoryAddress,
        request: {
          ...requestWithMemeSalt,
          nonce: nonce.toString(),
        },
        ...(template === null ? {} : { templateHash: template.templateHash }),
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
        typedData: withHooksLaunchEip712Domain(typedData),
        hookDeployer: hook.deployer.toLowerCase(),
        hookInitCodeHash: hook.initCodeHash.toLowerCase(),
        hookSalt,
        hookAddress: hookAddress.toLowerCase(),
        memeDeployer: tokenDeployment.deployer.toLowerCase(),
        memeInitCodeHash: tokenDeployment.initCodeHash.toLowerCase(),
        memeAddress: meme.address.toLowerCase(),
      });
    };
  return Object.freeze({
    async prepareSigningRequest(request) {
      // Bound CPU and RPC work per process; rejected callers can retry later.
      if (activePreparations >= 4) {
        throw new HooksLaunchDeploymentError(
          "busy",
          "Hooks launch deployment busy; retry later",
        );
      }
      activePreparations += 1;
      try {
        return await prepareSigningRequest(request);
      } catch (error) {
        // Factory/RPC reads and an exhausted salt search are unavailability,
        // never a client error and never a weakened requirement.
        if (error instanceof HooksLaunchDeploymentError) throw error;
        throw new HooksLaunchDeploymentError(
          "unavailable",
          "Hooks launch deployment unavailable",
        );
      } finally {
        activePreparations -= 1;
      }
    },
  } satisfies HooksLaunchDeploymentService);
}
