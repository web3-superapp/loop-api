# 运营后台管理面 `/admin/v1`（S119 / 决策 0102）—— S120 前端唯一依据

本文是 `loop-admin`（S120）对接 loop-api 管理面的契约。机器契约：
`openapi/loop-admin.v1.json`（`pnpm openapi:generate` 生成，不进 `/v2` 文档）。
设计来源：`LOOP/docs/modules/S119-S120-admin-console.md` §1。决策细节、偏离与待决问题见
`docs/decisions/0102-admin-console-api.md`；S119b 加固（登录并发、意图先行审计、独立暂停密钥、
活动位过滤）见 `docs/decisions/0105-admin-hardening-lists-policy.md`。

> **2026-10-10 S128（决策 0109）分权**：后台改为多账号 + 角色（platform_admin / reviewer /
> testnet_acceptor / auditor），每个接口服务端校验权限（新错误码 `PERMISSION_DENIED` 403）；会话响应多
> `accountId`、`role`、`permissions`、`passwordChangeRequired`、`operatorUserId`；审计行多 `actorAccountId`；
> 新增账号管理与发射项目审核接口，其写接口**需要** `Idempotency-Key`。全部见
> `docs/frontend-admin-role-separation.md`。本文 §1「管理面不用 `Idempotency-Key`」只对本文列出的旧接口成立。

> **2026-10-09 S119b（决策 0105）给 loop-admin 的字段变化**：
> 新错误码 `ADMIN_LOGIN_BUSY`（429）；新 reasonCode `ADMIN_AUDIT_UNAVAILABLE`、`MEME_PAUSE_PENDING`、
> `MEME_OPERATOR_KEY_MISSING`（取代 `MEME_EXECUTOR_DISABLED`）；活动位 GET/PUT 回执多
> `imageHosts`、`imageUrlMaximumLength` 两键，422 可带 `field: "imageUrl"`；审计 action 改为
> `community.review.requested/.decided/.failed`、`meme.pause.requested/.submitted/.failed`
> （`unpause` 同理），旧的 `community.review.verify/reject`、`meme.pause/unpause` 只出现在历史行。

## 1. 挂载与基址

| 环境    | Base URL（loop-api）                      |
| ------- | ----------------------------------------- |
| Dev     | `https://api-dev.quant-dinger.cc`         |
| Staging | `https://api-staging.quant-dinger.cc`     |
| 本机    | `http://127.0.0.1:<PORT>`（`.env.local`） |

- 只有 `ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`、`ADMIN_SESSION_SECRET` 三项**都**配置时才挂载；
  缺任一项，`/admin/*` 一律是普通 404（`{"code":"not_found",…}`），`/v1` `/v2` 不受影响。
  S120 遇到登录接口 404 应显示「管理面未启用」。
- 后台按设计 §2 同域反代 `/admin/v1/*` 到 loop-api，浏览器只认后台域；后台**原样转发**
  请求的 `Cookie` 头和响应的 `Set-Cookie` 头（不要改写 `Path`、`SameSite`）。
- 管理面**不用** Privy Bearer、`X-Loop-Contract-Version`、`Idempotency-Key`。
- 所有响应带 `Cache-Control: no-store` 与 `X-Request-ID`。
- 写接口请求体一律 `Content-Type: application/json`。`approve` / `withdraw` 可以不带请求体
  （或带 `{}`）；带了别的内容是 400。

## 2. 会话 cookie 规则

| 属性   | 值                                                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 名称   | `loop_admin_session`                                                                                                                                                                                                     |
| 内容   | 不透明签名串（`<payload>.<HMAC>`），后台不要解析                                                                                                                                                                         |
| 属性   | `Path=/admin; Max-Age=43200; HttpOnly; SameSite=Strict`，https 基址另加 `Secure`                                                                                                                                         |
| 有效期 | 12 小时，到期即 401，不续期（重新登录）                                                                                                                                                                                  |
| 登出   | `DELETE /admin/v1/session` → 204 + `Set-Cookie: loop_admin_session=; Max-Age=0`                                                                                                                                          |
| 锁定   | 决策 0110：按用户名（不分大小写）连续 5 次失败锁该用户名 15 分钟；同一来源 IP 15 分钟内 50 次失败锁该 IP 15 分钟（423，`detailsSafe.scope` = `username` / `ip`）；锁定期内正确密码也被拒；一个用户名被锁不影响其它用户名 |
| 并发   | 同一实例同一时刻只校验一次登录；并发的其它登录立即 429 `ADMIN_LOGIN_BUSY`（`Retry-After: 1`，不计失败次数）                                                                                                              |
| 失效   | 轮换 `ADMIN_SESSION_SECRET` 使所有会话失效                                                                                                                                                                               |
| 重启   | 决策 0110 起锁定计数在数据库 `admin_login_attempts`，多实例共享、重启不清零；引导管理员的登出撤销仍只在进程内存                                                                                                          |

**重启后的行为**：锁定与失败计数（决策 0110）落库，API 重启或多实例部署都不改变锁定状态；成功登录
清零该用户名的计数（不清 IP 计数）。引导管理员（`ADMIN_USERNAME`）已点「登出」但未满 12 小时的
cookie 在重启后仍会重新有效（决策 0105）；账号会话由 `credentials_version` 每请求复核（决策 0109）。
需要立刻让所有 cookie 失效时，轮换 `ADMIN_SESSION_SECRET` 并重启。

锁定阈值可用环境变量调整（都有默认值）：`ADMIN_LOGIN_USERNAME_MAX_FAILURES=5`、
`ADMIN_LOGIN_USERNAME_LOCK_SECONDS=900`、`ADMIN_LOGIN_IP_MAX_FAILURES=50`、
`ADMIN_LOGIN_IP_WINDOW_SECONDS=900`、`ADMIN_LOGIN_IP_LOCK_SECONDS=900`。

未登录（无 cookie / 伪造 / 过期 / 已登出）访问任何受保护接口一律
`401 ADMIN_SESSION_REQUIRED`，且在解析请求体之前返回——后台据此重定向到登录页。

## 3. 错误体（与 `/v2` 同为七字段）

```json
{
  "code": "ADMIN_CONFLICT",
  "category": "conflict",
  "retryable": false,
  "userMessageKey": "errors.admin.conflict",
  "correlationId": "d43064bd-005a-41df-910e-3dfe93f9cce0",
  "detailsSafe": {
    "reasonCode": "ADMIN_UPDATED_AT_MISMATCH",
    "currentUpdatedAt": "2026-10-08T00:00:00.002Z"
  },
  "providerReferenceSafe": null
}
```

| code                     | HTTP | category       | 含义 / 后台处理                                                                                                                             |
| ------------------------ | ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_SESSION_REQUIRED` | 401  | authentication | 未登录或会话失效 → 跳登录页                                                                                                                 |
| `ADMIN_LOGIN_INVALID`    | 401  | authentication | 用户名或密码错（计一次失败）                                                                                                                |
| `ADMIN_LOGIN_LOCKED`     | 423  | rateLimit      | 已锁定；`detailsSafe.scope`（`username` 该用户名被锁 / `ip` 该来源地址被锁）、`detailsSafe.retryAfterSeconds` 与 `Retry-After` 头给剩余秒数 |
| `ADMIN_LOGIN_BUSY`       | 429  | rateLimit      | 另一次登录正在校验；`retryAfterSeconds: 1` + `Retry-After: 1`，稍后重试（不计失败）                                                         |
| `ADMIN_CONFLICT`         | 409  | conflict       | `updatedAt` 过期（重新读取再改）、状态不允许、链上预演回滚；看 `detailsSafe.reasonCode`                                                     |
| `INVALID_REQUEST`        | 400  | validation     | 请求形状错误、cursor 被篡改或与筛选不符、`cursor` 与 `limit` 同时出现                                                                       |
| `VALIDATION_FAILED`      | 422  | validation     | 内容被规则拒绝；`detailsSafe.reasonCode`，可能附 `index` / `field` / `communityId`                                                          |
| `NOT_FOUND`              | 404  | validation     | 路由或目标不存在；`detailsSafe.reasonCode` 指明是哪类目标                                                                                   |
| `CAPABILITY_UNAVAILABLE` | 503  | availability   | 数据库/审计不可用、暂停密钥未配、生产环境禁止批准、广播失败；`detailsSafe.reasonCode`                                                       |
| `REQUEST_TIMEOUT`        | 503  | availability   | 处理超时（15 s）                                                                                                                            |
| `INTERNAL_ERROR`         | 500  | internal       | 未预期错误；把 `correlationId` 给后端查日志                                                                                                 |

`detailsSafe.reasonCode` 全集：

| reasonCode                                                                                                                                                                                    | 出现在                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ADMIN_UPDATED_AT_MISMATCH`（附 `currentUpdatedAt`）                                                                                                                                          | 两个 PUT 的 409                                                                    |
| `ADMIN_COMMUNITY_NOT_VERIFIED`（附 `communityId`）                                                                                                                                            | 推荐社区 422                                                                       |
| `ADMIN_COMMUNITY_NOT_FOUND`（附 `communityId`）                                                                                                                                               | 推荐社区 / 系数草稿 422、审核 404                                                  |
| `ADMIN_COMMUNITY_DUPLICATED`                                                                                                                                                                  | 推荐社区 422                                                                       |
| `ADMIN_COMMUNITY_ALREADY_VERIFIED`                                                                                                                                                            | 驳回已认证社区 409                                                                 |
| `ADMIN_COMMUNITY_BOUND_ASSET_TAKEN`（附 `holderCommunityId`）                                                                                                                                 | 改判通过被驳回社区时其绑定代币已被别的社区占用 409（决策 0182）                    |
| `ADMIN_PROMOTION_INVALID`（附 `index`，图片不合格时另附 `field: "imageUrl"`）                                                                                                                 | 活动位 422                                                                         |
| `ADMIN_REASON_CODE_INVALID`                                                                                                                                                                   | 审核 / MEME 422                                                                    |
| `ADMIN_REASON_TEXT_REQUIRED`                                                                                                                                                                  | 驳回、隐藏 422                                                                     |
| `ADMIN_REASON_TEXT_INVALID`                                                                                                                                                                   | 原因文字超 280 字或含控制字符 422                                                  |
| `ADMIN_FORMULA_VERSION_EXISTS`                                                                                                                                                                | 草稿 409                                                                           |
| `ADMIN_FORMULA_VERSION_NOT_FOUND`（草稿时附 `field: baseVersion`）                                                                                                                            | 草稿 422、批准/撤回 404                                                            |
| `ADMIN_FORMULA_STATE_INVALID`（附 `status`）                                                                                                                                                  | 批准/撤回 409                                                                      |
| `ADMIN_FORMULA_PARAMETERS_INVALID`（附 `field`）                                                                                                                                              | 草稿 422                                                                           |
| `ADMIN_FORMULA_COMMUNITY_WEIGHT_OUT_OF_RANGE`（附 `communityId`）                                                                                                                             | 草稿 / 批准 422                                                                    |
| `ADMIN_FORMULA_COMMUNITY_ASSET_NOT_BOUND`（附 `communityId`）                                                                                                                                 | 草稿 / 批准 422                                                                    |
| `ADMIN_FORMULA_COMMUNITY_WEIGHT_CONFLICT`（附 `communityId`）                                                                                                                                 | 草稿 / 批准 422（两个社区绑同一资产）                                              |
| `MINING_APPROVE_FORBIDDEN_IN_PRODUCTION`                                                                                                                                                      | 批准 503；列表 `approval.reasonCode`                                               |
| `ADMIN_FORMULA_SELF_APPROVAL`（决策 0110）                                                                                                                                                    | 批准 403 `PERMISSION_DENIED`：批准人就是草稿保存人                                 |
| `ADMIN_OPERATOR_DISABLED`（决策 0111）                                                                                                                                                        | 批准 403 `PERMISSION_DENIED`：reviewer 绑定的运营人员已停用（账号停用或 CLI 撤销） |
| `ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN`（决策 0110）                                                                                                                                             | 批准 409：草稿没有记录保存人（S129 之前或脚本建的），需重新保存为新草稿            |
| `ADMIN_MEME_TOKEN_NOT_FOUND`                                                                                                                                                                  | MEME 404                                                                           |
| `MEME_TOKEN_NOT_ON_CHAIN`                                                                                                                                                                     | 暂停 409（草稿/未上链）                                                            |
| `MEME_PAUSE_STATE_INVALID`（附 `status`）                                                                                                                                                     | 暂停 409（暂停只限 trading/full；恢复只限 paused）                                 |
| `MEME_PAUSE_SIMULATION_REVERTED`                                                                                                                                                              | 暂停 409（链上预演回滚，例如暂停密钥不是合约 owner；已记 requested + failed）      |
| `MEME_PAUSE_PENDING`（可附 `transactionHash`）                                                                                                                                                | 暂停 409（同一代币上一笔暂停/恢复仍在处理或未上链）                                |
| `MEME_PAUSE_BROADCAST_FAILED`（附 `auditId`）                                                                                                                                                 | 暂停 503（已记 requested + failed）                                                |
| `MEME_OPERATOR_KEY_MISSING` / `MEME_CONTRACT_NOT_CONFIGURED` / `MEME_USD1_NOT_CONFIGURED` / `MEME_MAINNET_SIGNING_CLOSED` / `MEME_CHAIN_RPC_NOT_CONFIGURED` / `MEME_PAUSE_SENDER_UNAVAILABLE` | 暂停 503；列表 `pause.reasonCode`                                                  |
| `ADMIN_AUDIT_UNAVAILABLE`                                                                                                                                                                     | 审核 / 暂停 503：意图审计行写不进去，**什么都没执行**                              |
| `ADMIN_DATABASE_UNAVAILABLE`                                                                                                                                                                  | 任一接口 503                                                                       |
| `COMMUNITY_REVIEW_UNAVAILABLE`                                                                                                                                                                | 审核 503                                                                           |

## 4. 写操作的统一回执

每个写接口（除登录/登出）成功时都带：

```json
"audit": { "auditId": "d3b723f7-f44b-4739-967e-7faa8874b049", "seq": 2, "at": "2026-10-08T00:00:00.003Z" }
```

后台顶部显示「已保存 · 审计 #`seq`」。`auditId` 是不透明 ID；`seq` 只用于展示与排序。

**有外部副作用的写（社区审核、MEME 暂停/恢复）先记意图再执行（决策 0105）**：

1. 先追加 `…requested` 审计行；写不进去 → 503 `ADMIN_AUDIT_UNAVAILABLE`，**审核不改状态、交易不签名**；
2. 执行；
3. 追加结果行：成功 `community.review.decided` / `meme.<action>.submitted`，失败
   `community.review.failed` / `meme.<action>.failed`（`after.requestedAuditId` 指回第 1 步，`after.errorCode` 给原因）。

回执里的 `audit` 指结果行（极少数情况下结果行写入失败，则指 requested 行）。其它写接口
（推荐社区、活动位、系数、隐藏）的审计行与改动在同一数据库事务里，不受影响。

## 5. 接口

### 5.1 会话

**`POST /admin/v1/session`**（无需 cookie）

```json
{ "username": "operator", "password": "…" }
```

200：

```json
{
  "actor": "operator",
  "issuedAt": "2026-10-08T16:00:15.000Z",
  "expiresAt": "2026-10-09T04:00:15.000Z"
}
```

响应头 `Set-Cookie: loop_admin_session=…; Path=/admin; Max-Age=43200; HttpOnly; SameSite=Strict[; Secure]`。
错误：400、401 `ADMIN_LOGIN_INVALID`、423 `ADMIN_LOGIN_LOCKED`、429 `ADMIN_LOGIN_BUSY`。
登录页收到 429 时等 `Retry-After` 秒后自动重试一次即可（不要循环重试）。

**`GET /admin/v1/session`** → 200 同上（当前会话）/ 401。用于「是否已登录」。

**`DELETE /admin/v1/session`** → 204，清 cookie；cookie 无效也 204。

### 5.2 总览 `GET /admin/v1/overview`

```json
{
  "accounts": 7,
  "communities": { "pending": 1, "verified": 2, "rejected": 0 },
  "pendingReviews": 1,
  "voiceRooms": { "live": 1, "participants": 4 },
  "memeTokens": { "byStatus": { "trading": 2 }, "hidden": 0 },
  "indexerLanes": [
    {
      "lane": "meme_event",
      "chainId": "eip155:97",
      "lastBlockNumber": "123",
      "updatedAt": "2026-10-08T00:00:00.000Z",
      "secondsSinceUpdate": 57616
    }
  ],
  "recentAudit": [/* 最近 20 条，形状同 §5.8 items */],
  "observedAt": "2026-10-08T16:00:16.004Z"
}
```

- `memeTokens.byStatus` 的键是出现过的状态（`draft`/`pending_chain`/`trading`/`full`/`graduated`/`paused`），没有的状态不出现，按 0 显示。
- 索引滞后用 `secondsSinceUpdate` 表示（不读链头）；`lastBlockNumber` 是十进制字符串。

### 5.3 推荐社区

**`GET /admin/v1/settings/recommended-communities`**

```json
{
  "communityIds": ["7c6d5e4f-3a2b-4c1d-8e9f-0a1b2c3d4e5f"],
  "source": "database",
  "updatedAt": "2026-10-08T00:00:00.002Z",
  "updatedBy": "operator",
  "environmentCommunityIds": [],
  "defaultSelectedCount": 5,
  "communities": [
    {
      "communityId": "7c6d5e4f-3a2b-4c1d-8e9f-0a1b2c3d4e5f",
      "name": "LOOP 官方",
      "slug": "loop-official",
      "logoRef": null,
      "verificationStatus": "verified",
      "memberCount": 3
    }
  ]
}
```

- `source: environment` 时 `communityIds` = `RECOMMENDED_COMMUNITY_IDS`，`updatedAt` 为 null。
- `communities` 按 `communityIds` 顺序；已不存在的 ID 不出现；若某社区后来不再是 verified，会显示其当前状态（App 端只展示 verified）。
- 候选社区用 `GET /admin/v1/communities?status=verified` 取。

**`PUT /admin/v1/settings/recommended-communities`**

```json
{
  "communityIds": ["<uuid>", "<uuid>"],
  "updatedAt": "<上次读到的 updatedAt，或 null>"
}
```

- 有序，≤ 50，不得重复，每个必须存在且 verified；前 5 个是 App 默认勾选。
- `communityIds: null` = 删除后台列表，回退环境变量。
- 200：GET 的形状 + `audit`。错误：400、409 `ADMIN_CONFLICT`、422、503。
- App 端（`GET /v2/communities/recommended`）同进程立即生效，其他进程 60 秒内生效。

### 5.4 活动位

**`GET /admin/v1/settings/intel-promotions`**

```json
{
  "items": [
    {
      "id": "081f1417-b83a-4606-a8eb-7b8cd9b5e737",
      "title": "社区周赛",
      "subtitle": "本周算力榜",
      "imageUrl": null,
      "deeplink": "/intel",
      "startsAt": "2026-10-08T00:00:00.000Z",
      "endsAt": "2026-11-01T00:00:00.000Z",
      "order": 1
    }
  ],
  "source": "database",
  "updatedAt": "2026-10-08T00:00:00.004Z",
  "updatedBy": "operator",
  "configVersion": "intelPromotionsV1+db.1791417600004",
  "effectiveAt": "2026-10-08T00:00:00.004Z",
  "deeplinkPattern": "^(/intel|/square|/meme|/community/profile\\?id=<uuidv4>)$",
  "deeplinkChoices": [
    "/intel",
    "/square",
    "/meme",
    "/community/profile?id=<communityId>"
  ],
  "maximumItems": 20,
  "imageHosts": ["cdn.loop.example"],
  "imageUrlMaximumLength": 512
}
```

- `items` 是全表（含不在投放窗口内的卡片）；App 只显示 `startsAt ≤ now < endsAt` 的卡片，按 `order`。
- `source: constant` 时是代码内置的两张卡，`configVersion = intelPromotionsV1`。
- 编辑器的 deeplink 下拉只给 `deeplinkChoices`；选 `/community/profile?id=<communityId>` 时把占位替换成真实社区 ID。

**`PUT /admin/v1/settings/intel-promotions`**

```json
{
  "items": [
    {
      "title": "社区周赛",
      "subtitle": "本周算力榜",
      "imageUrl": null,
      "deeplink": "/intel",
      "startsAt": "2026-10-08T00:00:00Z",
      "endsAt": "2026-11-01T00:00:00Z",
      "order": 1
    }
  ],
  "updatedAt": null
}
```

- 整表替换；已有卡片带回原 `id`，新卡片不带 `id`（服务端分配 UUIDv4）。
- 规则：标题 1–40 字、副标题 ≤ 80 字，**均不得含控制/格式字符**（换行、零宽、方向控制等）；
  `imageUrl` 为 null，或 ≤ 512 字符、`https://`、无端口无账号、主机在 `imageHosts`（配置项
  `INTEL_PROMOTION_IMAGE_HOSTS`）里的 URL——`imageHosts` 为空时只能填 null；deeplink 在白名单内、
  `endsAt > startsAt`、`order` 为 ≥ 0 整数、≤ 20 张、`id` 不重复。不合格 → 422
  `ADMIN_PROMOTION_INVALID` + `index`（第几张，从 0 起；图片问题另带 `field: "imageUrl"`）。
- 编辑器的图片输入框据 `imageHosts` 提示可用域名；为空时把图片输入置灰。已保存的图片若其域名后来
  被移出配置，App 读到的 `imageUrl` 为 null（后台 GET 仍显示原值）。
- `items: null` = 删除后台列表，回退内置卡片。
- 200：GET 形状 + `audit`。错误：400、409、422、503。

### 5.5 社区审核

**`GET /admin/v1/communities?status=pending|verified|rejected&q=&cursor=&limit=`**

- `status` 可省（全部）；`q` 匹配名称/slug 子串或完整社区 ID；`limit` 1–100（默认 20）；`cursor` 与 `limit` 不能同时出现，翻页时只传 `cursor`（必须保持同样的 `status`/`q`）。
- 新建在前。

```json
{
  "items": [
    {
      "communityId": "0b9f3c1e-5d2a-4c7b-9e8f-1a2b3c4d5e6f",
      "name": "Frog Club",
      "slug": "frog-club",
      "description": null,
      "logoRef": null,
      "verificationStatus": "pending",
      "boundAssetId": null,
      "memberCount": 3,
      "ownerUserId": "4bd131cb-47c9-4e74-b92c-b01670e1dd9d",
      "ownerLoopId": "LOOP-ABCDEFGH",
      "applicationSubmittedAt": "2026-10-01T00:00:00.000Z",
      "reviewedAt": null,
      "verifiedAt": null,
      "rejectedReason": null,
      "createdAt": "2026-10-01T00:00:00.000Z",
      "updatedAt": "2026-10-01T00:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

**`GET /admin/v1/communities/{communityId}`** → `{ "community": {…同上}, "reviewNotes": [ReviewNote…] }`（最近 50 条，新在前）。

**`PUT /admin/v1/communities/{communityId}/label`**（决策 0175，S282）

```json
{ "label": "算力社区" }
```

- 社区自定义标签：App 在原「已验证」位置显示它（`COMMUNITY_LABEL_EMIT=on` 后）。与审核无关：不改 `verificationStatus`，不影响搜索 / 公开。
- `label`：字符串或 `null`，必填键。先 trim；trim 后为空或 `null` = 清空；1–12 个字符（按 Unicode code point），超长 → 422 `VALIDATION_FAILED`，`detailsSafe = {reasonCode: "ADMIN_COMMUNITY_LABEL_TOO_LONG", field: "label"}`。
- 权限 `console.write`（platform_admin）；其他角色 403 `PERMISSION_DENIED`。不需要 `Idempotency-Key`（与审核接口相同）。
- 社区不存在或 ID 不是 UUID → 404 `NOT_FOUND / ADMIN_COMMUNITY_NOT_FOUND`；缺键 / 多余字段 → 400 `INVALID_REQUEST`；数据库不可用 → 503 `CAPABILITY_UNAVAILABLE`。
- 审计：值变化时同事务写 `community.label.update`（`before {label}`、`after {label}`）；值未变 → `changed: false`、`audit: null`，不写审计。

200：

```json
{
  "community": { "…": "同列表行，label 为新值（或 null）" },
  "changed": true,
  "audit": { "auditId": "…", "seq": 812, "at": "2026-10-22T10:00:00.000Z" }
}
```

列表行与详情的 `community` 恒带 `label`（`string | null`）。

**`POST /admin/v1/communities/{communityId}/review`**

```json
{
  "decision": "reject",
  "reasonCode": "material_mismatch",
  "reasonText": "社区名称与介绍对不上，请修改后重新提交。"
}
```

- `decision`：`verify | reject`。`reasonCode`：小写下划线（`^[a-z][a-z0-9_]{0,63}$`），无特定含义时用 `operator_manual_review`。
- `reasonText`：驳回必填（1–280 字，**申请人会在 App 看到**）；通过可省。
- 走现有审核流程（决策 0073）：改状态、写社区审计、给申请人发站内通知与推送（推送通道未配置时 `push.status = skipped`）。
- 审计：先记 `community.review.requested`，再记 `community.review.decided`（与审核备注同事务）或
  `community.review.failed`（审核流程拒绝时，如已认证不能驳回）。意图行写不进去 → 503
  `ADMIN_AUDIT_UNAVAILABLE`，社区状态不变、不发通知。
- 再次提交同一结论 → 200、`changed: false`（仍记 requested + decided 两条审计）。已认证社区不能驳回 → 409 `ADMIN_COMMUNITY_ALREADY_VERIFIED`。被驳回的社区可以改判通过；但若其绑定代币在被驳回期间已被另一个未被驳回的社区绑定（决策 0182「一币一社区」），改判通过 → 409 `ADMIN_CONFLICT`，`detailsSafe = {reasonCode: "ADMIN_COMMUNITY_BOUND_ASSET_TAKEN", holderCommunityId}`，先让群主改绑或清空代币。

200：

```json
{
  "community": {
    "…": "同列表行，verificationStatus 已是 rejected，rejectedReason 为上面的 reasonText"
  },
  "changed": true,
  "notification": "recorded",
  "push": { "status": "skipped", "reasonCode": null },
  "note": {
    "noteId": "f54c292c-…",
    "communityId": "0b9f3c1e-…",
    "at": "…",
    "actor": "operator",
    "decision": "reject",
    "reasonCode": "material_mismatch",
    "reasonText": "社区名称与介绍对不上，请修改后重新提交。",
    "auditId": "2414788f-…"
  },
  "audit": { "auditId": "2414788f-…", "seq": 4, "at": "…" }
}
```

`notification` ∈ `recorded | duplicate | skipped | failed`；`push.status` ∈ `delivered | suppressed | unavailable | skipped`。

### 5.6 挖矿系数（公式版本）

> **已弃用（决策 0187，S313）**：以下 `formula-versions` 四个接口保留，但 OpenAPI 已标 `deprecated`，后台隐藏「快照系数」入口。平台 MEME 的结算与 App 快照改由「矿池」表决定：`GET /admin/v1/mining/pool`，保存为挖矿参数草稿，详见 `docs/frontend-admin-mining-pool-api.md`。决策 0189（S316 / S317）起该表为「算力名单」：外部代币社区也列出（`kind = external`，默认不参与，`includedAssets` 放行），名单是社区权重 / 站位 / 榜单 / 结算 / 快照的唯一口径。

**`GET /admin/v1/mining/formula-versions`**

```json
{
  "items": [
    {
      "configVersion": "miningFormulaV2",
      "status": "pending_approval",
      "scope": "development_baseline",
      "effectiveAt": null,
      "approvedAt": null,
      "createdAt": "…",
      "updatedAt": "…",
      "parameters": {
        "assetWeights": { "eip155:97:native": "1" },
        "dailyOutputBudget": "2000",
        "referralBoostStatus": "pending_approval",
        "communityWeightRange": { "min": "1", "max": "3" },
        "communityWeights": [{ "communityId": "7c6d5e4f-…", "weight": "2" }],
        "nftWeight": "1.5",
        "inviteInitialPower": "100"
      },
      "formula": { "…": "完整公式文档（只读展示）" },
      "weightRange": { "…": "完整权重范围文档" },
      "priceGuardRules": [],
      "draftAuthor": {
        "kind": "admin_account",
        "username": "ops-alice",
        "accountId": "0b6f…"
      },
      "approvedBy": null
    }
  ],
  "approvedVersion": "miningFormulaV1-dev",
  "approval": { "available": true, "reasonCode": null }
}
```

- `status`：`pending_approval`（草稿）/ `approved`（在力，唯一）/ `retired`。
- 所有数值是十进制字符串，不要转浮点。
- `approval.available: false`（`MINING_APPROVE_FORBIDDEN_IN_PRODUCTION`）时批准按钮置灰。
- `communityWeights: null` 表示该版本不是后台建的（脚本建的），批准时不改社区权重。
- `nftWeight` / `inviteInitialPower` 是占位参数（需求方给准确值前），当前任何算力计算都不读它们，页面要标「占位」。
- 决策 0110：可读权限 `console.read`（platform_admin、auditor）**或** `formula.approve`（reviewer）。
- `draftAuthor`：保存草稿的人。`kind: admin_account` 带账号 `accountId`；`kind: admin_bootstrap` 是
  `ADMIN_USERNAME` 引导管理员（`accountId: null`）。`draftAuthor: null` = 保存人未知（S129 之前或脚本建的），
  **不能在后台批准**，要以它为 `baseVersion` 重新保存一个新草稿。
- `approvedBy`：在后台批准该版本的 reviewer（`{username, accountId}`），草稿 / 脚本批准 / 旧版本为 null。

**`POST /admin/v1/mining/formula-versions`**（201，需 `console.write` = platform_admin）

```json
{
  "configVersion": "miningFormulaV2",
  "baseVersion": "miningFormulaV1-dev",
  "parameters": {
    "dailyOutputBudget": "2000",
    "referralBoostStatus": "approved",
    "communityWeightRange": { "min": "1", "max": "3" },
    "communityWeights": [{ "communityId": "7c6d5e4f-…", "weight": "2" }],
    "nftWeight": "1.5",
    "inviteInitialPower": "100"
  }
}
```

- `configVersion`：`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，不能已存在（409）。
- `baseVersion`：被复制的版本；不可编辑部分（表达式、价格代理、参考定价、价格保护、scope）从它拷贝。
- `parameters` 每项可省，省略即沿用基版本：
  - `assetWeights`：`{ assetId: 十进制 }` 整表替换；
  - `dailyOutputBudget`：十进制或 null（null = 去掉日产出预算）；
  - `referralBoostStatus`：`pending_approval | approved`（邀请加成只是状态位）；
  - `communityWeightRange`：`{min,max}` 或 null；
  - `communityWeights`：`[{communityId, weight}]`，**省略时默认取当前在力版本已批准的社区权重**；每个权重须在范围内、社区须存在且已绑定资产、两社区不能绑同一资产；
  - `nftWeight`、`inviteInitialPower`：十进制或 null。
- 回执：`{ "version": FormulaVersion, "baseVersion": "…", "audit": {…} }`。草稿不影响任何在力数字。
- 决策 0110：保存草稿即「提交审批」，调用者记为 `draftAuthor`（不可再改）。

**`POST /admin/v1/mining/formula-versions/{configVersion}/approve`**（无请求体；决策 0110：需 `formula.approve` = **reviewer**）

- platform_admin（表内账号与引导管理员）403 `PERMISSION_DENIED`（`ADMIN_ROLE_FORBIDDEN`，`permission: formula.approve`）。
- 批准人 ≠ 草稿保存人：同一账号 403 `PERMISSION_DENIED`（`ADMIN_FORMULA_SELF_APPROVAL`）；数据库约束同样拒绝。
- 草稿保存人未知：409 `ADMIN_CONFLICT`（`ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN`），重新保存草稿后再批。
- 审计：先写 `mining.formula.approve.requested`（写不进去 → 503 `ADMIN_AUDIT_UNAVAILABLE`，不批准），
  再在批准事务里写 `mining.formula.approve`（`after.requestedAuditId`、`draftAuthor`、`approvedBy`），
  失败时写 `mining.formula.approve.failed`（`after.reasonCode`）。不需要 `Idempotency-Key`（与原接口一致；
  重复批准是 409 `ADMIN_FORMULA_STATE_INVALID`）。
- 只能批准 `pending_approval`；原在力版本变 `retired`；`effectiveAt = approvedAt = 现在`；同一事务把草稿的 `communityWeights` 写成该版本下已批准的社区权重。挖矿快照 lane 下一轮起按新版本计算（快照 lane 行为不变）。
- 200：`{ "version": …, "retiredVersion": "miningFormulaV1-dev", "audit": {…} }`。
- 错误：403（角色 / 自批）、404、409 `ADMIN_FORMULA_STATE_INVALID` / `ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN`、422（权重校验）、503 `MINING_APPROVE_FORBIDDEN_IN_PRODUCTION` / `ADMIN_AUDIT_UNAVAILABLE`。
- 确认弹窗要写明：批准后立刻替换在力版本，App 的挖矿数字会在下一次快照后按新版本变化。

**`POST /admin/v1/mining/formula-versions/{configVersion}/withdraw`**（无请求体，需 `console.write` = platform_admin）

- 只撤回草稿（`pending_approval → retired`）。在力版本不能撤回（409），要换版本就批准另一个草稿。
- 200：`{ "version": …, "audit": {…} }`。

### 5.7 MEME

**`GET /admin/v1/meme/tokens?status=&listing=&q=&cursor=&limit=`**

- `status` ∈ `draft|pending_chain|trading|full|graduated|paused`；`listing` ∈ `listed|hidden`；`q` 匹配名称/符号子串、完整 `memeTokenId` 或代币地址；分页规则同 §5.5。

```json
{
  "items": [
    {
      "memeTokenId": "3f2e1d0c-9b8a-4766-8554-433221100fed",
      "chainId": "eip155:97",
      "contractAddress": "0x…c1",
      "tokenAddress": "0x…d2",
      "name": "Frog",
      "symbol": "FROG",
      "status": "trading",
      "listing": "listed",
      "listingReasonCode": null,
      "listingReasonText": null,
      "listingChangedAt": null,
      "creatorUserId": "69fc2683-…",
      "creatorLoopId": null,
      "holderCount": 1,
      "tradeCount": 2,
      "sold": "1000",
      "graduationNeedsOperator": false,
      "chainCreatedAt": "2026-10-02T00:00:00.000Z",
      "graduatedAt": null,
      "createdAt": "2026-10-02T00:00:00.000Z"
    }
  ],
  "nextCursor": null,
  "pause": {
    "available": false,
    "reasonCode": "MEME_OPERATOR_KEY_MISSING",
    "executorAddress": null
  }
}
```

- `sold` 是原始整数字符串（18 位小数的代币单位），不要转浮点。
- `pause.available: false` → 暂停/恢复按钮置灰，旁边显示 `reasonCode` 的说明（暂停密钥未配 / 合约未配置 / 非测试网 / 无 RPC）。
- `pause.executorAddress` 是暂停密钥（`MEME_OPERATOR_PRIVATE_KEY`）的地址，**不是**部署者地址；它必须是曲线合约的 owner，否则预演回滚。

**`POST /admin/v1/meme/tokens/{memeTokenId}/listing`**

```json
{
  "listing": "hidden",
  "reasonCode": "user_reports",
  "reasonText": "该代币因多次举报已被平台隐藏。"
}
```

- `hidden` 必须带 `reasonText`（**App 代币详情会展示这句话**，请写面向用户的句子）；`listed` 可省。
- 隐藏立即生效：`GET /v2/meme/tokens`（含 hot）与 `category=meme` 不再出现；`GET /v2/meme/tokens/{id}` 仍可读，带 `listing: "hidden"` 与 `listingReason`。隐藏不停止交易（那是暂停）。
- 200：`{ "memeToken": 行, "changed": true, "audit": {…} }`；重复设置同一值 `changed: false`（仍记审计）。

**`POST /admin/v1/meme/tokens/{memeTokenId}/pause`**、**`…/unpause`**

```json
{ "reasonCode": "operator_incident", "reasonText": "排查异常交易" }
```

- 用独立的暂停密钥 `MEME_OPERATOR_PRIVATE_KEY` 签名（决策 0105），不再用部署者密钥；未配置 →
  503 `MEME_OPERATOR_KEY_MISSING`。
- 暂停只对 `trading`/`full`；恢复只对 `paused`。
- 同一代币同一时刻只处理一次：上一笔暂停/恢复仍在处理、或已广播但还没上链（按交易回执判断；RPC 读不到
  时按未上链处理，最长 10 分钟）→ 409 `MEME_PAUSE_PENDING`（附 `transactionHash`）。连点两次只会发一笔。
  按钮在 202 后置灰直到列表状态变化即可。
- 审计：先记 `meme.<action>.requested`（写不进去 → 503 `ADMIN_AUDIT_UNAVAILABLE`，不签名），再链上预演；
  预演回滚 → 409 `MEME_PAUSE_SIMULATION_REVERTED`（不广播，记 `meme.<action>.failed`）；广播成功记
  `meme.<action>.submitted`，广播失败记 `meme.<action>.failed`。
- 202：

```json
{
  "memeTokenId": "3f2e1d0c-…", "action": "pause", "status": "submitted",
  "transactionHash": "0x…", "executorAddress": "0x…", "audit": {…}
}
```

- `submitted` 只表示交易已广播，**不是已确认**；代币状态要等 `meme_event` 索引到 `Paused`/`Unpaused` 事件后才变（索引器未开时不会变）。页面显示「已提交 · 交易哈希」，刷新列表看状态。
- 广播失败 → 503 `MEME_PAUSE_BROADCAST_FAILED`（附 `auditId` = failed 行，已记审计；请到浏览器核对后再重试）。

### 5.8 审计 `GET /admin/v1/audit?actor=&action=&cursor=&limit=`

```json
{
  "items": [
    {
      "auditId": "9f9e13f7-…",
      "seq": 8,
      "at": "2026-10-08T00:00:00.013Z",
      "actor": "operator",
      "action": "meme.pause.submitted",
      "targetType": "meme_token",
      "targetId": "3f2e1d0c-…",
      "before": { "status": "trading" },
      "after": {
        "requestedAuditId": "5a1c…",
        "transactionHash": "0x…",
        "reasonCode": "operator_incident",
        "reasonText": "排查异常交易",
        "executorAddress": "0x…"
      },
      "requestId": "9ba16e86-…"
    }
  ],
  "nextCursor": "…"
}
```

- 新在前；`actor` / `action` 精确匹配；分页规则同 §5.5。`before` / `after` 是任意 JSON 快照，原样以代码块展示即可。
- 审计不可修改、不可删除。

`action` 全集：

| action                                                      | targetType                                                                                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.login` / `session.login_failed` / `session.logout` | `session`（login_failed 的 actor 为 `anonymous`；决策 0110 起 `after` 带 `lockScope`、`username`（仅已知账号，否则 null）、`accountId`、`sourceIp`、`usernameFailures`、`ipFailures`） |
| `session.login_locked`（决策 0110）                         | `session`（actor `anonymous`；`after.scope` = `username` / `ip`、`retryAfterSeconds`、`failures`、`username`、`accountId`、`sourceIp`）                                                |
| `settings.recommended_communities.update`                   | `setting`                                                                                                                                                                              |
| `settings.intel_promotions.update`                          | `setting`                                                                                                                                                                              |
| `community.review.requested` / `.decided` / `.failed`       | `community`（`after.decision` = verify/reject）                                                                                                                                        |
| `community.review.verify` / `community.review.reject`       | `community`（仅 S119b 之前的历史行）                                                                                                                                                   |
| `mining.formula.draft` / `.approve` / `.withdraw`           | `mining_formula_version`                                                                                                                                                               |
| `mining.formula.approve.requested` / `.failed`（决策 0110） | `mining_formula_version`                                                                                                                                                               |
| `meme.listing.update`                                       | `meme_token`                                                                                                                                                                           |
| `meme.pause.requested` / `.submitted` / `.failed`           | `meme_token`（`unpause` 同理）                                                                                                                                                         |
| `meme.pause` / `meme.unpause`                               | `meme_token`（仅 S119b 之前的历史行）                                                                                                                                                  |

### 5.9 链上风险 `GET /admin/v1/chain-guard/incidents`（决策 0134）

权限 `console.read`（platform_admin、auditor）；reviewer / testnet_acceptor 403 `PERMISSION_DENIED`；无 session 401 `ADMIN_SESSION_REQUIRED`。无请求参数，响应 `Cache-Control: no-store`。

```json
{
  "chainId": "eip155:56",
  "holdActive": true,
  "holdKinds": ["usd1_paused", "usd1_address_frozen"],
  "items": [
    {
      "incidentId": "5b0c6f0e-3d1c-4d55-9a57-0a4c3f2b7e11",
      "kind": "usd1_address_frozen",
      "subject": "0x4f1c…e5c0",
      "details": {
        "source": "state",
        "labels": ["instance:7d3e…:escrow"]
      },
      "firstSeenAt": "2026-10-14T00:00:00.000Z",
      "lastSeenAt": "2026-10-14T00:05:00.000Z",
      "hold": true
    },
    {
      "incidentId": "a2d4…",
      "kind": "pool_protocol_fee_nonzero",
      "subject": "0x9e1f…（32 字节 pool id）",
      "details": {
        "instanceId": "7d3e…",
        "poolManager": "0x28e2…e9df",
        "zeroForOnePips": 25,
        "oneForZeroPips": 25,
        "alertPips": 500
      },
      "firstSeenAt": "2026-10-14T00:00:00.000Z",
      "lastSeenAt": "2026-10-14T00:05:00.000Z",
      "hold": false
    }
  ],
  "generatedAt": "2026-10-14T00:05:03.120Z"
}
```

- 只列**未解决**事件（≤ 200，按最后一次看到倒序）。`holdActive = true` 时回购 keeper、Hooks 执行器、poke keeper 都在跳过 tick（`CHAIN_GUARD_HOLD`），页面应显著提示。
- `kind` 全集（中文展示名建议）：`usd1_paused` USD1 全局暂停｜`usd1_address_frozen` 我方地址被冻结｜`usd1_implementation_changed` USD1 实现合约变化｜`usd1_address_mismatch` 工厂 USD1 与配置不一致｜`usd1_read_unsupported` 主网 USD1 读数异常｜`protocol_fee_controller_changed` v4 协议费控制器变化｜`pool_protocol_fee_nonzero` 池协议费非零｜`pool_protocol_fee_high` 池协议费超阈值｜`account_balance_low` 签名账户 BNB 不足｜`usd1_frozen_funds_drained` 冻结资金被没收｜`usd1_frozen_funds_reallocated` 冻结资金被转移｜`usd1_upgraded` USD1 升级事件｜`usd1_proxy_admin_changed` 代理管理员变更｜`usd1_proxy_admin_ownership_transferred` ProxyAdmin 所有者变更｜`usd1_owner_transferred` USD1 owner 变更。
- `subject` 是小写地址或 pool id，可直接拼 BscScan 链接；`details` 是读数快照（金额十进制字符串，例如 `balanceBnb: "0.04"`、`amountRaw`），原样展示即可。
- 事件类 kind（最后 6 个）看到后 24 小时自动消失；其余在链上条件消失后的下一次检查（默认 60 秒）消失。
- 空列表只表示没有未解决事件，**不**表示监控在运行（`CHAIN_GUARD_ENABLED` 默认关闭）。
- 错误：503 `CAPABILITY_UNAVAILABLE`，`detailsSafe.reasonCode = CHAIN_GUARD_REPOSITORY_UNAVAILABLE`（无数据库）。

## 6. Unavailable 行为汇总

| 情况                                    | 表现                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 三个 `ADMIN_*` 不全                     | `/admin/*` 404                                                                                 |
| 数据库不可用                            | 任一接口 503 `ADMIN_DATABASE_UNAVAILABLE`；登录也 503（锁定计数读不到就不校验密码，决策 0110） |
| 社区仓库未组装                          | 审核 503 `COMMUNITY_REVIEW_UNAVAILABLE`                                                        |
| 暂停密钥未配 / 合约未配 / 主网 / 无 RPC | 暂停 503 + reasonCode；列表 `pause.available: false`                                           |
| 审计表写不进去                          | 审核 / 暂停 503 `ADMIN_AUDIT_UNAVAILABLE`，不执行                                              |
| 链上风险无数据库（0134）                | `chain-guard/incidents` 503 `CAPABILITY_UNAVAILABLE`（`CHAIN_GUARD_REPOSITORY_UNAVAILABLE`）   |
| 未配 `INTEL_PROMOTION_IMAGE_HOSTS`      | 活动位 `imageHosts: []`，`imageUrl` 只能 null                                                  |
| `NODE_ENV=production`                   | 批准 503 `MINING_APPROVE_FORBIDDEN_IN_PRODUCTION`；列表 `approval.available: false`            |

## 7. 验收对照（设计 §3）

| 操作           | App 侧观察点                                                               |
| -------------- | -------------------------------------------------------------------------- |
| 改推荐社区     | 注册 onboarding 推荐社区页（`GET /v2/communities/recommended`），≤ 60 秒   |
| 改活动位       | 情报页活动卡（`GET /v2/intel/promotions`，`configVersion` 变 `…+db.<ms>`） |
| 驳回待审核社区 | 创建者在 App 看到驳回原因（`rejectedReason` + 站内通知）                   |
| 隐藏 MEME      | 发射台列表消失，详情带隐藏标记                                             |
| 以上每一条     | 审计页可见                                                                 |
