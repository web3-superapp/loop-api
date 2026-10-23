# 0179 · 官网注册写面 `/v2/web/*`（S295，2026-10-23）

## 1. Status

已实现（分支 `S295-web-surface`，基线 `integration/v2` `c72cc7a`）。**无迁移**、无新依赖。新 env：`WEB_ORIGINS`、`WEB_BASE_URL`、`WEB_APP_LINKS_IOS`、`WEB_APP_LINKS_ANDROID`、`WEB_APP_LINKS_TESTFLIGHT`（全部默认空）。新 OpenAPI 产物 `openapi/loop-web.v2.json`（contract surface `web`）；`loop-api.v1.json`（字节冻结）、`loop-api.v2.json`、`loop-admin.v1.json`、`loop-public.v1.json` 均不变。App 现有路由行为不变。网站本身在独立仓库 `loop-web`（并行代理）。

先例：决策 0147（`/public/*` 跨域 + 限流的封装插件写法）、0162（`/i/{code}` 邀请页）、0030 / 0034（V2 资料激活与别名规则）、0036（邀请绑定）。

## 2. Context

需求方要官网：用户在网页上用**同一个 Privy App** 登录（邮箱验证码 / Google），完成 LOOP 注册（建账号、起用户名、可选绑邀请码），之后在 App 用同一登录方式进入即同一账号。此前 loop-api 除 0147 公开读面外全部同源、无 CORS，且 App 的 `POST /v2/session/bootstrap` 强制要求 `X-Loop-Device-ID` / `X-Loop-Platform`（`android|ios`，库约束）/ `X-Loop-Client-Version`，并写一条设备会话。

## 3. Decision

### A. 位置、挂载与产物

- 前缀 `/v2/web`，仍在 `/v2` 下：错误走全局 `/v2` 错误处理，七字段信封（`code/category/retryable/userMessageKey/correlationId/detailsSafe/providerReferenceSafe`）不变，拒绝原因放 `detailsSafe.reasonCode`。
- **`WEB_ORIGINS` 为空（默认）= 整个 web 面不挂载**（404，OPTIONS 也 404）。`contractSurface === "web"`（OpenAPI 生成）总是挂载，所以产物不依赖部署配置。
- 单独产物 `openapi/loop-web.v2.json`（tag `web` + `health`，安全方案只有 `privyBearer`），`pnpm openapi:generate / openapi:check` 一并生成与核对；App 的 `loop-api.v2.json` 里没有 `/v2/web/*`。

### B. CORS（只在 web 面）

封装插件内的 `onRequest` hook，不引 `@fastify/cors`（同 0147）：

| 情形                                    | 响应头                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 每个 web 面响应（含错误、预检）         | `Vary: origin`、`Cross-Origin-Resource-Policy: cross-origin`（覆盖 helmet 的 `same-origin`）                                                                                         |
| `Origin` 在白名单内                     | `Access-Control-Allow-Origin: <回显该 origin>`（**从不** `*`）、`Access-Control-Expose-Headers: retry-after, x-request-id`；**不发** `Allow-Credentials`（token 走头不走 cookie）    |
| 预检 `OPTIONS /v2/web/*`，origin 在名单 | 204 + `Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS`、`Access-Control-Allow-Headers: authorization, content-type, idempotency-key, x-loop-contract-version`、`Max-Age: 600` |
| origin 不在名单 / 无 origin             | 正常处理请求但不带任何 `Access-Control-Allow-*`（浏览器拒读）；预检仍 204 但无 allow 头                                                                                              |
| web 面之外的任何路由                    | 不变（同源，`same-origin`）                                                                                                                                                          |

允许头比主代理单里的 `authorization, content-type` 多了 `idempotency-key, x-loop-contract-version`：写接口要求这两个头（§C），不放行的话浏览器预检直接失败。

`WEB_ORIGINS` 解析（`parseWebSurfaceConfig`，`src/config.ts`）：逗号列表，每项按 Provider origin 同规则规范化（`URL.origin`：小写 host、去默认端口、去尾斜杠；拒绝路径 / query / fragment / 凭据），去重，≤ 16 个；只收 https，**非 production** 才额外允许 `http://localhost|127.0.0.1|[::1]`（本地 Next.js）。任何非法值拒绝启动。

### C. 鉴权与请求头（设备 / 版本头怎么处理）

- 鉴权一律 `Authorization: Bearer <Privy access token>`，复用 App 同一个 `PrivyAccessTokenVerifier`（同一 Privy App，逐请求校验）。`session` 用 `authenticatePrivyBearer`；`username` / `claim` 用 `authenticateLoopBearer`（账号不存在 → 409 `ACCOUNT_BOOTSTRAP_REQUIRED`）。
- **网页不是 App 安装，不需要也不读** `X-Loop-Device-ID` / `X-Loop-Platform` / `X-Loop-Client-Version` / `X-Loop-Session-ID`，**也不写设备会话**。不是"给默认值"：设备会话表的 `client_platform` 约束只允许 `android|ios`，伪造平台会污染「新设备登录」通知（决策 0067）与设备列表。web session 改走 App v1 bootstrap 同一个 `InternalUserRepository.getOrCreateByPrivyUserId`（同一事务内分配 LOOP ID、冲突重试），所以 App 之后 bootstrap 落到同一 `loop_users` 行，届时才有第一条设备会话。
- 写接口（`session` / `username` / `claim`）要求恰好一个 `X-Loop-Contract-Version: 2.0`（缺 / 重复 400，其它值 409 `VERSION_CONFLICT`）与恰好一个**小写**规范 UUIDv4 `Idempotency-Key`（否则 400）。读接口（`preview` / `meta`）无任何头、无鉴权。

### D. 路由与语义

| 路由                                 | 语义                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v2/web/session`               | get-or-create 账号，返回 `{loopId, username, usernameRequired, walletAddress, invite {bound, windowEndsAt, canClaim}, observedAt}`。天然幂等（同一 Privy 用户恒得同一账号），Idempotency-Key 只校验不落库。body 可省略或 `{}`。`V2_SESSION_ENABLED` 关 → 503 `WEB_SESSION_DISABLED`（与 App 的 V2 会话同一开关）                                                                                                                                                                                                               |
| `PUT /v2/web/profile/username`       | 用户名 = V2 资料 `alias`，规则与 App 完全一致（直接调 `ProfileV2Service`）：trim 后 1–40 码点、禁控制 / bidi / 不可见格式字符、保留词 422 `ALIAS_RESERVED`、运营屏蔽词 422 `ALIAS_BLOCKED`、超长 422 `VALIDATION_FAILED`、**不唯一**。资料 `pending` → 走 App 的一次性激活命令 `activateProfile`（同 key 同名回放、同 key 异名 409 `IDEMPOTENCY_CONFLICT`；保留已有 avatarRef / interests）；激活即开始 7 天绑码窗口。资料 `active` → CAS `replaceProfile`（只换 alias，其它字段原样；版本冲突自动重读重试一次；同名为 no-op） |
| `POST /v2/web/referral/claim`        | 直接调 App 的 `ReferralService.claim`，全部校验不变（需已激活、7 天窗口、一人一次、不能绑自己 / 下级成环、深度 5 一事务、同 key 回放）。成功 `{status:"bound", inviterLoopId}`；服务报 `DATA_STALE`（已绑）或 `POLICY_BLOCKED` 且账号已有直属上级 → 200 `{status:"already_bound"}`，**仅当**现有上级就是该邀请码的主人时才带 `inviterLoopId`（不暴露别的上级）                                                                                                                                                                 |
| `GET /v2/web/referral/preview?code=` | 无鉴权。格式不对 / 无主 → `{valid:false, inviter:null}`（200，不区分，防枚举）；有主 → `{valid:true, inviter:{username, loopId}}`，`username` 只在主人资料 active 时给，否则 null。不出其它字段。限流同 0147：按访客（`publicClientKey`，`TRUST_PROXY` + `PUBLIC_CLIENT_IP_HEADERS`）一分钟固定窗口 `PUBLIC_RATE_LIMIT_PER_MINUTE`（默认 120），进程内存，超出 429 `RATE_LIMITED` / `WEB_RATE_LIMITED` + `Retry-After` + `X-RateLimit-Limit` + `X-RateLimit-Remaining: 0`                                                      |
| `GET /v2/web/meta`                   | 无鉴权。`{appStore:{ios, android, testflight}, observedAt}`，值来自 `WEB_APP_LINKS_*`（https、无凭据，否则拒绝启动；空 = null）                                                                                                                                                                                                                                                                                                                                                                                                |

`invite` 字段口径：`bound` = 存在 depth 1 边（含已失效的，与 claim 的"一人一次"同口径）；`windowEndsAt` = 激活时间 + 7 天，未激活 null；`canClaim` = referral 模块可用 且 未绑 且 窗口未关（未激活时为 true，含义是「先设用户名再绑」）。`walletAddress` = LOOP 自己的钱包清单（决策 0033）里选中的、否则最早的 active 钱包；从未同步过为 null（本批不读 Privy 用户接口）。`username` 只在资料 active 时给，`usernameRequired = username === null`。

### E. 错误码与 reasonCode

| HTTP | code                                                                                                                      | reasonCode（`detailsSafe`）                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                                                                                                         | 头 / body 形状不对；claim 码格式不对时 `REFERRAL_CODE_INVALID`                                                       |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID`                                                                                          | —（带 `WWW-Authenticate`）                                                                                           |
| 403  | `POLICY_BLOCKED`                                                                                                          | `REFERRAL_CLAIM_WINDOW_CLOSED`                                                                                       |
| 404  | `NOT_FOUND`                                                                                                               | `REFERRAL_CODE_UNKNOWN`                                                                                              |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED` / `IDEMPOTENCY_CONFLICT` / `VERSION_CONFLICT` / `PROFILE_ACTIVATION_REQUIRED` / `DATA_STALE` | `PROFILE_ACTIVATION_REQUIRED`；`DATA_STALE` 实际被 already_bound 吸收，兜底 `REFERRAL_ALREADY_BOUND`                 |
| 422  | `VALIDATION_FAILED` / `ALIAS_RESERVED` / `ALIAS_BLOCKED`                                                                  | claim：`REFERRAL_SELF_INVITE` / `REFERRAL_CYCLE`                                                                     |
| 429  | `RATE_LIMITED`                                                                                                            | `WEB_RATE_LIMITED`（只有 preview）                                                                                   |
| 503  | `CAPABILITY_UNAVAILABLE` / `PROVIDER_DISCONNECTED` / `REQUEST_TIMEOUT`                                                    | `WEB_SESSION_DISABLED` / `WEB_REPOSITORY_UNAVAILABLE` / `V2_PROFILE_MODULE_DEFERRED` / `V2_REFERRAL_MODULE_DEFERRED` |

### F. unavailable 行为（fail closed）

- 没配 `WEB_ORIGINS`：不挂载（404）。
- Privy 未配置：Bearer 校验 503 `PROVIDER_DISCONNECTED`（同 App）。
- `V2_SESSION_ENABLED=false`：session 503 `WEB_SESSION_DISABLED`。
- `V2_MODULES_ENABLED` 不含 `profile` / `referral`（或仓库未组装）：username 503 `V2_PROFILE_MODULE_DEFERRED`；claim / preview 503 `V2_REFERRAL_MODULE_DEFERRED`；session 里 `canClaim=false`。
- web 读仓库未组装 / 数据库失败：503 `WEB_REPOSITORY_UNAVAILABLE`。
- 没有任何 fixture 兜底、没有假成功。

### G. `/i/{code}`

`WEB_BASE_URL` 非空时 `GET /i/{code}` 改为 `302 Location: ${WEB_BASE_URL}/i/{encodeURIComponent(code)}`（code 原样，不校验不规范化；作为单个路径段编码，跳不出 `/i/`），`Cache-Control: no-store`、`Referrer-Policy: no-referrer`；空则保持 0162 的 API 自有页面。`WEB_BASE_URL` 只收 https（非 production 允许 localhost http），不得带 query / fragment / 凭据，尾斜杠去掉。Universal Link / App Link 的 host 白名单仍是 API 域名（`apple-app-site-association` 的 `/i/*`、Android `autoVerify`），本批不动：装了 App 的手机由系统直接拉起 App，不会走到 302。

### H. 新代码位置

`src/features/web/`（contract、repository 接口、service、限流器）、`src/database/web-registration-repository.ts`（三条只读 SQL：账号摘要、按码查主人、直属上级）、`src/routes/v2/web.ts`（插件 + route schema）、`src/config.ts`（`parseWebSurfaceConfig`）、`src/routes/well-known.ts`（302）、`scripts/generate-openapi.ts`（第五个产物）。`ProfileV2ActivateInput.metadata` 类型放宽为只要 `idempotencyKey` + `contractVersion`（服务本来就只读这两个；App 路由传入的值不变）。

## 4. 风险与未做

- `walletAddress` 只反映 LOOP 已同步的钱包；网页新注册用户在打开 App（钱包同步）之前恒为 null。若网站需要立刻显示 Privy 嵌入式钱包地址，前端可直接从 Privy SDK 取，或另立决策让 session 读 Privy 用户接口。
- preview 限流在进程内存，多副本各自计数；与 0147 同。
- 允许头多了两个（见 §B）；如主代理坚持只放 `authorization, content-type`，写接口就必须放弃 Idempotency-Key / 契约版本头，与仓库硬规则冲突。
- `already_bound` 在窗口关闭后对同 key 回放也会返回 `already_bound`（服务先判窗口再回放），语义上可接受。

## 5. 证据

- `test/web-registration.test.ts`（35）：未挂载、白名单回显 / 不回显 / 预检、错误也带 CORS、其它路由保持同源、session 建号与头校验与关闭态、用户名激活 / 替换 / CAS 重试一次 / 规则 / 未建号 / 模块关、claim 成功 / 已绑（同主 / 异主）/ 自绑 / 成环 / 窗口关 / 未激活 / 未知 / 格式错 / 模块关、preview 有效 / 无效 / 限流、meta、`/i/{code}` 两种行为、config 解析与拒绝、限流器、产物确定性与头集合。
- `test/web-registration.integration.test.ts`（6，真实 PostgreSQL）：首次建号与二次同 LOOP ID（无设备会话、App 路径同一行）、激活 + 窗口 + 改名 + 规则 + 不唯一、preview、claim 全路径（未激活 / 成功 / 同 key 回放 / already_bound / 异主 / 自绑 / 成环）、窗口关闭、钱包投影。
