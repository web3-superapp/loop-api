# 前端联调：V2 通信（S4 / D7–D8）

本文是 `communication` 模块（决策 0032）以及 `community` 模块新增的 `chat` /
`voice` 字段的前端交接契约。权威机器契约为 `openapi/loop-api.v2.json`。通用
规则（Base URL、`X-Request-ID`、错误体七字段）沿用
`docs/frontend-v2-session-api.md` 与 `docs/api-v2-conventions.md`。

覆盖页面：`community-chat`、`dm`、`group`、`group-info`、`voiceroom`、
`voiceroom-full`。`chat-search`、`chat-forward`、`chat-merge-preview` 全部走
Stream SDK，本模块不提供接口；`community-ai` 全部 unavailable。
**任何位置都不得声明端到端加密。**

## 1. Base URL、启用条件与 headers

- Development：`https://api-dev.quant-dinger.cc`；本机 `http://127.0.0.1:3000`
  （或 `PORT` 指定端口）。
- 后端 `V2_MODULES_ENABLED` 必须同时包含 `community` 与 `communication`。未启用
  `communication` 时本文所有路径返回 `404 NOT_FOUND`（V2 错误体），且不会校验
  Bearer。
- 前端必须先读 `GET /v2/meta/capabilities`（现共 **31** 项；以 `openapi/loop-api.v2.json` 为唯一计数来源，不要写死）：

| capabilityId    | 期望                                                      | UI 含义                                                                                               |
| --------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `communityChat` | `available`（模块启用 + 仓储 + 社区运行时 + Stream 凭据） | 社区官方群、DM、小群可用                                                                              |
| `voiceRooms`    | `available`，但 `evidence.status` 恒为 `pending`          | **只要 `evidence.reasonCode` 是 `AUDIO_ROOM_USER_ROLE_EVIDENCE_PENDING`，语音房入口整页 unavailable** |

`availability: unavailable` + `COMMUNICATION_RUNTIME_UNAVAILABLE` 表示模块已
启用但依赖未配齐；`deferred` + `V2_COMMUNICATION_RUNTIME_DEFERRED` 表示模块未
启用。两种情况都不要调用本模块接口，也不要回退 fixture。

`voiceRooms.evidence` 是决策 0005 的前置证据位：后端契约与实现已就绪，但
Stream Dashboard 尚未导出「`audio_room` 的 `user` 角色不含 `create-call`」
的证据。在证据到位（后端把 `evidence.status` 改为 `notApplicable`）之前，
`voiceroom` / `voiceroom-full` 必须整页 unavailable 并解释原因，即使
`availability` 已是 `available`。

**角色映射（2026-09-08 修订，S4 BUG-03）**：LOOP 的 `role` 字段
（`host | speaker | listener`）是 LOOP 语义，**不等于 Stream call role**。
后端映射为：`listener → user`、`speaker → speaker`、`host → admin`
（Stream 应用没有 `admin` 角色时回退 `user` 并授予 `send-audio` / `mute-users`
/ `end-call`）。实测该 Dev 应用**没有** `listener` 这个 call role，所以 0005
的证据对象改成 `user` 角色。前端仍然只读 LOOP 的 `role`，不要自己推断 Stream
角色。

- 读接口 header：

```text
Authorization: Bearer <current Privy access token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: 1.0.0
```

- 写接口再带**恰好一个**规范小写 UUIDv4 `Idempotency-Key`。
- 读接口带 `Idempotency-Key` → `400 INVALID_REQUEST`；写接口缺失、重复或非规范
  UUIDv4 同样 `400`。未知 header / query / body 字段一律 `400 INVALID_REQUEST`。
- 所有响应 `Cache-Control: no-store`；错误体 `correlationId` 等于响应
  `X-Request-ID`。

## 2. Stream token（`community-chat` / `dm` / `group` / `voiceroom`）

```text
POST /v2/chat/token       # Stream Chat 用户 token
POST /v2/video/token      # Stream Video 用户 token
```

无 body、无 query，需要写接口 headers（含 `Idempotency-Key`）。成功 `200`：

```json
{
  "apiKey": "…",
  "token": "…",
  "expiresAt": "2026-09-08T02:00:00.000Z",
  "user": { "id": "loop_<32 hex>" },
  "contractVersion": "2.0"
}
```

- token 有效期固定 1 小时，服务端不缓存也不落库；前端不得持久化。
- `429 RATE_LIMITED`：命中每分钟的用户/IP 配额，按 `Retry-After` 语义退避。
- `503 CAPABILITY_UNAVAILABLE`：缺 Stream 凭据或持久化配额密钥 → 显示 unavailable。
- `/v1/chat/token` 与 `/v1/video/token` 保持冻结，两者解析到同一账号；新客户端
  只用 `/v2`。

## 3. DM 与小群（`dm` / `group` / `group-info`）

```text
POST   /v2/chat/direct-channels          {"targetPublicProfileId": "<uuid>"}
POST   /v2/chat/groups                   {"name": "…", "friendPublicProfileIds": ["<uuid>", …]}
GET    /v2/chat/operations/{operationId}
DELETE /v2/chat/groups/{groupId}/membership
```

- **好友关系（含 `message-requests accept` 产生的 friendship）是 DM 唯一准入。**
  非好友一律 `404 NOT_FOUND`（非枚举）。
- 小群 3–30 人：`friendPublicProfileIds` 传 2–29 个已接受好友，后端自动加上调用者。
- 两个写接口是**同一个 V1 持久操作状态机的 camelCase 投影**：

| 字段           | 取值                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| `operationId`  | 等于请求的 `Idempotency-Key`，所以首个响应丢失也能继续轮询                                  |
| `kind`         | `groupCreate` \| `directGetOrCreate`                                                        |
| `status`       | `pending` \| `submitting` \| `reconciling` \| `succeeded` \| `failed` \| `operatorRequired` |
| `terminal`     | 布尔                                                                                        |
| `retryAfterMs` | 非终态为正整数，终态为 `null`                                                               |
| `result`       | 成功时是群或 DM 结果，否则 `null`                                                           |
| `error`        | `failed` / `operatorRequired` 时是 `{code}`，否则 `null`                                    |

- 非终态返回 `202` + `Location: /v2/chat/operations/{operationId}` +
  `Retry-After`（秒）。终态与精确重放返回 `200`。
- `operatorRequired` 是**终态未决**，不是伪装的失败：不要重试，提示用户联系支持。
- 成功结果：

```json
{ "groupId": "<uuid>", "name": "…", "friendPublicProfileIds": ["<uuid>", …],
  "streamCid": "messaging:loop_group_<32 hex>" }
```

```json
{
  "targetPublicProfileId": "<uuid>",
  "streamCid": "messaging:loop_direct_<32 hex>"
}
```

- **退出小群**：`DELETE /v2/chat/groups/{groupId}/membership`，成功 `200`
  `{groupId, membership: null, contractVersion}`。后端先做 Stream `removeMembers`
  再提交本地删除；Stream 未知结果返回 `503 PROVIDER_DISCONNECTED` 且**不提交**，
  同一 key 重试是安全的：后端在 `prepare` 阶段就认领幂等记录，命中已提交的退群
  会只重放那一次 Stream 移除并返回 `200`，不会变成 `DATA_STALE`。群创建者不能
  退出（`403 PERMISSION_DENIED`）。
- `group-info` 的成员管理（踢人、改名）本步不做，显示 unavailable。

## 4. 社区官方群（`community-chat`）

`GET /v2/communities/{communityId}` 新增两段：

```json
{
  "chat": {
    "status": "available",
    "channelCid": "messaging:loop_community_<32 hex>",
    "memberState": "synced",
    "reasonCode": null
  },
  "voice": {
    "status": "available",
    "currentRoomId": "<uuid>",
    "reasonCode": null
  }
}
```

`chat.status` 有**三个**取值（2026-09-08 修订，此前只有两个）：
`available | syncing | unavailable`。只有在**官方频道已在 Stream 建好**且
**当前用户的频道成员状态是 `synced`** 时才是 `available`，也只有这一种状态带
`channelCid`。`syncing` 表示 LOOP 已经记录意图、Stream 侧还没跟上——请显示
「聊天权限同步中」并可轮询社区详情，**不要显示为不可用**。`unavailable` 表示
没有任何同步在进行中。

| `status`      | `reasonCode`                         | 含义与 UI                                                             |
| ------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `syncing`     | `COMMUNITY_CHANNEL_NOT_PROVISIONED`  | 社区已 verified、频道行与同步任务已入队，Stream 频道还没建好 → 同步中 |
| `syncing`     | `COMMUNITY_CHANNEL_MEMBER_SYNCING`   | 频道已建好，本人的成员同步在途 → 同步中                               |
| `unavailable` | `COMMUNITY_CHANNEL_NOT_PROVISIONED`  | 社区尚未 verified，压根没有频道 → 不可用                              |
| `unavailable` | `COMMUNITY_CHANNEL_CAPACITY_PENDING` | 频道已达 Stream 成员上限 → 不可用；LOOP 成员资格仍成立                |
| `unavailable` | `COMMUNITY_CHANNEL_PROVISION_FAILED` | 频道创建/同步终态失败 → 不可用，需运维介入                            |
| `unavailable` | `COMMUNITY_MEMBERSHIP_REQUIRED`      | 当前用户不是该社区非封禁成员                                          |
| `unavailable` | `VOICE_ROOM_RUNTIME_UNAVAILABLE`     | 后端通信运行时未组装 → 不可用                                         |

- `memberState` 取值 `synced | pending | removed | capacityPending | null`，
  仅用于文案区分，不要据此推断 Stream 事实。
- 加入社区 → 后端入队 `add`；退出/被封禁 → 入队 `remove`；**解封 → 入队
  `add`**（2026-09-08 修订：解封恢复成员资格，聊天权限随之恢复，用户不需要
  重新加入社区）。同步由独立 worker lane 在事务提交后执行。
- 拿到 `channelCid` 后用官方 `StreamChannel` 连接；LOOP 不提供消息、历史、
  已读、在线数接口。置顶公告、在线数在本步一律 unavailable。

## 5. 语音房（`voiceroom` / `voiceroom-full`）

```text
POST   /v2/communities/{communityId}/voice-rooms          # owner/admin 开房
GET    /v2/communities/{communityId}/voice-rooms/current  # 当前直播中的房间
GET    /v2/voice-rooms/{voiceRoomId}
GET    /v2/voice-rooms/{voiceRoomId}/hand-raises
POST   /v2/voice-rooms/{voiceRoomId}/join
POST   /v2/voice-rooms/{voiceRoomId}/leave
POST   /v2/voice-rooms/{voiceRoomId}/hand-raise
DELETE /v2/voice-rooms/{voiceRoomId}/hand-raise
POST   /v2/voice-rooms/{voiceRoomId}/speakers/{publicProfileId}   # host 邀请发言
DELETE /v2/voice-rooms/{voiceRoomId}/speakers/{publicProfileId}   # host 移出发言
POST   /v2/voice-rooms/{voiceRoomId}/mute-all                     # host
POST   /v2/voice-rooms/{voiceRoomId}/end                          # host
```

房间资源：

```json
{
  "room": {
    "voiceRoomId": "<uuid>",
    "communityId": "<uuid>",
    "callCid": "audio_room:loop_voice_<32 hex>",
    "state": "live",
    "provisionState": "provisioned",
    "backstage": true,
    "createdAt": "…",
    "endedAt": null
  },
  "viewer": {
    "role": "listener",
    "canInviteSpeakers": false,
    "canMuteAll": false,
    "canEndRoom": false,
    "handRaise": {
      "handRaiseId": "<uuid>",
      "sequence": "7",
      "state": "pending",
      "createdAt": "…"
    },
    "expiresAt": "…"
  },
  "participants": {
    "speakerCount": 3,
    "listenerCount": 42,
    "observed": { "status": "available", "memberCount": 45, "observedAt": "…" }
  },
  "providerSync": { "status": "confirmed", "reasonCode": null },
  "contractVersion": "2.0"
}
```

规则：

- **权限**：只有 `viewer.role === "host"` 才渲染邀请/移出发言、全体静音、结束
  房间。后端同样只接受 host；非 host 一律 `403 PERMISSION_DENIED`。owner 或
  admin 才能开房。
- **`provisionState`**：只有 `provisioned` 才能 `join`；`pending` /
  `reconciling` / `failed` 时 `join` 返回 `503 CAPABILITY_UNAVAILABLE`。
- **`join` 幂等**：已在房间内会返回当前角色，不会报错。`expiresAt` 是本次入场
  授权到期时间；到期前用 `POST /v2/video/token` 换新 token 并重新 `join`。
- **举手队列**：`sequence` 是 PostgreSQL 在房间行锁内分配的**十进制字符串**
  （绝不是 JS number），全序无重复。每人同一时刻只能有一个 `pending` 举手；
  重复举手返回 `409 DATA_STALE`。host 邀请发言会把该用户的 pending 举手置为
  `invited`。
- **人数**：`speakerCount` / `listenerCount` 是 LOOP 的**角色意图**投影（来自
  `voice_room_members`），**不是 Stream 在线人数**；
  `participants.observed` 是只读 Stream 投影，必须带 `observedAt` 展示。读不到
  时是 `{status:"unavailable", reasonCode:"STREAM_PARTICIPANT_COUNT_NOT_OBSERVED"}`，
  不要显示 0。后端最多翻 10 页（每页 100）累加；仍未翻完时同样返回 unavailable，
  绝不发布被截断的总数。
- **`providerSync`**：`confirmed` 表示这次命令的那一次 Stream 写入被确认；
  `unconfirmed` 表示 LOOP 侧已提交但 Provider 事实未确认（`reasonCode` 形如
  `STREAM_CALL_MUTE_UNCONFIRMED`）。**不要把 LOOP 提交当成 Provider 事实。**
  用同一个 `Idempotency-Key` 重放会跳过本地变更、只重试那一次 Provider 调用。
- **房间结束后所有写操作返回 `409 DATA_STALE`。** 一个社区同时只能有一个
  `live` 房间；重复开房返回 `409 RESOURCE_CONFLICT`。
- `GET .../voice-rooms/current` 在没有直播时返回
  `{current: null, reasonCode: "COMMUNITY_VOICE_ROOM_NOT_LIVE", contractVersion}`。

## 6. 错误码对照

| HTTP | code                             | 场景                                                            |
| ---- | -------------------------------- | --------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | header/query/body 违规，`Idempotency-Key` 不是规范 UUIDv4       |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | 缺少或无效 Privy Bearer                                         |
| 403  | `PERMISSION_DENIED`              | 非 host 的房间控制、非成员读房、创建者退群、非 owner/admin 开房 |
| 404  | `NOT_FOUND`                      | 模块未启用、房间/群/操作不存在或不属于调用者、非好友目标        |
| 409  | `DATA_STALE`                     | 已结束房间的写操作、重复举手、取消不存在的举手、非法角色迁移    |
| 409  | `IDEMPOTENCY_CONFLICT`           | 同一 key 配不同请求内容                                         |
| 409  | `PROFILE_ACTIVATION_REQUIRED`    | 账号没有激活的 V2 profile                                       |
| 409  | `RESOURCE_CONFLICT`              | 社区已有 `live` 语音房                                          |
| 429  | `RATE_LIMITED`                   | Stream token 配额                                               |
| 503  | `CAPABILITY_UNAVAILABLE`         | 模块/仓储/Stream 凭据缺失，或房间未 provisioned                 |
| 503  | `PROVIDER_DISCONNECTED`          | 退群时 Stream 移除结果未知（未提交，可安全重试）                |

错误体固定七字段：`code`、`category`、`retryable`、`userMessageKey`、
`correlationId`、`detailsSafe`、`providerReferenceSafe`。`detailsSafe` 与
`providerReferenceSafe` 恒为 `null`。

## 7. 本步不提供的能力

- 聊天搜索、转发、合并长图：全部走 Stream SDK（`client.search`、
  `sendMessage`），后端无接口，聊天内容也永远不进 `GET /v2/search`。
- 群成员管理（踢人、改名）、公告、在线数、未读数：unavailable。
- Community AI：全部功能区 unavailable（`COMMUNITY_AI_RUNTIME_DEFERRED`）。
- 聊天中的 Token Card：保持 identifier-only，渲染为 unavailable 态直到 D11。
- 端到端加密：任何位置都不声明。
