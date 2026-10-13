import { z } from "zod";
import {
  concatHex,
  getCreate2Address,
  hashTypedData,
  keccak256,
  recoverAddress,
  toBytes,
  type Hex,
} from "viem";
import type { AccountWalletRepository } from "../../database/account-wallet-repository.js";
import {
  HooksLaunchBuybackRecipientFixedError,
  assertHooksLaunchFixedBuybackRecipient,
  type HooksLaunchProjectConfigRepository,
} from "./hooks-launch-project-config.js";
import {
  assertHooksLaunchFactoryTemplate,
  readHooksLaunchFactoryTemplate,
  type HooksLaunchFactoryReader,
} from "./hooks-launch-deployment.js";
import type { HooksLaunchDeploymentStatus } from "./hooks-launch-deployment-status.js";
import {
  createHooksLaunchDeploymentTypedData,
  hooksLaunchHookPermissionBits,
  hooksLaunchId,
  type HooksLaunchTypedRequestInput,
} from "./hooks-launch-deployment-crypto.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(78);
export const hooksLaunchSubmissionSchema = z
  .object({
    walletId: z.string().min(1).max(128),
    request: z
      .object({
        configHash: hex32,
        projectOwner: address,
        configVersion: z.number().int().min(1).max(0xffff_ffff),
        name: z.string().min(1).max(64),
        ticker: z.string().regex(/^[A-Z0-9]{2,12}$/),
        nftSaleStart: uint,
        buybackRecipient: address,
        deadline: uint,
        memeSalt: hex32,
        nonce: uint,
      })
      .strict(),
    hookSalt: hex32,
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  })
  .strict();
export type HooksLaunchSignedSubmission = z.infer<
  typeof hooksLaunchSubmissionSchema
>;
/**
 * Decision 0108 binding hash of a task: everything the project signed
 * except the deadline (renewals keep the task), plus the Hook salt and both
 * CREATE2 predictions. Decision 0112: the executor recomputes it to bind a
 * stored authorization to its task before using it.
 */
export function hooksLaunchBindingHash(input: {
  readonly factoryAddress: string;
  readonly request: HooksLaunchTypedRequestInput;
  readonly hookSalt: string;
  readonly memeAddress: string;
  readonly hookAddress: string;
}): string {
  const stableRequest = {
    ...input.request,
    deadline: undefined,
    configHash: input.request.configHash.toLowerCase(),
    projectOwner: input.request.projectOwner.toLowerCase(),
    buybackRecipient: input.request.buybackRecipient.toLowerCase(),
    memeSalt: input.request.memeSalt.toLowerCase(),
  };
  return keccak256(
    toBytes(
      JSON.stringify([
        input.factoryAddress.toLowerCase(),
        stableRequest,
        input.hookSalt.toLowerCase(),
        input.memeAddress.toLowerCase(),
        input.hookAddress.toLowerCase(),
      ]),
    ),
  );
}

export interface HooksLaunchDeploymentEventView {
  readonly sequence: number;
  readonly fromStatus: HooksLaunchDeploymentStatus | null;
  readonly toStatus: HooksLaunchDeploymentStatus;
  readonly kind: string;
  readonly txHash: string | null;
  /** Decimal string. */
  readonly blockNumber: string | null;
  readonly blockHash: string | null;
  readonly confirmations: number | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
}
export interface HooksLaunchDeployedAddresses {
  readonly launchId: string;
  readonly meme: string;
  readonly hook: string;
  readonly nft: string;
  readonly curve: string;
  readonly gate: string;
  readonly escrow: string;
  readonly snapshots: string;
  readonly graduationAdapter: string;
  readonly buybackAdapter: string;
  readonly priceRecorder: string;
  readonly buybackExecutor: string;
}
export interface HooksLaunchDeploymentJob {
  readonly jobId: string;
  readonly projectId: string;
  readonly configVersion: number;
  readonly chainId: 97;
  readonly factoryAddress: string;
  readonly status: HooksLaunchDeploymentStatus;
  /** Predicted (EIP-712-bound) MEME address; S125 meaning unchanged. */
  readonly memeAddress: string;
  /** Predicted (EIP-712-bound) Hook address; S125 meaning unchanged. */
  readonly hookAddress: string;
  /** Decision 0112: the persisted `deployLaunch` transaction hash. */
  readonly txHash: string | null;
  /** Confirmations of `txHash` last observed by the executor. */
  readonly confirmations: number | null;
  readonly activationTxHash: string | null;
  readonly addresses: {
    readonly predicted: { readonly meme: string; readonly hook: string };
    /** Read back from the Factory after verification; null before. */
    readonly deployed: HooksLaunchDeployedAddresses | null;
  };
  readonly failure: {
    readonly code: string;
    readonly retryable: boolean;
  } | null;
  readonly attemptCount: number;
  readonly events: readonly HooksLaunchDeploymentEventView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface AcceptHooksLaunchSubmission {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly factoryAddress: string;
  readonly request: HooksLaunchTypedRequestInput;
  readonly signedPayload: HooksLaunchSignedSubmission;
  readonly memeAddress: string;
  readonly hookAddress: string;
}
export interface HooksLaunchSubmissionRepository {
  cancelOwned(
    ownerUserId: string,
    projectId: string,
    jobId: string,
  ): Promise<HooksLaunchDeploymentJob | null>;
  findReplay(
    ownerUserId: string,
    idempotencyKey: string,
  ): Promise<{
    readonly fingerprint: string;
    readonly job: HooksLaunchDeploymentJob;
  } | null>;
  accept(input: AcceptHooksLaunchSubmission): Promise<HooksLaunchDeploymentJob>;
  getOwned(
    ownerUserId: string,
    projectId: string,
    jobId: string,
  ): Promise<HooksLaunchDeploymentJob | null>;
}
export class HooksLaunchSubmissionError extends Error {
  constructor(
    readonly kind:
      | "invalid"
      | "conflict"
      | "idempotency_conflict"
      | "not_found"
      | "not_approved"
      | "not_cancellable"
      | "template_mismatch"
      /** Decision 0122: the draft names another buyback recipient. */
      | "recipient_fixed"
      /** Decision 0122: LAUNCH2_BUYBACK_RECIPIENT is not configured. */
      | "recipient_unavailable"
      | "unavailable",
  ) {
    super(`Hooks launch submission ${kind}`);
  }
}
export interface HooksLaunchSubmissionService {
  cancelOwned(
    ownerUserId: string,
    projectId: string,
    jobId: string,
  ): Promise<HooksLaunchDeploymentJob | null>;
  submit(input: {
    readonly ownerUserId: string;
    readonly projectId: string;
    readonly idempotencyKey: string;
    readonly body: unknown;
  }): Promise<HooksLaunchDeploymentJob>;
  getOwned(
    ownerUserId: string,
    projectId: string,
    jobId: string,
  ): Promise<HooksLaunchDeploymentJob | null>;
}
export function createHooksLaunchSubmissionService(input: {
  readonly configs: HooksLaunchProjectConfigRepository | null;
  readonly wallets: AccountWalletRepository | null;
  readonly reader: HooksLaunchFactoryReader | null;
  readonly repository: HooksLaunchSubmissionRepository | null;
  readonly now?: () => number;
  /** Decision 0122: `LAUNCH2_BUYBACK_RECIPIENT`; null fails closed. */
  readonly fixedBuybackRecipient?: string | null;
}): HooksLaunchSubmissionService {
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  return {
    async cancelOwned(ownerUserId, projectId, jobId) {
      if (!input.repository)
        throw new HooksLaunchSubmissionError("unavailable");
      return input.repository.cancelOwned(ownerUserId, projectId, jobId);
    },
    async getOwned(ownerUserId, projectId, jobId) {
      if (!input.repository)
        throw new HooksLaunchSubmissionError("unavailable");
      return input.repository.getOwned(ownerUserId, projectId, jobId);
    },
    async submit(command) {
      const { configs, wallets, reader, repository } = input;
      if (
        !configs ||
        !wallets ||
        !reader ||
        !repository ||
        reader.chainId !== 97
      )
        throw new HooksLaunchSubmissionError("unavailable");
      const parsed = hooksLaunchSubmissionSchema.safeParse(command.body);
      if (
        !parsed.success ||
        !z.uuid().safeParse(command.projectId).success ||
        !z.uuid().safeParse(command.idempotencyKey).success
      )
        throw new HooksLaunchSubmissionError("invalid");
      const body = parsed.data;
      const request = body.request;
      // Decision 0132: a LoopDynamic Factory's TEMPLATE_HASH is in the
      // signed struct; OfficialTax keeps the constant (no read).
      const loopDynamic = reader.hookKind === "loopDynamic";
      let templateHash: string | null = null;
      if (loopDynamic) {
        try {
          templateHash = (await readHooksLaunchFactoryTemplate(reader))
            .templateHash;
        } catch {
          throw new HooksLaunchSubmissionError("unavailable");
        }
      }
      let digest: Hex;
      try {
        const typed = createHooksLaunchDeploymentTypedData({
          chainId: 97,
          verifyingContract: reader.factoryAddress,
          request,
          ...(templateHash === null ? {} : { templateHash }),
        });
        digest = hashTypedData({
          ...typed,
          message: {
            ...typed.message,
            nftSaleStart: BigInt(request.nftSaleStart),
            deadline: BigInt(request.deadline),
            nonce: BigInt(request.nonce),
          },
        });
      } catch {
        throw new HooksLaunchSubmissionError("invalid");
      }
      const fingerprint = keccak256(
        toBytes(
          JSON.stringify([
            digest,
            body.walletId,
            body.hookSalt.toLowerCase(),
            body.signature.toLowerCase(),
          ]),
        ),
      );
      const replay = await repository.findReplay(
        command.ownerUserId,
        command.idempotencyKey,
      );
      if (replay) {
        if (
          replay.fingerprint !== fingerprint ||
          replay.job.projectId !== command.projectId
        )
          throw new HooksLaunchSubmissionError("idempotency_conflict");
        return replay.job;
      }
      const timestamp = now();
      if (
        !Number.isSafeInteger(timestamp) ||
        timestamp < 0 ||
        BigInt(request.deadline) <= BigInt(timestamp) ||
        BigInt(request.deadline) > BigInt(timestamp) + 3600n
      )
        throw new HooksLaunchSubmissionError("invalid");
      const wallet = await wallets.get(command.ownerUserId, body.walletId);
      if (
        !wallet ||
        !wallet.isActive ||
        wallet.status !== "active" ||
        wallet.address.toLowerCase() !== request.projectOwner.toLowerCase()
      )
        throw new HooksLaunchSubmissionError("invalid");
      const draft = await configs.getOwnedDraft({
        ownerUserId: command.ownerUserId,
        projectId: command.projectId,
      });
      if (!draft) throw new HooksLaunchSubmissionError("not_found");
      if (
        draft.version !== request.configVersion ||
        draft.config.configHash.toLowerCase() !==
          request.configHash.toLowerCase() ||
        draft.config.name !== request.name ||
        draft.config.ticker.toUpperCase() !== request.ticker ||
        draft.config.nftSaleStartAt !== request.nftSaleStart ||
        draft.config.buybackRecipient.toLowerCase() !==
          request.buybackRecipient.toLowerCase()
      )
        throw new HooksLaunchSubmissionError("conflict");
      try {
        assertHooksLaunchFixedBuybackRecipient(
          input.fixedBuybackRecipient ?? null,
          draft.config.buybackRecipient,
        );
      } catch (error) {
        throw new HooksLaunchSubmissionError(
          error instanceof HooksLaunchBuybackRecipientFixedError
            ? "recipient_fixed"
            : "recipient_unavailable",
        );
      }
      const signature = body.signature as Hex;
      const halfOrder =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
      if (
        BigInt(`0x${signature.slice(66, 130)}`) > halfOrder ||
        !["1b", "1c"].includes(signature.slice(-2).toLowerCase())
      )
        throw new HooksLaunchSubmissionError("invalid");
      let signer: string;
      try {
        signer = await recoverAddress({ hash: digest, signature });
      } catch {
        throw new HooksLaunchSubmissionError("invalid");
      }
      if (signer.toLowerCase() !== wallet.address.toLowerCase())
        throw new HooksLaunchSubmissionError("invalid");
      let memeAddress: string;
      let hookAddress: string;
      try {
        await assertHooksLaunchFactoryTemplate(
          reader,
          draft.config,
          () => new HooksLaunchSubmissionError("template_mismatch"),
        );
        if ((await reader.nonce(wallet.address)) !== BigInt(request.nonce))
          throw new HooksLaunchSubmissionError("conflict");
        const launchId = hooksLaunchId({
          chainId: 97,
          factory: reader.factoryAddress,
          projectOwner: request.projectOwner,
          configVersion: request.configVersion,
          configHash: request.configHash,
        });
        const token = await reader.tokenDeployment(request);
        memeAddress = getCreate2Address({
          from: token.deployer as Hex,
          salt: keccak256(concatHex([launchId, request.memeSalt as Hex])),
          bytecodeHash: token.initCodeHash as Hex,
        });
        if (!memeAddress.toLowerCase().endsWith("6666"))
          throw new HooksLaunchSubmissionError("invalid");
        const hook = await reader.hookDeployment(request);
        hookAddress = getCreate2Address({
          from: hook.deployer as Hex,
          salt: body.hookSalt as Hex,
          bytecodeHash: hook.initCodeHash as Hex,
        });
        if (
          (BigInt(hookAddress) & 0x3fffn) !==
            hooksLaunchHookPermissionBits[
              loopDynamic ? "loopDynamic" : "officialTax"
            ] ||
          (loopDynamic && /^0x0{64}$/iu.test(body.hookSalt))
        )
          throw new HooksLaunchSubmissionError("invalid");
      } catch (error) {
        if (error instanceof HooksLaunchSubmissionError) throw error;
        throw new HooksLaunchSubmissionError("unavailable");
      }
      return repository.accept({
        ...command,
        fingerprint,
        factoryAddress: reader.factoryAddress.toLowerCase(),
        request,
        signedPayload: body,
        memeAddress: memeAddress.toLowerCase(),
        hookAddress: hookAddress.toLowerCase(),
      });
    },
  };
}
