import { describe, expect, it, vi } from "vitest";

import {
  PerpWalletBindingRepositoryUnavailableError,
  PerpWalletBindingRepositoryVersionConflictError,
  type PerpWalletBindingRecord,
  type PerpWalletBindingRepository,
} from "../src/database/perp-wallet-binding-repository.js";
import {
  createPerpWalletBindingService,
  InvalidPerpWalletBindingRequestError,
  PerpWalletBindingSelectionRequiredError,
  PerpWalletBindingUnavailableError,
  PerpWalletBindingVersionConflictError,
} from "../src/features/perp/wallet-binding-service.js";
import type { PrivyUserReader } from "../src/integrations/privy/user-reader.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const privyUserId = "did:privy:wallet-binding-user";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const addressA = "0x1111111111111111111111111111111111111111";
const addressB = "0x2222222222222222222222222222222222222222";

const servicePrincipal = Object.freeze({
  userId: ownerUserId,
  privyUserId,
  streamUserId,
});

function wallet(
  address = addressA,
  id: string | null = "wallet-a",
): Record<string, unknown> {
  return {
    type: "wallet",
    chain_type: "ethereum",
    wallet_client_type: "privy",
    connector_type: "embedded",
    id,
    address,
    wallet_index: 99,
  };
}

function user(linkedAccounts: readonly unknown[]): unknown {
  return { id: privyUserId, linked_accounts: linkedAccounts };
}

function boundRecord(
  overrides: Partial<PerpWalletBindingRecord> = {},
): PerpWalletBindingRecord {
  return Object.freeze({
    ownerUserId,
    privyUserId,
    state: "bound",
    walletId: "wallet-a",
    accountAddress: addressA,
    accountKind: "master",
    bindingVersion: "1",
    lastVerifiedAt: "2026-08-25T04:00:00.000Z",
    createdAt: "2026-08-25T04:00:00.000Z",
    updatedAt: "2026-08-25T04:00:00.000Z",
    ...overrides,
  });
}

function unboundRecord(version = "2"): PerpWalletBindingRecord {
  return boundRecord({
    state: "unbound",
    walletId: null,
    accountAddress: null,
    accountKind: null,
    bindingVersion: version,
    lastVerifiedAt: null,
  });
}

function dependencies(input?: {
  readonly stored?: PerpWalletBindingRecord | null;
  readonly linkedAccounts?: readonly unknown[];
}) {
  const stored = input?.stored ?? null;
  const linkedAccounts = input?.linkedAccounts ?? [wallet()];
  const get = vi.fn<PerpWalletBindingRepository["get"]>(() =>
    Promise.resolve(stored),
  );
  const putVerifiedBinding = vi.fn<
    PerpWalletBindingRepository["putVerifiedBinding"]
  >((put) =>
    Promise.resolve(
      boundRecord({
        walletId: put.walletId,
        accountAddress: put.accountAddress,
        bindingVersion:
          stored?.state === "bound" &&
          stored.accountAddress === put.accountAddress &&
          stored.walletId === put.walletId
            ? stored.bindingVersion
            : String(BigInt(stored?.bindingVersion ?? "0") + 1n),
      }),
    ),
  );
  const unbind = vi.fn<PerpWalletBindingRepository["unbind"]>(() =>
    Promise.resolve(stored === null ? null : unboundRecord("2")),
  );
  const readCurrentUser = vi.fn<PrivyUserReader["readCurrentUser"]>(() =>
    Promise.resolve(user(linkedAccounts)),
  );
  return {
    get,
    putVerifiedBinding,
    readCurrentUser,
    repository: {
      get,
      putVerifiedBinding,
      unbind,
    } satisfies PerpWalletBindingRepository,
    unbind,
    userReader: { readCurrentUser } satisfies PrivyUserReader,
  };
}

function service(input = dependencies()) {
  return {
    ...input,
    service: createPerpWalletBindingService({
      repository: input.repository,
      userReader: input.userReader,
      createRequestId: () => "2d91e23f-249d-4db7-a2d5-c46d2f69d6f1",
    }),
  };
}

describe("Perp wallet-binding service", () => {
  it("returns the non-writing unbound version-0 default", async () => {
    const input = service();

    await expect(
      input.service.get({ principal: servicePrincipal }),
    ).resolves.toEqual({
      state: "unbound",
      binding_version: "0",
      account_kind: null,
      last_verified_at: null,
    });
    expect(input.get).toHaveBeenCalledWith({ ownerUserId, privyUserId });
    expect(input.readCurrentUser).not.toHaveBeenCalled();
    expect(input.putVerifiedBinding).not.toHaveBeenCalled();
  });

  it("binds the one eligible current wallet without client authority", async () => {
    const input = service(
      dependencies({
        linkedAccounts: [wallet(`0x${addressA.slice(2).toUpperCase()}`, null)],
      }),
    );
    const signal = new AbortController().signal;

    await expect(
      input.service.put({
        principal: servicePrincipal,
        body: { expected_binding_version: "0" },
        signal,
      }),
    ).resolves.toEqual({
      state: "bound",
      binding_version: "1",
      account_kind: "master",
      last_verified_at: "2026-08-25T04:00:00.000Z",
    });
    expect(input.readCurrentUser).toHaveBeenCalledWith({ privyUserId, signal });
    expect(input.putVerifiedBinding).toHaveBeenCalledWith({
      ownerUserId,
      privyUserId,
      expectedBindingVersion: "0",
      requestId: "2d91e23f-249d-4db7-a2d5-c46d2f69d6f1",
      walletId: null,
      accountAddress: addressA,
      accountKind: "master",
    });
    expect(
      JSON.stringify(await input.service.get({ principal: servicePrincipal })),
    ).not.toContain(addressA);
  });

  it("refreshes an exact stored wallet even when another candidate exists", async () => {
    const stored = boundRecord();
    const input = service(
      dependencies({
        stored,
        linkedAccounts: [wallet(addressB, "wallet-b"), wallet()],
      }),
    );

    await expect(
      input.service.put({
        principal: servicePrincipal,
        body: { expected_binding_version: "1" },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ binding_version: "1" });
    expect(input.putVerifiedBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: "wallet-a",
        accountAddress: addressA,
      }),
    );
  });

  it("rotates only when the removed selection leaves one candidate", async () => {
    const input = service(
      dependencies({
        stored: boundRecord(),
        linkedAccounts: [wallet(addressB, "wallet-b")],
      }),
    );

    await expect(
      input.service.put({
        principal: servicePrincipal,
        body: { expected_binding_version: "1" },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ binding_version: "2" });
    expect(input.putVerifiedBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: "wallet-b",
        accountAddress: addressB,
      }),
    );
  });

  it.each([
    ["no eligible wallets", []],
    [
      "multiple eligible wallets",
      [wallet(addressA, "wallet-a"), wallet(addressB, "wallet-b")],
    ],
  ] as const)(
    "requires explicit future selection for %s",
    async (_name, linkedAccounts) => {
      const input = service(dependencies({ linkedAccounts }));

      await expect(
        input.service.put({
          principal: servicePrincipal,
          body: { expected_binding_version: "0" },
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(PerpWalletBindingSelectionRequiredError);
      expect(input.putVerifiedBinding).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "cross-user envelope",
      { id: "did:privy:other", linked_accounts: [wallet()] },
    ],
    ["malformed linked account", { id: privyUserId, linked_accounts: [null] }],
    ["zero address", user([wallet(`0x${"0".repeat(40)}`)])],
    ["duplicate address", user([wallet(), wallet(addressA, "wallet-b")])],
    ["malformed eligible wallet", user([{ ...wallet(), id: " bad" }])],
  ] as const)("fails closed on %s", async (_name, rawUser) => {
    const input = dependencies();
    input.readCurrentUser.mockResolvedValueOnce(rawUser);
    const created = service(input);

    await expect(
      created.service.put({
        principal: servicePrincipal,
        body: { expected_binding_version: "0" },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(PerpWalletBindingUnavailableError);
    expect(input.putVerifiedBinding).not.toHaveBeenCalled();
  });

  it("preserves an outer abort instead of relabeling it unavailable", async () => {
    const input = dependencies();
    const controller = new AbortController();
    const abortError = new Error("outer abort");
    input.readCurrentUser.mockImplementationOnce(() => {
      controller.abort(abortError);
      return Promise.reject(abortError);
    });
    const created = service(input);

    await expect(
      created.service.put({
        principal: servicePrincipal,
        body: { expected_binding_version: "0" },
        signal: controller.signal,
      }),
    ).rejects.toBe(abortError);
  });

  it("unbinds without a provider lookup and retains the epoch", async () => {
    const input = service(dependencies({ stored: boundRecord() }));

    await expect(
      input.service.delete({
        principal: servicePrincipal,
        expectedBindingVersion: "1",
      }),
    ).resolves.toEqual({
      state: "unbound",
      binding_version: "2",
      account_kind: null,
      last_verified_at: null,
    });
    expect(input.unbind).toHaveBeenCalledWith({
      ownerUserId,
      privyUserId,
      expectedBindingVersion: "1",
      requestId: "2d91e23f-249d-4db7-a2d5-c46d2f69d6f1",
    });
    expect(input.readCurrentUser).not.toHaveBeenCalled();
  });

  it.each([
    [
      new PerpWalletBindingRepositoryVersionConflictError(),
      PerpWalletBindingVersionConflictError,
    ],
    [
      new PerpWalletBindingRepositoryUnavailableError(),
      PerpWalletBindingUnavailableError,
    ],
    [new Error("raw database failure"), PerpWalletBindingUnavailableError],
  ] as const)("classifies repository failure %s", async (error, expected) => {
    const input = dependencies();
    input.get.mockRejectedValueOnce(error);

    await expect(
      service(input).service.get({ principal: servicePrincipal }),
    ).rejects.toBeInstanceOf(expected);
  });

  it.each([
    {},
    { expected_binding_version: 0 },
    { expected_binding_version: "01" },
    { expected_binding_version: "9223372036854775808" },
    { expected_binding_version: "0", address: addressA },
  ])("rejects invalid/client-authority mutation body %#", async (body) => {
    const input = service();
    await expect(
      input.service.put({
        principal: servicePrincipal,
        body,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(InvalidPerpWalletBindingRequestError);
    expect(input.readCurrentUser).not.toHaveBeenCalled();
  });

  it("rejects a repository record from another owner", async () => {
    const input = service(
      dependencies({
        stored: boundRecord({
          ownerUserId: "8db9f6f4-2d17-4e5c-a40f-41fedab69dcb",
        }),
      }),
    );
    await expect(
      input.service.get({ principal: servicePrincipal }),
    ).rejects.toBeInstanceOf(PerpWalletBindingUnavailableError);
  });
});
