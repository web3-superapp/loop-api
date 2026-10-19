# 前端联调：V2 行情（S5b / D11）

本文是 `market` 模块（决策 0034）的前端交接契约。权威机器契约为
`openapi/loop-api.v2.json`。通用规则（Base URL、`X-Request-ID`、错误体七字段、
Bearer、`X-Loop-Contract-Version: 2.0`）沿用 `docs/frontend-v2-session-api.md`、
`docs/frontend-v2-wallet-api.md` 与 `docs/api-v2-conventions.md`。

覆盖页面：`market`、`token`、`chart-full`、`token-holders`、`token-trades`、
`new-pairs`、`smart-money`，以及 `community-chat` 里贴出合约地址后的 **Token Card**
（§4a，决策 0058）；v3 情报页的行情三分类与活动位见 §12、§13（决策 0100）。`watchlist-edit` 仍走 `GET/PUT /v2/watchlist`；
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
- 所有响应 `Cache-Control: no-store`，**唯一例外**是图片代理 `GET /v2/market/logos/…`
  的 200/304（公开、可被 CDN 缓存，见 §2b；决策 0161 起不再有 302）。

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

| `quality`     | 含义                                                                                                                                                                     | UI                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `fresh`       | 在 TTL 内由 Provider 报告                                                                                                                                                | 正常显示，附来源与 `fetchedAt`    |
| `proxied`     | 原生 BNB 通过 WBNB 代理（价格事实与 K 线，只此一种代理）                                                                                                                 | 显示并标注"以 WBNB 计价"          |
| `stale`       | 已过 TTL，但 Provider 暂时不可达/被限速，仍在宽限期内；或 Provider 这次答了交易对却漏了这个字段，下发的是它上次为同一交易对报的值（`reasonCode` 给出原因，决策 0074 §4） | 显示数值 + "数据可能过期"标记     |
| `derived`     | LOOP 由链上事件聚合（只用于 K 线）                                                                                                                                       | 显示并标注"链上成交聚合"          |
| `unavailable` | `value` 为 `null`，`reasonCode` 说明原因                                                                                                                                 | 该块 unavailable，不要显示 0 或 — |

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
| `MARKET_PAIR_UNREPRESENTABLE`            | （决策 0074 §5）Provider **给了**以该资产为 base 的交易对，但每一条都带着本端拒绝的值（池标识不是地址、数字不是规范十进制），所以一条都没发布。与 `MARKET_PAIR_NOT_FOUND`（Provider 不知道任何交易对）区分：前者是"解析失败"，后者是"没有"                                                                                                                                  |
| `MARKET_SPARKLINE_*`                     | 行折线专用，见 §3a                                                                                                                                                                                                                                                                                                                                                          |

## 2a. 代币 logo：`logo` 字段（决策 0072，**URL 自决策 0089 起改为 LOOP 自己的图片代理**）

需求方 2026-09-23 裁定"token 都用真实的 logo"。**每一处下发资产行的地方**都有一个必填
`logo` 字段（严格 codec 必须把它加进键集合）：

| 接口                                  | 位置                                                |
| ------------------------------------- | --------------------------------------------------- |
| `GET /v2/market/overview`             | `watchlist.items[].logo`、`trending.items[].logo`   |
| `GET /v2/market/assets/{assetId}`     | 顶层 `logo`（已登记 / 未登记 / 原生 BNB 都有）      |
| `GET /v2/market/new-pairs`            | `newPairs.items[].logo`（该池 **base token** 的）   |
| `GET /v2/wallets/{walletId}/balances` | `balances[].logo`、`launchChain.nativeBalance.logo` |
| `GET /v2/watchlist`                   | `groups[].items[].logo`                             |
| `GET /v2/mining/assets`               | `included[].logo`、`excluded[].logo`                |
| `GET /v2/search?domain=assets`        | `results[].displaySnapshot.logo`（其它域为 `null`） |

社区详情的"绑定资产卡"没有独立投影（只有 `boundAssetKey`），用
`GET /v2/market/assets/{assetId}` 的 `logo`。Launch 项目目前没有任何投影下发 `logo`。

**为什么改（决策 0089）**：2026-09-28 中国大陆测试者不翻墙时 `raw.githubusercontent.com`
超时，直连 GitHub / DexScreener CDN 的图标全部加载失败，只剩首字母。从本步起 `url`
**一律指向本 API 的图片代理**，服务端去上游取图并缓存；上游主机不再出现在任何响应里。
**响应形状不变**，客户端无需改 codec，只要照旧加载 `url`。

形状（一个共享 schema）：

```json
{ "status": "available", "url": "https://api-dev.quant-dinger.cc/v2/market/logos/eip155:56/0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c.png", "source": "dexscreener", "observedAt": "2026-09-23T08:00:00.000Z" }
{ "status": "available", "url": "https://api-dev.quant-dinger.cc/v2/market/logos/eip155:56/native.png", "source": "trustwallet", "observedAt": null }
{ "status": "unavailable", "reasonCode": "TOKEN_LOGO_ADDRESS_UNKNOWN" }
```

- **灰度开关（决策 0089 §8）**：服务端 `TOKEN_LOGO_URL_MODE=upstream` 时，`url` 仍是 0072 的外部 URL
  （DexScreener 图或 Trust Wallet 规则 URL，主机只会是三个白名单主机之一），`source`/`observedAt` 不变，
  代理路由照常可用；缺省 `proxy` 即下述代理 URL。客户端必须**两种形式都接受**（OpenAPI `pattern` 已是两者之并）。
- **`url`** = `<PUBLIC_BASE_URL>/v2/market/logos/eip155:56/<小写地址>.png`，原生 BNB 是
  `…/native.png`。同一资产在所有接口里是**同一个 URL**（不随来源变化），CDN / 客户端图片缓存
  按 URL 命中即可。OpenAPI `pattern` 锚定为 `^https?://…/v2/market/logos/eip155:56/(0x[0-9a-f]{40}|native)\.png$`
  （本地开发 `PUBLIC_BASE_URL` 可能是 http；staging / 生产是 https）。
- `source` / `observedAt` 含义不变，只说明服务端**优先用哪个上游**：
  - `dexscreener`：该资产**自己作为 base token** 的 DexScreener 交易对上报的图片，
    `observedAt` = 该价格事实的 `fetchedAt`。作为 quote 的交易对的图片不用；原生 BNB 虽以
    WBNB 计价，但 WBNB 的图不是 BNB 的，原生行永远是 `trustwallet`。
  - `trustwallet`：Trust Wallet 资产仓库的规则文件，`observedAt` 恒 `null`。
  - 只用于来源展示与排障，**不要**据此选择加载方式。
- **logo 不是行情事实**：Provider 关闭 / 限速 / 不可达时价格块 unavailable，`logo` 仍下发。
  它也不能用来合并、匹配或识别资产（只有 `assetId` 是键）。
- `unavailable` 的 reasonCode（一开始就画 monogram，不要请求任何图片）：

| reasonCode                     | 何时                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `TOKEN_LOGO_ADDRESS_UNKNOWN`   | new-pairs 里 Provider 没给 base token 地址                                     |
| `TOKEN_LOGO_CHAIN_UNSUPPORTED` | 非 BSC 主网（Launch 槽 `eip155:97` 的 tBNB 余额行）                            |
| `TOKEN_LOGO_PROXY_UNAVAILABLE` | 后端未启用 `market` 模块，图片代理路由不存在（已部署的栈都启用，正常不会出现） |

### 2b. `GET /v2/market/logos/{chainId}/{file}` —— 图片代理（决策 0089、0161）

客户端**不需要自己拼这个 URL**，直接用 `logo.url`；这里写清它的行为，便于图片组件与排障。

- **Base URL**：与 API 同源（`PUBLIC_BASE_URL`，如 `https://api-staging.quant-dinger.cc`）。
- **公开资源**：不需要 `Authorization`、不需要 `X-Loop-Contract-Version` 或任何 LOOP 头；
  普通图片加载器（`Image.network` / `CachedNetworkImage`）直接 GET 即可。带 query 参数 → 400。
- `chainId`：`eip155:56`（`logo.url` 只会是它）；决策 0161 起路由也能读 `eip155:1`、`eip155:8453`
  （Trust Wallet 对应链目录），但**不会出现在任何 `logo.url` 里**，客户端无需改正则。
- `file`：`0x`+40 位十六进制（大小写均可，下发的都是小写）+ `.png`，或 `native.png`；
  `.webp` 后缀是同一资源（同 ETag），留给以后，当前客户端照旧用 `.png`。
- **字节恒为 128 × 128 WebP**（决策 0161：服务端把任何来源、任何尺寸的图统一转成 128 × 128、
  保留透明、不裁剪、透明底补边），`Content-Type: image/webp`，平均约 3–4 KiB。**扩展名恒 `.png`
  而内容是 WebP**——按字节 / `Content-Type` 解码（Flutter 的图片解码器按字节识别，iOS / Android 都支持 WebP）。
  决策 0161 上线前缓存的极少数旧行在刷新前可能仍返回 PNG / JPEG / GIF。
- 服务端 **预热**：主流币（BNB、WBNB、BTCB、ETH、USDT、USDC、USD1、FDUSD、CAKE、DOGE…34 个）、
  资产注册表、被自选的资产、BSC 成交额前 200 个池子的代币（去重后约 90–100 个），每 6 h 一轮、到期前 1 天刷新，所以这些图
  几乎总是直接命中缓存；运营可在后台给任意代币上传手工图标（会立刻取代上游图，客户端在缓存
  1 天后看到新图）。

| HTTP | 何时 / 响应                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200  | 128 × 128 WebP 字节，`Content-Type: image/webp`；`ETag`；`Cache-Control: public, max-age=86400, stale-while-revalidate=604800`；`X-Content-Type-Options: nosniff` |
| 200  | 同上但 `Cache-Control: public, max-age=300`：优先上游暂时失败，先给了次选来源的图，稍后会换成更好的                                                               |
| 304  | 带了 `If-None-Match` 且与当前 `ETag` 相同（空 body）                                                                                                              |
| 400  | `INVALID_REQUEST`：链不对、地址不合法、扩展名不对、带 query                                                                                                       |
| 404  | `NOT_FOUND`：所有上游都没有这张图、上游图超过 4 MiB 或无法解码（服务端记住 24 h）。新币多半没有，属正常                                                           |
| 502  | `PROVIDER_UNREACHABLE`（`retryable: true`）：上游 5 s 超时 / 网络错误 / 5xx，且服务端没有任何旧图                                                                 |
| 500  | `INTERNAL_ERROR`                                                                                                                                                  |
| 503  | `REQUEST_TIMEOUT`（整请求超时）                                                                                                                                   |

**不再有 302**（决策 0161）：以前 > 256 KiB 的图会 302 到上游，大陆打不开；现在服务端自己缩图后下发。

错误体是标准七字段（`code / category / retryable / userMessageKey / correlationId / detailsSafe /
providerReferenceSafe`）、`Cache-Control: no-store`；图片组件不需要解析它。

**unavailable 行为**：`logo.status = unavailable` 时一开始就画 monogram，不请求图片；代理路由本身没有
「能力关闭」状态，后端未启用 `market` 模块时路由不存在（404），投影已经是 `TOKEN_LOGO_PROXY_UNAVAILABLE`。

**客户端回退规则（不变）**：直接加载 `url`；**任何非 200**（404 / 502 / 断网 / 解码失败）→ 该行回退到
首字母 monogram，**每行每屏只尝试一次，不要循环重试**。可以依赖 HTTP 缓存（`ETag` + `max-age`），
不需要自建缓存。

### 2c. 后台：手工图标（决策 0161 §3，仅 loop-admin）

`/admin/v1/market/logos/{chainId}/{address}`（`address` = `0x`+40 hex 或 `native`，大小写均可）；
签名会话 cookie，无 Privy Bearer、无 `X-Loop-Contract-Version`。`Idempotency-Key` 可选（小写 UUIDv4），不去重。

| 方法     | 权限            | 请求                                                                      | 响应                                                                                                                                                                                                         |
| -------- | --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `console.read`  | —                                                                         | `200 {logo}`；无缓存行 `404 NOT_FOUND`（`TOKEN_LOGO_NOT_CACHED`）                                                                                                                                            |
| `POST`   | `console.write` | `multipart/form-data`，一个 part `file`：PNG / JPEG / WebP / GIF，≤ 2 MiB | `200 {logo, audit}`；`422 VALIDATION_FAILED`（`reasonCode = TOKEN_LOGO_UPLOAD_INVALID`、`field = file`、`logoReasonCode = TOKEN_LOGO_TYPE_UNSUPPORTED \| TOKEN_LOGO_TOO_LARGE \| TOKEN_LOGO_DECODE_FAILED`） |
| `DELETE` | `console.write` | —                                                                         | `200 {audit}`；没有手工图 `404 NOT_FOUND`（`TOKEN_LOGO_OVERRIDE_NOT_FOUND`）                                                                                                                                 |

共通：未登录 401 `ADMIN_SESSION_REQUIRED`；无权限 403 `PERMISSION_DENIED`；链 / 地址不合法或非 multipart 400 `INVALID_REQUEST`；
无数据库 503 `CAPABILITY_UNAVAILABLE`（`TOKEN_LOGO_CACHE_UNAVAILABLE`）。

```json
{
  "logo": {
    "chainId": "eip155:56",
    "address": "0x25d887ce7a35172c62febfd67a1856f20faebb00",
    "status": "found",
    "source": "manual",
    "contentType": "image/webp",
    "etag": "\"q1Yz…\"",
    "byteLength": 3712,
    "fetchedAt": "2026-10-19T08:00:00.000Z",
    "expiresAt": null,
    "url": "https://api-staging.quant-dinger.cc/v2/market/logos/eip155:56/0x25d887ce7a35172c62febfd67a1856f20faebb00.png"
  },
  "audit": { "auditId": "6f1c…", "seq": 812, "at": "2026-10-19T08:00:00.000Z" }
}
```

`source`：`dexscreener` / `trustwallet` / `manual` / `null`（missing 行）；`status`：`found` / `missing` / `oversize`；
手工图 `expiresAt = null`，永不过期、预热与按需刷新都不会覆盖，直到 `DELETE`。

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
        "logo": { "status": "available", "url": "https://api-dev.quant-dinger.cc/v2/market/logos/eip155:56/0xbb4c….png", "source": "dexscreener", "observedAt": "…" },
        "price": { "value": "747.39", "source": "dexscreener", "fetchedAt": "…", "ttlSeconds": 30, "quality": "fresh", "reasonCode": null },
        "priceChange24h": { "value": "0.27", "source": "dexscreener", "…": "…" },
        "sparkline": { "status": "available", "interval": "1h", "closes": ["747.12", "747.48", "…"], "observedAt": "2026-09-23T11:00:00.000Z", "source": "geckoterminal", "quality": "fresh" }
      }
    ]
  },
  "trending": {
    "status": "available",
    "recommendationId": "5b1f…-uuid",
    "rules": { "configVersion": "marketTrendingV1", "effectiveAt": "2026-09-08T00:00:00.000Z", "ordering": "dexscreener_volume_h24_desc" },
    "items": [ { "assetId": "…", "asset": {…}, "logo": {…}, "price": {…}, "priceChange24h": {…}, "sparkline": {…}, "volume24h": {…}, "liquidityUsd": {…} } ]
  },
  "newPairs": { "status": "unavailable", "reasonCode": "MARKET_PROVIDER_GECKOTERMINAL_DISABLED" },
  "smartMoney": { "status": "unavailable", "reasonCode": "SMART_MONEY_RUNTIME_DEFERRED" },
  "observedAt": "2026-09-08T07:31:02.300Z",
  "contractVersion": "2.0"
}
```

- `watchlist.items` 顺序 = 自选顺序（跨分组去重）；`asset: null` +
  `price.reasonCode: ASSET_NOT_READABLE` 表示该资产已不可读（这种行的 `logo` 仍下发，`source: trustwallet`）。
- 每行必填 `logo`（§2a）。
- `trending` 只是**按 DexScreener 24h 成交量排序的 registry 资产**（最多 20），
  `recommendationId` 每次响应新生成，UI 上报"看到了哪一份排序"时带上它。
  原型里的"成员数 / 算力倍数"没有后端，不要渲染或必须标 unavailable。
- `priceChange24h.value` 可能为负数字符串（`"-3.2"`）。
- **`priceChange24h` 的 `stale`（决策 0074 §4）**：DexScreener 会对某个池**间歇性**不报
  `priceChange.h24`（2026-09-23 实测：LINK 主池连续约 100 秒没有该键，然后恢复；BTCB 的
  两个池在 5 分钟内各缺失一次）。此时后端下发它**上一次为同一交易对**报的数值：
  `{ "value": "-0.31", "source": "dexscreener", "fetchedAt": "<上次报出的时间>", "ttlSeconds": 30, "quality": "stale", "reasonCode": "MARKET_FACT_NOT_REPORTED" }`。
  客户端按 §2 的 `stale` 规则显示数值并加"数据可能过期"标记，不要把它当成 unavailable。
  只有当上次的值也不存在、属于另一个交易对、或已超过 TTL + 宽限期（默认 30 s + 900 s），
  才是 `{ "value": null, "quality": "unavailable", "reasonCode": "MARKET_FACT_NOT_REPORTED" }`
  （Provider 确实没给）。`MARKET_PAIR_UNREPRESENTABLE` 则是"Provider 给了交易对但每一条
  都解析失败"（§2 表）。
- **每行必填 `sparkline`（决策 0074，见 §3a）。严格 codec 必须把它加进两种行的键集合。**
- **响应时间（决策 0086）**：总览的两次 Provider 读取（DexScreener 批量、GeckoTerminal
  新池）同时发出，共用 1.2 s 截止。某个 Provider 卡住时总览仍在约 1.2 s 内返回，
  受影响的 fact 按"Provider 不可达"处理：宽限期内有缓存就是 `quality: "stale"` +
  `reasonCode: "MARKET_PROVIDER_UNREACHABLE"`，否则 `unavailable` + 同一 reasonCode；
  其它行、其它块不受影响。形状与 reasonCode 集合不变，客户端无需改动。
- **`newPairs`（决策 0053）**：可用变体是 `{ "status": "available", "omittedCount": 0 }`，
  `omittedCount` **必填**、与 `GET /v2/market/new-pairs` 的 `newPairs.omittedCount`
  **同源同值**（同一份 GeckoTerminal 缓存 fact）。`available` 现在意味着新币页此刻
  确实读得到数据，不再只是"有 Provider"：Provider 关闭是
  `MARKET_PROVIDER_GECKOTERMINAL_DISABLED`；Provider 开着但 fact 读不到（不可达 /
  畸形 / 缓存不可用）是 `{status:"unavailable", reasonCode}`，reasonCode 与新币页
  报的一致。行情 Tab 卡片可以印 `omittedCount`（正常为 0，表示"有 N 条池子因标识
  畸形没列出"）；`items` 不在总览里，进页再读。**严格 codec 必须把 `omittedCount`
  加进可用变体的键集合。**

## 3a. 行折线：`watchlist.items[].sparkline` / `trending.items[].sparkline`（决策 0074）

用户 2026-09-23 真机反馈：热门榜 11 行只有 4 行有小折线。原因是客户端
`MarketRowSparkline(assetId)` 逐行调 `GET /v2/market/assets/{id}/candles?interval=1h`，
每行都打 GeckoTerminal（30 次/分钟），一屏就把配额用完，后半屏全部
`MARKET_PROVIDER_RATE_LIMITED`。从本步起：

- **行折线由服务端投影**，随 `overview` 一起下发；**客户端不要再逐行调 `/candles`**。
  Token 页自己的图表仍用 `/candles`。
- 数据来自 worker 预热的缓存行（`market_fact_cache` 的 `sparkline_1h`，每个资产一行，
  来自该资产一个池的最近 24 根 1H K 线）。**请求路径只读缓存、不打 Provider**，所以它
  要么马上有、要么 `unavailable`，绝不会因为限流而一半有一半没有。

形状：

```json
{ "status": "available", "interval": "1h", "closes": ["747.12", "747.48", "…"], "observedAt": "2026-09-23T11:00:00.000Z", "source": "geckoterminal", "quality": "fresh" }
{ "status": "unavailable", "reasonCode": "MARKET_SPARKLINE_NOT_CACHED" }
```

| 字段         | 说明                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interval`   | 恒 `"1h"`                                                                                                                                           |
| `closes`     | 1–24 个十进制**字符串**，按时间从旧到新，最后一个是当前未收盘的小时；用 `Decimal` 解析。不补零、不插值；少于 24 个就画少于 24 个点                  |
| `observedAt` | 这批 K 线从 GeckoTerminal 取到的时间                                                                                                                |
| `source`     | 恒 `"geckoterminal"`                                                                                                                                |
| `quality`    | `fresh`（TTL 内，默认 300 s）/ `stale`（过 TTL 但在宽限期内，仍可画）/ `proxied`（原生 BNB 读 WBNB 的行，与价格事实同一代理规则，不会同时是 stale） |

`unavailable` 的 `reasonCode`：

| reasonCode                               | 含义                                                 | UI       |
| ---------------------------------------- | ---------------------------------------------------- | -------- |
| `MARKET_PROVIDER_GECKOTERMINAL_DISABLED` | 后端关闭了 GeckoTerminal（生产默认）                 | 留空占位 |
| `MARKET_SPARKLINE_NOT_CACHED`            | 预热 lane 还没写过这个资产（刚部署/刚登记）          | 留空占位 |
| `MARKET_SPARKLINE_EXPIRED`               | 缓存行超过 TTL + 宽限期（lane 停了或该资产持续失败） | 留空占位 |
| `MARKET_SPARKLINE_EMPTY`                 | Provider 对该池没有任何 K 线                         | 留空占位 |
| `MARKET_FACT_CACHE_UNAVAILABLE`          | 缓存读不到                                           | 留空占位 |
| `ASSET_NOT_READABLE` / `ASSET_BLOCKED`   | 与该行 `price` 相同                                  | 留空占位 |

客户端规则：有 `closes` 就画（`quality` 只影响可选的"可能过期"标记）；`unavailable` 留空
占位，不要重试、不要回退到 `/candles`。原因不必在行内展示，Token 页有空间说明。

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
  "logo": { "status": "available", "url": "https://api-dev.quant-dinger.cc/v2/market/logos/eip155:56/0xbb4c….png", "source": "dexscreener", "observedAt": "…" },
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
- 顶层 `logo` 必填（§2a）：`url` 恒为图片代理；`primaryPair` 带图时 `source: dexscreener`，否则（含原生 BNB、
  Provider 关闭、未登记地址走 GeckoTerminal 路径）`source: trustwallet`。
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

### 4.1 顶层 `range24h`：24h 高 / 24h 低（决策 0074 §1b）

交易所式代币页首屏的两格，**客户端不要自己从 K 线算**。与 §3a 的行折线**同一份缓存行**
（同一个池的最近 24 根 1H K 线），请求路径不打 Provider：

```json
"range24h": { "status": "available", "high": "748.9", "low": "746.5", "bars": 24, "observedAt": "2026-09-23T11:00:00.000Z", "source": "geckoterminal", "quality": "fresh" }
"range24h": { "status": "unavailable", "reasonCode": "MARKET_SPARKLINE_NOT_CACHED" }
```

| 字段         | 说明                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| `high`/`low` | 这 24 根 K 线里最高的 high / 最低的 low，十进制**字符串**，用 `Decimal` 解析                            |
| `bars`       | 覆盖了几根 K 线（1–24）。**不足 24 根也是 `available`**，`bars` 说明只有 N 小时历史；UI 可标"仅 N 小时" |
| `observedAt` | 这批 K 线从 GeckoTerminal 取到的时间                                                                    |
| `quality`    | 与 §3a 相同：`fresh` / `stale`（可显示 + "可能过期"）/ `proxied`（原生 BNB 读 WBNB 的行）               |

`unavailable` 的 `reasonCode` 与 §3a 同一张表（同一行）：`MARKET_PROVIDER_GECKOTERMINAL_DISABLED`、
`MARKET_SPARKLINE_NOT_CACHED`（预热 lane 还没写这个资产；**未登记地址**（§4a）不在预热范围，
恒为此码）、`MARKET_SPARKLINE_EXPIRED`、`MARKET_SPARKLINE_EMPTY`、`MARKET_FACT_CACHE_UNAVAILABLE`、
`ASSET_BLOCKED`。unavailable 时两格留空占位，不要回退到 `/candles` 自己算。
**严格 codec 必须把 `range24h` 加进 `GET /v2/market/assets/{assetId}` 的键集合**（已登记、
未登记、原生三种都有）。

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
        "logo": {
          "status": "available",
          "url": "https://api-dev.quant-dinger.cc/v2/market/logos/eip155:56/0x7d03759e5b41e36899833cb2e008455d69a24444.png",
          "source": "trustwallet",
          "observedAt": null
        },
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
        "logo": {
          "status": "available",
          "url": "…/v2/market/logos/eip155:56/<小写地址>.png",
          "source": "trustwallet",
          "observedAt": null
        },
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
- `logo` 必填（§2a）：`url` 是 `baseTokenAddress` 的图片代理地址（`source: trustwallet`，
  代理取图时若该地址已有 DexScreener 交易对缓存则优先用它的图）；`baseTokenAddress: null` 时是
  `{status:"unavailable", reasonCode:"TOKEN_LOGO_ADDRESS_UNKNOWN"}`（画 monogram）。
  新币多半没有图，代理回 404 → monogram，属正常。

## 9. `GET /v2/market/smart-money` → `smart-money` 页

恒 `{"smartMoney": {"status": "unavailable", "reasonCode": "SMART_MONEY_RUNTIME_DEFERRED"}, "contractVersion": "2.0"}`，整页 unavailable。

## 10. 错误码速查

| HTTP | code                             | 出现位置                                                                                                                                                                                      |
| ---- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | 未知 query、坏 cursor、cursor+limit 同时、带 `Idempotency-Key`、非法 interval、非小写/畸形地址；分类列表缺 `category` / 未知 `category`、`sort`、`limit` 越界、cursor 与 category/sort 不匹配 |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | 缺失或无效 Bearer                                                                                                                                                                             |
| 404  | `NOT_FOUND`                      | 模块未启用、`native` 未登记、未登记地址被所有已启用 Provider 明确否认、trades/holders 的未登记地址                                                                                            |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED`     | 账号未 bootstrap                                                                                                                                                                              |
| 422  | `CHAIN_MISMATCH`                 | 非 `eip155:56` 的 `assetId`                                                                                                                                                                   |
| 429  | `RATE_LIMITED`                   | 未登记地址查找配额用尽（asset / candles）                                                                                                                                                     |
| 502  | `PROVIDER_UNREACHABLE`           | 只有图片代理 `GET /v2/market/logos/…`：上游超时/失败（§2b）                                                                                                                                   |
| 503  | `CAPABILITY_UNAVAILABLE`         | cursor 密钥未配置（trades 分页、分类列表）；未登记地址查找的配额运行时缺失；`meme`/`community` 分类的候选来源未组装                                                                           |

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

## 12. `GET /v2/market/assets?category=…` → 情报页「行情」三分类（决策 0100）

```
GET /v2/market/assets?category=major|meme|community[&sort=marketCap|change24h|volume24h][&limit=1..50]
GET /v2/market/assets?category=…&sort=…&cursor=<nextCursor>
Authorization: Bearer <Privy access token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: <semver>
```

- `category` 必填；`sort` 默认 `marketCap`；`limit` 默认 30、最大 50。翻页时**同时带原来的
  `category` 与 `sort`** 加 `cursor`，**不要再带 `limit`**（带了 400，页大小在 cursor 里）。
  cursor 绑定账号、category、sort，600 秒过期；过期/不匹配 → 400，前端回到第一页重拉。
- 「自选」chip 不走本接口，仍读 `GET /v2/market/overview` 的 `watchlist`。
- 三个分类的来源：
  - `major`：后端静态白名单（configVersion `marketCategoriesV1`）里 Registry 已登记且未封禁的资产。
    当前 Development 为 BNB、USDT、WBNB、BTCB、ETH、XRP、ADA、DOT、LINK、UNI、Cake（USDC 未登记，不在列）。
  - `meme`：每个已登记 Launch 发售的项目代币（去重，**含 BSC 测试网**，测试网行情一定是 `quote: null`）。
  - `community`：已认证社区绑定的代币，每行带 `community`。
- 排序：按 sort 字段从大到小；该数字缺失（`quote: null` 或 quote 里该字段为 null）的行排在所有有值行之后；
  并列时按 `assetId` 升序。翻页期间价格变化可能让某行跨页移动，不会重复同一个 key、不会死循环。
- `meme` 候选范围（决策 0105）：未毕业的 MEME 曲线币按**当前 `sort`** 由数据库取前 100（市值/涨幅/成交额
  都由曲线快照与成交算出），已毕业 MEME 币与 Launch 项目币按毕业/登记时间取最近 100，不再按 assetId 截断。
- 已毕业 MEME 币没有 DexScreener 报价时的池子 `slot0` 价（`source: "pool_slot0"`）只给**当前页**的行补上
  （一页一次批量读），**不参与排序**：这类行按「无值」排在有值行之后，但显示时可能带价格。

响应（2026-10-08 形状示例，数字为示意）：

```json
{
  "category": "community",
  "sort": "marketCap",
  "items": [
    {
      "assetId": "eip155:56:0x55d398326f99059ff775485246999027b3197955",
      "symbol": "USDT",
      "name": "Tether USD",
      "logoUrl": "https://api-dev.quant-dinger.cc/v2/market/logos/eip155:56/0x55d398326f99059ff775485246999027b3197955.png",
      "quote": {
        "priceUsd": "1.0001",
        "change24hPct": "-0.02",
        "marketCapUsd": "6012345678",
        "volume24hUsd": "512345678.9",
        "observedAt": "2026-10-08T09:30:00.000Z",
        "source": "dexscreener",
        "quality": "fresh"
      },
      "sparkline": {
        "status": "available",
        "interval": "1h",
        "closes": ["1.0002", "1.0001"],
        "observedAt": "2026-10-08T09:00:00.000Z",
        "source": "geckoterminal",
        "quality": "fresh"
      },
      "community": {
        "communityId": "439cabe6-4c98-4f99-860f-192ad52403a1",
        "name": "Builders Guild",
        "logoRef": "logo:media/0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e"
      }
    },
    {
      "assetId": "eip155:97:0x358d40a1a2b02d550c64e7a9b8dc599f8219d976",
      "symbol": "LTPT",
      "name": "Loop Test Project Token",
      "logoUrl": null,
      "quote": null,
      "quoteUnavailable": { "reasonCode": "MARKET_CHAIN_NOT_PRICED" },
      "sparkline": {
        "status": "unavailable",
        "reasonCode": "MARKET_CHAIN_NOT_PRICED"
      }
    }
  ],
  "nextCursor": null,
  "rules": {
    "configVersion": "marketCategoriesV1",
    "effectiveAt": "2026-10-08T00:00:00.000Z",
    "ordering": "dexscreener_market_cap_desc"
  },
  "observedAt": "2026-10-08T09:30:01.123Z",
  "contractVersion": "2.0"
}
```

（第二行实际只会出现在 `category=meme`；这里放在一起只为展示 null 分支。）

行字段：

| 字段                                | 说明                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logoUrl`                           | 与 overview 行 `logo.url` 同一规则；`null` → 画字母头像                                                                                                                                                                                                                                                                                                                          |
| `quote`                             | 主交易对（最深的 base pair）的 DexScreener 数字；全部是十进制字符串。`change24hPct` 为百分点（`"-2.5"` 即 −2.5 %）。quote 内某字段 `null` = Provider 本次没报这个数，显示「—」                                                                                                                                                                                                   |
| `quote.quality`                     | `fresh` / `stale`（超 TTL、仍在宽限期，可加「延迟」小字）/ `proxied`（BNB 原生币用 WBNB 定价）                                                                                                                                                                                                                                                                                   |
| `quote.observedAt` + `quote.source` | 合并成一行 `LoopProvenanceLine`（「DexScreener · 观察于 HH:mm」）                                                                                                                                                                                                                                                                                                                |
| `quoteUnavailable.reasonCode`       | 仅 `quote: null` 时出现：`MARKET_CHAIN_NOT_PRICED`（测试网等不读行情的链）、`MARKET_PROVIDER_DEXSCREENER_DISABLED`、`MARKET_PROVIDER_UNREACHABLE`、`MARKET_PROVIDER_RATE_LIMITED`、`MARKET_PAIR_NOT_FOUND`、`MARKET_PAIR_UNREPRESENTABLE`、`MARKET_FACT_NOT_REPORTED`、`MARKET_FACT_CACHE_UNAVAILABLE`。行照常显示 symbol/name，价格位用 `LoopInlineUnavailable`，**不要显示 0** |
| `sparkline`                         | 与 overview 行相同（§3a）                                                                                                                                                                                                                                                                                                                                                        |
| `community`                         | 仅 `category=community`；`logoRef` 解析方式与社区资料相同                                                                                                                                                                                                                                                                                                                        |

unavailable 行为：

- DexScreener 关闭或不可达：仍是 `200`，每行 `quote: null` + 原因；不是 HTTP 错误。
- `meme` / `community` 的候选来源（数据库）不可用：`503 CAPABILITY_UNAVAILABLE`（不会返回空列表冒充「没有币」）。
  `major` 只依赖 Registry。
- cursor 密钥未配置：三个分类都 `503`。
- 空分类（例如还没有任何 Launch 登记项目代币）是真实的 `items: []` + `nextCursor: null`，显示空态。

## 13. `GET /v2/intel/promotions` → 情报页活动位（决策 0100）

```
GET /v2/intel/promotions
Authorization: Bearer <Privy access token>
X-Loop-Contract-Version: 2.0
```

无 query（带了 400）。响应：

```json
{
  "items": [
    {
      "id": "5b0f8a2e-6d1c-4e7a-9b3f-2c8d4e6f1a01",
      "title": "LOOP 挖矿算力周榜",
      "subtitle": "看看本周谁的算力最高",
      "imageUrl": null,
      "deeplink": "/intel",
      "startsAt": "2026-10-08T00:00:00.000Z",
      "endsAt": "2027-01-01T00:00:00.000Z",
      "order": 1
    },
    {
      "id": "5b0f8a2e-6d1c-4e7a-9b3f-2c8d4e6f1a02",
      "title": "推荐社区",
      "subtitle": "发现正在活跃的社区",
      "imageUrl": null,
      "deeplink": "/square",
      "startsAt": "2026-10-08T00:00:00.000Z",
      "endsAt": "2027-01-01T00:00:00.000Z",
      "order": 2
    }
  ],
  "configVersion": "intelPromotionsV1",
  "effectiveAt": "2026-10-08T00:00:00.000Z",
  "contractVersion": "2.0"
}
```

- 只返回当前生效（`startsAt <= now < endsAt`）的卡片，按 `order` 升序；`items: []` → 隐藏活动位整块。
- `deeplink` **只会**是 app 内路由：`/intel`、`/square`、`/meme`、`/community/profile?id=<communityId>`。
  后端启动时校验，任何外链/scheme 都进不了响应；前端仍应只用 GoRouter 内部跳转，不交给浏览器。
- `imageUrl` 为 `null` 时前端用自己的卡片底图；非 null 时一定是 https。
- 错误：400（带 query）、401、409 `ACCOUNT_BOOTSTRAP_REQUIRED`；`market` 模块未启用时 404。
