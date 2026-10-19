# 0161 · 代币图标：服务端归一化、预热与手工覆盖（S238-api，2026-10-19）

## 1. Status

已实现（分支 `feat/S238-token-logo-prewarm`，基线 `integration/v2` = `40921be`）。迁移 `000092_token_logo_normalized_manual`；新 worker lane `token_logo_prewarm`；新脚本 `pnpm token-logo:prewarm`；新后台路由 `GET / POST / DELETE /admin/v1/market/logos/{chainId}/{address}`；公开路由 `GET /v2/market/logos/{chainId}/{file}` 行为变化（不再 302、改发 WebP、读链放开到 1 / 8453、新增 `.webp` 别名）。无新错误码（沿用 `NOT_FOUND` / `PROVIDER_UNREACHABLE` / `VALIDATION_FAILED` / `CAPABILITY_UNAVAILABLE`），只新增 reason code。建立在决策 0072、0089（含 §8 `TOKEN_LOGO_URL_MODE`）、0095（sharp）、0157 之上。

## 2. Context

需求方（docs/42 第 6 条）：主流代币图标要在服务端缓存一份；大陆用户多，现方案常显示 placeholder。现状（0089）的三个缺口：

1. **按需拉取**：第一个请求某代币的大陆用户要等服务端回源（DexScreener / GitHub，单源 5 s）；冷启动和 7 天到期后的第一次请求都慢，期间客户端往往已经画了 monogram。
2. **> 256 KiB 时 302 回上游**：大陆客户端打不开上游，等于没有图。
3. **原图直出**：Trust Wallet 原图平均约 17 KiB（实测 33 个主流币总 556 KB），DexScreener 图更大；大陆移动网络上逐张下载慢。

此外运营需要在图源缺图或图错时手工给图，而 0089 的缓存只认上游。

## 3. Decision

### 3.1 归一化（128 × 128 WebP）

- 依赖：**`sharp` 已是直接依赖**（`0.35.4`，决策 0095 `/v2/media` 用它），本批不新增依赖、不改版本。
- `src/features/market/token-logo-normalize.ts` `normalizeTokenLogo`：上游字节先过 0089 的签名嗅探（只放行 PNG / JPEG / GIF / WebP，SVG 永不进解码器），再 `sharp(..., { limitInputPixels: 2048², failOn: "error", pages: 1 })` → 应用 EXIF 方向 → `resize(128, 128, { fit: "contain", 透明底 })` → `webp({ quality: 85, alphaQuality: 100 })`，单次编码 `.timeout({ seconds: 5 })`。不裁剪、保留透明；小图放大到 128；动图取第一帧；元数据全部丢弃。
- 实测：33 张 Trust Wallet 主流币原图 556 KB → 118 KB（平均 3.6 KiB / 张），单张 CPU 约 50 ms。
- 上游读取上限从 256 KiB 提到 **4 MiB**（`tokenLogoMaximumUpstreamBytes`）；超过 4 MiB 仍写 `oversize` 标记 24 h，但路由回 **404**（不再 302，也不发上游 URL）。解码失败（含 200 但不是栅格图）按「该源无图」处理，继续试下一个源；全部无图写 `missing` 24 h——**但已有 `found` 行时，若失败只是解码失败（上游非 404），保留旧字节（`kept`），不写 `missing`**。
- 入库 `content_type = image/webp`，ETag 取归一化后字节。
- **路径兼容方案**：公开 URL 仍是 `…/{chainId}/{address}.png`，字节是 WebP，`Content-Type: image/webp`。理由：已发版客户端 `loop_v2_chain_codec.dart` 的 `logoProxyPathPattern` 只认 `eip155:56/…\.png$`（注释已写明「always `.png` whatever the bytes are」），图片解码按字节不按扩展名；改发 `.webp` URL 会让旧包把图当无效 → monogram。路由另接受 `.webp` 后缀作同一资源（同 ETag），留给以后客户端；投影仍只发 `.png`。
- 迁移不改任何存量行。0161 前写入的旧格式行（PNG / JPEG / GIF / 原样 WebP）在到期前照常由 `resolve` 下发；只有预热（`warm`，提前 1 天的 aheadMs，且要求 WebP）会提前把它重取并归一化；任何重取都写归一化格式。0161 前的 `oversize` 标记在其剩余 ≤ 24 h 内回 404（不再 302），到期后重取。

### 3.2 预热（worker lane `token_logo_prewarm` + 脚本）

- `src/features/market/token-logo-prewarm.ts` `runTokenLogoPrewarmPass`：一次 pass 收集清单 → 读这些行的状态（一条 SQL，不取字节）→ 对「到期」的地址先读 DexScreener batch pair fact（缓存命中不发请求，未命中每 30 个一次 `/tokens/v1`）让代理能优先用 Provider 图 → 以并发 8 逐个 `proxy.warm`。
- 清单与顺序（按地址去重，上限 2000）：
  1. 原生 BNB（`native`）+ 静态主流列表 `src/features/market/token-logo-mainstream.ts`（34 个：WBNB / BTCB / ETH / USDT / USDC / USD1 / FDUSD / BUSD / DAI / TUSD / CAKE / DOGE / SHIB / XRP / ADA / DOT / LINK / UNI / LTC / TRX / TON / PEPE / AVAX / POL / ATOM / FIL / BCH / ETC / TWT / XVS / FLOKI / SOL / AAVE / 1INCH；2026-10-19 逐个用 DexScreener `/tokens/v1/bsc` 核对 base symbol、用 Trust Wallet 路径核对 200，PEPE 两边都无图已在文件内注明）；
  2. 资产注册表 `chain_id = eip155:56` 的可读资产。注册表状态只有 `pending / verified / blocked`，没有 `active`：取 **非 `blocked`**（即 `listReadableAssets`，与钱包 / 行情一致）。钱包持仓快照 `wallet_balance_snapshots.asset_id` 外键指向注册表，所以「持仓里出现过的地址」已全部包含，无需单独查；
  3. 自选（`watchlist_items.asset_id`，按关注人数降序，≤ 1000）中本链的；
  4. 热门：**GeckoTerminal** `/networks/bsc/pools?sort=h24_volume_usd_desc&page=1..10` 的 base token，≤ `TOKEN_LOGO_PREWARM_HOT_LIMIT`（默认 200）。DexScreener 没有「按链取热门」的公开接口（只有跨链的 boosts / profiles），仓库里也没有现成的热门拉取模块，所以复用已有的 GeckoTerminal adapter，新增 `readTopPools(page)`；worker 里 logo lane 与 sparkline lane **共用同一份 worker 角色 Provider 实例（同一 limiter）**，每 pass 10 页（不计限速重试）；免费档 page > 10 返回 401，代码在 10 处截止。200 个池子去重后的 base token 实测约 90 个，所以热门实际 ≤ 约 100。被限速（本地 throttle 或上游 429）时退避 **30 / 60 / 120 s** 重问同一页，单 pass 最多重试 **3** 次；其它失败或重试用尽则用已取到的部分、reason `TOKEN_LOGO_HOT_LIST_FAILED`。GeckoTerminal 关闭时热门为空、reason `TOKEN_LOGO_HOT_LIST_UNAVAILABLE`。完整取到的热门榜存入 `market_fact_cache`（subject `logohot:bsc`、kind `logo_hot_list`、source `geckoterminal`、TTL = lane 间隔），**距上次成功不足一个周期时直接复用、不问 GeckoTerminal**（`hotSource = cache`），所以 worker 重启不会重复打热门榜。
- 刷新规则：`warm` 在行到期前 **1 天** 就刷新（`tokenLogoWarmRefreshAheadMs`），所以按 6 h 一次的 pass，常规用户请求永远命中缓存；源变化（Provider 图出现）也算到期，旧格式（非 WebP）只对预热算到期；`missing` / `oversize` 标记 24 h 内不重下。失败保留旧图（`kept`），从不写失败行；高优先级源失败、低优先级源成功时不入库（`degraded`，与 0089 一致）。上游并发仍是全进程 8（代理内部 limiter），pass 自身并发也封顶 8。
- lane：`src/token-logo-prewarm-worker.ts`，默认开；启动后先随机等 **1–5 min** 再跑首轮（避免重启 / 多实例同时打 Provider）；代理的上游 / 缓存告警经 worker logger 以 `lane=token_logo_prewarm` 记录；`TOKEN_LOGO_PREWARM_ENABLED`（默认 `true`）、`TOKEN_LOGO_PREWARM_INTERVAL_MS`（默认 `21600000` = 6 h，范围 1 min – 24 h）、`TOKEN_LOGO_PREWARM_HOT_LIMIT`（默认 200，0–200，0 = 不取热门）。只在有数据库时构造；每 pass 打一行 info（目标数、各结果计数、热门数、reason），注册表 / 自选读失败按指数退避（5 s 起，封顶 15 min）。DexScreener 关闭时跳过 pair seeding（`TOKEN_LOGO_PAIR_SEED_UNAVAILABLE`），只用 Trust Wallet。
- 脚本：`pnpm token-logo:prewarm [--hot-limit N]`，跑一次同样的 pass 并打印计数；允许 `NODE_ENV=production`（只往缓存里写公开图片）；不打印 URL / secret。

### 3.3 手工覆盖（后台）

- `POST /admin/v1/market/logos/{chainId}/{address}`：multipart 单 part `file`，PNG / JPEG / WebP / GIF（按签名），≤ 2 MiB；同样归一化成 128 × 128 WebP，存 `source = manual`、`candidate_url = source_url = null`、`expires_at = 9999-12-31T23:59:59.999Z`。权限 **复用 `console.write`**（platform_admin），读 `GET` 用 `console.read`；不新增权限位（`market.*` 前缀在 `adminPermissions` 里不存在，新增权限位要改角色矩阵与 0109，收益不大）。
- `DELETE` 同路径：删除 manual 行，下一次请求 / 预热重新回源。
- 审计：写入与 `admin_audit_log` 同一事务；action `market.logo.override` / `market.logo.override_clear`，target `token_logo` / `<chainId>/<address>`，before / after 只记 status、source、ETag、字节数，不记字节。
- **不被刷新覆盖**：三层保证——代理读到 manual 行直接返回、永不回源；`warm` 对 manual 返回 `manual`；仓库自动写入 `put` 的 upsert 带 `where source is distinct from 'manual'`，即使刷新与上传竞态也不会覆盖。
- 422 `VALIDATION_FAILED`：`detailsSafe.reasonCode = TOKEN_LOGO_UPLOAD_INVALID`、`field = file`、`logoReasonCode = TOKEN_LOGO_TYPE_UNSUPPORTED | TOKEN_LOGO_TOO_LARGE | TOKEN_LOGO_DECODE_FAILED`；404 `TOKEN_LOGO_NOT_CACHED`（GET 无行）/ `TOKEN_LOGO_OVERRIDE_NOT_FOUND`（DELETE 无 manual 行）；无数据库 503 `CAPABILITY_UNAVAILABLE` / `TOKEN_LOGO_CACHE_UNAVAILABLE`。
- `Idempotency-Key` 可选、不去重（同图再传得到同字节，再记一条审计）。CDN / 客户端已缓存的旧图在其 max-age（1 天）后换新（ETag 变化）。loop-admin 页面不在本批。

### 3.4 多链读路径

- 路由 `chainId` 枚举放开为 `eip155:56 / eip155:1 / eip155:8453`（`tokenLogoProxyReadChainIds`）；Trust Wallet 目录映射 `smartchain / ethereum / base`（`trustWalletUpstreamLogoUrl`）。BSC 以外不查 pair fact（DexScreener pair fact 只按地址键、只描述 BSC）。
- **投影不放开**：`logo.url` 仍只发 `eip155:56`（`tokenLogoProxyChainIds` 不变，OpenAPI `logo.url` pattern 不变），因为已发版客户端只认 `eip155:56`。预热默认只做 56。
- **随机地址的面**：路由不鉴权，任意合法地址的未命中都会触发回源并写 24 h `missing` 行。BSC（56）自 0089 起就有这个面（受全进程 8 并发、24 h 未命中缓存与 CDN 约束，0089 裁决 4）。放开 1 / 8453 不应把它扩大：这两条链的回源加 **每进程令牌桶 10 次 / 分钟**（`tokenLogoOtherChainRefetchesPerMinute`），超出时不回源、不写行，回 502 `PROVIDER_UNREACHABLE`（已有旧图则照发旧图）。56 不受此桶限制。

### 3.5 迁移 `000092_token_logo_normalized_manual`

`source` 增加 `manual`；`candidate_url` 改为可空，新约束 `token_logo_cache_candidate_check`：manual 行必须 `status = found` 且两个 URL 为空，非 manual 行必须有 `candidate_url`；`found_check` 的 `source_url` 要求对 manual 豁免（字节 ≤ 256 KiB、类型、ETag 约束不变）；不改存量行。`down` 删除 manual 行并恢复 0089 约束。append-only；`token_logo_cache` 已在 `schema.ts` 的 `requiredDatabaseRelations`，`latestMigrationName` 更新。

## 4. Consequences

- 大陆客户端拿到的永远是我们自己域名下的 3–4 KiB WebP，不再有 302；预热后常规请求不触发回源。
- 公开路由 OpenAPI 去掉 302、200 改为 `image/webp`（旧行在刷新前可能仍是 PNG / JPEG / GIF，content 映射保留四种类型）。后台 OpenAPI 新增三条操作（tag `admin-market`）。
- 未知 / 新币仍按需拉取（行为与 0089 相同，只是不再 302）；热门榜按 24 h 成交额，会混入刷量币，它们多半 Trust Wallet 无图、DexScreener 有图则能命中。
- worker 每 6 h 至多约 10 次 GeckoTerminal（被限速时最多再 3 次，30 / 60 / 120 s；一个周期内复用上次结果时为 0 次）、≤ 数十次 DexScreener（只对到期地址）、对到期地址的图片回源。
- 测试：`test/token-logo-normalize.test.ts`（多格式 → 128 WebP、透明保留与 contain 填充、坏输入 null）、`test/token-logo-proxy.test.ts`（大图入库不 302、> 4 MiB 404 + 标记、解码失败换源、旧格式重取、manual 不回源不覆盖、1 / 8453 目录且不查 pair fact、warm 的 fresh / stored / kept / missing / failed / degraded 与提前 1 天刷新）、`test/token-logo-prewarm.test.ts`（清单顺序与去重、主流列表合法无重复、pair seeding 只对到期地址、manual 不动、第二轮全 fresh 不发请求、热门分页 / 截断 / 失败、并发 8、中止、lane 退避）、`test/admin-token-logo-routes.test.ts`（上传归一化 + 审计 + 公开路由命中 manual 不回源、清除后回源、401 / 403 / 422 / 400 / 404 / 503）、`test/v2-market-logo-routes.test.ts`（WebP 128、`.webp` 别名、大图不 302、坏图 404、1 / 8453 读）、`test/market-adapters.test.ts`（`readTopPools` URL 与页码边界）、`test/reconciliation-worker-config.test.ts`、`test/worker-runtime.test.ts`（lane 构造 / 关闭 / 无缓存不构造）、`test/token-logo-cache.integration.test.ts`（000092 约束、manual 写入 + 审计行、自动写入不覆盖 manual、listStates 不取字节、清除 + 审计）。

## 5. 运维说明

**环境变量**（只影响 worker 进程；都有默认值，不设即开）：

| 变量                             | 默认       | 说明                                            |
| -------------------------------- | ---------- | ----------------------------------------------- |
| `TOKEN_LOGO_PREWARM_ENABLED`     | `true`     | 关掉预热 lane（按需代理不受影响）               |
| `TOKEN_LOGO_PREWARM_INTERVAL_MS` | `21600000` | pass 间隔，60000–86400000                       |
| `TOKEN_LOGO_PREWARM_HOT_LIMIT`   | `200`      | 热门数量，0–200；0 = 只预热主流 + 注册表 + 自选 |

热门榜依赖 `MARKET_PROVIDER_GECKOTERMINAL_ENABLED=true`；pair seeding 依赖 DexScreener（默认开）。staging / 生产无需新 secret。`TOKEN_LOGO_URL_MODE` 不在本批范围，切 `proxy` 后客户端才会走我们的 URL（主代理另行切换）；预热在 `upstream` 模式下照样跑，切换前就能把缓存填满。

**部署顺序**：先 `pnpm db:migrate`（000092），再发 API 与 worker。迁移不改存量行；worker 启动 1–5 min 后的首轮把预热清单内的旧格式行重取成 WebP，清单外的旧行到期前照常下发。

**手工跑一次预热**（运行镜像不含 `scripts/` 与 tsx，脚本只能在有源码的环境跑；生产 / staging 一般直接靠 worker lane，启动即跑第一轮）：

```sh
# 源码目录，DATABASE_URL 指向目标库（.env.local 或显式环境变量）
pnpm token-logo:prewarm                # 用 TOKEN_LOGO_PREWARM_HOT_LIMIT
pnpm token-logo:prewarm --hot-limit 0  # 只预热主流 + 注册表 + 自选
```

输出一行：`token logo prewarm: targets=… (native=… mainstream=… registry=… watchlist=… hot=…) fresh=… manual=… stored=… missing=… kept=… failed=… degraded=… unsupported=… hotListed=… elapsedMs=…`。worker 日志对应 `lane=token_logo_prewarm` 的 `LOOP token logo prewarm pass finished`（`count / storedCount / freshCount / missingCount / keptCount / failedCount / hotCount`）。

**首次预热实测**（2026-10-19，本机临时库、空注册表 / 自选，真实网络，GeckoTerminal 打开）：

```
token logo prewarm: targets=122 (native=1 mainstream=34 registry=0 watchlist=0 hot=87) fresh=0 manual=0 stored=68 missing=54 kept=0 failed=0 degraded=0 unsupported=0 hotListed=92 elapsedMs=224704
```

主流 34 + BNB 中 34 个入库（PEPE 无图），热门 87 个里约一半两边图源都无图（`missing`，24 h 后再问）。入库平均 3.1–3.7 KiB / 张。约 225 s 里绝大部分是等 GeckoTerminal 429（本机 IP 与开发栈共用额度；当时是审查前的 30 s × 最多 10 次重试参数，现为 30 / 60 / 120 s × 3 次，热门可能被截短）；同一次运行紧接第二轮全部 `fresh`，0.8 s、无上游请求。

**staging / 生产估算**（目标约 1 + 34 + 注册表 N + 自选 + ≤ 100 热门，按 250 个估）：

- 耗时：热门 10 页，顺利时十几秒，被 429 时退避 30 / 60 / 120 s（最多 3 次，之后用已取到的部分），通常 **0.5–4 min**；DexScreener pair seeding 约 8 次请求，秒级；图片回源 250 个 / 并发 8，单张 0.3–1 s，约 10–30 s；源慢时最坏每个 5 s × 2 源，约 5 min。合计通常 **1–5 min**，最坏约 10 min（lane 后台跑，不影响 API）。
- 流量：请求本身极小；**入站**下载约 250 × 15–40 KiB ≈ **4–10 MB**（Trust Wallet 平均 17 KiB，DexScreener 图偏大）；之后每 6 h 只回源到期的（每个代币 7 天一次，提前 1 天），日均约 1–2 MB。**出站**几乎为零（只有请求头）。
- 库容量：归一化后平均约 3.5 KiB，250 行约 0.9 MB（`bytea`）。
- 对客户端：每张图从平均 17 KiB 降到约 3.5 KiB，CDN 缓存 1 天。

**运营给图**：`POST /admin/v1/market/logos/eip155:56/<地址>`（multipart `file`，platform_admin），撤销用 `DELETE` 同路径；查看状态 `GET` 同路径（auditor 可读）。已知需要手工给图的主流币：PEPE（`0x25d887ce…bb00`，两边图源都无图）。

## 6. 审查修订（2026-10-19，同分支追加提交）

1. logo lane 复用 sparkline lane 的 worker Provider 实例（同一 limiter）；热门榜限速重试改为最多 3 次、30 / 60 / 120 s 退避。
2. 已有 `found` 行时，重取只得到不可解码字节（上游 200 非 404）→ `kept`，保留旧字节，不写 `missing`。
3. 迁移 000092 去掉「全部标过期」；`resolve` 在到期前照常下发旧格式，只由 `warm` 提前重编码。
4. 归一化 `.timeout({ seconds: 5 })`，像素上限 2048²。
5. worker 里代理传 logger（`LOOP token logo upstream or cache warning`，只带 reasonCode）。
6. lane 首轮随机延迟 1–5 min；热门榜成功结果缓存一个周期，期内不再问 GeckoTerminal。
7. `resolve` 与 `warm` 共用同一 in-flight 键（`<chainId>/<address>`）：后到者加入正在跑的任务；被加入的任务答不了它（预热没读字节 / 请求没判定预热新鲜度）时才自己再跑。
8. 1 / 8453 回源每进程 10 次 / 分钟令牌桶（§3.4）。
