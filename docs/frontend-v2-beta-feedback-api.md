# 前端对接：内测反馈（S332 / 决策 0193，主代理 0262）

App（loop-mobile）与后台（loop-admin）共用本文。规则细节见 `docs/decisions/0193-beta-feedback.md`。

## 1. App 端

- Base URL：与其他 `/v2` 接口相同（`API_BASE_URL`）。
- 读请求头：`Authorization: Bearer <Privy access token>`、`X-Loop-Client-Version`、`X-Loop-Contract-Version: 2.0`。
- 写请求头：以上 + `Idempotency-Key`（小写 UUIDv4，每次新提交用新值；网络重试用同一个值）。
- 错误体固定七字段：`code / category / retryable / userMessageKey / correlationId / detailsSafe / providerReferenceSafe`。

### 1.1 `POST /v2/media/feedback-images`

`multipart/form-data`，只有一个 part `file`（JPEG / PNG / WebP / HEIC，≤ 5 MiB，两边 ≥ 64 px）。服务端转成 WebP，保持宽高比，最长边 ≤ 1440。

`201`：

```json
{
  "mediaId": "8d0f3c2e-6a1b-4c7d-9e2f-0a1b2c3d4e5f",
  "url": "https://api-dev.example/v2/media/8d0f3c2e-6a1b-4c7d-9e2f-0a1b2c3d4e5f.webp"
}
```

`url` 是绝对地址，可直接显示。同一个 `Idempotency-Key` 同一张图重传返回同一对象；换了图 409 `IDEMPOTENCY_CONFLICT`。和头像 / 社区 logo 上传共享每分钟 6 次（429 `RATE_LIMITED`）。上传后 24 小时内要用在 `POST /v2/feedback` 里。

### 1.2 `POST /v2/feedback`

```json
{
  "category": "bug",
  "body": "个人主页净值显示 $0",
  "mediaIds": ["8d0f3c2e-6a1b-4c7d-9e2f-0a1b2c3d4e5f"],
  "context": {
    "appVersion": "1.4.0",
    "build": "57",
    "platform": "ios",
    "osVersion": "27.0",
    "deviceModel": "iPhone17,1",
    "route": "/me",
    "locale": "zh-CN"
  }
}
```

- `category`：`bug` | `suggestion` | `other`（其他值 400）。
- `body`：必填，trim 后 1–2000 字。
- `mediaIds`：可选，≤ 4，顺序即展示顺序。
- `context`：可选；只保留上面七个键（值为字符串，`build` 也可以发整数），其他键被丢弃。

`201`（同键重放 `200`，内容相同）：

```json
{
  "feedback": {
    "id": "0b6a7f8e-2c1d-4e3f-8a9b-1c2d3e4f5a6b",
    "status": "open",
    "createdAt": "2026-11-02T08:00:00.000Z"
  }
}
```

### 1.3 `GET /v2/feedback/mine?cursor=`

最新在前，每页 20 条；`nextCursor` 为 null 表示没有下一页（cursor 绑定当前账号）。

```json
{
  "items": [
    {
      "id": "0b6a7f8e-2c1d-4e3f-8a9b-1c2d3e4f5a6b",
      "category": "bug",
      "body": "个人主页净值显示 $0",
      "status": "open",
      "createdAt": "2026-11-02T08:00:00.000Z",
      "images": [
        "https://api-dev.example/v2/media/8d0f3c2e-6a1b-4c7d-9e2f-0a1b2c3d4e5f.webp"
      ]
    }
  ],
  "nextCursor": null
}
```

`status`：`open` | `triaged` | `resolved` | `wont_fix`。

### 1.4 App 端错误

| HTTP | code                             | detailsSafe                                                                                                       | 处理建议                       |
| ---- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 400  | `INVALID_REQUEST`                | —                                                                                                                 | 客户端 bug                     |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | —                                                                                                                 | 走登录刷新                     |
| 409  | `IDEMPOTENCY_CONFLICT`           | —                                                                                                                 | 换新 key 重新提交              |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED`     | —                                                                                                                 | 走 bootstrap                   |
| 422  | `VALIDATION_FAILED`              | `reasonCode` + `field`：`FEEDBACK_BODY_EMPTY` / `FEEDBACK_BODY_TOO_LONG` / `FEEDBACK_BODY_INVALID`（body）        | 表单提示                       |
| 422  | `VALIDATION_FAILED`              | `FEEDBACK_TOO_MANY_IMAGES` / `MEDIA_NOT_OWNED` / `FEEDBACK_MEDIA_IN_USE` / `FEEDBACK_MEDIA_DUPLICATE`（mediaIds） | 重新选图上传                   |
| 422  | `VALIDATION_FAILED`              | 上传：`MEDIA_TYPE_UNSUPPORTED` / `MEDIA_TOO_LARGE` / `MEDIA_DIMENSIONS_TOO_SMALL` / `MEDIA_DECODE_FAILED`         | 换图（HEVC 的 HEIC 请转 JPEG） |
| 429  | `RATE_LIMITED`                   | `FEEDBACK_DAILY_LIMIT`, `limit: 20`（提交）；上传无 reasonCode                                                    | 提示稍后再试                   |
| 503  | `CAPABILITY_UNAVAILABLE`         | `BETA_FEEDBACK_DISABLED`                                                                                          | 隐藏 / 禁用入口                |
| 503  | `CAPABILITY_UNAVAILABLE`         | `FEEDBACK_REPOSITORY_UNAVAILABLE`                                                                                 | 显示不可用，不显示空列表       |

### 1.5 unavailable 行为

服务端开关 `BETA_FEEDBACK_ENABLED`（默认 on）。关闭时三条路由都是 503 `BETA_FEEDBACK_DISABLED`；入口是否显示仍由 dart-define `LOOP_BETA_FEEDBACK` 决定，客户端收到该错误时应显示「不可用」，不得显示提交成功。

## 2. 后台（loop-admin）

- Base URL：`{ADMIN_API_BASE}/admin/v1`，会话 cookie；无 `X-Loop-Contract-Version`、无 Bearer。响应 `Cache-Control: no-store`。
- 权限：读 = platform_admin、auditor、reviewer；改 = platform_admin、reviewer；testnet_acceptor 403。

### 2.1 `GET /admin/v1/feedback?status=&category=&limit=&cursor=`

`status`、`category` 可选；`limit` 1–100（默认 20），不可与 `cursor` 同给；`cursor` 绑定 status / category，换筛选后作废（400）。最新在前。

```json
{
  "items": [
    {
      "id": "0b6a7f8e-2c1d-4e3f-8a9b-1c2d3e4f5a6b",
      "accountId": "6d12a86e-4134-47e6-9312-c5ef75a30f55",
      "account": { "loopId": "LOOP-EYMVEN8N", "displayName": "Dd" },
      "category": "bug",
      "body": "个人主页净值显示 $0",
      "status": "open",
      "adminNote": null,
      "images": ["https://api-dev.example/v2/media/8d0f….webp"],
      "context": {
        "appVersion": "1.4.0",
        "build": "57",
        "platform": "ios",
        "route": "/me"
      },
      "createdAt": "2026-11-02T08:00:00.000Z",
      "updatedAt": "2026-11-02T08:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

`account.loopId` / `account.displayName` 可能为 null（账号没有 LOOP ID / 没有资料）。`context` 只含客户端发来的那几个键。

### 2.2 `GET /admin/v1/feedback/{feedbackId}`

`{ "feedback": { …同上一项… } }`；不存在 404 `NOT_FOUND`（`FEEDBACK_NOT_FOUND`）。

### 2.3 `PATCH /admin/v1/feedback/{feedbackId}`

```json
{ "status": "triaged", "adminNote": "已复现，S333 跟进" }
```

至少一个键；`adminNote: null` 或空串清空，≤ 1000 字（超长 422 `FEEDBACK_ADMIN_NOTE_TOO_LONG`）。

```json
{
  "feedback": { "…": "同上，已更新" },
  "audit": { "auditId": "…", "seq": 1234, "at": "2026-11-02T09:00:00.000Z" }
}
```

审计动作 `beta_feedback.update`（目标 `beta_feedback`），可在审计页按动作过滤。

### 2.4 后台错误

401 `ADMIN_SESSION_REQUIRED`；403（权限不足 / 需改密）；400 `INVALID_REQUEST`；404 `NOT_FOUND`；422 `VALIDATION_FAILED`；503 `CAPABILITY_UNAVAILABLE`（`FEEDBACK_REPOSITORY_UNAVAILABLE`，无数据库）。后台不受 `BETA_FEEDBACK_ENABLED` 影响。
