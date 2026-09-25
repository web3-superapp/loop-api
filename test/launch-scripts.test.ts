import { describe, expect, it, vi } from "vitest";

import {
  parseAllowlistCsv,
  parseLaunchAllowlistArguments,
  runLaunchAllowlist,
} from "../scripts/launch-allowlist.js";
import {
  parseLaunchRegisterSaleArguments,
  registerLaunchSale,
  runLaunchRegisterSale,
  type LaunchRegisterSaleDependencies,
  type ObservedSale,
} from "../scripts/launch-register-sale.js";
import type { LaunchDetailRecord } from "../src/features/launch/launch-repository.js";
import { LaunchContractUnavailableError } from "../src/integrations/launch/launch-contract-adapter.js";
import {
  fakeConfigVersion,
  fakeLaunchContract,
  fakeProjectToken,
} from "./helpers/launch-fake-adapter.js";
import {
  launchId,
  launchRepositoryFor,
  registeredDetail,
} from "./helpers/launch-service-fakes.js";

/**
 * Decision 0076 ruling 7 / Decision 0077 operator scripts: every refusal of
 * `pnpm launch:register-sale` happens before anything is written; the
 * allowlist CSV is all-or-nothing. Fixtures only.
 */

const argv = (...args: string[]) => ["node", "script", ...args];

function unregistered(): LaunchDetailRecord {
  const detail = registeredDetail();
  return {
    ...detail,
    launch: {
      ...detail.launch,
      saleId: null,
      contractAddress: null,
      contractVersion: null,
      quoteAssetId: null,
      projectAssetId: null,
    },
  };
}

function deps(
  observed: Partial<ObservedSale> | Error = {},
  detail: LaunchDetailRecord = unregistered(),
) {
  const registerSale = vi.fn(() => Promise.resolve());
  const registerAssets = vi.fn(() => Promise.resolve());
  const resetCheckpoint = vi.fn(() => Promise.resolve(true));
  const dependencies: LaunchRegisterSaleDependencies = {
    contract: fakeLaunchContract,
    chainId: "eip155:97",
    launches: launchRepositoryFor(detail),
    chain: { registerSale, resetCheckpoint },
    readSale: () =>
      observed instanceof Error
        ? Promise.reject(observed)
        : Promise.resolve({
            configVersion: fakeConfigVersion,
            usd1: fakeLaunchContract.usd1Address,
            projectToken: fakeProjectToken,
            blockNumber: "900",
            ...observed,
          }),
    registerAssets,
  };
  return { dependencies, registerSale, registerAssets, resetCheckpoint };
}

const request = { launchId, saleId: "7", confirm: true, rescan: false };

describe("pnpm launch:register-sale", () => {
  it("parses --launch/--sale-id/--confirm/--rescan and refuses production without --confirm", () => {
    expect(
      parseLaunchRegisterSaleArguments(
        argv("--launch", launchId, "--sale-id", "7", "--confirm"),
        {},
      ),
    ).toEqual({
      launchId,
      saleId: "7",
      confirm: true,
      rescan: false,
    });
    for (const bad of [
      argv("--launch", "nope", "--sale-id", "7"),
      argv("--launch", launchId, "--sale-id", "0"),
      argv("--launch", launchId),
      argv("--launch", launchId, "--sale-id", "7", "--rescan"),
      argv("--launch", launchId, "--sale-id", "7", "--force"),
    ]) {
      expect(() => parseLaunchRegisterSaleArguments(bad, {})).toThrow();
    }
    expect(() =>
      parseLaunchRegisterSaleArguments(
        argv("--launch", launchId, "--sale-id", "7"),
        { NODE_ENV: "production" },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "launch_register_sale_production_requires_confirm",
      }),
    );
  });

  const refusals: readonly [
    string,
    Parameters<typeof deps>[0],
    LaunchDetailRecord | undefined,
    string,
  ][] = [
    [
      "unknown saleId (zero configVersion)",
      { configVersion: `0x${"00".repeat(32)}` },
      undefined,
      "LAUNCH_SALE_NOT_FOUND",
    ],
    [
      "another settlement token",
      { usd1: "0x9999999999999999999999999999999999999999" },
      undefined,
      "LAUNCH_USD1_ADDRESS_MISMATCH",
    ],
    [
      "another project token",
      { projectToken: "0x8888888888888888888888888888888888888888" },
      undefined,
      "LAUNCH_PROJECT_TOKEN_MISMATCH",
    ],
    [
      "the sale reverts SaleNotFound / is unreadable",
      new LaunchContractUnavailableError("LAUNCH_CONTRACT_READ_FAILED"),
      undefined,
      "LAUNCH_CONTRACT_READ_FAILED",
    ],
    [
      "already registered",
      {},
      registeredDetail(),
      "LAUNCH_SALE_ALREADY_REGISTERED",
    ],
    [
      "no projectTokenAddress in the confirmed configuration",
      {},
      {
        ...unregistered(),
        configs: unregistered().configs.map((config) => ({
          ...config,
          parameters: { tierModeV1: "whitelist" },
        })),
      },
      "LAUNCH_PROJECT_TOKEN_UNRECORDED",
    ],
    [
      "another chain",
      {},
      {
        ...unregistered(),
        launch: { ...unregistered().launch, chainId: "eip155:56" as const },
      },
      "LAUNCH_CHAIN_MISMATCH",
    ],
  ];
  for (const [name, observed, detail, reasonCode] of refusals) {
    it(`refuses before writing: ${name}`, async () => {
      const fake = deps(observed, detail);
      await expect(
        registerLaunchSale(request, fake.dependencies),
      ).rejects.toMatchObject({ reasonCode });
      expect(fake.registerSale).not.toHaveBeenCalled();
      expect(fake.registerAssets).not.toHaveBeenCalled();
    });
  }

  it("dry-runs without --confirm and registers (assets, sale, rescan) with it", async () => {
    const dry = deps();
    expect(
      await registerLaunchSale(
        { ...request, confirm: false },
        dry.dependencies,
      ),
    ).toMatchObject({ written: false });
    expect(dry.registerSale).not.toHaveBeenCalled();
    const wet = deps();
    expect(
      await registerLaunchSale({ ...request, rescan: true }, wet.dependencies),
    ).toMatchObject({ written: true, rescanned: true });
    expect(wet.registerAssets).toHaveBeenCalledWith([
      fakeLaunchContract.usd1Address,
      fakeProjectToken,
    ]);
    expect(wet.registerSale).toHaveBeenCalledWith(
      expect.objectContaining({
        launchId,
        saleId: "7",
        contractAddress: fakeLaunchContract.address,
        contractVersion: "1.0.0",
        configVersionOnchain: fakeConfigVersion,
      }),
    );
  });

  it("prints a stable refusal code and never a URL", async () => {
    const stderr: string[] = [];
    const code = await runLaunchRegisterSale({
      argv: argv("--launch", launchId, "--sale-id", "7", "--confirm"),
      environment: {
        NODE_ENV: "test",
        DATABASE_URL: "postgres://x:y@127.0.0.1:5433/loop_api_test",
      },
      stdout: { write: () => true },
      stderr: { write: (line: string) => stderr.push(line) },
      run: () =>
        Promise.reject(
          new LaunchContractUnavailableError("LAUNCH_CONTRACT_CODE_MISSING"),
        ),
    });
    expect(code).toBe(1);
    expect(stderr.join("")).toBe(
      "Launch sale registration refused (LAUNCH_CONTRACT_CODE_MISSING)\n",
    );
    expect(stderr.join("")).not.toContain("127.0.0.1");
  });
});

describe("pnpm launch:allowlist", () => {
  it("parses import and compute and refuses production", () => {
    expect(
      parseLaunchAllowlistArguments(
        argv("import", "list.csv", "--launch", launchId, "--round", "1"),
        {},
      ),
    ).toMatchObject({
      kind: "import",
      file: "list.csv",
      roundIndex: 1,
      source: "operator_csv",
    });
    expect(
      parseLaunchAllowlistArguments(
        argv(
          "compute",
          "--launch",
          launchId,
          "--round",
          "2",
          "--snapshot-block",
          "900",
          "--confirm",
        ),
        {},
      ),
    ).toMatchObject({
      kind: "compute",
      roundIndex: 2,
      snapshotBlock: 900n,
      confirm: true,
    });
    expect(() =>
      parseLaunchAllowlistArguments(
        argv("compute", "--launch", launchId, "--round", "2"),
        {},
      ),
    ).toThrow();
    expect(() =>
      parseLaunchAllowlistArguments(
        argv("import", "a.csv", "--launch", launchId, "--round", "70000"),
        {},
      ),
    ).toThrow();
    expect(() =>
      parseLaunchAllowlistArguments(
        argv("import", "a.csv", "--launch", launchId, "--round", "1"),
        { NODE_ENV: "production" },
      ),
    ).toThrow();
  });

  it("reads a CSV all-or-nothing, lowercasing and de-duplicating", () => {
    expect(
      parseAllowlistCsv(
        "address\n0x000000000000000000000000000000000000000A\n\n0x000000000000000000000000000000000000000a,extra\n0x00000000000000000000000000000000000000bb\n",
      ),
    ).toEqual([
      "0x000000000000000000000000000000000000000a",
      "0x00000000000000000000000000000000000000bb",
    ]);
    expect(() => parseAllowlistCsv("0x1234\n")).toThrow(
      expect.objectContaining({
        code: "launch_allowlist_file_invalid",
        detail: "line 1",
      }),
    );
    expect(() => parseAllowlistCsv("address\n")).toThrow(
      expect.objectContaining({ code: "LAUNCH_ALLOWLIST_EMPTY" }),
    );
  });

  it("reports a refusal code on stderr", async () => {
    const stderr: string[] = [];
    const code = await runLaunchAllowlist({
      argv: argv("import"),
      environment: {},
      stdout: { write: () => true },
      stderr: { write: (line: string) => stderr.push(line) },
    });
    expect(code).toBe(1);
    expect(stderr.join("")).toBe(
      "Launch allowlist refused (launch_allowlist_arguments_invalid)\n",
    );
  });
});
