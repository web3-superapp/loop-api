# 0182 · 一币一社区：社区绑定代币强制唯一（S299，2026-10-25）

## 1. Status

已实现（分支 `feat/S299-bound-asset-unique`，基线 `d1a32d9`）。迁移 `000100_community_bound_asset_unique`（并行批次 S300 用 000101；`latestMigrationName` 与各「迁移头」断言已改到 000100，合并时由主代理顺延）。新 V2 错误码 `COMMUNITY_BOUND_ASSET_TAKEN`（409）；新后台 reasonCode `ADMIN_COMMUNITY_BOUND_ASSET_TAKEN`；launch2 lane 新 warn `LAUNCH2_COMMUNITY_BOUND_ASSET_TAKEN`。无新 env、无新路由、无新响应键（只多一种错误体）。

## 2. Context

- 需求方 2026-10-25 追问（`LOOP/docs/48-算力计算公式说明-2026-10-25.md` 附录 A、D 第 1 条）：预期「每个代币只能被一个社区绑定」，现状是建社区、改绑定、Launch 发射后自动绑定三处都不查重，`communities.bound_asset_key` 只有格式 CHECK（000016），没有唯一约束。
- 多社区绑同一币时挖矿两边都已有「多绑定」兜底：结算里该 MEME 的 NFT 归属记为未绑定（系数 0），快照里该币整体剔除（`COMMUNITY_WEIGHT_AMBIGUOUS`）。结果是重复绑定让大家都拿不到算力，且用户看不到原因。
- 已知存量重复：staging 上 `builders-guild` 与 `mock-vol-01` 都绑 USDT；`ops/seed-mock.sh` 给多个 mock 社区绑真实 BSC 币，可能还有。

## 3. Decision

### A. 规则

- 同一个 `bound_asset_key` 在任一时刻至多被**一个未被驳回**（`verification_status in ('pending','verified')`）的社区绑定。
- **被驳回社区不占位**：`rejected` 社区保留它的 `bound_asset_key`（便于改判 / 重新提交），但不挡别人绑同一币。它要重新回到 `pending`（resubmit）或被改判 `verified` 时，若该币已被别的社区占用，则拒绝。
- 唯一性只看「键」，与资产状态（pending / verified / blocked）、有没有池子无关；格式校验与 0097 的「必须在资产表」不变，先校验注册、再查占用。

### B. 数据库

- 部分唯一索引 `communities_bound_asset_key_unique on public.communities (bound_asset_key) where bound_asset_key is not null and verification_status <> 'rejected'`。谓词与结算 SQL 里「排除已拒绝」的口径（`mining-settlement-repository` 的 `c.verification_status <> 'rejected'`）一致。
- 迁移 `down` 只删索引，不恢复被清理的绑定。

### C. 存量清理（迁移 000100 内、建索引之前）

- 对每个有多于一个未驳回社区的 `bound_asset_key`：保留者 = **已验证里最早创建**的；没有已验证则**最早创建**的；同刻再按 `community_id` 升序。
- 其余社区：`bound_asset_key = null`、`record_version + 1`、`updated_at = clock_timestamp()`，并追加一行 `community_role_events`（`actor_type = operator`、`event_type = community_profile_updated`、`reason_code = bound_asset_dedup_0182`）。
- 每解绑一个社区 `raise notice 'Decision 0182: community <id> released bound asset <key> (kept by community <id>)'`，最后一行 `Decision 0182: <n> duplicate community binding(s) released`。staging / 生产执行迁移时从日志里能直接拿到被解绑社区清单。
- `rejected` 社区不参与比较、不被改动。
- `communities` 表上没有其他从 `bound_asset_key` 派生的列（000016 / 000039 / 000046 / 000097 核过）；买入播报、挖矿快照 / 结算等历史表记录的是当时事实，不回写。

### D. 应用层查重（不只靠索引）

公共函数 `src/database/community-bound-asset.ts` 的 `findBoundAssetHolder`：先取事务级 advisory lock（`hashtextextended('community_bound_asset:' || key, 0)`），再查「别的、未驳回」的持有社区。所有绑定路径都在各自事务里、在已有行锁之后调用，同一币的并发绑定被串行化。

| 路径                                                                    | 何时查                                                                                | 冲突结果                                                                                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v2/communities`（`createCommunity`）                             | 绑定键非空                                                                            | `409 COMMUNITY_BOUND_ASSET_TAKEN`                                                                                                                                                     |
| `PATCH /v2/communities/{id}`（`updateCommunity`，仅群主可改绑定，0098） | 键**有变化**且非空；不论本社区自己的审核状态（避免被驳回社区先占着、resubmit 时再撞） | 同上                                                                                                                                                                                  |
| `POST /v2/communities/{id}/resubmit`                                    | 本社区当前绑定键非空                                                                  | 同上（先 PATCH 换币或清空）                                                                                                                                                           |
| 后台审核改判通过（`verifyCommunity`，仅从 `rejected` 改判时）           | 本社区绑定键非空                                                                      | `409 ADMIN_CONFLICT`，`reasonCode = ADMIN_COMMUNITY_BOUND_ASSET_TAKEN`，`holderCommunityId`                                                                                           |
| launch2 发射成功自动绑定（`launch2-meme-asset-repository`）             | 项目社区未绑定、未驳回、仍归项目方                                                    | 走既有 `conflict` 结果（不新增枚举值、不改约束），结果带 `takenByCommunityId`；lane 打 warn `LAUNCH2_COMMUNITY_BOUND_ASSET_TAKEN`（含 `instanceId`、`communityId`），发射流程不受影响 |

兜底：若仍有写入绕过上述路径撞到索引（23505 且 constraint = `communities_bound_asset_key_unique`），社区仓储同样翻成 `CommunityBoundAssetTakenError`；建社区 / 改绑定回滚后尽力再读一次持有者，读不到时 `communityId = null`。launch2 那边撞索引时整笔事务按 unavailable 失败，下一个 tick 重跑，此时预检查能看到持有者，落 `conflict`。

### E. 错误码

`COMMUNITY_BOUND_ASSET_TAKEN`：409、`conflict`、不可重试、`errors.community.boundAssetTaken`。`detailsSafe = {"communityId": "<占用社区 opaque id>" | null}`，不带名称、slug、审核状态等任何其他信息（占用者可能是对调用者不可见的 pending 社区，id 本身不可枚举出内容）。只登记在建社区、PATCH、resubmit 三条路由的 409 集合里（`boundAssetCommandErrors`），其他社区命令不变。

```json
{
  "code": "COMMUNITY_BOUND_ASSET_TAKEN",
  "category": "conflict",
  "retryable": false,
  "userMessageKey": "errors.community.boundAssetTaken",
  "correlationId": "<request id>",
  "detailsSafe": { "communityId": "6f1c2b0e-8a4d-4e7b-9c1a-2d3e4f5a6b7c" },
  "providerReferenceSafe": null
}
```

### F. 对挖矿「多绑定」分支的影响

- **结算**（`mining-settlement-repository` 取 `community_ids`，`hourly-settlement-runner` 对 `communityIds.length !== 1` 记未绑定）：查询谓词就是「未驳回」，与索引一致，迁移后 `length > 1` 不会再出现，该分支只剩防御作用，保留不删。
- **快照**（`mining-snapshot.ts` 的 `COMMUNITY_WEIGHT_AMBIGUOUS`）：输入来自 `mining-repository.listCommunityWeightInputs`，条件只有 `bound_asset_key is not null`，**不排除已驳回社区**。因此「一个已驳回社区（且有已批准权重）+ 一个活跃社区绑同一币」仍会触发 ambiguous。要让该分支也只剩防御作用，需要在该查询加 `verification_status <> 'rejected'`（属挖矿侧文件，本批不改，交合并 / S300 处理；附录 D 第 2 条「只认已验证」若落地也会覆盖这里）。

## 4. Consequences

- 需求方附录 A 第一行变为「是」：三处入口 + resubmit / 改判都查重，数据库兜底。
- 迁移会改写存量数据（只清重复者的绑定）；staging 执行后应从迁移日志核对被解绑名单（预期至少 `mock-vol-01` 与 `builders-guild` 之一）。种子脚本 `ops/seed-mock.sh` 若再给多个社区绑同一币会在建社区时报 409，需要同步改成一币一社区。
- App 需要给 `errors.community.boundAssetTaken` 补文案（建社区 / 编辑社区 / 重新提交三处）；后台审核页需要认 `ADMIN_COMMUNITY_BOUND_ASSET_TAKEN`。

## 5. Verification

- `test/community-bound-asset-unique.integration.test.ts`：迁移清理（保留者顺序、rejected 不动、NOTICE 文案与顺序、审计行）、索引行为、建社区 / 改绑定 / resubmit / 改判冲突与持有者 id、被驳回社区不占位、并发两建只成一个。
- `test/mining-launch2-followups.integration.test.ts`：launch2 自动绑定冲突走 `conflict` + warn，已驳回持有者不挡绑定。
- `test/community-bound-asset-unique-migration.test.ts`、`test/v2-community-routes.test.ts`（409 映射与 detailsSafe）、`test/v2-error-contract.test.ts`（错误码表）。
