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
- `instance.perAddressCurveCapMeme`（**0152 新增**）：曲线单地址累计买入上限，链上读 `maxCumulativeBuy()`（旧曲线回退 `MAX_CUMULATIVE_BUY()`），进程内按曲线缓存；链不可达时用执行器核验过的值。`dynamic.buyFeeToken`（**0152 新增**）：`usd1` = S209 Hook（地址位 0x10CC，买入税从 USD1 输入扣），`meme` = 之前。
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
  - LoopDynamic：`poolBaseBuyFeeMeme` = Σ `launch2_dynamic_fees.base_fee`（`side = buy`，MEME；**0152 修订**：只计 `fee_token = meme` 的旧 Hook 行，S209 Hook 的 USD1 买入税计入新字段 `poolBaseBuyFeeUsd1`）；`poolBaseSellFeeUsd1` = Σ `base_fee`（`side = sell`，USD1）；`dynamicFeesUsd1` = Σ `extra_fee`（`side = sell`，进奖池）——即现有 `dynamicRoundSummary`，与 dynamic-pool `summary` 同值。
  - OfficialTax：`poolBaseBuyFeeMeme` = Σ `launch2_pool_swaps.tax_amount`（`tax_token = meme`）；`poolBaseSellFeeUsd1` = 同（`tax_token = usd1`）；`dynamicFeesUsd1 = 0`。未毕业两者都是 0。
  - `totalTaxUsd1Equivalent` = 以上 USD1 部分（**0152 修订**：含 `poolBaseBuyFeeUsd1`）+ MEME 买入税 × `lastPriceUsd1`（向下取整）；有 MEME 税而没有价格时 null。
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

- **staging 的 `request.ip`**：`TRUST_PROXY` 只信任回环（`127.0.0.0/8`、`::1`）。staging 的 Caddy / cloudflared 走 docker 网络连 API 时，`request.ip` 是代理容器地址，所有访客会落在同一个限流桶（120 次 / 分钟 ≈ 20+ 个同时打开的页面，按网页 15 s / 60 s 刷新估算）。要做到真正按访客限流，需要把可信代理网段配进 `TRUST_PROXY`（另立决策），本批不动 `ops/`。 **（S211 已修订，见文末「修订（S211）」。）**
- 限流与合并读都在单进程内存里，多副本时各自计数。
- 列表里每个已毕业 LoopDynamic 行都会读一次 Hook（四个一组并发，合并读 5 s）；实例多了以后可以改成读索引状态。
- 网页本身（`ops/web/meme-page`、Vercel `loop-meme`）不在本批。

## 6. 证据

- `test/public-meme-routes.test.ts`：字段集合与 schema 必填项逐一相等、无禁用字段、CORS / 缓存头、`/v2` 无 CORS、预检 204、400 / 404 / 503（`CHAIN_READ_FAILED` / `ROUTER_NOT_CONFIGURED` / `HOOK_MISMATCH` / 旧仓库）、列表阶段过滤与单行降级、K 线来源与回退、限流窗口与 `Retry-After`、5 s 合并读、纯函数。
- `test/public-meme.integration.test.ts`（真实 PostgreSQL）：三个接口经真实路由跑真实 SQL——绑定社区（含被拒的同键社区不显示）、内盘税与 24 h 已售量、外盘税与参考价、最近关闭轮、内盘边际价 K 线、外盘 swap K 线、Hook 蜡烛按朝向换算并用桶内 swap 扩高低。
- 本机对 dev 库（只读连接 `default_transaction_read_only=on`）实测 `GET /public/v1/meme/2f0d01fa-…` 与 `/candles`：见 S203 hand-back。

## 修订（S207，2026-10-16）：真实流量下的 500 与慢请求

依据：dev 日志 2026-10-16 13:00–13:02（网页 `loop-meme.vercel.app` 每 15 s 拉详情、60 s 拉 K 线，经 Cloudflare 隧道）：同一详情 URL 两条并发，`b6869c1c` 跑 18.3 s 后 `500` + `ERROR Unhandled error in public request {errorClass: FastifyError}`，4 s 后 `WARN Reply was already sent`；另一条 3.9 s 得 503。安全边界不变（仍无鉴权、只读、同一字段集合），故不新开决策号；**无迁移、无新 env、无新依赖**。

**根因（已复现）**：`src/app.ts` 的 Fastify 构造参数 `handlerTimeout: 15_000`。Hook 读（`verifyRouter` + `readHookState`，BSC RPC 单次 6 s、多 URL 回退）超过 15 s 时，Fastify `lib/route.js` 的计时器抛出 `FST_ERR_HANDLER_TIMEOUT`（`FastifyError`，`statusCode 503`）并经作用域 `setErrorHandler` 发送；旧的 `publicErrorOf` 只认 `V2ApiError` 与 4xx，把它投影成 `500 INTERNAL_ERROR`。随后 handler 的 Promise 落定、`sendOk` 再 `send` 一次 → `FST_ERR_REP_ALREADY_SENT`（「Reply was already sent」）。`test/public-meme-resilience.test.ts` 第一条用 `handlerTimeout: 60` 逐字复现了同一序列（修前：500 + 已发送告警；修后：503 `PUBLIC_UPSTREAM_TIMEOUT`、只发一次）。`responseTimeMs 18258` 大于 15 s，推测是日志计时起点早于 handler 计时器启动（`onRequest` 钩子、事件循环排队），未单独验证，不改变结论。`requestTimeout`（Node 收完请求头 / 体的时限）对无体 GET 不相关。

| 项          | 做法                                                                                                                                                                                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单飞        | 同一 URL（`request.raw.url`）在途时所有请求共享一个 Promise：只调一次 service；成功进 5 s memo；失败时所有等待者得到同一个 503，**失败不进 memo**。在途记录保留到**底层读本身**落定：超时后到达的请求拿到同一个 503，不会再叠一次 RPC；底层读迟到的成功仍填 memo                                                                 |
| 时间预算    | `AbortSignal.timeout`：详情 8 s、列表 10 s、K 线 5 s（`publicReadBudgetsMs`，均明显低于 15 s 的 `handlerTimeout` / 请求中止时限）。到点按 `503 CAPABILITY_UNAVAILABLE` / **`PUBLIC_UPSTREAM_TIMEOUT`**（新 reasonCode）回答；signal 传进 service，列表每批 Hook 读前、详情 Hook 读前、K 线回退读前检查，已中止即不再发起下一次读 |
| 兜底        | error handler 把 `FST_ERR_HANDLER_TIMEOUT` 也投影成 503 `PUBLIC_UPSTREAM_TIMEOUT`，不再是 500                                                                                                                                                                                                                                    |
| 双发 / 断开 | handler 与 error handler 发送前检查 `reply.sent                                                                                                                                                                                                                                                                                  |     | reply.raw.destroyed`，已发送或客户端响应流已关即直接返回。**不用 `request.raw.destroyed`**：Node 24 上 `IncomingMessage`读完（空）请求体就会 destroyed，客户端其实还在等（见`src/core/http/request-abort-signal.ts`） |
| 日志        | `Unhandled error in public request` 增加 `errorCode` 与 `errorMessage`（单行、≤ 200 码点、URL 替换为 `<url>`，防 RPC 密钥 URL 落日志；不打请求体）；所有 503 记 `info` `Public read unavailable {reasonCode, errorCode}`，便于区分 RPC 超时、`CHAIN_READ_FAILED`、`HOOK_MISMATCH`                                                |
| 合同        | `openapi/loop-public.v1.json` 只有 503 描述多列出 `PUBLIC_UPSTREAM_TIMEOUT`（schema 的 `reasonCode` 本就是模式串，字段集合不变）                                                                                                                                                                                                 |

剩余风险：

- 底层 RPC 调用本身不接 signal（`Launch2DynamicChain` 无取消参数），超时后已发出的那一次 RPC 仍会跑完（受 RPC 客户端单次 6 s 约束），只是不再发起后续读；把 signal 下沉到 `rpc-client` 另做。
- 单飞与 memo 都在单进程内存；多副本各自一份。
- 预算是固定值；若 dev / staging 的 RPC 常态就 > 8 s，页面会稳定看到 `PUBLIC_UPSTREAM_TIMEOUT`，应先查 RPC（运维速查的 publicnode / NodeReal 项），再考虑调预算。

证据：`test/public-meme-resilience.test.ts`（根因复现、单飞 N=6 只调一次、失败共享且不缓存、预算 503 且 signal 已中止、超时后不叠读、迟到成功入 memo、列表 / K 线预算、真实 socket 断开后不写、错误码与脱敏消息入日志）；`test/public-meme-routes.test.ts`、`test/public-meme.integration.test.ts` 不变通过。

## 修订（S211，2026-10-16）：公开面限流按真实访客计数

依据：§5 第一条风险（staging 全站访客共用一个桶）。只改 `/public/*` 限流的**计数键**、阈值配置与 429 头；字段集合、鉴权口径、`/v2` 行为与日志全部不变，故不新开决策号。**无迁移、无新依赖**；新增两个 env（下表），缺省值与改动前等价或更严。

### 事实（写本节时核对）

- `src/app.ts` 的 Fastify `trustProxy` 只信任回环（`127.0.0.0/8`、`::1/128`，Decision 本地隧道口径，`docs/local-development.md`）。staging 的 Caddy、cloudflared 与 API 在同一个 docker 网络，连进来的对端是容器地址（`172.x`），不在信任表里，所以 `request.ip` = 代理容器地址——即使 `TRUST_PROXY=true`。
- **`ops/staging/api-staging.env` 里已经是 `TRUST_PROXY=true`**（不是 false）；改动前它对公开面没有效果（原因同上）。这意味着本批代码一部署，staging 立即按访客计数，所以缺省读哪个头必须在现有拓扑下就不可伪造（见下）。
- staging 的 API 容器没有 `ports:`，只在 docker 网络里，入口只有 Caddy（`ops/staging-direct-https.sh`：`reverse_proxy api:3000`，只加了 `header_up X-Forwarded-Proto https`）与 cloudflared（隧道）。外部无法绕过代理直连 API。
- Caddy 2.x 在没配 `trusted_proxies` 时**丢弃**客户端带来的 `X-Forwarded-For`，换成它看到的对端地址；但它**不设** `X-Real-IP`，也**不删** `CF-Connecting-IP`，客户端自带的这两个头会原样转给 API。
- Cloudflare 边缘总是覆盖 `CF-Connecting-IP`，并把客户端地址**追加**到 `X-Forwarded-For` 末尾（客户端自带的部分在左边）。cloudflared 不再追加。

### 取 IP 的规则（`publicClientKey`，`src/core/http/client-ip.ts`）

| `TRUST_PROXY` | 计数键                                                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `false`       | `request.ip`（与改动前相同，任何转发头都不看）                                                                                                                                                                                                     |
| `true`        | 按 `PUBLIC_CLIENT_IP_HEADERS` 列出的顺序取**第一个得出公网地址**的头：`cf-connecting-ip` / `x-real-ip` 必须恰好一个合法地址；`x-forwarded-for` 从**右往左**取第一个公网地址。都没有 → `request.ip`。地址统一规范化（IPv6 小写压缩、IPv4 映射还原） |

- 「公网」= 排除 `0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`、`172.16/12`、`192.168/16`、`::`、`::1`、`fc00::/7`、`fe80::/10`；非法值、带逗号的单值头、空值都跳过，不信任。
- 不用 `request.ip` 优先：在非回环代理后面它是代理地址（全员一个桶）；不用 `X-Forwarded-For` 最左：那是客户端自己写的。
- 支持的顺序就是主代理定的 `cf-connecting-ip` → `x-real-ip` → `x-forwarded-for`，但**读哪几个由 env 决定，缺省只读 `x-forwarded-for`**。理由：按上面的事实，现在的 staging 直连 Caddy 路径上，`cf-connecting-ip` 与 `x-real-ip` 是客户端可以随便写的，若缺省三者全开，部署后任何人换一个头值就得到新桶（限流失效，且能把 1 万键的表刷满后清空、连带清掉别人的窗口）。而 `x-forwarded-for` 右起第一个公网地址在两条路径上都是真实访客：Caddy 路径上它被 Caddy 改写成对端，隧道路径上 Cloudflare 追加在最右。
- 只有当**每一条**到 API 的路径都会覆盖某个头时，才把它加进列表：例如源站只接受 Cloudflare（生产方案 ①，Caddy 在 Cloudflare 后面且源站锁 Cloudflare 网段），或 Caddyfile 加了 `header_up -Cf-Connecting-Ip` / `header_up X-Real-IP {remote_host}`。
- 只影响 `/public/*` 的限流键；计数键不落库、不进日志；`/v2` 的 `request.ip`、配额与日志不变。

### 配置

| env                            | 缺省              | 范围 / 取值                                                                                                      |
| ------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_RATE_LIMIT_PER_MINUTE` | `120`             | 整数 10–10000；每访客每一分钟固定窗口，越界拒绝启动                                                              |
| `PUBLIC_CLIENT_IP_HEADERS`     | `x-forwarded-for` | `none`，或 `cf-connecting-ip`、`x-real-ip`、`x-forwarded-for` 的不重复逗号列表（按给出的顺序读）；其它值拒绝启动 |

- 仍是进程内存实现：**多副本时各自计数**，有效上限 ≈ 副本数 × 阈值；键表上限 1 万（满了先删过期窗口，仍满则清空）。
- 429 现在带 `X-RateLimit-Limit`（= 阈值）与 `X-RateLimit-Remaining: 0`（另有原来的 `Retry-After`、`Cache-Control: no-store`、CORS `*`）。helmet / 安全头策略不限制自定义响应头，未冲突。只在 429 上加，200 不加（200 会被 CDN / 浏览器缓存 15 s，剩余次数在缓存里没有意义）。`openapi/loop-public.v1.json` 的 429 增加这些响应头的声明与描述，字段集合不变。

### 各环境应设

- **staging（香港，Caddy 直连 + cloudflared 隧道，都在 docker 网络内、API 无对外端口、不可绕过）**：`TRUST_PROXY=true`（`api-staging.env` 已有）+ 缺省 `x-forwarded-for`。建议在 `ops/staging/api-staging.local.env`（或 `api-staging.env`）显式写上这两行（本批不改 `ops/`）：

  ```text
  PUBLIC_RATE_LIMIT_PER_MINUTE=120
  PUBLIC_CLIENT_IP_HEADERS=x-forwarded-for
  ```

  若以后 api-staging 改回只走 Cloudflare（Caddy 下线或源站锁 Cloudflare），可改成 `cf-connecting-ip,x-forwarded-for`。

- **dev（本机 cloudflared 经回环连 Fastify）**：现有 `TRUST_PROXY=true` 下 `request.ip` 本就是真实访客；缺省 `x-forwarded-for` 右起公网地址与之相同，不用加 env。
- **生产（docs/29 §6 未定）**：① Cloudflare 前置 → 源站必须只放行 Cloudflare 网段，然后 `TRUST_PROXY=true`、`PUBLIC_CLIENT_IP_HEADERS=cf-connecting-ip,x-forwarded-for`；若 Cloudflare 后面还有 Caddy 且未配 `trusted_proxies`，`x-forwarded-for` 会是 Cloudflare 边缘地址，所以 `cf-connecting-ip` 必须排第一。② / ③ 云负载均衡（如 ALB，追加到 XFF 末尾）或直连 Caddy → `TRUST_PROXY=true` + 缺省 `x-forwarded-for`。API 能被公网直连（不经代理）时一律 `TRUST_PROXY=false`。

### 剩余风险

- IPv6 访客按完整地址计数，同一 /64 内换地址可以绕开；需要时再按 /64 聚合。
- 同一 NAT / 运营商出口后的访客仍共用一个桶（与任何按 IP 限流相同）；阈值可按 env 调。
- 若有人把 `cf-connecting-ip` / `x-real-ip` 加进 env 而某条路径不覆盖该头，限流可被绕过——这是部署配置的责任，已在 `.env.example` 与本节写明。

证据：`test/public-client-key.test.ts`（关 / 开、三头优先级、按 env 子集与顺序、伪造 XFF 左段、私网跳过、全私网回落、单值头非法 / 私网 / 多值、IPv6 与映射地址规范化、端口与方括号形式、私网段判定、env 缺省 / 解析 / 越界拒绝）；`test/public-meme-routes.test.ts`（429 的两个新头、`TRUST_PROXY=false` 时转发头不开新窗口、代理后按 XFF 右段分访客且伪造左段 / 未配置的 `cf-connecting-ip` 不逃出窗口、env 阈值生效、`cf-connecting-ip` 优先配置下 IPv6 规范化计数）。
