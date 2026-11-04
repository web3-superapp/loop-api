import type { FastifyInstance } from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AccountWalletRepository } from "../src/database/account-wallet-repository.js";
import type { Database } from "../src/database/database.js";
import type { HooksLaunchFactoryReader } from "../src/features/launch/hooks-launch-deployment.js";
import {
  resetHooksLaunchProjectTermsProbeCache,
  type HooksLaunchProjectConfigRecord,
  type HooksLaunchProjectConfigRepository,
} from "../src/features/launch/hooks-launch-project-config.js";
import type {
  HooksLaunchDeploymentJob,
  HooksLaunchSubmissionRepository,
} from "../src/features/launch/hooks-launch-submission.js";
import { createUnavailableLaunchRepository } from "../src/features/launch/launch-repository.js";
import {
  s7AccountId,
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0199 (S359): the per-project launch terms on the Hooks routes —
 * the two optional draft inputs and their 422 reasons, the
 * LAUNCH2_PROJECT_TERMS_EMIT gate on the draft read, and the S359 signing /
 * submission path (domain v2, terms in the signed request).
 */

const projectId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const walletId = "00000000-0000-4000-8000-000000000099";
const jobId = "00000000-0000-4000-8000-000000000011";
const createdAt = "2026-11-04T00:00:00.000Z";
const signer = privateKeyToAccount(`0x${"01".repeat(32)}`);
const recipient = "0x1234567890123456789012345678901234567890";
const enabled = {
  HOOKS_LAUNCH_ENABLED: "on",
  LAUNCH_CHAIN_ID: "97",
  LAUNCH2_BUYBACK_RECIPIENT: recipient,
} as const;
const draftBody = {
  name: "MoonCat",
  ticker: "MCAT",
  logoAssetUrl: "https://cdn.example.com/logo.png",
  description: "A launch project",
  links: ["https://mooncat.example"],
  nftSaleStartAt: "4000000000",
  buybackRecipient: recipient,
};

function configs(): HooksLaunchProjectConfigRepository {
  let record: HooksLaunchProjectConfigRecord | null = null;
  return {
    getOwnedProgress: () =>
      Promise.resolve({ approvedAt: null, rejection: null, latestJobId: null }),
    getOwnedDraft: (input) =>
      Promise.resolve(input.ownerUserId === s7AccountId ? record : null),
    saveOwnedDraft(input) {
      record = Object.freeze({
        projectId,
        ownerUserId: s7AccountId,
        version: (record?.version ?? 0) + 1,
        templateVersion: input.templateVersion,
        config: input.config,
        ...(input.terms === undefined ? {} : { terms: input.terms }),
        updatedAt: createdAt,
      });
      return Promise.resolve(record);
    },
  };
}

const wallets = {
  get: (ownerUserId: string, requested: string) =>
    Promise.resolve(
      ownerUserId === s7AccountId && requested === walletId
        ? {
            walletId,
            providerWalletId: "privy-wallet-1",
            address: signer.address,
            kind: "embedded" as const,
            status: "active" as const,
            isActive: true,
            firstSeenAt: createdAt,
            lastSeenAt: createdAt,
          }
        : null,
    ),
} as unknown as AccountWalletRepository;

function reader(
  projectTermsSupported: boolean | undefined,
  hookDeployment: HooksLaunchFactoryReader["hookDeployment"] = () =>
    Promise.resolve({
      deployer: "0x4444444444444444444444444444444444444444",
      initCodeHash: `0x${"ab".repeat(32)}`,
    }),
): HooksLaunchFactoryReader {
  return {
    factoryAddress: "0x1111111111111111111111111111111111111111",
    chainId: 97,
    nonce: () => Promise.resolve(9n),
    ownerVersionLaunchId: () => Promise.resolve(`0x${"0".repeat(64)}`),
    nftSaleDuration: () => Promise.resolve({ seconds: 604_800, legacy: false }),
    tokenDeployment: () =>
      Promise.resolve({
        deployer: "0x5555555555555555555555555555555555555555",
        initCodeHash: `0x${"ef".repeat(32)}`,
      }),
    hookDeployment,
    ...(projectTermsSupported === undefined
      ? {}
      : {
          projectTermsSupported: () => Promise.resolve(projectTermsSupported),
        }),
  };
}

const job = {
  jobId,
  projectId,
  configVersion: 1,
  chainId: 97,
  factoryAddress: "0x1111111111111111111111111111111111111111",
  status: "awaiting_executor",
  memeAddress: `0x${"ab".repeat(18)}6666`,
  hookAddress: `0x${"ab".repeat(18)}20cc`,
  txHash: null,
  confirmations: null,
  activationTxHash: null,
  addresses: { predicted: { meme: "", hook: "" }, deployed: null },
  failure: null,
  attemptCount: 0,
  events: [],
  createdAt,
  updatedAt: createdAt,
} as unknown as HooksLaunchDeploymentJob;

describe("Decision 0199 launch terms on the Hooks routes", () => {
  const apps: FastifyInstance[] = [];
  beforeEach(() => {
    resetHooksLaunchProjectTermsProbeCache();
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    options: {
      readonly emit?: boolean;
      readonly reader?: HooksLaunchFactoryReader;
      readonly submissions?: HooksLaunchSubmissionRepository;
    } = {},
  ) {
    const database: Database = {
      ...s7Database({ launch: createUnavailableLaunchRepository() }),
      accountWallets: wallets,
      hooksLaunchProjectConfigs: configs(),
      ...(options.submissions === undefined
        ? {}
        : { hooksLaunchSubmissions: options.submissions }),
    };
    const app = await buildApp({
      config: s7TestConfig({
        ...enabled,
        ...(options.emit === true ? { LAUNCH2_PROJECT_TERMS_EMIT: "on" } : {}),
      }),
      contractSurface: "v2",
      database,
      hooksLaunchFactoryReader: options.reader ?? reader(true),
      privyAccessTokenVerifier: s7PrivyVerifier(),
      logger: false,
    });
    apps.push(app);
    return app;
  }

  const save = (app: FastifyInstance, extra: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: `/v2/launch/projects/${projectId}/hooks-config`,
      headers: s7CommonHeaders(),
      payload: { expectedVersion: 0, config: { ...draftBody, ...extra } },
    });

  it.each([
    [{ nftPriceUsd1: 2.5 }, "LAUNCH2_NFT_PRICE_INVALID", "nftPriceUsd1"],
    [{ nftPriceUsd1: 0 }, "LAUNCH2_NFT_PRICE_INVALID", "nftPriceUsd1"],
    [{ nftPriceUsd1: 1_001 }, "LAUNCH2_NFT_PRICE_INVALID", "nftPriceUsd1"],
    [
      { walletCapPerMille: -1 },
      "LAUNCH2_WALLET_CAP_INVALID",
      "walletCapPerMille",
    ],
    [
      { walletCapPerMille: 1_001 },
      "LAUNCH2_WALLET_CAP_INVALID",
      "walletCapPerMille",
    ],
    [
      { walletCapPerMille: 0.1 },
      "LAUNCH2_WALLET_CAP_INVALID",
      "walletCapPerMille",
    ],
  ])("PUT hooks-config %j → 422 %s", async (extra, reasonCode, field) => {
    const app = await createApp();
    const response = await save(app, extra);
    expect(response.statusCode).toBe(422);
    const body = response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(
      [
        "category",
        "code",
        "correlationId",
        "detailsSafe",
        "providerReferenceSafe",
        "retryable",
        "userMessageKey",
      ].sort(),
    );
    expect(body).toMatchObject({
      code: "VALIDATION_FAILED",
      detailsSafe: { reasonCode, field },
    });
  });

  it("omits the read keys while LAUNCH2_PROJECT_TERMS_EMIT is off", async () => {
    const app = await createApp();
    const saved = await save(app, { nftPriceUsd1: 300, walletCapPerMille: 8 });
    expect(saved.statusCode).toBe(200);
    const config = saved.json<{ config: Record<string, unknown> }>().config;
    expect(config).not.toHaveProperty("nftPriceUsd1");
    expect(config).not.toHaveProperty("walletCapPerMille");
    expect(config).not.toHaveProperty("maxCumulativeBuyRaw");
    // The value change itself lives in fixedEconomics (signed by configHash).
    expect(config["fixedEconomics"]).toMatchObject({
      nftPriceUsd1Raw: "300000000000000000000",
      perAddressLifetimeBuyCapRaw: "8000000000000000000000000",
      buybackOrderUsd1Raw: "300000000000000000000",
    });
  });

  it("echoes the terms on the draft read with the switch on (defaults when omitted)", async () => {
    const app = await createApp({ emit: true });
    const saved = await save(app, {});
    expect(saved.json<{ config: unknown }>().config).toMatchObject({
      nftPriceUsd1: 100,
      walletCapPerMille: 5,
      maxCumulativeBuyRaw: "5000000000000000000000000",
    });
    const read = await app.inject({
      url: `/v2/launch/projects/${projectId}/hooks-config`,
      headers: s7CommonHeaders(),
    });
    expect(read.statusCode).toBe(200);
    expect(
      read.json<{ draft: { config: unknown } }>().draft.config,
    ).toMatchObject({ nftPriceUsd1: 100, walletCapPerMille: 5 });
  });

  it("refuses non-default terms on a pre-S359 Factory (422 HOOKS_LAUNCH_TERMS_UNSUPPORTED_BY_FACTORY)", async () => {
    for (const legacy of [reader(false), reader(undefined)]) {
      const app = await createApp({ reader: legacy });
      const response = await save(app, { walletCapPerMille: 10 });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        code: "VALIDATION_FAILED",
        detailsSafe: {
          reasonCode: "HOOKS_LAUNCH_TERMS_UNSUPPORTED_BY_FACTORY",
        },
      });
      // Defaults still save on the old Factory.
      expect((await save(app, {})).statusCode).toBe(200);
    }
  });

  it("signs the S359 terms under domain v2 and records the submission with them", async () => {
    const hookDeployment = vi.fn<HooksLaunchFactoryReader["hookDeployment"]>(
      () =>
        Promise.resolve({
          deployer: "0x4444444444444444444444444444444444444444",
          initCodeHash: `0x${"ab".repeat(32)}`,
        }),
    );
    const accept = vi.fn<HooksLaunchSubmissionRepository["accept"]>(() =>
      Promise.resolve(job),
    );
    const app = await createApp({
      reader: reader(true, hookDeployment),
      submissions: {
        getOwned: () => Promise.resolve(job),
        cancelOwned: () => Promise.resolve(null),
        findReplay: () => Promise.resolve(null),
        accept,
      },
    });
    expect(
      (await save(app, { nftPriceUsd1: 300, walletCapPerMille: 8 })).statusCode,
    ).toBe(200);
    const prepared = await app.inject({
      url: `/v2/launch/projects/${projectId}/hooks-config/signing-request?walletId=${walletId}`,
      headers: s7CommonHeaders(),
    });
    expect(prepared.statusCode).toBe(200);
    const body = prepared.json<{
      request: Record<string, unknown>;
      typedData: {
        domain: Record<string, unknown>;
        types: Record<string, { name: string; type: string }[]>;
        primaryType: "LaunchRequest";
        message: Record<string, string>;
      };
      hookSalt: string;
    }>();
    expect(body.request).toMatchObject({
      nftPrice: "300000000000000000000",
      maxCumulativeBuy: "8000000000000000000000000",
    });
    expect(body.typedData.domain["version"]).toBe("2");
    expect(
      body.typedData.types["LaunchRequest"]?.slice(-3).map((f) => f.name),
    ).toEqual(["templateHash", "nftPrice", "maxCumulativeBuy"]);
    // The Hook init-code preview was asked with the terms tuple.
    expect(hookDeployment.mock.calls.at(-1)?.[0]).toMatchObject({
      nftPrice: "300000000000000000000",
      maxCumulativeBuy: "8000000000000000000000000",
    });
    const message = body.typedData.message;
    const { EIP712Domain: _domain, ...types } = body.typedData.types;
    void _domain;
    const signature = await signer.signTypedData({
      domain: body.typedData.domain,
      types,
      primaryType: "LaunchRequest",
      message: {
        ...message,
        nftSaleStart: BigInt(message["nftSaleStart"] ?? "0"),
        deadline: BigInt(message["deadline"] ?? "0"),
        nonce: BigInt(message["nonce"] ?? "0"),
        nftPrice: BigInt(message["nftPrice"] ?? "0"),
        maxCumulativeBuy: BigInt(message["maxCumulativeBuy"] ?? "0"),
      },
    });
    const payload = {
      walletId,
      request: body.request,
      hookSalt: body.hookSalt,
      signature,
    };
    const tampered = await app.inject({
      method: "POST",
      url: `/v2/launch/projects/${projectId}/hooks-deployments`,
      headers: s7CommandHeaders(),
      payload: {
        ...payload,
        request: { ...body.request, nftPrice: "100000000000000000000" },
      },
    });
    expect(tampered.statusCode).not.toBe(200);
    // A domain "1" request (no terms) is never accepted by an S359 Factory.
    const {
      nftPrice: _price,
      maxCumulativeBuy: _cap,
      ...v1Request
    } = body.request;
    void _price;
    void _cap;
    const v1Typed = body.typedData;
    const v1Signature = await signer.signTypedData({
      domain: { ...v1Typed.domain, version: "1" },
      types: {
        LaunchRequest: (v1Typed.types["LaunchRequest"] ?? []).slice(0, -2),
      },
      primaryType: "LaunchRequest",
      message: {
        ...Object.fromEntries(
          Object.entries(v1Typed.message).filter(
            ([key]) => key !== "nftPrice" && key !== "maxCumulativeBuy",
          ),
        ),
        nftSaleStart: BigInt(v1Typed.message["nftSaleStart"] ?? "0"),
        deadline: BigInt(v1Typed.message["deadline"] ?? "0"),
        nonce: BigInt(v1Typed.message["nonce"] ?? "0"),
      },
    });
    const v1 = await app.inject({
      method: "POST",
      url: `/v2/launch/projects/${projectId}/hooks-deployments`,
      headers: s7CommandHeaders(),
      payload: { ...payload, request: v1Request, signature: v1Signature },
    });
    expect(v1.statusCode).toBe(409);
    expect(accept).not.toHaveBeenCalled();
    const response = await app.inject({
      method: "POST",
      url: `/v2/launch/projects/${projectId}/hooks-deployments`,
      headers: s7CommandHeaders(),
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(accept.mock.calls[0]?.[0].request).toMatchObject({
      nftPrice: "300000000000000000000",
      maxCumulativeBuy: "8000000000000000000000000",
    });
  });
});
