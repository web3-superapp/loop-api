import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPostgresAccountWalletRepository,
  type AccountWalletRecord,
  type AccountWalletRepository,
  type ObservedWallet,
} from "../src/database/account-wallet-repository.js";
import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import { createPostgresPublicProfileRepository } from "../src/database/public-profile-repository.js";
import { createPostgresWalletAccountLookup } from "../src/database/wallet-account-directory-repository.js";
import { externalWalletLimit } from "../src/features/chain/chain-contract.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0185 (S306): external wallet link rules on PostgreSQL — the
 * three-wallet limit, unlink archiving, the same-address conflict, and that
 * archived rows drop out of mining inputs and public attribution.
 */

const { Pool } = pg;
const pool = new Pool({ connectionString: requireIntegrationDatabaseUrl() });
const prefix = "s306-external-wallet-test:";
const native = "eip155:56:native";

let wallets: AccountWalletRepository;

const address = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
const external = (n: number): ObservedWallet => ({
  address: address(n),
  kind: "external",
  providerWalletId: null,
});
const embedded = (n: number, owner: string): ObservedWallet => ({
  address: address(n),
  kind: "embedded",
  providerWalletId: `s306-${owner.slice(0, 8)}-${n}`,
});

async function clean(): Promise<void> {
  const owners = `select id from public.loop_users where privy_user_id like $1`;
  await pool.query({
    text: `delete from public.wallet_balance_snapshots where wallet_id in (
      select wallet_id from public.account_wallets where owner_user_id in (${owners}))`,
    values: [`${prefix}%`],
  });
  await pool.query({
    text: `delete from public.account_wallets where owner_user_id in (${owners})`,
    values: [`${prefix}%`],
  });
  await pool.query({
    text: `delete from public.loop_users where privy_user_id like $1`,
    values: [`${prefix}%`],
  });
}

async function owner(): Promise<string> {
  const result = await pool.query<{ id: string }>({
    text: `insert into public.loop_users (privy_user_id) values ($1) returning id`,
    values: [`${prefix}${randomUUID()}`],
  });
  return result.rows[0]!.id;
}

/** Spread first-seen times so "earliest" is deterministic. */
async function backdate(ownerUserId: string, n: number, iso: string) {
  await pool.query({
    text: `update public.account_wallets
           set first_seen_at = $3::timestamptz, created_at = $3::timestamptz
           where owner_user_id = $1 and address = $2`,
    values: [ownerUserId, address(n), iso],
  });
}

const byAddress = (records: readonly AccountWalletRecord[], n: number) =>
  records.find((record) => record.address === address(n));
const activeExternal = (records: readonly AccountWalletRecord[]) =>
  records
    .filter(
      (record) => record.kind === "external" && record.status === "active",
    )
    .map((record) => record.address)
    .sort();

describe("Decision 0185 external wallet link rules on PostgreSQL", () => {
  beforeAll(async () => {
    wallets = createPostgresAccountWalletRepository(pool);
    await clean();
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await pool.end();
  });

  it("keeps at most three active external wallets, earliest first; embedded wallets never count", async () => {
    expect(externalWalletLimit).toBe(3);
    const user = await owner();
    // First sync: embedded + three externals.
    await wallets.sync({
      ownerUserId: user,
      observed: [embedded(0x100, user), external(1), external(2), external(3)],
    });
    for (const [n, day] of [
      [1, "01"],
      [2, "02"],
      [3, "03"],
    ] as const) {
      await backdate(user, n, `2026-10-${day}T00:00:00Z`);
    }
    // Two more arrive at once: both are over the limit.
    const records = await wallets.sync({
      ownerUserId: user,
      observed: [
        embedded(0x100, user),
        external(1),
        external(2),
        external(3),
        external(4),
        external(5),
      ],
    });
    expect(activeExternal(records)).toEqual([
      address(1),
      address(2),
      address(3),
    ]);
    for (const n of [4, 5]) {
      expect(byAddress(records, n)).toMatchObject({
        status: "archived",
        archivedReason: "external_limit_exceeded",
        isActive: false,
      });
    }
    expect(byAddress(records, 0x100)).toMatchObject({
      kind: "embedded",
      status: "active",
      archivedReason: null,
      isActive: true,
    });
    // Idempotent: the same observation converges on the same inventory.
    const again = await wallets.sync({
      ownerUserId: user,
      observed: [
        embedded(0x100, user),
        external(1),
        external(2),
        external(3),
        external(4),
        external(5),
      ],
    });
    expect(
      again.map((record) => [
        record.address,
        record.status,
        record.archivedReason,
      ]),
    ).toEqual(
      records.map((record) => [
        record.address,
        record.status,
        record.archivedReason,
      ]),
    );
  });

  it("frees a slot on unlink, and a relinked older wallet does not evict one already counted", async () => {
    const user = await owner();
    await wallets.sync({
      ownerUserId: user,
      observed: [external(1), external(2), external(3)],
    });
    await backdate(user, 1, "2026-10-01T00:00:00Z");
    await backdate(user, 2, "2026-10-02T00:00:00Z");
    await backdate(user, 3, "2026-10-03T00:00:00Z");

    // Unlink 1 (Privy siwe.unlink), link 4 in its place.
    const swapped = await wallets.sync({
      ownerUserId: user,
      observed: [external(2), external(3), external(4)],
    });
    expect(byAddress(swapped, 1)).toMatchObject({
      status: "archived",
      archivedReason: "unlinked",
      isActive: false,
    });
    expect(activeExternal(swapped)).toEqual([
      address(2),
      address(3),
      address(4),
    ]);

    // Relink 1: it is the earliest seen, but 2 / 3 / 4 already hold the
    // slots, so 1 is the one held back.
    const relinked = await wallets.sync({
      ownerUserId: user,
      observed: [external(1), external(2), external(3), external(4)],
    });
    expect(activeExternal(relinked)).toEqual([
      address(2),
      address(3),
      address(4),
    ]);
    expect(byAddress(relinked, 1)).toMatchObject({
      status: "archived",
      archivedReason: "external_limit_exceeded",
    });

    // Unlink 3: 1 is reported and the slot is free again, so it comes back
    // with its reason cleared.
    const freed = await wallets.sync({
      ownerUserId: user,
      observed: [external(1), external(2), external(4)],
    });
    expect(activeExternal(freed)).toEqual([address(1), address(2), address(4)]);
    expect(byAddress(freed, 1)?.archivedReason).toBeNull();
    expect(byAddress(freed, 3)).toMatchObject({
      status: "archived",
      archivedReason: "unlinked",
    });
    // Exactly one selected wallet remains.
    expect(freed.filter((record) => record.isActive)).toHaveLength(1);
  });

  it("never gives an address a second owner: the newcomer is stored as address_conflict until the first account unlinks", async () => {
    const first = await owner();
    const second = await owner();
    await wallets.sync({ ownerUserId: first, observed: [external(7)] });

    const conflicts: string[] = [];
    const blocked = await wallets.sync({
      ownerUserId: second,
      observed: [embedded(0x200, second), external(7)],
      onAddressConflict: (conflict) => {
        expect(conflict.ownerUserId).toBe(second);
        conflicts.push(conflict.walletId);
      },
    });
    const row = byAddress(blocked, 7);
    expect(row).toMatchObject({
      status: "archived",
      archivedReason: "address_conflict",
      isActive: false,
    });
    expect(conflicts).toEqual([row?.walletId]);
    const owners = await pool.query<{ owner_user_id: string }>({
      text: `select owner_user_id from public.account_wallets
             where address = $1 and status = 'active'`,
      values: [address(7)],
    });
    expect(owners.rows.map((r) => r.owner_user_id)).toEqual([first]);

    // The first account unlinks (its next sync no longer sees the wallet);
    // the second account's next sync then takes it.
    await wallets.sync({
      ownerUserId: first,
      observed: [embedded(0x201, first)],
    });
    const taken = await wallets.sync({
      ownerUserId: second,
      observed: [embedded(0x200, second), external(7)],
    });
    expect(byAddress(taken, 7)).toMatchObject({
      status: "active",
      archivedReason: null,
    });
  });

  it("the database refuses a reason on an active row and an unknown reason", async () => {
    const user = await owner();
    const [record] = await wallets.sync({
      ownerUserId: user,
      observed: [external(9)],
    });
    await expect(
      pool.query({
        text: `update public.account_wallets set archived_reason = 'unlinked' where wallet_id = $1`,
        values: [record!.walletId],
      }),
    ).rejects.toThrow(/account_wallets_archived_reason_status_check/u);
    await expect(
      pool.query({
        text: `update public.account_wallets
               set status = 'archived', is_active = false, archived_reason = 'other'
               where wallet_id = $1`,
        values: [record!.walletId],
      }),
    ).rejects.toThrow(/account_wallets_archived_reason_check/u);
  });

  it("an unlinked or over-limit wallet drops out of the mining snapshot input at once", async () => {
    const user = await owner();
    const observed = [external(11), external(12), external(13)];
    const records = await wallets.sync({ ownerUserId: user, observed });
    for (const record of records) {
      await pool.query({
        text: `insert into public.wallet_balance_snapshots
                 (wallet_id, asset_id, block_number, block_hash, raw_value, source)
               values ($1, $2, 100, $3, '1000000000000000000', 'chain')`,
        values: [record.walletId, native, `0x${"d".repeat(64)}`],
      });
    }
    const mining = createPostgresMiningRepository(pool);
    const counted = async () =>
      (
        await mining.listBalanceInputs({
          includeMockSeedHoldings: false,
          embeddedWalletOnly: false,
        })
      )
        .filter((row) => row.ownerUserId === user)
        .map((row) => row.walletId)
        .sort();
    expect(await counted()).toEqual(
      records.map((record) => record.walletId).sort(),
    );

    // Unlink 12.
    await wallets.sync({
      ownerUserId: user,
      observed: [external(11), external(13)],
    });
    const unlinked = byAddress(records, 12)!.walletId;
    expect(await counted()).not.toContain(unlinked);

    // Two newcomers: one fills the free slot, the other is over the limit.
    const grown = await wallets.sync({
      ownerUserId: user,
      observed: [external(11), external(13), external(14), external(15)],
    });
    const over = grown.find(
      (record) => record.archivedReason === "external_limit_exceeded",
    );
    expect(over).toBeDefined();
    await pool.query({
      text: `insert into public.wallet_balance_snapshots
               (wallet_id, asset_id, block_number, block_hash, raw_value, source)
             values ($1, $2, 100, $3, '1', 'chain')`,
      values: [over!.walletId, native, `0x${"d".repeat(64)}`],
    });
    expect(await counted()).not.toContain(over!.walletId);
  });

  it("EXTERNAL_WALLET_ADDRESS_PUBLIC: off maps an address to an account only through an embedded wallet, and other viewers' profile reads use the embedded wallet", async () => {
    const user = await owner();
    await wallets.sync({
      ownerUserId: user,
      observed: [embedded(0x300, user), external(21)],
    });
    // The owner selects the external wallet.
    const listed = await wallets.list(user);
    const ext = byAddress(listed, 21)!;
    const emb = byAddress(listed, 0x300)!;
    await wallets.setActive({
      ownerUserId: user,
      walletId: ext.walletId,
      expectedActiveWalletId: emb.walletId,
    });

    const hidden = createPostgresWalletAccountLookup(pool);
    const shown = createPostgresWalletAccountLookup(pool, {
      externalWalletAddressPublic: true,
    });
    expect(await hidden.findByAddresses([address(21)])).toEqual([]);
    expect(
      (await hidden.findByAddresses([address(0x300)])).map(
        (r) => r.ownerUserId,
      ),
    ).toEqual([user]);
    expect(
      (await shown.findByAddresses([address(21)])).map((r) => r.ownerUserId),
    ).toEqual([user]);

    const profiles = createPostgresPublicProfileRepository(pool);
    expect((await profiles.getActiveWallet(user))?.address).toBe(address(21));
    expect(
      (await profiles.getActiveWallet(user, { embeddedOnly: true }))?.address,
    ).toBe(address(0x300));
  });
});
