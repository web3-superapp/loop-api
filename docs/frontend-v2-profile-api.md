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
  才调用本模块；`avatarUpload` 恒为 `unavailable`（`AVATAR_STORAGE_NOT_SELECTED`），
  不要展示上传入口为可用。
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
  `409 IDEMPOTENCY_CONFLICT`。key 与 device/platform/client version 无关。
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

无 body/query。无行时返回 version 0 的 fail-closed 默认值（不落库）：

```json
{
  "privacy": {
    "discoverable": false,
    "anonymousMode": false,
    "visibility": {
      "totalAssets": "self",
      "miningPower": "self",
      "communities": "self",
      "tradeHistory": "self"
    }
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
    }
  }
}
```

- `discoverable`：显示 LOOP ID、允许被搜索；`anonymousMode`：只显示别名、
  永不显示钱包地址；四个 visibility 各为 `self | everyone`。
- 与 V1 `/v1/profile/privacy` 完全独立（各自的表与 version）；不存在
  `copyTradeVisibility`，传入任何未知字段都是 `400`。
- 这些值只是展示偏好，不是授权，也不产生任何社交关系。

## 别名规则与错误码

- 字符安全：拒绝控制字符、双向控制、零宽/不可见格式字符、行/段分隔符；
  两端空白会被 trim；trim 后 1–40 码点。
- 保留词（大小写与前后缀变体均命中）：`loop admin official support system
mod moderator team`。规则：NFKC + 小写后，按非字母数字拆分出的任一 token 去掉
  数字后等于保留词（`Admin`、`admin123`、`x_admin`、`LOOP Team`），或去掉分隔符
  和数字后的整体是保留词的拼接（`loopadmin`、`official-loop`）。`loopy`、
  `modern`、`administrator` 不命中。命中返回 `422 ALIAS_RESERVED`。
- 敏感词：后端 `V2_ALIAS_BLOCKED_TERMS`（默认空），NFKC + 小写后子串匹配，
  命中返回 `422 ALIAS_BLOCKED`。
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
| `VALIDATION_FAILED`          | 422  | `validation`     | no        | 别名/简介长度或空白不合规；提示用户修改                           |
| `ALIAS_RESERVED`             | 422  | `validation`     | no        | 提示"该名称为系统保留"                                            |
| `ALIAS_BLOCKED`              | 422  | `validation`     | no        | 提示"该名称包含不允许的词"                                        |
| `INTERNAL_ERROR`             | 500  | `internal`       | no        | 通用错误并记录 `correlationId`                                    |
| `CAPABILITY_UNAVAILABLE`     | 503  | `availability`   | yes       | 展示暂不可用；登录流程不阻塞                                      |
| `PROVIDER_DISCONNECTED`      | 503  | `availability`   | yes       | Privy 校验不可用；稍后重试                                        |
| `REQUEST_TIMEOUT`            | 503  | `availability`   | yes       | 激活用原 key/body 重试；CAS 写用原 `expectedVersion` 重试         |

`userMessageKey` 分别为 `errors.alias.reserved`、`errors.alias.blocked`；
其余见 `docs/api-v2-conventions.md`。

## capabilities 增量

`GET /v2/meta/capabilities` 现为 18 项，新增：

```json
{ "capabilityId": "profile", "availability": "available", "reasonCode": null, "evidence": { "status": "notApplicable", "reasonCode": null } }
{ "capabilityId": "avatarUpload", "availability": "unavailable", "reasonCode": "AVATAR_STORAGE_NOT_SELECTED", "evidence": { "status": "notApplicable", "reasonCode": null } }
```

`profile` 未启用时为 `deferred` / `PROFILE_MODULE_NOT_ENABLED`；启用但数据库未
组合时为 `unavailable` / `PROFILE_RUNTIME_UNAVAILABLE`。

`GET /v2/meta/client-policy` 的 `versionGate` / `termsGate` 在配置了策略但
`effectiveAt` 尚未到达时保持 `unavailable`，`reasonCode` 为
`POLICY_NOT_YET_EFFECTIVE`（解析器需接受该枚举值）。

## 当前验收状态

- 已通过：format/lint/typecheck/OpenAPI 双产物/单元与契约测试；PostgreSQL
  迁移回填、唯一约束、LOOP ID 冲突重试、V1/V2 共享列与 CAS 双向一致、幂等激活、
  V2 隐私 CAS 的 integration 测试。
- 未验证：真机 Privy token 下的完整流程（属 S2 联调与 Go/No-Go）。
