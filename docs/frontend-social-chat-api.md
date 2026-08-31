# LOOP 好友与聊天前端联调接口

本文档面向 Flutter 前端，描述 Development 环境中好友、公开昵称搜索、
Stream 频道创建和群内昵称相关的 LOOP HTTP 契约。实现以
`src/routes/` 的 Fastify Schema 和生成的
[`openapi/loop-api.v1.json`](../openapi/loop-api.v1.json) 为准。

这是一份联调契约，不是上线证明。PostgreSQL 本地能力可以独立工作，
但 Stream 频道、成员校验和群昵称投影仍需要真实 Development Stream App；
真机 Privy 登录、Stream 权限和物理设备闭环尚需单独验收。

## 1. 联调入口与通用规则

### 1.1 Base URL

```text
https://api-dev.quant-dinger.cc
```

本地直连默认是 `http://127.0.0.1:3000`。移动端联调应使用上面的 HTTPS
Development 域名；不要把它指向 Mainnet 或生产签名环境。

### 1.2 身份认证

除健康检查外，本文所有 `/v1` 请求都使用当前 Privy access token：

```http
Authorization: Bearer <current_privy_access_token>
```

- 不要传 Privy refresh token。
- 不要在 Body、Query 或 Header 中传 LOOP 内部用户 ID、Privy DID 或
  Stream user ID 来选择当前用户。
- `POST /v1/bootstrap` 可以首次创建当前 Privy 身份到 LOOP 用户的映射；
  其他接口在映射不存在时返回 `409 bootstrap_required`。
- 每次请求都会重新校验当前 Bearer。遇到 `401 invalid_access_token` 时，
  应通过 Privy SDK 获取新的当前 access token，再重试请求。

### 1.3 Request ID 与错误格式

每个 HTTP 响应都带一个新的相关性 Header：

```http
X-Request-ID: 550e8400-e29b-41d4-a716-446655440000
Cache-Control: no-store
```

错误 Body 的统一形状是：

```json
{
  "code": "invalid_request",
  "message": "The request is invalid.",
  "request_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

`request_id` 只用于日志和排障，不是业务资源 ID，也不能用来查询操作结果。
前端应按 `code` 分支，不要依赖英文 `message`。

### 1.4 Idempotency-Key

下面四个命令接口必须各自携带恰好一个 Header：

- `POST /v1/friend-requests`
- `POST /v1/friend-requests/{friend_request_id}/decision`
- `POST /v1/chat/groups`
- `POST /v1/chat/direct-channels`

格式必须是原始、小写、标准 UUIDv4：

```http
Idempotency-Key: 8c5d9f7a-6e21-4c30-8d7b-9120e6f54a31
```

规则：

- 每个新的逻辑命令生成一个新 UUIDv4。
- 同一逻辑命令发生超时、断网或丢响应时，必须复用原 UUID 和完全相同的
  Body；不要生成新 UUID 盲目重试。
- 该 UUID 同时就是公开的 `operation_id`。即使 POST 响应丢失，前端也已
  知道查询地址。
- 相同 UUID 和相同内容返回原结果；同一 social 或 Chat command scope 内，
  相同 UUID 搭配不同内容/命令返回 `409 idempotency_conflict`。前端仍应把
  UUID 当作全局一次性值，不跨任何逻辑命令复用。
- Social 命令的精确重放会先命中持久化幂等记录，不会再次消耗好友写配额；
  只有尚未见过的新命令才扣配额。
- 其他 GET、Profile CAS PUT、social-privacy PUT、群昵称 PUT 都不接受
  `Idempotency-Key`。

### 1.5 严格输入

- 未声明字段、重复 Query 参数和未声明 Query 参数都会返回
  `400 invalid_request`。
- GET 请求不能带 Body，也不能带 `Idempotency-Key`。
- 带 JSON Body 的请求使用 `Content-Type: application/json`。
- UUID、枚举和字段名区分大小写。客户端不要发送 `null` 代替未声明的
  Query 参数。

跨接口通用错误：

| HTTP | `code`                       | 含义                                                  |
| ---- | ---------------------------- | ----------------------------------------------------- |
| 400  | `invalid_request`            | 严格 Header、Query、Params 或 Body 校验失败           |
| 401  | `authentication_required`    | 缺少 Bearer；同时有 `WWW-Authenticate`                |
| 401  | `invalid_access_token`       | Privy access token 无效或已过期                       |
| 409  | `bootstrap_required`         | 当前 Privy 身份尚无 LOOP bootstrap 映射               |
| 503  | `authentication_unavailable` | Privy 服务端校验能力不可用                            |
| 503  | `request_timeout`            | 服务端总请求截止时间已到；写操作按 operation 规则恢复 |
| 500  | `internal_error`             | 未公开内部细节；记录 `X-Request-ID` 后排障            |

## 2. 前端应使用的身份引用

| 字段                | 用途                                                  | 是否可作为命令目标                |
| ------------------- | ----------------------------------------------------- | --------------------------------- |
| `public_profile_id` | 随机、不透明的公开 Profile 引用                       | 是；好友申请、建群和私聊只接受它  |
| `profile_code`      | 10 位、全局唯一、不可变的 Crockford Base32 展示区分码 | 否；只用于区分同名 Alias          |
| `alias`             | 可变、可重复的公开昵称                                | 否；不能据此唯一选择用户          |
| `group_id`          | LOOP 的不透明群组引用                                 | 仅用于群内昵称接口                |
| `group_alias_id`    | 某用户在某群的群内昵称引用                            | 仅用于显示/群内搜索，不可跨群关联 |
| `stream_cid`        | 已创建频道的完整 Stream CID，例如 `messaging:...`     | 交给 Stream SDK 打开频道          |

钱包地址、Privy DID、LOOP 内部用户 ID 和 Stream user ID 都不是公开搜索或
好友目标。`profile_code` 不进入 Stream，也不出现在群内昵称接口。

## 3. 登录与 Stream 前置接口

### 3.1 `POST /v1/bootstrap`

请求没有 Body、Query 或 `Idempotency-Key`。

```http
POST /v1/bootstrap
Authorization: Bearer <token>
```

成功 `200`：

```json
{
  "user": {
    "id": "a40b5d87-e815-4abc-9f03-f2e8d58750d1"
  },
  "stream_user_id": "loop_7m3h9t2xk4p8"
}
```

`user.id` 和 `stream_user_id` 是当前登录会话的服务端派生结果。不要把它们
当作好友接口目标，也不要让用户输入它们。

### 3.2 `POST /v1/chat/token`

请求没有 Body、Query 或 `Idempotency-Key`。它要求 bootstrap 已完成。

成功 `200`：

```json
{
  "api_key": "stream-development-api-key",
  "token": "<short-lived-stream-user-token>",
  "expires_at": "2026-08-31T10:30:00.000Z",
  "user": {
    "id": "loop_7m3h9t2xk4p8"
  }
}
```

Token 固定为一小时有效。Flutter 使用 `api_key`、`token` 和 `user.id` 连接
官方 Stream Chat SDK。常见错误：

| HTTP | `code`                | 处理                                  |
| ---- | --------------------- | ------------------------------------- |
| 409  | `bootstrap_required`  | 先调用 bootstrap                      |
| 429  | `rate_limit_exceeded` | 停止重复取 Token，稍后再试            |
| 503  | `stream_unavailable`  | Stream 凭据、签发器或持久化配额未就绪 |

## 4. 当前用户公开 Profile

公开 Alias 与社交权限是两个独立资源。首次联调建议先保存 Profile，再分别
开启需要的发现和社交权限。

### 4.1 `GET /v1/profile`

无记录时只返回不写库的版本 0 默认值：

```json
{
  "version": 0,
  "profile": {
    "alias": null,
    "avatar_ref": null
  },
  "updated_at": null
}
```

### 4.2 `PUT /v1/profile`

使用 GET 得到的 `version` 做 CAS 全量替换，不接受 `Idempotency-Key`：

```json
{
  "expected_version": 0,
  "profile": {
    "alias": "Wendi",
    "avatar_ref": null
  }
}
```

成功 `200` 返回与 GET 相同形状、递增后的版本。`alias` 可为 `null`，否则
trim 后为 1–40 个 Unicode code point，且不能含控制或不可见格式字符。
`avatar_ref` 只能是 `avatar:...` 形式的不透明 LOOP 引用或 `null`，不能直接
传任意 URL。

`409 version_conflict` 表示版本已变化，应重新 GET 后让用户确认再提交。
已经提交成功但响应丢失时，用原 `expected_version` 和完全相同的 Body 重试
会返回已提交资源。

### 4.3 `GET/PUT /v1/profile/privacy`

这是公开展示隐私，不是好友权限。版本 0 默认：

```json
{
  "version": 0,
  "privacy": {
    "discoverable": false,
    "copy_trade_visibility": "private"
  },
  "updated_at": null
}
```

开启昵称搜索示例：

```http
PUT /v1/profile/privacy
```

```json
{
  "expected_version": 0,
  "privacy": {
    "discoverable": true,
    "copy_trade_visibility": "private"
  }
}
```

两个字段都必须发送。`copy_trade_visibility` 只是已有展示偏好；它不授予交易
权限，与好友/聊天闭环无关。

## 5. 社交隐私

### 5.1 `GET /v1/profile/social-privacy`

无记录时返回不写库的 fail-closed 默认值：

```json
{
  "version": 0,
  "social_privacy": {
    "friend_requests": "disabled",
    "group_invites": "disabled",
    "direct_messages": "disabled"
  },
  "updated_at": null
}
```

字段含义：

- `friend_requests=enabled`：允许可发现用户向自己发好友申请。
- `group_invites=friends`：允许已接受好友把自己加入后端新建群。
- `direct_messages=friends`：允许已接受好友取得与自己的私聊频道。

### 5.2 `PUT /v1/profile/social-privacy`

不接受 `Idempotency-Key`，使用 CAS 全量替换：

```json
{
  "expected_version": 0,
  "social_privacy": {
    "friend_requests": "enabled",
    "group_invites": "friends",
    "direct_messages": "friends"
  }
}
```

成功 `200` 返回完整资源。`409 version_conflict` 时重新 GET。未配置服务端
social cursor/quota 两个密钥时，本接口也会 fail closed 返回
`503 social_unavailable`。

## 6. 昵称搜索

两个公开搜索接口都要求目标满足：Profile Alias 非空且
`/v1/profile/privacy` 的 `discoverable=true`。当前用户自己不会出现在结果中。
相同 Alias 可以出现多次，前端应同时展示 `profile_code`。

搜索规范：

- `alias_prefix` 必填；trim、NFKC 和空格折叠后为 2–40 个 Unicode code
  point。
- 只做前缀匹配，不做模糊、子串或通配符搜索。
- `limit` 可选，默认 20，范围 1–20。
- 没有 total 和 cursor；`truncated=true` 时提示用户继续输入更长前缀。
- 两个接口共用同一公开搜索配额，不能通过交替调用扩大枚举预算。

### 6.1 `GET /v1/discovery/users`

```http
GET /v1/discovery/users?alias_prefix=We&limit=20
```

成功 `200`：

```json
{
  "items": [
    {
      "public_profile_id": "56de310d-c4ca-4d8d-8ba3-a5efaf5b8379",
      "profile_code": "01ARZ3NDEK",
      "alias": "Wendi",
      "avatar_ref": null
    }
  ],
  "truncated": false
}
```

这个接口只返回公开展示，不返回好友关系状态。

### 6.2 `GET /v1/friends/search`

好友页应优先使用本接口：

```http
GET /v1/friends/search?alias_prefix=We&limit=20
```

成功 `200`：

```json
{
  "items": [
    {
      "public_profile_id": "56de310d-c4ca-4d8d-8ba3-a5efaf5b8379",
      "profile_code": "01ARZ3NDEK",
      "alias": "Wendi",
      "avatar_ref": null,
      "relationship": "incoming_pending",
      "friend_request_id": "b019aaf4-83ce-4fb6-b7dc-28a5e7de58ba"
    }
  ],
  "truncated": false
}
```

`relationship`：

| 值                 | `friend_request_id` | 前端动作                            |
| ------------------ | ------------------- | ----------------------------------- |
| `none`             | `null`              | 可以显示“添加好友”                  |
| `outgoing_pending` | 对应请求 UUID       | 显示“等待对方接受”                  |
| `incoming_pending` | 对应请求 UUID       | 可以直接进入接受/拒绝 UI            |
| `friend`           | `null`              | 显示“已是好友”，可发起私聊/建群选择 |

不存在、不可发现、自身或不满足资格的目标都会被省略。公开搜索失败常见为：
`relationship=none` 还要求目标当前开放 `friend_requests`；已经形成的 pending
或 friend 关系不会因为对方关闭“新的好友申请”而从关系搜索中消失。

| HTTP | `code`                  | 含义                                                                         |
| ---- | ----------------------- | ---------------------------------------------------------------------------- |
| 400  | `invalid_request`       | 前缀、limit、Body/Header 或重复 Query 不合法                                 |
| 429  | `search_rate_limited`   | 搜索配额耗尽；`/friends/search` 当前返回 `Retry-After: 60`，其他搜索也应退避 |
| 503  | `discovery_unavailable` | `/discovery/users` 的目录/搜索配额不可用                                     |
| 503  | `social_unavailable`    | `/friends/search` 的 social 能力不可用                                       |

## 7. 好友列表与好友申请

### 7.1 `GET /v1/friends`

第一页：

```http
GET /v1/friends?limit=20
```

后续页：

```http
GET /v1/friends?cursor=<opaque_cursor>
```

`limit` 默认 20、最大 50。携带 `cursor` 时不能再传 `limit`；page size 已
绑定在 cursor 内。成功 `200`：

```json
{
  "items": [
    {
      "public_profile_id": "56de310d-c4ca-4d8d-8ba3-a5efaf5b8379",
      "profile_code": "01ARZ3NDEK",
      "alias": "Wendi",
      "avatar_ref": null,
      "accepted_at": "2026-08-31T09:45:12.123Z"
    }
  ],
  "next_cursor": null
}
```

好友接受后仍可清空或修改公开 Alias，所以列表中的 `alias`、`avatar_ref`
允许为 `null`；`public_profile_id` 和 `profile_code` 才是稳定引用。

Cursor 是 owner、路由、过滤条件和 page size 绑定的加密签名值，当前有效期
10 分钟。不要解析、缓存到其他账号或跨列表复用。过期、篡改或与当前请求
不匹配统一返回 `400 invalid_request`，此时从第一页重新加载。

### 7.2 `POST /v1/friend-requests`

```http
POST /v1/friend-requests
Authorization: Bearer <token>
Idempotency-Key: 8c5d9f7a-6e21-4c30-8d7b-9120e6f54a31
Content-Type: application/json
```

```json
{
  "target_public_profile_id": "56de310d-c4ca-4d8d-8ba3-a5efaf5b8379"
}
```

成功 `200` 返回一个已经终结的本地 operation：

```json
{
  "operation_id": "8c5d9f7a-6e21-4c30-8d7b-9120e6f54a31",
  "kind": "friend_request_send",
  "status": "succeeded",
  "terminal": true,
  "retry_after_ms": null,
  "result": {
    "friend_request_id": "b019aaf4-83ce-4fb6-b7dc-28a5e7de58ba",
    "status": "pending"
  },
  "error": null,
  "created_at": "2026-08-31T09:40:00.000Z",
  "updated_at": "2026-08-31T09:40:00.000Z"
}
```

目标必须同时拥有可发现的非空 Alias 且
`friend_requests=enabled`。自身、不可发现、不存在或未开放好友申请的目标统一
返回 `404 target_unavailable`，避免泄露目标是否存在。发送者必须先持久化
自己的 Profile，否则返回 `409 profile_required`。

一个无序用户对同一时间最多有一个 pending 请求：

- 同方向已有请求：`409 outgoing_request_pending`。
- 对方已经发来请求：`409 incoming_request_pending`；不会自动互加好友，
  前端应改为显示接受/拒绝。
- 已是好友：`409 already_friends`。
- 被拒绝后的冷却期：`409 friend_request_cooldown`。当前冷却为 24 小时。
- pending 请求当前在 7 天后过期。

### 7.3 `GET /v1/friend-requests`

只支持 pending 列表，`direction` 和 `status` 都必填：

```http
GET /v1/friend-requests?direction=incoming&status=pending&limit=20
```

`direction` 为 `incoming|outgoing`。第一页 `limit` 默认 20、最大 50；后续页
保留相同 `direction` 和 `status=pending`，只发送 cursor：

```http
GET /v1/friend-requests?direction=incoming&status=pending&cursor=<opaque_cursor>
```

有 cursor 时同样不能发送 `limit`。成功 `200`：

```json
{
  "items": [
    {
      "friend_request_id": "b019aaf4-83ce-4fb6-b7dc-28a5e7de58ba",
      "counterparty": {
        "public_profile_id": "56de310d-c4ca-4d8d-8ba3-a5efaf5b8379",
        "profile_code": "01ARZ3NDEK",
        "alias": "Wendi",
        "avatar_ref": null
      },
      "direction": "incoming",
      "status": "pending",
      "created_at": "2026-08-31T09:40:00.000Z",
      "expires_at": "2026-09-07T09:40:00.000Z"
    }
  ],
  "next_cursor": null
}
```

`counterparty.alias` 和 `avatar_ref` 可能在请求发出后被清空，因此均可为
`null`。

### 7.4 `POST /v1/friend-requests/{friend_request_id}/decision`

只有当前收件人可以决定请求：

```http
POST /v1/friend-requests/b019aaf4-83ce-4fb6-b7dc-28a5e7de58ba/decision
Idempotency-Key: 04dc1a8e-c1b9-4ca4-8b66-31396c942796
Content-Type: application/json
```

```json
{
  "decision": "accept"
}
```

`decision` 只能是 `accept` 或 `reject`。成功 operation 的 result status 分别是
`accepted` 或 `rejected`。只有 `accept` 会创建好友关系。第一次已经提交的
接受或拒绝不可改写；之后使用新命令再决定会返回
`409 friend_request_already_decided`。不存在、非当前收件人或不可见的请求
统一返回 `404 friend_request_not_found`。

### 7.5 `GET /v1/social/operations/{operation_id}`

好友写操作是 PostgreSQL 本地事务，公开状态只有 `succeeded|failed`，均为
终态。`operation_id` 就是发起命令时的 `Idempotency-Key`：

```http
GET /v1/social/operations/8c5d9f7a-6e21-4c30-8d7b-9120e6f54a31
```

成功 operation 形状见 7.2。已经持久化的业务失败示例：

```json
{
  "operation_id": "8c5d9f7a-6e21-4c30-8d7b-9120e6f54a31",
  "kind": "friend_request_send",
  "status": "failed",
  "terminal": true,
  "retry_after_ms": null,
  "result": null,
  "error": {
    "code": "target_unavailable"
  },
  "created_at": "2026-08-31T09:40:00.000Z",
  "updated_at": "2026-08-31T09:40:00.000Z"
}
```

当前 operation error code 集合：

```text
target_unavailable
profile_required
incoming_request_pending
outgoing_request_pending
already_friends
friend_request_cooldown
friend_request_not_found
friend_request_already_decided
```

`result.status` 的契约枚举是 `pending|accepted|rejected|expired`；当前发送成功
产生 `pending`，当前决定成功产生 `accepted` 或 `rejected`，过期值保留给
持久化请求生命周期投影。

未知 operation 和属于另一个用户的 operation 都返回
`404 social_operation_not_found`。

如果 POST 超时或断网：

1. 用原 `Idempotency-Key` 查询本接口。
2. 查询到 operation 就按其终态处理。
3. 暂时查不到时，可用原 UUID 和完全相同 Body 重试原 POST；不要生成新
   UUID。

注意：认证、配额或服务不可用可能发生在 operation 持久化之前，因此并非
每个 4xx/5xx 都一定能查到 operation。

好友 mutation 还可能返回：

| HTTP | `code`                | 含义                                           |
| ---- | --------------------- | ---------------------------------------------- |
| 429  | `social_rate_limited` | 发送或决定配额耗尽；当前返回 `Retry-After: 60` |
| 503  | `social_unavailable`  | social repository、cursor 或 quota 能力未就绪  |

## 8. 后端创建 Stream 频道

这两个 POST 只接受已接受好友的 `public_profile_id`。前端不能提交 Stream
user ID、成员角色、频道 ID、CID 或 distinct key。后端会先持久化固定频道
目标，再通过 Stream server SDK 创建/核对频道。

### 8.1 `POST /v1/chat/groups`

```http
POST /v1/chat/groups
Idempotency-Key: fef95867-8676-4575-99b9-e63e336748c2
Content-Type: application/json
```

```json
{
  "name": "Research Room",
  "friend_public_profile_ids": [
    "56de310d-c4ca-4d8d-8ba3-a5efaf5b8379",
    "e64c1448-2f32-4714-93b7-d5437029771e"
  ]
}
```

- 必须提供 2–29 个互不重复的已接受好友；后端自动加入当前用户，所以总
  成员数是 3–30。
- `name` trim 后为 1–60 个 Unicode code point；原始输入最多 512 字符，
  不能包含控制/不可见格式字符。
- 每个目标当前都必须设置 `group_invites=friends`。
- 后端在真正调用 Stream 前再次检查好友关系和隐私。若初次准备时已经不
  满足，返回 `404 target_unavailable`，不创建 operation。若 operation 已
  持久化后、provider 写入前资格才变化，则返回 HTTP `200` 的终态
  `failed` operation，`error.code=target_unavailable`；其 provider attempt
  仍为 0。
- 同样的成员和名称使用一个新的 Idempotency-Key 可以创建另一个群。

### 8.2 `POST /v1/chat/direct-channels`

```http
POST /v1/chat/direct-channels
Idempotency-Key: cc63d67f-8f2e-48d7-a701-c932f70364bf
Content-Type: application/json
```

```json
{
  "target_public_profile_id": "56de310d-c4ca-4d8d-8ba3-a5efaf5b8379"
}
```

目标必须是已接受好友，且目标当前设置
`direct_messages=friends`。一个无序好友对只有一个固定 direct CID；双方
并发请求或之后使用新 operation 请求都会收敛到同一个 `stream_cid`。

### 8.3 Chat operation 响应

非终态返回 HTTP `202`，并同时带：

```http
Location: /v1/chat/operations/fef95867-8676-4575-99b9-e63e336748c2
Retry-After: 2
```

```json
{
  "operation_id": "fef95867-8676-4575-99b9-e63e336748c2",
  "kind": "group_create",
  "status": "reconciling",
  "terminal": false,
  "retry_after_ms": 2000,
  "result": null,
  "error": null,
  "created_at": "2026-08-31T09:50:00.000Z",
  "updated_at": "2026-08-31T09:50:01.000Z"
}
```

`pending|submitting|reconciling` 都是非终态。前端应取
`max(retry_after_ms, Retry-After)` 控制轮询，不要高频请求。

群创建成功是 HTTP `200`：

```json
{
  "operation_id": "fef95867-8676-4575-99b9-e63e336748c2",
  "kind": "group_create",
  "status": "succeeded",
  "terminal": true,
  "retry_after_ms": null,
  "result": {
    "group_id": "e464386d-cd85-472d-9b22-2d94412ad413",
    "name": "Research Room",
    "friend_public_profile_ids": [
      "56de310d-c4ca-4d8d-8ba3-a5efaf5b8379",
      "e64c1448-2f32-4714-93b7-d5437029771e"
    ],
    "stream_cid": "messaging:loop_group_fef958678676457599b9e63e336748c2"
  },
  "error": null,
  "created_at": "2026-08-31T09:50:00.000Z",
  "updated_at": "2026-08-31T09:50:02.000Z"
}
```

Direct 成功时只改变 `kind` 和 result：

```json
{
  "operation_id": "cc63d67f-8f2e-48d7-a701-c932f70364bf",
  "kind": "direct_get_or_create",
  "status": "succeeded",
  "terminal": true,
  "retry_after_ms": null,
  "result": {
    "target_public_profile_id": "56de310d-c4ca-4d8d-8ba3-a5efaf5b8379",
    "stream_cid": "messaging:loop_direct_cc63d67f8f2e48d7a701c932f70364bf"
  },
  "error": null,
  "created_at": "2026-08-31T09:52:00.000Z",
  "updated_at": "2026-08-31T09:52:01.000Z"
}
```

`failed|operator_required` 是终态，HTTP `200`，`result=null`，`error` 中有
机器码。前端当前需要处理：

| `error.code`                         | 终态                | 前端处理                                                                                      |
| ------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------- |
| `target_unavailable`                 | `failed`            | 好友/隐私最终复查失败；条件恢复后用新 UUID 重新发起                                           |
| `submission_not_started`             | `failed`            | canonical mapping 持久化后 20 秒仍未 claim attempt；原 UUID 永久失败，改用新 UUID 重新发起    |
| `stream_channel_not_created`         | `operator_required` | 一次 write 后 60 秒仍权威确认不存在，但不能证明不会延迟生效；停止自动重建并等待 operator 处置 |
| `direct_channel_unavailable`         | `failed`            | canonical direct 映射处于不可自动使用的终态；停止自动重试                                     |
| `stream_channel_projection_mismatch` | `operator_required` | 固定 CID 已存在但 kind/schema/精确成员不匹配；停止自动重试                                    |
| `stream_reconciliation_unavailable`  | `operator_required` | 连续 5 分钟无法完成权威只读对账；停止自动重试                                                 |

Schema 允许以后增加其他小写错误码，前端应提供通用失败展示。资格复查
失败发生在 provider attempt 之前；原 UUID 永久重放原终态。Provider 写入后
的未知结果会保留 operator hold；`operator_required` 不能当作成功，也不要
自动创建第二个频道。Direct 映射进入该 hold 后，新 operation 会以
`direct_channel_unavailable` 终结，直到有单独的 operator 处置能力。

`friend_public_profile_ids` 是成员集合，前端不要依赖返回顺序。`stream_cid`
是完整 CID，客户端把它当不透明值交给 Stream SDK；不要自己拼接频道 ID。

### 8.4 `GET /v1/chat/operations/{operation_id}`

```http
GET /v1/chat/operations/fef95867-8676-4575-99b9-e63e336748c2
```

该 GET 既查询本地状态，也可能对同一个已持久化固定 Stream ID 做只读
reconciliation。它绝不会分配第二个 ID。返回规则与 8.3 相同：非终态
`202`，终态 `200`。

未知 operation 和其他用户的 operation 都返回
`404 chat_operation_not_found`。POST 超时后直接用预先生成的
Idempotency-Key 查询；若尚未持久化，再用完全相同 UUID/Body 重试 POST。

频道接口常见 HTTP 错误：

| HTTP | `code`                     | 含义                                                               |
| ---- | -------------------------- | ------------------------------------------------------------------ |
| 400  | `invalid_request`          | Header、UUID、Body、成员数或群名不合法                             |
| 404  | `target_unavailable`       | 初次准备时目标不存在、不是好友或相关社交隐私关闭；不创建 operation |
| 404  | `chat_operation_not_found` | operation 不存在或不属于当前用户                                   |
| 409  | `idempotency_conflict`     | 同一 key 被不同命令或内容占用                                      |
| 503  | `chat_unavailable`         | DB、Stream server gateway 或协调能力未就绪                         |

如果资格在 operation 持久化后、provider 写入前才变化，响应不是上表的
404，而是 HTTP `200` 的终态 failed operation，error code 同样是
`target_unavailable`。这一区分让前端能确认该命令已经安全终结。

## 9. 已有 Stream 群与群内昵称

群内 Alias 是 UI 层的群内化名，不是强匿名机制。Stream 仍使用同一个稳定
server-derived user ID；修改客户端、provider/operator 权限或流量分析可能
关联同一账号。

Direct 频道没有群内 Alias namespace。下面接口只用于 group 或未标记的
legacy messaging channel。

### 9.1 `POST /v1/chat/groups/resolve`

用于把一个已经存在且当前用户已经加入的 Stream `messaging` 频道解析成
LOOP `group_id`。后端创建群成功后已经在 result 中返回 `group_id`，无需再次
resolve。

Body 接受频道 ID，不是完整 CID：

```json
{
  "stream_channel_id": "existing_group_channel_id"
}
```

成功 `200`：

```json
{
  "group_id": "e464386d-cd85-472d-9b22-2d94412ad413"
}
```

它只验证当前 Stream 成员并创建/取得 LOOP 映射；不会创建频道、加入用户、
添加成员或授权角色。已标记为 `direct` 的频道会按不存在处理，返回
`404 not_found`。

### 9.2 `GET /v1/chat/groups/{group_id}/me/alias`

先通过 Stream 重新确认当前用户仍是成员，再返回本人已经保留的群 Alias：

```json
{
  "group_alias_id": "bb5e12c2-40e2-4577-9951-57fac0b5ce5e",
  "alias": "Night Owl",
  "projection_state": "confirmed"
}
```

尚未设置、群不存在或当前已不是成员统一返回 `404 not_found`。

### 9.3 `PUT /v1/chat/groups/{group_id}/me/alias`

不接受 `Idempotency-Key`：

```json
{
  "alias": "Night Owl"
}
```

Alias trim 后为 1–40 个 Unicode code point；同一群内规范化后唯一，但不同
群可以使用相同 Alias。当前用户在该群第一次成功保留后永久不可修改：

- 完全相同的值可以安全重试。
- 不同值返回 `409 group_alias_immutable`。
- 名称已被群内其他账号永久保留时返回
  `409 group_alias_unavailable`。

离开 Stream 群不会释放 Alias；重新加入后仍恢复原值。LOOP PostgreSQL 是
权威来源，Stream member custom data 只是服务端投影。投影失败时保留记录仍
为 `pending`；请求可能返回 `503 chat_group_unavailable`，之后 GET 可看到
pending，并可用完全相同 PUT 重试投影。

### 9.4 `GET /v1/chat/groups/{group_id}/aliases`

```http
GET /v1/chat/groups/e464386d-cd85-472d-9b22-2d94412ad413/aliases?alias_prefix=Ni&limit=20
```

成功 `200`：

```json
{
  "items": [
    {
      "group_alias_id": "bb5e12c2-40e2-4577-9951-57fac0b5ce5e",
      "alias": "Night Owl"
    }
  ],
  "truncated": false
}
```

前缀和 limit 规则与公开搜索相同，无 cursor/total。服务端通过 Stream 重新
确认请求者及候选人当前都是成员，并省略请求者本人、离群成员和
`projection_state=pending` 的记录。结果不会包含 `public_profile_id`、
`profile_code`、Stream user ID、公开 Alias、钱包或跨群关联字段。

群昵称常见错误：

| HTTP | `code`                    | 含义                                   |
| ---- | ------------------------- | -------------------------------------- |
| 404  | `not_found`               | 群、Alias 或当前 Stream 成员关系不可见 |
| 409  | `group_alias_immutable`   | 本人在此群已有另一个永久 Alias         |
| 409  | `group_alias_unavailable` | 规范化名称已被此群保留                 |
| 429  | `search_rate_limited`     | 群内搜索配额耗尽                       |
| 503  | `chat_group_unavailable`  | Stream 成员检查/投影或 LOOP 映射不可用 |

## 10. 推荐的前端闭环

1. Privy 登录后取得当前 access token，调用 bootstrap。
2. GET Profile；用 CAS PUT 保存非空 Alias。
3. GET/PUT `/profile/privacy`，按用户选择开启 `discoverable`。
4. GET/PUT `/profile/social-privacy`，按用户选择开启好友申请、拉群和私聊。
5. 好友页调用 `/friends/search`，展示 `alias + profile_code` 和 relationship。
6. `none` 时生成 UUIDv4，发送好友申请；网络未知时按原 UUID 查
   `/social/operations/{id}`。
7. 收件方分页读取 incoming pending，生成新的 UUIDv4 接受或拒绝。
8. 接受后刷新 `/friends`；不要仅凭本地 UI 状态推断已成为好友。
9. 调 `/chat/token` 并连接 Stream Chat SDK。
10. 私聊或建群使用后端频道 POST。202 时遵守 Retry-After 轮询 operation。
11. 成功后使用返回的完整 `stream_cid` 通过 Stream SDK watch/query 频道。
12. 群聊需要匿名昵称时，使用 result 的 `group_id` PUT 本人群 Alias；消息、
    历史和成员 UI 仍由 Stream SDK 提供。

## 11. Stream SDK 与 LOOP API 的职责边界

继续直接通过官方 Stream SDK 完成：

- 消息发送、接收和历史分页；
- 已读、未读、输入状态和在线状态；
- 频道 watch、成员呈现及实时事件；
- Chat/Video 通话相关状态。

必须通过 LOOP 后端完成：

- Stream user token 签发；
- 从好友关系创建 group/direct 频道；
- 固定频道 ID、幂等和不确定结果 reconciliation；
- public-profile 目标到 Stream 成员的服务端派生；
- 群内 Alias 的永久保留和服务端投影。

App 不应直接为其他用户创建频道、修改成员、修改服务端保留的 member
custom fields 或通过 Stream `queryUsers` 构建用户搜索。上线前仍要在 Stream
Dashboard/权限测试中证明这些客户端操作确实被拒绝。

## 12. 服务端配置与当前证据边界

以下值只放在后端忽略提交的 `.env.local`，不得进入 Flutter 或 Git：

| 能力                                  | 必需配置                                                              | 缺失时                                    |
| ------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------- |
| Privy Bearer 校验                     | `PRIVY_APP_ID`, `PRIVY_APP_SECRET`                                    | `503 authentication_unavailable`          |
| Stream token + Chat provider          | `STREAM_API_KEY`, `STREAM_API_SECRET`                                 | Token/频道/群 Alias fail closed           |
| Stream token 和公开/群 Alias 搜索配额 | `STREAM_TOKEN_QUOTA_HMAC_SECRET`                                      | Token 或 Alias 搜索 `503`                 |
| Social cursor 和好友写配额            | `SOCIAL_CURSOR_HMAC_SECRET`, `SOCIAL_QUOTA_HMAC_SECRET`，两者同时配置 | 所有 social 路由 `503 social_unavailable` |

Privy、Stream 以及 Social 的成对配置都不能只填一半：只填一个成对字段会被视为
启动配置错误；Social 两个值都留空时进程可以启动，但 social 路由保持上述 503
fail-closed 状态。

这些配置能让代码路径可用，但不自动证明以下验收已完成：

- 两个真实 Privy 账号在实体手机完成好友同意闭环；
- Development Stream App 创建 group/direct、双方并发 direct 收敛；
- 群 Alias 投影、离群/重新加入和候选成员过滤；
- Flutter 重启后的历史发现；
- 客户端无法绕过后端创建频道、改成员或改服务端字段。

## 13. 本阶段明确不提供

- 二维码加好友或身份解析；
- 钱包地址搜索；
- 删除好友、拉黑/解除拉黑和 blocklist 管理；
- 群成员邀请、移除、退出、转让、角色和群管理 LOOP API；
- Alias 历史、跨群 Alias 关联或强匿名保证；
- 消息/历史/已读/输入/在线状态的平行 LOOP API；
- Firebase Push、设备 Token 注册或通知收件箱；
- 账号删除、社交数据保留和外部发布级完整滥用控制。

因此当前 Development 闭环不能声称已经执行 block check、好友关系撤销、
完整群成员生命周期或推送通知。需要这些能力时必须先新增产品/安全决策和
后端契约。
