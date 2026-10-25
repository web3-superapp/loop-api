# 决策 0183：挖矿只认已验证社区、持有人须为社区成员、只算内置钱包（S300-api）

- 状态：已采纳（S300-api），仅 Development / BSC Testnet
- 日期：2026-10-25
- 基线：`d1a32d9`（merge S297）
- 依据：需求方 2026-10-25 裁决，`docs/48-算力计算公式说明-2026-10-25.md` 附录 D 第 2 / 3 / 4 条及第 5 条的 API 侧校验；决策 0116（小时结算）、0123（按数量计）、0125 / 0126（快照按数量、毕业币）。
- 范围：迁移 `000101_community_membership_history`；结算事实读取、runner 切段、快照余额输入与社区权重输入；后台挖矿参数草稿 / 批准校验；新增后台错误码 `MINING_COMMUNITY_UNKNOWN`；草稿响应可选键 `skippedCommunityIds`；`ops/seed-mock.sh` 的 mock 钱包改为 embedded。不新增 `/v2` 路由或键，App 接口形状不变。
- 并行：S299-api / 决策 0182（迁移 000100，一币一社区唯一约束），已合并进本分支。本决策以「一个 MEME 最多被一个未拒绝社区绑定」为前提，但多绑定防御分支保留。

## 规则

| #   | 规则                                                                                                                                 | 结算（小时）                                                                                                              | 快照（5 分钟）                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| R1  | 只认 `verification_status = 'verified'` 的社区绑定                                                                                   | NFT 归属社区只取已验证社区（原来是「非 rejected」）；待审核社区「挂名绑定」同一 MEME 不再让 NFT 变成未绑定                | 候选社区（`listCommunityWeightInputs`）只取已验证社区；待审核社区的绑定不再让该币被剔除 |
| R2  | 持有人须在小时内是该社区成员，按秒切段                                                                                               | NFT 轨：持有区间 ∩ 持有人在 NFT 所属已验证社区的成员区间；币轨：持有区间 ∩ 持有人在「绑定该 MEME 的已验证社区」的成员区间 | 余额行只在持有人当前是绑定该币的已验证社区成员时计入                                    |
| R2′ | **没有任何已验证社区绑定的币，不要求成员**（没有社区可加），按原样计入                                                               | 同左                                                                                                                      | 同左                                                                                    |
| R3  | 只算内置钱包 `account_wallets.kind = 'embedded'`（**决策 0184 起为开关 `MINING_EMBEDDED_WALLET_ONLY`，默认关 = 内置 + 外部都计入**） | 地址归属只看 embedded 且 active 的钱包；外部钱包（Reown / WalletConnect 连接）上的持有视为未归属                          | 余额输入只取 embedded 钱包                                                              |
| R4  | 挖矿参数社区系数必须是存在且已验证的社区                                                                                             | 草稿保存与批准时校验，不满足 422 `MINING_COMMUNITY_UNKNOWN`                                                               | —                                                                                       |

补充口径：

- 「成员」= `community_memberships` 中 status 不是 `banned` 的行（与 `communities.member_count` 同一口径）：`active`、`muted` 是成员，`banned` 不是。
- 社区创建者（`communities.created_by_user_id`）自社区创建时起视为成员，不论是否有 membership 行（开发库 44 个社区里 43 个是种子数据，没有群主 membership 行）。群主通过正常建社区流程本来就有 `role = owner` 的行，同样被历史表覆盖。
- 多绑定防御：同一 MEME 被两个以上已验证社区绑定时，NFT 仍按 0116 / 0123 规则记为未绑定（系数 0，不切段）；币轨要求持有人是其中任一社区的成员。
- 邀请加成只取下级「本人算力」，所以门槛切掉的本人算力自然不再产生邀请加成。
- NFT 实例没有已验证社区时仍为「未绑定」（系数 0），不切段。

## 成员资格历史（迁移 000101）

`community_memberships` 只保存当前状态：离开是删行（`community-repository.ts` `leaveCommunity` 的 `delete`），封禁是改 status。无法回答「第 t 秒是不是成员」，所以新增历史表：

| 列                                                  | 说明                                                            |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `history_id` uuid PK                                |                                                                 |
| `community_id` → `communities`，`on delete cascade` |                                                                 |
| `user_id` → `loop_users`，`on delete cascade`       |                                                                 |
| `joined_at` timestamptz not null                    | 区间起点                                                        |
| `left_at` timestamptz null                          | 区间终点（不含）；null = 仍是成员；check `left_at >= joined_at` |
| `source` `trigger` \| `backfill`                    |                                                                 |
| `created_at`                                        |                                                                 |

- 部分唯一索引 `(community_id, user_id) where left_at is null`：每人每社区最多一个未结束区间。另有 `(community_id, joined_at, left_at)`、`(user_id, community_id)` 索引。
- 只由触发器 `community_memberships_history`（`after insert or update of status or delete`）维护，覆盖所有写入方（加入、建社区、离开、封禁、解封、种子脚本）：
  - 插入非 banned 行 → 开区间，起点 `least(new.joined_at, clock_timestamp())`；
  - banned → 非 banned → 开区间，起点 `clock_timestamp()`；
  - 非 banned → banned，或删除 → 关闭开区间，`left_at = clock_timestamp()`。
- 回填：迁移时现有每条非 banned membership 回填一行（`joined_at` 为原行的 `joined_at`，`source = 'backfill'`）。迁移之前的离开记录无法还原。
- 创建者不写入历史表，由查询本身覆盖（见上）。
- `scripts/dev-reset-users.ts` 把该表归为 `user` 类并在删 membership 前删除。

## 结算实现

- `readSettlementFacts`（`src/database/mining-settlement-repository.ts`）：
  - NFT 实例社区：`c.verification_status = 'verified'`；
  - 地址归属：`status = 'active' and kind = 'embedded'`；
  - 新事实 `membershipGate = { assetCommunities, memberships }`：被读 MEME（每个 launch2 实例的 MEME + 准入资产）的已验证社区，以及这些社区与本小时重叠的成员区间（历史表 ∪ 创建者自 `created_at` 起的开区间）。秒取整保守：起点 `ceil`、终点 `floor`。
- `prepareMiningHour`（`src/features/mining/hourly-settlement-runner.ts`）：对每个已归属的 NFT / 币持有分段，与对应社区的合并成员区间求交，只把交集段交给计算器。计算器、摘要算法（`miningInputDigest`）不变；当所有持有人整小时都是成员时，输入与摘要和 S300 之前完全相同。
- `input_summary` 新增 `membershipGate: "verified_member_embedded"`（决策 0184 起改为 `"verified_member"`，钱包口径另记 `walletKinds`）与 `membershipGatedSegmentCount`（被切掉或部分切掉的分段数）。
- 没有 `membershipGate` 的事实集（S300 之前写的测试夹具）按旧规则准备，用于保持 0123 黄金回放测试（摘要 `aa63cd33…fb3b`）不变；仓储层从 S300 起总是提供该事实。

### 回放说明

回放从当前数据重新读取事实（这一点自 0116 起就是如此）。S300 部署前已结算的小时，如果当时有非成员、外部钱包或待审核社区绑定参与，回放会显示 `digestMatches: false` / 奖励不一致——这是规则变化的预期结果，不改历史账本。

## 快照实现

`src/database/mining-repository.ts`：

- `listCommunityWeightInputs`：加 `c.verification_status = 'verified'`。
- `listBalanceInputs`：加 `w.kind = 'embedded'`；并且余额行满足「该资产没有已验证社区绑定」或「持有人是某个绑定该资产的已验证社区的创建者或非 banned 成员」才返回（快照是当前态，直接读 `community_memberships`）。

## 后台挖矿参数（R4）

- 草稿 `POST /admin/v1/mining/parameter-versions`：解析后对 `communityCoefficients[].communityId` 调 `findUnverifiedCommunityIds`；不存在或非 verified → 422。
- 批准 `POST /admin/v1/mining/parameter-versions/{versionId}/approve`：在批准事务内重新校验（社区可能在草稿后被拒绝），失败 → 422，版本保持 `pending_approval`，审计 `mining.parameters.approve.failed` 的 `reasonCode = MINING_COMMUNITY_UNKNOWN`。
- 错误体（七字段信封）：

```json
{
  "code": "MINING_COMMUNITY_UNKNOWN",
  "category": "validation",
  "retryable": false,
  "userMessageKey": "errors.admin.miningCommunityUnknown",
  "correlationId": "…",
  "detailsSafe": {
    "reasonCode": "MINING_COMMUNITY_UNKNOWN",
    "field": "communityCoefficients",
    "unknownCommunityIds": ["0d6e4b8c-1f2a-4b3c-8d4e-5f6a7b8c9d0e"]
  },
  "providerReferenceSafe": null
}
```

`AdminErrorDetailsSafe` 的值类型因此放宽为可含 `readonly string[]`（只有这一处使用数组）。

- 「冻结复制」（草稿未传 `communityCoefficients` 时复制已批准的快照社区权重）：复制前过滤掉非 verified 社区；若有被跳过的，201 响应额外带可选键 `skippedCommunityIds: string[]`（为空时不出现，旧客户端可忽略）。

## 种子脚本

`ops/seed-mock.sh`：mock 账号钱包改为 `kind = 'embedded'`，`provider_wallet_id = 'mock-seed.' || md5(...)`（满足 embedded 必须有 provider_wallet_id 的检查）；已有的 mock external 钱包用一条 update 改为 embedded。脚本未运行。

## 与决策 0182（S299，一币一社区）合并后的调整

- 迁移头为 000101（000100 之后）；`schema.ts` 与所有断言迁移头的测试都以 000101 为准。
- 快照 `setCommunityWeight` 的「一币一次」冲突检查排除 `rejected` 社区（已驳回社区不占用代币）；在一币一个未拒绝社区的前提下，该冲突分支、结算 runner 的 `communityIds.length !== 1` 分支、快照 `COMMUNITY_WEIGHT_AMBIGUOUS` 分支都只剩防御作用（代码注释引用 0182）。
- `ops/seed-mock.sh` 的 `mock-vol-01` 从 USDT 改绑 LTC（BSC-peg `0x4338665cbb7b2485a8855a139b75d5e34ab0db94`），避免与 staging builders-guild 的 USDT 绑定撞唯一索引；该币需先 `pnpm asset:register` 才能跑 `--holdings`。

## 跟进

- loop-mobile：文案「持仓即算力」需补充「须加入社区」「只算 LOOP 内置钱包」「只认已验证社区」；`docs/47 §7.3` 那条「未通过审核的社区没有权重」现在对结算也成立。App 接口无变化。
- loop-admin：处理 `MINING_COMMUNITY_UNKNOWN`（草稿与批准两个入口，读 `detailsSafe.unknownCommunityIds` 标红对应行）；可选展示 `skippedCommunityIds`；社区系数改为从已验证社区列表选择（附录 D 第 5 条）。
- 部署：000100（S299）与 000101 必须按序执行。曾在合并 S299 之前单独执行过 000101 的库（只有本批次的临时测试库）需要重建。
