# 决策 0189：算力名单——外部代币社区人工放行、名单成为唯一口径；放行的主网代币进小时结算（S316-api + S317-api）

- 状态：已采纳（S316-api + S317-api），仅 Development / BSC Testnet
- 日期：2026-10-27
- 基线：`b24825b`（integration/v2，已含 0187 及附录 A）；S317 合并 `integration/v2` 的 S316a（决策 0188 社区榜 `avatarRef`）
- 编号：S316 起草时用 0188，与 S316a（`0188-rank-community-avatar-ref.md`）撞号，本篇改为 0189；代码注释里的「Decision 0188」凡涉及外部代币 / 名单的，均已改为 0189。
- 依据：需求方 2026-10-27 晚确认、用户裁决：已审核且绑定外部代币（非平台 MEME）的社区也进名单，默认不参与，运营勾选并填权重 / 系数、审核员批准后才计算力；名单（已批准参数版本）是参与与否、币权重、系数的唯一口径。S317：用户拍板「BSC 上已发行的 MEME 来 LOOP 建社区也给算力」——放行的外部代币社区成员既有快照算力，也在小时结算里分 LOOP。
- 修订：决策 0187 §2「非候选资产规则不变」与附录 A「非矿池社区按 `community_mining_weights` 旧规则」**退役**——所有已审核且绑定代币的社区都是名单候选，旧表保留不删，读路径不再使用。0183（只认已验证社区、成员门槛）、0184（钱包口径开关，默认 false）、0125（`quantity` 口径）不变。
- 范围：参数文档一个可选键；名单 SQL / 纯函数；社区页、社区站位、发现页排序、小时社区榜、结算、快照的读路径；后台 `GET /admin/v1/mining/pool` 加 `kind`、`settleable`、`settleableReasonCode`。**无迁移**；`/v2` 键集不变（`avatarRef` 属 0188）。

## 1. 名单行

| `kind`     | 定义                                                                                    | 默认   | 参与                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `platform` | 已验证社区，`bound_asset_key` = 某个 `launch2_instances` 的 MEME（任何链）              | 参与   | 资产不在 `excludedAssets`、社区不在 `excludedCommunities`（同 0187）                 |
| `external` | 已验证社区，`bound_asset_key` 非空且不是任何 launch2 MEME（通常 `eip155:56:` 主网资产） | 不参与 | 资产在 `includedAssets`，且资产不在 `excludedAssets`、社区不在 `excludedCommunities` |

- 币权重：参与时 = `assetWeights` 显式值，没有 = 1；不参与 = 0（外部行即使 `assetWeights` 有值也不算——权重与参与分离）。
- NFT 系数：同 0187（外部代币社区没有平台 NFT，实际不产生 NFT 算力）。
- 算力口径不变：持币数量 × 币权重 + NFT 数 × NFT 系数（`assetPowerBasis = quantity`），不按美元。
- 无已批准的 `quantity` 参数版本时名单为空：**没有任何社区有权重**（旧表不再兜底）。此时社区页 `weight` 的原因码是 `COMMUNITY_WEIGHT_PENDING_REVIEW`——fail-closed，但语义偏「等审核」，实际含义是「还没有已批准的名单版本」；不新增原因码（客户端只认已有码），后台看名单页即可区分。

## 2. 参数文档（`hourly-settlement-contract.ts`）

| 键               | 类型        | 约束                        | 缺省 |
| ---------------- | ----------- | --------------------------- | ---- |
| `includedAssets` | `assetId[]` | ≤ 500，唯一，`eip155:N:0x…` | `[]` |

- 与 0187 的 `excludedAssets / excludedCommunities` 对称；旧文档缺键视为空，解析结果排序去重；格式错误 → 422 `ADMIN_MINING_PARAMETERS_INVALID`（`field = includedAssets`）。
- 草稿校验：`assetWeights ∪ excludedAssets ∪ includedAssets` 的资产须有 launch2 / MEME v1 来源；**例外**：在 `includedAssets` 里的资产（含同时写在 `assetWeights` 的）只要有已验证社区绑定即可（`findVerifiedBoundAssetIds`）。否则 422 `MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN`。

## 3. 读路径清单（全部走 `src/database/mining-pool-roster-sql.ts` 的 `pool_roster` 或 `src/features/mining/mining-pool-roster.ts`）

| 读路径                                                                                                 | 位置                                                   | 0189 之后                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 社区页 `weight`（`getCommunityWeight`）                                                                | `mining-repository.ts`                                 | 只读名单；名单外 → `pending_review`；不参与 → `MINING_POOL_EXCLUDED`                                                                                                                                                                                                |
| 社区站位 / `/v2/communities/{id}` `miningPower`（`communityStandingsSql`）                             | `mining-repository.ts`                                 | 只有参与的名单社区；去掉 `community_mining_weights` 分支                                                                                                                                                                                                            |
| 发现页 `sort=miningPower`                                                                              | `community-repository.ts`                              | 同上                                                                                                                                                                                                                                                                |
| 小时社区榜 / 我的最好社区（`epochCommunityStandingsSql`）                                              | `mining-repository.ts`                                 | 0189 规则的小时（摘要有 `poolRosterRule` 或 `poolExternalAssetIds`）：只有该小时参数版本下参与的名单社区，`weight` = 币权重。**更早的小时保持 0187 投影**（见 §6）                                                                                                  |
| 快照社区因子 / `/v2/mining/assets.excluded` 原因（`listCommunityWeightInputs` → `selectMiningWeight`） | `mining-repository.ts`、`mining-snapshot.ts`           | 行来自名单（`source: roster`）：参与 → 名单币权重**直接作为**资产权重；**S317：不再要求快照公式 `assetWeights` 有该资产**（后台没有公式编辑页）；不参与 → 跳过，`MINING_POOL_EXCLUDED`；没有名单绑定的资产仍按公式权重（无 → `MINING_ASSET_WEIGHT_NOT_CONFIGURED`） |
| 快照 lane 价格读取                                                                                     | `mining-snapshot-worker.ts`                            | 只给「有权重」的资产读价（公式权重或参与的名单资产）；不参与的名单资产不读价。S317：名单资产取不到参考价 → 该资产以价格原因码**跳过**（不再让整次快照 `incomplete`）——`quantity` 口径下价格只展示、不进算力                                                         |
| 快照个人算力的成员门槛                                                                                 | `mining-repository.ts` `listBalanceInputs`             | 0183 起已在 SQL：已验证社区绑定的资产（platform + external）只返回该社区创建者或非 banned 成员的余额行；非成员的余额行不进快照（算力 0，静默排除，0183 未设原因码，沿用）                                                                                           |
| 快照矿池部分                                                                                           | `mining-snapshot-worker.ts`、`mining-pool-snapshot.ts` | 只取 `kind = platform`；外部资产不进矿池部分的事实读取                                                                                                                                                                                                              |
| 小时结算                                                                                               | `hourly-settlement-runner.ts`                          | 见 §4、§5                                                                                                                                                                                                                                                           |

`community_mining_weights` 仍被后台写路径使用（社区权重审核、旧「快照系数」草稿的冻结复制、批准写入），只是不再被以上读路径读取。

## 4. 结算的外部集合

- runner 读全部候选（不限链）：本链 `platform` 行 = `poolAssetIds`（同 0187）；`external` 行（任何链）∪ 各版本 `includedAssets` 中非平台 MEME 的资产 = 受控外部集合（`miningPoolExternalFor`）。
- 外部资产在有效权重表里：未放行 → 删除（即使 `assetWeights` 有值）；放行 → 显式值或 1；只有结算**读得到**的才保留。S317 起「读得到」（`miningPoolSettleability`）=
  - 本链 MEME v1（`settlementSource = meme_v1`，读 `meme_trades`）；或
  - **`erc20`**：资产在 `assets` 登记且未 `blocked`，且其链有 `erc20_transfer` lane 的 checkpoint（BSC 主网代币即此类，任何链，不要求与结算链相同）。
- `input_summary` 在有外部集合时记 `poolExternalAssetIds` / `poolExternalReadableAssetIds`；回放用存下的集合。没有外部候选时切片与 0187 逐字节相同。
- 读事实时外部资产走「宽松」路径：没有来源 / lane 滞后 → 该资产记进 `excludedAssets`（带原因码）离开本小时，**不让整小时失败**（平台 MEME 照常结算）；非外部资产没有来源仍是整小时 `MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN`（原规则）。

## 5. `erc20` 持仓来源（S317，核心）

**口径**：每个用户在该资产上的持仓 = 其计入钱包（内置 + 已绑定外部钱包；`MINING_EMBEDDED_WALLET_ONLY=true` 时只算内置，同 0184；`status = active` 且 `first_seen_at` 早于小时末）的余额之和，按小时内时间加权（与平台 MEME 相同的分段计算），再过 0183 成员门槛。

**只读谁**：该小时内是该资产绑定的已验证社区成员（`community_membership_history` 区间与小时相交）或创建者的用户的钱包——非成员本来就被 0183 门槛归 0，不读。

**每个钱包地址**（`mining-settlement-repository.ts` `erc20Facts`）：

1. 覆盖起点 `c` = `indexer_wallet_coverage(chain, 'erc20_transfer', address).from_block_number`；没有 → 未知 `MINING_EXTERNAL_BALANCE_UNCOVERED`。
2. 期初读数 = 该地址在该资产上**最近一条** `wallet_balance_snapshots`（`source = 'chain'`，`observed_at` 早于小时开始），且其块号 `b ≥ c − 1`（保证 `b` 之后该地址的转账都已被索引）；没有 → 未知 `MINING_EXTERNAL_OPENING_MISSING`。回放时不重新挑，直接读摘要里钉住的 `(walletId, blockNumber)` 行。
3. 期初余额 = 读数 + `indexed_transfers` 中块号 `> b`、`observed_at` 早于小时开始、未 `removed` 的净流入；小时内变动 = 块号 `> b`、`observed_at ∈ [小时开始, 小时末)` 的转账，时间点取 `observed_at`（秒）。块号 `≤ b` 的转账已含在读数里，不重复计。
4. 期初或滚动过程出现负数 → 未知 `MINING_EXTERNAL_BALANCE_INCONSISTENT`（有 lane 没看见的转账）。
5. 某用户**任一**计入钱包是未知 → 该用户该资产本小时算力 **0**（不猜、不用其它钱包部分值）。

**回放保证**：摘要记 `externalOpeningPins[] = {assetId, walletId, blockNumber}`（每个已知地址用的读数行）、`externalUnknownHolders[] = {assetId, reasonCode, userCount}`、`externalStaleAssetIds[]`（若有）。回放用钉住的读数行 + 同一过滤条件读转账；之后写入的读数（`observed_at` 晚于小时）和之后观察到的转账（`observed_at` 晚于小时末）都不在读取范围内，digest 不变。

**误差边界 / 限制**（如实）：

- `indexed_transfers` 没有区块时间，小时归属用 lane 的 `observed_at`（入库时间）。lane 正常时滞后 = 确认数 + 一个 tick（秒级）；**lane 停摆后追赶**期间的转账会被记到追赶时刻所在的小时（停摆时长即误差上限）。就绪门槛只看 checkpoint `updated_at`，判断不出「在追赶但已在 tick」。
- reorg 重放会把重放行的 `observed_at` 刷成新时间（`on conflict do update`），被重放的转账若跨过小时边界，回放 digest 会不一致（回放报告会标出，不静默）。
- 钱包解绑期间 lane 不索引该地址，重新绑定后 `indexer_wallet_coverage` 不重写：若期初读数早于解绑，解绑期间的转出不会被看见 → **可能高估**（解绑 → 转走 → 重绑）。下一次该钱包余额被读取（用户打开钱包页即写一条读数）后自动纠正。是否要加「读数最长有效期」由主代理决定（见 §9）。
- 读数只在用户打开钱包页时写入：从未被读过的钱包 → `OPENING_MISSING` → 该用户本资产 0，直到有一次读数。
- 资产在登记表中被 `blocked` 再解封期间，lane 不索引其转账：同上限制（极少见）。

**就绪门槛**（`readIndexerFreshness`）：外部 `erc20` 资产按链列出 `erc20_transfer` lane（带 `externalAssetIds`）；`updated_at < 小时末 + indexerGraceSeconds` → 这些资产本小时记 `MINING_SETTLEMENT_SOURCE_STALE` 并跳过，平台 MEME 与 NFT 照常结算（不再 `INDEXER_BEHIND` 整小时等待）。launch2 / meme lane 的门槛不变。

## 6. 历史小时榜不追溯改写

`epochCommunityStandingsSql` 按该 epoch 的 `input_summary` 选投影：有 `poolRosterRule`（S317 起每个新结算小时都写 `"participating"`）或 `poolExternalAssetIds` → 只排参与的名单社区；都没有（0189 部署前结算的小时）→ 0187 投影：所有绑定社区（除被取消勾选的平台 MEME），平台行显示币权重，其它显示 NFT 系数。

## 7. 后台 `GET /admin/v1/mining/pool`

- 每行 `kind`（`platform` | `external`）；外部行 `instanceId` / `launchId` 为 `null`，`symbol` 为资产登记符号或 `null`，`memeAddress` 为代币地址。新 query `kind=platform|external`。保存折算：外部行勾选 → `includedAssets`；取消 → 从 `includedAssets` 与 `assetWeights` 移除（**不进** excluded）。
- S317 新增 `settleable: boolean` 与 `settleableReasonCode: "MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN" | null`：结算链（`LAUNCH_CHAIN_ID`）上的平台 MEME / MEME v1、或任何链上的 `erc20` 外部代币为 `true`；否则 `false`（只有快照算力，不分 LOOP）。文档：`docs/frontend-admin-mining-pool-api.md`。

## 8. 部署顺序、空窗与回滚（硬约束）

1. 先部署 api + admin（同一批次）。部署后、新版本生效前：
   - **小时结算**：旧版本没有 `includedAssets`，外部集合全部不参与。受影响的**只有**「原靠 `assetWeights` 进结算的 MEME v1 绑定社区」（0188/0189 之前它们按显式权重被结算，现在要 `includedAssets` 才算）。平台 MEME 不受影响。BSC 主网代币此前本就不进结算，无损失。
   - **快照**：所有外部代币社区（staging 上 S316 审查列出的 BSC 链上快讯、Builders Guild、DeFi 早读会、Meme 观察室、Launch 候选池等）立即不参与——社区页 `MINING_POOL_EXCLUDED`、不入社区榜、快照跳过。
2. 立刻在后台「算力名单」勾选需要放行的外部行并保存草稿，审核员批准，`effectiveFrom` 设为**最近的下一个整点**。空窗 = 部署时刻到该整点（≤ 1 小时 + 审批耗时）。批准前先确认新代码在 staging 运行正常（结算 lane 有一个整点正常结算、名单页可读）——批准之后不能再回滚代码（见 4）。
3. 部署前在 staging 跑下面的查询，列出会在空窗里断结算的 MEME v1 绑定社区（本机 dev 库查询结果为 **0 行**：dev 没有绑定 MEME v1 的社区；staging 库 = dev 导入，预计同为 0，需部署前现场确认）：

   ```sql
   select c.community_id, c.name, c.bound_asset_key
   from communities c
   join meme_tokens t on t.chain_id || ':' || t.token_address = c.bound_asset_key
   where c.verification_status = 'verified'
     and not exists (select 1 from launch2_instances i
       where i.chain_id || ':' || i.meme_address = c.bound_asset_key);
   ```

4. **回滚硬约束**：旧代码（`b24825b` 及更早）的 `parseMiningParameterDocument` 对未知键直接报错，而 `listApprovedParameterVersions` 会解析**所有**已批准版本——只要库里存在任何一条含 `includedAssets` 的已批准版本，旧代码的结算、参数页、名单页全部失败；已批准版本不能撤回（撤回只对 `pending_approval`），再批准一个不含该键的新版本也救不回来。因此：**在仍可能回滚的窗口内，不得批准含 `includedAssets` 的版本**；一旦批准，只能前滚修复，不能回滚代码。0188 原文「回滚后撤回该版本」不成立，作废。
5. 无迁移，无数据回填；`erc20` 结算依赖 `erc20_transfer` lane 在主网运行且钱包被读过余额——lane 停摆时外部资产每小时记 `MINING_SETTLEMENT_SOURCE_STALE`，不影响平台结算。

## 9. 原因码（只进 `input_summary` / 后台，不进 `/v2` 客户端块）

| 码                                       | 层级               | 含义                                                                  |
| ---------------------------------------- | ------------------ | --------------------------------------------------------------------- |
| `MINING_SETTLEMENT_SOURCE_STALE`         | 资产 × 小时        | 外部资产所在链的 `erc20_transfer` lane 未在小时末 + 宽限后 tick       |
| `MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN` | 资产 × 小时 / 行   | 外部资产没有持仓来源（结算时被移出该小时；后台行 `settleable=false`） |
| `MINING_EXTERNAL_BALANCE_UNCOVERED`      | 用户 × 资产 × 小时 | 该用户某钱包地址没有 lane 覆盖记录                                    |
| `MINING_EXTERNAL_OPENING_MISSING`        | 用户 × 资产 × 小时 | 没有覆盖起点之后、小时开始之前的余额读数                              |
| `MINING_EXTERNAL_BALANCE_INCONSISTENT`   | 用户 × 资产 × 小时 | 滚动余额为负                                                          |

需要主代理决定：(a) 是否给期初读数加最长有效期（如 7 天）以收窄「解绑 → 转走 → 重绑」高估；(b) lane 停摆追赶期间的小时是否改为「等待」而不是「跳过外部资产」（当前按派单：跳过）；(c) 是否要给 transfer lane 加区块时间列（需迁移 + 索引器改动）以消除 `observed_at` 误差。

## 10. 测试

- `test/mining-external-erc20.test.ts`：`settleable` / 可读判定；`erc20` 时间加权结算；用户任一钱包未知 → 该资产 0 + 摘要计数；成员门槛；未放行不计；lane 滞后 → 外部资产 `SOURCE_STALE`、平台照常、回放同样；launch2 lane 滞后仍整小时等待；钉住读数回放；快照名单资产免公式权重、无价跳过、无绑定资产仍需公式权重。
- `test/mining-external-erc20.integration.test.ts`（PostgreSQL）：候选 `settlementSource = erc20`；期初读数 + 小时前转账 + 小时内转账（块号 ≤ 读数块与 removed 行被忽略）→ 313.5；未覆盖 / 无读数 / 读数早于覆盖 → 0 与原因码；之后新读数不影响回放；lane 滞后 → 跳过外部、平台 300；快照余额成员门槛；历史 epoch 保持 0187 榜单投影。
- S316 既有：`test/mining-pool-roster.test.ts`、`test/mining-pool-roster.integration.test.ts`、`test/admin-mining-settlement-routes.test.ts`（含 `settleable`）、受影响的旧集成测试改为批准名单版本。
