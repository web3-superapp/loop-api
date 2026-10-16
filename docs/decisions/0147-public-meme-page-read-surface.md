# 0147 · 单 MEME 公开网页只读面 `/public/v1/meme*`（S203-api，2026-10-16）

依据：主代理 S203 数据合同（2026-10-16 定稿，api 与 web 两边共用）；需求方原话「单 meme 需要单独网页：K 线、绑定的社区口号；目前动态税、已累计悬挂奖池、悬挂状态是否开启；总税收、已回购数量。网页用 Vercel 发布」。本仓 Decision 0063 / 0090（well-known 无鉴权公开路由）、0131 / 0132 / 0144 / 0146（LoopDynamic 读模型与 503 口径）、0121（回购账本）、0125（社区绑定 MEME）、0138（项目资料与链接）。
范围：只在 `loop-api`。**无迁移、无新 env、无新依赖**。新增路由进**新的** OpenAPI 产物 `openapi/loop-public.v1.json`（contract surface `public`，tag `public`，`pnpm openapi:generate / openapi:check` 一并生成与核对）：`openapi/loop-api.v1.json` 是冻结的 V1 产物（`test/openapi.test.ts` 钉了 sha256，字节级不变），`loop-api.v2.json` 是 App 合同，两者都不动。运行时（`runtime` surface）照常挂载。未碰 `ops/`、launchd、dev 库（实测只用只读连接）。

## 1. 结论

| 项         | 做法                                                                                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 位置       | `/public/v1/meme`、`/public/v1/meme/{instanceId}`、`/public/v1/meme/{instanceId}/candles`。在 `/v2` 之外，类比 `/.well-known/*`：**无 Bearer、无 `X-Loop-Contract-Version`、无 `Idempotency-Key`**，GET 只读，不写库                                                    |
| 暴露口径   | 只给链上本就公开、或 App 里任何登录用户都能看到的聚合事实：名称、价格、Hook 轮次状态、已索引的税与回购总额、绑定社区的公开资料。**绝不**出现钱包 / 用户 / viewer / owner / 买家 / 交易者字段（`currentRoundBuyers` 的地址只取个数），也不出现私钥或签名材料             |
| 社区       | 只给公开资料：`communityId`、名称、口号、描述、成员数、是否认证、头像。`rejected` 社区不显示                                                                                                                                                                            |
| 复用       | Hook 一致快照与轮次汇总直接复用 dynamic-pool 的读取（抽成 `dynamicPoolRead`，App 的 `/v2/.../dynamic-pool` 走同一段）；实例详情、回购摘要、阶段推导、项目资料投影都用现有函数；新增的只有一条事实 SQL 与三条 K 线 SQL（§3、§4）                                         |
| 失败关闭   | Hook 读不到、注册表 / 路由 / 池子不一致等按现有 503 `reasonCode` 原样透出（`LAUNCH2_CHAIN_READ_FAILED`、`LAUNCH2_DYNAMIC_HOOK_MISMATCH`、`LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED`…），**不返回半截**；`officialTax` 实例与未毕业实例 `dynamic = null`，不 503            |
| 列表的例外 | 列表里某个已毕业 LoopDynamic 行的 Hook 读不到时，**该行** `dynamic = null` 并在 `dynamicReasonCode` 写明 503 原因（其详情接口照样 503）；仓库 / 数据库失败仍是整表 503。理由：测试网仍有绑旧路由的历史实例（实测 2 个 `HOOK_MISMATCH`），一行不可读不应让整张列表不可用 |
| CORS       | 只对 `/public/*` 加 `Access-Control-Allow-Origin: *`（错误与 `OPTIONS` 预检 204 也加；`Cross-Origin-Resource-Policy: cross-origin` 覆盖 helmet 的 same-origin）；`/v2` 一律不加。手写封装插件内的 `onRequest` hook，**不加 `@fastify/cors`**                            |
| 缓存       | 200：`Cache-Control: public, max-age=15`；所有错误：`no-store`                                                                                                                                                                                                          |
| 限流       | 仓库现有限流器（`alias-search-quota` 等）依赖库表 + HMAC 密钥，不适合无身份的公开面；用 Fastify `onRequest` hook 的最简实现：按 `request.ip` 每分钟固定窗口 120 次，进程内存，超出 429 `RATE_LIMITED` / `PUBLIC_RATE_LIMITED` + `Retry-After`。预检不计数               |
| 合并读     | 同一 URL 的 200 结果进程内共享 5 秒（≤ 500 条），突发访问对每个实例每 5 秒至多一次 Hook 读                                                                                                                                                                              |
| 错误体     | `{ code, reasonCode }`：`400 INVALID_REQUEST`（`PUBLIC_LIMIT_INVALID` / `PUBLIC_STAGE_INVALID` / `PUBLIC_CANDLE_INTERVAL_UNSUPPORTED`）、`404 NOT_FOUND`（`LAUNCH2_INSTANCE_NOT_FOUND` / `PUBLIC_NOT_FOUND`）、`429`、`503 CAPABILITY_UNAVAILABLE`（launch2 原因原样）  |
| 模块门     | 与 `/v2/launch2` 同一个服务：`V2_MODULES_ENABLED` 不含 `launch2` 时全部 503 `V2_LAUNCH2_MODULE_DEFERRED`                                                                                                                                                                |

## 2. 字段口径（详情）

- `instance.stage`：按时钟推导（与 App 同一 `deriveLaunch2StageOf`）；`createdAt` = 链上激活时间（无则登记时间）；`hookAddress`：LoopDynamic = 毕业时绑定的 Hook（未绑定 null），OfficialTax = 注册表 Hook；`poolId` = `Graduated.officialPoolId`；`explorerBaseUrl` 按 CAIP-2（97 → testnet.bscscan.com，56 → bscscan.com）。
- `instance.socials`：创建者保存的链接（0138：http(s)、≤ 5、原顺序）里第一个 x.com / twitter.com → `x`，第一个 t.me / telegram.me / telegram.org → `telegram`，第一个其它 → `website`。
- `community.slogan`：社区表**没有单独的口号字段**，口号取公开描述的第一行（折叠空白，≤ 60 个码点，超出加「…」，与 0138 摘要同规则）；描述本身也是单行（库约束），所以通常口号 = 描述。`avatarUrl` 恒为 `null`：社区头像是 App 内置预设（`avatar:preset/…`）或需要登录的媒体（`logo:media/…`），没有公开 URL。
- `price.lastPriceUsd1`：已毕业 = 最后一笔已索引外盘 swap 后的价格（还没有 swap 时用曲线终价）；未毕业 = 曲线当前价（投影）。`asOf` = 最后外盘成交时间，否则投影时间。
- `price.change24hPct`：`(last − ref) / ref × 100`，向零截断到两位小数。`ref`：已毕业 = 24 h 前（含）最后一笔 swap 的价格，没有则 24 h 窗口内第一笔 swap 的价格，都没有 null；未毕业 = 截止 24 h 前已售量 `s`（Σ 买 − Σ 卖 MEME）对应的曲线价 `p(s)`（曲线价只由已售量决定，所以这是 24 h 前的精确价格）。
- `dynamic`（只在已毕业 LoopDynamic）：一次 Hook 快照（同一块，`asOfBlock`），路由、PoolManager、池子 ID、MEME、名单路由逐项校验（0131 / 0132）。
  - `armed` = Hook `armed()`（悬挂状态是否开启）；`currentRound` 只在 armed 时有：`roundId`、`startCandle`（Hook `rounds(id).startCandle`）、`openPriceUsd1` = **当前 5 分钟蜡烛的开盘价**（S193 规则下第一根收盘 ≥ 开盘的蜡烛结束本轮，0144）、`buyerCount`（0146 合并权重的地址数）、`totalBuyWeightUsd1`。
  - `currentDynamicTaxBps` = `min(drop, cap)`（与 dynamic-pool 同值，0 = 只收基础 2 %）；`maxDynamicFeeBps`；`baseBuyFeeBps` / `baseSellFeeBps` = Hook 的 ppm / 100。
  - `pendingPotUsd1 = carryUsd1 + currentRoundDynamicFeesUsd1`，即 dynamic-pool 的 `potUsd1 = carry + roundExtraFees`（未 armed 时本轮动态税记 0，奖池 = carry）。
  - `lastClosedRound` = `launch2_dynamic_rounds` 里最新一条 `closed` 行（`allocation_usd1`、`buyer_count`、`closed_at`）。
- `totals`（§3 的 SQL + 现有轮次汇总）：
  - `curveTaxUsd1` = Σ `launch2_trades.tax_usd1`（内盘买卖各 10 %，USD1）。
  - LoopDynamic：`poolBaseBuyFeeMeme` = Σ `launch2_dynamic_fees.base_fee`（`side = buy`，MEME）；`poolBaseSellFeeUsd1` = Σ `base_fee`（`side = sell`，USD1）；`dynamicFeesUsd1` = Σ `extra_fee`（`side = sell`，进奖池）——即现有 `dynamicRoundSummary`，与 dynamic-pool `summary` 同值。
  - OfficialTax：`poolBaseBuyFeeMeme` = Σ `launch2_pool_swaps.tax_amount`（`tax_token = meme`）；`poolBaseSellFeeUsd1` = 同（`tax_token = usd1`）；`dynamicFeesUsd1 = 0`。未毕业两者都是 0。
  - `totalTaxUsd1Equivalent` = 以上 USD1 部分 + MEME 买入税 × `lastPriceUsd1`（向下取整）；有 MEME 税而没有价格时 null。
  - `rewardsAllocatedUsd1` / `rewardsClaimedUsd1` = Σ `launch2_dynamic_rounds.allocation_usd1` / `claimed_usd1`（`claimed_usd1` 由 `launch2_dynamic_claims` 投影而来）；OfficialTax 为 0。
  - `buyback` = 回购账本（0121）：`executedCount` / `spentUsd1` / `boughtMeme` / `lastAt` 来自 `launch2_buybacks`（executed、未回滚）的实例投影，`escrowRemainingUsd1` = NFT 收入 − 已花（与 `/v2` 详情 `escrowAvailableUsd1` 同口径），`recipientAddress` = 注册表回购接收地址。本实现**总是给对象**（合同允许 null，未用到）。
- 所有求和都跳过 reorg 回滚（`removed`）的事实。

## 3. 事实 SQL（`getPublicMemeFacts`，一条）

对 `instance_id = any($1)` 的每个实例一行：

- 社区：`communities.bound_asset_key = '<chainId>:<lower(meme)>'` 且非 `rejected`，按 `created_at` 取最早一条（0125 只会绑定一个）；
- 内盘：`launch2_trades` 的 Σ `tax_usd1`，以及 `traded_at ≤ since` 的 Σ（买 − 卖）MEME；
- 外盘：`launch2_pool_swaps` 按 `tax_token` 分开的 Σ `tax_amount`；
- 最近关闭轮：`launch2_dynamic_rounds` `closed` 的最大 `round_id`；
- 外盘参考价：`swapped_at ≤ since` 的最后一笔，否则 `> since` 的第一笔。

`since = now − 24 h`（服务时钟）。没有返回某个实例的行即 503 `LAUNCH2_REPOSITORY_UNAVAILABLE`。

## 4. K 线（`listPublicCandles`）

- 只接受 `interval=5m`（缺省即 5m），其它值 400；`limit` 1–300（默认 300），取最新的 N 个桶、按时间正序返回；价格单位 USD1 / MEME。
- **未毕业（`source: curve`）**：`launch2_trades` 按日志顺序累计已售量 `s`，每笔成交按成交后的曲线边际价 `div(Qv·Tv·1e18, (Tv − s)²)`（= `launch2PriceAt(s)`，常量由 TS 传入）定价，5 分钟分桶取首 / 高 / 低 / 尾；`v` = Σ `usd1_gross`（含税）。
- **已毕业 OfficialTax（`source: pool`）**：`launch2_pool_swaps.price_e18`（每笔 swap 后价格）5 分钟分桶；`v` = Σ `usd1_amount`。
- **已毕业 LoopDynamic（`source: pool`）**：`launch2_dynamic_candles`（Hook `CandleClosed`，同一 `candle_id` 取最新未回滚的一条）的开 / 收 sqrt 价，按 lane 在该实例 `Swap` 事件上记下的 `memeIsCurrency0` 换算（`price = sqrtP² / 2¹⁹²` 或其倒数）；高 / 低再与该 5 分钟桶内的 swap 价取 max / min；`v` = 桶内 swap 的 USD1 之和（被 poke 关掉的空蜡烛为 0）。Hook 蜡烛的开盘价 = 上一根收盘价，与轮次规则比较的是同一对价格。没有朝向事实（还没有已索引 swap）或还没有 Hook 蜡烛时，退回上一条外盘 swap 聚合。
- 毕业前的曲线 K 线不拼进外盘序列。

## 5. 风险与未做

- **staging 的 `request.ip`**：`TRUST_PROXY` 只信任回环（`127.0.0.0/8`、`::1`）。staging 的 Caddy / cloudflared 走 docker 网络连 API 时，`request.ip` 是代理容器地址，所有访客会落在同一个限流桶（120 次 / 分钟 ≈ 20+ 个同时打开的页面，按网页 15 s / 60 s 刷新估算）。要做到真正按访客限流，需要把可信代理网段配进 `TRUST_PROXY`（另立决策），本批不动 `ops/`。
- 限流与合并读都在单进程内存里，多副本时各自计数。
- 列表里每个已毕业 LoopDynamic 行都会读一次 Hook（四个一组并发，合并读 5 s）；实例多了以后可以改成读索引状态。
- 网页本身（`ops/web/meme-page`、Vercel `loop-meme`）不在本批。

## 6. 证据

- `test/public-meme-routes.test.ts`：字段集合与 schema 必填项逐一相等、无禁用字段、CORS / 缓存头、`/v2` 无 CORS、预检 204、400 / 404 / 503（`CHAIN_READ_FAILED` / `ROUTER_NOT_CONFIGURED` / `HOOK_MISMATCH` / 旧仓库）、列表阶段过滤与单行降级、K 线来源与回退、限流窗口与 `Retry-After`、5 s 合并读、纯函数。
- `test/public-meme.integration.test.ts`（真实 PostgreSQL）：三个接口经真实路由跑真实 SQL——绑定社区（含被拒的同键社区不显示）、内盘税与 24 h 已售量、外盘税与参考价、最近关闭轮、内盘边际价 K 线、外盘 swap K 线、Hook 蜡烛按朝向换算并用桶内 swap 扩高低。
- 本机对 dev 库（只读连接 `default_transaction_read_only=on`）实测 `GET /public/v1/meme/2f0d01fa-…` 与 `/candles`：见 S203 hand-back。
