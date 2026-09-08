import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

const pool = new Pool({ connectionString: databaseUrl });
const testPrivyPrefix = "chain-wallet-migration-test:";
const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const wbnbAssetId = `eip155:56:${wbnb}`;
const walletAddress = "0x00000000000000000000000000000000000000a1";

async function cleanFixtures(): Promise<void> {
  await pool.query({
    text: `
      delete from public.watchlist_versions
      where owner_user_id in (
        select id from public.loop_users where privy_user_id like $1
      )
    `,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `
      delete from public.account_wallets
      where owner_user_id in (
        select id from public.loop_users where privy_user_id like $1
      )
    `,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `delete from public.loop_users where privy_user_id like $1`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query(
    `delete from public.indexed_approvals where chain_id = 'eip155:56'`,
  );
  await pool.query(
    `delete from public.indexed_transfers where chain_id = 'eip155:56'`,
  );
  // Pools (S5b) reference registry assets; drop any pool on the fixture
  // assets before the assets themselves so suite order cannot matter.
  await pool.query(
    `delete from public.indexed_pool_events where chain_id = 'eip155:56'`,
  );
  await pool.query(`delete from public.pools where chain_id = 'eip155:56'`);
  await pool.query({
    text: `delete from public.assets where asset_id = $1`,
    values: [wbnbAssetId],
  });
}

async function createOwner(): Promise<string> {
  const result = await pool.query<{ id: string }>({
    text: `insert into public.loop_users (privy_user_id) values ($1) returning id`,
    values: [`${testPrivyPrefix}${randomUUID()}`],
  });
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("owner setup failed");
  }
  return id;
}

async function seedAsset(): Promise<void> {
  await pool.query({
    text: `
      insert into public.assets (
        asset_id, chain_id, address, symbol, name, decimals, status,
        source_kind, source_block_number, source_verified_at
      )
      values ($1, 'eip155:56', $2, 'WBNB', 'Wrapped BNB', 18, 'pending',
              'chain_call', 43000000, clock_timestamp())
      on conflict (asset_id) do nothing
    `,
    values: [wbnbAssetId, wbnb],
  });
}

describe("V2 chain registry, wallet, and watchlist migration", () => {
  beforeEach(async () => {
    await cleanFixtures();
  });

  afterAll(async () => {
    await cleanFixtures();
    await pool.end();
  });

  it("seeds the BSC chain row and its native asset", async () => {
    const chain = await pool.query<{
      chain_id: string;
      reference: number;
      confirmations: number;
      reorg_depth_blocks: number;
      native_asset_id: string;
    }>(
      `select chain_id, reference, confirmations, reorg_depth_blocks, native_asset_id
       from public.chains where chain_id = 'eip155:56'`,
    );
    expect(chain.rows[0]).toMatchObject({
      chain_id: "eip155:56",
      reference: 56,
      confirmations: 15,
      reorg_depth_blocks: 64,
      native_asset_id: "eip155:56:native",
    });

    const native = await pool.query<{ symbol: string; decimals: number }>(
      `select symbol, decimals from public.assets where asset_id = 'eip155:56:native'`,
    );
    expect(native.rows[0]).toEqual({ symbol: "BNB", decimals: 18 });
  });

  it("refuses a non-canonical asset ID, address, or decimals", async () => {
    await expect(
      pool.query({
        text: `
          insert into public.assets (
            asset_id, chain_id, address, symbol, name, decimals, status,
            source_kind, source_block_number, source_verified_at
          )
          values ('eip155:56:0xBB4CDB9CBD36B01BD1CBAEBF2DE08D9173BC095C',
                  'eip155:56', $1, 'WBNB', 'Wrapped BNB', 18, 'pending',
                  'chain_call', 1, clock_timestamp())
        `,
        values: [wbnb],
      }),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      pool.query({
        text: `
          insert into public.assets (
            asset_id, chain_id, address, symbol, name, decimals, status,
            source_kind, source_block_number, source_verified_at
          )
          values ($1, 'eip155:56', $2, 'WBNB', 'Wrapped BNB', 99, 'pending',
                  'chain_call', 1, clock_timestamp())
        `,
        values: [wbnbAssetId, wbnb],
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("requires on-chain evidence for a chain_call asset row", async () => {
    await expect(
      pool.query({
        text: `
          insert into public.assets (
            asset_id, chain_id, address, symbol, name, decimals, status,
            source_kind
          )
          values ($1, 'eip155:56', $2, 'WBNB', 'Wrapped BNB', 18, 'pending',
                  'chain_call')
        `,
        values: [wbnbAssetId, wbnb],
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps at most one active wallet per account", async () => {
    const ownerUserId = await createOwner();
    await pool.query({
      text: `
        insert into public.account_wallets (
          owner_user_id, provider_wallet_id, address, kind, is_active
        )
        values ($1, 'wallet_privy_1', $2, 'embedded', true)
      `,
      values: [ownerUserId, walletAddress],
    });

    await expect(
      pool.query({
        text: `
          insert into public.account_wallets (
            owner_user_id, address, kind, is_active
          )
          values ($1, '0x00000000000000000000000000000000000000b2', 'external', true)
        `,
        values: [ownerUserId],
      }),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      pool.query({
        text: `
          insert into public.account_wallets (
            owner_user_id, provider_wallet_id, address, kind
          )
          values ($1, null, $2, 'embedded')
        `,
        values: [ownerUserId, "0x00000000000000000000000000000000000000c3"],
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("stores an indexed transfer once per transaction hash and log index", async () => {
    await seedAsset();
    const insert = {
      text: `
        insert into public.indexed_transfers (
          chain_id, transaction_hash, log_index, block_number, block_hash,
          asset_id, from_address, to_address, raw_value
        )
        values ('eip155:56', $1, 0, 100, $2, $3, $4, $5, $6::numeric)
        on conflict (chain_id, transaction_hash, log_index) do update set
          raw_value = excluded.raw_value
      `,
      values: [
        `0x${"7".repeat(64)}`,
        `0x${"2".repeat(64)}`,
        wbnbAssetId,
        walletAddress,
        "0x00000000000000000000000000000000000000b2",
        "1500000000000000000",
      ],
    };
    await pool.query(insert);
    await pool.query(insert);

    const rows = await pool.query<{ count: string; raw_value: string }>({
      text: `
        select count(*)::text as count, max(raw_value)::text as raw_value
        from public.indexed_transfers
        where chain_id = 'eip155:56'
      `,
    });
    expect(rows.rows[0]).toEqual({
      count: "1",
      raw_value: "1500000000000000000",
    });
  });

  it("keeps V1 and V2 watchlist rows in separate asset namespaces", async () => {
    await seedAsset();
    const ownerUserId = await createOwner();
    await pool.query({
      text: `insert into public.watchlist_versions (owner_user_id, record_version) values ($1, 1)`,
      values: [ownerUserId],
    });
    await pool.query({
      text: `
        insert into public.watchlist_groups (owner_user_id, group_key, name, position)
        values ($1, 'default', 'All', 0)
      `,
      values: [ownerUserId],
    });
    await pool.query({
      text: `
        insert into public.watchlist_items (
          owner_user_id, group_key, asset_key, asset_id, position
        )
        values ($1, 'default', 'BTC', null, 0)
      `,
      values: [ownerUserId],
    });
    await pool.query({
      text: `
        insert into public.watchlist_items (
          owner_user_id, group_key, asset_key, asset_id, position
        )
        values ($1, 'default', null, $2, 1)
      `,
      values: [ownerUserId, wbnbAssetId],
    });

    await expect(
      pool.query({
        text: `
          insert into public.watchlist_items (
            owner_user_id, group_key, asset_key, asset_id, position
          )
          values ($1, 'default', 'ETH', $2, 2)
        `,
        values: [ownerUserId, wbnbAssetId],
      }),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      pool.query({
        text: `
          insert into public.watchlist_items (
            owner_user_id, group_key, asset_key, asset_id, position
          )
          values ($1, 'default', null, $2, 3)
        `,
        values: [ownerUserId, wbnbAssetId],
      }),
    ).rejects.toMatchObject({ code: "23505" });

    const counts = await pool.query<{ v1: string; v2: string }>({
      text: `
        select
          count(*) filter (where asset_key is not null)::text as v1,
          count(*) filter (where asset_id is not null)::text as v2
        from public.watchlist_items
        where owner_user_id = $1
      `,
      values: [ownerUserId],
    });
    expect(counts.rows[0]).toEqual({ v1: "1", v2: "1" });
  });
});
