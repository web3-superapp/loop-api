import {
  createL1ActionHash,
  signL1Action,
  type AbstractViemLocalAccount,
} from "@nktkas/hyperliquid/signing";
import { recoverTypedDataAddress } from "viem";
import { z } from "zod";

import type {
  SpotIocSignature,
  SpotIocSigner,
} from "../../features/spot/spot-intent-submission.js";
import {
  assertHyperliquidSpotIocTiming,
  HyperliquidSpotIocAdapterUnavailableError,
  parseHyperliquidSpotIocAction,
  parseHyperliquidSpotIocAddress,
  parseHyperliquidSpotIocRequestId,
  parseHyperliquidSpotIocSignature,
  parseHyperliquidSpotIocSignatureHex,
  parseHyperliquidSpotIocSignerRef,
} from "./spot-ioc-wire.js";

const eip712Domain = Object.freeze({
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const);
const agentTypes = Object.freeze({
  Agent: Object.freeze([
    Object.freeze({ name: "source", type: "string" }),
    Object.freeze({ name: "connectionId", type: "bytes32" }),
  ]),
});
const signingInputSchema = z
  .object({
    signingRequestId: z.string(),
    network: z.literal("testnet"),
    signerRef: z.string(),
    expectedSignerAddress: z.string(),
    action: z.unknown(),
    nonce: z.string(),
    vaultAddress: z.null(),
    expiresAfter: z.string(),
    attemptDeadlineAt: z.string(),
    signal: z.instanceof(AbortSignal),
  })
  .strict();

export type HyperliquidSpotIocTypedData = Parameters<
  AbstractViemLocalAccount["signTypedData"]
>[0];

/**
 * Remote signing boundary for one already-journaled Agent. Implementations
 * must locate the wallet only by signerRef, pass signingRequestId as provider
 * idempotency, and pass requestExpiryMilliseconds as the provider request
 * expiry. expectedSignerAddress is an assertion, never a lookup key.
 */
export interface HyperliquidSpotIocRemoteTypedDataSigner {
  signTypedData(input: {
    readonly signingRequestId: string;
    readonly signerRef: string;
    readonly expectedSignerAddress: `0x${string}`;
    readonly typedData: HyperliquidSpotIocTypedData;
    readonly requestExpiryMilliseconds: number;
    readonly signal: AbortSignal;
  }): Promise<string>;
}

export interface CreateHyperliquidSpotIocSignerInput {
  readonly remoteSigner: HyperliquidSpotIocRemoteTypedDataSigner;
  readonly now?: () => Date;
}

function unavailable(): never {
  throw new HyperliquidSpotIocAdapterUnavailableError();
}

function readNow(now: () => Date): number {
  let value: unknown;
  try {
    value = now();
  } catch {
    return unavailable();
  }
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) {
    return unavailable();
  }
  return value.getTime();
}

function signatureHex(rawSignature: unknown): `0x${string}` {
  const signature = parseHyperliquidSpotIocSignature(rawSignature);
  return `0x${signature.r.slice(2)}${signature.s.slice(2)}${(signature.v - 27)
    .toString(16)
    .padStart(2, "0")}`;
}

export function createHyperliquidSpotIocSigner(
  input: CreateHyperliquidSpotIocSignerInput,
): SpotIocSigner {
  const now = input.now ?? (() => new Date());

  return Object.freeze({
    async sign(inputValue: unknown) {
      const parsedInput = signingInputSchema.safeParse(inputValue);
      if (!parsedInput.success) {
        return unavailable();
      }
      const rawInput = parsedInput.data;
      const action = parseHyperliquidSpotIocAction(rawInput.action);
      const signingAction = action as unknown as Record<string, unknown>;
      const expectedSignerAddress = parseHyperliquidSpotIocAddress(
        rawInput.expectedSignerAddress,
      );
      const signingRequestId = parseHyperliquidSpotIocRequestId(
        rawInput.signingRequestId,
      );
      const signerRef = parseHyperliquidSpotIocSignerRef(rawInput.signerRef);
      const timing = assertHyperliquidSpotIocTiming({
        nonce: rawInput.nonce,
        expiresAfter: rawInput.expiresAfter,
        attemptDeadlineAt: rawInput.attemptDeadlineAt,
        signal: rawInput.signal,
        nowMilliseconds: readNow(now),
      });

      try {
        const wallet = Object.freeze({
          address: expectedSignerAddress,
          async signTypedData(typedData: HyperliquidSpotIocTypedData) {
            const signature = await input.remoteSigner.signTypedData({
              signingRequestId,
              signerRef,
              expectedSignerAddress,
              typedData,
              requestExpiryMilliseconds: timing.attemptDeadlineAt,
              signal: rawInput.signal,
            });
            rawInput.signal.throwIfAborted();
            return parseHyperliquidSpotIocSignatureHex(signature);
          },
        }) satisfies AbstractViemLocalAccount;

        const signature = await signL1Action({
          wallet,
          action: signingAction,
          nonce: timing.nonce,
          isTestnet: true,
          expiresAfter: timing.expiresAfter,
        });
        rawInput.signal.throwIfAborted();
        const normalized = parseHyperliquidSpotIocSignature({
          r: signature.r.toLowerCase(),
          s: signature.s.toLowerCase(),
          v: signature.v,
        }) satisfies SpotIocSignature;
        const connectionId = createL1ActionHash({
          action: signingAction,
          nonce: timing.nonce,
          expiresAfter: timing.expiresAfter,
        });
        const recoveredAddress = await recoverTypedDataAddress({
          domain: eip712Domain,
          types: agentTypes,
          primaryType: "Agent",
          message: { source: "b", connectionId },
          signature: signatureHex(normalized),
        });
        rawInput.signal.throwIfAborted();
        if (recoveredAddress.toLowerCase() !== expectedSignerAddress) {
          return unavailable();
        }
        return normalized;
      } catch {
        rawInput.signal.throwIfAborted();
        return unavailable();
      }
    },
  });
}
