import { describe, expect, it, vi } from "vitest";

import {
  createPrivyUserReader,
  createUnavailablePrivyUserReader,
  PrivyUserLookupUnavailableError,
  type PrivyUsersLookupClient,
} from "../src/integrations/privy/user-reader.js";

describe("Privy current-user reader", () => {
  it("performs one fresh DID lookup with the outer signal and no SDK retry", async () => {
    const user = { id: "did:privy:test-user", linked_accounts: [] };
    const get = vi.fn<PrivyUsersLookupClient["_get"]>(() =>
      Promise.resolve(user),
    );
    const signal = new AbortController().signal;
    const reader = createPrivyUserReader({ _get: get });

    await expect(
      reader.readCurrentUser({ privyUserId: user.id, signal }),
    ).resolves.toBe(user);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(user.id, {
      signal,
      timeout: 4_000,
      maxRetries: 0,
    });
  });

  it("preserves SDK and abort errors for feature-layer classification", async () => {
    const controller = new AbortController();
    const error = new Error("synthetic provider failure");
    const get = vi.fn<PrivyUsersLookupClient["_get"]>(() =>
      Promise.reject(error),
    );

    await expect(
      createPrivyUserReader({ _get: get }).readCurrentUser({
        privyUserId: "did:privy:test-user",
        signal: controller.signal,
      }),
    ).rejects.toBe(error);
  });

  it("provides an explicit unavailable adapter for unconfigured Privy", async () => {
    await expect(
      createUnavailablePrivyUserReader().readCurrentUser({
        privyUserId: "did:privy:test-user",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(PrivyUserLookupUnavailableError);
  });
});
