# 前端联调：V2 LOOP ID、资料与隐私（S2 / D2）

本文是 `profile` 模块（决策 0030）的前端交接契约。权威机器契约为
`openapi/loop-api.v2.json`。通用规则（Base URL、`X-Request-ID`、错误体七字段）
沿用 `docs/frontend-v2-session-api.md` 与 `docs/api-v2-conventions.md`。

## Base URL、启用条件与 headers

- Development：`https://api-dev.quant-dinger.cc`；本机 `http://127.0.0.1:3000`
  （或 `PORT` 指定端口）。
- 后端 `V2_MODULES_ENABLED` 必须包含 `profile`。未启用时本文所有路径都返回
  `404 NOT_FOUND`（V2 错误体），`GET /v2/meta/capabilities` 的 `profile`
  为 `deferred`。前端应先读 capabilities：`profile.availability === "available"`
  才调用本模块；`avatarUpload` 为 `available` 时才展示「上传头像」（决策 0095，
  S107）；为 `unavailable`（`AVATAR_STORAGE_UNAVAILABLE`）时只给默认头像。
- 受保护读写接口（`/v2/profile`、`/v2/profile/privacy`）必需：

```text
Authorization: Bearer <current Privy access token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: 1.0.0
```

- `POST /v2/profile/loop-id` 使用与 bootstrap 相同的写 header 集：

```text
Authorization: Bearer <current Privy access token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: 1.0.0
X-Loop-Platform: ios | android
X-Loop-Device-ID: <canonical lowercase UUIDv4 installation id>
Idempotency-Key: <canonical lowercase UUIDv4 for this logical activation>
```

- `PUT /v2/profile` 与 `PUT /v2/profile/privacy` **不接受** `Idempotency-Key`
  （带上会返回 `400 INVALID_REQUEST`）。它们通过 `expectedVersion` 做 CAS：
  完全相同内容的重试返回已提交资源，旧版本返回 `409 VERSION_CONFLICT`。
- `GET /v2/profile/avatars` 为公共只读接口，无需任何 header。
- 所有响应 `Cache-Control: no-store`；不要缓存 `loopId` 之外的字段。
- 未知的 `X-Loop-*` header、query、多余 body 字段一律 `400 INVALID_REQUEST`。

## 登录后重定向顺序

1. Privy 登录成功、`GET /v2/account/me` 或 bootstrap 完成后调用 `GET /v2/profile`。
2. `profile.profileStatus === "pending"` → 进入 `/auth/loop-id`
   （`loop-id-setup`），展示只读 `profile.loopId`。
3. `profile.profileStatus === "active"` → 进入 `/community`。
4. `GET /v2/profile` 失败（离线、`503`、`500`）→ 进入 `community` 只读并显示
   unavailable，不阻塞登录，下次启动再检查。
5. `409 ACCOUNT_BOOTSTRAP_REQUIRED` → 先调 bootstrap，再回到第 1 步。

## `GET /v2/profile/avatars`

公共只读，无 body/query。people atlas 为 4 列 × 3 行，`slot` 是 1 起的行优先
序号（`row = ceil(slot/4)`，`column = (slot-1) % 4 + 1`）；`monogram` 由客户端用
别名首字符渲染，`slot` 为 `null`。

```json
{
  "avatars": [
    {
      "avatarRef": "avatar:preset/people-01",
      "atlas": "people",
      "slot": 1,
      "label": "People 01"
    },
    {
      "avatarRef": "avatar:preset/people-02",
      "atlas": "people",
      "slot": 2,
      "label": "People 02"
    },
    {
      "avatarRef": "avatar:preset/people-12",
      "atlas": "people",
      "slot": 12,
      "label": "People 12"
    },
    {
      "avatarRef": "avatar:preset/monogram",
      "atlas": "monogram",
      "slot": null,
      "label": "Monogram"
    }
  ],
  "contractVersion": "2.0"
}
```

完整清单共 13 项：`avatar:preset/people-01` … `avatar:preset/people-12` 与
`avatar:preset/monogram`。V2 写接口只接受这 13 个值或 `null`。

## `GET /v2/profile`

无 body/query。首次（无资料行）返回 version 0 默认值，但 `loopId` 一定存在：

```json
{
  "profile": {
    "loopId": "LOOP-7HJKMNPQ",
    "alias": null,
    "avatarRef": null,
    "bio": null,
    "interests": [],
    "profileStatus": "pending",
    "activatedAt": null
  },
  "version": 0,
  "updatedAt": null,
  "contractVersion": "2.0"
}
```

激活后：

```json
{
  "profile": {
    "loopId": "LOOP-7HJKMNPQ",
    "alias": "Alice",
    "avatarRef": "avatar:preset/people-03",
    "bio": null,
    "interests": ["MEME", "AI"],
    "profileStatus": "active",
    "activatedAt": "2026-09-07T01:00:00.000Z"
  },
  "version": 1,
  "updatedAt": "2026-09-07T01:00:00.000Z",
  "contractVersion": "2.0"
}
```

`loopId` 格式 `^LOOP-[0-9A-HJKMNP-TV-Z]{8}$`，服务端生成、不可更改、不可自选。
`avatarRef` 读回时可能是 V1 写入的非预设值（`^avatar:[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$`）；
无法渲染时按 monogram 兜底，但重新提交时必须换成预设值。

## `POST /v2/profile/loop-id`（一次性激活）

body：

```json
{
  "alias": "Alice",
  "avatarRef": "avatar:preset/people-03",
  "interests": ["MEME", "AI"]
}
```

- `alias` 必填字符串（1–40 码点，trim 后）；`avatarRef` 预设值或 `null`；
  `interests` 枚举 `MEME DEFI AI GAMEFI NFT RWA`，≤6，服务端去重。
- 成功 `200`，响应与 `GET /v2/profile` 同构，`profileStatus` 为 `active`。
- 幂等：生成并持久化本次逻辑激活的 `Idempotency-Key` 与 body；超时/断网只能
  用同一 key + 同一 body 重试，返回当前资源。同一 key 配不同 body →
  `409 IDEMPOTENCY_CONFLICT`。key 与 device/platform/client version 无关；
  `interests` 在 digest 内去重并排序，同一组赛道换顺序重试不会冲突。
- 已激活账号再次调用（任意 key）→ `200` 当前资源，不修改任何字段，也不重置
  `activatedAt`。要改别名请走 `PUT /v2/profile`。
- 通知开关本步只在前端本地保存，不发给后端。

## `PUT /v2/profile`

body：

```json
{
  "expectedVersion": 1,
  "profile": {
    "alias": "Alice",
    "avatarRef": "avatar:preset/people-05",
    "bio": "Building on LOOP",
    "interests": ["DEFI", "AI"]
  }
}
```

- 四个字段全部必填（可为 `null` 的是 `alias`、`avatarRef`、`bio`；`interests`
  至少传 `[]`）。`bio` ≤160 码点，空字符串请传 `null`。
- `expectedVersion` 取自最近一次 `GET/PUT/POST` 响应的 `version`；该 version 与
  V1 `/v1/profile` 共用，任一侧写入都会递增。
- 不改变 `profileStatus`。响应同 `GET /v2/profile`。

## `GET /v2/profile/privacy`

无 body/query。无行时返回 version 0 的默认值（不落库）。展示类开关 fail-closed
（`discoverable=false`、`miningPower`/`communities` 为 `self`），但
**`totalAssets` 与 `tradeHistory` 默认 `everyone`**（决策 0095，docs/09 B11
「主页持仓默认公开可关」；迁移 000046 已把存量 `self` 翻成 `everyone`）；
三个社交开关**默认开启**（决策 0070，用户 2026-09-23 裁决）。隐私页
「公开持仓与交易」单开关 = 同时写 `totalAssets` 与 `tradeHistory`
（`everyone` / `self`）；「匿名模式」开关 UI 下线，字段保留原样回写：

```json
{
  "privacy": {
    "discoverable": false,
    "anonymousMode": false,
    "visibility": {
      "totalAssets": "everyone",
      "miningPower": "self",
      "communities": "self",
      "tradeHistory": "everyone"
    },
    "friendRequests": "enabled",
    "groupInvites": "friends",
    "directMessages": "friends"
  },
  "version": 0,
  "updatedAt": null,
  "contractVersion": "2.0"
}
```

## `PUT /v2/profile/privacy`

```json
{
  "expectedVersion": 0,
  "privacy": {
    "discoverable": true,
    "anonymousMode": false,
    "visibility": {
      "totalAssets": "self",
      "miningPower": "everyone",
      "communities": "everyone",
      "tradeHistory": "self"
    },
    "friendRequests": "enabled",
    "groupInvites": "friends",
    "directMessages": "disabled"
  }
}
```

- `discoverable`：只决定别人能否按**别名**搜到你、推荐里是否列出你（决策 0090 起按精确 LOOP ID
  搜索不看它；决策 0096 起发好友申请与关注也都不看它）；`anonymousMode`：只显示别名、
  永不显示钱包地址；四个 visibility 各为 `self | everyone`。
- 与 V1 `/v1/profile/privacy` 完全独立（各自的表与 version）；不存在
  `copyTradeVisibility`，传入任何未知字段都是 `400`。
- 展示类值只是展示偏好，不是授权，也不产生任何社交关系。

### 社交开关（决策 0070，2026-09-23 新增）

| 字段             | 取值                  | 默认      | 服务端在哪里读它                                                                                   |
| ---------------- | --------------------- | --------- | -------------------------------------------------------------------------------------------------- |
| `friendRequests` | `enabled \| disabled` | `enabled` | `POST /v2/message-requests`：目标关闭则 `404 NOT_FOUND`（决策 0090 起**不再**要求 `discoverable`） |
| `groupInvites`   | `friends \| disabled` | `friends` | `POST /v2/chat/groups`：任一被邀请好友关闭则 `404 NOT_FOUND`                                       |
| `directMessages` | `friends \| disabled` | `friends` | `POST /v2/chat/direct-channels`：目标关闭则 `404 NOT_FOUND`（好友关系仍是前提）                    |

- **`PUT` 是整体替换，三个字段全部必填**；缺任一字段或值不在枚举内 →
  `400 INVALID_REQUEST`。前端保存时把 `GET` 读到的九个值一起回传。
- 三个开关与展示类开关在同一事务提交；任何一个开关变化都会让 `version` +1。
  无行账号首次写入（`expectedVersion: 0`）后 `version` 为 1。
- "缺行即默认"：从未进过隐私中心的账号在服务端就是 `enabled/friends/friends`，
  不需要前端做任何初始化写入。用户主动关掉的值会被原样保留。
- 语义文案建议（决策 0090 更新，客户端文案由前端后续对齐）：`discoverable` =
  "可被发现"（副标题："允许别人按昵称搜到你；LOOP ID 始终可被精确搜索"，决策 0096 起不再含"关注你"）；
  `friendRequests` = "允许陌生人发好友申请"（副标题："知道你 LOOP ID 的人可以加你"）；`directMessages` = "允许好友发起私聊"；
  `groupInvites` = "允许好友拉我进群"。
- 旧 `/v1/profile/social-privacy` 已退役，不要再调用；它的默认值也已同步为开启。

## 别名规则与错误码

- 字符安全：拒绝控制字符、双向控制、零宽/不可见格式字符、行/段分隔符；
  两端空白会被 trim。空白/纯空格的别名或简介是请求形状错误 →
  `400 INVALID_REQUEST`；trim 后超过 40（别名）/ 160（简介）码点 →
  `422 VALIDATION_FAILED`。
- 保留词：`loop admin official support system mod moderator team`。规则：
  NFKC + 小写后，按非字母数字拆分出的任一 token 去掉数字后等于保留词
  （`Admin`、`admin123`、`x_admin`、`LOOP Team`）；长度 ≥5 的保留词
  （`admin official support system moderator`）作为 token 的前缀或后缀也命中，
  且先剥掉 token 两端的其他保留词再判断
  （`AdminAlice`、`superadmin`、`LoopSupportBot`、`administrator`）；去掉分隔符
  和数字后的整体是保留词拼接也命中（`loopadmin`、`official-loop`）。短词
  `loop`/`team`/`mod` 只做整 token 匹配，`loopy`、`teams`、`modern` 允许。
  命中返回 `422 ALIAS_RESERVED`。
- 敏感词：后端 `V2_ALIAS_BLOCKED_TERMS`（默认空），term 与别名都做 NFKC +
  小写，并额外比较去掉空白与分隔符的 compact 形式（`rug pull` 命中 `rugpull`、
  `rug-pull`、`Rug_Pull`），命中返回 `422 ALIAS_BLOCKED`。
- 别名允许重复；前端的"换一个"只是本地随机建议，不需要查重。

本模块可能返回的错误码与建议行为：

| Code                         | HTTP | category         | retryable | 建议行为                                                          |
| ---------------------------- | ---- | ---------------- | --------- | ----------------------------------------------------------------- |
| `INVALID_REQUEST`            | 400  | `validation`     | no        | 请求形状/枚举/header 错误；修正后重发                             |
| `AUTH_REQUIRED`              | 401  | `authentication` | no        | 回到 Privy 登录                                                   |
| `AUTH_INVALID`               | 401  | `authentication` | no        | 刷新 Privy access token 后重试                                    |
| `NOT_FOUND`                  | 404  | `validation`     | no        | 模块未启用；按 capabilities 展示 unavailable                      |
| `ACCOUNT_BOOTSTRAP_REQUIRED` | 409  | `authentication` | no        | 用同一 token 调 `POST /v2/session/bootstrap`                      |
| `VERSION_CONFLICT`           | 409  | `conflict`       | no        | 重新 `GET` 取最新 `version` 后再提交；contract 版本不符也返回此码 |
| `IDEMPOTENCY_CONFLICT`       | 409  | `conflict`       | no        | 停止重试，记录 `correlationId`，重新生成 key 与 body 提交         |
| `VALIDATION_FAILED`          | 422  | `validation`     | no        | 别名/简介 trim 后超长；提示用户修改                               |
| `ALIAS_RESERVED`             | 422  | `validation`     | no        | 提示"该名称为系统保留"                                            |
| `ALIAS_BLOCKED`              | 422  | `validation`     | no        | 提示"该名称包含不允许的词"                                        |
| `INTERNAL_ERROR`             | 500  | `internal`       | no        | 通用错误并记录 `correlationId`                                    |
| `CAPABILITY_UNAVAILABLE`     | 503  | `availability`   | yes       | 展示暂不可用；登录流程不阻塞                                      |
| `PROVIDER_DISCONNECTED`      | 503  | `availability`   | yes       | Privy 校验不可用；稍后重试                                        |
| `REQUEST_TIMEOUT`            | 503  | `availability`   | yes       | 激活用原 key/body 重试；CAS 写用原 `expectedVersion` 重试         |

`userMessageKey` 分别为 `errors.alias.reserved`、`errors.alias.blocked`；
其余见 `docs/api-v2-conventions.md`。

## capabilities 增量

`GET /v2/meta/capabilities` 现为 **31** 项（以 `openapi/loop-api.v2.json` 为唯一计数来源，不要写死），本模块新增：

```json
{ "capabilityId": "profile", "availability": "available", "reasonCode": null, "evidence": { "status": "notApplicable", "reasonCode": null } }
{ "capabilityId": "avatarUpload", "availability": "available", "reasonCode": null, "evidence": { "status": "notApplicable", "reasonCode": null } }
```

`avatarUpload` 自决策 0095 起由运行时决定：`profile` 可用 + PostgreSQL 媒体存储
已组合 + `STREAM_TOKEN_QUOTA_HMAC_SECRET` 已配置 → `available`；否则
`unavailable` / `AVATAR_STORAGE_UNAVAILABLE`（原 `AVATAR_STORAGE_NOT_SELECTED`
已改名）。

`profile` 未启用时为 `deferred` / `PROFILE_MODULE_NOT_ENABLED`；启用但数据库未
组合时为 `unavailable` / `PROFILE_RUNTIME_UNAVAILABLE`。

`GET /v2/meta/client-policy` 的 `versionGate` / `termsGate` 在配置了策略但
`effectiveAt` 尚未到达时保持 `unavailable`，`reasonCode` 为
`POLICY_NOT_YET_EFFECTIVE`（解析器需接受该枚举值）。

## 媒体上传与头像（决策 0095，S107）

### `POST /v2/media/avatars`、`POST /v2/media/community-logos`

```text
Authorization: Bearer <current Privy access token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: 1.0.0
Idempotency-Key: <canonical lowercase UUIDv4, 每次新选图换一个>
Content-Type: multipart/form-data; boundary=...
```

- body：**只有一个** part，名字 `file`（文件名、声明的 Content-Type 都不看）。
  其它 part、多个文件、part 名不是 `file`、非 multipart → `400 INVALID_REQUEST`。
- 内容按魔数识别：JPEG / PNG / WebP / HEIC(HEIF)。≤ 5 MiB，宽高都 ≥ 64 px。
  服务端统一转成 **512×512 cover WebP（质量 82，去元数据）**，客户端裁成方形再传
  效果最好。HEVC 编码的 HEIC 服务端解不了 → `MEDIA_DECODE_FAILED`，iOS 请交
  JPEG（image_picker 指定 `imageQuality` 即输出 JPEG）。
- 不需要已激活资料：注册页 `loop-id-setup` 激活前即可上传。
- 限频：两个上传接口合计每用户每分钟 6 次 → `429 RATE_LIMITED`（`retryable: true`）。
- 幂等：同一 `Idempotency-Key` + 同一字节 → 返回同一对象（201，同 body）；
  同 key 不同字节或换了接口 → `409 IDEMPOTENCY_CONFLICT`。

`201`：

```json
{
  "mediaId": "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  "ref": "avatar:media/6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  "url": "/v2/media/6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f.webp",
  "width": 512,
  "height": 512,
  "contractVersion": "2.0"
}
```

社区 logo 上传返回 `ref: "logo:media/{mediaId}"`。`url` 是相对路径，客户端拼
API base URL。

错误（七字段错误体）：

| HTTP | code                                                  | 说明                                                                                                                        |
| ---- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                                     | 缺/错 header、非 multipart、part 不对                                                                                       |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID`                      | Bearer 缺失或无效                                                                                                           |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED` / `IDEMPOTENCY_CONFLICT` |                                                                                                                             |
| 422  | `VALIDATION_FAILED`                                   | `detailsSafe.reasonCode` ∈ `MEDIA_TYPE_UNSUPPORTED`、`MEDIA_TOO_LARGE`、`MEDIA_DIMENSIONS_TOO_SMALL`、`MEDIA_DECODE_FAILED` |
| 429  | `RATE_LIMITED`                                        | 每分钟 6 次                                                                                                                 |
| 503  | `CAPABILITY_UNAVAILABLE`                              | 存储或限频未组合（与 `avatarUpload` unavailable 一致）                                                                      |

### `GET /v2/media/{mediaId}.webp`

公共图片资源，**不带任何 header**（与 `/v2/market/logos/...` 一样）。
`200 image/webp`，`Cache-Control: public, max-age=31536000, immutable`，强
`ETag`；带 `If-None-Match` → `304`。不存在 → `404 NOT_FOUND`；ID 格式错 →
`400 INVALID_REQUEST`。对象不可变，客户端可永久缓存。

### `avatarRef` 规则

- 接受：13 个预设（`avatar:preset/people-01..12`、`avatar:preset/monogram`）或
  `avatar:media/{mediaId}`。默认头像 = `avatar:preset/monogram`（别名首字母）。
  预设人物图不再在客户端提供选择，但旧值继续可写可渲染。
- `avatar:media/{id}` 必须是**本人**上传的头像（不是 logo、不是别人的、存在）；
  否则 `PUT /v2/profile` / `POST /v2/profile/loop-id` → `422 VALIDATION_FAILED`，
  `detailsSafe.reasonCode = MEDIA_NOT_OWNED`。媒体存储不可用时 →
  `503 CAPABILITY_UNAVAILABLE`。
- 渲染：`avatar:media/{id}` → `{baseUrl}/v2/media/{id}.webp`；`avatar:preset/*` 旧逻辑。

### 真实身份进 Stream

`PUT /v2/profile` 与 `POST /v2/profile/loop-id` 成功后，服务端把本人 Stream user
upsert 为 `{ id, name: alias, image: <绝对 URL>, custom: { publicProfileId } }`
（预设/空头像时不带 `image`，即 Stream 侧为空；资料未激活时不带
`publicProfileId`）。Stream 失败不影响资料写入（日志记录，`pnpm
stream:users-backfill --apply` 修复）。客户端注意：

- 聊天气泡、会话行、成员列表直接用 Stream user 的 `name` / `image`；`image`
  为空时按 avatarRef 规则或首字母兜底。
- 点头像进公开资料页：读 Stream user 的自定义字段 `publicProfileId`（见
  `docs/frontend-v2-social-api.md`「从 Stream 头像进入资料页」）。
- `connectUser` 时**不要**传 `name` / `image` / 自定义字段（只传 `id`），避免客户端
  覆盖服务端写的真实身份。

## 当前验收状态

- 已通过：format/lint/typecheck/OpenAPI 双产物/单元与契约测试；PostgreSQL
  迁移回填、唯一约束、LOOP ID 冲突重试、V1/V2 共享列与 CAS 双向一致、幂等激活、
  V2 隐私 CAS 的 integration 测试。
- 未验证：真机 Privy token 下的完整流程（属 S2 联调与 Go/No-Go）。
