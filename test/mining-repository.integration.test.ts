import { randomUUID } from "node:crypto";

import type { MigrationBuilder } from "node-pg-migrate";
import pg from "pg";

import { down, up } from "../migrations/000046_ops_mining_weights.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import { buildMiningDevBaselineDocuments } from "../src/features/mining/mining-dev-baseline.js";
import {
  MiningCommunityWeightConflictError,
  MiningFormulaStateError,
} from "../src/features/mining/mining-repository.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

const assetId = `eip155:56:0x${"1".repeat(40)}`;
const documents = buildMiningDevBaselineDocuments([assetId]);

describe("PostgreSQL versioned community mining weights", () => {
  const pool = new pg.Pool({
    connectionString: requireIntegrationDatabaseUrl(),
  });
  const repository = createPostgresMiningRepository(pool);

  beforeEach(async () => {
    await pool.query(
      "truncate public.community_mining_weights, public.mining_formula_versions cascade",
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  async function community() {
    const owner = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:mining-test:${randomUUID()}`],
    );
    const result = await pool.query<{ community_id: string }>(
      `insert into public.communities (name, slug, bound_asset_key, created_by_user_id)
       values ('Mining test', $1, $2, $3) returning community_id`,
      [
        `mine-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        assetId,
        owner.rows[0]!.id,
      ],
    );
    return result.rows[0]!.community_id;
  }
  async function formula(configVersion: string) {
    return repository.createFormulaVersion({
      ...documents,
      configVersion,
      requestId: randomUUID(),
    });
  }
  async function set(
    communityId: string,
    configVersion: string,
    weight: string,
  ) {
    return repository.setCommunityWeight({
      communityId,
      configVersion,
      weight,
      requestId: randomUUID(),
    });
  }
  async function approve(configVersion: string) {
    return repository.approveFormula({
      configVersion,
      requestId: randomUUID(),
    });
  }

  it("keeps active and retired weights unchanged when a new version is edited and published", async () => {
    const id = await community();
    await formula("mining-old");
    await set(id, "mining-old", "0.5");
    await approve("mining-old");
    await formula("mining-new");
    await set(id, "mining-new", "2");
    expect(await repository.getCommunityWeight(id)).toMatchObject({
      configVersion: "mining-old",
      weight: "0.5",
    });
    expect(
      (await repository.listCommunityWeightInputs("mining-old")).filter(
        (row) => row.communityId === id,
      ),
    ).toEqual([
      { communityId: id, assetId, weight: "0.5", status: "approved" },
    ]);
    await approve("mining-new");
    expect(await repository.getCommunityWeight(id)).toMatchObject({
      configVersion: "mining-new",
      weight: "2",
    });
    expect(
      (await repository.listCommunityWeightInputs("mining-old")).filter(
        (row) => row.communityId === id,
      ),
    ).toHaveLength(1);
    expect(
      (await repository.listCommunityWeightInputs("mining-old")).find(
        (row) => row.communityId === id,
      )?.weight,
    ).toBe("0.5");
  });

  it("refuses edits to an approved formula through the repository and direct SQL", async () => {
    const id = await community();
    await formula("mining-frozen");
    await set(id, "mining-frozen", "1");
    await approve("mining-frozen");
    await expect(set(id, "mining-frozen", "2")).rejects.toBeInstanceOf(
      MiningFormulaStateError,
    );
    await expect(
      pool.query(
        "update public.community_mining_weights set weight = '2' where community_id = $1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(
        "delete from public.community_mining_weights where community_id = $1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("keeps unversioned pending rows without duplicating a version-specific read", async () => {
    const id = await community();
    await pool.query(
      "insert into public.community_mining_weights (community_id) values ($1)",
      [id],
    );
    await formula("mining-pending");
    await set(id, "mining-pending", "1.5");
    expect(
      (
        await pool.query(
          "select * from public.community_mining_weights where community_id = $1 and config_version is null",
          [id],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (await repository.listCommunityWeightInputs("mining-pending")).filter(
        (row) => row.communityId === id,
      ),
    ).toEqual([
      { communityId: id, assetId, weight: "1.5", status: "approved" },
    ]);
    expect(await repository.getCommunityWeight(id)).toMatchObject({
      status: "pending_review",
      weight: null,
      configVersion: null,
    });
  });

  it("serializes competing communities for one asset and version", async () => {
    const [first, second] = await Promise.all([community(), community()]);
    await formula("mining-conflict");
    const results = await Promise.allSettled([
      set(first, "mining-conflict", "1"),
      set(second, "mining-conflict", "2"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(
      rejected?.status === "rejected" ? rejected.reason : undefined,
    ).toBeInstanceOf(MiningCommunityWeightConflictError);
  });

  it("keeps version asset inputs frozen after a community is rebound or unbound", async () => {
    const id = await community();
    await formula("mining-binding");
    await set(id, "mining-binding", "1.5");
    await approve("mining-binding");
    for (const binding of [`eip155:56:0x${"2".repeat(40)}`, null]) {
      await pool.query(
        "update public.communities set bound_asset_key = $2 where community_id = $1",
        [id, binding],
      );
      expect(
        (await repository.listCommunityWeightInputs("mining-binding")).find(
          (row) => row.communityId === id,
        ),
      ).toEqual({
        communityId: id,
        assetId,
        weight: "1.5",
        status: "approved",
      });
      expect(await repository.getCommunityWeight(id)).toMatchObject({
        boundAssetId: assetId,
        weight: "1.5",
      });
      expect(
        await repository.getCommunityStanding({
          communityId: id,
          configVersion: "mining-binding",
          snapshotId: randomUUID(),
        }),
      ).toMatchObject({ boundAssetId: assetId, weight: "1.5" });
    }
  });

  it("detects draft asset conflicts using the saved binding after rebind", async () => {
    const first = await community();
    const second = await community();
    await formula("mining-binding-conflict");
    await set(first, "mining-binding-conflict", "1");
    await pool.query(
      "update public.communities set bound_asset_key = null where community_id = $1",
      [first],
    );
    await expect(
      set(second, "mining-binding-conflict", "1"),
    ).rejects.toBeInstanceOf(MiningCommunityWeightConflictError);
  });

  it("serializes concurrent publication and leaves exactly one active formula", async () => {
    await formula("mining-first");
    await formula("mining-second");
    const results = await Promise.allSettled([
      approve("mining-first"),
      approve("mining-second"),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const versions = await repository.listFormulaVersions();
    expect(
      versions.filter((version) => version.status === "approved"),
    ).toHaveLength(1);
    expect(
      versions.filter((version) => version.status === "retired"),
    ).toHaveLength(1);
  });

  it("preserves evidenced legacy rows and marks missing history unknown during migration", async () => {
    const weighted = await community();
    const pending = await community();
    const client = await pool.connect();
    const migrationSql = (direction: typeof up) => {
      let sql = "";
      direction({
        sql: (statement: string) => {
          sql += statement;
        },
      } as MigrationBuilder);
      return sql;
    };
    await client.query("begin");
    try {
      await client.query(migrationSql(down));
      for (const version of ["legacy-lost", "legacy-surviving"]) {
        await client.query(
          `insert into public.mining_formula_versions
          (config_version, formula, weight_range, price_guard_rules, status)
          values ($1, $2, $3, $4, 'pending_approval')`,
          [
            version,
            JSON.stringify(documents.formula),
            JSON.stringify(documents.weightRange),
            JSON.stringify(documents.priceGuardRules),
          ],
        );
      }
      await client.query(
        `insert into public.community_mining_weights
        (community_id, config_version, status, weight, reviewed_at)
        values ($1, 'legacy-surviving', 'approved', '1.5', clock_timestamp()),
               ($2, null, 'pending_review', null, null)`,
        [weighted, pending],
      );
      await client.query(migrationSql(up));
      const weights = await client.query(
        "select community_id, config_version, weight, bound_asset_id from public.community_mining_weights order by config_version nulls last",
      );
      expect(weights.rows).toEqual([
        {
          community_id: weighted,
          config_version: "legacy-surviving",
          weight: "1.5",
          bound_asset_id: assetId,
        },
        {
          community_id: pending,
          config_version: null,
          weight: null,
          bound_asset_id: assetId,
        },
      ]);
      const history = await client.query(
        "select community_weight_history_status from public.mining_formula_versions",
      );
      expect(history.rows).toEqual([
        { community_weight_history_status: "legacy_unknown" },
        { community_weight_history_status: "legacy_unknown" },
      ]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
