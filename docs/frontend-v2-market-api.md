# 前端联调：V2 行情（S5b / D11）

本文是 `market` 模块（决策 0034）的前端交接契约。权威机器契约为
`openapi/loop-api.v2.json`。通用规则（Base URL、`X-Request-ID`、错误体七字段、
Bearer、`X-Loop-Contract-Version: 2.0`）沿用 `docs/frontend-v2-session-api.md`、
`docs/frontend-v2-wallet-api.md` 与 `docs/api-v2-conventions.md`。

覆盖页面：`market`、`token`、`chart-full`、`token-holders`、`token-trades`、
`new-pairs`、`smart-money`，以及 `community-chat` 里贴出合约地址后的 **Token Card**
（§4a，决策 0058）。`watchlist-edit` 仍走 `GET/PUT /v2/watchlist`；
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
| `proxied`     | 原生 BNB 通过 WBNB 代理（价格事实与 K 线，只此一种代理）                       | 显示并标注"以 WBNB 计价"          |
| `stale`       | 已过 TTL，但 Provider 暂时不可达/被限速，仍在宽限期内（`reasonCode` 给出原因） | 显示数值 + "数据可能过期"标记     |
| `derived`     | LOOP 由链上事件聚合（只用于 K 线）                                             | 显示并标注"链上成交聚合"          |
| `unavailable` | `value` 为 `null`，`reasonCode` 说明原因                                       | 该块 unavailable，不要显示 0 或 — |

`source` 取值：`dexscreener`、`goplus`、`geckoterminal`、`loop_indexer`；
`value` 一律是十进制字符串，用 `Decimal` 解析，绝不用 `double`。

常见 `reasonCode`：

| reasonCode                               | 含义                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MARKET_PROVIDER_DEXSCREENER_DISABLED`   | 后端关闭了 DexScreener                                                                                                                                                                                                                                                                                                                                                      |
| `MARKET_PROVIDER_GOPLUS_NOT_CONFIGURED`  | 未配置 GoPlus 密钥（安全事实、持有人数）                                                                                                                                                                                                                                                                                                                                    |
| `MARKET_PROVIDER_GECKOTERMINAL_DISABLED` | GeckoTerminal 未启用（new-pairs、OHLCV）；Development 栈已启用（决策 0050），仓库默认与生产仍关闭                                                                                                                                                                                                                                                                           |
| `MARKET_PROVIDER_RATE_LIMITED`           | 本地节流或 Provider 429                                                                                                                                                                                                                                                                                                                                                     |
| `MARKET_PROVIDER_UNREACHABLE`            | Provider 网络失败/超时                                                                                                                                                                                                                                                                                                                                                      |
| `MARKET_PROVIDER_RESPONSE_MALFORMED`     | Provider 响应整体不符合契约（响应结构不可解析，或 JSON 数字精度已丢失）。**单个交易对**读不出来的情况不再走这个码：池标识不是地址（four.meme `{address}:4meme`、Uniswap V4 pool id，决策 0060）、Provider 给的数字不是规范十进制（如 `priceChange.h24: "3.725857251510287e+42"`）、计数/时间戳不合形状（决策 0062），都只丢弃该交易对并计数，token 其余交易对与价格照常可用 |
| `MARKET_PAIR_NOT_FOUND`                  | DexScreener 没有以该资产为 base 的交易对                                                                                                                                                                                                                                                                                                                                    |
| `MARKET_FACT_NOT_REPORTED`               | Provider 返回了交易对但没报这个字段                                                                                                                                                                                                                                                                                                                                         |
| `MARKET_NATIVE_ASSET_NOT_SUPPORTED`      | 原生 BNB 没有合约：安全事实/持有人/成交不可用（价格与 K 线走 `proxied`；WBNB 未登记时 K 线也是这个码）                                                                                                                                                                                                                                                                      |
| `MARKET_POOL_NOT_REGISTERED`             | 该资产没有已登记的 PancakeSwap V3 池，且（K 线）Provider 也没有可用顶池                                                                                                                                                                                                                                                                                                     |
| `BSC_POOL_INDEXER_NOT_STARTED`           | `pool_event` lane 从未运行                                                                                                                                                                                                                                                                                                                                                  |
| `MARKET_NO_SWAPS_IN_RANGE`               | 请求区间内无成交                                                                                                                                                                                                                                                                                                                                                            |
| `ASSET_BLOCKED`                          | registry 标记为 blocked                                                                                                                                                                                                                                                                                                                                                     |
| `ASSET_NOT_REGISTERED`                   | （`capability.reasonCode`）该地址不在 registry，身份来自 Provider 查找（§4a）                                                                                                                                                                                                                                                                                               |
| `MARKET_TOKEN_NOT_FOUND`                 | Provider 明确回答"没有这个 token"（只会出现在 `asset.status: unavailable` 的部分回答里；全部 Provider 都这么答时是 404）                                                                                                                                                                                                                                                    |
| `MARKET_LOOKUP_PROVIDER_DISABLED`        | GeckoTerminal 与 DexScreener 都关闭，未登记地址无法解析                                                                                                                                                                                                                                                                                                                     |

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
- **`newPairs`（决策 0053）**：可用变体是 `{ "status": "available", "omittedCount": 0 }`，
  `omittedCount` **必填**、与 `GET /v2/market/new-pairs` 的 `newPairs.omittedCount`
  **同源同值**（同一份 GeckoTerminal 缓存 fact）。`available` 现在意味着新币页此刻
  确实读得到数据，不再只是"有 Provider"：Provider 关闭是
  `MARKET_PROVIDER_GECKOTERMINAL_DISABLED`；Provider 开着但 fact 读不到（不可达 /
  畸形 / 缓存不可用）是 `{status:"unavailable", reasonCode}`，reasonCode 与新币页
  报的一致。行情 Tab 卡片可以印 `omittedCount`（正常为 0，表示"有 N 条池子因标识
  畸形没列出"）；`items` 不在总览里，进页再读。**严格 codec 必须把 `omittedCount`
  加进可用变体的键集合。**

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
  DexScreener 没有可用交易对时，整组事实改由 Provider 顶池查找提供（决策 0064，见 §4a
  末条）：来源在每个事实的 `source` 里自述，不会一个字段来自一个 Provider。仍然没有 →
  价格块全是 unavailable，`primaryPair: null`，`reasonCode` 说明原因。
- `security.facts` 是**带来源与观察时间的事实列表**，键名固定：
  `openSource proxy mintable ownershipTakeBack ownerChangeBalance hiddenOwner selfDestruct externalCall honeypot transferPausable blacklist whitelist antiWhale tradingCooldown cannotSellAll listedOnDex`（值 `"true"/"false"`）与
  `buyTax sellTax`（小数字符串）。后端**不给评分、评级或结论**，页面只渲染
  "X —— 来源 GoPlus，观察于 N 分钟前"。缺少某个键就是 Provider 没报，不要补默认值。
- `community.status === "available"` 时给 `communityId/name/slug/memberCount`
  （只有 `verified` 且绑定了该 assetId 的社区），用于"进入 LOOP 社区"入口；
  原型里的讨论量、7 天增长、算力排名没有后端，标 unavailable。
- 挖矿数据块（Mining Weight、预估/日）没有后端（D19），整块 unavailable。
- 非 56 链 → `422 CHAIN_MISMATCH`。**不在 registry 的地址不再 404**：走 §4a 的
  Provider 查找。只有 `eip155:56:native` 未登记时仍是 `404`。

## 4a. 聊天里贴出的合约地址 → `GET /v2/market/assets/{assetId}` → Token Card（决策 0058）

**入口**：消息文本里匹配到 `0x` + 40 位十六进制 → **小写化** → 拼成
`eip155:56:<address>` → 请求同一个资产端点。不要发大小写混合的 checksum
地址（`400 INVALID_REQUEST`），不要发 ticker。同一条消息里的多个地址各发一次；
客户端应按 `assetId` 本地缓存 60 s（价格）/ 1 h（身份），因为**每次请求都计入配额**
（缓存命中也计）。

**响应与 §4 完全同一 schema**，只有 `asset` 块是按 `status` 判别的三选一：

| `asset.status`                     | 含义                                   | Token Card                                                    |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------- |
| `pending` / `verified` / `blocked` | registry 资产（§4 原样）               | 原有渲染                                                      |
| `unregistered`                     | 未登记地址，身份来自 Provider 查找     | 显示 symbol/name（为 `null` 时显示缩略地址），标注来源与时间  |
| `unavailable`                      | 未登记地址，此刻没有 Provider 能描述它 | 显示缩略地址 + unavailable 态 + `reasonCode`；不要占位 ticker |

`unregistered` 变体（WETH 实测形状，2026-09-20，GeckoTerminal 路径）：

```json
{
  "asset": {
    "assetId": "eip155:56:0x2170ed0880ac9a755fd29b2688956bd959f933f8",
    "chainId": "eip155:56",
    "address": "0x2170ed0880ac9a755fd29b2688956bd959f933f8",
    "symbol": "ETH",
    "name": "Ethereum Token",
    "decimals": 18,
    "status": "unregistered",
    "source": {
      "kind": "provider_lookup",
      "provider": "geckoterminal",
      "fetchedAt": "2026-09-20T14:52:33.120Z",
      "ttlSeconds": 3600,
      "quality": "fresh",
      "blockNumber": null,
      "verifiedAt": null
    },
    "updatedAt": "2026-09-20T14:52:33.120Z"
  },
  "capability": {
    "viewable": true,
    "swappable": false,
    "value": "viewable",
    "reasonCode": "ASSET_NOT_REGISTERED"
  },
  "price": {
    "value": "2575.1402462078",
    "source": "geckoterminal",
    "fetchedAt": "…",
    "ttlSeconds": 60,
    "quality": "fresh",
    "reasonCode": null
  },
  "priceChange24h": { "value": "-2.52", "source": "geckoterminal", "…": "…" },
  "liquidityUsd": { "value": "16714230.2158", "…": "…" },
  "volume24h": { "value": "25016115.5564862", "…": "…" },
  "marketCap": { "value": "1300514252.30807", "…": "…" },
  "fdv": { "value": "1300404347.01321", "…": "…" },
  "primaryPair": {
    "pairAddress": "0xd0e226f674bbf064f54ab47f42473ff80db98cba",
    "dexId": "pancakeswap-v3-bsc",
    "labels": [],
    "quoteTokenAddress": "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    "quoteTokenSymbol": "WBNB",
    "pairCreatedAt": "2025-11-14T06:46:14.000Z"
  },
  "community": { "status": "unavailable", "reasonCode": "COMMUNITY_NOT_BOUND" },
  "security": {
    "status": "unavailable",
    "reasonCode": "MARKET_PROVIDER_GOPLUS_NOT_CONFIGURED"
  },
  "holderCount": {
    "value": null,
    "quality": "unavailable",
    "reasonCode": "MARKET_PROVIDER_GOPLUS_NOT_CONFIGURED",
    "…": "…"
  },
  "contractVersion": "2.0"
}
```

- **Provider 顺序**：GeckoTerminal（Development 栈已开）优先，DexScreener 兜底。
  DexScreener 路径下 `source.provider: "dexscreener"`、**`decimals: null`**
  （DexScreener 不报 decimals；生产默认只开 DexScreener，所以生产里未登记地址
  的 `decimals` 常为 `null`）。`decimals` 为 `null` 时**不要**格式化任何原始数量，
  Token Card 只显示价格类事实。`symbol`/`name` 也可能为 `null`。
- `source.quality: "stale"`：Provider 此刻不可达，身份来自 1 h 内的上次查找；此时
  价格类事实全部 `unavailable` 并带原因。标注"数据可能过期"。
- `capability.swappable` 恒 `false`，`reasonCode: ASSET_NOT_REGISTERED`；**不渲染 Swap
  入口**，也不要把"可展示"当"可成交"。
- `community` 恒 `COMMUNITY_NOT_BOUND`；`security`/`holderCount` 与登记资产一样来自
  GoPlus（配了密钥就有）。
- `asset.status: "unavailable"` 时 `capability.value` 是 `temporarily_unavailable`、
  `viewable: false`。
- **HTTP 结果**：

| HTTP | code                     | 何时                                                                                                                              |
| ---- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 200  | —                        | Provider 描述了它（`unregistered`）或没有 Provider 能答（`unavailable`）                                                          |
| 400  | `INVALID_REQUEST`        | 地址不是小写 `0x`+40 hex（含 checksum 大小写）、长度不对、发了 ticker                                                             |
| 404  | `NOT_FOUND`              | **所有已启用的** Provider 都明确回答"没有这个 token"（GeckoTerminal 404 / DexScreener 空列表）                                    |
| 422  | `CHAIN_MISMATCH`         | 非 `eip155:56`                                                                                                                    |
| 429  | `RATE_LIMITED`           | 未登记地址查找配额用尽：每用户 30 次/分钟、每 IP 90 次/分钟、每用户 600 次/天；`retryable: true`，UI 显示"稍后再试"，不要自动重试 |
| 503  | `CAPABILITY_UNAVAILABLE` | 配额运行时未组装（HMAC 密钥或控制面仓储缺失）；登记资产不受影响                                                                   |

- **K 线**：`GET /v2/market/assets/{assetId}/candles` 对未登记地址也可用（同样计配额）。
  只有 GeckoTerminal 路径：`source: geckoterminal`、`pool.address` = `primaryPair.pairAddress`、
  **`pool.protocol` 是 Provider 的 dex id 字符串**（如 `pancakeswap-v3-bsc`，不再是
  `pancakeswap_v3` 常量——严格 codec 要改成字符串）、**`pool.origin: "provider"`**（决策
  0064，见 §5）、`quoteAssetId: null`、`quoteSymbol: "USD"`、`priceUnit: "USD per ETH"`。
  GeckoTerminal 关闭 → `MARKET_POOL_NOT_REGISTERED`（没有登记池，无法链上聚合）；无主交易对 →
  `MARKET_PAIR_NOT_FOUND`。`trades`/`holders` 对未登记地址仍是 `404`。
- **已登记但没有登记池的资产走同一条 Provider 顶池路径（决策 0064）**：`asset.status` 仍是
  `pending`/`verified`（身份永远来自 registry，不会变成 `unregistered`），K 线与 §4 的
  `primaryPair`/价格类事实在本地没有 DexScreener 交易对时改由同一次 Provider 查找提供，
  `pool.origin: "provider"`。**这条路径不计配额**（registry 资产是有界集合，不构成探测）。
  Provider 也不知道任何池 → 仍是 `MARKET_POOL_NOT_REGISTERED`；Provider 不可达 → 该
  Provider 的原因码（`MARKET_PROVIDER_UNREACHABLE` 等）。`trades` 仍是
  `MARKET_POOL_NOT_REGISTERED`（那是 LOOP 自己的链上成交流水，Provider 的成交没有
  log index/区块哈希/自有钱包归属，不会冒充）；`holders` 本来就不依赖池，照常可用。

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
    "proxyAsset": null,
    "pool": {
      "address": "0x3669…",
      "protocol": "pancakeswap_v3",
      "origin": "registry",
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
- **`pool.origin`（决策 0064，必填）**：`"registry"` = LOOP 已登记并索引的池（同一个池
  支撑 `/trades` 与派生 K 线）；`"provider"` = Provider 报的顶池，LOOP 没有索引它。
  资产**没有登记池**时（不论是否已登记）就走 `"provider"`：`source: geckoterminal`、
  `pool.protocol` 是 Provider 的 dex id、`quoteAssetId: null`、`quoteSymbol: "USD"`。
  此时同一资产的 `/trades` 仍是 `MARKET_POOL_NOT_REGISTERED`——K 线有、成交流水没有，
  是正常组合，不是矛盾。GeckoTerminal 关闭、或 Provider 也不知道任何池 →
  `MARKET_POOL_NOT_REGISTERED`；Provider 不可达 → 该 Provider 的原因码。
- **原生 BNB（`eip155:56:native`）走 WBNB 代理（决策 0050）**：K 线取 WBNB 的池，
  `quality: "proxied"`，`proxyAsset: "eip155:56:0xbb4c…"`；`source` 与 `labelKey`
  照旧说明是 GeckoTerminal OHLCV 还是链上聚合（派生时 `labelKey` 仍非空，两个标注都要显示）。
  `priceUnit` 写的是**实际被定价的资产**（`USD per WBNB` / `USDT per WBNB`），顶层
  `assetId` 仍是 native。页面标注"以 WBNB 计价"，与钱包页 `valuation.quality: proxied`
  同一套文案。非代理资产 `proxyAsset` 恒为 `null`。WBNB 未登记时 native 的 K 线是
  `MARKET_NATIVE_ASSET_NOT_SUPPORTED`。成交（trades）、安全事实、持有人**不代理**。
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
    "omittedCount": 0,
    "items": [
      {
        "poolRef": {
          "kind": "poolId",
          "poolId": "0xffac50ac4e2b84e81d3edbf15aa9855b35fac78fb11c4e3b8223930587146621"
        },
        "dexId": "uniswap-v4-bsc",
        "name": "priceless / U 0.163%",
        "baseTokenAddress": "0x7d03759e5b41e36899833cb2e008455d69a24444",
        "quoteTokenAddress": "0xce24439f2d9c6a2289f741120fe202248b666666",
        "registryAssetId": null,
        "createdAt": "2026-09-17T13:54:07.000Z",
        "reserveUsd": "4.4257",
        "volumeH24Usd": "3428.8481615718"
      },
      {
        "poolRef": {
          "kind": "address",
          "address": "0xde5f97199161e6e91ea601a1a27c2d604362ffff"
        },
        "dexId": "four-meme",
        "name": "NMS / BNB",
        "baseTokenAddress": "0x…",
        "quoteTokenAddress": "0x…",
        "registryAssetId": null,
        "createdAt": "…",
        "reserveUsd": "…",
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

- **Development 栈已启用 GeckoTerminal（决策 0050）**；仓库默认与生产仍关闭。
- **`poolRef`（决策 0052，破坏性：`poolAddress` 字段已删除）**是判别联合：
  - `{kind:"address", address}`：合约池（PancakeSwap 等 V2/V3 风格），`address`
    是小写 EVM 地址，可跳交易对页 / 资产页。
  - `{kind:"poolId", poolId}`：**Uniswap V4** 池（`dexId: "uniswap-v4-bsc"`），
    `poolId` 是 `0x` + 64 位小写 hex 的 32 字节 pool id，**不是地址**。V4 池住在
    singleton 合约里，没有 PancakeSwap 交易对页面：这类行**只展示不跳转**，也
    不要把 `poolId` 送进任何按地址取数的接口（K 线 / 成交 / 安全事实都不支持）。
  - 上面样例是 2026-09-17 13:58 Development 栈实测：一页 20 条里 7 条是 V4 池。
- `omittedCount`（必填整数）现在只计**真正畸形**的行（既不是地址也不是 pool id），
  正常为 0；非 0 时页面可提示"另有 N 行无法识别"。
- `registryAssetId` 只在 base token 已登记时非空（V4 池同样按 base token 解析）；`dexId` 是 GeckoTerminal 的
  字符串标识（`pancakeswap_v2`、`four-meme`、`uniswap-v4-bsc`……），不要当枚举解析。

## 9. `GET /v2/market/smart-money` → `smart-money` 页

恒 `{"smartMoney": {"status": "unavailable", "reasonCode": "SMART_MONEY_RUNTIME_DEFERRED"}, "contractVersion": "2.0"}`，整页 unavailable。

## 10. 错误码速查

| HTTP | code                             | 出现位置                                                                                           |
| ---- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | 未知 query、坏 cursor、cursor+limit 同时、带 `Idempotency-Key`、非法 interval、非小写/畸形地址     |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | 缺失或无效 Bearer                                                                                  |
| 404  | `NOT_FOUND`                      | 模块未启用、`native` 未登记、未登记地址被所有已启用 Provider 明确否认、trades/holders 的未登记地址 |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED`     | 账号未 bootstrap                                                                                   |
| 422  | `CHAIN_MISMATCH`                 | 非 `eip155:56` 的 `assetId`                                                                        |
| 429  | `RATE_LIMITED`                   | 未登记地址查找配额用尽（asset / candles）                                                          |
| 503  | `CAPABILITY_UNAVAILABLE`         | cursor 密钥未配置（trades 分页）；未登记地址查找的配额运行时缺失                                   |

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
