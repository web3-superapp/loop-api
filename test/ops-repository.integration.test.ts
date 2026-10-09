import { runOperator } from "../scripts/ops-operator.js";
import { createPostgresSupportTicketRepository } from "../src/database/support-ticket-repository.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresOpsRepository } from "../src/database/ops-repository.js";
import { buildMiningDevBaselineDocuments } from "../src/features/mining/mining-dev-baseline.js";
import {
  opsHash,
  miningPackageSchema,
  type OpsCommand,
  type MiningPackage,
} from "../src/features/ops/ops-contract.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

describe("operations transaction boundary", () => {
  const pool = new pg.Pool({
    connectionString: requireIntegrationDatabaseUrl(),
  });
  const repo = createPostgresOpsRepository(pool);
  let editor: string, reviewer: string;
  beforeEach(async () => {
    await pool.query(
      "truncate public.ops_audit,public.ops_operations,public.ops_mining_drafts,public.ops_grants,public.ops_operators,public.community_mining_weights,public.mining_formula_versions cascade",
    );
    editor = await operator([
      "mining.edit",
      "mining.read",
      "community.review",
      "support.manage",
    ]);
    reviewer = await operator(["mining.approve", "mining.read", "audit.read"]);
  });
  afterAll(async () => {
    await pool.end();
  });
  async function operator(permissions: string[]) {
    const id = (
      await pool.query<{ id: string }>(
        "insert into public.loop_users(privy_user_id) values($1) returning id",
        [`did:privy:ops-test:${randomUUID()}`],
      )
    ).rows[0]!.id;
    await pool.query(
      "insert into public.ops_operators(user_id,label,enabled) values($1,'Ops',true)",
      [id],
    );
    for (const permission of permissions)
      await pool.query(
        "insert into public.ops_grants(user_id,permission) values($1,$2)",
        [id, permission],
      );
    return id;
  }
  it("bootstraps, replaces and revokes operator grants with an audit entry", async () => {
    const userId = (
      await pool.query<{ id: string }>(
        "insert into public.loop_users(privy_user_id) values($1) returning id",
        [`did:privy:bootstrap-test:${randomUUID()}`],
      )
    ).rows[0]!.id;
    const env = {
      NODE_ENV: "development",
      DATABASE_URL: requireIntegrationDatabaseUrl(),
    };
    await runOperator(
      [
        "--user",
        userId,
        "--label",
        "Editor",
        "--permissions",
        "mining.read,mining.edit",
        "--confirm",
      ],
      env,
    );
    expect(await repo.session(userId)).toMatchObject({
      grants: [
        { permission: "mining.edit", scope: "*" },
        { permission: "mining.read", scope: "*" },
      ],
    });
    await runOperator(
      [
        "--user",
        userId,
        "--label",
        "Reader",
        "--permissions",
        "mining.read",
        "--confirm",
      ],
      env,
    );
    expect(await repo.session(userId)).toMatchObject({
      grants: [{ permission: "mining.read", scope: "*" }],
    });
    await runOperator(["--user", userId, "--revoke", "--confirm"], env);
    await expect(repo.session(userId)).rejects.toMatchObject({
      code: "OPS_FORBIDDEN",
    });
    const audit = await pool.query(
      "select actor_id,actor_kind,source,target,outcome,before_state,after_state from public.ops_audit where target=$1 and action='operator.bootstrap' order by id",
      [userId],
    );
    const identity = {
      actor_id: null,
      actor_kind: "deployment_admin",
      source: "deployment_cli",
      target: userId,
      outcome: "succeeded",
    };
    const editorGrants = [
      { permission: "mining.edit", scope: "*" },
      { permission: "mining.read", scope: "*" },
    ];
    const readerGrants = [{ permission: "mining.read", scope: "*" }];
    expect(audit.rows).toEqual([
      {
        ...identity,
        before_state: { enabled: null, grants: [] },
        after_state: { enabled: true, grants: editorGrants },
      },
      {
        ...identity,
        before_state: { enabled: true, grants: editorGrants },
        after_state: { enabled: true, grants: readerGrants },
      },
      {
        ...identity,
        before_state: { enabled: true, grants: readerGrants },
        after_state: { enabled: false, grants: readerGrants },
      },
    ]);
    const listed = await repo.list(reviewer, "audit", undefined, {
      target: userId,
    });
    expect(listed).toMatchObject({
      items: [
        expect.objectContaining({
          ...identity,
          before_state: { enabled: true, grants: readerGrants },
          after_state: { enabled: false, grants: readerGrants },
        }),
        expect.anything(),
        expect.anything(),
      ],
    });
  });
  it("serializes concurrent grant replacements into a continuous audit history", async () => {
    const env = {
      NODE_ENV: "development",
      DATABASE_URL: requireIntegrationDatabaseUrl(),
    };
    await Promise.all(
      ["mining.read", "audit.read"].map((permission) =>
        runOperator(
          [
            "--user",
            editor,
            "--label",
            "Concurrent",
            "--permissions",
            permission,
            "--confirm",
          ],
          env,
        ),
      ),
    );
    type GrantState = {
      enabled: boolean | null;
      grants: { permission: string; scope: string }[];
    };
    const rows = (
      await pool.query<{ before_state: GrantState; after_state: GrantState }>(
        "select before_state,after_state from public.ops_audit where target=$1 order by id",
        [editor],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1]!.before_state).toEqual(rows[0]!.after_state);
    expect(rows[0]!.before_state.grants).toHaveLength(4);
    expect(rows[0]!.after_state.grants).toHaveLength(1);
    expect(await repo.session(editor)).toMatchObject({
      grants: rows[1]!.after_state.grants,
    });
  });
  it("finishes an already-authorized API audit while CLI revocation waits", async () => {
    const apiClient = await pool.connect();
    let revocation: Promise<{ error: unknown }> | undefined;
    try {
      await apiClient.query("begin");
      await apiClient.query("set local statement_timeout='3s'");
      const apiPid = (
        await apiClient.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      // Hold the same authorization locks as an in-flight ops API command.
      await apiClient.query(
        "select user_id from public.ops_operators where user_id=$1 and enabled for share",
        [editor],
      );
      await apiClient.query(
        "select 1 from public.ops_grants where user_id=$1 and permission='mining.edit' and scope='*' for share",
        [editor],
      );
      revocation = runOperator(["--user", editor, "--revoke", "--confirm"], {
        NODE_ENV: "development",
        DATABASE_URL: requireIntegrationDatabaseUrl(),
      }).then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
      // Observe the actual lock wait before the API audit checks its actor FK.
      let cliWaiting = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        cliWaiting = (
          await pool.query<{ waiting: boolean }>(
            "select exists(select 1 from pg_stat_activity where datname=current_database() and $1::int=any(pg_blocking_pids(pid)) and query like 'update public.ops_operators set enabled=false%') as waiting",
            [apiPid],
          )
        ).rows[0]!.waiting;
        if (cliWaiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(cliWaiting).toBe(true);
      await apiClient.query(
        "insert into public.ops_audit(operation_id,actor_id,action,target,reason,outcome) values($1,$2,'test.inflight','test','in-flight API completed','succeeded')",
        [randomUUID(), editor],
      );
      await apiClient.query("commit");
      expect(await revocation).toEqual({ error: null });
      await expect(repo.session(editor)).rejects.toMatchObject({
        code: "OPS_FORBIDDEN",
      });
      expect(
        (
          await pool.query(
            "select actor_kind,source from public.ops_audit order by id",
          )
        ).rows,
      ).toEqual([
        { actor_kind: "user", source: "ops_api" },
        { actor_kind: "deployment_admin", source: "deployment_cli" },
      ]);
    } finally {
      await apiClient.query("rollback");
      apiClient.release();
      await revocation;
    }
  });
  it("rolls back the CLI authorization when its audit insert fails", async () => {
    await pool.query(
      "create function public.ops_test_cli_reject_audit() returns trigger language plpgsql as $$ begin if NEW.source='deployment_cli' then raise exception 'test CLI audit failure'; end if; return NEW; end $$",
    );
    await pool.query(
      "create trigger ops_test_cli_reject before insert on public.ops_audit for each row execute function public.ops_test_cli_reject_audit()",
    );
    try {
      const before = await repo.session(editor);
      await expect(
        runOperator(["--user", editor, "--revoke", "--confirm"], {
          NODE_ENV: "development",
          DATABASE_URL: requireIntegrationDatabaseUrl(),
        }),
      ).rejects.toThrow();
      expect(await repo.session(editor)).toEqual(before);
      expect(
        (
          await pool.query("select 1 from public.ops_audit where target=$1", [
            editor,
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await pool.query(
        "drop trigger ops_test_cli_reject on public.ops_audit; drop function public.ops_test_cli_reject_audit()",
      );
    }
  });
  it("defaults API audits to a user actor and rejects forged CLI actor shapes", async () => {
    const operationId = randomUUID();
    await pool.query(
      "insert into public.ops_audit(operation_id,actor_id,action,target,reason,outcome) values($1,$2,'test.action','test','test','succeeded')",
      [operationId, editor],
    );
    expect(
      (
        await pool.query(
          "select actor_id,actor_kind,source from public.ops_audit where operation_id=$1",
          [operationId],
        )
      ).rows,
    ).toEqual([{ actor_id: editor, actor_kind: "user", source: "ops_api" }]);
    await expect(
      pool.query(
        "insert into public.ops_audit(operation_id,actor_id,actor_kind,source,action,target,reason,outcome) values($1,$2::uuid,'deployment_admin','deployment_cli','operator.bootstrap',$2::uuid::text,'test','succeeded')",
        [randomUUID(), editor],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "insert into public.ops_audit(operation_id,actor_id,action,target,reason,outcome) values($1,null,'test.action','test','test','succeeded')",
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  function pkg(): MiningPackage {
    return miningPackageSchema.parse({
      ...buildMiningDevBaselineDocuments([`eip155:56:0x${"1".repeat(40)}`]),
      configVersion: `ops-${randomUUID()}`,
      communityWeights: [],
    });
  }
  function cmd(action: "mining.create", payload: MiningPackage): OpsCommand {
    return {
      action,
      operationId: randomUUID(),
      target: randomUUID(),
      reason: "审核配置",
      payload,
    };
  }
  it("denies ordinary/revoked users and binds retries to actor and content", async () => {
    const command = cmd("mining.create", pkg());
    await expect(repo.execute(randomUUID(), command)).rejects.toMatchObject({
      code: "OPS_FORBIDDEN",
    });
    const first = await repo.execute(editor, command);
    expect(first).toMatchObject({ replayed: false });
    expect(await repo.execute(editor, command)).toMatchObject({
      replayed: true,
    });
    expect(await repo.operation(editor, command.operationId)).toMatchObject({
      operationId: command.operationId,
    });
    await expect(
      repo.execute(editor, { ...command, reason: "another" }),
    ).rejects.toMatchObject({ code: "OPS_IDEMPOTENCY_CONFLICT" });
    await expect(
      repo.operation(reviewer, command.operationId),
    ).rejects.toMatchObject({ code: "OPS_NOT_FOUND" });
    await pool.query(
      "update public.ops_operators set enabled=false where user_id=$1",
      [editor],
    );
    await expect(repo.execute(editor, command)).rejects.toMatchObject({
      code: "OPS_FORBIDDEN",
    });
  });
  it("publishes a complete immutable package with independent approval and CAS", async () => {
    const content = pkg();
    const create = cmd("mining.create", content);
    await repo.execute(editor, create);
    await repo.execute(editor, {
      action: "mining.submit",
      operationId: randomUUID(),
      target: create.target,
      reason: "送审",
      payload: { expectedRevision: 1 },
    });
    await pool.query(
      "insert into public.ops_grants(user_id,permission) values($1,'mining.approve')",
      [editor],
    );
    const publish: OpsCommand = {
      action: "mining.publish",
      operationId: randomUUID(),
      target: create.target,
      reason: "批准",
      payload: {
        expectedRevision: 2,
        contentHash: opsHash(content),
        expectedActiveVersion: null,
      },
    };
    await expect(repo.execute(editor, publish)).rejects.toMatchObject({
      code: "OPS_SELF_APPROVAL",
    });
    await repo.execute(reviewer, publish);
    expect(
      (
        await pool.query(
          "select config_version,status from public.mining_formula_versions",
        )
      ).rows,
    ).toEqual([{ config_version: content.configVersion, status: "approved" }]);
    expect(await repo.execute(reviewer, publish)).toMatchObject({
      replayed: true,
    });
  });
  it("rejects changed community bindings after review without touching live formula", async () => {
    const communityId = (
      await pool.query<{ community_id: string }>(
        "insert into public.communities(name,slug,bound_asset_key,created_by_user_id) values('Ops',$1,$2,$3) returning community_id",
        [
          `ops-${randomUUID().slice(0, 16)}`,
          `eip155:56:0x${"1".repeat(40)}`,
          editor,
        ],
      )
    ).rows[0]!.community_id;
    const content = {
      ...pkg(),
      communityWeights: [
        {
          communityId,
          boundAssetId: `eip155:56:0x${"1".repeat(40)}`,
          weight: "1",
        },
      ],
    };
    const create = cmd("mining.create", content);
    await repo.execute(editor, create);
    await repo.execute(editor, {
      action: "mining.submit",
      operationId: randomUUID(),
      target: create.target,
      reason: "送审",
      payload: { expectedRevision: 1 },
    });
    await pool.query(
      "update public.communities set bound_asset_key=null where community_id=$1",
      [communityId],
    );
    await expect(
      repo.execute(reviewer, {
        action: "mining.publish",
        operationId: randomUUID(),
        target: create.target,
        reason: "批准",
        payload: {
          expectedRevision: 2,
          contentHash: opsHash(content),
          expectedActiveVersion: null,
        },
      }),
    ).rejects.toMatchObject({ code: "OPS_COMMUNITY_BINDING_CHANGED" });
    expect(
      (await pool.query("select * from public.mining_formula_versions"))
        .rowCount,
    ).toBe(0);
    expect(
      (await pool.query("select state from public.ops_mining_drafts")).rows[0],
    ).toEqual({ state: "review" });
  });
  it("revision invalidates review and preserves all contributors against self approval", async () => {
    const content = pkg(),
      create = cmd("mining.create", content);
    await repo.execute(editor, create);
    await repo.execute(editor, {
      action: "mining.submit",
      operationId: randomUUID(),
      target: create.target,
      reason: "送审",
      payload: { expectedRevision: 1 },
    });
    await repo.execute(editor, {
      action: "mining.revise",
      operationId: randomUUID(),
      target: create.target,
      reason: "修订",
      payload: { expectedRevision: 2, package: content },
    });
    expect(
      (await pool.query("select state,revision from public.ops_mining_drafts"))
        .rows[0],
    ).toEqual({ state: "draft", revision: 3 });
    await expect(
      repo.execute(reviewer, {
        action: "mining.publish",
        operationId: randomUUID(),
        target: create.target,
        reason: "旧审批",
        payload: {
          expectedRevision: 2,
          contentHash: opsHash(content),
          expectedActiveVersion: null,
        },
      }),
    ).rejects.toMatchObject({ code: "OPS_VERSION_CONFLICT" });
  });
  it("allows only one publish from the same expected active version", async () => {
    const drafts = [cmd("mining.create", pkg()), cmd("mining.create", pkg())];
    for (const draft of drafts) {
      await repo.execute(editor, draft);
      await repo.execute(editor, {
        action: "mining.submit",
        operationId: randomUUID(),
        target: draft.target,
        reason: "送审",
        payload: { expectedRevision: 1 },
      });
    }
    const results = await Promise.allSettled(
      drafts.map((d) =>
        repo.execute(reviewer, {
          action: "mining.publish",
          operationId: randomUUID(),
          target: d.target,
          reason: "批准",
          payload: {
            expectedRevision: 2,
            contentHash: opsHash(d.payload),
            expectedActiveVersion: null,
          },
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await pool.query(
          "select count(*)::int as count from public.mining_formula_versions where status='approved'",
        )
      ).rows[0],
    ).toEqual({ count: 1 });
  });
  it("rechecks queued-job grants and audits held jobs", async () => {
    const content = pkg(),
      create = cmd("mining.create", content);
    await repo.execute(editor, create);
    const queued = (await repo.execute(editor, {
      action: "mining.trial",
      operationId: randomUUID(),
      target: create.target,
      reason: "试算",
      payload: { expectedRevision: 1, contentHash: opsHash(content) },
    })) as { result: { jobId: string } };
    await pool.query(
      "delete from public.ops_grants where user_id=$1 and permission='mining.edit'",
      [editor],
    );
    await expect(repo.job(editor, queued.result.jobId)).rejects.toMatchObject({
      code: "OPS_FORBIDDEN",
    });
    const runtime = {
      registry: { listAssets: () => Promise.resolve([]) },
      prices: {
        readAssetPrice: () => Promise.reject(new Error("must not read")),
        readPair: () => Promise.reject(new Error("must not read")),
      },
    };
    await expect(
      repo.runJob(editor, queued.result.jobId, runtime),
    ).rejects.toMatchObject({ code: "OPS_FORBIDDEN" });
    expect(
      (
        await pool.query("select state from public.ops_jobs where id=$1", [
          queued.result.jobId,
        ])
      ).rows[0],
    ).toEqual({ state: "held" });
    expect(
      (
        await pool.query(
          "select 1 from public.ops_audit where operation_id=$1 and code='OPS_FORBIDDEN'",
          [queued.result.jobId],
        )
      ).rowCount,
    ).toBeGreaterThan(0);
  });
  it("stores trial evidence and returns the saved result on repeated execution", async () => {
    const content = pkg(),
      create = cmd("mining.create", content);
    await repo.execute(editor, create);
    const queued = (await repo.execute(editor, {
      action: "mining.trial",
      operationId: randomUUID(),
      target: create.target,
      reason: "试算",
      payload: { expectedRevision: 1, contentHash: opsHash(content) },
    })) as { result: { jobId: string } };
    const runtime = {
      registry: { listAssets: () => Promise.resolve([]) },
      prices: {
        readAssetPrice: () => Promise.reject(new Error("no assets")),
        readPair: () => Promise.reject(new Error("no assets")),
      },
    };
    await repo.runJob(editor, queued.result.jobId, runtime);
    expect(await repo.job(editor, queued.result.jobId)).toMatchObject({
      state: "complete",
      evidence: { formula: { configVersion: content.configVersion } },
      result: { published: false, snapshotId: null },
    });
    expect(
      await repo.runJob(editor, queued.result.jobId, runtime),
    ).toMatchObject({ state: "complete" });
    expect(
      (
        await pool.query(
          "select count(*)::int as count from public.ops_audit where operation_id=$1 and outcome='succeeded'",
          [queued.result.jobId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
  });
  it("rolls back reused repository writes when the outer audit fails", async () => {
    const support = createPostgresSupportTicketRepository(pool);
    const ticket = await support.create({
      ownerUserId: editor,
      idempotencyKey: randomUUID(),
      requestSha256: "a".repeat(64),
      requestId: randomUUID(),
      category: "other",
      body: "请帮忙处理",
    });
    await pool.query(
      "create function public.ops_test_reject_audit() returns trigger language plpgsql as $$ begin if NEW.reason='ROLLBACK_TEST' and NEW.outcome='succeeded' then raise exception 'test audit failure'; end if; return NEW; end $$",
    );
    await pool.query(
      "create trigger ops_test_reject before insert on public.ops_audit for each row execute function public.ops_test_reject_audit()",
    );
    try {
      await expect(
        repo.execute(editor, {
          action: "support.answer",
          operationId: randomUUID(),
          target: ticket.ticket.ticketId,
          reason: "ROLLBACK_TEST",
          payload: { status: "answered", note: "回复" },
        }),
      ).rejects.toMatchObject({ code: "OPS_COMMAND_FAILED" });
      expect(
        (
          await pool.query(
            "select status from public.support_tickets where ticket_id=$1",
            [ticket.ticket.ticketId],
          )
        ).rows[0],
      ).toEqual({ status: "open" });
      expect(
        (
          await pool.query(
            "select count(*)::int as count from public.support_ticket_events where ticket_id=$1 and event_type='answered'",
            [ticket.ticket.ticketId],
          )
        ).rows[0],
      ).toEqual({ count: 0 });
    } finally {
      await pool.query(
        "drop trigger ops_test_reject on public.ops_audit; drop function public.ops_test_reject_audit()",
      );
    }
  });
  it("does not consume retries when a job is already claimed", async () => {
    const content = pkg(),
      create = cmd("mining.create", content);
    await repo.execute(editor, create);
    const queued = (await repo.execute(editor, {
      action: "mining.trial",
      operationId: randomUUID(),
      target: create.target,
      reason: "试算",
      payload: { expectedRevision: 1, contentHash: opsHash(content) },
    })) as { result: { jobId: string } };
    const lock = await pool.connect();
    try {
      await lock.query("begin");
      await lock.query(
        "select id from public.ops_jobs where id=$1 for update",
        [queued.result.jobId],
      );
      await expect(
        repo.runJob(editor, queued.result.jobId, {
          registry: { listAssets: () => Promise.resolve([]) },
          prices: {
            readAssetPrice: () => Promise.reject(new Error("unexpected")),
            readPair: () => Promise.reject(new Error("unexpected")),
          },
        }),
      ).rejects.toMatchObject({ code: "OPS_JOB_BUSY" });
    } finally {
      await lock.query("rollback");
      lock.release();
    }
    expect(await repo.job(editor, queued.result.jobId)).toMatchObject({
      state: "queued",
      attempts: 0,
    });
  });
  it("filters the full audit history on the server with a stable cursor", async () => {
    const content = pkg(),
      create = cmd("mining.create", content);
    await repo.execute(editor, create);
    const filters = {
      actorId: editor,
      action: "mining.create",
      target: create.target,
      configVersion: content.configVersion,
      outcome: "succeeded" as const,
      from: "2020-01-01T00:00:00Z",
      to: "2100-01-01T00:00:00Z",
    };
    const result = (await repo.list(reviewer, "audit", undefined, filters)) as {
      items: { id: string; config_version: string }[];
    };
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.config_version).toBe(content.configVersion);
    expect(
      await repo.list(reviewer, "audit", result.items[0]!.id, filters),
    ).toMatchObject({ items: [] });
    expect(
      await repo.list(reviewer, "audit", undefined, {
        ...filters,
        actorId: reviewer,
      }),
    ).toMatchObject({ items: [] });
    await expect(
      repo.list(editor, "audit", undefined, filters),
    ).rejects.toMatchObject({ code: "OPS_FORBIDDEN" });
  });
  it("reads frozen weights by an explicit version and never follows active publication", async () => {
    const id = (
      await pool.query<{ community_id: string }>(
        "insert into public.communities(name,slug,bound_asset_key,created_by_user_id) values('Versioned',$1,$2,$3) returning community_id",
        [
          `ops-${randomUUID().slice(0, 16)}`,
          `eip155:56:0x${"1".repeat(40)}`,
          editor,
        ],
      )
    ).rows[0]!.community_id;
    async function publish(weight: string, previous: string | null) {
      const content = {
        ...pkg(),
        communityWeights: [
          {
            communityId: id,
            boundAssetId: `eip155:56:0x${"1".repeat(40)}`,
            weight,
          },
        ],
      };
      const create = cmd("mining.create", content);
      await repo.execute(editor, create);
      await repo.execute(editor, {
        action: "mining.submit",
        target: create.target,
        operationId: randomUUID(),
        reason: "送审",
        payload: { expectedRevision: 1 },
      });
      await repo.execute(reviewer, {
        action: "mining.publish",
        target: create.target,
        operationId: randomUUID(),
        reason: "批准",
        payload: {
          expectedRevision: 2,
          contentHash: opsHash(content),
          expectedActiveVersion: previous,
        },
      });
      return content.configVersion;
    }
    const first = await publish("1", null);
    const second = await publish("1.5", first);
    await pool.query(
      "update public.communities set bound_asset_key=null where community_id=$1",
      [id],
    );
    expect(
      await repo.list(editor, "weights", undefined, { configVersion: first }),
    ).toMatchObject({
      configVersion: first,
      items: [{ weight: "1", bound_asset_id: `eip155:56:0x${"1".repeat(40)}` }],
    });
    expect(
      await repo.list(editor, "weights", undefined, { configVersion: second }),
    ).toMatchObject({ configVersion: second, items: [{ weight: "1.5" }] });
    await expect(repo.list(editor, "weights")).rejects.toMatchObject({
      code: "OPS_CONFIG_VERSION_REQUIRED",
    });
  });
});
