import { randomUUID } from "node:crypto";

import {
  encodeFunctionData,
  hashTypedData,
  maxUint256,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { createV2CursorCodec } from "../src/core/http/v2-cursor.js";
import { V2ApiError } from "../src/core/http/v2-error.js";
import { createDappContractDirectory } from "../src/features/dapp-browser/contract-directory.js";
import {
  decodeDappCall,
  permit2Address,
} from "../src/features/wallet-intents/dapp-call-decoder.js";
import {
  createDappIntentService,
  normalizeDappOrigin,
} from "../src/features/wallet-intents/dapp-intent-service.js";
import {
  parseTypedData,
  personalSignRiskFlags,
  reviewPersonalSignMessage,
  reviewTypedData,
  typedDataBinding,
  typedDataDigest,
  typedDataRiskFlags,
} from "../src/features/wallet-intents/dapp-sign-review.js";
import {
  digestCanonicalPayload,
  isIntentChainAllowed,
} from "../src/features/wallet-intents/intent-contract.js";
import type {
  DappContractDirectory,
  WalletIntentRuntime,
} from "../src/features/wallet-intents/intent-preparation.js";
import { createWalletIntentReconciler } from "../src/features/wallet-intents/intent-reconciliation.js";
import { createWalletIntentService } from "../src/features/wallet-intents/wallet-intent-service.js";
import { loopRouterAbi } from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
import type {
  BscCallOutcome,
  BscCallRequest,
  BscChainCallClient,
  BscTransactionObservation,
  BscTransactionReceiptObservation,
} from "../src/integrations/bsc/rpc-client.js";
import { fromHexQuantity } from "../src/integrations/bsc/tx-builder.js";
import {
  embeddedWallet,
  externalWallet,
  externalWalletId,
  principal,
  readClientFake,
  runtimeFake,
  walletAddress,
  walletId,
  walletsFake,
} from "./wallet-intent-fakes.js";

/**
 * Decision 0197 (S342, LOOP decision 0270): the DApp browser signing exit
 * with fakes — the calldata decoder and its risk flags, the message /
 * typed-data review and Permit recognition, the chain / origin / switch
 * gates, idempotency, the opt-in list, the dapp_tx lifecycle through
 * broadcast-report and reconciliation, and the dapp_sign signature report
 * (real ECDSA signatures, ecrecover).
 */

const signal = new AbortController().signal;
const token = "0x00000000000000000000000000000000000000d1";
const nft = "0x00000000000000000000000000000000000000d2";
const loopRouter = "0x00000000000000000000000000000000000000d3";
const spender = "0x00000000000000000000000000000000000000c3";
const contractSpender = "0x00000000000000000000000000000000000000c4";
const eoa = "0x00000000000000000000000000000000000000b2";
const txHash = `0x${"9".repeat(64)}`;
const erc165Selector = "0x01ffc9a7";

const erc20 = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
]);
const erc721 = parseAbi([
  "function approve(address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
  "function setApprovalForAll(address operator, bool approved)",
]);
const permit2 = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

const approveUnlimited = encodeFunctionData({
  abi: erc20,
  functionName: "approve",
  args: [spender, maxUint256],
});

interface ChainOptions {
  readonly call?: BscCallOutcome;
  readonly erc721?: readonly string[];
  readonly gasEstimate?: bigint | null;
  readonly transactions?: Map<string, BscTransactionObservation | null>;
  readonly receipts?: Map<string, BscTransactionReceiptObservation | null>;
  readonly nativeBalance?: bigint;
}

function slotClient(options: ChainOptions = {}): {
  readonly client: BscChainCallClient;
  readonly calls: BscCallRequest[];
} {
  const calls: BscCallRequest[] = [];
  const base = readClientFake({
    code: {
      [token]: "0x60",
      [nft]: "0x60",
      [loopRouter]: "0x60",
      [contractSpender]: "0x60",
      [permit2Address]: "0x60",
    },
    ...(options.gasEstimate === undefined
      ? {}
      : { gasEstimate: options.gasEstimate }),
    ...(options.transactions === undefined
      ? {}
      : { transactions: options.transactions }),
    ...(options.receipts === undefined ? {} : { receipts: options.receipts }),
    ...(options.nativeBalance === undefined
      ? {}
      : { nativeBalance: options.nativeBalance }),
  }).client;
  const client: BscChainCallClient = {
    ...base,
    chainId: "eip155:97",
    chainReference: 97,
    confirmations: 5,
    call: (request) => {
      calls.push(request);
      if (request.data.startsWith(erc165Selector)) {
        const yes = (options.erc721 ?? []).includes(request.to);
        return Promise.resolve({
          status: "passed",
          returnData: `0x${(yes ? "1" : "0").padStart(64, "0")}`,
        });
      }
      return Promise.resolve(
        options.call ?? { status: "passed", returnData: "0x" },
      );
    },
  };
  return { client, calls };
}

const directory: DappContractDirectory = createDappContractDirectory({
  statics: {
    chainId: "eip155:97",
    loopRouter,
    poolRouter: null,
    routerRegistry: null,
    factories: [],
    launchContract: null,
    usd1: null,
  },
});

function build(
  options: {
    readonly enabled?: boolean;
    readonly withClient?: boolean;
    readonly writesEnabled?: boolean;
    readonly chain?: ChainOptions;
    readonly counterparties?: readonly string[];
    readonly walletAddressOverride?: string;
  } = {},
) {
  const fake = runtimeFake({
    ...(options.writesEnabled === false ? { writesEnabled: false } : {}),
    ...(options.counterparties === undefined
      ? {}
      : { canaryCounterpartyAddresses: options.counterparties }),
  });
  const chain = slotClient(options.chain);
  const runtime: WalletIntentRuntime = {
    ...fake.runtime,
    ...(options.walletAddressOverride === undefined
      ? {}
      : {
          wallets: walletsFake([
            { ...embeddedWallet, address: options.walletAddressOverride },
            externalWallet,
          ]),
        }),
    cursorCodec: createV2CursorCodec({
      secret: new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
    }),
    dapp: {
      enabled: options.enabled ?? true,
      signingChainId: options.withClient === false ? null : "eip155:97",
      signingClient: options.withClient === false ? null : chain.client,
      directory,
    },
  };
  return {
    dapp: createDappIntentService(runtime),
    intents: createWalletIntentService(runtime),
    runtime,
    repository: fake.repository,
    chain,
  };
}

function txBody(overrides: Record<string, unknown> = {}) {
  return {
    walletId,
    chainId: "eip155:97",
    origin: "https://app.example.org",
    tx: { to: token, data: approveUnlimited, value: "0x0" },
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

const mailTypedData = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Person: [
      { name: "name", type: "string" },
      { name: "wallet", type: "address" },
    ],
    Mail: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person" },
      { name: "contents", type: "string" },
    ],
  },
  primaryType: "Mail",
  domain: {
    name: "Ether Mail",
    version: "1",
    chainId: 97,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  },
  message: {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    contents: "Hello, Bob!",
  },
};

function permitTypedData(value: string, chainId: number | string = 97) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    domain: {
      name: "USD1",
      version: "1",
      chainId,
      verifyingContract: token,
    },
    message: {
      owner: walletAddress,
      spender,
      value,
      nonce: "0",
      deadline: "1900000000",
    },
  };
}

const permit2Single = {
  types: {
    PermitDetails: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
    PermitSingle: [
      { name: "details", type: "PermitDetails" },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" },
    ],
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
  },
  domain: {
    name: "Permit2",
    chainId: "0x61",
    verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
  primaryType: "PermitSingle",
  message: {
    details: {
      token,
      amount: "1461501637330902918203684832716283019655932542975",
      expiration: 1900000000,
      nonce: 0,
    },
    spender,
    sigDeadline: "1900000000",
  },
};

describe("DApp calldata decoder (Decision 0197)", () => {
  const decode = (
    data: Hex,
    to = token,
    flags: { erc721?: boolean; loop?: boolean } = {},
  ) =>
    decodeDappCall({
      data,
      to,
      targetIsErc721: flags.erc721 ?? false,
      targetIsLoop: flags.loop ?? false,
    });

  it("decodes ERC-20 transfer / approve / increaseAllowance with the unlimited flag at 2^128", () => {
    const transfer = decode(
      encodeFunctionData({
        abi: erc20,
        functionName: "transfer",
        args: [eoa, 5n],
      }),
    );
    expect(transfer.call).toEqual({
      functionName: "transfer",
      selector: "0xa9059cbb",
      standard: "erc20",
      args: { to: eoa, amount: "5" },
      dataLength: 68,
    });
    expect(transfer.counterparty).toEqual({ role: "recipient", address: eoa });
    expect(transfer.flags).toEqual([]);

    const unlimited = decode(approveUnlimited);
    expect(unlimited.call.functionName).toBe("approve");
    expect(unlimited.call.args).toEqual({
      spender,
      amount: maxUint256.toString(10),
    });
    expect(unlimited.counterparty).toEqual({
      role: "spender",
      address: spender,
    });
    expect(unlimited.flags).toEqual(["UNLIMITED_APPROVAL"]);

    const exact = decode(
      encodeFunctionData({
        abi: erc20,
        functionName: "approve",
        args: [spender, (1n << 128n) - 1n],
      }),
    );
    expect(exact.flags).toEqual([]);
    const increase = decode(
      encodeFunctionData({
        abi: erc20,
        functionName: "increaseAllowance",
        args: [spender, 1n << 128n],
      }),
    );
    expect(increase.call.functionName).toBe("increaseAllowance");
    expect(increase.flags).toEqual(["UNLIMITED_APPROVAL"]);
  });

  it("decodes ERC-721 approve (after the ERC-165 probe), both safeTransferFrom overloads and setApprovalForAll", () => {
    const approve = decode(
      encodeFunctionData({
        abi: erc721,
        functionName: "approve",
        args: [spender, maxUint256],
      }),
      nft,
      { erc721: true },
    );
    expect(approve.call).toMatchObject({
      functionName: "approve",
      standard: "erc721",
      args: { to: spender, tokenId: maxUint256.toString(10) },
    });
    // A token ID is not an allowance.
    expect(approve.flags).toEqual([]);
    const safe = decode(
      encodeFunctionData({
        abi: erc721,
        functionName: "safeTransferFrom",
        args: [walletAddress, eoa, 7n],
      }),
      nft,
    );
    expect(safe.call).toMatchObject({
      functionName: "safeTransferFrom",
      selector: "0x42842e0e",
      standard: "erc721",
      args: { from: walletAddress, to: eoa, tokenId: "7" },
    });
    expect(safe.counterparty).toEqual({ role: "recipient", address: eoa });
    const withData = decode(
      encodeFunctionData({
        abi: erc721,
        functionName: "safeTransferFrom",
        args: [walletAddress, eoa, 7n, "0xbeef"],
      }),
      nft,
    );
    expect(withData.call).toMatchObject({
      functionName: "safeTransferFrom",
      selector: "0xb88d4fde",
      args: { from: walletAddress, to: eoa, tokenId: "7", data: "0xbeef" },
    });
    const all = decode(
      encodeFunctionData({
        abi: erc721,
        functionName: "setApprovalForAll",
        args: [contractSpender, true],
      }),
      nft,
    );
    expect(all.call).toMatchObject({
      functionName: "setApprovalForAll",
      args: { operator: contractSpender, approved: "true" },
    });
    expect(all.counterparty).toEqual({
      role: "operator",
      address: contractSpender,
    });
    expect(all.flags).toEqual(["APPROVAL_FOR_ALL"]);
    const revokeAll = decode(
      encodeFunctionData({
        abi: erc721,
        functionName: "setApprovalForAll",
        args: [contractSpender, false],
      }),
      nft,
    );
    expect(revokeAll.flags).toEqual([]);
  });

  it("decodes Permit2 approve only on the Permit2 address", () => {
    const data = encodeFunctionData({
      abi: permit2,
      functionName: "approve",
      args: [token, spender, (1n << 160n) - 1n, 1_900_000_000],
    });
    const onPermit2 = decode(data, permit2Address);
    expect(onPermit2.call).toMatchObject({
      functionName: "approve",
      standard: "permit2",
      args: { token, spender, expiration: "1900000000" },
    });
    expect(onPermit2.flags).toEqual(["UNLIMITED_APPROVAL"]);
    const elsewhere = decode(data, token);
    expect(elsewhere.call).toEqual({
      functionName: null,
      selector: "0x87517c45",
      standard: null,
      args: {},
      dataLength: 132,
    });
  });

  it("names LOOP router methods only on a LOOP-known target; unknown selectors stay null", () => {
    const data = encodeFunctionData({
      abi: loopRouterAbi,
      functionName: "swapExactInput",
      args: [
        {
          currency0: token,
          currency1: nft,
          fee: 3000,
          tickSpacing: 60,
          hooks: loopRouter,
        },
        true,
        10n,
        9n,
        0n,
        1_900_000_000n,
      ],
    });
    const known = decode(data, loopRouter, { loop: true });
    expect(known.call.functionName).toBe("swapExactInput");
    expect(known.call.standard).toBe("loop");
    expect(known.call.args["amountIn"]).toBe("10");
    expect(known.call.args["key"]).toContain(token);
    const unknown = decode(data, contractSpender);
    expect(unknown.call.functionName).toBeNull();
    expect(unknown.call.selector).toBe(data.slice(0, 10));
    const plain = decode("0x", eoa);
    expect(plain.call).toEqual({
      functionName: null,
      selector: null,
      standard: null,
      args: {},
      dataLength: 0,
    });
  });
});

describe("DApp message review (Decision 0197)", () => {
  it("shows printable UTF-8 as text and anything else as hex", () => {
    expect(reviewPersonalSignMessage("Sign in to example.org")).toEqual({
      encoding: "utf8",
      text: "Sign in to example.org",
      hex: `0x${Buffer.from("Sign in to example.org").toString("hex")}`,
      byteLength: 22,
    });
    const siwe = `0x${Buffer.from("example.org wants you to sign in\nNonce: 1").toString("hex")}`;
    expect(reviewPersonalSignMessage(siwe)).toMatchObject({
      encoding: "utf8",
      text: "example.org wants you to sign in\nNonce: 1",
    });
    expect(reviewPersonalSignMessage("0xdeadbeef00")).toEqual({
      encoding: "hex",
      text: null,
      hex: "0xdeadbeef00",
      byteLength: 5,
    });
  });

  it("flattens typed data and recognises EIP-2612 Permit and Permit2", () => {
    const mail = parseTypedData(JSON.stringify(mailTypedData));
    const mailReview = reviewTypedData(mail);
    expect(mailReview.domain).toEqual({
      name: "Ether Mail",
      version: "1",
      chainId: "97",
      verifyingContract: "0xcccccccccccccccccccccccccccccccccccccccc",
      salt: null,
    });
    expect(mailReview.fields).toEqual([
      { path: "from.name", type: "string", value: "Cow", truncated: false },
      {
        path: "from.wallet",
        type: "address",
        value: "0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826",
        truncated: false,
      },
      { path: "to.name", type: "string", value: "Bob", truncated: false },
      {
        path: "to.wallet",
        type: "address",
        value: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        truncated: false,
      },
      {
        path: "contents",
        type: "string",
        value: "Hello, Bob!",
        truncated: false,
      },
    ]);
    // S346 (A2): a primary type the review does not recognise is flagged.
    expect(typedDataRiskFlags(mail, mailReview)).toEqual([
      "UNRECOGNIZED_TYPED_DATA",
    ]);

    const permit = parseTypedData(JSON.stringify(permitTypedData("1000")));
    expect(typedDataRiskFlags(permit, reviewTypedData(permit))).toEqual([
      "PERMIT_SIGNATURE",
    ]);
    const maxPermit = parseTypedData(
      JSON.stringify(permitTypedData(maxUint256.toString(10))),
    );
    expect(typedDataRiskFlags(maxPermit, reviewTypedData(maxPermit))).toEqual([
      "PERMIT_SIGNATURE",
      "UNLIMITED_APPROVAL",
    ]);
    const single = parseTypedData(JSON.stringify(permit2Single));
    const singleReview = reviewTypedData(single);
    expect(single.domainChainId).toBe(97n);
    expect(singleReview.fields.map((field) => field.path)).toEqual([
      "details.token",
      "details.amount",
      "details.expiration",
      "details.nonce",
      "spender",
      "sigDeadline",
    ]);
    expect(typedDataRiskFlags(single, singleReview)).toEqual([
      "PERMIT_SIGNATURE",
      "UNLIMITED_APPROVAL",
    ]);
  });

  it("refuses payloads that do not hash under EIP-712", () => {
    for (const payload of [
      "{",
      JSON.stringify({ ...mailTypedData, primaryType: "Missing" }),
      JSON.stringify({
        ...mailTypedData,
        message: { ...mailTypedData.message, contents: 7 },
      }),
      JSON.stringify({
        ...mailTypedData,
        domain: { ...mailTypedData.domain, extra: "x" },
      }),
    ]) {
      expect(() => parseTypedData(payload)).toThrow();
    }
  });
});

describe("dapp_tx intents (Decision 0197)", () => {
  it("is 503 DAPP_BROWSER_DISABLED while the switch is off and gates chain / origin / slot", async () => {
    expect(
      await codeOf(
        build({ enabled: false }).dapp.prepareTransaction({
          principal,
          idempotencyKey: randomUUID(),
          body: txBody(),
          signal,
        }),
      ),
    ).toBe("503:CAPABILITY_UNAVAILABLE:DAPP_BROWSER_DISABLED");
    const { dapp } = build();
    const prepare = (body: unknown) =>
      codeOf(
        dapp.prepareTransaction({
          principal,
          idempotencyKey: randomUUID(),
          body,
          signal,
        }),
      );
    expect(await prepare(txBody({ chainId: "eip155:56" }))).toBe(
      "422:VALIDATION_FAILED:CHAIN_SIGNING_DISABLED",
    );
    expect(await prepare(txBody({ chainId: "eip155:1" }))).toBe(
      "422:CHAIN_MISMATCH",
    );
    expect(await prepare(txBody({ origin: "http://app.example.org" }))).toBe(
      "422:VALIDATION_FAILED:ORIGIN_NOT_HTTPS",
    );
    for (const origin of [
      "https://app.example.org/path",
      "https://user:pw@app.example.org",
      "javascript:alert(1)",
      "app.example.org",
    ]) {
      expect(await prepare(txBody({ origin }))).toBe("400:INVALID_REQUEST");
    }
    expect(await prepare(txBody({ walletId: externalWalletId }))).toBe(
      "422:VALIDATION_FAILED",
    );
    expect(
      await codeOf(
        build({ withClient: false }).dapp.prepareTransaction({
          principal,
          idempotencyKey: randomUUID(),
          body: txBody(),
          signal,
        }),
      ),
    ).toBe("503:CAPABILITY_UNAVAILABLE:DAPP_BROWSER_CHAIN_UNAVAILABLE");
    // Mainnet stays refused even with the slot missing.
    expect(
      await codeOf(
        build({ withClient: false }).dapp.prepareTransaction({
          principal,
          idempotencyKey: randomUUID(),
          body: txBody({ chainId: "eip155:56" }),
          signal,
        }),
      ),
    ).toBe("422:VALIDATION_FAILED:CHAIN_SIGNING_DISABLED");
    expect(
      await codeOf(
        build({ writesEnabled: false }).dapp.prepareTransaction({
          principal,
          idempotencyKey: randomUUID(),
          body: txBody(),
          signal,
        }),
      ),
    ).toBe("503:CAPABILITY_UNAVAILABLE");
    expect(isIntentChainAllowed("dapp_tx", 97)).toBe(true);
    expect(normalizeDappOrigin("https://APP.Example.org:443")).toBe(
      "https://app.example.org",
    );
    expect(normalizeDappOrigin("https://bücher.example:8443/")).toBe(
      "https://xn--bcher-kva.example:8443",
    );
  });

  it("builds an unlimited approve on the slot with the decoded review and risk flags", async () => {
    const { dapp, repository } = build();
    const key = randomUUID();
    const created = await dapp.prepareTransaction({
      principal,
      idempotencyKey: key,
      body: txBody(),
      signal,
    });
    expect(created.created).toBe(true);
    const intent = created.resource;
    expect(intent).toMatchObject({
      kind: "dapp_tx",
      chainId: "eip155:97",
      state: "awaiting_signature",
      signing: {
        mode: "device_eth_send_transaction",
        allowed: true,
        reasonCode: null,
      },
      review: {
        kind: "dapp_tx",
        asset: { assetId: "eip155:97:native", symbol: "tBNB", decimals: 18 },
        amount: { raw: "0", display: "0" },
        recipient: null,
        spender: null,
        decodedCall: null,
        dapp: {
          origin: "https://app.example.org",
          method: "eth_sendTransaction",
          to: {
            address: token,
            isContract: true,
            isVerified: false,
            knownContract: null,
          },
          value: { raw: "0", display: "0" },
          decodedCall: {
            functionName: "approve",
            selector: "0x095ea7b3",
            standard: "erc20",
            args: { spender, amount: maxUint256.toString(10) },
            dataLength: 68,
          },
          counterparty: {
            address: spender,
            role: "spender",
            isContract: false,
            isVerified: false,
          },
          message: null,
          typedData: null,
          // S346 (A5): the spender has no code.
          riskFlags: [
            "UNLIMITED_APPROVAL",
            "EOA_SPENDER",
            "UNVERIFIED_CONTRACT",
          ],
        },
      },
      unsignedTransaction: {
        chainId: 97,
        from: walletAddress,
        to: token,
        data: approveUnlimited,
        value: "0x0",
        nonce: "0x7",
      },
      policy: { exposureBasis: "none", valueUsd: null },
    });
    expect(intent).not.toHaveProperty("signatureRequest");
    expect(intent).not.toHaveProperty("review.nft");
    expect(intent.reviewSha256).toBe(
      digestCanonicalPayload(
        repository.records.get(intent.intentId)?.canonicalPayload,
      ),
    );
    const replay = await dapp.prepareTransaction({
      principal,
      idempotencyKey: key,
      body: txBody(),
      signal,
    });
    expect(replay.created).toBe(false);
    expect(replay.resource.intentId).toBe(intent.intentId);
    expect(
      await codeOf(
        dapp.prepareTransaction({
          principal,
          idempotencyKey: key,
          body: txBody({
            tx: { to: token, data: approveUnlimited, value: "0x1" },
          }),
          signal,
        }),
      ),
    ).toBe("409:IDEMPOTENCY_CONFLICT");
  });

  it("calls a LOOP-known router verified, a native transfer exact, and flags a contract operator", async () => {
    const { dapp } = build({ chain: { erc721: [nft] } });
    const routerCall = await dapp.prepareTransaction({
      principal,
      idempotencyKey: randomUUID(),
      body: txBody({
        tx: {
          to: loopRouter,
          data: encodeFunctionData({
            abi: loopRouterAbi,
            functionName: "swapExactInput",
            args: [
              {
                currency0: token,
                currency1: nft,
                fee: 3000,
                tickSpacing: 60,
                hooks: loopRouter,
              },
              true,
              10n,
              9n,
              0n,
              1_900_000_000n,
            ],
          }),
        },
      }),
      signal,
    });
    expect(routerCall.resource.review.dapp).toMatchObject({
      to: {
        isVerified: true,
        knownContract: { kind: "loopRouter", role: null, label: "LoopRouter" },
      },
      decodedCall: { functionName: "swapExactInput", standard: "loop" },
      riskFlags: [],
    });
    const native = await dapp.prepareTransaction({
      principal,
      idempotencyKey: randomUUID(),
      body: txBody({ tx: { to: eoa, value: "0xDE0B6B3A7640000" } }),
      signal,
    });
    expect(native.resource.review.dapp).toMatchObject({
      to: { address: eoa, isContract: false, isVerified: false },
      value: { raw: "1000000000000000000", display: "1" },
      decodedCall: { functionName: null, selector: null, dataLength: 0 },
      riskFlags: [],
    });
    expect(native.resource.unsignedTransaction).toMatchObject({
      gas: "0xcb20",
      value: "0xde0b6b3a7640000",
      data: "0x",
    });
    const all = await dapp.prepareTransaction({
      principal,
      idempotencyKey: randomUUID(),
      body: txBody({
        tx: {
          to: nft,
          data: encodeFunctionData({
            abi: erc721,
            functionName: "setApprovalForAll",
            args: [contractSpender, true],
          }),
        },
      }),
      signal,
    });
    expect(all.resource.review.dapp?.riskFlags).toEqual([
      "APPROVAL_FOR_ALL",
      "UNVERIFIED_CONTRACT",
    ]);
    expect(all.resource.review.dapp?.counterparty).toMatchObject({
      address: contractSpender,
      role: "operator",
      isContract: true,
      isVerified: false,
    });
    const erc721Approve = await dapp.prepareTransaction({
      principal,
      idempotencyKey: randomUUID(),
      body: txBody({
        tx: {
          to: nft,
          data: encodeFunctionData({
            abi: erc721,
            functionName: "approve",
            args: [spender, 7n],
          }),
        },
      }),
      signal,
    });
    expect(erc721Approve.resource.review.dapp?.decodedCall).toMatchObject({
      standard: "erc721",
      args: { to: spender, tokenId: "7" },
    });
    expect(erc721Approve.resource.review.dapp?.riskFlags).toContain(
      "EOA_SPENDER",
    );
  });

  it("creates a reverting call as prepared, not signable, with SIMULATION_FAILED", async () => {
    const { dapp } = build({
      chain: { call: { status: "reverted", reasonCode: "BSC_CALL_REVERTED" } },
    });
    const created = await dapp.prepareTransaction({
      principal,
      idempotencyKey: randomUUID(),
      body: txBody(),
      signal,
    });
    expect(created.resource).toMatchObject({
      state: "prepared",
      simulation: { status: "reverted", reasonCode: "BSC_CALL_REVERTED" },
      signing: { allowed: false, reasonCode: "BSC_CALL_REVERTED" },
    });
    expect(created.resource.review.dapp?.riskFlags).toEqual([
      "UNLIMITED_APPROVAL",
      "EOA_SPENDER",
      "UNVERIFIED_CONTRACT",
      "SIMULATION_FAILED",
    ]);
    const { dapp: noGas } = build({ chain: { gasEstimate: null } });
    const unavailable = await noGas.prepareTransaction({
      principal,
      idempotencyKey: randomUUID(),
      body: txBody(),
      signal,
    });
    expect(unavailable.resource).toMatchObject({
      state: "prepared",
      signing: { allowed: false, reasonCode: "GAS_ESTIMATE_UNAVAILABLE" },
    });
    expect(unavailable.resource.review.dapp?.riskFlags).toContain(
      "SIMULATION_FAILED",
    );
  });

  it("refuses an empty wallet with INSUFFICIENT_BALANCE and a counterparty outside the canary allowlist", async () => {
    expect(
      await codeOf(
        build({ chain: { nativeBalance: 1n } }).dapp.prepareTransaction({
          principal,
          idempotencyKey: randomUUID(),
          body: txBody(),
          signal,
        }),
      ),
    ).toBe("409:INSUFFICIENT_BALANCE");
    expect(
      await codeOf(
        build({ counterparties: [token] }).dapp.prepareTransaction({
          principal,
          idempotencyKey: randomUUID(),
          body: txBody(),
          signal,
        }),
      ),
    ).toBe("403:POLICY_BLOCKED:COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST");
    expect(
      await codeOf(
        build({ counterparties: [token, spender] }).dapp.prepareTransaction({
          principal,
          idempotencyKey: randomUUID(),
          body: txBody(),
          signal,
        }),
      ),
    ).toBe("OK");
  });

  it("hides DApp kinds from the list unless named, then walks broadcast-report and reconciliation", async () => {
    const receipts = new Map<string, BscTransactionReceiptObservation | null>();
    const transactions = new Map<string, BscTransactionObservation | null>();
    const { dapp, intents, runtime, repository, chain } = build({
      chain: { transactions, receipts },
    });
    const created = await dapp.prepareTransaction({
      principal,
      idempotencyKey: randomUUID(),
      body: txBody(),
      signal,
    });
    const intent = created.resource;
    expect((await intents.list({ principal })).items).toHaveLength(0);
    expect(
      (await intents.list({ principal, includeKinds: "dapp_tx" })).items.map(
        (item) => item.intentId,
      ),
    ).toEqual([intent.intentId]);
    expect(
      (await intents.list({ principal, includeKinds: "send_nft,dapp_sign" }))
        .items,
    ).toHaveLength(0);
    expect(
      await codeOf(
        intents.list({ principal, includeKinds: "dapp_tx,dapp_tx" }),
      ),
    ).toBe("400:INVALID_REQUEST");
    const tx = intent.unsignedTransaction;
    if (tx === null) throw new Error("no transaction");
    transactions.set(txHash, {
      hash: txHash,
      from: tx.from,
      to: tx.to,
      input: tx.data,
      value: fromHexQuantity(tx.value),
      nonce: Number(fromHexQuantity(tx.nonce)),
      chainId: 97,
      blockNumber: null,
    });
    const reported = await intents.reportBroadcast({
      principal,
      intentId: intent.intentId,
      body: { txHash },
    });
    expect(reported).toMatchObject({ state: "submitted", kind: "dapp_tx" });
    receipts.set(txHash, {
      hash: txHash,
      status: "success",
      blockNumber: 43_999_000n,
      blockHash: `0x${"2".repeat(64)}`,
      gasUsed: 46_000n,
      effectiveGasPrice: 1_000_000_000n,
    });
    for (const record of repository.records.values()) {
      repository.records.set(record.intentId, {
        ...record,
        reconcileAfter: null,
      });
    }
    // The primary client would not know the hash: only the slot's does.
    const reconciler = createWalletIntentReconciler({
      repository,
      wallets: runtime.wallets,
      readClient: readClientFake().client,
      launchReadClient: chain.client,
      swapAdapter: runtime.swapAdapter,
      createUuid: randomUUID,
    });
    const result = await reconciler.reconcileOnce();
    expect(result.transitions).toEqual([
      { intentId: intent.intentId, toState: "confirmed", reasonCode: null },
    ]);
    expect(
      (await intents.get({ principal, intentId: intent.intentId })).state,
    ).toBe("confirmed");
  });
});

describe("dapp_sign intents (Decision 0197)", () => {
  const account = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  const signer = account.address.toLowerCase();

  function signBody(overrides: Record<string, unknown> = {}) {
    return {
      walletId,
      chainId: "eip155:97",
      origin: "https://app.example.org",
      method: "personal_sign",
      payload: "Sign in to example.org",
      ...overrides,
    };
  }

  it("gates the switch, mainnet, typed-data chain and validity", async () => {
    expect(
      await codeOf(
        build({ enabled: false }).dapp.prepareSignature({
          principal,
          idempotencyKey: randomUUID(),
          body: signBody(),
          signal,
        }),
      ),
    ).toBe("503:CAPABILITY_UNAVAILABLE:DAPP_BROWSER_DISABLED");
    const { dapp } = build();
    const prepare = (body: unknown) =>
      codeOf(
        dapp.prepareSignature({
          principal,
          idempotencyKey: randomUUID(),
          body,
          signal,
        }),
      );
    expect(await prepare(signBody({ chainId: "eip155:56" }))).toBe(
      "422:VALIDATION_FAILED:CHAIN_SIGNING_DISABLED",
    );
    expect(
      await prepare(
        signBody({
          method: "eth_signTypedData_v4",
          payload: JSON.stringify(permitTypedData("1", 56)),
        }),
      ),
    ).toBe("422:VALIDATION_FAILED:TYPED_DATA_CHAIN_MISMATCH");
    expect(
      await prepare(
        signBody({ method: "eth_signTypedData_v4", payload: "{not json" }),
      ),
    ).toBe("422:VALIDATION_FAILED:TYPED_DATA_INVALID");
    expect(await prepare(signBody({ method: "eth_sign" }))).toBe(
      "400:INVALID_REQUEST",
    );
    expect(await prepare(signBody({ payload: "0x" }))).toBe(
      "400:INVALID_REQUEST",
    );
  });

  it("prepares a Permit signature with the signature request, then verifies the reported signature", async () => {
    const { dapp, intents, repository } = build({
      walletAddressOverride: signer,
    });
    const payload = JSON.stringify({
      ...permitTypedData(maxUint256.toString(10)),
      message: {
        ...permitTypedData(maxUint256.toString(10)).message,
        owner: signer,
      },
    });
    const created = await dapp.prepareSignature({
      principal,
      idempotencyKey: randomUUID(),
      body: signBody({ method: "eth_signTypedData_v4", payload }),
      signal,
    });
    const intent = created.resource;
    expect(intent).toMatchObject({
      kind: "dapp_sign",
      state: "awaiting_signature",
      simulation: {
        status: "unavailable",
        source: "not_applicable",
        reasonCode: "SIGNATURE_NOT_SIMULATED",
      },
      signing: {
        mode: "device_sign_typed_data_v4",
        allowed: true,
        reasonCode: null,
      },
      unsignedTransaction: null,
      signatureRequest: {
        method: "eth_signTypedData_v4",
        params: [signer, payload],
      },
      review: {
        kind: "dapp_sign",
        amount: { raw: "0", display: "0" },
        fee: null,
        dapp: {
          method: "eth_signTypedData_v4",
          to: null,
          value: null,
          decodedCall: null,
          message: null,
          typedData: {
            primaryType: "Permit",
            domain: { name: "USD1", chainId: "97", verifyingContract: token },
            fieldsTruncated: false,
          },
          // S346 (A2): the verifying contract (token) is not LOOP-known.
          riskFlags: [
            "UNLIMITED_APPROVAL",
            "PERMIT_SIGNATURE",
            "UNVERIFIED_CONTRACT",
          ],
        },
      },
    });
    // broadcast-report does not apply to a signature.
    expect(
      await codeOf(
        intents.reportBroadcast({
          principal,
          intentId: intent.intentId,
          body: { txHash },
        }),
      ),
    ).toBe("422:VALIDATION_FAILED");
    const parsed = JSON.parse(payload) as {
      domain: Record<string, unknown>;
      types: Record<string, { name: string; type: string }[]>;
      message: Record<string, unknown>;
    };
    const types = Object.fromEntries(
      Object.entries(parsed.types).filter(([name]) => name !== "EIP712Domain"),
    );
    const signature = await account.signTypedData({
      domain: {
        name: "USD1",
        version: "1",
        chainId: 97,
        verifyingContract: token,
      },
      types,
      primaryType: "Permit",
      message: {
        owner: signer,
        spender,
        value: maxUint256,
        nonce: 0n,
        deadline: 1_900_000_000n,
      },
    });
    const wrong = await account.signMessage({ message: "something else" });
    expect(
      await codeOf(
        dapp.reportSignature({
          principal,
          intentId: intent.intentId,
          body: { signature: wrong },
        }),
      ),
    ).toBe("422:VALIDATION_FAILED:SIGNATURE_MISMATCH");
    const confirmed = await dapp.reportSignature({
      principal,
      intentId: intent.intentId,
      body: { signature },
    });
    expect(confirmed).toMatchObject({
      state: "confirmed",
      signing: { allowed: false },
      result: { transactionHash: null },
    });
    const again = await dapp.reportSignature({
      principal,
      intentId: intent.intentId,
      body: { signature: signature.toUpperCase().replace("0X", "0x") },
    });
    expect(again.state).toBe("confirmed");
    const events = repository.events.filter(
      (event) => event.intentId === intent.intentId,
    );
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "signature_report_rejected",
        "signature_reported",
      ]),
    );
    const reported = events.find(
      (event) => event.eventType === "signature_reported",
    );
    expect(JSON.stringify(reported)).not.toContain(signature.slice(2, 40));
    expect(reported?.details?.["signatureSha256"]).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("verifies a personal_sign over hex bytes and refuses a report on another kind", async () => {
    const { dapp } = build({ walletAddressOverride: signer });
    const message = `0x${Buffer.from("example.org wants you to sign in").toString("hex")}`;
    const created = await dapp.prepareSignature({
      principal,
      idempotencyKey: randomUUID(),
      body: signBody({ payload: message }),
      signal,
    });
    expect(created.resource).toMatchObject({
      signing: { mode: "device_personal_sign", allowed: true },
      signatureRequest: { method: "personal_sign", params: [message, signer] },
      review: {
        dapp: {
          message: {
            encoding: "utf8",
            text: "example.org wants you to sign in",
            byteLength: 32,
          },
          typedData: null,
          riskFlags: [],
        },
      },
    });
    const signature = await account.signMessage({
      message: { raw: message as Hex },
    });
    expect(
      (
        await dapp.reportSignature({
          principal,
          intentId: created.resource.intentId,
          body: { signature },
        })
      ).state,
    ).toBe("confirmed");
    const tx = await dapp.prepareTransaction({
      principal,
      idempotencyKey: randomUUID(),
      body: txBody(),
      signal,
    });
    expect(
      await codeOf(
        dapp.reportSignature({
          principal,
          intentId: tx.resource.intentId,
          body: { signature },
        }),
      ),
    ).toBe("422:VALIDATION_FAILED");
    expect(
      await codeOf(
        dapp.reportSignature({
          principal,
          intentId: tx.resource.intentId,
          body: { signature: "0x12" },
        }),
      ),
    ).toBe("400:INVALID_REQUEST");
  });

  it("records a late signature on a superseded intent", async () => {
    const { dapp } = build({ walletAddressOverride: signer });
    const first = await dapp.prepareSignature({
      principal,
      idempotencyKey: randomUUID(),
      body: signBody(),
      signal,
    });
    // A newer prepare supersedes the open one (one open intent per wallet).
    await dapp.prepareSignature({
      principal,
      idempotencyKey: randomUUID(),
      body: signBody({ payload: "second" }),
      signal,
    });
    const signature = await account.signMessage({
      message: "Sign in to example.org",
    });
    const late = await dapp.reportSignature({
      principal,
      intentId: first.resource.intentId,
      body: { signature },
    });
    expect(late.state).toBe("confirmed");
  });
});

/**
 * S346 (Decision 0197 amendment): the review findings A1 (typed-data chain
 * binding), A2 (unrecognised typed data, verifying contract, raw hash),
 * A4 (a DApp prepare never supersedes a send) and A5 (EOA spender).
 */
function withoutKey<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

describe("S346 review fixes (Decision 0197 amendment)", () => {
  function signBody(overrides: Record<string, unknown> = {}) {
    return {
      walletId,
      chainId: "eip155:97",
      origin: "https://app.example.org",
      method: "eth_signTypedData_v4",
      payload: JSON.stringify(mailTypedData),
      ...overrides,
    };
  }

  const mailWithout = (
    domain: Record<string, unknown>,
    eip712Domain?: readonly { name: string; type: string }[],
  ) =>
    JSON.stringify({
      ...mailTypedData,
      types: {
        ...mailTypedData.types,
        ...(eip712Domain === undefined ? {} : { EIP712Domain: eip712Domain }),
      },
      domain,
    });

  it("A1: refuses typed data whose hash would not bind the request chain", async () => {
    const { dapp } = build();
    const prepare = (payload: string) =>
      codeOf(
        dapp.prepareSignature({
          principal,
          idempotencyKey: randomUUID(),
          body: signBody({ payload }),
          signal,
        }),
      );
    const domainWithoutChain = withoutKey(mailTypedData.domain, "chainId");
    // domain without chainId (with and without a page EIP712Domain).
    const withoutChainTypes = mailTypedData.types.EIP712Domain.filter(
      (field) => field.name !== "chainId",
    );
    expect(
      await prepare(mailWithout(domainWithoutChain, withoutChainTypes)),
    ).toBe("422:VALIDATION_FAILED:TYPED_DATA_INVALID");
    const structTypes = withoutKey(mailTypedData.types, "EIP712Domain");
    expect(
      await prepare(
        JSON.stringify({
          ...mailTypedData,
          types: structTypes,
          domain: domainWithoutChain,
        }),
      ),
    ).toBe("422:VALIDATION_FAILED:TYPED_DATA_INVALID");
    // chainId not the request chain.
    expect(
      await prepare(mailWithout({ ...mailTypedData.domain, chainId: 56 })),
    ).toBe("422:VALIDATION_FAILED:TYPED_DATA_CHAIN_MISMATCH");
    expect(
      await prepare(mailWithout({ ...mailTypedData.domain, chainId: "0x38" })),
    ).toBe("422:VALIDATION_FAILED:TYPED_DATA_CHAIN_MISMATCH");
    // The reproduced bypass: domain.chainId 97 but a page EIP712Domain that
    // leaves chainId out of the hash.
    expect(
      await prepare(mailWithout(mailTypedData.domain, withoutChainTypes)),
    ).toBe("422:VALIDATION_FAILED:TYPED_DATA_INVALID");
    // EIP712Domain naming a key the domain does not have.
    expect(
      await prepare(
        mailWithout(domainWithoutChain, [
          ...withoutChainTypes,
          { name: "chainId", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ]),
      ),
    ).toBe("422:VALIDATION_FAILED:TYPED_DATA_INVALID");
    // A wrong EIP-712 type for a domain field, and a duplicate.
    expect(
      await prepare(
        mailWithout(mailTypedData.domain, [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint64" },
          { name: "verifyingContract", type: "address" },
        ]),
      ),
    ).toBe("422:VALIDATION_FAILED:TYPED_DATA_INVALID");
    expect(
      await prepare(
        mailWithout(mailTypedData.domain, [
          ...mailTypedData.types.EIP712Domain,
          { name: "name", type: "string" },
        ]),
      ),
    ).toBe("422:VALIDATION_FAILED:TYPED_DATA_INVALID");
  });

  it("A1: an accepted payload's digest includes the chainId", async () => {
    const parsed = parseTypedData(JSON.stringify(mailTypedData));
    expect(typedDataBinding(parsed, 97n)).toBe("bound");
    expect(typedDataBinding(parsed, 56n)).toBe("chainMismatch");
    const digest = typedDataDigest(parsed);
    const domainWithoutChain = withoutKey(mailTypedData.domain, "chainId");
    const structTypes = withoutKey(mailTypedData.types, "EIP712Domain");
    const verifyingContract = mailTypedData.domain
      .verifyingContract as `0x${string}`;
    const withChain = hashTypedData({
      domain: { ...mailTypedData.domain, verifyingContract },
      types: structTypes,
      primaryType: "Mail",
      message: mailTypedData.message,
    });
    const withoutChain = hashTypedData({
      domain: { ...domainWithoutChain, verifyingContract },
      types: structTypes,
      primaryType: "Mail",
      message: mailTypedData.message,
    });
    expect(digest).toBe(withChain);
    expect(digest).not.toBe(withoutChain);
    // The page-declared order is honoured, and still covers chainId.
    const reordered = parseTypedData(
      mailWithout(mailTypedData.domain, [
        { name: "chainId", type: "uint256" },
        { name: "name", type: "string" },
        { name: "verifyingContract", type: "address" },
        { name: "version", type: "string" },
      ]),
    );
    expect(typedDataBinding(reordered, 97n)).toBe("bound");
    expect(typedDataDigest(reordered)).not.toBe(withoutChain);

    const { dapp } = build();
    const created = await dapp.prepareSignature({
      principal,
      idempotencyKey: randomUUID(),
      body: signBody(),
      signal,
    });
    expect(created.resource.review.dapp?.typedData?.domain.chainId).toBe("97");
  });

  it("A2: flags unrecognised typed data, an unknown verifying contract and a raw hash", async () => {
    const seaport = {
      types: {
        OrderComponents: [
          { name: "offerer", type: "address" },
          { name: "counter", type: "uint256" },
        ],
      },
      primaryType: "OrderComponents",
      domain: {
        name: "Seaport",
        version: "1.5",
        chainId: 97,
        verifyingContract: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
      },
      message: {
        offerer: "0x1111111111111111111111111111111111111111",
        counter: "0",
      },
    };
    const parsed = parseTypedData(JSON.stringify(seaport));
    expect(typedDataRiskFlags(parsed, reviewTypedData(parsed))).toEqual([
      "UNRECOGNIZED_TYPED_DATA",
    ]);
    const { dapp } = build();
    const order = await dapp.prepareSignature({
      principal,
      idempotencyKey: randomUUID(),
      body: signBody({ payload: JSON.stringify(seaport) }),
      signal,
    });
    expect(order.resource.review.dapp?.riskFlags).toEqual([
      "UNRECOGNIZED_TYPED_DATA",
      "UNVERIFIED_CONTRACT",
    ]);
    for (const primaryType of [
      "ForwardRequest",
      "MetaTransaction",
      "Delegation",
    ]) {
      const other = parseTypedData(
        JSON.stringify({
          types: { [primaryType]: [{ name: "from", type: "address" }] },
          primaryType,
          domain: { name: "X", chainId: 97 },
          message: { from: walletAddress },
        }),
      );
      expect(typedDataRiskFlags(other, reviewTypedData(other))).toEqual([
        "UNRECOGNIZED_TYPED_DATA",
      ]);
    }
    // A LOOP-known verifying contract is not UNVERIFIED_CONTRACT.
    const known = await dapp.prepareSignature({
      principal,
      idempotencyKey: randomUUID(),
      body: signBody({
        payload: mailWithout({
          ...mailTypedData.domain,
          verifyingContract: loopRouter,
        }),
      }),
      signal,
    });
    expect(known.resource.review.dapp?.riskFlags).toEqual([
      "UNRECOGNIZED_TYPED_DATA",
    ]);
    // 32 bytes of hex that are not text: RAW_HASH_SIGNATURE.
    const hash = `0x${"ab".repeat(32)}`;
    expect(
      personalSignRiskFlags(hash, reviewPersonalSignMessage(hash)),
    ).toEqual(["RAW_HASH_SIGNATURE"]);
    const raw = await dapp.prepareSignature({
      principal,
      idempotencyKey: randomUUID(),
      body: signBody({ method: "personal_sign", payload: hash }),
      signal,
    });
    expect(raw.resource.review.dapp).toMatchObject({
      message: { encoding: "hex", byteLength: 32 },
      riskFlags: ["RAW_HASH_SIGNATURE"],
    });
    // 31 / 33 bytes, or 32 printable bytes, are not a hash.
    for (const payload of [
      `0x${"ab".repeat(31)}`,
      `0x${"ab".repeat(33)}`,
      `0x${Buffer.from("example.org wants you to sign in").toString("hex")}`,
      "ab".repeat(16),
    ]) {
      expect(
        personalSignRiskFlags(payload, reviewPersonalSignMessage(payload)),
      ).toEqual([]);
    }
  });

  it("A4: a DApp prepare supersedes only DApp intents and is refused by an open send", async () => {
    const { dapp, repository } = build();
    const first = await dapp.prepareTransaction({
      principal,
      idempotencyKey: randomUUID(),
      body: txBody(),
      signal,
    });
    // A dapp_sign supersedes the open dapp_tx.
    const sign = await dapp.prepareSignature({
      principal,
      idempotencyKey: randomUUID(),
      body: signBody(),
      signal,
    });
    expect(repository.records.get(first.resource.intentId)).toMatchObject({
      state: "expired",
      reasonCode: "INTENT_SUPERSEDED",
    });
    // An open send on the wallet (the user is reviewing it).
    const template = repository.records.get(sign.resource.intentId)!;
    const sendId = randomUUID();
    repository.records.set(sendId, {
      ...template,
      intentId: sendId,
      kind: "send",
      state: "awaiting_signature",
    });
    const busyKey = randomUUID();
    const busy = () =>
      codeOf(
        dapp.prepareTransaction({
          principal,
          idempotencyKey: busyKey,
          body: txBody(),
          signal,
        }),
      );
    expect(await busy()).toBe("409:RESOURCE_CONFLICT:INTENT_BUSY");
    expect(
      await codeOf(
        dapp.prepareSignature({
          principal,
          idempotencyKey: randomUUID(),
          body: signBody(),
          signal,
        }),
      ),
    ).toBe("409:RESOURCE_CONFLICT:INTENT_BUSY");
    expect(repository.records.get(sendId)?.state).toBe("awaiting_signature");
    // The dapp_sign that was open stays open too (nothing was superseded).
    expect(repository.records.get(sign.resource.intentId)?.state).toBe(
      "awaiting_signature",
    );
    // Once the send is past its expiry it no longer blocks; the same key
    // retried now creates the intent.
    repository.records.set(sendId, {
      ...repository.records.get(sendId)!,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(await busy()).toBe("OK");
    expect(repository.records.get(sendId)?.state).toBe("awaiting_signature");
  });

  it("A5: flags EOA_SPENDER for a grant to an address without code", async () => {
    const { dapp } = build();
    const prepare = async (data: Hex) =>
      (
        await dapp.prepareTransaction({
          principal,
          idempotencyKey: randomUUID(),
          body: txBody({ tx: { to: token, data } }),
          signal,
        })
      ).resource.review.dapp?.riskFlags;
    // A large but finite increaseAllowance to an EOA: no UNLIMITED flag, but
    // EOA_SPENDER.
    expect(
      await prepare(
        encodeFunctionData({
          abi: erc20,
          functionName: "increaseAllowance",
          args: [spender, 10n ** 30n],
        }),
      ),
    ).toEqual(["EOA_SPENDER", "UNVERIFIED_CONTRACT"]);
    // A contract spender, or a revoke (amount 0), is not EOA_SPENDER.
    expect(
      await prepare(
        encodeFunctionData({
          abi: erc20,
          functionName: "approve",
          args: [contractSpender, 10n ** 30n],
        }),
      ),
    ).toEqual(["UNVERIFIED_CONTRACT"]);
    expect(
      await prepare(
        encodeFunctionData({
          abi: erc20,
          functionName: "approve",
          args: [spender, 0n],
        }),
      ),
    ).toEqual(["UNVERIFIED_CONTRACT"]);
    // A transfer to an EOA grants nothing.
    expect(
      await prepare(
        encodeFunctionData({
          abi: erc20,
          functionName: "transfer",
          args: [spender, 1n],
        }),
      ),
    ).toEqual(["UNVERIFIED_CONTRACT"]);
    expect(
      decodeDappCall({
        data: encodeFunctionData({
          abi: erc721,
          functionName: "setApprovalForAll",
          args: [spender, false],
        }),
        to: nft,
        targetIsErc721: true,
        targetIsLoop: false,
      }).grantsApproval,
    ).toBe(false);
    expect(
      decodeDappCall({
        data: encodeFunctionData({
          abi: permit2,
          functionName: "approve",
          args: [token, spender, 5n, 1_900_000_000],
        }),
        to: permit2Address,
        targetIsErc721: false,
        targetIsLoop: false,
      }).grantsApproval,
    ).toBe(true);
  });
});
