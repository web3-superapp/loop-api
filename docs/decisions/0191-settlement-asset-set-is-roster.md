# 决策 0191：小时结算的可结算资产集合 = 算力名单（S321-api）

- 状态：已采纳（S321-api），仅 Development / BSC Testnet
- 日期：2026-10-28
- 基线：`4a3a644`（integration/v2）
- 依据：决策 0187 / 0189「名单是唯一口径」「显示与结算同口径」「只认已验证社区」。staging 2026-10-28 实测：在用参数版本 `v2-r3`（`quantity`）的 `assetWeights` 写着 `eip155:97:0x70fec501…6666`，该资产绑定的社区 `MEME 持有人俱乐部` 为 `pending`，不在名单里。快照正确忽略它（最新 `total_power` = 7,500,001），小时结算却照样结算（最新已结算小时资产分母 10,566,500，5 个用户的自有算力全部来自该资产，另有由此派生的推荐算力）。App 算力榜（每小时总算力）与「全网算力」（快照合计）对不上。
- 修订：决策 0187 文首「名单外资产（BTCB、USDT、未绑定或 pending 社区的 MEME）沿用 0187 前规则：显式权重即计」**退役**（对 0191 之后结算的小时）。

## 1. 绕过点

不是 runner 绕过折算函数，而是折算函数本身：`miningEffectiveAssetWeights`（`src/features/mining/mining-pool-roster.ts`）以文档 `assetWeights` 全表为起点，再叠加名单默认值与外部门控；名单外的显式条目原样留在有效权重表里。`admittedAssetIds` 据此读事实、`settleMiningHour` 据此计算自有算力，推荐算力再从自有算力派生。快照的矿池部分同样经过这个函数，但最后只取 `poolAssetIds` 的行，所以快照没出错。

## 2. 新规则（`MiningSettlementAssetRule = "roster" | "document"`）

- `roster`（0191 起每个新结算小时、快照矿池部分）：`quantity` 文档的 `assetWeights` 里，资产既不是本链平台 MEME（`poolAssetIds`）也不在外部集合（`miningPoolExternalFor`：外部名单行 ∪ 各版本 `includedAssets` 中的非平台资产）→ **从有效权重表删除**：不读事实、没有持仓行、没有自有算力、没有由它派生的推荐算力。即使读事实端返回了它，`prepareMiningHour` 也丢弃。
- 于是可结算资产集合 = 名单参与行：已验证社区的平台 MEME（`assetWeights` 显式值，否则 1；`excludedAssets` → 0）+ 被 `includedAssets` 放行且读得到的外部代币（0189 §4 不变）。
- `document`（回放 0191 之前结算的小时）：原折算，名单外显式条目照算。`valuation` 文档（0116 回放）不受影响。
- 单一位置：`miningEffectiveAssetWeights(document, candidates, external, rule)` + `miningIgnoredNonRosterAssetIds`；结算 runner、`admittedAssetIds`、快照矿池部分共用。

## 3. `mining_epochs.input_summary`

- 新键 `ignoredNonRosterAssetIds: string[]`（排序去重，可为空数组）：本小时各参数版本里被名单规则忽略的 `assetWeights` 资产 id，给运营排查用。
- 该键**存在**即表示该小时按 `roster` 规则结算；回放据此选规则。0191 之前的小时没有此键 → `document` 规则回放，摘要 / 奖励 / 榜单投影（`mining-repository.ts`，决策 0186/0187/0189 §6）一律不改写。
- 无迁移；`/v2` 无新键。后台 epoch 详情的 `inputSummary` 是宽松对象，直接可见。

## 4. 「全网算力」与算力榜（评估，未改语义）

| 数字                                                   | 来源                                                                                  | 含义                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `/v2/mining` `networkPower`（App「全网算力」）         | `mining-service.ts` → 最新完整快照 `total_power`                                      | 5 分钟快照，各账号**自有**算力之和（币 + NFT），无推荐                    |
| `/v2/mining/rank`（算力榜，按小时）                    | `mining-repository.ts` `epochAccountTotalsSql`：`nft_total_power + asset_total_power` | 上一结算小时，每账号自有 **+ 5 级推荐**算力                               |
| `/v2/mining/rewards` `tracks.{nft,asset}.networkPower` | `mining_epochs.denominator_nft_power` / `denominator_asset_power`                     | 同一小时的分母 = Σ 各账号 total（逐用户同一截断），**与榜单合计精确相等** |

修复 1 之后，只要存在推荐链，榜单合计仍会大于「全网算力」（推荐算力是在自有算力之外另加的分配权重），且两者时间点不同（5 分钟 vs 上一整点小时）。

建议（最小改动，不在本批实现）：App 的「全网算力」格改读已有的 `/v2/mining/rewards` `tracks.nft.networkPower + tracks.asset.networkPower`（现有键，`awaiting_first_settlement` 时回落到 `/v2/mining networkPower` 或 `—`）。这与相邻的「上一小时算力」同源同口径，无需 `/v2` 改动。不改服务端 `networkPower` 的原因：它与 `power`（快照自有算力）和 `estimatedToday = budget × power ÷ networkPower` 成对，换成含推荐的小时分母会让估算份额和 `/v2/mining` 文档同时失真，属于语义变更。

## 5. 测试

`test/mining-pool-roster.test.ts`「Decision 0191」：名单外 `assetWeights` 资产在 `roster` 规则下不进权重表、不读事实、无持仓 / 自有 / 推荐算力、资产分母只含名单 MEME、摘要记 `ignoredNonRosterAssetIds`；`document` 规则下仍按旧行为计算；runner 结算后按存储规则回放 digest 一致；无该键的旧小时按 `document` 规则回放。
