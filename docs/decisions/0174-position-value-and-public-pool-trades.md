# 0174 · 持仓行价格与估值、毕业后公开外盘成交（S280，2026-10-22）

## 1. Status

已实现（分支 `feat/S280-position-value-and-public-trades`，基线 `integration/v2` `220a30b`）。无迁移（下一个迁移号仍为 000097）。新路径 1 条：`GET /v2/launch2/instances/{instanceId}/pool/recent-trades`。既有 `GET /v2/launch2/me/positions` 行新增 3 个**可选**键。新 env：`LAUNCH2_POSITION_VALUE_EMIT`（默认 `off`）。不改合约，不改 `/v1`。

## 2. Context

- 需求方 2026-10-22 验收反馈第 08 条：钱包代币列表要显示每个 MEME v2 持仓的 USD1 价值。`GET /v2/launch2/me/positions` 行只有数量（`curve.*`、`memeBalance`），没有价格；价格只在详情：内盘 `curve.priceUsd1`（读模型 `launch2_instances.price_e18`），外盘 `pool.lastPriceUsd1`（`pool_last_price_e18`）。
- 第 04 条的数据准备：毕业后项目页要展示公开的外盘成交。`launch2_pool_swaps` 已有全部外盘 swap，但 `GET …/pool/trades` 只返回调用者自己钱包的成交。
- 已发布 App 的 V2 解码器严格（决策 0166 §D；10-19 S239 因新增键回滚过一次），既有响应对象的新增键必须默认关闭。
- `listMyPositions` 之前逐实例 `getInstance`（N+1）。

## 3. Decision

### A. 持仓行价格与估值（第 08 条）

- `GET /v2/launch2/me/positions` 每行新增可选键（schema 中不在 `required`，永远不改为必带）：
  - `priceUsd1`：USD1 / MEME，十进制字符串（与 `curve.usd1Spent` 同编码，18 位精度内去尾零）。未毕业 = 当前曲线价（读模型 `price_e18`，与详情 `curve.priceUsd1` 同一字段同一格式化）；已毕业 = 官方池最后成交价（`pool_last_price_e18`，与详情 `pool.lastPriceUsd1` 相同）。
  - `valueUsd1`：`floor(数量 × price / 1e18)`，十进制字符串。数量：未毕业取 `curve.net`（bought − sold，最小 0），已毕业取实时 `memeBalance`。
  - `priceSource`：`curve` | `pool`；无价时 `null`。
- 「是否毕业」以 `graduation !== null` 判定（与 `memeBalance` / `balanceStatus` 同口径）。
- **无价不估**：价格字段缺失或为 0（例如已毕业但池内还没有成交）→ 三键全 `null`；已毕业但余额读不到（`balanceStatus = unavailable`）→ `priceUsd1` / `priceSource` 照常，`valueUsd1 = null`。不用曲线价代替外盘价，也不用报价模拟。与 S281 客户端的约定（主代理 2026-10-22）：已毕业行 `memeBalance` 为 `null`（读不到 / 未索引）时 `valueUsd1` 必为 `null`，**绝不**退回用 `curve.net` 乘价；客户端此时显示 `curve.net` 数量、不显示估值。
- **开关**：只在 `LAUNCH2_POSITION_VALUE_EMIT=on` 时输出三键；默认 `off` 整个键不存在，行与之前逐字节相同。
- **一次读完**：新增仓储方法 `getInstances(ids)`（一条 `where instance_id = any($1::uuid[])`），`listMyPositions` 用它替代逐实例 `getInstance`；价格全部来自该次读到的读模型列，不再为价格做任何额外查询或链读。持仓为空时不读实例。开关 off 时同样走批量读（行为不变，仅消除 N+1）。

### B. 公开外盘成交 `GET /v2/launch2/instances/{instanceId}/pool/recent-trades`

- **公开**：不需要 Bearer（带了也忽略），仍要求 V2 读请求头（`X-Loop-Contract-Version: 2.0`、`X-Loop-Client-Version`，不得带 `Idempotency-Key`）；OpenAPI `security: []`。
- **限流**：每访客固定一分钟窗口（进程内），上限 `PUBLIC_RATE_LIMIT_PER_MINUTE`（默认 120，与决策 0147 公开 MEME 页同一开关）；访客 = `TRUST_PROXY` 开时 `PUBLIC_CLIENT_IP_HEADERS` 中第一个公网地址，否则对端 IP。超限 `429 RATE_LIMITED`（`retryable: true`）+ `Retry-After` 秒数。限流器抽成 `src/core/http/fixed-window-rate-limiter.ts`（公开 MEME 页的实现未改动）。
- **查询**：`limit` 1–50，默认 20；> 50 / 0 / 非数字 → `400 INVALID_REQUEST`。不分页（无 cursor）。
- **口径**：只列用户成交，与 `pool.userTradeCount` 及发射台活动流（决策 0127 / 0158）同一规则：排除本实例回购适配器 / 执行器发起的 swap，以及记录了本实例回购的交易里的 swap；排除 `removed`（重组）行。全部钱包（含未归属的匿名 swap）。按 `block_number desc, log_index desc` 排序（走 `launch2_pool_swaps_instance_idx`）。
- **响应**：`{ instanceId, items: [...], observedAt, contractVersion }`；每项 `{ txHash, blockNumber, at, side, memeAmount, usd1Amount, priceUsd1, wallet }`：
  - 编码与 `recentTrades`（曲线成交）一致：金额为十进制字符串，`blockNumber` 为无符号整数字符串，`at` 为 ISO 8601 UTC，`txHash` 为 `0x` + 64 小写 hex。
  - `usd1Amount`：买 = 付出的 USD1；卖 = 收到的 USD1（USD1 计税时为 `usd1_amount − tax_amount`）——与活动流相同。
  - `priceUsd1`：该 swap 后的池价（`price_e18`）。
  - `wallet`：归属的交易者（决策 0126 router payer / 0132 tx.from）脱敏为 `0x` + 前 4 + `…` + 后 4（如 `0x1234…abcd`，小写）；匿名 swap 为 `null`。完整地址不出现在响应中。
- 未毕业：`200`，`items: []`（不查询）。未知 / 未激活 / 他链实例 → `404 NOT_FOUND / LAUNCH2_INSTANCE_NOT_FOUND`。依赖缺失 → `503 CAPABILITY_UNAVAILABLE`（同其他 launch2 路由）。
- **缓存**：服务进程内按 `(instanceId, limit)` 复用成功响应 10 秒（`observedAt` = 实际读库时刻）；`200` 带 `Cache-Control: public, max-age=10`；错误 `no-store`。不做 ETag。
- 新路由不影响老客户端，不需要开关。

### C. 环境变量

| 变量                          | 默认  | 说明                                                             |
| ----------------------------- | ----- | ---------------------------------------------------------------- |
| `LAUNCH2_POSITION_VALUE_EMIT` | `off` | `off` / `on`，其他值拒绝启动；控制 positions 行三个价格 / 估值键 |

新路由复用既有 `PUBLIC_RATE_LIMIT_PER_MINUTE`、`TRUST_PROXY`、`PUBLIC_CLIENT_IP_HEADERS`。

### D. 发布顺序

1. 服务端可直接上线（开关默认 off，持仓响应不变；新路由为纯新增）。
2. App 在 positions 行 codec 里把 `priceUsd1` / `valueUsd1` / `priceSource` 加为**可选可空**键并发版；全部受支持版本都能解码后，再把 `LAUNCH2_POSITION_VALUE_EMIT` 切到 `on`。
3. 公开成交列表 App 可随时接入（新 codec，字段编码与 `recentTrades` 一致）。

## 4. Consequences

- 已毕业但池内尚无成交的实例显示「暂无价格」，不是 0。
- 持仓列表少了每实例一次查询（N+1 → 1）。
- 进程内缓存与限流在多副本下各自独立（与决策 0147 相同的已知限制）。
- 证据：`test/v2-launch2-position-value-routes.test.ts`（开关 off 键集合不变且一次批量读、on 时曲线 / 外盘 / 无价 / 余额不可用 / 零价、空持仓不读实例；公开成交无 Bearer、脱敏、默认 20 / 上限 50 / 51 → 400、10 秒复用、未毕业空、404、缺请求头 400、429 + Retry-After）、`test/config.test.ts`（开关解析）、`test/launch2-position-value.integration.test.ts`（真实 PostgreSQL：`getInstances` 批量读与去重、开关 off / on、与详情 `curve.priceUsd1` 同值、外盘价 × 余额、无外盘价 null；公开成交的排序、回购适配器与重组行排除、匿名 null、USD1 计税卖出取净额、上限 50 / 51 → 400、未毕业空）。
