# 决策 0186：行情列表行的 24 小时迷你走势 `sparkline24h`（可选键，开关默认关）

- 状态：Accepted（S307-api；需求方 2026-10-25 要求，设计稿 docs/49 §E/F「行内趋势图」与「数据要求」）
- 日期：2026-10-25
- 范围：`GET /v2/market/assets?category=major|meme|community` 的 `items[]`，`GET /v2/market/overview` 的 `watchlist.items[]` 与 `trending.items[]`——只有这三处行加可选键 `sparkline24h`；其它接口不变。新开关 `MARKET_ROW_SPARKLINE24H_EMIT`（off|on，默认 off）。**无迁移、无新表、无新 worker lane、无新错误码。**
- 基线：`integration/v2` = `6c8b911`，提交前合入 `f77bbca`（S306，迁移 000102）。

## 背景

情报页「行情」四个分段：自选 = overview 的 `watchlist.items[]`；主流 / MEME / 社区代币 = `GET /v2/market/assets?category=` 的三个分类（共用一个列表接口，按 `category` 区分）。

这些行**已有必填的 `sparkline` 块**（决策 0074：`{status, interval:"1h", closes[], observedAt, source:"geckoterminal", quality}`，worker 预热的 GeckoTerminal 缓存行）。实测覆盖（开发库 2026-10-25）：

| 行                                                        | 现有 `sparkline`                                               |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| 主流币（登记表 11 个 BSC 资产，含 native 走 WBNB）        | 11/11 有缓存行，均 24 点，`fetched_at` 在 TTL 内 → `available` |
| 社区代币里的主网资产                                      | 同上（登记表资产都在预热范围内）                               |
| MEME v1 曲线代币                                          | `unavailable / MEME_CURVE_SPARKLINE_UNAVAILABLE`               |
| 已毕业 MEME（池子推算价 `pool_slot0`）                    | `unavailable / MEME_POOL_SPARKLINE_UNAVAILABLE`                |
| launch2 MEME、测试网 Launch 代币（社区代币 / 自选里出现） | `unavailable / MARKET_CHAIN_NOT_PRICED`                        |

缺口只在发射台代币。

### 为什么不把 MEME 序列塞进现有 `sparkline` 块

协调方首选「零新键：把现有块填满」。核实 loop-mobile `loop_v2_market_api.dart` `_rowSparkline`：`available` 分支**严格要求 `source == 'geckoterminal'`**、`interval == '1h'`，键集合封闭。用 LOOP 链上成交算出的序列就只能标成 `geckoterminal`，那是谎报来源（违反决策 0034 「不从别的来源推断事实」与 fail-closed 原则）；加一个新 `source` 值则旧客户端整页解码失败（strict 解码 → `invalidPayload`）。两条都不行，所以保留现有块原样，另加可选键。

## 决策

### 1. 键与形状

```json
"sparkline24h": ["747.12", "747.48", "…", "748.01"]
"sparkline24h": null
```

- 至多 24 个点，每小时一点，**按时间升序**，最后一点是当前小时；值是**规范十进制字符串**（不是 JSON number，AGENTS 规则：价格不用 JS number），非负，单位与该行价格一致（USD；发射台代币为 USD1，按 1:1 计 USD，与 `loop_curve` / `pool_slot0` 报价同一口径）。
- 不足 2 点或没有来源：`null`（客户端不画线，只显示百分比）。不补 0，不插值，不跨来源拼接。
- 开关 `MARKET_ROW_SPARKLINE24H_EMIT=off`（默认）：**不出现这个键**，三处行逐字节与现在一致；`on`：三处每一行都带这个键（数组或 null）。OpenAPI 中为可选属性（不在 `required`）。

### 2. 来源（取第一个有结果的）

1. **行自己的 `sparkline`**（决策 0074，GeckoTerminal 1h OHLCV 收盘，worker 预热）：`status: available` 时取其 `closes` 末 24 个；`stale` / `proxied` 同样采用（与块本身的发布规则一致）。主流币、社区代币里的主网资产走这里——请求路径零新增读取。
2. **LOOP 链上成交**（一条 SQL 批量读多资产，`src/database/market-row-series-repository.ts`）：
   - launch2：资产 `chain_id:meme_address` 的 `launch2_instances`，价格序列与 S267 K 线（决策 0171 `/v2/launch2/instances/:id/candles`）同口径——曲线成交后边际价 `div(N, (Tv − sold)²)`（sold = 按链上顺序累计的已售量），毕业后官方池 swap 的 `price_e18`；`removed` 不算。
   - MEME v1：`meme_tokens.asset_id`（同分类列表取最早一行）的 `meme_trades.price_after_e18`。
   - 按 UTC 整点分桶（`floor(epoch/3600)×3600`），**收盘 = 该小时最后一笔成交后的价格**；从「首笔成交所在小时」与「窗口起点」较晚者画到当前小时；没有成交的小时沿用上一收盘（与 K 线接口补空桶同规则，表示价格没变，不是假数据）；窗口起点之前的最后一笔给起始价。
   - 只有当前小时有成交（1 点）→ `null`。
3. 都没有 → `null`（如 DexScreener 有价但 worker 尚未预热的资产、测试网 Launch 项目代币无成交）。

不新建「小时报价快照表」：主流币已有 0074 的 24 点缓存行（开发库 11/11 满 24 点），再存一份 DexScreener 小时价是第二个事实来源且要多一个迁移与写入路径；因此**未使用迁移号**（原预留 000103 未占用）。

### 3. 只为返回的那一页读、批量、缓存

- 分类列表在分页**之后**、只对本页行计算；overview 对自选全部行和截断后的热门行计算。
- 来源 1 不发任何读取；来源 2 把本页所有「自己没有线」的行一次性交给 `readHourlyCloses(assetIds[])`，一条 SQL。
- 进程内记忆（`createMarketRowSparkline24hReader`）：按 assetId 缓存结果（含 null），TTL = `MARKET_CANDLES_TTL_SECONDS`（默认 60 秒，与行情 K 线一致），且换小时即失效；最多 2000 条。读失败：本次这些行答 `null`、不缓存、`warn` 日志 `MARKET_ROW_SPARKLINE24H_READ_FAILED`，列表照常 200。每次真实读取有一条 `debug` 日志 `market_row_sparkline24h_read {assets, withSeries, durationMs}`。
- SQL 只逐行读窗口内（24 h）的成交；窗口前的起始价与首笔成交时间都是 `limit 1` 索引查找（`meme_trades_token_time_idx`、`launch2_*_instance_idx`），launch2 曲线窗口前的已售量是每个实例一次无排序聚合。

### 4. 性能（本机，2026-10-25）

| 场景                                                      | 资产 | 数据量                                 | SQL p50 / p95 |
| --------------------------------------------------------- | ---- | -------------------------------------- | ------------- |
| 开发库只读（8 个 launch2 + 5 个 MEME v1，全部得到 24 点） | 13   | 997 曲线成交 + 90 池 swap + 95 v1 成交 | 4.2 / 13.4 ms |
| 压测（测试库事务内造数后回滚）                            | 40   | 120 000 笔 v1 成交，窗口内 40 000 笔   | 117 / 122 ms  |
| 测试库小数据 + 47 个无数据 ID                             | 50   | 11 笔                                  | 2.0 / 4.4 ms  |

第一版 SQL（全历史扫描 + distinct on）压测为 683 ms，已改写。60 秒记忆下，同一批资产每分钟至多读一次；开关关闭时零开销。主流币行不增加任何读取。

## 给 loop-mobile 的契约

- `MARKET_ROW_SPARKLINE24H_EMIT` 默认 off；**客户端先发版**：分类行 `strictMapWithOptional` 的可选集合加 `sparkline24h`，overview 的 `_assetRow`（自选 / 热门）同样把它放进可选键。所有支持的 build 都能解码后再在 staging / 生产开 `on`（「/v2 新增键必须客户端先行」）。
- 画线规则：有 `sparkline24h`（数组）就用它；键缺失（开关关）再回退现有 `sparkline` 块（`available` 且 ≥2 点）；`sparkline24h: null` 表示服务端已查过所有来源都没有，**不要**再回退（该行 `sparkline` 也必然不可用）。都没有就只显示百分比。
- 值是十进制字符串；客户端可兼容数字但服务端只发字符串。长度 2–24，升序，非负。
- 颜色 / 涨跌仍以行里的 `change24hPct`（分类）或 `priceChange24h`（overview）为准，折线只表示形状；发射台代币的 `change24hPct` 可能为 null（`pool_slot0`），此时按设计稿走平盘色。

## 回滚

`MARKET_ROW_SPARKLINE24H_EMIT=off`：键消失，行与之前逐字节一致。无数据迁移需要回退。
