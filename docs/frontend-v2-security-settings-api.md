# 前端联调：V2 设备 / 安全中心 / 设置 / 关于 / 客服（S8 / D20）

本文是 `security`、`settings`、`support` 模块与公共 `GET /v2/meta/about`
（决策 0037）的前端交接契约。权威机器契约为 `openapi/loop-api.v2.json`。通用
规则（Base URL、`X-Request-ID`、错误体七字段）沿用 `docs/frontend-v2-session-api.md`
与 `docs/api-v2-conventions.md`。

页面映射：`devices` → §2；`security` / `key-export` / `social-recovery` → §3；
`settings` → §4；`about` → §5；`support` → §6。

## 1. 启用条件、capability 与 headers

- 后端 `V2_MODULES_ENABLED` 需包含 `security`、`settings`、`support`。未启用时
  对应路径返回 `404 NOT_FOUND`（V2 错误体），`GET /v2/meta/capabilities` 里的
  同名 capability 为 `deferred`；启用但运行时未组装时为 `unavailable`
  （`SECURITY_RUNTIME_UNAVAILABLE` / `SETTINGS_RUNTIME_UNAVAILABLE` /
  `SUPPORT_RUNTIME_UNAVAILABLE`）。capability 列表现在有 **30** 项（新增
  `security`、`settings`、`support`），移动端枚举同步。
- **MFA / Passkey / 恢复密码 / 自动恢复 / 社交恢复 / 私钥导出不是 meta
  capability**，只从 `GET /v2/security/capabilities` 读（§3.1），六项恒
  `unavailable`。任何页面都不得本地模拟"已开启"。
- 读接口 headers：

```text
Authorization: Bearer <current Privy access token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: 1.0.0
```

- `GET /v2/devices` 额外可带 `X-Loop-Session-ID: <bootstrap 返回的 sessionId>`
  （只用来标记 `isCurrent`，不是凭证）。
- `POST /v2/devices/{sessionId}/revoke`、`POST /v2/devices/revoke-all` 用
  **logout 的整套 header**：以上三项 + `X-Loop-Platform: ios|android` +
  `X-Loop-Device-ID` + `X-Loop-Session-ID`（当前 session）+ `Idempotency-Key`
  （新 UUIDv4）。
- `PUT /v2/settings` **不接受** `Idempotency-Key`（带了 → `400`），靠
  `expectedVersion` CAS；可带 `X-Loop-Platform` / `X-Loop-Device-ID`。
- `POST /v2/support/tickets` 用 community 命令 header 集：读 header +
  `Idempotency-Key`（必带），`X-Loop-Platform` / `X-Loop-Device-ID` 可选。
- `GET /v2/meta/about` 公共，不需要任何 header。
- 所有响应 `Cache-Control: no-store`；未知 `X-Loop-*` header / query / body 字段
  一律 `400 INVALID_REQUEST`。

## 2. `GET /v2/devices` → `devices` 页

```json
{
  "devices": [
    {
      "sessionId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      "deviceId": "2d4e3f50-6b7c-4d8e-8f90-1b2c3d4e5f60",
      "platform": "ios",
      "clientVersion": "1.0.0",
      "status": "active",
      "authStrength": "providerAuthenticated",
      "isCurrent": true,
      "createdAt": "2026-09-08T20:00:00.000Z",
      "lastSeenAt": "2026-09-08T20:00:00.000Z",
      "revokedAt": null
    }
  ],
  "currentSessionId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  "riskSignals": {
    "newSessions24h": 1,
    "highRiskNewDevice": false,
    "policy": {
      "configVersion": "deviceRiskV1",
      "windowHours": 24,
      "newSessionThreshold": 2
    }
  },
  "revokeAll": {
    "status": "unavailable",
    "reasonCode": "AUTH_STEP_UP_REQUIRED"
  },
  "truncated": false,
  "observedAt": "2026-09-09T02:00:00.000Z",
  "contractVersion": "2.0"
}
```

- 最新在前，`active` 排在 `revoked` 前，最多 100 条（`truncated: true` 表示
  被截断）；没有 cursor。
- `isCurrent` 只有在请求带了 `X-Loop-Session-ID` 且匹配时为 `true`；不带时
  `currentSessionId: null`、全部 `false`——前端应始终带上。
- `lastSeenAt` 是 bootstrap 观测时间（决策 0027），**不是**持续活跃时间；原型
  的"上海 · 今天 09:41"里的地理位置没有后端来源，不渲染。设备名称也没有后端
  字段，用 `platform` + `clientVersion` 展示。
- `riskSignals.highRiskNewDevice`：24h 内新建 session ≥ 2（阈值随 `policy`
  下发，不要写死）。只做提示，后端不强制 MFA / 冷却。
- `revokeAll` 恒 `unavailable`：原型"下线所有其他设备"按钮显示为需要二次验证、
  不可执行。

### 撤销单台设备

```http
POST /v2/devices/{sessionId}/revoke
```

- 200 → `{"session": {"sessionId", "status": "revoked", "revokedAt"}, "contractVersion": "2.0"}`。
- 目标 = 当前 session（header `X-Loop-Session-ID`）→ `403 AUTH_STEP_UP_REQUIRED`
  （MFA 未接，恒返回；本机退出仍走 `POST /v2/session/logout`）。
- 不存在 / 不属于本账号 → `404 SESSION_NOT_FOUND`（不可枚举）。
- 同 key 重放 → 200 且 `revokedAt` 相同；同 key 不同目标 → `409 IDEMPOTENCY_CONFLICT`。
- 已撤销的 session 再撤销 → 200（幂等）。
- 配额：与 logout 共用每账号每 24h 40 次命令 → `429 RATE_LIMITED`。

`POST /v2/devices/revoke-all` 恒 `403 AUTH_STEP_UP_REQUIRED`，不写任何东西。

## 3. 安全中心

### 3.1 `GET /v2/security/capabilities` → `security` / `key-export` / `social-recovery` / `wallet-recovery` 说明

```json
{
  "items": [
    {
      "capabilityId": "mfa",
      "status": "unavailable",
      "reasonCode": "PRIVY_MFA_EVIDENCE_PENDING",
      "evidence": {
        "status": "pending",
        "reasonCode": "PRIVY_MFA_EVIDENCE_PENDING"
      },
      "guideKey": "security.capability.mfa.howToEnable"
    }
  ],
  "contractVersion": "2.0"
}
```

固定六项、固定顺序：`mfa`、`passkey`、`recoveryPassword`、`autoRecovery`、
`socialRecovery`、`keyExport`，reasonCode 为 `PRIVY_<X>_EVIDENCE_PENDING`。
前端只展示"未开启 + 原因 + `guideKey` 对应的如何开启说明"；`key-export` 页
只有说明与**不可执行**按钮；`social-recovery` 页只有 2-of-3 说明 + unavailable，
不渲染守护人列表。原型里的"已开启 / 3 项保护已开启 / 已导出态"在本步都不存在。

### 3.2 `GET /v2/security/summary` → `security` 页汇总

```json
{
  "devices": {
    "status": "available",
    "deviceCount": 2,
    "activeSessionCount": 2,
    "newSessions24h": 1,
    "highRiskNewDevice": false,
    "policy": {
      "configVersion": "deviceRiskV1",
      "windowHours": 24,
      "newSessionThreshold": 2
    }
  },
  "approvals": {
    "status": "available",
    "walletId": "5a716283-…",
    "activeCount": 3,
    "unlimitedCount": 1,
    "freshness": {
      "indexerBlockNumber": "120659683",
      "headBlockNumber": "120661145",
      "observedAt": "2026-09-09T02:00:00.000Z"
    }
  },
  "notifications": {
    "securityEvents": {
      "category": "security.event",
      "enabled": true,
      "locked": true
    }
  },
  "recentSecurityEvents": { "status": "available", "items": [] },
  "observedAt": "2026-09-09T02:00:00.000Z",
  "contractVersion": "2.0"
}
```

- 没有评分、没有"GOOD"徽章；每块只有 `available` 或
  `{status: "unavailable", reasonCode}`。
- `devices`：`deviceCount` = 有活跃 session 的不同 `deviceId` 数。
- `approvals`：复用 S6 `GET /v2/approvals` 的 `summary`，取账号**活跃钱包**。
  unavailable 的 reasonCode：`SEND_APPROVALS_RUNTIME_DEFERRED`（模块未启用）、
  `WALLET_INTENT_RUNTIME_UNAVAILABLE`（运行时未组装）、
  `WALLET_RUNTIME_UNAVAILABLE`、`WALLET_NOT_SELECTED`、以及 approvals 接口
  自己的错误码（`INDEXING_DELAYED`、`CAPABILITY_UNAVAILABLE` 等）。原型
  `wallet` 页"授权盘点"副标题的数字从这里取，unavailable 时不显示数字。
- `notifications.securityEvents` 恒 `enabled: true, locked: true`（与通知设置
  一致）。
- `recentSecurityEvents.items` = 最近 10 条 `type === "security.event"` 的通知，
  条目结构与 `GET /v2/notifications/feed` 相同。本步唯一生产者是撤销他人设备：
  `entityRef: deviceSession:<sessionId>`、`contextRoute: devices`、
  `contextParams.sessionId`、`payload.event: session_revoked`（含
  `deviceId`/`platform`/`revokedAt`/`revokedFromSessionId`），同一 session 同一
  UTC 日只有一条；没有撤销过则为空数组（空态，不是 unavailable）。

## 4. `GET/PUT /v2/settings` → `settings` 页

```json
{
  "settings": { "displayCurrency": "USD", "language": "zh-CN" },
  "version": 0,
  "updatedAt": null,
  "policy": {
    "configVersion": "accountSettingsV1",
    "fixed": { "displayCurrency": "USD", "language": "zh-CN" },
    "localOnly": ["reduceMotion", "theme"]
  },
  "contractVersion": "2.0"
}
```

- 两个值在本步是**固定常量**、只读；`version 0` 表示还没有行（读不写）。
- `PUT` body：`{"expectedVersion": <当前 version>, "settings": {"displayCurrency": "USD", "language": "zh-CN"}}`。
  - `expectedVersion` = 当前版本 → 200，版本 +1；
  - `expectedVersion` = 当前版本 − 1（丢响应重试）→ 200，返回已提交资源；
  - 其他 → `409 VERSION_CONFLICT`，重新 GET 后再试；
  - 任何非固定值（如 `"EUR"`）→ `422 VALIDATION_FAILED`；
  - 未知字段（`reduceMotion`、`theme`）→ `400 INVALID_REQUEST`——这两项按
    `policy.localOnly` 留在本地。
- 页面其他行（网络、通知、隐私、安全、帮助、关于）是入口；退出登录走
  `POST /v2/session/logout`；"数据用量"没有后端，本地或不渲染。

## 5. `GET /v2/meta/about` → `about` 页（公共，无 token）

```json
{
  "contractVersion": "2.0",
  "configVersions": [
    {
      "module": "productPolicy",
      "configVersion": "productPolicyV2.2026-09-01",
      "effectiveAt": "2026-09-01T00:00:00.000Z"
    },
    {
      "module": "clientPolicy",
      "configVersion": "productPolicyV2.2026-09-01",
      "effectiveAt": "2026-09-01T00:00:00.000Z"
    },
    {
      "module": "sessionPolicy",
      "configVersion": "sessionPolicyV1",
      "effectiveAt": null
    },
    {
      "module": "deviceRisk",
      "configVersion": "deviceRiskV1",
      "effectiveAt": null
    },
    {
      "module": "accountSettings",
      "configVersion": "accountSettingsV1",
      "effectiveAt": null
    },
    {
      "module": "support",
      "configVersion": "supportPolicyV1",
      "effectiveAt": null
    },
    {
      "module": "swapPolicy",
      "configVersion": "swapPolicyV1",
      "effectiveAt": null
    },
    {
      "module": "bscWriteCanary",
      "configVersion": "bscWriteCanaryV1",
      "effectiveAt": null
    }
  ],
  "termsGate": {
    "status": "unavailable",
    "requiredVersion": null,
    "reasonCode": "TERMS_POLICY_UNAVAILABLE"
  },
  "openSource": {
    "source": "docs/open-source-attribution.md",
    "summary": "This register covers …",
    "entries": [
      {
        "name": "Fastify",
        "version": "5.12.1",
        "purpose": "HTTP server and route lifecycle",
        "license": "MIT"
      }
    ]
  },
  "clientBuild": {
    "status": "local",
    "reasonCode": "CLIENT_BUILD_IS_DEVICE_LOCAL"
  }
}
```

- 客户端版本 / 构建号由 App 本地读取；服务端不下发、不比较。
- `termsGate` 与 `GET /v2/meta/client-policy` 同一联合；用户协议 / 隐私政策 /
  风险披露的文档 URL 本步**不下发**，原型的法务四行显示为"版本槽位 + unavailable"。
- `openSource.entries` 就是开源许可页的列表；`summary` 是摘要。
- `configVersions` 只展示，不要 pin。

## 6. 客服工单 → `support` 页

### `POST /v2/support/tickets`

```json
{ "category": "mining", "body": "为什么我的币没有权重" }
```

- `category` ∈ `account | security | wallet | trade | launch | mining | community | other`。
- `body`：去首尾空白后 1–2000 码点；含控制字符 / 双向控制 / 不可见格式字符
  或全空白 → `400 INVALID_REQUEST`；超 2000 码点 → `422 VALIDATION_FAILED`。
- `201` 新建；同 key 同 body 重放 → `200` 同一工单；同 key 不同 body →
  `409 IDEMPOTENCY_CONFLICT`；每账号每 24h 最多 20 张 → `429 RATE_LIMITED`。
- 带 `attachments` 字段 → `400`；附件功能恒 unavailable。

响应（创建与列表条目相同）：

```json
{
  "ticket": {
    "ticketId": "…",
    "category": "mining",
    "body": "为什么我的币没有权重",
    "status": "open",
    "createdAt": "…",
    "updatedAt": "…",
    "lastEventAt": "…",
    "events": [
      {
        "eventVersion": 0,
        "eventType": "created",
        "actor": "user",
        "note": null,
        "occurredAt": "…"
      }
    ]
  },
  "attachments": {
    "status": "unavailable",
    "reasonCode": "SUPPORT_ATTACHMENTS_UNAVAILABLE"
  },
  "policy": {
    "configVersion": "supportPolicyV1",
    "responseWindowHours": 24,
    "businessDaysOnly": true,
    "escalationChannel": "copy"
  },
  "contractVersion": "2.0"
}
```

- `status` 只由 Dev 脚本推进（`pnpm support:answer <ticketId> [note]` →
  `answered`；`--close` → `closed`），客服回复在 `events[].note`
  （`actor: "operator"`）。
- "工作日 24 小时内回复"用 `policy` 渲染；紧急升级入口是文案
  （`escalationChannel: "copy"`），没有独立通道。
- FAQ、官方社区入口是静态文案 / 已有 community 路由，无新接口。

### `GET /v2/support/tickets?limit=|cursor=`

`{"items": [ticket…], "nextCursor", "attachments", "policy", "contractVersion"}`；
最新在前；`limit` 1–50（默认 25）与 `cursor` 互斥；cursor 绑定账号/路由、600s
过期，坏 cursor → `400`；未配置 cursor secret → `503 CAPABILITY_UNAVAILABLE`。

## 7. 错误码速查

| HTTP | code                             | 出现位置                                                         | 前端动作                     |
| ---- | -------------------------------- | ---------------------------------------------------------------- | ---------------------------- |
| 400  | `INVALID_REQUEST`                | 未知字段/header、坏 cursor、不安全文本、CAS 带 `Idempotency-Key` | 修请求，不重试               |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | 缺失或无效 Bearer                                                | 重新走 Privy 登录            |
| 403  | `AUTH_STEP_UP_REQUIRED`          | 撤销当前 session、revoke-all                                     | 显示"需要二次验证（未开放）" |
| 404  | `NOT_FOUND`                      | 模块未启用                                                       | 整页 unavailable             |
| 404  | `SESSION_NOT_FOUND`              | 撤销不存在/他人 session                                          | 刷新列表                     |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED`     | 未 bootstrap                                                     | 先 bootstrap                 |
| 409  | `IDEMPOTENCY_CONFLICT`           | 同 key 不同内容                                                  | 换新 key                     |
| 409  | `VERSION_CONFLICT`               | settings CAS                                                     | 重新 GET 再提交              |
| 422  | `VALIDATION_FAILED`              | settings 非固定值、工单正文超长                                  | 提示用户                     |
| 429  | `RATE_LIMITED`                   | 撤销命令 / 工单配额                                              | 稍后再试                     |
| 503  | `CAPABILITY_UNAVAILABLE`         | 仓库/cursor secret 未组装                                        | 整块 unavailable，可重试     |

## 8. 本步明确 unavailable 的产品项

| 项目                                                 | 来源 / reasonCode                                             |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| MFA、Passkey、恢复密码、自动恢复、社交恢复、私钥导出 | `GET /v2/security/capabilities`：`PRIVY_<X>_EVIDENCE_PENDING` |
| 撤销当前设备 / 下线所有设备                          | `AUTH_STEP_UP_REQUIRED`                                       |
| 设备名称、地理位置、持续活跃时间                     | 无后端字段，不渲染                                            |
| 安全评分 / "3 项保护已开启"                          | 不存在，不渲染                                                |
| 用户协议 / 隐私政策 / 风险披露 URL                   | `termsGate` 只有版本槽位                                      |
| 工单附件                                             | `SUPPORT_ATTACHMENTS_UNAVAILABLE`                             |
| 客服在线状态、社区成员数                             | 无后端字段（社区数据走 community 模块）                       |
| 数据用量、主题、reduceMotion                         | 本地（`policy.localOnly`）                                    |
