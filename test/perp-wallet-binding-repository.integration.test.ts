import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PerpWalletBindingRepositoryUnavailableError,
  PerpWalletBindingRepositoryVersionConflictError,
  createPostgresPerpWalletBindingRepository,
  type PerpWalletBindingRepository,
  type PutVerifiedPerpWalletBindingInput,
} from "../src/database/perp-wallet-binding-repository.js";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

const fixturePrivyPrefix = "did:privy:wallet-binding-test:";
const addressA = `0x${"1".repeat(40)}`;
const addressB = `0x${"2".repeat(40)}`;
const addressC = `0x${"3".repeat(40)}`;

interface OwnerFixture {
  readonly ownerUserId: string;
  readonly privyUserId: string;
}

function bindingInput(
  owner: OwnerFixture,
  overrides: Partial<PutVerifiedPerpWalletBindingInput> = {},
): PutVerifiedPerpWalletBindingInput {
  return {
    ownerUserId: owner.ownerUserId,
    privyUserId: owner.privyUserId,
    expectedBindingVersion: "0",
    requestId: randomUUID(),
    walletId: "wallet-a",
    accountAddress: addressA,
    accountKind: "master",
    ...overrides,
  };
}

describe("PostgreSQL Perp wallet-binding repository", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let repository: PerpWalletBindingRepository;

  async function cleanFixtures(): Promise<void> {
    await pool.query(`
      truncate table
        public.perp_wallet_binding_events,
        public.perp_wallet_bindings
    `);
    await pool.query({
      text: `
        delete from public.loop_users
        where privy_user_id like $1
      `,
      values: [`${fixturePrivyPrefix}%`],
    });
  }

  async function createOwner(label: string): Promise<OwnerFixture> {
    const privyUserId = `${fixturePrivyPrefix}${label}:${randomUUID()}`;
    const inserted = await pool.query<{ id: string }>({
      text: `
        insert into public.loop_users (privy_user_id)
        values ($1)
        returning id
      `,
      values: [privyUserId],
    });
    const ownerUserId = inserted.rows[0]?.id;
    if (ownerUserId === undefined) {
      throw new Error("Wallet-binding integration owner setup failed");
    }
    return { ownerUserId, privyUserId };
  }

  beforeAll(() => {
    repository = createPostgresPerpWalletBindingRepository(pool);
  });

  beforeEach(cleanFixtures);

  afterAll(async () => {
    await cleanFixtures();
    await pool.end();
  });

  it("returns an absent unbound default without creating a row", async () => {
    const owner = await createOwner("absent");

    await expect(repository.get(owner)).resolves.toBeNull();
    const count = await pool.query<{ count: string }>({
      text: `
        select count(*)::text as count
        from public.perp_wallet_bindings
        where owner_user_id = $1
      `,
      values: [owner.ownerUserId],
    });
    expect(count.rows[0]?.count).toBe("0");
  });

  it("binds, refreshes, rotates, unbinds, and rebinds with one monotonic epoch", async () => {
    const owner = await createOwner("lifecycle");

    const bound = await repository.putVerifiedBinding(
      bindingInput(owner, { walletId: null }),
    );
    expect(bound).toMatchObject({
      ownerUserId: owner.ownerUserId,
      privyUserId: owner.privyUserId,
      state: "bound",
      walletId: null,
      accountAddress: addressA,
      accountKind: "master",
      bindingVersion: "1",
    });
    expect(bound.lastVerifiedAt).toEqual(expect.any(String));

    const refreshed = await repository.putVerifiedBinding(
      bindingInput(owner, {
        expectedBindingVersion: "1",
        walletId: null,
        accountAddress: addressA,
      }),
    );
    expect(refreshed.bindingVersion).toBe("1");
    expect(Date.parse(refreshed.lastVerifiedAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(bound.lastVerifiedAt ?? ""),
    );

    const rotated = await repository.putVerifiedBinding(
      bindingInput(owner, {
        expectedBindingVersion: "1",
        walletId: "wallet-b",
        accountAddress: addressB,
      }),
    );
    expect(rotated).toMatchObject({
      state: "bound",
      walletId: "wallet-b",
      accountAddress: addressB,
      bindingVersion: "2",
    });

    const unbound = await repository.unbind({
      ...owner,
      expectedBindingVersion: "2",
      requestId: randomUUID(),
    });
    expect(unbound).toMatchObject({
      state: "unbound",
      walletId: null,
      accountAddress: null,
      accountKind: null,
      bindingVersion: "3",
      lastVerifiedAt: null,
    });

    const rebound = await repository.putVerifiedBinding(
      bindingInput(owner, {
        expectedBindingVersion: "3",
        walletId: "wallet-c",
        accountAddress: addressC,
      }),
    );
    expect(rebound).toMatchObject({
      state: "bound",
      walletId: "wallet-c",
      accountAddress: addressC,
      bindingVersion: "4",
    });
    await expect(repository.get(owner)).resolves.toEqual(rebound);

    const events = await pool.query<{
      action: string;
      from_version: string;
      to_version: string;
    }>({
      text: `
        select
          action,
          from_version::text as from_version,
          to_version::text as to_version
        from public.perp_wallet_binding_events
        where owner_user_id = $1
        order by occurred_at, id
      `,
      values: [owner.ownerUserId],
    });
    expect(events.rows).toEqual([
      { action: "bind", from_version: "0", to_version: "1" },
      { action: "refresh", from_version: "1", to_version: "1" },
      { action: "rotate", from_version: "1", to_version: "2" },
      { action: "unbind", from_version: "2", to_version: "3" },
      { action: "bind", from_version: "3", to_version: "4" },
    ]);
  });

  it("replays an identical request but rejects request-ID reuse or stale different authority", async () => {
    const owner = await createOwner("replay");
    const requestId = randomUUID();
    const initialInput = bindingInput(owner, { requestId });

    const created = await repository.putVerifiedBinding(initialInput);
    await expect(repository.putVerifiedBinding(initialInput)).resolves.toEqual(
      created,
    );
    await expect(
      repository.putVerifiedBinding(
        bindingInput(owner, {
          requestId,
          accountAddress: addressB,
          walletId: "wallet-b",
        }),
      ),
    ).rejects.toBeInstanceOf(PerpWalletBindingRepositoryVersionConflictError);
    await expect(
      repository.putVerifiedBinding(
        bindingInput(owner, {
          expectedBindingVersion: "0",
          accountAddress: addressB,
          walletId: "wallet-b",
        }),
      ),
    ).rejects.toBeInstanceOf(PerpWalletBindingRepositoryVersionConflictError);
    await expect(
      repository.putVerifiedBinding(
        bindingInput(owner, {
          expectedBindingVersion: "7",
        }),
      ),
    ).rejects.toBeInstanceOf(PerpWalletBindingRepositoryVersionConflictError);
    await expect(
      repository.putVerifiedBinding(
        bindingInput(owner, {
          expectedBindingVersion: "0",
        }),
      ),
    ).resolves.toEqual(created);

    const unbindRequestId = randomUUID();
    const unbound = await repository.unbind({
      ...owner,
      expectedBindingVersion: "1",
      requestId: unbindRequestId,
    });
    await expect(
      repository.unbind({
        ...owner,
        expectedBindingVersion: "1",
        requestId: unbindRequestId,
      }),
    ).resolves.toEqual(unbound);
    await expect(
      repository.unbind({
        ...owner,
        expectedBindingVersion: "0",
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(PerpWalletBindingRepositoryVersionConflictError);
    await expect(
      repository.unbind({
        ...owner,
        expectedBindingVersion: "2",
        requestId: randomUUID(),
      }),
    ).resolves.toEqual(unbound);
    expect(await repository.get(owner)).toEqual(unbound);
  });

  it("serializes divergent first binds so exactly one expected-version target wins", async () => {
    const owner = await createOwner("concurrency");

    const results = await Promise.allSettled([
      repository.putVerifiedBinding(
        bindingInput(owner, {
          walletId: "wallet-a",
          accountAddress: addressA,
        }),
      ),
      repository.putVerifiedBinding(
        bindingInput(owner, {
          walletId: "wallet-b",
          accountAddress: addressB,
        }),
      ),
    ]);
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<PerpWalletBindingRepository["putVerifiedBinding"]>>
      > => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.bindingVersion).toBe("1");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(
      PerpWalletBindingRepositoryVersionConflictError,
    );
    await expect(repository.get(owner)).resolves.toEqual(fulfilled[0]?.value);
  });

  it("enforces active wallet ID and address uniqueness across owners only", async () => {
    const ownerA = await createOwner("unique-a");
    const ownerB = await createOwner("unique-b");
    const ownerC = await createOwner("unique-c");

    await repository.putVerifiedBinding(bindingInput(ownerA));
    await expect(
      repository.putVerifiedBinding(
        bindingInput(ownerB, {
          walletId: "wallet-b",
          accountAddress: addressA,
        }),
      ),
    ).rejects.toBeInstanceOf(PerpWalletBindingRepositoryUnavailableError);
    await expect(
      repository.putVerifiedBinding(
        bindingInput(ownerC, {
          walletId: "wallet-a",
          accountAddress: addressC,
        }),
      ),
    ).rejects.toBeInstanceOf(PerpWalletBindingRepositoryUnavailableError);

    await repository.unbind({
      ...ownerA,
      expectedBindingVersion: "1",
      requestId: randomUUID(),
    });
    await expect(
      repository.putVerifiedBinding(bindingInput(ownerB)),
    ).resolves.toMatchObject({
      ownerUserId: ownerB.ownerUserId,
      bindingVersion: "1",
      state: "bound",
    });
  });

  it("fails closed on owner identity mismatch and malformed authority", async () => {
    const owner = await createOwner("identity");

    await expect(
      repository.get({
        ownerUserId: owner.ownerUserId,
        privyUserId: `${owner.privyUserId}:wrong`,
      }),
    ).rejects.toBeInstanceOf(PerpWalletBindingRepositoryUnavailableError);
    await expect(
      repository.putVerifiedBinding(
        bindingInput(owner, {
          accountAddress: `0x${"0".repeat(40)}`,
        }),
      ),
    ).rejects.toBeInstanceOf(PerpWalletBindingRepositoryUnavailableError);
    await expect(repository.get(owner)).resolves.toBeNull();
  });

  it("enforces monotonic rows and immutable authority-free lifecycle events in PostgreSQL", async () => {
    const owner = await createOwner("database-guards");
    await repository.putVerifiedBinding(bindingInput(owner));

    await expect(
      pool.query({
        text: `
          update public.perp_wallet_bindings
          set binding_version = binding_version + 2
          where owner_user_id = $1
        `,
        values: [owner.ownerUserId],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query({
        text: `
          update public.perp_wallet_binding_events
          set action = 'refresh'
          where owner_user_id = $1
        `,
        values: [owner.ownerUserId],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query({
        text: `
          delete from public.perp_wallet_binding_events
          where owner_user_id = $1
        `,
        values: [owner.ownerUserId],
      }),
    ).rejects.toMatchObject({ code: "55000" });

    const columns = await pool.query<{ column_name: string }>({
      text: `
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'perp_wallet_binding_events'
        order by ordinal_position
      `,
    });
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "id",
      "owner_user_id",
      "request_id",
      "action",
      "from_version",
      "to_version",
      "occurred_at",
    ]);
  });
});
