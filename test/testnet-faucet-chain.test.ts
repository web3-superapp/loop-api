import {
  custom,
  decodeFunctionData,
  keccak256,
  parseTransaction,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  createTestnetFaucetChain,
  mockUsd1MintAbi,
  TestnetFaucetChainRefusedError,
} from "../src/integrations/bsc/testnet-faucet-chain.js";

/**
 * Decision 0128: the operator chain against a scripted JSON-RPC endpoint —
 * the hash is known before the broadcast, a broadcast error is resolved by
 * eth_getTransactionByHash, and a missing receipt is `unconfirmed`.
 */

const key = `0x${"ab".repeat(32)}` as const;
const operator = privateKeyToAccount(key).address.toLowerCase();
const recipient = "0x000000000000000000000000000000000000000a";
const usd1 = "0x00000000000000000000000000000000000005d1";

interface Script {
  broadcast: "ok" | "error";
  knownAfterError: boolean;
  receipt: "success" | "reverted" | "never";
  estimate: "ok" | "revert";
  readonly raw: Hex[];
  readonly methods: string[];
}

function rpc(script: Script) {
  return custom({
    request({ method, params }: { method: string; params?: unknown }) {
      script.methods.push(method);
      const args = (params ?? []) as unknown[];
      switch (method) {
        case "eth_chainId":
          return Promise.resolve("0x61");
        case "eth_blockNumber":
          return Promise.resolve("0x10");
        case "eth_getTransactionCount":
          return Promise.resolve("0x7");
        case "eth_gasPrice":
        case "eth_maxPriorityFeePerGas":
          return Promise.resolve("0x3b9aca00");
        case "eth_getBalance":
          return Promise.resolve("0xde0b6b3a7640000");
        case "eth_getBlockByNumber":
          return Promise.resolve({
            number: "0x10",
            hash: `0x${"11".repeat(32)}`,
            parentHash: `0x${"22".repeat(32)}`,
            timestamp: "0x1",
            baseFeePerGas: "0x0",
            gasLimit: "0x1c9c380",
            gasUsed: "0x0",
            transactions: [],
          });
        case "eth_call":
          return Promise.resolve(
            "0x0000000000000000000000000000000000000000000000000000000000000012",
          );
        case "eth_estimateGas":
          return script.estimate === "ok"
            ? Promise.resolve("0xea60")
            : Promise.reject(
                Object.assign(new Error("execution reverted"), {
                  code: 3,
                  data: "0x",
                }),
              );
        case "eth_sendRawTransaction": {
          const raw = args[0] as Hex;
          script.raw.push(raw);
          return script.broadcast === "ok"
            ? Promise.resolve(keccak256(raw))
            : Promise.reject(new Error("upstream closed"));
        }
        case "eth_getTransactionByHash":
          return Promise.resolve(
            script.knownAfterError
              ? {
                  hash: args[0],
                  from: operator,
                  to: recipient,
                  nonce: "0x7",
                  value: "0x0",
                  gas: "0x5208",
                  gasPrice: "0x3b9aca00",
                  input: "0x",
                  blockHash: null,
                  blockNumber: null,
                  transactionIndex: null,
                  type: "0x0",
                  v: "0x1b",
                  r: "0x1",
                  s: "0x1",
                }
              : null,
          );
        case "eth_getTransactionReceipt":
          return Promise.resolve(
            script.receipt === "never"
              ? null
              : {
                  transactionHash: args[0],
                  blockHash: `0x${"11".repeat(32)}`,
                  blockNumber: "0x10",
                  transactionIndex: "0x0",
                  from: operator,
                  to: recipient,
                  contractAddress: null,
                  cumulativeGasUsed: "0x5208",
                  gasUsed: "0x5208",
                  effectiveGasPrice: "0x3b9aca00",
                  logs: [],
                  logsBloom: `0x${"00".repeat(256)}`,
                  status: script.receipt === "success" ? "0x1" : "0x0",
                  type: "0x0",
                },
          );
        default:
          return Promise.reject(new Error(`unexpected ${method}`));
      }
    },
  });
}

function setup(overrides: Partial<Script> = {}) {
  const script: Script = {
    broadcast: "ok",
    knownAfterError: false,
    receipt: "success",
    estimate: "ok",
    raw: [],
    methods: [],
    ...overrides,
  };
  const chain = createTestnetFaucetChain({
    privateKey: key,
    chainReference: 97,
    rpcUrls: [],
    transport: rpc(script),
    receiptTimeoutMs: 300,
    pollingIntervalMs: 20,
  });
  return { chain, script };
}

describe("testnet faucet operator chain (Decision 0128)", () => {
  it("refuses BSC Mainnet and a missing endpoint", () => {
    expect(() =>
      createTestnetFaucetChain({
        privateKey: key,
        chainReference: 56,
        rpcUrls: ["https://x.test"],
      }),
    ).toThrow(TestnetFaucetChainRefusedError);
    expect(() =>
      createTestnetFaucetChain({
        privateKey: key,
        chainReference: 97,
        rpcUrls: [],
      }),
    ).toThrow(/TESTNET_FAUCET_RPC_NOT_CONFIGURED/);
  });

  it("signs a chain-97 transfer, reports the hash before broadcast, and confirms it", async () => {
    const { chain, script } = setup();
    expect(chain.operatorAddress).toBe(operator);
    const signed: string[] = [];
    const outcome = await chain.sendNative({
      to: recipient,
      valueWei: 20_000_000_000_000_000n,
      onSigned: (hash) => {
        signed.push(hash);
        expect(script.raw).toHaveLength(0);
        return Promise.resolve();
      },
    });
    expect(script.raw).toHaveLength(1);
    const hash = keccak256(script.raw[0] as Hex);
    expect(signed).toEqual([hash]);
    expect(outcome).toEqual({ status: "confirmed", transactionHash: hash });
    const tx = parseTransaction(script.raw[0] as Hex);
    expect(tx.chainId).toBe(97);
    expect(tx.to).toBe(recipient);
    expect(tx.value).toBe(20_000_000_000_000_000n);
    expect(tx.gas).toBe(21_000n);
    expect(tx.nonce).toBe(7);
  });

  it("encodes mint(to, amount) on the USD1 address", async () => {
    const { chain, script } = setup();
    const outcome = await chain.sendMint({
      usd1,
      to: recipient,
      amountRaw: 500n * 10n ** 18n,
      gas: 72_000n,
      onSigned: () => Promise.resolve(),
    });
    expect(outcome.status).toBe("confirmed");
    const tx = parseTransaction(script.raw[0] as Hex);
    expect(tx.to).toBe(usd1);
    expect(tx.value ?? 0n).toBe(0n);
    const decoded = decodeFunctionData({
      abi: mockUsd1MintAbi,
      data: tx.data as Hex,
    });
    expect(decoded.functionName).toBe("mint");
    expect(String(decoded.args[0]).toLowerCase()).toBe(recipient);
    expect(decoded.args[1]).toBe(500n * 10n ** 18n);
  });

  it("maps a reverted receipt, a missing receipt, and broadcast errors", async () => {
    const reverted = setup({ receipt: "reverted" });
    expect(
      (
        await reverted.chain.sendNative({
          to: recipient,
          valueWei: 1n,
          onSigned: () => Promise.resolve(),
        })
      ).status,
    ).toBe("reverted");
    const never = setup({ receipt: "never" });
    expect(
      (
        await never.chain.sendNative({
          to: recipient,
          valueWei: 1n,
          onSigned: () => Promise.resolve(),
        })
      ).status,
    ).toBe("unconfirmed");
    const lost = setup({ broadcast: "error" });
    expect(
      await lost.chain.sendNative({
        to: recipient,
        valueWei: 1n,
        onSigned: () => Promise.resolve(),
      }),
    ).toEqual({ status: "not_sent" });
    const known = setup({ broadcast: "error", knownAfterError: true });
    expect(
      (
        await known.chain.sendNative({
          to: recipient,
          valueWei: 1n,
          onSigned: () => Promise.resolve(),
        })
      ).status,
    ).toBe("confirmed");
  });

  it("does not broadcast when the hash cannot be stored", async () => {
    const { chain, script } = setup();
    await expect(
      chain.sendNative({
        to: recipient,
        valueWei: 1n,
        onSigned: () => Promise.reject(new Error("db down")),
      }),
    ).rejects.toThrow("db down");
    expect(script.raw).toHaveLength(0);
  });

  it("reads decimals, gas price, balance, and classifies a reverting mint estimate", async () => {
    const { chain } = setup();
    expect(await chain.readUsd1Decimals(usd1)).toBe(18);
    expect(await chain.readGasPrice()).toBe(1_000_000_000n);
    expect(await chain.readOperatorBalance()).toBe(10n ** 18n);
    expect(
      await chain.estimateMintGas({ usd1, to: recipient, amountRaw: 1n }),
    ).toEqual({ kind: "ok", gas: 60_000n });
    const reverting = setup({ estimate: "revert" });
    expect(
      await reverting.chain.estimateMintGas({
        usd1,
        to: recipient,
        amountRaw: 1n,
      }),
    ).toEqual({ kind: "reverted" });
  });
});
