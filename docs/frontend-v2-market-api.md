# 前端联调：V2 行情（S5b / D11）

本文是 `market` 模块（决策 0034）的前端交接契约。权威机器契约为
`openapi/loop-api.v2.json`。通用规则（Base URL、`X-Request-ID`、错误体七字段、
Bearer、`X-Loop-Contract-Version: 2.0`）沿用 `docs/frontend-v2-session-api.md`、
`docs/frontend-v2-wallet-api.md` 与 `docs/api-v2-conventions.md`。

覆盖页面：`market`、`token`、`chart-full`、`token-holders`、`token-trades`、
`new-pairs`、`smart-money`。`watchlist-edit` 仍走 `GET/PUT /v2/watchlist`；
价格提醒与通知见 `docs/frontend-v2-notifications-api.md`。

## 1. 启用条件与 capability

- 后端 `V2_MODULES_ENABLED` 必须包含 `market`（读 registry 还需 `chain`）。未启用时
  所有 `/v2/market/*` 路径返回 `404 NOT_FOUND`。
- `GET /v2/meta/capabilities` 新增 `marketRead`：

| capabilityId | `available` 条件                                                       | reasonCode（unavailable）    |
| ------------ | ---------------------------------------------------------------------- | ---------------------------- |
| `marketRead` | `market` 启用 + registry/事实缓存/indexer 仓储已组装 + cursor 密钥已配 | `MARKET_RUNTIME_UNAVAILABLE` |

**Provider 是否可用不在 capability 里**：DexScreener / GoPlus / GeckoTerminal 各自的
状态写在每一个事实上（见 §2）。`marketRead: available` 只表示路由能响应，
不表示某个数字一定存在。

- 全部读接口；**没有** `Idempotency-Key`（带了返回 `400 INVALID_REQUEST`）。
- 所有响应 `Cache-Control: no-store`。

## 2. 事实（fact）的固定形状

每个数值事实都是同一个对象，不要按字段名猜来源：

```json
{
  "value": "747.39",
  "source": "dexscreener",
  "fetchedAt": "2026-09-08T07:31:02.112Z",
  "ttlSeconds": 30,
  "quality": "fresh",
  "reasonCode": null
}
```

| `quality`     | 含义                                                                           | UI                                |
| ------------- | ------------------------------------------------------------------------------ | --------------------------------- |
| `fresh`       | 在 TTL 内由 Provider 报告                                                      | 正常显示，附来源与 `fetchedAt`    |
| `proxied`     | 原生 BNB 通过 WBNB 价格代理（只此一种代理）                                    | 显示并标注"以 WBNB 计价"          |
| `stale`       | 已过 TTL，但 Provider 暂时不可达/被限速，仍在宽限期内（`reasonCode` 给出原因） | 显示数值 + "数据可能过期"标记     |
| `derived`     | LOOP 由链上事件聚合（只用于 K 线）                                             | 显示并标注"链上成交聚合"          |
| `unavailable` | `value` 为 `null`，`reasonCode` 说明原因                                       | 该块 unavailable，不要显示 0 或 — |

`source` 取值：`dexscreener`、`goplus`、`geckoterminal`、`loop_indexer`；
`value` 一律是十进制字符串，用 `Decimal` 解析，绝不用 `double`。

常见 `reasonCode`：

| reasonCode                               | 含义                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `MARKET_PROVIDER_DEXSCREENER_DISABLED`   | 后端关闭了 DexScreener                                                 |
| `MARKET_PROVIDER_GOPLUS_NOT_CONFIGURED`  | 未配置 GoPlus 密钥（安全事实、持有人数）                               |
| `MARKET_PROVIDER_GECKOTERMINAL_DISABLED` | GeckoTerminal 未启用（new-pairs、OHLCV）                               |
| `MARKET_PROVIDER_RATE_LIMITED`           | 本地节流或 Provider 429                                                |
| `MARKET_PROVIDER_UNREACHABLE`            | Provider 网络失败/超时                                                 |
| `MARKET_PROVIDER_RESPONSE_MALFORMED`     | Provider 响应不符合契约（含 JSON 数字精度丢失）                        |
| `MARKET_PAIR_NOT_FOUND`                  | DexScreener 没有以该资产为 base 的交易对                               |
| `MARKET_FACT_NOT_REPORTED`               | Provider 返回了交易对但没报这个字段                                    |
| `MARKET_NATIVE_ASSET_NOT_SUPPORTED`      | 原生 BNB 没有合约：安全事实/持有人/成交/K 线不可用（价格走 `proxied`） |
| `MARKET_POOL_NOT_REGISTERED`             | 该资产没有已登记的 PancakeSwap V3 池                                   |
| `BSC_POOL_INDEXER_NOT_STARTED`           | `pool_event` lane 从未运行                                             |
| `MARKET_NO_SWAPS_IN_RANGE`               | 请求区间内无成交                                                       |
| `ASSET_BLOCKED`                          | registry 标记为 blocked                                                |

## 3. `GET /v2/market/overview` → `market` 页

```json
{
  "watchlist": {
    "status": "available",
    "version": 3,
    "items": [
      {
        "assetId": "eip155:56:0xbb4c…",
        "asset": { "symbol": "WBNB", "name": "Wrapped BNB", "decimals": 18, "status": "pending" },
        "price": { "value": "747.39", "source": "dexscreener", "fetchedAt": "…", "ttlSeconds": 30, "quality": "fresh", "reasonCode": null },
        "priceChange24h": { "value": "0.27", "source": "dexscreener", "…": "…" }
      }
    ]
  },
  "trending": {
    "status": "available",
    "recommendationId": "5b1f…-uuid",
    "rules": { "configVersion": "marketTrendingV1", "effectiveAt": "2026-09-08T00:00:00.000Z", "ordering": "dexscreener_volume_h24_desc" },
    "items": [ { "assetId": "…", "asset": {…}, "price": {…}, "priceChange24h": {…}, "volume24h": {…}, "liquidityUsd": {…} } ]
  },
  "newPairs": { "status": "unavailable", "reasonCode": "MARKET_PROVIDER_GECKOTERMINAL_DISABLED" },
  "smartMoney": { "status": "unavailable", "reasonCode": "SMART_MONEY_RUNTIME_DEFERRED" },
  "observedAt": "2026-09-08T07:31:02.300Z",
  "contractVersion": "2.0"
}
```

- `watchlist.items` 顺序 = 自选顺序（跨分组去重）；`asset: null` +
  `price.reasonCode: ASSET_NOT_READABLE` 表示该资产已不可读。
- `trending` 只是**按 DexScreener 24h 成交量排序的 registry 资产**（最多 20），
  `recommendationId` 每次响应新生成，UI 上报"看到了哪一份排序"时带上它。
  原型里的"成员数 / 算力倍数"没有后端，不要渲染或必须标 unavailable。
- `priceChange24h.value` 可能为负数字符串（`"-3.2"`）。
- `newPairs.status === "available"` 只表示 `GET /v2/market/new-pairs` 有 Provider。

## 4. `GET /v2/market/assets/{assetId}` → `token` 页

```json
{
  "asset": { "assetId": "eip155:56:0xbb4c…", "symbol": "WBNB", "name": "Wrapped BNB", "decimals": 18, "status": "pending", "address": "0xbb4c…", "chainId": "eip155:56", "source": {…}, "updatedAt": "…" },
  "capability": { "viewable": true, "swappable": false, "value": "viewable", "reasonCode": "SWAP_MODULE_NOT_DELIVERED" },
  "price": {…}, "priceChange24h": {…}, "liquidityUsd": {…}, "volume24h": {…}, "marketCap": {…}, "fdv": {…},
  "primaryPair": {
    "pairAddress": "0x16b9…", "dexId": "pancakeswap", "labels": ["v2"],
    "quoteTokenAddress": "0x55d3…", "quoteTokenSymbol": "USDT", "pairCreatedAt": "2023-04-05T14:12:23.000Z"
  },
  "community": { "status": "unavailable", "reasonCode": "COMMUNITY_NOT_BOUND" },
  "security": {
    "status": "available", "source": "goplus", "fetchedAt": "…", "ttlSeconds": 600, "quality": "fresh", "reasonCode": null,
    "facts": [
      { "fact": "openSource", "value": "true", "source": "goplus", "observedAt": "…" },
      { "fact": "mintable", "value": "false", "source": "goplus", "observedAt": "…" },
      { "fact": "honeypot", "value": "false", "source": "goplus", "observedAt": "…" },
      { "fact": "sellTax", "value": "0.05", "source": "goplus", "observedAt": "…" }
    ]
  },
  "holderCount": { "value": "8019338", "source": "goplus", "…": "…" },
  "contractVersion": "2.0"
}
```

- `capability.swappable` 恒 `false`；**Swap 入口不渲染**。`capability.value` 与
  `GET /v2/assets/{assetId}` 相同语义。
- 价格类事实全部来自 `primaryPair`（以该资产为 base、流动性最深的 DexScreener 交易对）。
  `primaryPair: null` 时价格块全是 unavailable，`reasonCode` 说明原因。
- `security.facts` 是**带来源与观察时间的事实列表**，键名固定：
  `openSource proxy mintable ownershipTakeBack ownerChangeBalance hiddenOwner selfDestruct externalCall honeypot transferPausable blacklist whitelist antiWhale tradingCooldown cannotSellAll listedOnDex`（值 `"true"/"false"`）与
  `buyTax sellTax`（小数字符串）。后端**不给评分、评级或结论**，页面只渲染
  "X —— 来源 GoPlus，观察于 N 分钟前"。缺少某个键就是 Provider 没报，不要补默认值。
- `community.status === "available"` 时给 `communityId/name/slug/memberCount`
  （只有 `verified` 且绑定了该 assetId 的社区），用于"进入 LOOP 社区"入口；
  原型里的讨论量、7 天增长、算力排名没有后端，标 unavailable。
- 挖矿数据块（Mining Weight、预估/日）没有后端（D19），整块 unavailable。
- 不在 registry 的 `assetId` → `404 NOT_FOUND`；非 56 链 → `422 CHAIN_MISMATCH`。

## 5. `GET /v2/market/assets/{assetId}/candles?interval=15m|1h|4h|1d|1w[&limit=1..300]` → `token` 图表 / `chart-full`

```json
{
  "assetId": "eip155:56:0xbb4c…",
  "interval": "1h",
  "candles": {
    "status": "available",
    "quality": "derived",
    "source": "loop_indexer",
    "fetchedAt": "2026-09-08T07:30:41.000Z",
    "labelKey": "market.candles.onChainSwapAggregate",
    "pool": {
      "address": "0x3669…",
      "protocol": "pancakeswap_v3",
      "quoteAssetId": "eip155:56:0x55d3…",
      "quoteSymbol": "USDT"
    },
    "priceUnit": "USDT per WBNB",
    "items": [
      {
        "openTime": "2026-09-08T06:00:00.000Z",
        "closeTime": "2026-09-08T07:00:00.000Z",
        "open": "747.12…",
        "high": "748.9…",
        "low": "746.5…",
        "close": "747.48…",
        "volume": "1234.5",
        "swapCount": 4812
      }
    ]
  },
  "contractVersion": "2.0"
}
```

- 两条数据源，互不推断：
  - GeckoTerminal 启用时：`quality: fresh|stale`、`source: geckoterminal`、
    `labelKey: null`、`pool.quoteAssetId: null`、`quoteSymbol: "USD"`、`swapCount: null`。
  - 否则由 indexer 已登记池的 Swap 事件聚合：`quality: derived`、`source: loop_indexer`、
    **必须显示 `labelKey` 对应文案（"链上成交聚合"）**，价格单位是池子的**另一个代币**
    （`priceUnit`），不是 USD；`volume` 是该资产一侧的成交量（资产自身单位）。
  - 都没有 → `candles.status: unavailable`（`MARKET_POOL_NOT_REGISTERED` /
    `BSC_POOL_INDEXER_NOT_STARTED` / `MARKET_NO_SWAPS_IN_RANGE` / `MARKET_PROVIDER_GECKOTERMINAL_DISABLED`）。
- `items` 按 `openTime` 升序，只包含有成交的桶（空桶不补 0）。`1w` 按 epoch 周
  （周四 00:00 UTC）对齐。`limit` 默认 120，最大 300。
- 每根带 `isOpen`：`true` 表示该桶尚未收盘（close/high/low 还会变），前端把它画成
  "进行中"的最后一根，不要缓存。
- OHLC 是字符串，绘图前在前端归一化为 `double`；O/H/L/C 文本显示用 `Decimal`。
- 原型 `chart-full` 的 `1m`、MA/EMA/MACD/RSI 指标没有后端，前端本地计算或不显示。

## 6. `GET /v2/market/assets/{assetId}/trades?cursor|limit=1..50` → `token-trades` 页

```json
{
  "assetId": "eip155:56:0xbb4c…",
  "trades": {
    "status": "available",
    "source": "loop_indexer",
    "items": [
      {
        "transactionHash": "0x…",
        "logIndex": 12,
        "blockNumber": "120640705",
        "blockHash": "0x…",
        "blockTimestamp": "2026-09-08T07:30:39.000Z",
        "confirmations": 101,
        "status": "confirmed",
        "direction": "buy",
        "amountAsset": "1.25",
        "amountQuote": "934.35",
        "quoteAssetId": "eip155:56:0x55d3…",
        "quoteSymbol": "USDT",
        "priceAfter": "747.482453211647133359",
        "poolAddress": "0x3669…",
        "sender": "0x…",
        "recipient": "0x…"
      }
    ],
    "nextCursor": "…",
    "freshness": {
      "indexerBlockNumber": "120640710",
      "headBlockNumber": "120640743",
      "lagBlocks": 33,
      "observedAt": "…"
    }
  },
  "contractVersion": "2.0"
}
```

- `direction` 相对于该资产：`buy` = 资产从池子流出（有人买入）。金额为绝对值字符串。
- **不下发对手方地址**：`isOwn: true` 表示该笔 swap 的 sender/recipient 是当前账号的
  某个钱包（服务端按 `account_wallets` 计算），用于原型里"我"的标记。
- `status`：`confirmed`（确认数 ≥ 15）/ `pending` / `reorged`（行保留，前端把已显示的该条标记为已回滚）。
- 原型的"大单 / 聪明钱"分段没有后端：`大单` 由前端按 `amountQuote` 阈值本地筛选，
  `聪明钱` 段 unavailable。
- `cursor` 与 `limit` 互斥；cursor 绑定账号 + assetId，跨资产使用 → `400 INVALID_REQUEST`。
- 未登记池 / lane 未运行 → `trades.status: unavailable`（不是空列表）。

## 7. `GET /v2/market/assets/{assetId}/holders` → `token-holders` 页

```json
{
  "assetId": "…",
  "holderCount": {
    "value": "8019338",
    "source": "goplus",
    "fetchedAt": "…",
    "ttlSeconds": 600,
    "quality": "fresh",
    "reasonCode": null
  },
  "distribution": {
    "status": "unavailable",
    "reasonCode": "HOLDER_DISTRIBUTION_NOT_SUPPORTED"
  },
  "contractVersion": "2.0"
}
```

Top 持有人、Top 10/100 集中度、聚类标注本步全部 unavailable（需要全量历史）。

## 8. `GET /v2/market/new-pairs` → `new-pairs` 页

GeckoTerminal 默认关闭：`newPairs: {status: "unavailable", reasonCode: "MARKET_PROVIDER_GECKOTERMINAL_DISABLED"}`，
整页 unavailable。启用后：

```json
{
  "newPairs": {
    "status": "available",
    "source": "geckoterminal",
    "fetchedAt": "…",
    "ttlSeconds": 60,
    "quality": "fresh",
    "reasonCode": null,
    "items": [
      {
        "poolAddress": "0x…",
        "dexId": "pancakeswap_v3",
        "name": "X / WBNB",
        "baseTokenAddress": "0x…",
        "quoteTokenAddress": "0x…",
        "registryAssetId": null,
        "createdAt": "…",
        "reserveUsd": "12345.6",
        "volumeH24Usd": "…"
      }
    ]
  },
  "riskScreening": {
    "status": "unavailable",
    "reasonCode": "MARKET_PROVIDER_GOPLUS_NOT_CONFIGURED"
  },
  "contractVersion": "2.0"
}
```

原型的"已过预筛 / 风险特征折叠"依赖 `riskScreening`，本步恒 unavailable，
不要按其它字段自行判定风险。

## 9. `GET /v2/market/smart-money` → `smart-money` 页

恒 `{"smartMoney": {"status": "unavailable", "reasonCode": "SMART_MONEY_RUNTIME_DEFERRED"}, "contractVersion": "2.0"}`，整页 unavailable。

## 10. 错误码速查

| HTTP | code                             | 出现位置                                                                      |
| ---- | -------------------------------- | ----------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | 未知 query、坏 cursor、cursor+limit 同时、带 `Idempotency-Key`、非法 interval |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | 缺失或无效 Bearer                                                             |
| 404  | `NOT_FOUND`                      | 模块未启用、未知 `assetId`                                                    |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED`     | 账号未 bootstrap                                                              |
| 422  | `CHAIN_MISMATCH`                 | 非 `eip155:56` 的 `assetId`                                                   |
| 503  | `CAPABILITY_UNAVAILABLE`         | cursor 密钥未配置（trades 分页）                                              |

Provider 故障**不是 HTTP 错误**：请求 200，受影响的块 `unavailable` 或事实 `quality: stale`。

## 11. 本步明确 unavailable 的产品项

| 项目                                     | reasonCode / 位置                                               |
| ---------------------------------------- | --------------------------------------------------------------- |
| 持有人分布、集中度、聚类标注             | `HOLDER_DISTRIBUTION_NOT_SUPPORTED`                             |
| 新币发现（默认）、风险预筛               | `MARKET_PROVIDER_GECKOTERMINAL_DISABLED`、`riskScreening`       |
| 聪明钱                                   | `SMART_MONEY_RUNTIME_DEFERRED`                                  |
| 社区讨论量 / 增长 / 算力排名、挖矿数据块 | 无后端（D19），整块 unavailable                                 |
| Swap 入口                                | `capability.swappable === false`                                |
| 钱包估值 / 净值                          | 仍为 `MARKET_PRICE_PROVIDER_NOT_CONFIGURED`（待主代理裁决接入） |
