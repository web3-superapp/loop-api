import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import type { WalletIntentRecord } from "../../database/wallet-intent-repository.js";
import {
  buildErc721SafeTransfer,
  decodeErc721OwnerOf,
  encodeErc721OwnerOf,
  erc721SafeTransferFromSelector,
} from "../../integrations/bsc/erc721-tx.js";
import type { BscCallOutcome } from "../../integrations/bsc/rpc-client.js";
import {
  InvalidTransactionArgumentError,
  maxUint256,
  parseRecipientAddress,
} from "../../integrations/bsc/tx-builder.js";
import { isChainId, type LaunchChainId } from "../chain/chain-contract.js";
import type { Launch2Repository } from "../launch2/launch2-ports.js";
import {
  nftSendReasonCodes,
  sealIntent,
  sendIntentTtlSeconds,
  walletIntentPayloadVersions,
  intentRequestDigest,
  type DecodedCallReview,
  type IntentSource,
} from "./intent-contract.js";
import {
  assertNativeSufficiency,
  buildUnsignedTransaction,
  canaryPolicyFact,
  chainUnavailable,
  intentStateForSimulation,
  preExecute,
  projectIntent,
  readFeeSnapshot,
  readNonce,
  requireCanaryCounterparty,
  requireSignableWallet,
  requireWriteAdmission,
  withPrepareIdempotency,
  type NftSendRuntime,
  type ProjectNftDirectory,
  type ProjectNftRecord,
  type WalletIntentResource,
  type WalletIntentRuntime,
} from "./intent-preparation.js";
import { reviewRecipient } from "./send-service.js";

/**
 * Decision 0194 (S339, LOOP decision 0267): send one LOOP Launch project NFT
 * (ERC-721) from the user's embedded wallet. The server checks the contract
 * is a launch2 `ProjectNFT` it indexes, reads `ownerOf(tokenId)`, encodes
 * `safeTransferFrom(owner, recipient, tokenId)`, pre-executes it with
 * `eth_call` + `estimateGas` on the launch slot, and seals nonce / gas /
 * expiry into a `send_nft` intent that walks the shared lifecycle (device
 * signs and broadcasts, `broadcast-report`, reconciliation lane).
 *
 * Gates, in order: NFT_SEND_ENABLED (503 NFT_SEND_DISABLED) → body shape →
 * launch slot chain (422 CHAIN_MISMATCH) → slot open with a client and a
 * directory (503 NFT_SEND_CHAIN_UNAVAILABLE) → BSC_WRITES_ENABLED and a
 * verified chain (503) → signable wallet → not to self (422 RECIPIENT_SELF)
 * → project NFT (422 NFT_CONTRACT_UNSUPPORTED) → counterparty allowlist
 * (403) → idempotency → ownerOf (422 NFT_NOT_OWNED) → pre-execution
 * (422 NFT_RECIPIENT_REJECTS for a contract recipient, 409
 * SIMULATION_FAILED otherwise) → gas (409 INSUFFICIENT_BALANCE).
 */

export interface NftSendService {
  prepare(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly body: unknown;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly created: boolean;
    readonly resource: WalletIntentResource;
  }>;
}

const tokenIdPattern = /^(0|[1-9][0-9]{0,77})$/u;
const zeroAddress = "0x0000000000000000000000000000000000000000";
/** The `review.nft.projectName` bound (route schema `maxLength: 128`). */
const maxNameLength = 128;
/** The asset snapshot symbol bound (route schema `maxLength: 32`). */
const maxSymbolLength = 32;

function truncate(value: string, length: number): string {
  const characters = Array.from(value);
  return characters.length <= length
    ? value
    : characters.slice(0, length).join("");
}

function refuse(reasonCode: string): never {
  throw V2ApiError.fromCode("VALIDATION_FAILED", { reasonCode });
}

function unavailable(reasonCode: string): never {
  throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", { reasonCode });
}

function parseAddress(value: unknown): string {
  try {
    return parseRecipientAddress(value);
  } catch (error) {
    if (error instanceof InvalidTransactionArgumentError) {
      throw V2ApiError.invalidRequest();
    }
    throw error;
  }
}

function parseTokenId(value: unknown): bigint {
  if (typeof value !== "string" || !tokenIdPattern.test(value)) {
    throw V2ApiError.invalidRequest();
  }
  const tokenId = BigInt(value);
  if (tokenId > maxUint256) {
    throw V2ApiError.invalidRequest();
  }
  return tokenId;
}

interface ParsedRequest {
  readonly walletId: unknown;
  readonly chainId: string;
  readonly contractAddress: string;
  readonly tokenId: bigint;
  readonly recipient: string;
}

function parseRequest(body: unknown): ParsedRequest {
  if (typeof body !== "object" || body === null) {
    throw V2ApiError.invalidRequest();
  }
  const request = body as {
    readonly walletId?: unknown;
    readonly chainId?: unknown;
    readonly contractAddress?: unknown;
    readonly tokenId?: unknown;
    readonly recipientAddress?: unknown;
  };
  if (!isChainId(request.chainId)) {
    throw V2ApiError.invalidRequest();
  }
  const recipient = parseAddress(request.recipientAddress);
  if (recipient === zeroAddress) {
    throw V2ApiError.invalidRequest();
  }
  return {
    walletId: request.walletId,
    chainId: request.chainId,
    contractAddress: parseAddress(request.contractAddress),
    tokenId: parseTokenId(request.tokenId),
    recipient,
  };
}

/** The slot pieces once every one of them is present and open. */
function requireSlot(nft: NftSendRuntime): {
  readonly readClient: NonNullable<NftSendRuntime["readClient"]>;
  readonly directory: NonNullable<NftSendRuntime["directory"]>;
} {
  if (!nft.slotOpen || nft.readClient === null || nft.directory === null) {
    unavailable(nftSendReasonCodes.chainUnavailable);
  }
  return { readClient: nft.readClient, directory: nft.directory };
}

/**
 * `ownerOf(tokenId)` at the latest block. A revert (a token that was never
 * minted or was burned) and another owner are both NFT_NOT_OWNED; an
 * endpoint that cannot answer is CAPABILITY_UNAVAILABLE, never a guess.
 */
async function requireOwnership(
  runtime: WalletIntentRuntime,
  contract: string,
  tokenId: bigint,
  walletAddress: string,
): Promise<void> {
  let outcome: BscCallOutcome;
  try {
    outcome = await runtime.readClient.call({
      from: walletAddress,
      to: contract,
      data: encodeErc721OwnerOf(tokenId),
      value: 0n,
    });
  } catch {
    // An endpoint failure (or a chain mismatch) leaves ownership unknown.
    throw V2ApiError.capabilityUnavailable();
  }
  if (outcome.status === "reverted") {
    refuse(nftSendReasonCodes.notOwned);
  }
  const owner = decodeErc721OwnerOf(outcome.returnData);
  if (owner === null) {
    throw V2ApiError.capabilityUnavailable();
  }
  if (owner !== walletAddress) {
    refuse(nftSendReasonCodes.notOwned);
  }
}

export function createNftSendService(
  runtime: WalletIntentRuntime,
): NftSendService {
  const service: NftSendService = {
    async prepare({ principal, idempotencyKey, body }) {
      const nft = runtime.nftSend ?? null;
      if (nft === null || !nft.enabled) {
        unavailable(nftSendReasonCodes.disabled);
      }
      const request = parseRequest(body);
      if (request.chainId !== nft.chainId) {
        throw V2ApiError.fromCode("CHAIN_MISMATCH");
      }
      const slot = requireSlot(nft);
      const chainRuntime: WalletIntentRuntime = Object.freeze({
        ...runtime,
        readClient: slot.readClient,
      });
      const writes = await requireWriteAdmission(chainRuntime);
      const wallet = await requireSignableWallet(
        runtime,
        principal,
        request.walletId,
      );
      if (request.recipient === wallet.address) {
        refuse(nftSendReasonCodes.recipientSelf);
      }
      let project: ProjectNftRecord | null;
      try {
        project = await slot.directory.findByContract({
          chainId: nft.chainId,
          contractAddress: request.contractAddress,
        });
      } catch {
        throw V2ApiError.capabilityUnavailable();
      }
      if (
        project === null ||
        project.chainId !== nft.chainId ||
        project.nftAddress !== request.contractAddress
      ) {
        refuse(nftSendReasonCodes.contractUnsupported);
      }
      requireCanaryCounterparty(writes, request.recipient);
      const tokenIdText = request.tokenId.toString(10);
      const requestId = runtime.createUuid();
      const outcome = await withPrepareIdempotency(
        runtime,
        {
          principal,
          kind: "send_nft",
          idempotencyKey,
          requestSha256: intentRequestDigest("send_nft", [
            wallet.walletId,
            nft.chainId,
            request.contractAddress,
            tokenIdText,
            request.recipient,
          ]),
          requestId,
        },
        async (operationId): Promise<WalletIntentRecord> => {
          await requireOwnership(
            chainRuntime,
            request.contractAddress,
            request.tokenId,
            wallet.address,
          );
          const nativeAssetId = `${nft.chainId}:native`;
          let read;
          try {
            read = await chainRuntime.readClient.readBalances(wallet.address, [
              { assetId: nativeAssetId, address: null },
            ]);
          } catch (error) {
            return chainUnavailable(error);
          }
          const rawNativeBalance = read.balances.find(
            (balance) => balance.assetId === nativeAssetId,
          )?.rawValue;
          if (rawNativeBalance === undefined || rawNativeBalance === null) {
            throw V2ApiError.capabilityUnavailable();
          }
          const recipientReview = await reviewRecipient(
            chainRuntime,
            wallet.address,
            request.recipient,
            nft.chainId,
          );
          const call = buildErc721SafeTransfer({
            contract: request.contractAddress,
            from: wallet.address,
            to: request.recipient,
            tokenId: request.tokenId,
          });
          const execution = await preExecute(
            chainRuntime,
            {
              from: wallet.address,
              to: call.to,
              data: call.data,
              value: call.value,
            },
            false,
          );
          if (execution.simulation.status === "reverted") {
            // Ownership was just read: a revert of a contract recipient is
            // its `onERC721Received` refusing; anything else is a payload
            // the chain would not execute.
            if (recipientReview.isContract) {
              refuse(nftSendReasonCodes.recipientRejects);
            }
            throw V2ApiError.fromCode("SIMULATION_FAILED");
          }
          const fee = await readFeeSnapshot(chainRuntime, execution.gasLimit);
          assertNativeSufficiency({
            rawNativeBalance,
            nativeAmount: 0n,
            maximumFeeRaw: fee.maximumFeeRaw,
            gasReserveRaw: runtime.config.gasReserveRawWei,
          });
          const nonce = await readNonce(chainRuntime, wallet.address);
          const now = runtime.now();
          const intentId = runtime.createUuid();
          const decodedCall: DecodedCallReview = Object.freeze({
            functionName: "safeTransferFrom" as const,
            selector: erc721SafeTransferFromSelector,
            args: Object.freeze({
              from: wallet.address,
              to: request.recipient,
              tokenId: tokenIdText,
            }),
          });
          const source: IntentSource = {
            version: walletIntentPayloadVersions.send_nft,
            intentId,
            kind: "send_nft",
            chainId: nft.chainId as LaunchChainId,
            walletId: wallet.walletId,
            from: wallet.address,
            asset: Object.freeze({
              assetId: `${nft.chainId}:${project.nftAddress}`,
              address: project.nftAddress,
              symbol: truncate(project.ticker, maxSymbolLength),
              decimals: 0,
            }),
            amount: Object.freeze({ raw: "1", display: "1" }),
            recipient: recipientReview,
            spender: null,
            decodedCall,
            transaction: buildUnsignedTransaction({
              kind: "send_nft",
              chainReference: slot.readClient.chainReference,
              from: wallet.address,
              to: call.to,
              data: call.data,
              value: call.value,
              gasLimit: execution.gasLimit,
              nonce,
              feeData: fee.feeData,
            }),
            fee: fee.fact,
            balance: Object.freeze({
              blockNumber: read.head.blockNumber.toString(10),
              blockHash: read.head.blockHash,
              observedAt: read.head.observedAt,
              // The one token this intent moves, held at `ownerOf` time.
              rawBalance: "1",
              displayBalance: "1",
              rawNativeBalance: rawNativeBalance.toString(10),
              gasReserveRaw: runtime.config.gasReserveRawWei.toString(10),
            }),
            simulation: execution.simulation,
            // An NFT has no price the canary could value: no USD exposure
            // (like a revoke), the counterparty allowlist still applies.
            policy: canaryPolicyFact(writes, null, {
              basis: "none",
              raw: null,
              blockNumber: null,
            }),
            swap: null,
            signingMode: "device_eth_send_transaction",
            nft: Object.freeze({
              contractAddress: project.nftAddress,
              tokenId: tokenIdText,
              projectName: truncate(project.name, maxNameLength),
            }),
            factsObservedAt: now.toISOString(),
            expiresAt: new Date(
              now.getTime() + sendIntentTtlSeconds * 1000,
            ).toISOString(),
          };
          const sealed = sealIntent(source);
          return runtime.repository.create({
            intentId,
            ownerUserId: principal.userId,
            walletId: wallet.walletId,
            providerOperationId: operationId,
            kind: "send_nft",
            state: intentStateForSimulation(execution.simulation),
            chainId: nft.chainId,
            canonicalPayload: sealed.canonicalPayload,
            publicReview: sealed.publicReview,
            reviewSha256: sealed.reviewSha256,
            policyConfigVersion: writes.configVersion,
            factsObservedAt: source.factsObservedAt,
            expiresAt: source.expiresAt,
            simulationStatus: execution.simulation.status,
            requestId,
            canaryAdmission: null,
          });
        },
      );
      return Object.freeze({
        created: outcome.created,
        resource: projectIntent(
          outcome.record,
          runtime.now(),
          null,
          slot.readClient.confirmations,
        ),
      });
    },
  };
  return Object.freeze(service);
}

/**
 * Decision 0194: the launch2 read model as the project NFT directory. Null
 * when the repository cannot look an instance up by its NFT contract.
 */
export function projectNftDirectoryFromLaunch2(
  repository: Pick<Launch2Repository, "getInstanceByNftAddress"> | undefined,
): ProjectNftDirectory | null {
  const lookup = repository?.getInstanceByNftAddress;
  if (repository === undefined || lookup === undefined) {
    return null;
  }
  const directory: ProjectNftDirectory = {
    async findByContract({ chainId, contractAddress }) {
      const record = await lookup.call(repository, {
        chainId,
        nftAddress: contractAddress,
      });
      return record === null
        ? null
        : Object.freeze({
            instanceId: record.instanceId,
            chainId: record.chainId,
            nftAddress: record.addresses.nft.toLowerCase(),
            name: record.name,
            ticker: record.ticker,
          });
    },
  };
  return Object.freeze(directory);
}
