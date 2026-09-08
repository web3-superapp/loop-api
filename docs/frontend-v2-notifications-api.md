# 前端联调：V2 价格提醒、上下文通知与通知设置（S5b / D14）

本文是 `notifications` 模块（决策 0034）的前端交接契约。权威机器契约为
`openapi/loop-api.v2.json`。通用规则沿用 `docs/frontend-v2-session-api.md` 与
`docs/api-v2-conventions.md`。

覆盖页面：`alerts`、`notif-settings`，以及 Token 页 / alerts 页内的上下文通知入口。
**没有独立通知中心，没有推送。**

## 1. 启用条件与 capability

- 后端 `V2_MODULES_ENABLED` 必须包含 `notifications`。未启用时所有路径 `404 NOT_FOUND`。
- `GET /v2/meta/capabilities`：

| capabilityId        | `available` 条件                                          | 说明                                                        |
| ------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| `priceAlerts`       | 模块启用 + V2 alert 仓储 + registry + cursor 密钥         | `alerts` 页可用                                             |
| `notificationsFeed` | 模块启用 + 通知仓储 + cursor 密钥                         | feed / 已读 / 通知设置可用                                  |
| `pushNotifications` | **恒 `unavailable`**，`reasonCode: PUSH_RUNTIME_DEFERRED` | 没有 FCM/APNs；原型"需要系统通知权限"卡片改为"推送尚不可用" |

## 2. Headers

| 接口                                                                | 必带                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 所有 GET                                                            | Bearer、`X-Loop-Contract-Version: 2.0`、`X-Loop-Client-Version`            |
| `POST /v2/alerts`、`POST …/read`                                    | 以上 + `Idempotency-Key`（UUIDv4，每个逻辑操作一个）                       |
| `PUT /v2/alerts/{id}`、`DELETE`、`PUT /v2/notification-preferences` | 以上，**不带** `Idempotency-Key`（带了 → `400`），靠 `expectedVersion` CAS |

## 3. 价格提醒资源

```json
{
  "alert": {
    "alertId": "0b2c1d3e-…",
    "assetId": "eip155:56:0xbb4c…",
    "asset": {
      "symbol": "WBNB",
      "name": "Wrapped BNB",
      "decimals": 18,
      "status": "pending"
    },
    "condition": "at_or_above",
    "threshold": "800.5",
    "expiresAt": null,
    "state": "active",
    "triggeredAt": null,
    "lastEvaluatedAt": "2026-09-08T07:31:30.000Z",
    "delivery": {
      "status": "unavailable",
      "reasonCode": "PUSH_RUNTIME_DEFERRED"
    },
    "version": 1,
    "createdAt": "…",
    "updatedAt": "…"
  },
  "contractVersion": "2.0"
}
```

- `condition`：`above | at_or_above | below | at_or_below`，对比的是 DexScreener
  以该资产为 base 的最深交易对的 `priceUsd`（USD）。
- `threshold` 是正十进制字符串（最多 18 位小数）；`"0"`、负数 → `422 VALIDATION_FAILED`；
  科学计数法 → `400`。
- `state`：`active`（等待评估）/ `triggered`（已触发一次，**一次性**，`PUT` 后重新变为
  `active`）/ `expired`（过了 `expiresAt` 未触发，只读投影）。
- `lastEvaluatedAt: null` 表示评估器还没看过这条（评估器是后端 worker 的开关
  `ALERT_EVALUATOR_ENABLED`，客户端不可见）。原型"距目标 +22%"由前端用当前价格
  （`GET /v2/market/assets/{assetId}`）本地计算。
- `asset: null` 表示资产已不可读。

### 接口

| 方法   | 路径                                    | 请求                                                            | 响应                                        |
| ------ | --------------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| GET    | `/v2/alerts?cursor\|limit`              | `limit` 1–50（默认 25）与 `cursor` 互斥                         | `{items, nextCursor, contractVersion}`      |
| POST   | `/v2/alerts`                            | `Idempotency-Key`；`{assetId, condition, threshold, expiresAt}` | `201`（新建）/ `200`（同 key 同 body 重放） |
| GET    | `/v2/alerts/{alertId}`                  | —                                                               | envelope                                    |
| PUT    | `/v2/alerts/{alertId}`                  | `{expectedVersion, assetId, condition, threshold, expiresAt}`   | envelope（重新 arm）                        |
| DELETE | `/v2/alerts/{alertId}?expectedVersion=` | —                                                               | `204`（不存在/已删也 204，不枚举）          |

- POST 同 key 不同 body → `409 IDEMPOTENCY_CONFLICT`；`assetId` 不在 registry 或 blocked
  → `422 VALIDATION_FAILED`；`expiresAt` 不在未来 → `422 VALIDATION_FAILED`；
  非 56 链 → `422 CHAIN_MISMATCH`。
- PUT/DELETE `expectedVersion` 不符 → `409 VERSION_CONFLICT`（重新 GET 后再试）。

## 4. 触发与上下文通知

评估器只用 `quality: fresh` 的价格；stale/unavailable 的 tick 直接跳过，不触发。
触发后：alert → `triggered`，`price_alert_events` 记一条（含 `source`、`observedAt`），
并在 feed 里生成一条通知（同一 alert 在 1 小时去重窗口内只生成一条）。
用户在通知设置里关闭 `trade.priceAlert` 时，事件仍记录，但**不生成通知**。

`GET /v2/notifications/feed?cursor|limit=1..50`：

```json
{
  "items": [
    {
      "notificationId": "1c3d…",
      "type": "trade.priceAlert",
      "entityRef": "priceAlert:0b2c1d3e-…",
      "contextRoute": "token",
      "contextParams": { "assetId": "eip155:56:0xbb4c…" },
      "payload": {
        "assetId": "eip155:56:0xbb4c…",
        "symbol": "WBNB",
        "condition": "at_or_above",
        "threshold": "700",
        "observedValue": "747.39",
        "source": "dexscreener",
        "observedAt": "2026-09-08T07:31:30.000Z"
      },
      "source": "dexscreener",
      "observedAt": "2026-09-08T07:31:30.000Z",
      "readAt": null,
      "createdAt": "2026-09-08T07:31:31.204Z"
    }
  ],
  "nextCursor": null,
  "unreadCount": 1,
  "push": { "status": "unavailable", "reasonCode": "PUSH_RUNTIME_DEFERRED" },
  "contractVersion": "2.0"
}
```

- 通知路由：`contextRoute` + `contextParams` 决定打开哪一页（新增 intent
  `priceAlertTriggered` → `token` 页，参数 `assetId`）。`entityRef` 用于在 alerts 页
  高亮对应提醒（`priceAlert:<alertId>`）。
- `payload` 只有字符串（或 null），是展示事实；`observedValue` 是触发时的价格，
  `source/observedAt` 必须一起显示。
- 原型 alerts 页"触发历史"= feed 中 `type === "trade.priceAlert"` 的条目。
- `POST /v2/notifications/{notificationId}/read`（`Idempotency-Key` 必带，操作天然幂等，
  重复调用返回同一 `readAt`）→ `{notification, contractVersion}`；不属于本账号 → `404`。

## 5. 通知设置（十类）

`GET /v2/notification-preferences`：

```json
{
  "version": 0,
  "updatedAt": null,
  "categories": {
    "mining.settlement": { "enabled": true, "locked": false },
    "mining.weight": { "enabled": true, "locked": false },
    "launch.round": { "enabled": true, "locked": false },
    "launch.graduation": { "enabled": true, "locked": false },
    "trade.result": { "enabled": true, "locked": false },
    "trade.priceAlert": { "enabled": true, "locked": false },
    "community.mention": { "enabled": true, "locked": false },
    "community.announcement": { "enabled": true, "locked": false },
    "community.all": { "enabled": false, "locked": false },
    "security.event": { "enabled": true, "locked": true }
  },
  "push": { "status": "unavailable", "reasonCode": "PUSH_RUNTIME_DEFERRED" },
  "contractVersion": "2.0"
}
```

- 默认（`version: 0`，从未写入）：除 `community.all` 外全开；`security.event` 恒开且 `locked`。
- 写入是**整体替换 + CAS**：

```http
PUT /v2/notification-preferences
{"expectedVersion": 0, "categories": { …十个键全部必填…, "security.event": true }}
```

- **`security.event` 的裁决是"拒绝"而不是"忽略"**：必须传且必须为 `true`；传 `false`
  → `400 INVALID_REQUEST`，整个请求不写入。UI 上该开关不可交互，提交时始终带 `true`。
- 少任何一个键 → `400`；`expectedVersion` 不符 → `409 VERSION_CONFLICT`；内容与当前
  完全一致的重试 → `200` 返回当前资源（不冲突）。
- `enabled` 只是意图：目前只影响 `trade.priceAlert` 是否生成 feed 通知；其余类别的
  生产者（挖矿、Launch、社区）尚未交付；推送恒不可用。

## 6. 错误码速查

| HTTP | code                             | 出现位置                                                                           |
| ---- | -------------------------------- | ---------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | 缺/多 `Idempotency-Key`、坏 cursor、`security.event=false`、缺类别、非法 threshold |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | Bearer                                                                             |
| 404  | `NOT_FOUND`                      | 模块未启用、未知 alert / notification                                              |
| 409  | `IDEMPOTENCY_CONFLICT`           | 同 key 不同 body 创建                                                              |
| 409  | `VERSION_CONFLICT`               | alert PUT/DELETE、通知设置 PUT                                                     |
| 422  | `VALIDATION_FAILED`              | 资产不在 registry / blocked、阈值非正、过期时间不在未来                            |
| 422  | `CHAIN_MISMATCH`                 | 非 `eip155:56`                                                                     |
| 503  | `CAPABILITY_UNAVAILABLE`         | cursor 密钥未配置 / 仓储不可用                                                     |
