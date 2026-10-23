# 前端联调：V2 价格提醒、上下文通知与通知设置（S5b / D14）

本文是 `notifications` 模块（决策 0034）的前端交接契约。权威机器契约为
`openapi/loop-api.v2.json`。通用规则沿用 `docs/frontend-v2-session-api.md` 与
`docs/api-v2-conventions.md`。

覆盖页面：`alerts`、`notif-settings`，Token 页 / alerts 页内的上下文通知入口，
以及（决策 0177，S287）统一通知收件箱：见 §8。推送通道见 §7（决策 0067）：推送只是"指针"，
点击后必须重新认证并重新读取 feed，绝不能相信 payload 里的结论。

## 1. 启用条件与 capability

- 后端 `V2_MODULES_ENABLED` 必须包含 `notifications`。未启用时所有路径 `404 NOT_FOUND`。
- `GET /v2/meta/capabilities`：

| capabilityId        | `available` 条件                                         | 说明                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `priceAlerts`       | 模块启用 + V2 alert 仓储 + registry + cursor 密钥        | `alerts` 页可用                                                                                                                                                                              |
| `notificationsFeed` | 模块启用 + 通知仓储 + cursor 密钥                        | feed / 已读 / 通知设置可用                                                                                                                                                                   |
| `pushNotifications` | 模块启用 + push 仓储 + 已配置 Firebase 凭据（决策 0067） | `available` 时 `evidence.reasonCode = PUSH_DEVICE_DELIVERY_EVIDENCE_PENDING`（尚无真机送达证据）；否则 `unavailable` + `PUSH_RUNTIME_DEFERRED`，原型"需要系统通知权限"卡片显示"推送尚不可用" |

## 2. Headers

| 接口                                                                | 必带                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 所有 GET                                                            | Bearer、`X-Loop-Contract-Version: 2.0`、`X-Loop-Client-Version`                                         |
| `POST /v2/alerts`、`POST …/read`、`POST /v2/notifications/read-all` | 以上 + `Idempotency-Key`（UUIDv4，每个逻辑操作一个）                                                    |
| `PUT /v2/alerts/{id}`、`DELETE`、`PUT /v2/notification-preferences` | 以上，**不带** `Idempotency-Key`（带了 → `400`），靠 `expectedVersion` CAS                              |
| 所有写操作（可选）                                                  | `X-Loop-Platform: ios\|android`、`X-Loop-Device-ID`（UUIDv4）；存在即校验，格式错 → `400`；读接口不接受 |

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
- `threshold` **必须是 JSON 字符串**（正十进制，最多 18 位小数）：JSON 数字 → `400 INVALID_REQUEST`
  （服务端在类型强转前拒绝）；`"0"`、负数 → `422 VALIDATION_FAILED`；科学计数法 → `400`。
- 资产必须可定价：无 DexScreener 主对的代币 → `422 VALIDATION_FAILED`；原生 BNB 允许，
  用 WBNB 代理价评估（触发通知 `payload.proxyAsset` = WBNB 的 assetId）；创建时 Provider
  不可达 → `503 CAPABILITY_UNAVAILABLE`（可重试）。
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
- **同内容重放短路在 CAS 之前**（S5 联调发现 3）：`PUT /v2/alerts/{id}` 的 body
  与当前定义完全一致且 alert 仍是 `active` 时，无论 `expectedVersion` 是多少都
  返回 `200` 与已提交的 alert（不重新 arm、版本不变）；只有 body 不同时才比较
  `expectedVersion`。这与 watchlist / 通知设置的幂等重放语义一致，前端不要把
  "同内容 + 旧版本 → 200" 当成异常。

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

- `push`（以及 alert 资源里的 `delivery`）有两种状态：推送通道已组装时
  `{"status": "available", "reasonCode": null}`，否则
  `{"status": "unavailable", "reasonCode": "PUSH_RUNTIME_DEFERRED"}`。两种状态下
  feed 都是权威记录。
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
- `enabled` 影响两件事：是否生成 feed 通知，以及（决策 0067）是否发送对应的推送。
  目前有生产者的类别是 `trade.priceAlert`、`community.announcement`（语音房开播）与
  `security.event`；其余类别（挖矿、Launch、trade.result、community.mention/all）
  的生产者尚未交付。`security.event` 强制发送，不受偏好影响。

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

## 7. 推送通道（决策 0067）

### 7.1 注册与注销

Base URL 与 headers 同 `docs/frontend-v2-session-api.md`。两个写接口都属于
`security` 模块的 `/v2/devices` 家族，都要求**登出头集合**：Bearer、
`X-Loop-Contract-Version: 2.0`、`X-Loop-Client-Version`、`X-Loop-Platform`、
`X-Loop-Device-ID`、`X-Loop-Session-ID`、`Idempotency-Key`（UUIDv4）。

```http
POST /v2/devices/push-token
{"platform": "ios", "token": "<FCM registration token>", "appVersion": "1.2.3"}
```

```json
{
  "registered": true,
  "pushTokenId": "5a716283-…",
  "platform": "ios",
  "provider": "fcm",
  "appVersion": "1.2.3",
  "observedAt": "2026-09-22T02:00:00.000Z",
  "contractVersion": "2.0"
}
```

```http
DELETE /v2/devices/push-token
```

```json
{
  "registered": false,
  "revokedAt": "2026-09-22T02:10:00.000Z",
  "observedAt": "2026-09-22T02:10:00.000Z",
  "contractVersion": "2.0"
}
```

规则：

- **Android 与 iOS 都上报 FCM registration token**。iOS 不要上报 APNs device
  token：APNs key 已上传到同一个 Firebase 项目，由 FCM 代发。
- `platform` 必须与 `X-Loop-Platform` 一致，不一致 → `400 INVALID_REQUEST`。
  `appVersion` 是 semver2（与 `X-Loop-Client-Version` 同格式）。
- token 绑定当前 device session。**同一 session 重发同一 token → 同一
  `pushTokenId`**（只刷新 `observedAt`）；换 token 或同一 token 换 session 会
  作废旧行并返回新的 `pushTokenId`。
- 登出、远程撤销该 session 时，token 在同一事务里失效，**不需要客户端再调
  `DELETE`**。重新登录后必须重新注册。
- token 永远不会被任何接口回显。
- `DELETE` 是幂等的：该 session 没有 token 时也返回 `200`，`revokedAt: null`。
  即使推送不可用，`DELETE` 也始终可用。

### 7.2 推送 payload（data 字段）

只有四个键，**没有金额、地址、ticker、余额、验证码、聊天正文、社区名**：

| 键             | 值                                                                                                                                                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`         | `price_alert_triggered` / `security_event` / `community_voice_room_started` / `community_application_verified` / `community_application_rejected`；决策 0177 新增（仅 `NOTIFICATION_INBOX_EMIT=on`）：`launch_graduated` / `launch_badge_minted` / `social_friend_request` / `social_friend_accepted` |
| `entityRef`    | `<类型>:<UUID>`，如 `priceAlert:…`、`deviceSession:…`、`voiceRoom:…`、`community:…`；新增 `launch2Instance:…`、`friendRequest:…`                                                                                                                                                                      |
| `contextRoute` | `token` / `devices` / `voice-room` / `community-profile`；新增 `launch2-instance` / `dm-requests` / `user-profile`                                                                                                                                                                                    |
| `eventVersion` | `"1"`                                                                                                                                                                                                                                                                                                 |

可见文案由客户端用本地化 key 渲染（`push.priceAlertTriggered.title/body`、
`push.securityEvent.*`、`push.communityVoiceRoomStarted.*`），服务端不下发任何
展示文案。iOS 下发的 `title-loc-key` / `loc-key` 是点号原样；Android 的
`title_loc_key` / `body_loc_key` 是同一组键的下划线拼写（`push_priceAlertTriggered_title`
等），因为 Android 资源名不允许点号。

**点击处理**：重新认证 → 用 `contextRoute` 打开对应页面 → 重新读取
`GET /v2/notifications/feed` 与该页面的权威接口。不得把 payload 当成结果。

### 7.3 事件字典（第一批）

| `type`                           | 触发                                                                                                        | 偏好类别                 | 可关 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------ | ---- |
| `price_alert_triggered`          | 价格提醒被评估器触发且写入了 feed 通知                                                                      | `trade.priceAlert`       | 是   |
| `security_event`                 | 新设备登录、远程撤销设备会话                                                                                | `security.event`         | 否   |
| `community_voice_room_started`   | 社区语音房开播（房主自己不收）                                                                              | `community.announcement` | 是   |
| `community_application_verified` | 运营通过了你创建的社区申请（决策 0073）；`entityRef: community:<id>`，`contextRoute: community-profile`     | `community.announcement` | 是   |
| `community_application_rejected` | 运营驳回了你创建的社区申请（决策 0073）；原因只在 feed 行与社区详情里，不在推送里                           | `community.announcement` | 是   |
| `launch_graduated`               | 决策 0177：你持有（曲线净买入或勋章）或发起的 MEME v2 项目毕业；`launch2Instance:<id>` → `launch2-instance` | `launch.graduation`      | 是   |
| `launch_badge_minted`            | 决策 0177：你的共识勋章铸造上链；`launch2Instance:<id>` → `launch2-instance`                                | `launch.round`           | 是   |
| `social_friend_request`          | 决策 0177：有人向你发送好友申请；`friendRequest:<id>` → `dm-requests`                                       | `community.mention`      | 是   |
| `social_friend_accepted`         | 决策 0177：对方接受了你的好友申请；`friendRequest:<id>` → `user-profile`                                    | `community.mention`      | 是   |

社区申请结果的 feed 行（`type: community.announcement`，`payload.event =
 community.application.verified|rejected`，含 `communityId`、`communityName`、`reviewedAt`、
`reason`）**不受偏好开关影响**，只有推送受 `community.announcement` 门控；见
`docs/frontend-v2-community-api.md` §7。`payload` 值上限从 256 放宽到 512 字符以容纳
280 码点的驳回原因。

### 7.4 送达语义

- **一个事件对一台设备最多一次**，永久去重；重复不会补发。
- 每台设备每小时上限：可选类事件 20 条、强制类（安全）10 条，两个额度**分开计算**，
  安全事件不会被其他推送挤掉。
- 语音房开播的受众上限 200 台设备，超出会被截断（服务端记日志）。
- Provider 判定 token 失效（`UNREGISTERED` / 400）时后端自动作废该 token 行；
  客户端下次启动重新注册即可。
- 瞬时失败不重试：feed 里已经有这条记录，**不会**出现同一事件推送两次。

### 7.5 推送相关错误码

| HTTP | code                             | 出现位置                                                                                                                            |
| ---- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | body 缺键/多键、`platform` 与 header 不一致、token 太短或含非法字符、`appVersion` 非 semver、`DELETE` 带 body、缺 `Idempotency-Key` |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | Bearer 缺失或无效；`X-Loop-Session-ID` 指向已撤销 session 时也是 `AUTH_INVALID`                                                     |
| 404  | `SESSION_NOT_FOUND`              | `X-Loop-Session-ID` 不是本账号的活跃 session，或 header 里的设备/平台与该 session 记录不符                                          |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED`     | 尚未 bootstrap                                                                                                                      |
| 409  | `IDEMPOTENCY_CONFLICT`           | 同 `Idempotency-Key` 换了 body                                                                                                      |
| 409  | `VERSION_CONFLICT`               | `X-Loop-Contract-Version` 不是 `2.0`                                                                                                |
| 503  | `CAPABILITY_UNAVAILABLE`         | **未配置 Firebase 凭据**（`detailsSafe.reasonCode = PUSH_RUNTIME_DEFERRED`）或 push 仓储不可用；只影响 `POST`，`DELETE` 不受影响    |

### 7.6 unavailable 行为（前端必须实现）

| 情况                              | 表现                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pushNotifications` ≠ `available` | 不调用 `POST /v2/devices/push-token`；`notif-settings` 顶部显示"推送尚不可用"，开关仍可改（只影响 feed） |
| `POST` 返回 503                   | 不重试注册，不提示"已开启推送"；按 unavailable 处理                                                      |
| 系统通知权限被拒                  | 不注册 token；引导系统设置，不伪造已注册状态                                                             |
| 登出 / 会话被撤销                 | 本地丢弃 token，重新登录后重新注册                                                                       |

## 8. 通知收件箱（决策 0177，S286 / 客户端 S287）

Base URL、headers、模块开关与 capability（`notificationsFeed`）同 §1–§2。收件箱就是
`GET /v2/notifications/feed`（分页、游标、`unreadCount`、`readAt` 都不变），加两条新路由与
四种新事件。

### 8.1 新事件（feed `type` 新值）

| feed `type`              | 偏好类别（`notif-settings` 开关管推送） | `entityRef`                    | `contextRoute`     | `contextParams`       | `payload` 键                                                                                     |
| ------------------------ | --------------------------------------- | ------------------------------ | ------------------ | --------------------- | ------------------------------------------------------------------------------------------------ |
| `launch.graduated`       | `launch.graduation`                     | `launch2Instance:<instanceId>` | `launch2-instance` | `{ instanceId }`      | `event, title, body, instanceId, projectName, graduatedAt, officialPoolId`（后者可为 null）      |
| `launch.badge_minted`    | `launch.round`                          | `launch2Instance:<instanceId>` | `launch2-instance` | `{ instanceId }`      | `event, title, body, instanceId, projectName, tokenId, mintedAt, transactionHash`                |
| `social.friend_request`  | `community.mention`                     | `friendRequest:<id>`           | `dm-requests`      | `{ friendRequestId }` | `event, title, body, friendRequestId, publicProfileId（申请人）, alias（申请人昵称，可为 null）` |
| `social.friend_accepted` | `community.mention`                     | `friendRequest:<id>`           | `user-profile`     | `{ publicProfileId }` | `event, title, body, friendRequestId, publicProfileId（接受人）, alias（可为 null）`             |

- 行的键集合不变（十个键，`readAt` 照旧）；只是 `type` 多了四个值。**客户端 codec 必须先接受这四个值**，
  未知 `type` 建议按"通用行"显示 `payload.title / payload.body` 而不是整页失败。
- `title` / `body` 是服务端写好的中文展示文案，直接显示；其余键是事实（时间为 ISO 8601 UTC，
  `tokenId` 为十进制字符串）。示例：

```json
{
  "notificationId": "5c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "type": "launch.graduated",
  "entityRef": "launch2Instance:3c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "contextRoute": "launch2-instance",
  "contextParams": { "instanceId": "3c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f" },
  "payload": {
    "event": "launch.graduated",
    "title": "Moon 已毕业",
    "body": "Moon 已于 2026-10-22 14:05（北京时间）毕业，交易已迁入官方池 0xabab…abab。",
    "instanceId": "3c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    "projectName": "Moon",
    "graduatedAt": "2026-10-22T06:05:00.000Z",
    "officialPoolId": "0xabab…（66 字符）"
  },
  "source": "launch2_indexer",
  "observedAt": "2026-10-22T06:05:00.000Z",
  "readAt": null,
  "createdAt": "2026-10-22T06:05:09.120Z"
}
```

- 路由：`launch2-instance` → `/launch2/instance?id=<instanceId>`；`dm-requests` → `/chat/requests`；
  `user-profile` → `/profile/user?id=<publicProfileId>`。
- 谁会收到：毕业 = 该项目曲线净买入 > 0 或持有勋章的钱包对应账号 + 项目方；勋章 = 铸造者；
  好友申请 = 被申请人；好友接受 = 申请人。拒绝不产生通知。只从上线后起算（不回填）；
  超过 24 小时才被索引到的链上事实不产生通知。

### 8.2 `GET /v2/notifications/unread-count`

读头（Bearer、`X-Loop-Contract-Version: 2.0`、`X-Loop-Client-Version`；不得带
`Idempotency-Key`、query、body）。

```json
{ "unread": 3, "observedAt": "2026-10-22T08:00:00.000Z" }
```

与 feed 的 `unreadCount` 同口径，适合 Tab 角标轮询。

### 8.3 `POST /v2/notifications/read-all`

写头（以上 + `Idempotency-Key` UUIDv4）；无 body、无 query。天然幂等：

```json
{ "marked": 3 }
```

重复调用返回 `{ "marked": 0 }`。单条已读仍用 `POST /v2/notifications/{id}/read`。

### 8.4 错误码

| HTTP | code                             | 出现位置                                                                         |
| ---- | -------------------------------- | -------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | 读接口带 `Idempotency-Key` / query；read-all 缺或非法 `Idempotency-Key`、带 body |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | Bearer 缺失或无效                                                                |
| 404  | `NOT_FOUND`                      | 模块未启用                                                                       |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED`     | 尚未 bootstrap                                                                   |
| 409  | `VERSION_CONFLICT`               | `X-Loop-Contract-Version` 不是 `2.0`                                             |
| 503  | `CAPABILITY_UNAVAILABLE`         | 通知仓储不可用                                                                   |

错误体只有 `code/category/retryable/userMessageKey/correlationId/detailsSafe/providerReferenceSafe`。

### 8.5 开关与 unavailable 行为

- 服务端 `NOTIFICATION_INBOX_EMIT`（默认 `off`）：`off` 时四种新事件照常写库，但 feed、`unreadCount`、
  `unread-count`、`read-all`、单条已读都**看不见**它们（单条已读返回 404），也不推送。新客户端在
  `off` 下照常工作（收件箱里只有老类型）。全部受支持版本能解码新 `type` 后服务端切 `on`，
  已写入的行立即出现。
- `notificationsFeed` ≠ `available`：收件箱入口显示不可用，不显示 0 角标。
- 推送（§7）：四个新推送事件的设备端本地化键 `push.launchGraduated.*`、`push.launchBadgeMinted.*`、
  `push.socialFriendRequest.*`、`push.socialFriendAccepted.*`（Android 下划线拼写）须在开关 `on` 前发版；
  router 需新增四个 type ↔ route 配对（`launch2Instance` → `launch2-instance`，`friendRequest` →
  `dm-requests` / `user-profile`）。推送仍是四键，点击后重读 feed 按 `type + entityRef` 找行。

## 9. 发射进度通知（决策 0178，S291 / 客户端 S292）

项目方（提交该项目、签名部署任务的账号）在审核 / 部署链路上收到四种通知。存储与读法同 §8：库里
`type` = `launch.round`（十类之一，决定推送开关），feed / 单条已读返回的 `type` = 细分事件。

| feed `type`（`eventType`） | 触发                                   | `title` / `body`                                                              | `entityRef`                 | `contextRoute`          | `contextParams`  | 推送 `type`              |
| -------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- | --------------------------- | ----------------------- | ---------------- | ------------------------ |
| `launch.review_approved`   | 发射配置审核通过（进入待签名）         | 「{项目名} 审核已通过」/「请完成签名，发射才会部署」                          | `launchProject:<projectId>` | `launch2-project-sign`  | `{ projectId }`  | `launch_review_approved` |
| `launch.review_rejected`   | 资料或配置被驳回                       | 「{项目名} 审核未通过」/ 驳回原因（审核员备注，否则原因码对应的中文）         | `launchProject:<projectId>` | `launch2-projects-mine` | `{ projectId }`  | `launch_review_rejected` |
| `launch.activated`         | 部署并激活成功、实例已登记             | 「{项目名} 已上链」/「YYYY-MM-DD HH:mm（北京时间）开售」或「已开售」          | `launch2Instance:<id>`      | `launch2-instance`      | `{ instanceId }` | `launch_activated`       |
| `launch.deploy_failed`     | 执行器部署 / 核验 / 激活失败且不再重试 | 「{项目名} 部署失败」/ 简短原因（按失败码，未知码「部署未完成，请联系平台」） | `launchProject:<projectId>` | `launch2-projects-mine` | `{ projectId }`  | `launch_deploy_failed`   |

`payload`（全部字符串）：`event`、`title`、`body`、`projectName`、`symbol`（有就带）、`taskId`（= 项目
ID，与 `projectId` 同值，即「我的项目」行与签名页的 `id`）、`projectId`；另：审核通过 / 配置驳回带
`configVersion`；驳回带 `reasonCode`、`reasonText`；激活带 `jobId`、`instanceId`、`saleStartAt`
（RFC 3339）；失败带 `jobId`、`failureCode`。

- 开关 `LAUNCH_REVIEW_INBOX_EMIT`（默认 `off`，API 与 worker 同时切）：`off` 时照常写库，但 feed、
  `unreadCount`、`unread-count`、`read-all`、单条已读都看不见这四种（单条已读 404），worker 不推送。
  与 `NOTIFICATION_INBOX_EMIT` 互相独立。
- 推送四键不变（`eventVersion: "1"`）；设备端本地化键 `push.launchReviewApproved.*`、
  `push.launchReviewRejected.*`、`push.launchActivated.*`、`push.launchDeployFailed.*`；router 新增
  `launchProject` → `launch2-project-sign` / `launch2-projects-mine`，`launch2Instance` → `launch2-instance`。
- `launch2-projects-mine` 是本契约的字面路由名（manifest slug 为 `launch2-projects`），客户端按字面匹配，服务端不改。
- 项目事件 `entityRef` 只发 `launchProject:<uuid>`，`contextParams.projectId` 必带；`launch.activated` 只发
  `launch2Instance:<uuid>`，`contextParams.instanceId` 必带。
