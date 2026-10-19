# 0162 · launch2 成交带账户投影与邀请中心（S239-api，2026-10-19）

## 1. Status

已实现（分支 `feat/S239-profile-links-and-referral`，基线 `40921be`）。无迁移、无新表、无新错误码。新增 `GET /v2/referral/invitees`、扩展 `GET /v2/referral`、`/v2/launch2` 三处成交 / 动态加可选字段 `account`；新增非 `/v2` 公开页 `GET /i/{code}`（不进 OpenAPI），AASA 加 `/i/*`。新增可选 env `APP_STORE_URL_IOS` / `APP_STORE_URL_ANDROID`。

## 2. Context

需求方 docs/42 第 3 条：「a. 对方头像都可以点击查看；b. 行情 - 推广 这块应该显示邀请相关功能」。用户裁决：邀请功能按常见做法做。

- MEME 成交（决策 0101）早已带 `account {publicProfileId, displayName, avatarRef}`；launch2 的曲线成交（`instance.recentTrades`）、自己的池成交（`…/pool/trades`）与发射台动态（`GET /v2/launch2/overview.activity`）只有地址，App 无法跳资料页。
- `GET /v2/referral` 只有邀请码、绑定、按状态计数和恒为 `unavailable` 的 boost；没有邀请链接、直推名单、有效人数。小时结算（决策 0116）已把每人五级推荐算力写进 `mining_epoch_rewards`，可以直接读。
- docs/09 待办里写的「8 位邀请码」是 10-08 的设想；实际实现（决策 0036）是 `LOOP-XXXXC`（4 位随机 Crockford Base32 + 1 位校验）。**本决策保持现状，不改格式，不做自定义邀请码。**

## 3. Decision

### A. launch2 成交 / 动态的 `account`

- 形状与 MEME 成交**完全相同**（直接复用 `meme-schemas.ts` 的 `accountSchema`）：`{publicProfileId, displayName, avatarRef} | null`。注意字段名是 `displayName`（MEME 既有命名），不是 `alias`；值就是资料 alias。
- 出现位置：`GET /v2/launch2/instances/{id}` → `instance.recentTrades[].account`；`GET …/pool/trades` → `trades[].account`；`GET /v2/launch2/overview` → `activity[].account`（`actor` 为 null 时恒为 null）。Schema 里是可选属性（旧服务端不发），本服务端总是发。
- 映射规则（与 MEME `accountJoin` 一致）：地址 → `account_wallets` 中 `status='active'` 的最早一行（`first_seen_at, wallet_id` 升序）→ 只认 `profile_status='active'` 的资料。
- 隐私：资料主人的 `privacy_preferences_v2.trade_history_visibility`（无行 = `everyone`，与所有公开成交读一致）为 `self` 时，对别人返回 null；**本人始终看得到自己**（池成交列表必然是本人钱包）。拉黑不参与（MEME 成交同样不看拉黑；点进资料页时由资料接口自己 404）。
- 查询方式：`src/features/profile/wallet-account-directory.ts` + `src/database/wallet-account-directory-repository.ts`。每个响应**一次**批量查询（`distinct on (address) … where address = any($1)`，走 `account_wallets_active_address_idx`，单批 ≤ 200 地址），进程内按地址缓存 30 s（最多 5000 条，含「无账户」的负结果）。查询失败 → 该批全部 `null`（显示钱包地址）并打 `WALLET_ACCOUNT_LOOKUP_FAILED` 警告日志，失败结果不缓存。无数据库时 `accounts` 依赖为 null，所有 `account` 恒为 null。

### B. 邀请中心

1. **`GET /v2/referral/invitees?cursor=&limit=`**：我的直推（depth 1，含已失效的关系），按绑定时间（`locked_at`）倒序、`referral_edge_id` 倒序打破同刻并列；`limit` 1–50 默认 20，`cursor` 与 `limit` 互斥；游标是 owner/route 绑定的 V2 游标（`route=referralInvitees`），内含微秒精度的 `locked_at` 键。无 `V2_CURSOR_HMAC_SECRET` → 503 `CAPABILITY_UNAVAILABLE` / `V2_CURSOR_NOT_CONFIGURED`（不截断返回）。
   - 字段：`publicProfileId, alias, avatarRef, boundAt, validationStatus`。
   - `validationStatus`（对外三态）：`valid` = 被邀请人**本人**算力（`nft_self_power + asset_self_power`）在最新已结算小时 > 0（docs/38 §5.2「有效成员」）；`invalid` = 关系已失效（`effective_to` 非空或存储状态 `invalidated`）；其余（尚无结算小时、本人算力为 0）为 `pending`。存储的 `referral_edges.validation_status` 不改写。
   - **脱敏规则（选定）：不脱敏**。照 message requests 的做法——对方资料的 alias / 头像原样显示，`discoverable` 只管搜索（决策 0096、docs/09 B9 裁决）。唯一例外：被邀请人**拉黑了我**时，该行仍列出、仍计数，但 `publicProfileId / alias / avatarRef` 为 null（避免点进去 404）。资料未激活同样为 null。
2. **`GET /v2/referral` 扩展**（向后兼容，只加字段 / 加 boost 的 available 分支）：
   - `inviteLink`：`{PUBLIC_BASE_URL}/i/{code}`（去掉尾部 `/`）。
   - `stats {directCount, validCount, level2to5Count, validAsOf}`：`directCount` = 生效中的 depth 1；`validCount` = 其中 `valid` 的人数（同上规则）；`level2to5Count` = 生效中的 depth 2..5；`validAsOf` = 读取所用结算小时的 `hourEnd`，尚无结算时 null（`validCount` 为 0）。
   - `boost`：有已结算小时 → `{status:"available", referralPower, nftReferralPower, assetReferralPower, levels[5]{level, effectiveMembers, nftPower, assetPower}, epochId, hourStart, hourEnd}`，`referralPower = trim_scale(nft + asset)`，单位是挖矿算力（不是钱）。该小时没有本人那一行 = 0（决策 0116：无行即无算力）。尚无结算小时或读取失败 → 保持 `unavailable` / `MINING_REFERRAL_BOOST_PENDING`（读取失败不拖垮整页）。
   - `levels[].counts` 仍是存储的边状态计数，未改语义。
3. **`GET /i/{code}`**（`src/routes/well-known.ts`，`hide: true`，不进 OpenAPI，无鉴权、不读库）：
   - 路径参数按 `parseInviteCode` 规范化（大小写、省略 `LOOP-`、Crockford `I/L→1, O→0`）并校验校验位；无效 → 404 `no-store` 的「链接无效」页；有效 → 200、`public, max-age=3600`。页面不说明该码是否真的发放过（与 `/u/` 一样不可枚举）。
   - 页面：黑底、LOOP 字样、「邀请码」+ 规范化的码、「复制邀请码并下载 LOOP」按钮、App Store / Google Play 链接（各自 env 有值才显示）、注册后 7 天内补绑的提示。`<meta property="og:title|og:description">` 与 `<meta name="loop-invite-code">`。
   - 唯一的内联脚本是固定文本（码和链接放在 `data-*` 属性里），CSP 用 `script-src 'sha256-…'` 只放行它；点按钮：写剪贴板（失败退回 `execCommand('copy')`）→ 按 UA 跳 iOS / Android 商店链接，都没有时跳 `APP_DOWNLOAD_URL`，再没有就只复制。
   - App 已安装：AASA `applinks.components` 增加 `{"/": "/i/*"}`；Android `assetlinks.json` 是域级声明，无需改动，**App 端 manifest 需加 `/i/` 的 intent-filter path**、iOS 端按 Universal Link 收到 `/i/{code}` 后取码并走 `POST /v2/referral/claim`（或预填注册页）。
   - env：`APP_STORE_URL_IOS`、`APP_STORE_URL_ANDROID`（https、无凭据，否则启动失败；未设 = 不显示该按钮）。
4. **`POST /v2/referral/claim`**：语义不改。已核对窗口与错误码齐全：窗口 `[activatedAt, activatedAt + 7 天)`（服务器时钟，边界取开区间，`referral-contract.test.ts` 覆盖）；400 `INVALID_REQUEST`（格式 / 校验位错）、401、403 `POLICY_BLOCKED`（窗口已关）、404 `NOT_FOUND`（未知码，不可枚举）、409 `PROFILE_ACTIVATION_REQUIRED` / `DATA_STALE`（已绑定）/ `IDEMPOTENCY_CONFLICT`、422 `VALIDATION_FAILED`（自邀 / 成环）、503。

### C. 邀请码格式

保持 `LOOP-XXXXC`；docs/09 的「8 位」是旧设想，以本决策与决策 0036 为准。自定义邀请码不做。

## 4. Consequences

- App 可直接用 `account.publicProfileId` 打开 `GET /v2/public-profiles/{id}`；`account` 为 null 时继续显示钱包地址。缓存 30 s 意味着改隐私 / 换头像后最长 30 s 才在成交里生效。
- `validCount` 与 `boost` 随小时结算推进；结算停摆时 `validAsOf` 停在最后一小时，客户端可据此标注「截至」。
- 测试：`test/v2-launch2-trader-accounts.test.ts`（目录单元：隐私 / 本人豁免 / 批量 / TTL / 负缓存 / 分批 / 失败降级；三条路由的 `account`、每响应一次查询、跨请求命中缓存）、`test/v2-referral-routes.test.ts`（`inviteLink`、`stats`、boost 两种形态与降级、名单分页 / 游标 / 参数错误 / 无游标密钥 503）、`test/well-known-app-links-routes.test.ts`（`/i/` 页、CSP 哈希、商店链接、无效码 404、AASA 含 `/i/*`、env 校验）、`test/referral-invite-center.integration.test.ts`（PostgreSQL：结算前后的状态与计数、只读最新结算小时、拉黑隐去资料、同刻并列的游标翻页、地址映射规则）。
