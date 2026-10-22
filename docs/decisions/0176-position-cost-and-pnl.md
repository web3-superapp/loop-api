# 0176 · 持仓买入成本价与盈亏（S284，2026-10-22）

## 1. Status

已实现（分支 `feat/S284-position-cost-pnl`，基线 `integration/v2` `78c5f72`）。**无迁移**（查询时聚合，下一个迁移号仍为 000098）。无新路径。既有 `GET /v2/launch2/me/positions` 行与 `GET /v2/launch2/instances/{instanceId}` 的 `instance.viewer` 各新增 5 个**可选**键。新 env：`LAUNCH2_PNL_EMIT`（默认 `off`）。不改合约，不改 `/v1`。

## 2. Context

- 需求方 2026-10-22 反馈第 03 条：K 线页（项目详情）要显示「买入成本价」与「盈亏金额」。
- 已有：`launch2_positions` 的累计值（`usd1_spent` / `usd1_received` / `curve_bought` / `curve_sold`）只覆盖内盘、且是累计和——卖出后再买入时推不出移动平均成本；外盘成交在 `launch2_pool_swaps`（决策 0126 / 0132 按钱包归属，`router_amount_in` / `router_amount_out` = 钱包实际付出 / 到手）。
- 价格与持仓数量已由 S280（决策 0174）定口径：未毕业 = 曲线价 × `curve.net`，毕业后 = 官方池最后成交价 × 实时 `memeBalance`。
- 已发布 App 的 V2 解码器严格（决策 0166 §D），既有对象的新增键必须默认关闭。

## 3. Decision

### A. 成本法（主代理裁决）

**移动加权平均成本**，按链上顺序（`block_number`, `log_index`）重放该钱包在该实例的全部交易：

| 交易                                                      | 数量（MEME）                                                | USD1                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 内盘买 `CurveBought`（`launch2_trades`）                  | `meme_amount`                                               | `usd1_gross` = reserveIn + platformTax（实际支付，含税；退款已不在内）               |
| 内盘卖 `CurveSold`                                        | `meme_amount`                                               | `usd1_net`（扣税后到手）                                                             |
| 外盘买（`launch2_pool_swaps`，`wallet_address` = 本钱包） | `router_amount_out`（净到手；缺时 `meme_amount − MEME 税`） | `router_amount_in`（实际支付；S209 Hook 的 USD1 买入费已含在内；缺时 `usd1_amount`） |
| 外盘卖                                                    | `router_amount_in`（付出；缺时 `meme_amount`）              | `router_amount_out`（净到手；缺时 `usd1_amount − USD1 税`）                          |

- 外盘取数与钱包活动流（`wallet-activity-merge-repository`）同一规则；对 OfficialTax 池与 S280 recent-trades 的 `usd1Amount` 相同，对 S209 USD1 买入费的 LoopDynamic 买单多计入了费（「实际支付含税」）。
- 排除：重组行（`removed`）；回购（决策 0127 / 0158：调用方为本实例回购适配器 / 执行器，或同交易记录了本实例回购）。只取归属到本钱包的 swap（匿名 swap 无从归属）。
- 重放：买 → `cost += usd1`，`qty += meme`；卖 `q` → 离开的成本 = `cost × q / qty`（整数截断），`realized += usd1 − 离开成本`；卖出量 ≥ 持有交易量时成本清零，超出部分按 0 成本卖出并记 `oversold`（必是转入的币）。

### B. 转入 / 转出（无成本信息）

只重放交易，不重放普通转账。设 `traded` = 重放后的交易持有量，`holding` = S280 同口径的当前持仓（未毕业 `curve.net`，已毕业 `memeBalance`）：

- `holding > traded`（转入）：转入部分 0 成本、不进均价分母——均价不变，`costBasis` 只含交易部分。
- `holding < traded`（转出）：按均价把成本降到 `holding` 那部分，不产生已实现盈亏。
- `costCoverage`：`holding == traded` 且没有 `oversold` → `full`；否则 `partial`；`holding` 读不到（`balanceStatus: unavailable`）→ `null`。

### C. 输出键（两处相同）

| 键                  | 定义                                                                                    | null 条件                                                  |
| ------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `avgCostUsd1`       | `floor(cost × 1e18 / traded)`，USD1 / MEME                                              | 无交易；或交易所得已全部卖出（`traded = 0`）               |
| `costBasisUsd1`     | `cost × min(holding, traded) / traded`（`holding` 读不到时按 `traded`）；全卖出为 `"0"` | 无交易                                                     |
| `realizedPnlUsd1`   | Σ 卖出净到手 − 均价成本；可为负                                                         | 无交易                                                     |
| `unrealizedPnlUsd1` | `(price − avg) × holding / 1e18`（向零截断）；`holding = 0` 时 `"0"`                    | 无交易；无价（null 或 0）；`holding` 读不到；`avg` 为 null |
| `costCoverage`      | `full` / `partial`（§B）                                                                | 无交易；`holding` 读不到                                   |

- 编码：与 `curve.usd1Spent` 相同的十进制字符串（≤ 18 位小数，去尾零）；盈亏为**有符号**十进制（亏损带 `-`），schema 用 `^-?(0|[1-9][0-9]{0,40})(\.[0-9]{1,18})?$`。
- 价格不重复下发：详情页已有 `curve.priceUsd1` / `pool.lastPriceUsd1`，持仓行有 S280 的 `priceUsd1`（开关 `LAUNCH2_POSITION_VALUE_EMIT`）。`unrealizedPnlUsd1` 用的就是这同一个价。
- 没有任何交易记录（只持有 NFT、或只收到转账）→ 5 键全 `null`。
- 注意：`holding > traded`（`partial`）时 `unrealizedPnlUsd1` 按主代理给定公式对全部 `holding` 计算，而 `costBasisUsd1` 只含交易部分，所以此时 `valueUsd1 − costBasisUsd1 ≠ unrealizedPnlUsd1`；客户端应在 `partial` 时提示「含转入，成本不完整」。

### D. 读取（无 N+1）

- 新仓储方法 `listCostTrades({ holderAddresses, instanceId | null })`：一条 SQL（`launch2_trades` ∪ `launch2_pool_swaps`，`order by instance_id, holder, block_number, log_index`）。
- `GET /v2/launch2/me/positions`：开关 on 且有持仓时，用调用者全部钱包地址、`instanceId = null` 读一次，内存按 `(instance, wallet)` 分组重放。开关 off 不读。
- 详情：开关 on 且有钱包时与其他读并行，按 `(wallet, instanceId)` 读一次。
- 规模：每钱包几百笔以内；走既有索引 `launch2_trades (trader_address, instance_id)`、`launch2_pool_swaps_wallet_idx`（按实例时）。

### E. 开关与发布顺序

| 变量               | 默认  | 说明                                                                         |
| ------------------ | ----- | ---------------------------------------------------------------------------- |
| `LAUNCH2_PNL_EMIT` | `off` | `off` / `on`，其他值拒绝启动；控制持仓行与详情 `viewer` 的 5 个成本 / 盈亏键 |

1. 服务端可直接上线（默认 off，响应逐字节不变，也不多读库）。
2. App 在 positions 行与详情 `viewer` 的 codec 里把 5 键加为**可选可空**键并发版；全部受支持版本都能解码后再切 `on`。
3. schema 中 5 键永远不进 `required`。

### F. unavailable 行为

不新增错误码。依赖缺失沿用 launch2 既有 503（`CAPABILITY_UNAVAILABLE`）；成本读失败按仓储不可用翻译为 503，不会返回部分成本。毕业后余额读不到时不估：`unrealizedPnlUsd1` / `costCoverage` 为 `null`，其余按交易重放照常给出。

## 4. Consequences

- 成本口径只认本钱包发起 / 被归属的交易；通过其他路由（匿名 swap）或别的钱包买入后转入的币不计成本，表现为 `partial`。
- 外盘买单若付款人与收款人不同，MEME 记在付款人名下（与 `poolTradeCount` 同归属），收款钱包会显示 `partial`。
- 均价与成本是整数截断，多笔卖出后与手算可能差 1e-18 级。
- 证据：`test/launch2-cost-basis.test.ts`（纯函数：只买、部分卖、全卖再买、含税、负盈亏、转入 / 转出 partial、超卖、无交易与读不到余额）、`test/v2-launch2-position-pnl-routes.test.ts`（开关 off 键集合不变且不读交易；on 时曲线 / 毕业 / partial / 无交易、一次读、详情 viewer、空持仓不读）、`test/config.test.ts`（开关解析）、`test/launch2-position-pnl.integration.test.ts`（真实 PostgreSQL：链上顺序与路由金额、回购与重组行排除、开关 off / on、内盘与毕业后、partial、无交易 null、详情 viewer 与持仓行一致且与 S280 `priceUsd1` / `curve.priceUsd1` 同价）。
