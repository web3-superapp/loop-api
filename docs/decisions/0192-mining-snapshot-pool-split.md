# 决策 0192：快照算力按「代币池 / NFT 池」拆分（S323-api）

- 状态：已采纳（S323-api），仅 Development / BSC Testnet
- 日期：2026-10-28
- 基线：`e5c368c`（integration/v2）
- 依据：产品裁决 2026-10-28——App 分开显示「代币算力」（持仓 × 币权重）与「NFT 算力」（NFT 数 × 社区系数）；客户端 loop-mobile `62c1129c`（决策 0253，TF 55）已落可选键并在缺省时回退上一结算小时。

## 1. 事实与选择

- 快照矿池部分（决策 0187，`mining-pool-snapshot.ts`）把每个 NFT 的算力加进其 MEME 行的 `power`；拆分**此前没有持久化**。
- 读时重算需要重读 `[at, at+1)` 的结算事实并重跑 `prepareMiningHour` + `settleMiningHour`：每次读一遍链上事实，且事实（会员、钱包归属）可能在快照之后变化，不能保证与已存 `power` 同源。
- 因此选**持久化**：迁移 `000104_mining_snapshot_nft_power` 给 `mining_snapshot_powers` 加可空列 `nft_power`（decimal 文本，`0 <= nft_power <= power`）。写快照时同一次计算顺手写入，读时只多一次按 `(owner, snapshot)` 索引的行读。

## 2. 写入规则

| 行来源                           | `nft_power`                                            |
| -------------------------------- | ------------------------------------------------------ |
| 矿池部分（平台 MEME）            | 该账号该 MEME 的 NFT 算力合计（并入 `power` 的那部分） |
| 公式路径（外部代币、旧公式资产） | `"0"`                                                  |
| 0192 之前写入的行                | `null`（不改写历史）                                   |

## 3. `/v2` 新可选键（开关 `MINING_POOL_SPLIT_EMIT=off|on`，默认 off）

- `GET /v2/mining/summary`：顶层 `assetPower`、`nftPower`。`nftPower = Σ 行 nft_power`，`assetPower = power − nftPower`，十进制字符串精确运算，`assetPower + nftPower = power.value`（数值相等；`power.value` 可能带 PostgreSQL numeric 尾随 0，两个新键为规范形）。
- `GET /v2/mining/assets`：`included[].nftPower`，即该行 `power` 中的 NFT 部分；无 NFT 的行为 `"0"`。
- 不发：`power` 为 `unavailable` 时；快照任一行 `nft_power` 为 null（0192 之前的快照）时；行合计与 `power` 不等时（不猜）。客户端此时回退上一结算小时。
- 为什么要开关：已发版客户端（TF ≤ 54）的 mining codec 是**严格键集**（`strictMapWithOptional`），未知键整包拒绝；62c1129c 起才认识这三个键。开关默认 off 时两个响应逐字节不变；主代理确认受支持的客户端都 ≥ 62c1129c 后在 staging 开。
- 全网拆分（`networkAssetPower` / `networkNftPower`）**不做**：快照只存 `total_power`，全网拆分要对整张快照行做聚合（不是现成值），且当前客户端键集不认识这两个键，发了会整包拒绝。需要时可在 `mining_snapshots` 加列由 worker 写入，另开批次。

## 4. 不变

`power` / `networkPower` / `totalPower` / 行 `power` 及其余键不变；小时结算侧已有 `asset_total_power` / `nft_total_power`，不动。迁移回滚只删列与约束。
