import { randomUUID } from "node:crypto";

import { encodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";

import { createV2CursorCodec } from "../src/core/http/v2-cursor.js";
import { V2ApiError } from "../src/core/http/v2-error.js";
import {
  digestCanonicalPayload,
  isIntentChainAllowed,
} from "../src/features/wallet-intents/intent-contract.js";
import type {
  ProjectNftDirectory,
  WalletIntentRuntime,
} from "../src/features/wallet-intents/intent-preparation.js";
import { createWalletIntentReconciler } from "../src/features/wallet-intents/intent-reconciliation.js";
import {
  createNftSendService,
  projectNftDirectoryFromLaunch2,
} from "../src/features/wallet-intents/nft-send-service.js";
import { createSendService } from "../src/features/wallet-intents/send-service.js";
import { createWalletIntentService } from "../src/features/wallet-intents/wallet-intent-service.js";
import {
  decodeErc721SafeTransfer,
  erc721SafeTransferFromSelector,
} from "../src/integrations/bsc/erc721-tx.js";
import type {
  BscCallOutcome,
  BscCallRequest,
  BscChainCallClient,
  BscTransactionObservation,
  BscTransactionReceiptObservation,
} from "../src/integrations/bsc/rpc-client.js";
import { fromHexQuantity } from "../src/integrations/bsc/tx-builder.js";
import {
  principal,
  readClientFake,
  recipientAddress,
  runtimeFake,
  usdtAssetId,
  walletAddress,
  walletId,
  type ReadClientFakeOptions,
} from "./wallet-intent-fakes.js";

/**
 * Decision 0194 (S339, LOOP decision 0267): the project NFT send intent on
 * the launch slot (chain 97) with fakes — gates, reason codes, idempotency,
 * the decoded review, the opt-in list, and reconciliation on the slot.
 */

const signal = new AbortController().signal;
const nftAddress = "0x00000000000000000000000000000000000000e7";
const otherContract = "0x00000000000000000000000000000000000000e8";
const contractRecipient = "0x00000000000000000000000000000000000000d4";
const txHash = `0x${"7".repeat(64)}`;
const ownerOfSelector = "0x6352211e";
const instanceId = "5f1a2b3c-4d5e-4f60-8a71-b2c3d4e5f607";

interface ChainOptions {
  /** `ownerOf` answer: an address, `revert` (unminted), or `throw`. */
  readonly owner?: string;
  /** The pre-execution of `safeTransferFrom`. */
  readonly transfer?: BscCallOutcome;
  readonly base?: ReadClientFakeOptions;
}

function launchClient(options: ChainOptions = {}): {
  readonly client: BscChainCallClient;
  readonly calls: BscCallRequest[];
} {
  const calls: BscCallRequest[] = [];
  const base = readClientFake({
    code: { [contractRecipient]: "0x60" },
    ...options.base,
  }).client;
  const owner = options.owner ?? walletAddress;
  const client: BscChainCallClient = {
    ...base,
    chainId: "eip155:97",
    chainReference: 97,
    confirmations: 5,
    call: (request) => {
      calls.push(request);
      if (request.data.startsWith(ownerOfSelector)) {
        if (owner === "throw") {
          return Promise.reject(new Error("rpc down"));
        }
        if (owner === "revert") {
          return Promise.resolve({
            status: "reverted",
            reasonCode: "BSC_CALL_REVERTED",
          });
        }
        return Promise.resolve({
          status: "passed",
          returnData: encodeAbiParameters(
            [{ type: "address" }],
            [owner as `0x${string}`],
          ),
        });
      }
      return Promise.resolve(
        options.transfer ?? { status: "passed", returnData: "0x" },
      );
    },
  };
  return { client, calls };
}

function directoryFake(): ProjectNftDirectory & {
  readonly lookups: string[];
} {
  const lookups: string[] = [];
  return {
    lookups,
    findByContract: ({ chainId, contractAddress }) => {
      lookups.push(contractAddress);
      return Promise.resolve(
        chainId === "eip155:97" && contractAddress === nftAddress
          ? {
              instanceId,
              chainId,
              nftAddress,
              name: "Loop Cat Project",
              ticker: "LCAT",
            }
          : null,
      );
    },
  };
}

function build(
  options: {
    readonly enabled?: boolean;
    readonly slotOpen?: boolean;
    readonly withClient?: boolean;
    readonly writesEnabled?: boolean;
    readonly chain?: ChainOptions;
    readonly counterparties?: readonly string[];
  } = {},
) {
  const fake = runtimeFake({
    ...(options.writesEnabled === false ? { writesEnabled: false } : {}),
    ...(options.counterparties === undefined
      ? {}
      : { canaryCounterpartyAddresses: options.counterparties }),
  });
  const chain = launchClient(options.chain);
  const directory = directoryFake();
  const runtime: WalletIntentRuntime = {
    ...fake.runtime,
    cursorCodec: createV2CursorCodec({
      secret: new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
    }),
    nftSend: {
      enabled: options.enabled ?? true,
      chainId: "eip155:97",
      slotOpen: options.slotOpen ?? true,
      readClient: options.withClient === false ? null : chain.client,
      directory,
    },
  };
  return {
    nft: createNftSendService(runtime),
    send: createSendService(runtime),
    intents: createWalletIntentService(runtime),
    runtime,
    repository: fake.repository,
    chain,
    directory,
  };
}

function sendBodyFor() {
  return { walletId, assetId: usdtAssetId, amount: "1.5", recipientAddress };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    walletId,
    chainId: "eip155:97",
    contractAddress: nftAddress,
    tokenId: "7",
    recipientAddress,
    ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof V2ApiError) {
      return `${error.statusCode}:${error.code}${error.detailsSafe === null ? "" : `:${String(error.detailsSafe["reasonCode"])}`}`;
    }
    throw error;
  }
  return "OK";
}

describe("send_nft intent (Decision 0194)", () => {
  it("admits send_nft on the launch slot's testnet and keeps send on 56", () => {
    expect(isIntentChainAllowed("send_nft", 97)).toBe(true);
    expect(isIntentChainAllowed("send_nft", 56)).toBe(true);
    expect(isIntentChainAllowed("send", 97)).toBe(false);
  });

  it("builds safeTransferFrom(owner, recipient, tokenId) with a decoded review bound to the digest", async () => {
    const { nft, chain, intents } = build();
    const { created, resource } = await nft.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: body({
        contractAddress: nftAddress.toUpperCase().replace("0X", "0x"),
      }),
      signal,
    });
    expect(created).toBe(true);
    expect(resource).toMatchObject({
      kind: "send_nft",
      state: "awaiting_signature",
      chainId: "eip155:97",
      walletId,
      simulation: { status: "passed", source: "rpc_call" },
      signing: { mode: "device_eth_send_transaction", allowed: true },
      policy: {
        configVersion: "bscWriteCanaryV1",
        exposureBasis: "none",
        valueUsd: null,
      },
      review: {
        kind: "send_nft",
        asset: {
          assetId: `eip155:97:${nftAddress}`,
          address: nftAddress,
          symbol: "LCAT",
          decimals: 0,
        },
        amount: { raw: "1", display: "1" },
        spender: null,
        swap: null,
        recipient: { address: recipientAddress, isContract: false },
        decodedCall: {
          functionName: "safeTransferFrom",
          selector: erc721SafeTransferFromSelector,
          args: {
            from: walletAddress,
            to: recipientAddress,
            tokenId: "7",
          },
        },
        nft: {
          contractAddress: nftAddress,
          tokenId: "7",
          projectName: "Loop Cat Project",
        },
        balance: { rawBalance: "1", displayBalance: "1" },
      },
    });
    const transaction = resource.unsignedTransaction;
    expect(transaction).toMatchObject({
      chainId: 97,
      from: walletAddress,
      to: nftAddress,
      value: "0x0",
      nonce: "0x7",
      // 52,000 estimated × 1.2 headroom.
      gas: `0x${(62_400).toString(16)}`,
    });
    expect(decodeErc721SafeTransfer(transaction!.data)).toEqual({
      from: walletAddress,
      to: recipientAddress,
      tokenId: 7n,
    });
    // ownerOf, then the exact payload pre-executed from the owner.
    expect(chain.calls.map((call) => call.data.slice(0, 10))).toEqual([
      ownerOfSelector,
      erc721SafeTransferFromSelector,
    ]);
    expect(chain.calls[1]).toMatchObject({
      from: walletAddress,
      to: nftAddress,
      value: 0n,
    });
    // The record reads back on the launch slot, unchanged.
    const read = await intents.get({ principal, intentId: resource.intentId });
    expect(read.reviewSha256).toBe(resource.reviewSha256);
    expect(read.chainId).toBe("eip155:97");
  });

  it("replays the same key to the same intent and refuses a different request on it", async () => {
    const { nft, repository } = build();
    const key = randomUUID();
    const first = await nft.prepare({
      principal,
      idempotencyKey: key,
      body: body(),
      signal,
    });
    const replay = await nft.prepare({
      principal,
      idempotencyKey: key,
      body: body(),
      signal,
    });
    expect(replay.created).toBe(false);
    expect(replay.resource.intentId).toBe(first.resource.intentId);
    expect(repository.records.size).toBe(1);
    expect(
      await codeOf(
        nft.prepare({
          principal,
          idempotencyKey: key,
          body: body({ tokenId: "8" }),
          signal,
        }),
      ),
    ).toBe("409:IDEMPOTENCY_CONFLICT");
  });

  it("refuses with the 422 reason codes", async () => {
    // Someone else owns it / it was never minted.
    expect(
      await codeOf(
        build({
          chain: { owner: "0x00000000000000000000000000000000000000f1" },
        }).nft.prepare({
          principal,
          idempotencyKey: randomUUID(),
          body: body(),
          signal,
        }),
      ),
    ).toBe("422:VALIDATION_FAILED:NFT_NOT_OWNED");
    expect(
      await codeOf(
        build({ chain: { owner: "revert" } }).nft.prepare({
          principal,
          idempotencyKey: randomUUID(),
          body: body(),
          signal,
        }),
      ),
    ).toBe("422:VALIDATION_FAILED:NFT_NOT_OWNED");
    // Not a LOOP project NFT.
    const unsupported = build();
    expect(
      await codeOf(
        unsupported.nft.prepare({
          principal,
          idempotencyKey: randomUUID(),
          body: body({ contractAddress: otherContract }),
          signal,
        }),
      ),
    ).toBe("422:VALIDATION_FAILED:NFT_CONTRACT_UNSUPPORTED");
    expect(unsupported.chain.calls).toEqual([]);
    // A contract recipient whose onERC721Received refuses.
    expect(
      await codeOf(
        build({
          chain: {
            transfer: { status: "reverted", reasonCode: "BSC_CALL_REVERTED" },
          },
        }).nft.prepare({
          principal,
          idempotencyKey: randomUUID(),
          body: body({ recipientAddress: contractRecipient }),
          signal,
        }),
      ),
    ).toBe("422:VALIDATION_FAILED:NFT_RECIPIENT_REJECTS");
    // The same revert towards an account is a payload the chain refuses.
    expect(
      await codeOf(
        build({
          chain: {
            transfer: { status: "reverted", reasonCode: "BSC_CALL_REVERTED" },
          },
        }).nft.prepare({
          principal,
          idempotencyKey: randomUUID(),
          body: body(),
          signal,
        }),
      ),
    ).toBe("409:SIMULATION_FAILED");
    // To itself.
    expect(
      await codeOf(
        build().nft.prepare({
          principal,
          idempotencyKey: randomUUID(),
          body: body({ recipientAddress: walletAddress }),
          signal,
        }),
      ),
    ).toBe("422:VALIDATION_FAILED:RECIPIENT_SELF");
  });

  it("fails closed: switch off, no slot, writes off, wrong chain, gas, shape, counterparty", async () => {
    const prepare = (
      built: ReturnType<typeof build>,
      overrides: Record<string, unknown> = {},
    ) =>
      codeOf(
        built.nft.prepare({
          principal,
          idempotencyKey: randomUUID(),
          body: body(overrides),
          signal,
        }),
      );
    expect(await prepare(build({ enabled: false }))).toBe(
      "503:CAPABILITY_UNAVAILABLE:NFT_SEND_DISABLED",
    );
    expect(await prepare(build({ slotOpen: false }))).toBe(
      "503:CAPABILITY_UNAVAILABLE:NFT_SEND_CHAIN_UNAVAILABLE",
    );
    expect(await prepare(build({ withClient: false }))).toBe(
      "503:CAPABILITY_UNAVAILABLE:NFT_SEND_CHAIN_UNAVAILABLE",
    );
    expect(await prepare(build({ writesEnabled: false }))).toBe(
      "503:CAPABILITY_UNAVAILABLE",
    );
    expect(await prepare(build({ chain: { base: { verified: false } } }))).toBe(
      "503:CAPABILITY_UNAVAILABLE",
    );
    expect(await prepare(build({ chain: { owner: "throw" } }))).toBe(
      "503:CAPABILITY_UNAVAILABLE",
    );
    expect(await prepare(build(), { chainId: "eip155:56" })).toBe(
      "422:CHAIN_MISMATCH",
    );
    expect(
      await prepare(build({ chain: { base: { nativeBalance: 1n } } })),
    ).toBe("409:INSUFFICIENT_BALANCE");
    for (const tokenId of ["-1", "07", "1.5", "", `1${"0".repeat(78)}`]) {
      expect(await prepare(build(), { tokenId }), tokenId).toBe(
        "400:INVALID_REQUEST",
      );
    }
    expect(
      await prepare(build(), {
        recipientAddress: "0x0000000000000000000000000000000000000000",
      }),
    ).toBe("400:INVALID_REQUEST");
    expect(await prepare(build({ counterparties: [contractRecipient] }))).toBe(
      "403:POLICY_BLOCKED:COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST",
    );
  });

  it("leaves a payload whose estimate is unavailable unsignable", async () => {
    const { nft } = build({ chain: { base: { gasEstimate: null } } });
    const { resource } = await nft.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: body(),
      signal,
    });
    expect(resource).toMatchObject({
      state: "prepared",
      signing: { allowed: false, reasonCode: "GAS_ESTIMATE_UNAVAILABLE" },
    });
  });

  it("checks the recipient on the launch slot through the send preflight only while enabled", async () => {
    const { send } = build();
    const preflight = await send.preflight({
      principal,
      body: { walletId, address: contractRecipient, chainId: "eip155:97" },
    });
    expect(preflight).toMatchObject({
      chainId: "eip155:97",
      recipient: { address: contractRecipient, isContract: true },
    });
    expect(
      await codeOf(
        build({ enabled: false }).send.preflight({
          principal,
          body: { walletId, address: recipientAddress, chainId: "eip155:97" },
        }),
      ),
    ).toBe("422:CHAIN_MISMATCH");
    // The primary chain is unchanged.
    expect(
      (
        await send.preflight({
          principal,
          body: { walletId, address: recipientAddress },
        })
      ).chainId,
    ).toBe("eip155:56");
  });

  it("hides send_nft from the list unless the client opts in, with cursors bound to the opt-in", async () => {
    const { nft, send, intents } = build();
    const sent = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBodyFor(),
      signal,
    });
    const nftIntent = await nft.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: body(),
      signal,
    });
    const plain = await intents.list({ principal });
    expect(plain.items.map((item) => item.kind)).toEqual(["send"]);
    // Every other kind keeps the closed review key set (no `nft`).
    expect(Object.keys(plain.items[0]!.review).sort()).toEqual(
      [
        "amount",
        "asset",
        "balance",
        "decodedCall",
        "fee",
        "kind",
        "recipient",
        "spender",
        "swap",
      ].sort(),
    );
    expect(Object.keys(nftIntent.resource.review.decodedCall!.args)).toEqual([
      "from",
      "to",
      "tokenId",
    ]);
    expect(plain.items[0]?.intentId).toBe(sent.resource.intentId);
    const opted = await intents.list({
      principal,
      includeKinds: "send_nft",
    });
    expect(opted.items.map((item) => item.intentId).sort()).toEqual(
      [sent.resource.intentId, nftIntent.resource.intentId].sort(),
    );
    for (const includeKinds of ["swap", "send_nft,send_nft", "", "SEND_NFT"]) {
      expect(
        await codeOf(intents.list({ principal, includeKinds })),
        includeKinds,
      ).toBe("400:INVALID_REQUEST");
    }
    const firstPage = await intents.list({ principal, limit: 1 });
    expect(firstPage.nextCursor).toBeNull();
    const optedPage = await intents.list({
      principal,
      limit: 1,
      includeKinds: "send_nft",
    });
    expect(optedPage.nextCursor).not.toBeNull();
    // A cursor minted with the opt-in does not continue without it.
    expect(
      await codeOf(
        intents.list({ principal, cursor: optedPage.nextCursor ?? "" }),
      ),
    ).toBe("400:INVALID_REQUEST");
    const next = await intents.list({
      principal,
      cursor: optedPage.nextCursor ?? "",
      includeKinds: "send_nft",
    });
    expect(next.items).toHaveLength(1);
  });

  it("is reported, verified on the launch slot, and confirmed by the reconciliation lane", async () => {
    const transactions = new Map<string, BscTransactionObservation | null>();
    const receipts = new Map<string, BscTransactionReceiptObservation | null>();
    const { nft, intents, runtime, repository, chain } = build({
      chain: { base: { transactions, receipts } },
    });
    const { resource } = await nft.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: body(),
      signal,
    });
    const transaction = resource.unsignedTransaction!;
    transactions.set(txHash, {
      hash: txHash,
      from: transaction.from,
      to: transaction.to,
      input: transaction.data,
      value: fromHexQuantity(transaction.value),
      nonce: Number(fromHexQuantity(transaction.nonce)),
      chainId: 97,
      blockNumber: null,
    });
    const reported = await intents.reportBroadcast({
      principal,
      intentId: resource.intentId,
      body: { txHash },
    });
    expect(reported).toMatchObject({ state: "submitted", kind: "send_nft" });
    receipts.set(txHash, {
      hash: txHash,
      status: "success",
      blockNumber: 43_999_900n,
      blockHash: `0x${"4".repeat(64)}`,
      gasUsed: 61_000n,
      effectiveGasPrice: 1_000_000_000n,
    });
    for (const record of repository.records.values()) {
      repository.records.set(record.intentId, {
        ...record,
        reconcileAfter: null,
      });
    }
    // The primary client would not know the hash: only the slot's does.
    const primary = readClientFake().client;
    const reconciler = createWalletIntentReconciler({
      repository: runtime.repository,
      wallets: runtime.wallets,
      readClient: primary,
      launchReadClient: chain.client,
      swapAdapter: runtime.swapAdapter,
      createUuid: randomUUID,
    });
    const result = await reconciler.reconcileOnce();
    expect(result.transitions).toEqual([
      { intentId: resource.intentId, toState: "confirmed", reasonCode: null },
    ]);
    const record = repository.records.get(resource.intentId)!;
    expect(digestCanonicalPayload(record.canonicalPayload)).toBe(
      resource.reviewSha256,
    );
  });

  it("maps the launch2 repository to the directory, or none without the lookup", async () => {
    expect(projectNftDirectoryFromLaunch2(undefined)).toBeNull();
    expect(projectNftDirectoryFromLaunch2({})).toBeNull();
    const directory = projectNftDirectoryFromLaunch2({
      getInstanceByNftAddress: ({ chainId, nftAddress: address }) =>
        Promise.resolve(
          address === nftAddress
            ? ({
                instanceId,
                chainId,
                name: "Loop Cat Project",
                ticker: "LCAT",
                addresses: { nft: nftAddress },
              } as never)
            : null,
        ),
    });
    expect(
      await directory?.findByContract({
        chainId: "eip155:97",
        contractAddress: nftAddress,
      }),
    ).toEqual({
      instanceId,
      chainId: "eip155:97",
      nftAddress,
      name: "Loop Cat Project",
      ticker: "LCAT",
    });
    expect(
      await directory?.findByContract({
        chainId: "eip155:97",
        contractAddress: otherContract,
      }),
    ).toBeNull();
  });
});
