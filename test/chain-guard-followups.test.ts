import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  parseAbi,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import { runChainPreflight } from "../scripts/chain-preflight.js";
import {
  ConfigurationError,
  parseChainGuardAlertConfig,
} from "../src/config.js";
import { chainGuardPolicyLimitedReasons } from "../src/features/chain-guard/chain-guard-contract.js";
import { chainGuardLogFindings } from "../src/features/chain-guard/chain-guard-evaluate.js";
import {
  createChainGuardLane,
  type ChainGuardIncidentEvent,
} from "../src/features/chain-guard/chain-guard-lane.js";
import { launch2PoolKey } from "../src/features/launch2/launch2-pool.js";
import {
  chainGuardAlertText,
  createChainGuardAlertNotifier,
  type ChainGuardAlertFetch,
} from "../src/integrations/chain-guard/chain-guard-alerts.js";
import {
  chainGuardEventsAbi,
  createChainGuardChain,
} from "../src/integrations/chain-guard/chain-guard-chain.js";
import { createLaunch2Chain } from "../src/integrations/launch2/launch2-chain.js";
import { snapshotRegistryAbi } from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
import {
  controller,
  createFakeChainGuardChain,
  createInMemoryChainGuardRepository,
  factory,
  guardAddress,
  guardHook,
  guardMeme,
  instanceRecord,
  poolManager,
  usd1,
  usd1Log,
} from "./helpers/chain-guard-fakes.js";

/**
 * Decision 0135 (S176): PoolManager fee logs, the fee-controller policy
 * warning, the alert outlets, and the launch2 foreign-log split.
 */

const chainId = "eip155:97";
const zero = "0x0000000000000000000000000000000000000000";

function lane(
  options: {
    readonly chain?: Parameters<typeof createFakeChainGuardChain>[0];
    readonly expectedController?: string | null;
  } = {},
) {
  const instance = instanceRecord(1);
  const repository = createInMemoryChainGuardRepository([instance]);
  const chain = createFakeChainGuardChain(options.chain);
  const events: ChainGuardIncidentEvent[] = [];
  const notices: { reasonCode: string; detail: string | null }[] = [];
  let clock = new Date("2026-10-14T00:00:00.000Z");
  const guard = createChainGuardLane({
    repository,
    chain,
    targets: {
      chainId,
      chainReference: 97,
      usd1Address: usd1,
      factories: [factory],
      poolManagerAddress: null,
      poolRouterAddress: null,
      watch: [],
      balanceAccounts: [],
    },
    policy: {
      expectedImplementation: guardAddress(0x1111),
      expectedProtocolFeeController: options.expectedController ?? null,
      protocolFeeAlertPips: 500,
      minBnbWei: 5n * 10n ** 16n,
    },
    confirmations: 5,
    intervalSeconds: 60,
    now: () => clock,
    onIncident: (event) => events.push(event),
    onNotice: (event) => notices.push(event),
  });
  return {
    guard,
    repository,
    chain,
    events,
    notices,
    instance,
    advance(seconds: number) {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
    open: () =>
      repository.rows
        .filter((row) => row.resolvedAt === null)
        .map((row) => row.kind),
  };
}

/** `ProtocolFeeUpdated(id, fee)` as the reader decodes it. */
function feeLog(
  poolId: string,
  packed: number,
  block: bigint,
  from = poolManager,
) {
  return {
    ...usd1Log("ProtocolFeeUpdated", block, {
      id: poolId,
      protocolFee: String(packed),
    }),
    address: from,
  };
}

describe("PoolManager fee logs (Decision 0135 A)", () => {
  it("asks the PoolManager's logs alongside USD1 and ProxyAdmin", async () => {
    const h = lane();
    await h.guard.runOnce();
    expect(h.chain.state.logPoolManagers[0]).toEqual([poolManager]);
  });

  it("opens the fee incidents from a ProtocolFeeUpdated of our pool at once, with the log's facts", async () => {
    const h = lane();
    const poolId = h.instance.poolId as string;
    // 600 pips zeroForOne; slot0 says the same.
    h.chain.state.logs.push(feeLog(poolId, 600, 9_990n));
    h.chain.state.protocolFee.set(poolId, 600);
    await h.guard.runOnce();
    expect(h.open()).toEqual([
      "pool_protocol_fee_nonzero",
      "pool_protocol_fee_high",
    ]);
    const row = h.repository.rows[0];
    expect(row?.details).toMatchObject({
      source: "event",
      blockNumber: "9990",
      zeroForOnePips: 600,
      instanceId: h.instance.instanceId,
    });
    expect(row?.details["transactionHash"]).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(h.events.filter((event) => event.change === "opened")).toHaveLength(
      2,
    );
  });

  it("keeps a fee switched on and off inside one window as open-then-resolved", async () => {
    const h = lane();
    h.chain.state.logs.push(feeLog(h.instance.poolId as string, 25, 9_990n));
    await h.guard.runOnce();
    expect(h.repository.rows.map((row) => [row.kind, row.resolution])).toEqual([
      ["pool_protocol_fee_nonzero", "auto"],
    ]);
    expect(h.events.map((event) => event.change)).toEqual([
      "opened",
      "resolved",
    ]);
  });

  it("ignores a fee log of a pool that is not ours or from another address", () => {
    const watched = new Set<string>();
    const graduatedPools = new Map([[`0x${"ab".repeat(32)}`, "i-1"]]);
    const result = chainGuardLogFindings({
      logs: [
        feeLog(`0x${"cd".repeat(32)}`, 900, 1n),
        feeLog(`0x${"ab".repeat(32)}`, 900, 2n, guardAddress(0xbad)),
        feeLog(`0x${"ab".repeat(32)}`, 0, 3n),
      ],
      usd1,
      proxyAdmin: null,
      watched,
      poolManagers: new Set([poolManager]),
      graduatedPools,
      policy: {
        protocolFeeAlertPips: 500,
        expectedProtocolFeeController: null,
      },
    });
    expect(result.state).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("evaluates ProtocolFeeControllerUpdated only against a configured controller", async () => {
    const changed = guardAddress(0xc1c1);
    const log = {
      ...usd1Log("ProtocolFeeControllerUpdated", 9_990n, {
        protocolFeeController: changed,
      }),
      address: poolManager,
    };
    const unconfigured = chainGuardLogFindings({
      logs: [log],
      usd1,
      proxyAdmin: null,
      watched: new Set(),
      poolManagers: new Set([poolManager]),
      policy: {
        protocolFeeAlertPips: 500,
        expectedProtocolFeeController: null,
      },
    });
    expect(unconfigured.state).toEqual([]);

    const h = lane({ expectedController: controller });
    h.chain.state.logs.push(log);
    await h.guard.runOnce();
    // The state read still says the expected controller: open, then resolved.
    expect(h.repository.rows.map((row) => [row.kind, row.subject])).toEqual([
      ["protocol_fee_controller_changed", poolManager],
    ]);
    expect(h.repository.rows[0]?.details).toMatchObject({
      source: "event",
      expected: controller,
      observed: changed,
    });
    expect(h.repository.rows[0]?.resolvedAt).not.toBeNull();
  });
});

describe("fee policy ahead of slot0 (Decision 0135 B)", () => {
  it("asks protocolFeeForPool with the launch2 PoolKey", async () => {
    const h = lane();
    await h.guard.runOnce();
    expect(h.chain.state.policyQueries).toEqual([h.instance.poolId]);
  });

  it("warns nonzero / high while slot0 lags, and resolves when the policy drops", async () => {
    const h = lane();
    const poolId = h.instance.poolId as string;
    h.chain.state.policy.set(poolId, 700 | (100 << 12));
    const first = await h.guard.runOnce();
    expect(h.open()).toEqual([
      "pool_protocol_fee_policy_nonzero",
      "pool_protocol_fee_policy_high",
    ]);
    expect(first).toMatchObject({ policyLimited: [] });
    expect(h.repository.rows[0]?.details).toMatchObject({
      policyZeroForOnePips: 700,
      policyOneForZeroPips: 100,
      zeroForOnePips: 0,
    });

    // slot0 catches up below the threshold: nonzero policy is no longer
    // ahead, high still is; the slot0 kind takes over for "nonzero".
    h.chain.state.protocolFee.set(poolId, 100);
    await h.guard.runOnce();
    expect(h.open().sort()).toEqual([
      "pool_protocol_fee_nonzero",
      "pool_protocol_fee_policy_high",
    ]);

    h.chain.state.policy.set(poolId, 0);
    h.chain.state.protocolFee.set(poolId, 0);
    await h.guard.runOnce();
    expect(h.open()).toEqual([]);
  });

  it("is limited (logged once, nothing opened or resolved) when the policy cannot be read", async () => {
    const h = lane();
    const poolId = h.instance.poolId as string;
    h.chain.state.policy.set(poolId, 50);
    await h.guard.runOnce();
    expect(h.open()).toEqual(["pool_protocol_fee_policy_nonzero"]);

    h.chain.state.policySupported = false;
    const limited = await h.guard.runOnce();
    await h.guard.runOnce();
    expect(limited).toMatchObject({
      kind: "checked",
      policyLimited: [chainGuardPolicyLimitedReasons.unsupported],
    });
    // The open warning is kept, not resolved by a missing read.
    expect(h.open()).toEqual(["pool_protocol_fee_policy_nonzero"]);
    expect(
      h.notices.filter(
        (notice) => notice.reasonCode === "CHAIN_GUARD_POLICY_LIMITED",
      ),
    ).toEqual([
      {
        reasonCode: "CHAIN_GUARD_POLICY_LIMITED",
        detail: chainGuardPolicyLimitedReasons.unsupported,
      },
    ]);
  });

  it("does not read a zero-address controller and opens nothing", async () => {
    const h = lane({ chain: { controller: zero } });
    const result = await h.guard.runOnce();
    expect(h.chain.state.policyQueries).toEqual([]);
    expect(result).toMatchObject({
      policyLimited: [chainGuardPolicyLimitedReasons.controllerUnset],
    });
    expect(h.open()).toEqual([]);
  });

  it("is limited when the instance's MEME / hook do not rebuild its pool id", async () => {
    const h = lane();
    h.repository.instances[0] = {
      ...h.instance,
      poolHook: guardHook(99),
    };
    const result = await h.guard.runOnce();
    expect(result).toMatchObject({
      policyLimited: [chainGuardPolicyLimitedReasons.poolKeyUnknown],
    });
    expect(h.chain.state.policyQueries).toEqual([]);
  });

  it("prints a policy row in the preflight", async () => {
    const stdout: string[] = [];
    const chain = createFakeChainGuardChain();
    const instance = instanceRecord(1);
    chain.state.policy.set(instance.poolId as string, 300);
    const code = await runChainPreflight({
      argv: ["node", "chain-preflight.ts", "--dry"],
      environment: {
        LAUNCH_CHAIN_ID: "97",
        LAUNCH_BSC_RPC_URLS: "https://bsc-testnet.example.invalid",
        HOOKS_LAUNCH_FACTORY_ADDRESS: factory,
        CHAIN_GUARD_USD1_IMPLEMENTATION: guardAddress(0x1111),
      },
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: () => true },
      createChain: () => chain,
      listInstances: () => Promise.resolve([instance]),
    });
    expect(code).toBe(0);
    const text = stdout.join("");
    expect(text).toMatch(/WARN {2}pool\.protocolFeePolicy/u);
    expect(text).toContain("300/0 pips (slot0 0/0, alert ≥ 500)");
  });
});

describe("manual resolve and the next tick (Decision 0135 C)", () => {
  it("re-opens a condition that still holds; an event kind stays closed", async () => {
    const h = lane({ chain: { paused: true } });
    h.chain.state.logs.push(
      usd1Log("Upgraded", 9_990n, { implementation: guardAddress(0x3333) }),
    );
    await h.guard.runOnce();
    expect(h.open()).toEqual(["usd1_upgraded", "usd1_paused"]);
    for (const row of [...h.repository.rows]) {
      const result = await h.repository.resolveManually({
        chainId,
        incidentId: row.incidentId,
        note: "acknowledged",
        now: new Date("2026-10-14T00:00:30.000Z"),
        audit: { actor: "operator", actorAccountId: null, requestId: "r" },
      });
      expect(result.status).toBe("resolved");
    }
    expect(h.open()).toEqual([]);
    h.advance(60);
    await h.guard.runOnce();
    // Still paused: a new row; the upgrade log is behind the cursor.
    expect(h.open()).toEqual(["usd1_paused"]);
    expect(h.repository.rows.map((row) => [row.kind, row.resolution])).toEqual([
      ["usd1_upgraded", "manual"],
      ["usd1_paused", "manual"],
      ["usd1_paused", null],
    ]);
  });
});

describe("chain guard viem reader (Decision 0135)", () => {
  const policyAbi = parseAbi([
    "function protocolFeeForPool((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey) view returns (uint24)",
  ]);

  it("calls protocolFeeForPool with the PoolKey tuple; no data is null", async () => {
    const key = launch2PoolKey({
      meme: guardMeme(1),
      usd1,
      hook: guardHook(1),
    });
    const calls: unknown[] = [];
    let answer: Hex = encodeFunctionResult({
      abi: policyAbi,
      functionName: "protocolFeeForPool",
      result: 4_096 + 12,
    });
    const reader = createChainGuardChain({
      rpcUrls: [],
      chainReference: 97,
      transport: custom({
        request: ({ method, params }: { method: string; params?: unknown }) => {
          if (method === "eth_chainId") return Promise.resolve("0x61");
          if (method !== "eth_call") {
            return Promise.reject(new Error(`unexpected ${method}`));
          }
          const call = (params as [{ data: Hex; to: string }])[0];
          calls.push(
            decodeFunctionData({ abi: policyAbi, data: call.data }).args,
          );
          return Promise.resolve(answer);
        },
      }),
    });
    expect(await reader.readProtocolFeePolicy(controller, key)).toBe(4_108);
    const [sent] = calls[0] as [Record<string, string | number>];
    expect(
      Object.fromEntries(
        Object.entries(sent).map(([name, value]) => [
          name,
          typeof value === "string" ? value.toLowerCase() : value,
        ]),
      ),
    ).toEqual({ ...key });
    answer = "0x";
    expect(await reader.readProtocolFeePolicy(controller, key)).toBeNull();
  });

  it("decodes the PoolManager fee logs and asks every address in one filter", async () => {
    const poolId: Hex = `0x${"ab".repeat(32)}`;
    const filters: { address: string[] }[] = [];
    const reader = createChainGuardChain({
      rpcUrls: [],
      chainReference: 97,
      transport: custom({
        request: ({ method, params }: { method: string; params?: unknown }) => {
          if (method !== "eth_getLogs") {
            return Promise.reject(new Error(`unexpected ${method}`));
          }
          filters.push((params as [{ address: string[] }])[0]);
          const base = {
            address: poolManager,
            blockHash: `0x${"bb".repeat(32)}`,
            transactionIndex: "0x0",
            removed: false,
          };
          return Promise.resolve([
            {
              ...base,
              topics: encodeEventTopics({
                abi: chainGuardEventsAbi,
                eventName: "ProtocolFeeUpdated",
                args: { id: poolId },
              }),
              data: encodeAbiParameters([{ type: "uint24" }], [600]),
              blockNumber: "0x10",
              transactionHash: `0x${"01".repeat(32)}`,
              logIndex: "0x0",
            },
            {
              ...base,
              topics: encodeEventTopics({
                abi: chainGuardEventsAbi,
                eventName: "ProtocolFeeControllerUpdated",
                args: { protocolFeeController: controller as Hex },
              }),
              data: "0x",
              blockNumber: "0x11",
              transactionHash: `0x${"02".repeat(32)}`,
              logIndex: "0x0",
            },
          ]);
        },
      }),
    });
    const logs = await reader.getLogs({
      usd1,
      proxyAdmin: guardAddress(0xad),
      poolManagers: [poolManager],
      fromBlock: 1n,
      toBlock: 20n,
    });
    expect(filters[0]?.address.map((entry) => entry.toLowerCase())).toEqual([
      usd1,
      guardAddress(0xad),
      poolManager,
    ]);
    expect(logs.map((log) => [log.name, log.args])).toEqual([
      ["ProtocolFeeUpdated", { id: poolId, protocolFee: "600" }],
      ["ProtocolFeeControllerUpdated", { protocolFeeController: controller }],
    ]);
  });
});

describe("alert outlets (Decision 0135 D)", () => {
  const token = "123456789:AAH-secret-token_value-0123456789";
  const opened = {
    type: "incident_opened" as const,
    chainId: "eip155:56",
    incidentId: "4f1c2f5e-7c55-4d55-9d55-2a0b8c0d9e11",
    kind: "usd1_paused",
    subject: usd1,
    details: { source: "state" },
    at: "2026-10-14T00:00:00.000Z",
  };

  function capture(
    answer: (url: string) => Promise<{ ok: boolean; status: number }>,
  ) {
    const requests: { url: string; body: unknown; signal: AbortSignal }[] = [];
    const fetch: ChainGuardAlertFetch = (url, init) => {
      requests.push({ url, body: JSON.parse(init.body), signal: init.signal });
      return answer(url);
    };
    return { requests, fetch };
  }

  it("is null (nothing sent) when neither outlet is configured", () => {
    expect(parseChainGuardAlertConfig({})).toBeNull();
    expect(
      createChainGuardAlertNotifier({ config: null, onFailure: () => {} }),
    ).toBeNull();
    expect(
      createChainGuardAlertNotifier({ config: undefined, onFailure: () => {} }),
    ).toBeNull();
  });

  it("posts JSON to the webhook and plain text to Telegram sendMessage", async () => {
    const { requests, fetch } = capture(() =>
      Promise.resolve({ ok: true, status: 200 }),
    );
    const failures: unknown[] = [];
    const notifier = createChainGuardAlertNotifier({
      config: parseChainGuardAlertConfig({
        CHAIN_GUARD_WEBHOOK_URL: "https://hooks.example.com/loop/secret-path",
        CHAIN_GUARD_TELEGRAM_BOT_TOKEN: token,
        CHAIN_GUARD_TELEGRAM_CHAT_ID: "-1001234567890",
      }),
      fetch,
      onFailure: (event) => failures.push(event),
    });
    await notifier?.notify(opened);
    expect(failures).toEqual([]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://hooks.example.com/loop/secret-path",
      `https://api.telegram.org/bot${token}/sendMessage`,
    ]);
    expect(requests[0]?.body).toMatchObject({
      source: "loop.chain_guard",
      type: "incident_opened",
      chainId: "eip155:56",
      kind: "usd1_paused",
      subject: usd1,
      details: { source: "state" },
      at: opened.at,
    });
    expect(requests[1]?.body).toEqual({
      chat_id: "-1001234567890",
      text: chainGuardAlertText(opened),
      disable_web_page_preview: true,
    });
    expect(chainGuardAlertText(opened)).toContain("chain: eip155:56");
    expect(
      requests.every((request) => request.signal instanceof AbortSignal),
    ).toBe(true);
  });

  it("reports one failure per outlet by host only and never rejects", async () => {
    const { fetch } = capture((url) =>
      url.includes("telegram")
        ? Promise.reject(new DOMException("timed out", "TimeoutError"))
        : Promise.resolve({ ok: false, status: 502 }),
    );
    const failures: Record<string, unknown>[] = [];
    const notifier = createChainGuardAlertNotifier({
      config: {
        webhookUrl: "https://hooks.example.com/loop/secret-path",
        telegram: { botToken: token, chatId: "@loopops" },
      },
      fetch,
      onFailure: (event) => failures.push({ ...event }),
    });
    await expect(
      notifier?.notify({
        type: "hold_engaged",
        chainId,
        lane: "launch2_buyback_keeper",
        kind: "usd1_paused",
        subject: usd1,
        holdCount: 1,
        at: opened.at,
      }),
    ).resolves.toBeUndefined();
    expect(failures).toEqual([
      {
        reasonCode: "CHAIN_GUARD_ALERT_DELIVERY_FAILED",
        outlet: "webhook",
        host: "hooks.example.com",
        status: 502,
        errorClass: null,
      },
      {
        reasonCode: "CHAIN_GUARD_ALERT_DELIVERY_FAILED",
        outlet: "telegram",
        host: "api.telegram.org",
        status: null,
        errorClass: "TimeoutError",
      },
    ]);
    expect(JSON.stringify(failures)).not.toContain("secret");
    expect(JSON.stringify(failures)).not.toContain(token);
  });

  it("gives up after the timeout", async () => {
    const fetch: ChainGuardAlertFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(init.signal.reason as Error);
        });
      });
    const failures: { errorClass: string | null }[] = [];
    const notifier = createChainGuardAlertNotifier({
      config: { webhookUrl: "https://hooks.example.com/x", telegram: null },
      fetch,
      timeoutMs: 20,
      onFailure: (event) => failures.push(event),
    });
    await notifier?.notify(opened);
    expect(failures.map((failure) => failure.errorClass)).toEqual([
      "TimeoutError",
    ]);
  });

  it("refuses a malformed outlet without echoing the secret", () => {
    const cases: Record<string, string>[] = [
      { CHAIN_GUARD_WEBHOOK_URL: "http://hooks.example.com/x" },
      { CHAIN_GUARD_WEBHOOK_URL: "https://user:pw@hooks.example.com/x" },
      { CHAIN_GUARD_WEBHOOK_URL: "not a url" },
      { CHAIN_GUARD_TELEGRAM_BOT_TOKEN: token },
      {
        CHAIN_GUARD_TELEGRAM_BOT_TOKEN: "nope-secret",
        CHAIN_GUARD_TELEGRAM_CHAT_ID: "1",
      },
      {
        CHAIN_GUARD_TELEGRAM_BOT_TOKEN: token,
        CHAIN_GUARD_TELEGRAM_CHAT_ID: "chat secret",
      },
    ];
    for (const environment of cases) {
      let caught: unknown = null;
      try {
        parseChainGuardAlertConfig(environment);
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(environment)).toBeInstanceOf(
        ConfigurationError,
      );
      const text = (caught as ConfigurationError).issues.join(" ");
      expect(text).not.toContain("secret");
      expect(text).not.toContain(token);
    }
    expect(
      parseChainGuardAlertConfig({
        CHAIN_GUARD_WEBHOOK_URL: "http://127.0.0.1:9000/hook",
      }),
    ).toEqual({ webhookUrl: "http://127.0.0.1:9000/hook", telegram: null });
  });
});

describe("launch2 reader skips foreign logs before decoding (Decision 0135 E)", () => {
  it("counts an untracked address apart from a tracked address's unknown topic", async () => {
    const snapshots = `0x${"0a".repeat(20)}`;
    const foreign = `0x${"0f".repeat(20)}`;
    const launchId: Hex = `0x${"11".repeat(32)}`;
    const known = {
      topics: encodeEventTopics({
        abi: snapshotRegistryAbi,
        eventName: "PublicRoundOpenedWithoutHolders",
        args: { launchId },
      }),
      data: encodeAbiParameters(
        [{ type: "uint64" }, { type: "uint64" }],
        [1n, 1n],
      ),
    };
    const log = (address: string, index: number, body = known) => ({
      address,
      ...body,
      blockNumber: "0x10",
      blockHash: `0x${"bb".repeat(32)}`,
      transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
      transactionIndex: "0x0",
      logIndex: `0x${index.toString(16)}`,
      removed: false,
    });
    const chain = createLaunch2Chain({
      rpcUrls: [],
      transport: custom({
        request: ({ method }: { method: string }) => {
          if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
          return Promise.resolve([
            log(snapshots, 0),
            log(foreign, 1),
            log(foreign, 2),
            log(snapshots, 3, {
              topics: [
                `0x${"ee".repeat(32)}`,
              ] as unknown as typeof known.topics,
              data: "0x",
            }),
          ]);
        },
      }),
    });
    const result = await chain.getLogs({
      roles: new Map([[snapshots, "snapshots"]]),
      fromBlock: 16n,
      toBlock: 16n,
    });
    expect(result.logs).toHaveLength(1);
    expect(result.ignored).toBe(1);
    expect(result.skippedForeign).toBe(2);
  });
});
