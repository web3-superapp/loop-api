import { describe, expect, it, vi } from "vitest";

import type {
  PerpWalletBindingRecord,
  PerpWalletBindingRepository,
} from "../src/database/perp-wallet-binding-repository.js";
import {
  createPerpWalletBindingResolver,
  WalletBindingRequiredError,
  WalletBindingResolutionUnavailableError,
} from "../src/features/perp/wallet-binding-resolver.js";
import type { PrivyUserReader } from "../src/integrations/privy/user-reader.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const privyUserId = "did:privy:resolver-user";
const address = "0x1111111111111111111111111111111111111111";

function record(
  overrides: Partial<PerpWalletBindingRecord> = {},
): PerpWalletBindingRecord {
  return Object.freeze({
    ownerUserId,
    privyUserId,
    state: "bound",
    walletId: "wallet-a",
    accountAddress: address,
    accountKind: "master",
    bindingVersion: "9223372036854775807",
    lastVerifiedAt: "2026-08-25T04:00:00.000Z",
    createdAt: "2026-08-25T04:00:00.000Z",
    updatedAt: "2026-08-25T04:00:00.000Z",
    ...overrides,
  });
}

function rawWallet(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "wallet",
    chain_type: "ethereum",
    wallet_client_type: "privy",
    connector_type: "embedded",
    id: "wallet-a",
    address,
    ...overrides,
  };
}

function dependencies(stored: PerpWalletBindingRecord | null = record()) {
  const get = vi.fn<PerpWalletBindingRepository["get"]>(() =>
    Promise.resolve(stored),
  );
  const readCurrentUser = vi.fn<PrivyUserReader["readCurrentUser"]>(() =>
    Promise.resolve({ id: privyUserId, linked_accounts: [rawWallet()] }),
  );
  const repository = {
    get,
    putVerifiedBinding:
      vi.fn<PerpWalletBindingRepository["putVerifiedBinding"]>(),
    unbind: vi.fn<PerpWalletBindingRepository["unbind"]>(),
  } satisfies PerpWalletBindingRepository;
  return {
    get,
    readCurrentUser,
    repository,
    userReader: { readCurrentUser } satisfies PrivyUserReader,
  };
}

function resolveInput(signal = new AbortController().signal) {
  return { ownerUserId, privyUserId, signal };
}

describe("Perp wallet-binding resolver", () => {
  it("returns a fresh 15-second master lease for the exact stored wallet", async () => {
    const input = dependencies();
    const resolver = createPerpWalletBindingResolver({
      repository: input.repository,
      userReader: input.userReader,
      now: () => Date.parse("2026-08-25T05:00:00.000Z"),
    });

    await expect(resolver.resolve(resolveInput())).resolves.toEqual({
      ownerUserId,
      privyUserId,
      accountAddress: address,
      accountKind: "master",
      bindingVersion: "9223372036854775807",
      verifiedAt: "2026-08-25T05:00:00.000Z",
      expiresAt: "2026-08-25T05:00:15.000Z",
    });
    expect(input.get).toHaveBeenCalledWith({ ownerUserId, privyUserId });
    expect(input.readCurrentUser).toHaveBeenCalledWith(
      expect.objectContaining({ privyUserId }),
    );
  });

  it("exposes the stored wallet ID only through the neutral authority channel", async () => {
    const input = dependencies();
    const resolver = createPerpWalletBindingResolver({
      repository: input.repository,
      userReader: input.userReader,
      now: () => Date.parse("2026-08-25T05:00:00.000Z"),
    });

    const legacy = await resolver.resolve(resolveInput());
    expect(legacy).toEqual({
      ownerUserId,
      privyUserId,
      accountAddress: address,
      accountKind: "master",
      bindingVersion: "9223372036854775807",
      verifiedAt: "2026-08-25T05:00:00.000Z",
      expiresAt: "2026-08-25T05:00:15.000Z",
    });
    expect(legacy).not.toHaveProperty("walletId");

    await expect(resolver.resolveAuthority(resolveInput())).resolves.toEqual({
      ownerUserId,
      privyUserId,
      walletId: "wallet-a",
      accountAddress: address,
      accountKind: "master",
      bindingVersion: "9223372036854775807",
      verifiedAt: "2026-08-25T05:00:00.000Z",
      expiresAt: "2026-08-25T05:00:15.000Z",
    });
  });

  it("matches a nullable stored wallet ID by user-scoped address", async () => {
    const input = dependencies(record({ walletId: null }));
    input.readCurrentUser.mockResolvedValueOnce({
      id: privyUserId,
      linked_accounts: [rawWallet({ id: "new-provider-id" })],
    });

    await expect(
      createPerpWalletBindingResolver({
        repository: input.repository,
        userReader: input.userReader,
      }).resolve(resolveInput()),
    ).resolves.toMatchObject({ accountAddress: address });

    await expect(
      createPerpWalletBindingResolver({
        repository: input.repository,
        userReader: input.userReader,
      }).resolveAuthority(resolveInput()),
    ).resolves.toMatchObject({
      walletId: null,
      accountAddress: address,
    });
  });

  it.each([
    ["missing row", null],
    [
      "unbound row",
      record({
        state: "unbound",
        walletId: null,
        accountAddress: null,
        accountKind: null,
        lastVerifiedAt: null,
      }),
    ],
  ] as const)(
    "requires binding for %s without a provider call",
    async (_name, stored) => {
      const input = dependencies(stored);
      await expect(
        createPerpWalletBindingResolver({
          repository: input.repository,
          userReader: input.userReader,
        }).resolve(resolveInput()),
      ).rejects.toBeInstanceOf(WalletBindingRequiredError);
      expect(input.readCurrentUser).not.toHaveBeenCalled();
    },
  );

  it("treats authoritative unlink as binding required", async () => {
    const input = dependencies();
    input.readCurrentUser.mockResolvedValueOnce({
      id: privyUserId,
      linked_accounts: [],
    });

    await expect(
      createPerpWalletBindingResolver({
        repository: input.repository,
        userReader: input.userReader,
      }).resolve(resolveInput()),
    ).rejects.toBeInstanceOf(WalletBindingRequiredError);
  });

  it.each([
    ["provider failure", new Error("synthetic provider failure")],
    ["database failure", new Error("synthetic database failure")],
  ] as const)("maps %s to resolution unavailable", async (kind, error) => {
    const input = dependencies();
    if (kind === "provider failure") {
      input.readCurrentUser.mockRejectedValueOnce(error);
    } else {
      input.get.mockRejectedValueOnce(error);
    }

    await expect(
      createPerpWalletBindingResolver({
        repository: input.repository,
        userReader: input.userReader,
      }).resolve(resolveInput()),
    ).rejects.toBeInstanceOf(WalletBindingResolutionUnavailableError);
  });

  it.each([
    [
      "cross-user response",
      { id: "did:privy:other", linked_accounts: [rawWallet()] },
    ],
    ["malformed response", { id: privyUserId, linked_accounts: [null] }],
    [
      "duplicate exact wallet",
      {
        id: privyUserId,
        linked_accounts: [rawWallet(), rawWallet({ id: "wallet-b" })],
      },
    ],
  ] as const)("fails unavailable for %s", async (_name, user) => {
    const input = dependencies();
    input.readCurrentUser.mockResolvedValueOnce(user);

    await expect(
      createPerpWalletBindingResolver({
        repository: input.repository,
        userReader: input.userReader,
      }).resolve(resolveInput()),
    ).rejects.toBeInstanceOf(WalletBindingResolutionUnavailableError);
  });

  it("propagates the outer abort reason", async () => {
    const input = dependencies();
    const controller = new AbortController();
    const abortError = new Error("outer abort");
    input.readCurrentUser.mockImplementationOnce(() => {
      controller.abort(abortError);
      return Promise.reject(abortError);
    });

    await expect(
      createPerpWalletBindingResolver({
        repository: input.repository,
        userReader: input.userReader,
      }).resolve(resolveInput(controller.signal)),
    ).rejects.toBe(abortError);
  });

  it("preserves an abort that happens while the stored binding is read", async () => {
    const input = dependencies(null);
    const controller = new AbortController();
    const abortError = new Error("database wait aborted");
    input.get.mockImplementationOnce(() => {
      controller.abort(abortError);
      return Promise.resolve(null);
    });

    await expect(
      createPerpWalletBindingResolver({
        repository: input.repository,
        userReader: input.userReader,
      }).resolve(resolveInput(controller.signal)),
    ).rejects.toBe(abortError);
    expect(input.readCurrentUser).not.toHaveBeenCalled();
  });

  it("rejects an invalid lease clock", async () => {
    const input = dependencies();

    await expect(
      createPerpWalletBindingResolver({
        repository: input.repository,
        userReader: input.userReader,
        now: () => -1,
      }).resolve(resolveInput()),
    ).rejects.toBeInstanceOf(WalletBindingResolutionUnavailableError);
  });
});
