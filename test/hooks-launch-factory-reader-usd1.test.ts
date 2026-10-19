import { describe, expect, it } from "vitest";
import { custom, encodeAbiParameters, keccak256 } from "viem";

import { createHooksLaunchFactoryReader } from "../src/integrations/launch/hooks-launch-factory-reader.js";

// Decision 0165: the Factory's immutable usd1(), the token the wallet's
// launch-slot USD1 pair reads.
describe("Hooks launch Factory reader usd1()", () => {
  const code = `0x${"60".repeat(64)}` as const;
  const factoryUsd1 = "0x3A12000000000000000000000000000000000195";

  function readerAnswering(answer: string) {
    const counts = { eth_call: 0 };
    const transport = custom({
      request: ({ method }: { method: string }) => {
        if (method === "eth_chainId") return Promise.resolve("0x61");
        if (method === "eth_getCode") return Promise.resolve(code);
        if (method === "eth_call") {
          counts.eth_call += 1;
          return Promise.resolve(
            encodeAbiParameters(
              [{ type: "address" }],
              [answer as `0x${string}`],
            ),
          );
        }
        return Promise.reject(new Error(`unexpected ${method}`));
      },
    });
    const reader = createHooksLaunchFactoryReader({
      factoryAddress: "0x1111111111111111111111111111111111111111",
      expectedRuntimeCodeHash: keccak256(code),
      rpcUrls: [],
      transport,
    });
    return { reader, counts };
  }

  it("answers the lowercase usd1() and reads it once", async () => {
    const { reader, counts } = readerAnswering(factoryUsd1);
    expect(await reader.usd1?.()).toBe(factoryUsd1.toLowerCase());
    expect(await reader.usd1?.()).toBe(factoryUsd1.toLowerCase());
    expect(counts.eth_call).toBe(1);
  });

  it("fails closed on the zero address and keeps asking", async () => {
    const { reader, counts } = readerAnswering(`0x${"0".repeat(40)}`);
    await expect(reader.usd1?.()).rejects.toThrow(/usd1 unavailable/u);
    await expect(reader.usd1?.()).rejects.toThrow(/usd1 unavailable/u);
    expect(counts.eth_call).toBe(2);
  });
});
