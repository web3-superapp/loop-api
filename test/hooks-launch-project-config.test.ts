import { describe, expect, it } from "vitest";

import {
  createHooksLaunchProjectConfigService,
  hooksLaunchFactorySupportsTicker,
  HooksLaunchProjectConfigUnavailableError,
  HooksLaunchTickerUnsupportedByFactoryError,
  HooksLaunchProjectNotFoundError,
  HooksLaunchProjectVersionConflictError,
  type HooksLaunchProjectConfigRecord,
  type HooksLaunchProjectConfigRepository,
} from "../src/features/launch/hooks-launch-project-config.js";
import {
  type BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  custom,
  encodeAbiParameters,
  HttpRequestError,
  keccak256,
  TimeoutError,
} from "viem";

import {
  createHooksLaunchFactoryReader,
  hooksLaunchTextRulesFromVersion,
  hooksLaunchTextRulesVersionAbi,
  isHooksLaunchMissingFunctionRevert,
} from "../src/integrations/launch/hooks-launch-factory-reader.js";

const body = {
  name: "LOOP 项目示例",
  ticker: "MEME",
  logoAssetUrl: "https://cdn.example.com/logo.png",
  description: "Project description",
  links: ["https://example.com"],
  nftSaleStartAt: "1800000000",
  buybackRecipient: "0x1234567890123456789012345678901234567890",
};
const projectId = "00000000-0000-4000-8000-000000000001";

function makeHarness() {
  let record: HooksLaunchProjectConfigRecord | null = null;
  const repository: HooksLaunchProjectConfigRepository = {
    getOwnedDraft(input) {
      if (input.projectId !== projectId || input.ownerUserId !== "user-1") {
        return Promise.resolve(null);
      }
      return Promise.resolve(record);
    },
    saveOwnedDraft(input) {
      if (input.projectId !== projectId || input.ownerUserId !== "user-1") {
        return Promise.reject(new HooksLaunchProjectNotFoundError());
      }
      const version = record?.version ?? 0;
      if (input.expectedVersion !== version) {
        return Promise.reject(new HooksLaunchProjectVersionConflictError());
      }
      record = Object.freeze({
        ...input,
        version: version + 1,
        updatedAt: "2026-10-08T00:00:00.000Z",
      });
      return Promise.resolve(record);
    },
    getOwnedProgress: () =>
      Promise.resolve({ approvedAt: null, rejection: null, latestJobId: null }),
  };
  return { repository, getRecord: () => record };
}

describe("Hooks project config service", () => {
  it("persists owner-scoped drafts with the immutable Hooks economics", async () => {
    const harness = makeHarness();
    const service = createHooksLaunchProjectConfigService({
      fixedBuybackRecipient: "0x1234567890123456789012345678901234567890",
      repository: harness.repository,
      factory: {
        nftSaleDuration: () =>
          Promise.resolve({ seconds: 604_800, legacy: false }),
      },
      minimumLeadSeconds: 86_400,
      now: () => 1_790_000_000,
    });

    const result = await service.saveDraft({
      ownerUserId: "user-1",
      projectId,
      expectedVersion: 0,
      body,
    });

    expect(result.version).toBe(1);
    expect(result.config.fixedEconomics.curveBuyTaxBps).toBe(1_000);
    expect(result.config.fixedEconomics.buybackOrderUsd1Raw).toBe(
      "100000000000000000000",
    );
    expect(harness.getRecord()?.config.configHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects stale writes and does not mutate the last saved version", async () => {
    const harness = makeHarness();
    const service = createHooksLaunchProjectConfigService({
      fixedBuybackRecipient: "0x1234567890123456789012345678901234567890",
      repository: harness.repository,
      factory: {
        nftSaleDuration: () =>
          Promise.resolve({ seconds: 604_800, legacy: false }),
      },
      minimumLeadSeconds: 86_400,
      now: () => 1_790_000_000,
    });
    await service.saveDraft({
      ownerUserId: "user-1",
      projectId,
      expectedVersion: 0,
      body,
    });

    await expect(
      service.saveDraft({
        ownerUserId: "user-1",
        projectId,
        expectedVersion: 0,
        body: { ...body, name: "Changed" },
      }),
    ).rejects.toBeInstanceOf(HooksLaunchProjectVersionConflictError);
    expect(harness.getRecord()?.version).toBe(1);
    expect(harness.getRecord()?.config.name).toBe(body.name);
  });

  it("does not disclose another owner's project", async () => {
    const service = createHooksLaunchProjectConfigService({
      fixedBuybackRecipient: "0x1234567890123456789012345678901234567890",
      repository: makeHarness().repository,
      factory: {
        nftSaleDuration: () =>
          Promise.resolve({ seconds: 604_800, legacy: false }),
      },
      minimumLeadSeconds: 86_400,
      now: () => 1_790_000_000,
    });

    await expect(
      service.saveDraft({
        ownerUserId: "user-2",
        projectId,
        expectedVersion: 0,
        body,
      }),
    ).rejects.toBeInstanceOf(HooksLaunchProjectNotFoundError);
  });

  it("rejects economic overrides even when submitted as extra config keys", async () => {
    const service = createHooksLaunchProjectConfigService({
      fixedBuybackRecipient: "0x1234567890123456789012345678901234567890",
      repository: makeHarness().repository,
      factory: {
        nftSaleDuration: () =>
          Promise.resolve({ seconds: 604_800, legacy: false }),
      },
      minimumLeadSeconds: 86_400,
      now: () => 1_790_000_000,
    });

    await expect(
      service.saveDraft({
        ownerUserId: "user-1",
        projectId,
        expectedVersion: 0,
        body: { ...body, officialPoolBuyTaxBps: 0 },
      }),
    ).rejects.toThrow("Invalid Hooks launch draft");
  });

  describe("Decision 0119: the draft hashes the target Factory's sale period", () => {
    const save = (
      factory: Parameters<
        typeof createHooksLaunchProjectConfigService
      >[0]["factory"],
    ) =>
      createHooksLaunchProjectConfigService({
        fixedBuybackRecipient: "0x1234567890123456789012345678901234567890",
        repository: makeHarness().repository,
        factory,
        minimumLeadSeconds: 86_400,
        now: () => 1_790_000_000,
      }).saveDraft({
        ownerUserId: "user-1",
        projectId,
        expectedVersion: 0,
        body,
      });

    it("binds 3,600 s for a 1-hour Factory and 604,800 s for a 7-day one", async () => {
      const hourly = await save({
        nftSaleDuration: () =>
          Promise.resolve({ seconds: 3_600, legacy: false }),
      });
      const weekly = await save({
        nftSaleDuration: () =>
          Promise.resolve({ seconds: 604_800, legacy: true }),
      });
      expect(hourly.config.fixedEconomics.nftSaleDurationSeconds).toBe(3_600);
      expect(weekly.config.fixedEconomics.nftSaleDurationSeconds).toBe(604_800);
      expect(hourly.config.configHash).not.toBe(weekly.config.configHash);
    });

    it("fails closed without a Factory or on a failed read (no constant fallback)", async () => {
      await expect(save(null)).rejects.toMatchObject({ source: "factory" });
      await expect(
        save({ nftSaleDuration: () => Promise.reject(new Error("rpc down")) }),
      ).rejects.toBeInstanceOf(HooksLaunchProjectConfigUnavailableError);
    });
  });
});

describe("Decision 0164: the ticker transition gate", () => {
  const recipient = "0x1234567890123456789012345678901234567890";
  function serviceFor(tickerTextRule?: () => Promise<"utf8" | "ascii">) {
    const harness = makeHarness();
    let probes = 0;
    const service = createHooksLaunchProjectConfigService({
      fixedBuybackRecipient: recipient,
      repository: harness.repository,
      factory: {
        nftSaleDuration: () =>
          Promise.resolve({ seconds: 604_800, legacy: false }),
        ...(tickerTextRule === undefined
          ? {}
          : {
              tickerTextRule: () => {
                probes += 1;
                return tickerTextRule();
              },
            }),
      },
      minimumLeadSeconds: 86_400,
      now: () => 1_790_000_000,
    });
    return { service, harness, probes: () => probes };
  }
  const save = (
    service: ReturnType<typeof serviceFor>["service"],
    ticker: string,
  ) =>
    service.saveDraft({
      ownerUserId: "user-1",
      projectId,
      expectedVersion: 0,
      body: { ...body, ticker },
    });

  it("passes a legacy ticker on any Factory without probing", async () => {
    const ascii = serviceFor(() => Promise.resolve("ascii"));
    await expect(save(ascii.service, "DOGE")).resolves.toMatchObject({
      config: { ticker: "DOGE" },
    });
    expect(ascii.probes()).toBe(0);
  });

  it.each(["狗狗币", "doge", "$1", "D"])(
    "refuses %s on a pre-S242 Factory and writes nothing",
    async (ticker) => {
      const ascii = serviceFor(() => Promise.resolve("ascii"));
      await expect(save(ascii.service, ticker)).rejects.toBeInstanceOf(
        HooksLaunchTickerUnsupportedByFactoryError,
      );
      expect(ascii.harness.getRecord()).toBeNull();
    },
  );

  it("fails closed on a reader without the probe", async () => {
    const legacyReader = serviceFor();
    await expect(save(legacyReader.service, "狗狗币")).rejects.toBeInstanceOf(
      HooksLaunchTickerUnsupportedByFactoryError,
    );
  });

  it("is unavailable when the probe cannot be read", async () => {
    const broken = serviceFor(() => Promise.reject(new Error("rpc down")));
    await expect(save(broken.service, "狗狗币")).rejects.toMatchObject({
      name: "HooksLaunchProjectConfigUnavailableError",
      source: "factory",
    });
    expect(broken.harness.getRecord()).toBeNull();
  });

  it("lifts the gate on an S242 Factory, case kept", async () => {
    const utf8 = serviceFor(() => Promise.resolve("utf8"));
    await expect(save(utf8.service, "狗狗币")).resolves.toMatchObject({
      config: { ticker: "狗狗币" },
    });
    await expect(
      hooksLaunchFactorySupportsTicker(
        { tickerTextRule: () => Promise.resolve("utf8") },
        "doge",
      ),
    ).resolves.toBe(true);
    await expect(hooksLaunchFactorySupportsTicker(null, "doge")).resolves.toBe(
      false,
    );
    await expect(hooksLaunchFactorySupportsTicker(null, "DOGE")).resolves.toBe(
      true,
    );
  });

  describe("real node answers to launchTextRulesVersion() through the reader", () => {
    const code = "0x6001600055";
    /** A reader whose eth_call answers `call` (throw = JSON-RPC error). */
    function readerAnswering(call: () => unknown) {
      let calls = 0;
      const unsupported: number[] = [];
      const reader = createHooksLaunchFactoryReader({
        onUnsupportedTextRulesVersion: (version) => {
          unsupported.push(version);
        },
        factoryAddress: "0x1111111111111111111111111111111111111111",
        expectedRuntimeCodeHash: keccak256(code),
        rpcUrls: [],
        transport: custom(
          {
            // A thrown JSON-RPC error object becomes the rejection.
            // eslint-disable-next-line @typescript-eslint/require-await
            async request({ method }: { method: string }) {
              if (method === "eth_chainId") return "0x61";
              if (method === "eth_getCode") return code;
              if (method === "eth_call") {
                calls += 1;
                return call();
              }
              throw new Error(`unexpected ${method}`);
            },
          },
          { retryCount: 0 },
        ),
      });
      return { reader, calls: () => calls, unsupported };
    }
    const rpcError = (shape: Record<string, unknown>) => () => {
      throw Object.assign(new Error(String(shape["message"])), shape);
    };

    it.each([
      ["publicnode", { code: 3, message: "execution reverted", data: "0x" }],
      [
        "bnbchain seed",
        { code: 3, message: "execution reverted: 0x", data: "0x" },
      ],
      [
        "geth -32000 without data",
        { code: -32000, message: "execution reverted" },
      ],
      [
        "geth -32000 with data 0x",
        { code: -32000, message: "execution reverted", data: "0x" },
      ],
    ] as const)("%s empty revert → ascii (cached)", async (_name, shape) => {
      const { reader, calls } = readerAnswering(rpcError(shape));
      await expect(reader.tickerTextRule?.()).resolves.toBe("ascii");
      await expect(reader.tickerTextRule?.()).resolves.toBe("ascii");
      expect(calls()).toBe(1);
    });

    it("result 0x → ascii", async () => {
      const { reader } = readerAnswering(() => "0x");
      await expect(reader.tickerTextRule?.()).resolves.toBe("ascii");
    });

    it("2 → utf8", async () => {
      const { reader } = readerAnswering(() =>
        encodeAbiParameters([{ type: "uint8" }], [2]),
      );
      await expect(reader.tickerTextRule?.()).resolves.toBe("utf8");
    });

    it.each([
      [
        "a revert with custom error data",
        rpcError({
          code: 3,
          message: "execution reverted",
          data: "0x82b42900",
        }),
      ],
      [
        "a geth revert with custom error data",
        rpcError({
          code: -32000,
          message: "execution reverted",
          data: "0x82b42900",
        }),
      ],
      [
        "a revert reason",
        rpcError({ code: 3, message: "execution reverted: nope", data: "0x" }),
      ],
      ["a rate limit", rpcError({ code: -32005, message: "limit exceeded" })],
      ["an HTTP 429", rpcError({ code: 429, message: "Too Many Requests" })],
      [
        "another -32000",
        rpcError({ code: -32000, message: "header not found" }),
      ],
      ["version 1", () => encodeAbiParameters([{ type: "uint8" }], [1])],
    ] as const)("%s → unreadable, not cached", async (_name, call) => {
      const { reader, calls } = readerAnswering(call);
      await expect(reader.tickerTextRule?.()).rejects.toThrow();
      await expect(reader.tickerTextRule?.()).rejects.toThrow();
      expect(calls()).toBe(2);
    });

    // Decision 0168 (S255 audit I-21): only version 2 is trusted.
    it.each([1, 3, 255])(
      "version %i → unreadable (fail closed) and reported",
      async (version) => {
        const { reader, unsupported } = readerAnswering(() =>
          encodeAbiParameters([{ type: "uint8" }], [version]),
        );
        await expect(reader.tickerTextRule?.()).rejects.toThrow(
          "Hooks launch factory text rules unreadable",
        );
        expect(unsupported).toEqual([version]);
      },
    );

    it("version 2 → utf8 without a report; a revert → ascii without a report", async () => {
      const v2 = readerAnswering(() =>
        encodeAbiParameters([{ type: "uint8" }], [2]),
      );
      await expect(v2.reader.tickerTextRule?.()).resolves.toBe("utf8");
      expect(v2.unsupported).toEqual([]);
      const old = readerAnswering(
        rpcError({ code: 3, message: "execution reverted", data: "0x" }),
      );
      await expect(old.reader.tickerTextRule?.()).resolves.toBe("ascii");
      expect(old.unsupported).toEqual([]);
    });

    it("a version 3 Factory makes a non-legacy ticker save unavailable (503 path)", async () => {
      const { reader } = readerAnswering(() =>
        encodeAbiParameters([{ type: "uint8" }], [3]),
      );
      const harness = makeHarness();
      const service = createHooksLaunchProjectConfigService({
        fixedBuybackRecipient: body.buybackRecipient,
        repository: harness.repository,
        factory: {
          nftSaleDuration: () =>
            Promise.resolve({ seconds: 604_800, legacy: false }),
          tickerTextRule: () =>
            reader.tickerTextRule?.() ?? Promise.reject(new Error("no probe")),
        },
        minimumLeadSeconds: 86_400,
        now: () => 1_790_000_000,
      });
      await expect(
        service.saveDraft({
          ownerUserId: "user-1",
          projectId,
          expectedVersion: 0,
          body: { ...body, ticker: "狗狗币" },
        }),
      ).rejects.toBeInstanceOf(HooksLaunchProjectConfigUnavailableError);
      expect(harness.getRecord()).toBeNull();
    });
  });

  it("reads launchTextRulesVersion(): exactly 2 utf8, a missing function ascii, else unreadable", () => {
    expect(hooksLaunchTextRulesFromVersion(2)).toBe("utf8");
    // Decision 0168: a newer (possibly stricter) generation fails closed.
    for (const value of [0, 1, 3, 255, 256, 2.5, "2", 2n, null, undefined]) {
      expect(hooksLaunchTextRulesFromVersion(value)).toBeNull();
    }
    const wrap = (cause: BaseError) =>
      new ContractFunctionExecutionError(cause, {
        abi: hooksLaunchTextRulesVersionAbi,
        functionName: "launchTextRulesVersion",
      });
    const reverted = (data?: `0x${string}`, message?: string) =>
      wrap(
        new ContractFunctionRevertedError({
          abi: hooksLaunchTextRulesVersionAbi,
          functionName: "launchTextRulesVersion",
          ...(data === undefined ? {} : { data }),
          ...(message === undefined ? {} : { message }),
        }),
      );
    // Old factory: no selector → empty revert (or empty return data).
    expect(isHooksLaunchMissingFunctionRevert(reverted())).toBe(true);
    expect(isHooksLaunchMissingFunctionRevert(reverted("0x"))).toBe(true);
    expect(
      isHooksLaunchMissingFunctionRevert(
        reverted(undefined, "execution reverted"),
      ),
    ).toBe(true);
    expect(
      isHooksLaunchMissingFunctionRevert(
        wrap(
          new ContractFunctionZeroDataError({
            functionName: "launchTextRulesVersion",
          }),
        ),
      ),
    ).toBe(true);
    // A revert with data or a reason, transport errors, timeouts: unreadable.
    expect(isHooksLaunchMissingFunctionRevert(reverted("0x82b42900"))).toBe(
      false,
    );
    expect(
      isHooksLaunchMissingFunctionRevert(
        reverted(undefined, "internal error: header not found"),
      ),
    ).toBe(false);
    expect(
      isHooksLaunchMissingFunctionRevert(
        new HttpRequestError({ url: "https://rpc.invalid", status: 502 }),
      ),
    ).toBe(false);
    expect(
      isHooksLaunchMissingFunctionRevert(
        new TimeoutError({ body: {}, url: "https://rpc.invalid" }),
      ),
    ).toBe(false);
    expect(isHooksLaunchMissingFunctionRevert(new Error("x"))).toBe(false);
  });
});
