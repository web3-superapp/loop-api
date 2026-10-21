# 0171 · MEME v2 项目页 K 线：`GET /v2/launch2/instances/{instanceId}/candles`（S267-api，2026-10-21）

## 1. Status

已实现（分支 `feat/S267-launch2-candles`，基线 `integration/v2` `ceda2a7`）。只读：无迁移、无新表、无 worker、无新 env、无新能力位。新路径 1 条；既有响应键集合不变（决策 0166 §D 不受影响）。

## 2. Context

- 需求方 2026-10-21：「我们发射的代币详情里没有 K 线」。现有 K 线只在 `/v2/market/assets/:assetId/candles` 与 `/v2/meme/tokens/:memeTokenId/candles`（DexScreener，测试网无数据）。launch2 项目页内盘、外盘都没有图。
- 官网有决策 0147 的 `GET /public/v1/meme/{id}/candles`（只有 5m、三选一来源、无填平、`v` 为 USD1），口径与 App 合同不同，不复用其路由，只复用定价公式。
- 主代理已定合同字段（前端并行开发），本决策只定实现口径。

## 3. Decision

### A. 实体与 ID

- 不新增实体。`instanceId` 即 `launch2_instances.instance_id`（opaque UUID）；K 线是 `launch2_event` 车道已索引事实的只读聚合，地址 / ticker 不参与任何关联。
- 可见性与 404 与详情完全相同（`visibleInstance`：不存在、链不符、未激活且未 hold → `404 NOT_FOUND / LAUNCH2_INSTANCE_NOT_FOUND`）。列表隐藏（0163）的实例按 id 仍可读。

### B. 价格序列（一条，按链序 block_number, log_index）

- **内盘**：`launch2_trades`（`removed = false`）。每笔成交后的价格 = `launch2PriceAt(s)`，SQL 中为 `div(N, (Tv − s)²)`（`N = Qv·Tv·WAD`，与 TS 逐位相等，决策 0147 同式）。`s` = 运行中的已售量 Σ(买 − 卖) MEME。**偏离任务单**：任务单写 `launch2PriceAt(sold_after)`，但车道写 `CurveBought` 时 `sold_after` 为 `null`（只有 `CurveSold` 带 `nextSoldSupply`），所以用运行和；在 `CurveSold` 行上两者相等。`s` 超出 `[0, curveSaleSupply]`（一致的车道不会发生）的行剔除，与 `launch2PriceAt` 的定义域一致。
- **外盘**：`launch2_pool_swaps`（`removed = false`，`price_e18 > 0`），价格 = 该笔 swap 后的 `price_e18`（USD1 / MEME，即 `pool_last_price_e18` 的来源：投影取最新一笔 swap 的 `price_e18`）。OfficialTax 与 LoopDynamic 池都在这张表；回购适配器 / 执行器的 swap 也计入（与 `pool_last_price_e18` 一致，它们是真实池内成交）。
- **LoopDynamic 不用 `launch2_dynamic_candles`**：该表只有 `CandleClosed` 的 open / close sqrtPrice（没有高低、没有成交量），且固定 5 分钟、只在 swap / poke 时收盘；1m / 15m / 1h / 4h / 1d 无法从它得到，高低还要回到 swap 表。直接用 swap 表对两种 Hook 口径一致。
- 毕业前后在同一序列里：毕业那笔曲线买入在前、池子 swap 在后（同块按 log_index），不需要毕业时间分界。

### C. 桶与字段

- `interval` ∈ `1m 5m 15m 1h 4h 1d`（默认 `5m`），桶 = `floor(epoch / step) × step`（UTC 对齐，1d 对齐 UTC 0 点，4h 对齐 0/4/8/… 点）。
- `t` 桶开始 unix 秒；`o` = 上一根的 `c`（第一笔成交之前为 `launch2PriceAt(0)`）；`h` / `l` = `o` 与桶内各笔成交后价格的最大 / 最小；`c` = 桶内最后一笔成交后的价格。以「成交后价格」为点，`o` 取上一收盘，因此 K 线首尾相接、无跳空（毕业桶的 `o` 是曲线末价，池子初始价若不同会体现在该桶的高低里）。
- `v` = 桶内 MEME 成交量（买 + 卖：曲线 `meme_amount`、池子 `meme_amount`）；`q` = 桶内 USD1 成交额：曲线 `usd1_net`（买：扣 10 % 税后进入储备的 USD1；卖：扣税后付给卖方的 USD1）+ 池子 `usd1_amount`（swap 的 USD1 腿，Hook 输出税不扣）；`n` = 笔数。
- 价格与数量都用 `formatLaunch2Amount`（与 `priceBeforeUsd1` 等同款：去尾零的十进制字符串，`"0"` 表示零）。合同示例里 `v`/`q` 的 18 位补零写法是示意，App 按十进制解析，不依赖位数。
- **填平**：从第一笔成交所在桶到「现在」所在桶（带 `before` 时到 `t < before` 的最后一桶）每一桶都输出；空桶 `o=h=l=c=` 上一 `c`、`v=q="0"`、`n=0`。没有任何成交 → `candles: []`。
- **窗口**：返回最新 `limit` 根（1..500，默认 200），升序；不早于第一笔成交的桶。`before` 为正整数 unix 秒（≤ 9999 年），只取 `t < before` 的桶，用于向左翻页（下一页 `before` = 本页第一根的 `t`）。
- **`latest`**：全序列最新一笔成交的 `{price, at}`（与 `before` 无关）；无成交 = `{launch2PriceAt(0), 激活时间}`；无成交且从未激活（hold 中）= `null`。
- **`source`**（页级）：本页 K 线价格来自哪里——只有曲线 `curve`、只有池子 `pool`、都有 `mixed`；填平桶计其收盘价的来源。空页：已毕业 `pool`，否则 `curve`。
- 服务器时钟晚于区块时间（成交时间在「现在」之后）时，窗口延伸到最新成交所在桶，不丢数据。

### D. 实现

- SQL 两条（`src/database/launch2-candles-repository.ts`）：bounds（第一笔时间、最新价与时间）与 window（窗口前最后价及其来源 + 窗口内按桶 `max/min/最后价/Σ/count`，`jsonb_agg` 一行返回）。按实例的现有索引扫描（`launch2_trades_instance_idx`、`launch2_pool_swaps_instance_idx`，都是 `instance_id, block_number desc, log_index desc where not removed`）；运行和需要该实例全部曲线成交（受曲线售量所限）。
- 填平与资源投影在 `src/features/launch2/launch2-candles.ts`（纯函数）；服务只加 `listCandles`（先校验 query，再 `visibleInstance`，再读）；端口方法为可选（缺失 → 503）。
- `cache-control: no-store`（与其他 launch2 读一致；App 自行节流轮询）。

### E. 错误码与 unavailable

| HTTP | code                             | reasonCode                                                                                              |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | — （未知 query 键；body）                                                                               |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | —                                                                                                       |
| 404  | `NOT_FOUND`                      | `LAUNCH2_INSTANCE_NOT_FOUND`                                                                            |
| 422  | `VALIDATION_FAILED`              | `LAUNCH2_CANDLE_INTERVAL_INVALID` / `LAUNCH2_CANDLE_LIMIT_INVALID` / `LAUNCH2_CANDLE_BEFORE_INVALID`    |
| 503  | `CAPABILITY_UNAVAILABLE`         | 模块 / 工厂未配置同其他 launch2 路由；`LAUNCH2_REPOSITORY_UNAVAILABLE`（无库、库读失败、仓库无 K 线读） |

422 先于 404 判断（query 规则与实例无关）。fail closed：库不可读一律 503，绝不返回空数组冒充「无成交」。能力位沿用 `launch2`，不新增 id。

## 4. Consequences

- 前端：`docs/frontend-v2-launch2-api.md` §3.15。新路径，旧包不受影响。
- K 线精度受车道延迟影响（`launch2_event` 车道 tick）；重组撤销的成交（`removed`）在下次读取即消失，K 线会相应回改。
- 每次读取对该实例全部曲线成交做一次窗口和；若将来单实例成交量巨大，可加物化 `sold_after`（车道写入时计算）而不改合同。
- 证据：`test/v2-launch2-candles-routes.test.ts`（解析 / 窗口 / 填平纯函数、422 / 400 / 401 / 404 / 503、资源键集合），`test/launch2-candles.integration.test.ts`（真实 PostgreSQL：无成交、三笔内盘跨桶、reorg 剔除、`before` / `limit` / 500 上限、六种粒度对齐、毕业 mixed 序列与页级 source、422 / 404 / 401）。
