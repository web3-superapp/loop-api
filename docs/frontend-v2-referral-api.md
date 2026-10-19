# 前端联调：V2 邀请中心（S239，决策 0162）

覆盖页面：行情 → 推广（邀请中心）、注册后补绑邀请码、`/i/{code}` 邀请链接。权威机器契约为
`openapi/loop-api.v2.json`（`/i/{code}` 是网页，不在 OpenAPI 里）。旧版字段说明见
`docs/frontend-v2-mining-api.md` §5，本文是它的超集。

## 1. Base URL 与 headers

- Base URL：与其它 V2 模块相同的 API 源（Development `https://api-dev.quant-dinger.cc`，Staging
  `https://api-staging.quant-dinger.cc`）。邀请链接也挂在这个源上：`{PUBLIC_BASE_URL}/i/{code}`。
- 读接口（`GET`）：`Authorization: Bearer <Privy access token>`、`X-Loop-Contract-Version: 2.0`、
  `X-Loop-Client-Version`；**不得**带 `Idempotency-Key`。响应 `Cache-Control: no-store`。
- 写接口（`POST /v2/referral/claim`）：另加 `Idempotency-Key: <UUIDv4>`，同一次点击重试用同一个 key。
- 模块开关：`V2_MODULES_ENABLED` 含 `referral`；未开时这些路由 404，`GET /v2/meta/capabilities` 里
  `referral` 为不可用。

## 2. `GET /v2/referral`（邀请中心首屏）

首次读取自动签发本账号邀请码。决策 0162 新增 `inviteLink`、`stats`，`boost` 多了可用形态。

```json
{
  "inviteCode": {
    "code": "LOOP-7HJKM",
    "issuedAt": "2026-10-19T08:00:00.000Z"
  },
  "inviteLink": "https://api-dev.quant-dinger.cc/i/LOOP-7HJKM",
  "binding": {
    "status": "unbound",
    "inviter": null,
    "claimWindow": { "status": "open", "activatedAt": "…", "closesAt": "…" }
  },
  "levels": [
    {
      "level": 1,
      "boostPercent": "10",
      "counts": {
        "pending_activation": 0,
        "pending_wallet": 0,
        "pending_mining": 3,
        "valid": 0,
        "invalidated": 0
      },
      "total": 3
    }
  ],
  "stats": {
    "directCount": 3,
    "validCount": 1,
    "level2to5Count": 4,
    "validAsOf": "2026-10-19T08:00:00.000Z"
  },
  "boost": {
    "status": "available",
    "referralPower": "0.75",
    "nftReferralPower": "0.5",
    "assetReferralPower": "0.25",
    "levels": [
      {
        "level": 1,
        "effectiveMembers": 1,
        "nftPower": "0.5",
        "assetPower": "0.25"
      },
      { "level": 2, "effectiveMembers": 0, "nftPower": "0", "assetPower": "0" },
      { "level": 3, "effectiveMembers": 0, "nftPower": "0", "assetPower": "0" },
      { "level": 4, "effectiveMembers": 0, "nftPower": "0", "assetPower": "0" },
      { "level": 5, "effectiveMembers": 0, "nftPower": "0", "assetPower": "0" }
    ],
    "epochId": "0f1e2d3c-…",
    "hourStart": "2026-10-19T07:00:00.000Z",
    "hourEnd": "2026-10-19T08:00:00.000Z"
  },
  "rules": {
    "configVersion": "referralRulesV1",
    "effectiveAt": "2026-09-01T00:00:00.000Z",
    "appliesTo": "miningPower",
    "maximumDepth": 5,
    "claimWindowDays": 7
  },
  "contractVersion": "2.0"
}
```

（`levels` 实际固定 5 项，示例只列一项。）

- **邀请码**：`LOOP-` + 4 位 Crockford Base32 + 1 位校验位，不支持自定义。「一键复制」复制 `inviteCode.code`；
  「分享链接」用 `inviteLink`。
- **`stats`**：`directCount` 直推人数（生效中）；`validCount` 有效人数 = 直推里本人算力在最新已结算小时 > 0
  的人；`level2to5Count` 第 2–5 级人数；`validAsOf` 是有效人数的「截至」时间，`null` 表示还没有任何结算小时
  （此时 `validCount` 为 0，文案「结算后更新」）。
- **`boost`**：
  - `available`：最新已结算小时里我从五级邀请拿到的**挖矿算力**（不是钱）。`referralPower` 为总数，可显示
    「邀请加成算力 0.75（截至 hourEnd）」；`levels[]` 可做五级明细（`effectiveMembers` = 该级有效人数）。
    该小时我没有记录 = 全 0（真实的 0，不是读不到）。
  - `unavailable` + `MINING_REFERRAL_BOOST_PENDING`：还没有任何结算小时（或暂时读不到）。显示「加成待结算」，
    不要显示 0。
- `levels[].counts.valid`（决策 0162 §E）与 `stats.validCount` 同源：被邀请人本人算力在最新已结算小时 > 0；其余状态仍是存储值。展示有效人数请用 `stats`。
- `binding`、`rules` 语义不变（见 mining 文档 §5.1）。禁止「返佣 / 分红 / 下线收入」表述。

## 3. `GET /v2/referral/invitees?limit=&cursor=`（我的直推列表）

只列直推（第 1 级），按绑定时间倒序。`limit` 1–50，默认 20；翻页只带 `cursor`（`cursor` 与 `limit` 同时出现
→ 400）。`nextCursor` 为 `null` 表示到底。游标绑定当前账号，约 10 分钟有效；过期或被篡改 → 400，回到第一页。

```json
{
  "items": [
    {
      "publicProfileId": "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e00",
      "alias": "frog",
      "avatarRef": "avatar:media/9a1b…",
      "boundAt": "2026-10-18T03:00:00.000Z",
      "validationStatus": "valid"
    },
    {
      "publicProfileId": null,
      "alias": null,
      "avatarRef": null,
      "boundAt": "2026-10-17T12:00:00.000Z",
      "validationStatus": "pending"
    }
  ],
  "nextCursor": "eyJ2Ijox….c2ln",
  "contractVersion": "2.0"
}
```

- `validationStatus`：`valid`（有效：本人有算力）、`pending`（待生效：还没结算或本人算力为 0）、
  `invalid`（关系已失效，仍列出，置灰）。
- 名字 / 头像**原样显示，不脱敏**：「可被发现」只管搜索（docs/09 B9），与消息请求列表同一口径。
- `publicProfileId` 为 `null`（对方拉黑了我，或资料未激活）：显示默认头像 + 「LOOP 用户」，不可点；有值时点按
  打开 `GET /v2/public-profiles/{publicProfileId}`。`avatarRef` 渲染同资料页（`avatar:media/{id}` →
  `{baseUrl}/v2/media/{id}.webp`）。
- 空列表：`items: []`、`nextCursor: null` → 空态「还没有邀请好友」+ 分享按钮。

## 4. `POST /v2/referral/claim`（注册后补绑）

语义不变。请求 `{ "inviteCode": "loop-7hjkm" }`（大小写、`I/L→1`、`O→0`、省略 `LOOP-` 都可）。
成功 `200 { "binding": {…bound}, "contractVersion": "2.0" }`。

可补绑窗口：LOOP ID 激活起 7 天（`[activatedAt, activatedAt + 7 天)`，服务器时钟）。入口显隐看
`GET /v2/referral.binding.claimWindow.status`：`open` 显示，`closed` 隐藏，`unavailable` +
`PROFILE_ACTIVATION_REQUIRED` 先去激活。

## 5. 错误码（七字段错误体）

| 接口                        | 状态 / code                                  | 场景 / 处理                                                                                                   |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 全部                        | `401 AUTH_REQUIRED` / `AUTH_INVALID`         | 重新登录                                                                                                      |
| 全部                        | `409 ACCOUNT_BOOTSTRAP_REQUIRED`             | 先完成账号初始化                                                                                              |
| 全部                        | `503 CAPABILITY_UNAVAILABLE`                 | 模块或数据库不可用；`invitees` 另有 `detailsSafe.reasonCode = V2_CURSOR_NOT_CONFIGURED`（服务端未配游标密钥） |
| 全部                        | `503 REQUEST_TIMEOUT` / `500 INTERNAL_ERROR` | 重试                                                                                                          |
| `GET /v2/referral`          | `400 INVALID_REQUEST`                        | 带了 query / body                                                                                             |
| `GET /v2/referral/invitees` | `400 INVALID_REQUEST`                        | `limit` 越界、`cursor` 与 `limit` 同时出现、游标无效或过期、未知参数                                          |
| `claim`                     | `400 INVALID_REQUEST`                        | 码格式 / 校验位错、缺 `Idempotency-Key`                                                                       |
| `claim`                     | `409 PROFILE_ACTIVATION_REQUIRED`            | 去激活 LOOP ID                                                                                                |
| `claim`                     | `403 POLICY_BLOCKED`                         | 已超过 7 天窗口                                                                                               |
| `claim`                     | `404 NOT_FOUND`                              | 码不存在（不可枚举）                                                                                          |
| `claim`                     | `422 VALIDATION_FAILED`                      | 自邀或成环                                                                                                    |
| `claim`                     | `409 DATA_STALE`                             | 已绑定过                                                                                                      |
| `claim`                     | `409 IDEMPOTENCY_CONFLICT`                   | 同一 key 换了码                                                                                               |

## 6. 邀请链接 `/i/{code}`

- 链接 = `inviteLink`。系统分享面板里直接分享这个 URL。
- **已安装 App**：iOS Universal Link（AASA 已声明 `/i/*`）/ Android App Link（`assetlinks.json` 已是域级声明；
  **App 的 AndroidManifest 需加 `pathPrefix="/i/"` 的 intent-filter**，iOS 的 Associated Domains 沿用现有
  `applinks:` 域名）拉起 App，App 从路径取 `code`：已登录且 `claimWindow.status = open` → 弹确认后调
  `POST /v2/referral/claim`；未注册 → 预填注册页的邀请码输入框，注册激活后补绑。
- **未安装**：浏览器打开极简黑底页：显示邀请码、「复制邀请码并下载 LOOP」按钮（复制后按系统跳 App Store /
  Google Play；都未配置时跳 `APP_DOWNLOAD_URL`；再没有就只复制），以及注册后 7 天内补绑的说明。首次启动时
  App 可在用户确认后读剪贴板里的 `LOOP-XXXXC` 预填（docs/09：不接第三方延迟深链 SDK）。
- 无效码（校验位错 / 格式错）→ 404「链接无效」页。页面不读库，不告诉访问者这个码是否真的存在。
- 服务端 env：`APP_STORE_URL_IOS`、`APP_STORE_URL_ANDROID`（https，可不配；不配就不显示该商店链接）。

## 7. unavailable 行为汇总

| 情况                         | 表现                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 尚无任何挖矿结算小时         | `boost` = `unavailable` / `MINING_REFERRAL_BOOST_PENDING`；`stats.validCount = 0`、`validAsOf = null`；名单全为 `pending`（失效的为 `invalid`） |
| 读 boost 失败                | 同上 `unavailable`，页面其它部分照常 200                                                                                                        |
| 未配 `V2_CURSOR_HMAC_SECRET` | `GET /v2/referral/invitees` → 503 `V2_CURSOR_NOT_CONFIGURED`（不会只给第一页）                                                                  |
| 模块未开 / 无数据库          | 404（未注册）或 503 `CAPABILITY_UNAVAILABLE`                                                                                                    |
| 未配商店链接                 | `/i/{code}` 页不显示对应商店按钮                                                                                                                |
