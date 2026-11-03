import { createHash } from "node:crypto";

import type { Hex } from "viem";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { isOpaqueId } from "../../core/ids/opaque-id.js";
import {
  WalletIntentBusyError,
  WalletIntentStateConflictError,
  type WalletIntentRecord,
} from "../../database/wallet-intent-repository.js";
import {
  BscChainMismatchError,
  BscReadUnavailableError,
  type BscChainCallClient,
} from "../../integrations/bsc/rpc-client.js";
import {
  checksumAddress,
  InvalidTransactionArgumentError,
  maxUint256,
  parseRecipientAddress,
} from "../../integrations/bsc/tx-builder.js";
import {
  bscChainId,
  bscNativeDecimals,
  formatDecimalAmount,
  isChainId,
  type LaunchChainId,
} from "../chain/chain-contract.js";
import {
  decodeDappCall,
  erc165Supported,
  erc165SupportsInterfaceData,
  needsErc721Probe,
  orderRiskFlags,
} from "./dapp-call-decoder.js";
import {
  DappPayloadInvalidError,
  parseTypedData,
  personalSignRiskFlags,
  recoverPersonalSigner,
  recoverTypedDataSigner,
  reviewPersonalSignMessage,
  reviewTypedData,
  typedDataBinding,
  typedDataRiskFlags,
  type ParsedTypedData,
} from "./dapp-sign-review.js";
import {
  dappReasonCodes,
  intentRequestDigest,
  sealIntent,
  sendIntentTtlSeconds,
  walletIntentPayloadVersions,
  walletIntentReasonCodes,
  type DappAddressReview,
  type DappCounterpartyReview,
  type DappRiskFlag,
  type DappSignatureRequest,
  type IntentAssetSnapshot,
  type IntentBalanceFact,
  type IntentDappReview,
  type IntentSource,
  type SimulationFact,
} from "./intent-contract.js";
import {
  assertNativeSufficiency,
  buildUnsignedTransaction,
  canaryPolicyFact,
  chainUnavailable,
  intentStateForSimulation,
  isElapsed,
  preExecute,
  projectIntent,
  readFeeSnapshot,
  readNonce,
  requireCanaryCounterparty,
  requireSignableWallet,
  requireWriteAdmission,
  withPrepareIdempotency,
  type DappBrowserRuntime,
  type WalletIntentResource,
  type WalletIntentRuntime,
} from "./intent-preparation.js";

/**
 * Decision 0197 (S342, LOOP decision 0270): the DApp browser's signing exit.
 * A page's `eth_sendTransaction` becomes a `dapp_tx` intent (decoded,
 * pre-executed with eth_call + estimateGas, nonce / gas / expiry bound) that
 * walks the shared lifecycle (device signs and broadcasts,
 * `broadcast-report`, reconciliation). A page's `personal_sign` /
 * `eth_signTypedData_v4` becomes a `dapp_sign` intent whose review is the
 * decoded message and whose `signatureRequest` is the exact JSON-RPC
 * request the device signs; the device reports the signature through
 * `signature-report`, which ecrecovers it and closes the intent as
 * `confirmed` (only the signature's SHA-256 is kept, in the audit event).
 *
 * Gates, in order: DAPP_BROWSER_ENABLED (503 DAPP_BROWSER_DISABLED) → body
 * shape (400) → origin https (422 ORIGIN_NOT_HTTPS) → chain: eip155:56 is
 * 422 CHAIN_SIGNING_DISABLED (docs/00 rule 8), a slot without a separate
 * testnet client is 503 DAPP_BROWSER_CHAIN_UNAVAILABLE, any other chain is
 * 422 CHAIN_MISMATCH → (sign) payload (422 TYPED_DATA_INVALID /
 * TYPED_DATA_CHAIN_MISMATCH; S346: typed data must carry the request
 * chain's domain.chainId) → BSC_WRITES_ENABLED and a verified chain
 * (503) → signable embedded wallet (422) → idempotency → facts.
 *
 * A pre-execution revert does not refuse: the intent is created in
 * `prepared` with `signing.allowed=false` and the SIMULATION_FAILED flag, so
 * the page can be told why (the same rule as a send whose gas estimate is
 * unavailable).
 */

export interface DappIntentService {
  prepareTransaction(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly body: unknown;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly created: boolean;
    readonly resource: WalletIntentResource;
  }>;
  prepareSignature(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly body: unknown;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly created: boolean;
    readonly resource: WalletIntentResource;
  }>;
  reportSignature(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly intentId: string;
    readonly body: unknown;
  }): Promise<WalletIntentResource>;
}

const maximumOriginLength = 256;
const maximumCalldataBytes = 10_000;
const hexDataPattern = /^0x([0-9a-fA-F]{2})*$/u;
const hexQuantityPattern = /^0x[0-9a-fA-F]{1,64}$/u;
const signaturePattern = /^0x[0-9a-fA-F]{130}$/u;

function refuse(reasonCode: string): never {
  throw V2ApiError.fromCode("VALIDATION_FAILED", { reasonCode });
}

function unavailable(reasonCode: string): never {
  throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", { reasonCode });
}

/**
 * S346 (finding A4): a DApp prepare never supersedes an open send / swap /
 * approve / send_nft — the repository refuses, and the page is told the
 * wallet is busy (409 RESOURCE_CONFLICT / INTENT_BUSY).
 */
async function createOrBusy(
  create: () => Promise<WalletIntentRecord>,
): Promise<WalletIntentRecord> {
  try {
    return await create();
  } catch (error) {
    if (error instanceof WalletIntentBusyError) {
      throw V2ApiError.fromCode("RESOURCE_CONFLICT", {
        reasonCode: dappReasonCodes.intentBusy,
      });
    }
    throw error;
  }
}

/**
 * The page's origin as the browser reports it, normalised by WHATWG URL:
 * lower-case host, punycode, default port dropped. Only `https:` with no
 * credentials, path, query or fragment is an origin; `http:` is the
 * product rule (docs/55 §一) and refused with ORIGIN_NOT_HTTPS.
 */
export function normalizeDappOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > maximumOriginLength) {
    throw V2ApiError.invalidRequest();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw V2ApiError.invalidRequest();
  }
  if (url.protocol === "http:") {
    refuse(dappReasonCodes.originNotHttps);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname === ""
  ) {
    throw V2ApiError.invalidRequest();
  }
  return url.origin;
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

interface SigningChain {
  readonly chainId: string;
  readonly client: BscChainCallClient;
}

/** The chain rule shared by both prepares (see the gate order above). */
function requireSigningChain(
  dapp: DappBrowserRuntime,
  chainId: unknown,
): SigningChain {
  if (!isChainId(chainId)) {
    throw V2ApiError.invalidRequest();
  }
  if (chainId === bscChainId) {
    refuse(dappReasonCodes.chainSigningDisabled);
  }
  if (dapp.signingChainId === null || dapp.signingClient === null) {
    unavailable(dappReasonCodes.chainUnavailable);
  }
  if (chainId !== dapp.signingChainId) {
    throw V2ApiError.fromCode("CHAIN_MISMATCH");
  }
  return { chainId, client: dapp.signingClient };
}

function requireEnabled(runtime: WalletIntentRuntime): DappBrowserRuntime {
  const dapp = runtime.dapp ?? null;
  if (dapp === null || !dapp.enabled) {
    unavailable(dappReasonCodes.disabled);
  }
  return dapp;
}

function nativeAsset(chainId: string): IntentAssetSnapshot {
  return Object.freeze({
    assetId: `${chainId}:native`,
    address: null,
    symbol: chainId === bscChainId ? "BNB" : "tBNB",
    decimals: bscNativeDecimals,
  });
}

interface NativeFacts {
  readonly fact: IntentBalanceFact;
  readonly rawNativeBalance: bigint;
}

async function readNativeFacts(
  runtime: WalletIntentRuntime,
  chainId: string,
  address: string,
): Promise<NativeFacts> {
  const assetId = `${chainId}:native`;
  let read;
  try {
    read = await runtime.readClient.readBalances(address, [
      { assetId, address: null },
    ]);
  } catch (error) {
    return chainUnavailable(error);
  }
  const raw = read.balances.find(
    (balance) => balance.assetId === assetId,
  )?.rawValue;
  if (raw === undefined || raw === null) {
    throw V2ApiError.capabilityUnavailable();
  }
  return {
    rawNativeBalance: raw,
    fact: Object.freeze({
      blockNumber: read.head.blockNumber.toString(10),
      blockHash: read.head.blockHash,
      observedAt: read.head.observedAt,
      rawBalance: raw.toString(10),
      displayBalance: formatDecimalAmount(raw, bscNativeDecimals),
      rawNativeBalance: raw.toString(10),
      gasReserveRaw: runtime.config.gasReserveRawWei.toString(10),
    }),
  };
}

async function isContractAt(
  runtime: WalletIntentRuntime,
  address: string,
): Promise<boolean> {
  try {
    return (await runtime.readClient.getCode(address)) !== "0x";
  } catch {
    // Contract-ness is a review fact: unknown is unavailable, never a guess
    // (the same rule as the send preflight's recipient review).
    throw V2ApiError.capabilityUnavailable();
  }
}

async function reviewAddress(
  runtime: WalletIntentRuntime,
  dapp: DappBrowserRuntime,
  chainId: string,
  address: string,
): Promise<DappAddressReview> {
  const isContract = await isContractAt(runtime, address);
  let knownContract = null;
  if (isContract && dapp.directory !== null) {
    try {
      knownContract = await dapp.directory.classify({ chainId, address });
    } catch {
      throw V2ApiError.capabilityUnavailable();
    }
  }
  return Object.freeze({
    address,
    checksumAddress: checksumAddress(address),
    isContract,
    isVerified: knownContract !== null,
    knownContract,
  });
}

/**
 * S346 (finding A2): whether a typed-data `verifyingContract` is a contract
 * LOOP knows. Unknown (no directory, not listed) is unverified.
 */
async function isKnownContract(
  dapp: DappBrowserRuntime,
  chainId: string,
  address: string,
): Promise<boolean> {
  if (dapp.directory === null) return false;
  try {
    return (await dapp.directory.classify({ chainId, address })) !== null;
  } catch {
    throw V2ApiError.capabilityUnavailable();
  }
}

/** ERC-165 `supportsInterface(ERC-721)`; a revert or garbage is "no". */
async function probeErc721(
  runtime: WalletIntentRuntime,
  from: string,
  to: string,
): Promise<boolean> {
  try {
    const outcome = await runtime.readClient.call({
      from,
      to,
      data: erc165SupportsInterfaceData,
      value: 0n,
    });
    return outcome.status === "passed" && erc165Supported(outcome.returnData);
  } catch (error) {
    if (
      error instanceof BscReadUnavailableError ||
      error instanceof BscChainMismatchError
    ) {
      throw V2ApiError.capabilityUnavailable();
    }
    // Any other failure of the probe reads as "not an ERC-721": the call is
    // then decoded as ERC-20, whose approve carries the stricter flag.
    return false;
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface ParsedTransaction {
  readonly walletId: unknown;
  readonly chainId: unknown;
  readonly origin: string;
  readonly to: string;
  readonly data: Hex;
  readonly value: bigint;
}

function parseTransactionRequest(body: unknown): ParsedTransaction {
  if (typeof body !== "object" || body === null) {
    throw V2ApiError.invalidRequest();
  }
  const request = body as {
    readonly walletId?: unknown;
    readonly chainId?: unknown;
    readonly origin?: unknown;
    readonly tx?: unknown;
  };
  if (typeof request.tx !== "object" || request.tx === null) {
    throw V2ApiError.invalidRequest();
  }
  const tx = request.tx as {
    readonly to?: unknown;
    readonly data?: unknown;
    readonly value?: unknown;
  };
  const data = tx.data === undefined ? "0x" : tx.data;
  if (
    typeof data !== "string" ||
    !hexDataPattern.test(data) ||
    (data.length - 2) / 2 > maximumCalldataBytes
  ) {
    throw V2ApiError.invalidRequest();
  }
  const valueText = tx.value === undefined ? "0x0" : tx.value;
  if (typeof valueText !== "string" || !hexQuantityPattern.test(valueText)) {
    throw V2ApiError.invalidRequest();
  }
  const value = BigInt(valueText);
  if (value > maxUint256) {
    throw V2ApiError.invalidRequest();
  }
  return {
    walletId: request.walletId,
    chainId: request.chainId,
    origin: normalizeDappOrigin(request.origin),
    to: parseAddress(tx.to),
    data: data.toLowerCase() as Hex,
    value,
  };
}

type SignMethod = DappSignatureRequest["method"];

interface ParsedSignature {
  readonly walletId: unknown;
  readonly chainId: unknown;
  readonly origin: string;
  readonly method: SignMethod;
  readonly payload: string;
}

function parseSignatureRequest(body: unknown): ParsedSignature {
  if (typeof body !== "object" || body === null) {
    throw V2ApiError.invalidRequest();
  }
  const request = body as {
    readonly walletId?: unknown;
    readonly chainId?: unknown;
    readonly origin?: unknown;
    readonly method?: unknown;
    readonly payload?: unknown;
  };
  if (
    (request.method !== "personal_sign" &&
      request.method !== "eth_signTypedData_v4") ||
    typeof request.payload !== "string"
  ) {
    throw V2ApiError.invalidRequest();
  }
  return {
    walletId: request.walletId,
    chainId: request.chainId,
    origin: normalizeDappOrigin(request.origin),
    method: request.method,
    payload: request.payload,
  };
}

function parseTypedOrRefuse(payload: string): ParsedTypedData {
  try {
    return parseTypedData(payload);
  } catch (error) {
    if (error instanceof DappPayloadInvalidError) {
      refuse(dappReasonCodes.typedDataInvalid);
    }
    throw error;
  }
}

const notSimulated = (observedAt: string): SimulationFact =>
  Object.freeze({
    status: "unavailable" as const,
    source: "not_applicable" as const,
    observedAt,
    reasonCode: dappReasonCodes.signatureNotApplicable,
  });

export function createDappIntentService(
  runtime: WalletIntentRuntime,
): DappIntentService {
  async function requireIntent(
    principal: AuthenticatedLoopPrincipal,
    intentId: string,
  ): Promise<WalletIntentRecord> {
    if (!isOpaqueId(intentId)) {
      throw V2ApiError.invalidRequest();
    }
    const record = await runtime.repository.get(principal.userId, intentId);
    if (record === null) {
      throw V2ApiError.notFound();
    }
    return record;
  }

  function project(record: WalletIntentRecord): WalletIntentResource {
    const client = runtime.dapp?.signingClient ?? runtime.readClient;
    return projectIntent(record, runtime.now(), null, client.confirmations);
  }

  const service: DappIntentService = {
    async prepareTransaction({ principal, idempotencyKey, body }) {
      const dapp = requireEnabled(runtime);
      const request = parseTransactionRequest(body);
      const chain = requireSigningChain(dapp, request.chainId);
      const chainRuntime: WalletIntentRuntime = Object.freeze({
        ...runtime,
        readClient: chain.client,
      });
      const writes = await requireWriteAdmission(chainRuntime);
      const wallet = await requireSignableWallet(
        runtime,
        principal,
        request.walletId,
      );
      const requestId = runtime.createUuid();
      const outcome = await withPrepareIdempotency(
        runtime,
        {
          principal,
          kind: "dapp_tx",
          idempotencyKey,
          requestSha256: intentRequestDigest("dapp_tx", [
            wallet.walletId,
            chain.chainId,
            request.origin,
            request.to,
            request.data,
            request.value.toString(10),
          ]),
          requestId,
        },
        async (operationId): Promise<WalletIntentRecord> => {
          const native = await readNativeFacts(
            chainRuntime,
            chain.chainId,
            wallet.address,
          );
          const to = await reviewAddress(
            chainRuntime,
            dapp,
            chain.chainId,
            request.to,
          );
          const targetIsErc721 =
            to.isContract && needsErc721Probe(request.data)
              ? await probeErc721(chainRuntime, wallet.address, request.to)
              : false;
          const decoded = decodeDappCall({
            data: request.data,
            to: request.to,
            targetIsErc721,
            targetIsLoop:
              to.knownContract !== null &&
              to.knownContract.kind !== "registryAsset",
          });
          let counterparty: DappCounterpartyReview | null = null;
          if (decoded.counterparty !== null) {
            const reviewed =
              decoded.counterparty.address === request.to
                ? to
                : await reviewAddress(
                    chainRuntime,
                    dapp,
                    chain.chainId,
                    decoded.counterparty.address,
                  );
            counterparty = Object.freeze({
              ...reviewed,
              role: decoded.counterparty.role,
            });
          }
          // The canary counterparty allowlist (Decision 0065) covers the
          // target and whoever the call grants or sends to.
          requireCanaryCounterparty(writes, request.to);
          if (counterparty !== null) {
            requireCanaryCounterparty(writes, counterparty.address);
          }
          const execution = await preExecute(
            chainRuntime,
            {
              from: wallet.address,
              to: request.to,
              data: request.data,
              value: request.value,
            },
            request.data === "0x" && !to.isContract,
          );
          const fee = await readFeeSnapshot(chainRuntime, execution.gasLimit);
          assertNativeSufficiency({
            rawNativeBalance: native.rawNativeBalance,
            nativeAmount: request.value,
            maximumFeeRaw: fee.maximumFeeRaw,
            gasReserveRaw: runtime.config.gasReserveRawWei,
          });
          const nonce = await readNonce(chainRuntime, wallet.address);
          const flags: DappRiskFlag[] = [...decoded.flags];
          if (
            (to.isContract && !to.isVerified) ||
            (counterparty !== null &&
              counterparty.isContract &&
              !counterparty.isVerified)
          ) {
            flags.push("UNVERIFIED_CONTRACT");
          }
          if (
            decoded.grantsApproval &&
            counterparty !== null &&
            (counterparty.role === "spender" ||
              counterparty.role === "operator") &&
            !counterparty.isContract
          ) {
            flags.push("EOA_SPENDER");
          }
          if (execution.simulation.status !== "passed") {
            flags.push("SIMULATION_FAILED");
          }
          const value = Object.freeze({
            raw: request.value.toString(10),
            display: formatDecimalAmount(request.value, bscNativeDecimals),
          });
          const review: IntentDappReview = Object.freeze({
            origin: request.origin,
            method: "eth_sendTransaction" as const,
            to,
            value,
            decodedCall: decoded.call,
            counterparty,
            message: null,
            typedData: null,
            riskFlags: orderRiskFlags(flags),
          });
          const now = runtime.now();
          const intentId = runtime.createUuid();
          const source: IntentSource = {
            version: walletIntentPayloadVersions.dapp_tx,
            intentId,
            kind: "dapp_tx",
            chainId: chain.chainId as LaunchChainId,
            walletId: wallet.walletId,
            from: wallet.address,
            asset: nativeAsset(chain.chainId),
            amount: value,
            recipient: null,
            spender: null,
            decodedCall: null,
            transaction: buildUnsignedTransaction({
              kind: "dapp_tx",
              chainReference: chain.client.chainReference,
              from: wallet.address,
              to: request.to,
              data: request.data,
              value: request.value,
              gasLimit: execution.gasLimit,
              nonce,
              feeData: fee.feeData,
            }),
            fee: fee.fact,
            balance: native.fact,
            simulation: execution.simulation,
            // Testnet value has no USD price the canary could value; only
            // the counterparty allowlist applies (like send_nft).
            policy: canaryPolicyFact(writes, null, {
              basis: "none",
              raw: null,
              blockNumber: null,
            }),
            swap: null,
            signingMode: "device_eth_send_transaction",
            dapp: review,
            factsObservedAt: now.toISOString(),
            expiresAt: new Date(
              now.getTime() + sendIntentTtlSeconds * 1000,
            ).toISOString(),
          };
          const sealed = sealIntent(source);
          return createOrBusy(() =>
            runtime.repository.create({
              intentId,
              ownerUserId: principal.userId,
              walletId: wallet.walletId,
              providerOperationId: operationId,
              kind: "dapp_tx",
              state: intentStateForSimulation(execution.simulation),
              chainId: chain.chainId,
              canonicalPayload: sealed.canonicalPayload,
              publicReview: sealed.publicReview,
              reviewSha256: sealed.reviewSha256,
              policyConfigVersion: writes.configVersion,
              factsObservedAt: source.factsObservedAt,
              expiresAt: source.expiresAt,
              simulationStatus: execution.simulation.status,
              requestId,
              canaryAdmission: null,
            }),
          );
        },
      );
      return Object.freeze({
        created: outcome.created,
        resource: project(outcome.record),
      });
    },

    async prepareSignature({ principal, idempotencyKey, body }) {
      const dapp = requireEnabled(runtime);
      const request = parseSignatureRequest(body);
      const chain = requireSigningChain(dapp, request.chainId);
      // The payload is validated before any chain or wallet read.
      let message = null;
      let typedData = null;
      let flags: readonly DappRiskFlag[] = [];
      if (request.method === "personal_sign") {
        try {
          message = reviewPersonalSignMessage(request.payload);
        } catch (error) {
          if (error instanceof DappPayloadInvalidError) {
            throw V2ApiError.invalidRequest();
          }
          throw error;
        }
        flags = personalSignRiskFlags(request.payload, message);
      } else {
        const parsed = parseTypedOrRefuse(request.payload);
        // S346 (finding A1): v4 must bind the request chain — domain.chainId
        // present and equal, and a page-supplied EIP712Domain that covers
        // exactly the domain's keys (so the hash includes the chainId).
        const binding = typedDataBinding(
          parsed,
          BigInt(chain.client.chainReference),
        );
        if (binding === "invalid") {
          refuse(dappReasonCodes.typedDataInvalid);
        }
        if (binding === "chainMismatch") {
          refuse(dappReasonCodes.typedDataChainMismatch);
        }
        typedData = reviewTypedData(parsed);
        flags = typedDataRiskFlags(parsed, typedData);
      }
      const chainRuntime: WalletIntentRuntime = Object.freeze({
        ...runtime,
        readClient: chain.client,
      });
      const writes = await requireWriteAdmission(chainRuntime);
      const wallet = await requireSignableWallet(
        runtime,
        principal,
        request.walletId,
      );
      const requestId = runtime.createUuid();
      const outcome = await withPrepareIdempotency(
        runtime,
        {
          principal,
          kind: "dapp_sign",
          idempotencyKey,
          requestSha256: intentRequestDigest("dapp_sign", [
            wallet.walletId,
            chain.chainId,
            request.origin,
            request.method,
            sha256Hex(request.payload),
          ]),
          requestId,
        },
        async (operationId): Promise<WalletIntentRecord> => {
          const native = await readNativeFacts(
            chainRuntime,
            chain.chainId,
            wallet.address,
          );
          // S346 (finding A2): the verifying contract goes through the same
          // directory as a transaction's target.
          const verifyingContract = typedData?.domain.verifyingContract ?? null;
          const riskFlags: DappRiskFlag[] = [...flags];
          if (
            verifyingContract !== null &&
            !(await isKnownContract(dapp, chain.chainId, verifyingContract))
          ) {
            riskFlags.push("UNVERIFIED_CONTRACT");
          }
          const now = runtime.now();
          const intentId = runtime.createUuid();
          const signatureRequest: DappSignatureRequest = Object.freeze({
            method: request.method,
            params:
              request.method === "personal_sign"
                ? ([request.payload, wallet.address] as const)
                : ([wallet.address, request.payload] as const),
          });
          const simulation = notSimulated(now.toISOString());
          const source: IntentSource = {
            version: walletIntentPayloadVersions.dapp_sign,
            intentId,
            kind: "dapp_sign",
            chainId: chain.chainId as LaunchChainId,
            walletId: wallet.walletId,
            from: wallet.address,
            asset: nativeAsset(chain.chainId),
            amount: Object.freeze({ raw: "0", display: "0" }),
            recipient: null,
            spender: null,
            decodedCall: null,
            transaction: null,
            fee: null,
            balance: native.fact,
            simulation,
            policy: canaryPolicyFact(writes, null, {
              basis: "none",
              raw: null,
              blockNumber: null,
            }),
            swap: null,
            signingMode:
              request.method === "personal_sign"
                ? "device_personal_sign"
                : "device_sign_typed_data_v4",
            dapp: Object.freeze({
              origin: request.origin,
              method: request.method,
              to: null,
              value: null,
              decodedCall: null,
              counterparty: null,
              message,
              typedData,
              riskFlags: orderRiskFlags(riskFlags),
            }),
            signatureRequest,
            factsObservedAt: now.toISOString(),
            expiresAt: new Date(
              now.getTime() + sendIntentTtlSeconds * 1000,
            ).toISOString(),
          };
          const sealed = sealIntent(source);
          return createOrBusy(() =>
            runtime.repository.create({
              intentId,
              ownerUserId: principal.userId,
              walletId: wallet.walletId,
              providerOperationId: operationId,
              kind: "dapp_sign",
              // Nothing to pre-execute: a message is signable as prepared.
              state: "awaiting_signature",
              chainId: chain.chainId,
              canonicalPayload: sealed.canonicalPayload,
              publicReview: sealed.publicReview,
              reviewSha256: sealed.reviewSha256,
              policyConfigVersion: writes.configVersion,
              factsObservedAt: source.factsObservedAt,
              expiresAt: source.expiresAt,
              simulationStatus: simulation.status,
              requestId,
              canaryAdmission: null,
            }),
          );
        },
      );
      return Object.freeze({
        created: outcome.created,
        resource: project(outcome.record),
      });
    },

    async reportSignature({ principal, intentId, body }) {
      if (typeof body !== "object" || body === null) {
        throw V2ApiError.invalidRequest();
      }
      const raw = (body as { readonly signature?: unknown }).signature;
      if (typeof raw !== "string" || !signaturePattern.test(raw)) {
        throw V2ApiError.invalidRequest();
      }
      const signature = raw.toLowerCase() as Hex;
      const record = await requireIntent(principal, intentId);
      const request = record.canonicalPayload.signatureRequest;
      if (record.kind !== "dapp_sign" || request === undefined) {
        throw V2ApiError.fromCode("VALIDATION_FAILED");
      }
      const requestId = runtime.createUuid();
      let signer: string | null;
      try {
        signer =
          request.method === "personal_sign"
            ? await recoverPersonalSigner(request.params[0], signature)
            : await recoverTypedDataSigner(
                parseTypedData(request.params[1]),
                signature,
              );
      } catch {
        signer = null;
      }
      const signatureSha256 = sha256Hex(signature);
      if (signer !== record.canonicalPayload.from) {
        await runtime.repository.recordEvent({
          ownerUserId: principal.userId,
          intentId: record.intentId,
          eventType: "signature_report_rejected",
          actorType: "api",
          requestId,
          reasonCode: dappReasonCodes.signatureMismatch,
          details: { signatureSha256 },
        });
        refuse(dappReasonCodes.signatureMismatch);
      }
      // A verified signature over the reviewed payload is the whole fact:
      // reporting it again is idempotent.
      if (record.state === "confirmed") {
        return project(record);
      }
      const elapsed = isElapsed(record, runtime.now());
      // The device may sign right before the intent expires, is superseded,
      // or is cancelled elsewhere; the signature exists either way, so it is
      // recorded late (the same tolerance as a late broadcast report).
      const lateReport =
        elapsed ||
        (record.state === "expired" &&
          (record.reasonCode === walletIntentReasonCodes.expired ||
            record.reasonCode === walletIntentReasonCodes.superseded)) ||
        (record.state === "cancelled" &&
          record.reasonCode === walletIntentReasonCodes.cancelled);
      if (!lateReport && record.state !== "awaiting_signature") {
        throw V2ApiError.fromCode("DATA_STALE");
      }
      let confirmed: WalletIntentRecord;
      try {
        confirmed = await runtime.repository.transition({
          ownerUserId: principal.userId,
          intentId: record.intentId,
          expectedVersion: record.recordVersion,
          fromStates: lateReport
            ? ["prepared", "awaiting_signature", "expired", "cancelled"]
            : ["awaiting_signature"],
          toState: "confirmed",
          eventType: lateReport
            ? "late_signature_report"
            : "signature_reported",
          actorType: "api",
          requestId,
          reasonCode: null,
          details: { signatureSha256 },
        });
      } catch (error) {
        if (error instanceof WalletIntentStateConflictError) {
          throw V2ApiError.fromCode("DATA_STALE");
        }
        throw error;
      }
      return project(confirmed);
    },
  };
  return Object.freeze(service);
}
