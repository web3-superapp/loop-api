import { createPublicClient, http, keccak256 } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Launch2DynamicChain } from "../src/features/launch2/launch2-ports.js";
import { createLaunch2DynamicChain } from "../src/integrations/launch2/launch2-dynamic-chain.js";
import {
  anvilAccount,
  deployLoopDynamicProtocol,
  locateFoundry,
  startAnvil,
  type AnvilChain,
  type DeployedLoopDynamicProtocol,
} from "./helpers/anvil.js";

/**
 * Decision 0153 on a local `anvil --chain-id 97`: two LoopDynamic
 * generations side by side (two `DeployLoopProtocol` runs, each with its own
 * LoopRouter / LoopRouterRegistry / Hook deployment factory, as every
 * testnet redeploy does). The real reader resolves each Factory's routing
 * from its getters, verifies **both** routers by code hash while configured
 * with only the newer one, and answers null for an address that is not a
 * LoopDynamic Factory. No database; skips when anvil/forge/loop-contracts
 * are absent.
 */

const foundry = locateFoundry();
const skipReason = typeof foundry === "string" ? foundry : null;
if (skipReason !== null) {
  process.stderr.write(
    `[skip] LoopDynamic per-Factory routing anvil suite: ${skipReason}\n`,
  );
}

describe.skipIf(skipReason !== null)(
  "LoopDynamic router per Factory on anvil (Decision 0153)",
  () => {
    let chain: AnvilChain;
    let older: DeployedLoopDynamicProtocol;
    let newer: DeployedLoopDynamicProtocol;
    let reader: Launch2DynamicChain;

    beforeAll(async () => {
      if (typeof foundry === "string") return;
      chain = await startAnvil(foundry);
      older = deployLoopDynamicProtocol(foundry, chain.rpcUrl);
      newer = deployLoopDynamicProtocol(foundry, chain.rpcUrl);
      const client = createPublicClient({ transport: http(chain.rpcUrl) });
      const code = await client.getCode({
        address: newer.loopRouter,
      });
      reader = createLaunch2DynamicChain({
        rpcUrls: [chain.rpcUrl],
        router: newer.loopRouter,
        expectedRuntimeCodeHash: keccak256(code ?? "0x"),
      });
    }, 600_000);

    afterAll(async () => {
      if (typeof foundry !== "string") await chain.stop();
    });

    it("reads each Factory's own LoopRouter / registry / Hook deployment factory", async () => {
      expect(older.factory).not.toBe(newer.factory);
      expect(older.loopRouter).not.toBe(newer.loopRouter);
      expect(older.routerRegistry).not.toBe(newer.routerRegistry);
      expect(await reader.readFactoryRouting(older.factory)).toEqual({
        router: older.loopRouter,
        routerRegistry: older.routerRegistry,
        hookDeploymentFactory: older.hookDeploymentFactory,
      });
      expect(await reader.readFactoryRouting(newer.factory)).toEqual({
        router: newer.loopRouter,
        routerRegistry: newer.routerRegistry,
        hookDeploymentFactory: newer.hookDeploymentFactory,
      });
      // Not a LoopDynamic Factory: a token (reverts) and an EOA (no data).
      expect(await reader.readFactoryRouting(newer.usd1)).toBeNull();
      expect(
        await reader.readFactoryRouting(anvilAccount(13).address.toLowerCase()),
      ).toBeNull();
      // No launch yet: the Factory's loopHook(launchId) is not a Hook.
      const hook = await reader.readFactoryHook({
        factory: older.factory,
        launchId: `0x${"11".repeat(32)}`,
      });
      expect(
        hook === null || hook === "0x0000000000000000000000000000000000000000",
      ).toBe(true);
    });

    it("verifies the configured router, an older one only with its hash listed, and refuses other code", async () => {
      expect(reader.router).toBe(newer.loopRouter);
      expect(await reader.verifyRouter()).toEqual({
        status: "ok",
        poolManager: newer.poolManager,
      });
      // LoopRouter's runtime code embeds its PoolManager (immutable): on
      // anvil each run deploys its own PoolManager, so the older router's
      // hash differs and is refused unless listed
      // (LAUNCH2_DYNAMIC_LEGACY_ROUTER_CODE_HASHES). On BSC Testnet every
      // generation shares one PoolManager and the hash is equal.
      expect(await reader.verifyRouter(older.loopRouter)).toEqual({
        status: "unavailable",
        reasonCode: "LAUNCH2_DYNAMIC_ROUTER_CODE_MISMATCH",
      });
      const client = createPublicClient({ transport: http(chain.rpcUrl) });
      const [newerCode, olderCode] = await Promise.all([
        client.getCode({ address: newer.loopRouter }),
        client.getCode({ address: older.loopRouter }),
      ]);
      const listed = createLaunch2DynamicChain({
        rpcUrls: [chain.rpcUrl],
        router: newer.loopRouter,
        expectedRuntimeCodeHash: keccak256(newerCode ?? "0x"),
        legacyRuntimeCodeHashes: [keccak256(olderCode ?? "0x")],
      });
      expect(await listed.verifyRouter(older.loopRouter)).toEqual({
        status: "ok",
        poolManager: older.poolManager,
      });
      expect(await listed.verifyRouter()).toEqual({
        status: "ok",
        poolManager: newer.poolManager,
      });
      expect(await listed.verifyRouter(newer.usd1)).toEqual({
        status: "unavailable",
        reasonCode: "LAUNCH2_DYNAMIC_ROUTER_CODE_MISMATCH",
      });
    });
  },
);
