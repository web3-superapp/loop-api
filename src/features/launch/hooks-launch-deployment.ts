import type { AccountWalletRepository } from "../../database/account-wallet-repository.js";
import { getCreate2Address } from "viem";
import {
  launchSlotRefusal,
  testnetLaunchSlot,
  type LaunchSlotPolicy,
} from "../chain/chain-contract.js";
import {
  HooksLaunchBuybackRecipientFixedError,
  assertHooksLaunchFixedBuybackRecipient,
  hooksLaunchFactorySupportsTicker,
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
  hooksLaunchLoopDynamicHookPermissionBits,
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
   * Decision 0164: which ticker text rule the Factory enforces, probed on
   * chain (immutable; cached): `utf8` = the S242 `LaunchText` floor (any
   * script, case kept), `ascii` = the earlier `^[A-Z0-9]{2,12}$`. Rejects
   * when unreadable. Absent = treated as `ascii` (fail closed).
   */
  tickerTextRule?(): Promise<"utf8" | "ascii">;
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
       * Decision 0164: the ticker is not `^[A-Z0-9]{2,12}$` and the target
       * Factory predates S242 (422 HOOKS_LAUNCH_TICKER_UNSUPPORTED_BY_FACTORY).
       */
      | "ticker_unsupported"
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

/**
 * Decision 0160: the wall-clock budget for every chain read of one
 * signing-request preparation (same 8 s as the submission, Decision 0155),
 * well inside the 15 s `handlerTimeout`. A slow or hanging RPC ends the
 * request with 503 HOOKS_LAUNCH_FACTORY_UNAVAILABLE instead of the handler
 * timing out while it keeps running. The preparation never writes, so a
 * timeout leaves nothing behind.
 */
export const hooksLaunchSigningRequestChainBudgetMs = 8_000;

export function createHooksLaunchDeploymentService(input: {
  readonly configs: HooksLaunchProjectConfigRepository | null;
  readonly wallets: AccountWalletRepository | null;
  readonly reader: HooksLaunchFactoryReader | null;
  readonly now?: () => number;
  readonly signatureLifetimeSeconds: number;
  readonly maxSaltAttempts: number;
  /** Decision 0122: `LAUNCH2_BUYBACK_RECIPIENT`; null fails closed. */
  readonly fixedBuybackRecipient?: string | null;
  /**
   * Decision 0150: the configured launch slot (absent = BSC Testnet). The
   * reader must be on it, and chain 56 needs `LAUNCH_MAINNET_ACK`.
   */
  readonly launchSlot?: LaunchSlotPolicy;
  /** Decision 0160: chain-read budget per preparation (test seam). */
  readonly chainBudgetMs?: number;
}): HooksLaunchDeploymentService {
  const now = input.now ?? (() => Math.floor(Date.now() / 1_000));
  const chainBudgetMs =
    input.chainBudgetMs ?? hooksLaunchSigningRequestChainBudgetMs;
  let activePreparations = 0;
  const prepareSigningRequest: HooksLaunchDeploymentService["prepareSigningRequest"] =
    async (request) => {
      const { reader, configs, wallets } = input;
      if (
        reader === null ||
        configs === null ||
        wallets === null ||
        launchSlotRefusal(
          input.launchSlot ?? testnetLaunchSlot,
          reader.chainId,
        ) !== null
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
      // Decision 0160: one deadline for all chain reads of this request.
      const chainDeadline = Date.now() + chainBudgetMs;
      const withinChainBudget = <T>(work: Promise<T>): Promise<T> => {
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new HooksLaunchDeploymentError(
                  "unavailable",
                  "Hooks launch factory read timed out",
                ),
              ),
            Math.max(0, chainDeadline - Date.now()),
          );
        });
        return Promise.race([work, expired]).finally(() => clearTimeout(timer));
      };
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
        // Decision 0164: signed exactly as stored (never upper-cased).
        ticker: draft.config.ticker,
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
      // Decision 0160: the independent Factory reads run concurrently under
      // the request's chain budget; results are still checked in the
      // original order (template, owner version, nonce, MEME deployer).
      const loopDynamic = reader.hookKind === "loopDynamic";
      const [
        templateCheck,
        usedByRead,
        nonceRead,
        tokenRead,
        templateRead,
        tickerRead,
      ] = await withinChainBudget(
        Promise.allSettled([
          assertHooksLaunchFactoryTemplate(
            reader,
            draft.config,
            () =>
              new HooksLaunchDeploymentError(
                "template_mismatch",
                "Hooks launch config template differs from the Factory",
              ),
          ),
          reader.ownerVersionLaunchId(projectOwner, draft.version),
          reader.nonce(projectOwner),
          reader.tokenDeployment({
            name: requestFields.name,
            ticker: requestFields.ticker,
          }),
          loopDynamic
            ? readHooksLaunchFactoryTemplate(reader)
            : Promise.resolve(null),
          // Decision 0164: the transition gate (no read for a legacy ticker).
          hooksLaunchFactorySupportsTicker(reader, requestFields.ticker),
        ]),
      );
      const settled = <T>(result: PromiseSettledResult<T>): T => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      };
      settled(templateCheck);
      if (tickerRead.status === "rejected") {
        throw new HooksLaunchDeploymentError(
          "unavailable",
          "Hooks launch factory ticker rule unreadable",
        );
      }
      if (!tickerRead.value) {
        throw new HooksLaunchDeploymentError(
          "ticker_unsupported",
          "Hooks launch ticker not supported by the Factory",
        );
      }
      // Decision 0127: never hand out a signature the Factory would reject
      // with VersionAlreadyUsed.
      const usedBy = settled(usedByRead);
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
      const nonce = settled(nonceRead);
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
      const tokenDeployment = settled(tokenRead);
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
      // The Hook init code binds the mined MEME salt, so this read follows
      // the search; it still counts against the same wall-clock deadline.
      const hook = await withinChainBudget(
        reader.hookDeployment(requestWithMemeSalt),
      );
      // Decision 0132: LoopDynamic Hooks carry their Factory's bits (salt
      // ≠ 0) — Decision 0152: 0x10CC for an S209 Factory, 0x10C4 before.
      const template = settled(templateRead);
      const hookSalt = await mineHooksLaunchSaltAsync({
        deployer: hook.deployer,
        initCodeHash: hook.initCodeHash,
        maxAttempts: input.maxSaltAttempts,
        ...(loopDynamic
          ? {
              hookKind: "loopDynamic" as const,
              ...(template?.loopDynamic === undefined
                ? {}
                : {
                    permissionBits: hooksLaunchLoopDynamicHookPermissionBits(
                      template.loopDynamic,
                    ),
                  }),
            }
          : {}),
      });
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
