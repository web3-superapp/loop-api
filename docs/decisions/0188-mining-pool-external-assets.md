# 决策 0188：算力名单——外部代币社区人工放行，名单成为唯一口径（S316-api）

- 状态：已采纳（S316-api），仅 Development / BSC Testnet
- 日期：2026-10-27
- 基线：`b24825b`（integration/v2，已含 0187 及附录 A）
- 依据：需求方 2026-10-27 晚确认、用户裁决：已审核且绑定外部代币（非平台 MEME）的社区也进名单，但默认不参与，运营勾选并填权重 / 系数、审核员批准后才计算力；名单（已批准参数版本）是参与与否、币权重、系数的唯一口径。
- 修订：决策 0187 §2「非候选资产规则不变」与附录 A「非矿池社区按 `community_mining_weights` 旧规则」**退役**——所有已审核且绑定代币的社区都是名单候选，旧表保留不删，读路径不再使用。0183（只认已验证社区、成员门槛）、0184（钱包口径开关，默认 false）、0125（`quantity` 口径）不变。
- 范围：参数文档一个可选键；名单 SQL / 纯函数；社区页、社区站位、发现页排序、小时社区榜、结算、快照的读路径；后台 `GET /admin/v1/mining/pool` 加 `kind`；`/v2/mining/rank` 社区行一个可选键（客户端先行）。**无迁移**，不新增 reasonCode。

## 1. 名单行

| `kind`     | 定义                                                                                    | 默认   | 参与                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `platform` | 已验证社区，`bound_asset_key` = 某个 `launch2_instances` 的 MEME（任何链）              | 参与   | 资产不在 `excludedAssets`、社区不在 `excludedCommunities`（同 0187）                 |
| `external` | 已验证社区，`bound_asset_key` 非空且不是任何 launch2 MEME（通常 `eip155:56:` 主网资产） | 不参与 | 资产在 `includedAssets`，且资产不在 `excludedAssets`、社区不在 `excludedCommunities` |

- 币权重：参与时 = `assetWeights` 显式值，没有 = 1；不参与 = 0（外部行即使 `assetWeights` 有值也不算——权重与参与分离）。
- NFT 系数：同 0187（外部代币社区没有平台 NFT，实际不产生 NFT 算力）。
- 算力口径不变：持币数量 × 币权重 + NFT 数 × NFT 系数（`assetPowerBasis = quantity`），不按美元。
- 无已批准的 `quantity` 参数版本时名单为空：**没有任何社区有权重**（旧表不再兜底）。

## 2. 参数文档（`hourly-settlement-contract.ts`）

| 键               | 类型        | 约束                        | 缺省 |
| ---------------- | ----------- | --------------------------- | ---- |
| `includedAssets` | `assetId[]` | ≤ 500，唯一，`eip155:N:0x…` | `[]` |

- 与 0187 的 `excludedAssets / excludedCommunities` 对称；旧文档缺键视为空，解析结果排序去重；格式错误 → 422 `ADMIN_MINING_PARAMETERS_INVALID`（`field = includedAssets`）。
- 草稿校验：`assetWeights ∪ excludedAssets ∪ includedAssets` 的资产须有 launch2 / MEME v1 来源；**例外**：在 `includedAssets` 里的资产（含同时写在 `assetWeights` 的）只要有已验证社区绑定即可（`findVerifiedBoundAssetIds`）。否则 422 `MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN`。

## 3. 读路径清单（全部走 `src/database/mining-pool-roster-sql.ts` 的 `pool_roster` 或 `src/features/mining/mining-pool-roster.ts`）

| 读路径                                                                                                 | 位置                                                   | 0188 之后                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 社区页 `weight`（`getCommunityWeight`）                                                                | `mining-repository.ts`                                 | 只读名单；名单外 → `pending_review`；不参与 → `MINING_POOL_EXCLUDED`                                                                                                                       |
| 社区站位 / `/v2/communities/{id}` `miningPower`（`communityStandingsSql`）                             | `mining-repository.ts`                                 | 只有参与的名单社区；去掉 `community_mining_weights` 分支                                                                                                                                   |
| 发现页 `sort=miningPower`                                                                              | `community-repository.ts`                              | 同上                                                                                                                                                                                       |
| 小时社区榜 / 我的最好社区（`epochCommunityStandingsSql`）                                              | `mining-repository.ts`                                 | 只有该小时参数版本下参与的名单社区（原来任何绑定社区都入榜）；`weight` = 币权重                                                                                                            |
| 快照社区因子 / `/v2/mining/assets.excluded` 原因（`listCommunityWeightInputs` → `selectMiningWeight`） | `mining-repository.ts`、`mining-snapshot.ts`           | 行来自名单（`source: roster`）：参与 → 名单币权重**直接作为**资产权重（不再乘公式权重）；不参与 → 跳过，`MINING_POOL_EXCLUDED`；快照公式 `assetWeights` 仍决定外部资产是否被观测与取参考价 |
| 快照 lane 价格读取                                                                                     | `mining-snapshot-worker.ts`                            | 不参与的名单资产不读价格                                                                                                                                                                   |
| 快照矿池部分                                                                                           | `mining-snapshot-worker.ts`、`mining-pool-snapshot.ts` | 只取 `kind = platform`；外部资产（含 `includedAssets`）不进矿池部分的事实读取                                                                                                              |
| 小时结算                                                                                               | `hourly-settlement-runner.ts`                          | 见 §4                                                                                                                                                                                      |

`community_mining_weights` 仍被后台写路径使用（社区权重审核、旧「快照系数」草稿的冻结复制、批准写入），只是不再被以上读路径读取。

## 4. 结算

- runner 读全部候选（不限链）：本链 `platform` 行 = `poolAssetIds`（同 0187）；`external` 行（任何链）∪ 各版本 `includedAssets` 中非平台 MEME 的资产 = 受控外部集合（`miningPoolExternalFor`）。
- 外部资产在有效权重表里：未放行 → 删除（即使 `assetWeights` 有值）；放行 → 显式值或 1；但只有结算**读得到**的（本链且有 MEME v1 来源，`settlementSource = meme_v1`）才保留——BSC 主网代币不进小时结算（否则整小时 `ASSET_SOURCE_UNKNOWN`），它的算力只在快照里体现。
- `input_summary` 在有外部集合时多两个键 `poolExternalAssetIds` / `poolExternalReadableAssetIds`；回放用存下的集合；0188 之前的小时没有这两个键，回放不带外部门控，摘要与 digest 不变。没有外部候选时切片与 0187 逐字节相同。

## 5. 后台 `GET /admin/v1/mining/pool`

- 每行加 `kind`（`platform` | `external`）；外部行 `instanceId` / `launchId` 为 `null`，`symbol` 为资产登记符号或 `null`，`memeAddress` 为代币地址。其它键与分页不变。
- 新 query `kind=platform|external`（缺省全部）；游标在给了 `kind` 时绑定它（不给时与 0187 游标兼容）。`address` / `q` 对两类都生效（`q` 也匹配资产登记符号）。
- 保存折算：外部行勾选 → `includedAssets`；取消勾选 → 从 `includedAssets` 与 `assetWeights` 移除（**不进** excluded）；平台行不变。文档：`docs/frontend-admin-mining-pool-api.md`。

## 6. `/v2` 兼容

- 不新增 reasonCode：未放行 / 被移除的外部代币社区复用 `MINING_POOL_EXCLUDED`。
- S316 追加：`GET /v2/mining/rank?scope=communities` 每行加**可选键** `avatarRef`（`communities.logo_ref`，格式 `avatar:preset/community-NN` 或 `logo:media/<uuid>`，与社区接口 `logoRef` 同源同格式；空或不合格 → `null`）。users / referrals 行不变。客户端（S315）同步读取；按「新增键客户端先行」，客户端未发版前服务端已输出也不会被旧客户端拒绝——**需确认 S315 已用可选键解析后再部署**（旧客户端 codec 若严格拒绝未知键，见下「部署」）。

## 7. 部署与回滚

- 无迁移。部署后 staging 现有参数版本（v2）没有 `includedAssets`：所有外部代币社区（BSC 链上快讯、Builders Guild、DeFi 早读会、Meme 观察室、Launch 候选池等）立即**不参与**——社区页 `MINING_POOL_EXCLUDED`、不入社区榜、快照里这些资产被跳过。若要它们继续计算力，需在后台勾选、保存草稿、审核员批准新版本。
- `avatarRef` 是 `/v2` 新键：旧客户端若用严格键集解析 rank 行会拒绝，部署前确认已发版的客户端 codec 接受可选 `avatarRef`（S315）。
- 回滚：回退代码即可（无数据变化）；`includedAssets` 键留在已批准文档里，旧代码解析时会因未知键报错——回滚前不要批准含 `includedAssets` 的版本，或回滚后撤回该版本。

## 8. 测试

- `test/mining-pool-roster.test.ts`：外部行三种情况（未放行 → 0 / 放行 → 按权重 / 新版本移除 → 回到 0）、有效权重门控与可读集合、`miningPoolExternalFor`、`includedAssets` 解析、结算 runner（MEME v1 放行被结算、主网代币不读、回放用存下集合）、快照（名单权重直接作为权重、未放行 `MINING_POOL_EXCLUDED`）、快照 lane（外部资产不进矿池部分、不读价格）。
- `test/mining-pool-roster.integration.test.ts`（PostgreSQL）：外部候选与 `kind` 过滤、未放行无权重无站位（旧表 1.8 不再生效）、放行后按权重且只算成员、下一小时结算不因主网代币失败且可回放、小时榜 `avatarRef`、新版本移除后回到无。
- `test/admin-mining-settlement-routes.test.ts`：外部行默认不参与、`kind` 过滤 / 非法值 400、`includedAssets` 草稿与待批列、只写权重不放行仍 422。
- `test/v2-mining-routes.test.ts`：社区榜行 `avatarRef` 存在且格式正确 / null。
- 受影响的旧集成测试改为批准名单版本：`community-repository`、`mining-rank-hourly`、`s7-repositories`、`admin-console`（测试辅助 `test/helpers/mining-power-list.ts`）。
