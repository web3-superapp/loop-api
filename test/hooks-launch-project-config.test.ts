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
  HttpRequestError,
  TimeoutError,
} from "viem";

import {
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

  it("reads launchTextRulesVersion(): >= 2 utf8, a missing function ascii, else unreadable", () => {
    expect(hooksLaunchTextRulesFromVersion(2)).toBe("utf8");
    expect(hooksLaunchTextRulesFromVersion(3)).toBe("utf8");
    for (const value of [0, 1, 256, 2.5, "2", 2n, null, undefined]) {
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
