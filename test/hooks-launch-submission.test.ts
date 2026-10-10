import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  createHooksLaunchDeploymentService,
  type HooksLaunchFactoryReader,
} from "../src/features/launch/hooks-launch-deployment.js";
import {
  createHooksLaunchSubmissionService,
  type HooksLaunchSubmissionRepository,
  type AcceptHooksLaunchSubmission,
  type HooksLaunchDeploymentJob,
} from "../src/features/launch/hooks-launch-submission.js";
import type { AccountWalletRepository } from "../src/database/account-wallet-repository.js";
import type { HooksLaunchProjectConfigRepository } from "../src/features/launch/hooks-launch-project-config.js";

const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
const now = 1_800_000_000;
const projectId = "00000000-0000-4000-8000-000000000001";
const draft = {
  projectId,
  ownerUserId: "owner",
  version: 1,
  config: {
    name: "Project",
    ticker: "MEME",
    configHash: `0x${"cd".repeat(32)}`,
    nftSaleStartAt: String(now + 86400),
    buybackRecipient: "0x3333333333333333333333333333333333333333",
    fixedEconomics: { nftSaleDurationSeconds: 604_800 },
  },
};
const configs = {
  getOwnedDraft: () => Promise.resolve(draft),
} as unknown as HooksLaunchProjectConfigRepository;
const wallets = {
  get: () =>
    Promise.resolve({
      address: account.address,
      status: "active",
      isActive: true,
    }),
} as unknown as AccountWalletRepository;
const reader: HooksLaunchFactoryReader = {
  chainId: 97,
  factoryAddress: "0x1111111111111111111111111111111111111111",
  nonce: () => Promise.resolve(7n),
  nftSaleDuration: () => Promise.resolve({ seconds: 604_800, legacy: false }),
  tokenDeployment: () =>
    Promise.resolve({
      deployer: "0x5555555555555555555555555555555555555555",
      initCodeHash: `0x${"ef".repeat(32)}`,
    }),
  hookDeployment: () =>
    Promise.resolve({
      deployer: "0x4444444444444444444444444444444444444444",
      initCodeHash: `0x${"ab".repeat(32)}`,
    }),
};
let preparedPromise:
  | Promise<
      Awaited<
        ReturnType<
          ReturnType<
            typeof createHooksLaunchDeploymentService
          >["prepareSigningRequest"]
        >
      >
    >
  | undefined;
async function payload() {
  preparedPromise ??= createHooksLaunchDeploymentService({
    configs,
    wallets,
    reader,
    now: () => now,
    signatureLifetimeSeconds: 900,
    maxSaltAttempts: 1_000_000,
  }).prepareSigningRequest({
    ownerUserId: "owner",
    projectId,
    walletId: "wallet",
  });
  const prepared = await preparedPromise;
  const message = prepared.typedData.message;
  const signature = await account.signTypedData({
    ...prepared.typedData,
    message: {
      ...message,
      nftSaleStart: BigInt(message.nftSaleStart),
      deadline: BigInt(message.deadline),
      nonce: BigInt(message.nonce),
    },
  });
  return {
    walletId: "wallet",
    request: prepared.request,
    hookSalt: prepared.hookSalt,
    signature,
  };
}
function fixture(
  overrides: Partial<
    Parameters<typeof createHooksLaunchSubmissionService>[0]
  > = {},
) {
  const save = vi.fn(
    (input: AcceptHooksLaunchSubmission): Promise<HooksLaunchDeploymentJob> =>
      Promise.resolve({
        jobId: "00000000-0000-4000-8000-000000000002",
        projectId: input.projectId,
        configVersion: input.request.configVersion,
        chainId: 97,
        factoryAddress: input.factoryAddress,
        status: "awaiting_executor",
        memeAddress: input.memeAddress,
        hookAddress: input.hookAddress,
        txHash: null,
        confirmations: null,
        activationTxHash: null,
        addresses: {
          predicted: { meme: input.memeAddress, hook: input.hookAddress },
          deployed: null,
        },
        failure: null,
        attemptCount: 0,
        events: [],
        createdAt: "2026-10-09T00:00:00.000Z",
        updatedAt: "2026-10-09T00:00:00.000Z",
      }),
  );
  const repository = {
    findReplay: vi.fn(() => Promise.resolve(null)),
    accept: save,
  } as unknown as HooksLaunchSubmissionRepository;
  return {
    save,
    repository,
    service: createHooksLaunchSubmissionService({
      configs,
      wallets,
      reader,
      repository,
      now: () => now,
      ...overrides,
    }),
  };
}
const command = {
  ownerUserId: "owner",
  projectId,
  idempotencyKey: "00000000-0000-4000-8000-000000000003",
};
describe("Hooks signed deployment submission", { timeout: 60_000 }, () => {
  it("verifies the exact project signature and records an awaiting-executor task", async () => {
    const { service, save } = fixture();
    const result = await service.submit({ ...command, body: await payload() });
    expect(result.status).toBe("awaiting_executor");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({
      factoryAddress: reader.factoryAddress,
      ownerUserId: "owner",
      request: { nonce: "7" },
    });
  });
  it("rejects tampered signed fields without saving", async () => {
    const { service, save } = fixture();
    const body = await payload();
    await expect(
      service.submit({
        ...command,
        body: {
          ...body,
          request: { ...body.request, buybackRecipient: account.address },
        },
      }),
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
  it("rejects expired signatures and stale chain nonces", async () => {
    const body = await payload();
    const expired = fixture({ now: () => now + 901 });
    await expect(
      expired.service.submit({ ...command, body }),
    ).rejects.toThrow();
    expect(expired.save).not.toHaveBeenCalled();
    const stale = fixture({
      reader: { ...reader, nonce: () => Promise.resolve(8n) },
    });
    await expect(stale.service.submit({ ...command, body })).rejects.toThrow();
    expect(stale.save).not.toHaveBeenCalled();
  });
  it("rejects foreign wallets and wrong Hook permission salts", async () => {
    const body = await payload();
    const foreign = fixture({
      wallets: {
        get: () => Promise.resolve(null),
      } as unknown as AccountWalletRepository,
    });
    await expect(
      foreign.service.submit({ ...command, body }),
    ).rejects.toThrow();
    const invalidHook = fixture();
    await expect(
      invalidHook.service.submit({
        ...command,
        body: { ...body, hookSalt: `0x${"00".repeat(32)}` },
      }),
    ).rejects.toThrow();
    expect(invalidHook.save).not.toHaveBeenCalled();
  });
  it("returns a durable exact replay even after the original signature expires", async () => {
    const body = await payload();
    const initial = fixture();
    const job = await initial.service.submit({ ...command, body });
    const saved = initial.save.mock.calls[0]![0];
    const replay = fixture({
      now: () => now + 3600,
      repository: {
        findReplay: () =>
          Promise.resolve({ fingerprint: saved.fingerprint, job }),
        accept: initial.save,
      } as unknown as HooksLaunchSubmissionRepository,
    });
    expect(await replay.service.submit({ ...command, body })).toEqual(job);
    expect(initial.save).toHaveBeenCalledTimes(1);
  });
  it("rejects a valid signature from a different private key", async () => {
    const body = await payload();
    const prepared = await preparedPromise!;
    const message = prepared.typedData.message;
    const other = privateKeyToAccount(`0x${"02".repeat(32)}`);
    body.signature = await other.signTypedData({
      ...prepared.typedData,
      message: {
        ...message,
        nftSaleStart: BigInt(message.nftSaleStart),
        deadline: BigInt(message.deadline),
        nonce: BigInt(message.nonce),
      },
    });
    const { service, save } = fixture();
    await expect(service.submit({ ...command, body })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
  it("does not fall back to another chain", async () => {
    const { service, save } = fixture({ reader: { ...reader, chainId: 56 } });
    await expect(
      service.submit({ ...command, body: await payload() }),
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
  it("refuses a config hashed for another Factory sale period (Decision 0119)", async () => {
    const { service, save } = fixture({
      reader: {
        ...reader,
        nftSaleDuration: () =>
          Promise.resolve({ seconds: 3_600, legacy: false }),
      },
    });
    await expect(
      service.submit({ ...command, body: await payload() }),
    ).rejects.toMatchObject({ kind: "template_mismatch" });
    expect(save).not.toHaveBeenCalled();
  });
});
