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

| capabilityId    | 期望                                                                    | UI 含义                                                                                                                              |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `communityChat` | `available`（模块启用 + 仓储 + 社区运行时 + Stream 凭据）               | 社区官方群、DM、小群可用                                                                                                             |
| `voiceRooms`    | `available`；`evidence.status` 为 `pending` 或 `confirmed`（决策 0039） | **只要 `evidence.status !== "confirmed"`（即 `reasonCode` 是 `AUDIO_ROOM_USER_ROLE_EVIDENCE_PENDING`），语音房入口整页 unavailable** |

`availability: unavailable` + `COMMUNICATION_RUNTIME_UNAVAILABLE` 表示模块已
启用但依赖未配齐；`deferred` + `V2_COMMUNICATION_RUNTIME_DEFERRED` 表示模块未
启用。两种情况都不要调用本模块接口，也不要回退 fixture。

`voiceRooms.evidence` 是决策 0005 的前置证据位：后端契约与实现已就绪，但
Stream Dashboard 必须先导出「`audio_room` 的 `user` 角色不含 `create-call`」
的证据。证据由运维在后端环境变量 `STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF`
里确认（决策 0039），前端只看响应：

```jsonc
// 未确认（默认；与 S7 逐字节相同）
{ "status": "pending", "reasonCode": "AUDIO_ROOM_USER_ROLE_EVIDENCE_PENDING" }
// 已确认：多一个 reference 键（1–120 个可打印字符，运维的截图归档标签）
{ "status": "confirmed", "reasonCode": null, "reference": "dashboard-2026-09-10-user-role-no-create-call" }
```

- `evidence.status` 取值 `notApplicable | pending | confirmed`；`confirmed`
  目前只出现在 `voiceRooms`。`reference` 键**仅在 `confirmed` 时出现**，其它
  capability 与 `pending` 状态下**缺席而非 `null`**（沿用决策 0038 的规则），
  严格解析时请把它声明为可选字段。
- 在 `status` 变成 `confirmed` 之前，`voiceroom` / `voiceroom-full` 必须整页
  unavailable 并解释原因，即使 `availability` 已是 `available`。
- `confirmed` **不改变** `availability`：`deferred` / `unavailable` +
  `confirmed` 仍然不能调用本模块接口。只有 `availability === "available"` 且
  `evidence.status === "confirmed"` 同时成立，语音房入口才可打开。
- `reference` 只用于展示 / 排障（例如放在 unavailable 说明或调试面板），不要
  据它做任何逻辑判断。

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
PATCH  /v2/chat/groups/{groupId}          {"name": "…"}   # 改群名（决策 0098）
```

- **好友关系（含 `message-requests accept` 产生的 friendship）是 DM 唯一准入。**
  非好友一律 `404 NOT_FOUND`（非枚举）。
- 目标的隐私开关 `directMessages`（群：每个被邀请好友的 `groupInvites`）**默认开启**
  （决策 0070，2026-09-23）：从未进过隐私中心的账号即可被好友私聊/拉群；只有对方
  在 `/v2/profile/privacy` 明确设为 `disabled` 时才 `404 NOT_FOUND`。前端对此 404
  的文案应是"对方暂不接受私聊/群邀请"，不要说"不是好友"——两者服务端不可区分。
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

### 小群改名：`PATCH /v2/chat/groups/{groupId}`（决策 0098，2026-10-08）

写接口 header：Privy Bearer + `Idempotency-Key`（规范 UUIDv4）+
`X-Loop-Contract-Version: 2.0` + `X-Loop-Client-Version`。

```http
PATCH /v2/chat/groups/2b3c4d5e-6f70-4182-9394-a5b6c7d8e9f0
Content-Type: application/json

{ "name": "蛙群 二期" }
```

```json
{
  "groupId": "2b3c4d5e-6f70-4182-9394-a5b6c7d8e9f0",
  "name": "蛙群 二期",
  "nameVersion": 2,
  "updatedAt": "2026-10-08T05:00:00.000Z",
  "contractVersion": "2.0"
}
```

- `groupId` 是 `POST /v2/chat/groups` 成功结果里的 `groupId`（不是 Stream CID）。
- **只有群主（创建者）能改**；其他群成员 → `403 PERMISSION_DENIED`；不是该群成员、
  群不存在或群还没建成（创建操作未 `succeeded`）→ `404 NOT_FOUND`（非枚举）。
- 名称规则与建群完全一致：服务端先 trim，1–**60** 码点，不允许控制 / 格式字符；
  违规 → `400 INVALID_REQUEST`。产品文案限 40 码点的话前端自己卡 40，服务端不会拒
  41–60。body 只能有 `name` 一个键。
- 改成与当前相同的名字：`200`，`nameVersion`、`updatedAt` 不变（无操作）。
- `nameVersion` 建群时为 1，每次真正改名 +1，可用来丢弃过期的本地乐观值。
- 同一 `Idempotency-Key` 重放返回第一次的结果；同 key 换名字 → `409 IDEMPOTENCY_CONFLICT`。
- PostgreSQL 先提交，随后服务端以群主身份把 Stream 频道 `name` 改成新名（一次
  `updateChannelPartial`）。**Stream 这一步失败只记日志，接口仍返回 200**；Stream
  侧会收到 `channel.updated` 事件，客户端监听到后标题自然更新。前端在 200 后可以
  先乐观更新本地标题；若 Stream 那一步失败，同 key 重试或再次改名会把 Stream 补齐。
- 群信息页「群名称与简介」：群主显示可编辑行；非群主只读并提示「仅群主可改」。
  简介本步没有接口。

错误：

| HTTP | code                                              | 场景                                                               |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------ |
| 400  | `INVALID_REQUEST`                                 | 名称不合规、多余键、`groupId` 非 UUIDv4、缺 / 坏 `Idempotency-Key` |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID`                  | 缺少或无效 Privy Bearer                                            |
| 403  | `PERMISSION_DENIED`                               | 调用者是群成员但不是群主                                           |
| 404  | `NOT_FOUND`                                       | 非成员 / 群不存在 / 群未建成；`communication` 模块未启用           |
| 409  | `IDEMPOTENCY_CONFLICT`                            | 同 key 不同名字                                                    |
| 409  | `VERSION_CONFLICT` / `ACCOUNT_BOOTSTRAP_REQUIRED` | 合约版本不对 / 账号未 bootstrap                                    |
| 503  | `CAPABILITY_UNAVAILABLE`                          | 通信运行时或仓储不可用（`retryable: true`）                        |

unavailable 行为：`503` 时改名行显示「暂不可用，稍后重试」，**不要**在本地假装改名成功。

### 收件箱私聊行：`GET /v2/chat/direct-channels`（决策 0056，2026-09-20）

```text
GET /v2/chat/direct-channels                 # 默认 50 条
GET /v2/chat/direct-channels?limit=20        # 1–50
GET /v2/chat/direct-channels?cursor=<cursor> # cursor 与 limit 互斥
```

读接口 headers（Bearer + `X-Loop-Contract-Version: 2.0` + `X-Loop-Client-Version`），
无 body。成功 `200`：

```json
{
  "items": [
    {
      "streamCid": "messaging:loop_direct_b386bd8d1c2e4f6a8b9c0d1e2f3a4b5c",
      "peer": {
        "publicProfileId": "7e25420e-d7ca-46b1-9a2f-3c4d5e6f7a8b",
        "loopId": "LOOP-2T6JQ8WX",
        "alias": "Voyager_09",
        "avatarRef": null
      },
      "createdAt": "2026-09-20T06:45:09.123Z"
    },
    {
      "streamCid": "messaging:loop_direct_a1b2c3d4e5f60718293a4b5c6d7e8f90",
      "peer": null,
      "createdAt": "2026-09-18T11:02:44.010Z"
    }
  ],
  "nextCursor": null,
  "contractVersion": "2.0"
}
```

- **用途**：这是收件箱把 Stream 私聊频道映射到对方公开资料的唯一途径（R14-1）。
  以 LOOP `direct_channels` 表为权威，**不查 Stream**；只返回调用者自己参与、
  状态 `active` 的频道，按建立时间倒序。
- `peer` 与 `GET /v2/connections` 的 `profile` **字段完全一致**
  （`publicProfileId` / `loopId` / `alias` / `avatarRef`），前端复用同一个身份组件。
- `peer: null` = 对方账号没有可展示的公开资料（已注销 / 从未激活）。
- **响应里没有任何 Stream user id、内部 user id、钱包地址。**
- 分页：keyset（`createdAt` desc, `streamCid` desc），cursor 绑定账号与路由，
  带页大小，因此 `cursor` 和 `limit` 同时出现是 `400 INVALID_REQUEST`；
  `limit` 越界（0 或 >50）、未知 query、别人的 cursor、过期 cursor 都是 `400`。
- 权限：仅本人（principal 绑定，不接受任何目标参数）；未登录 `401`；模块未启用
  `404 NOT_FOUND`；仓储 / cursor 密钥 / Stream 凭据缺失 `503 CAPABILITY_UNAVAILABLE`。

**客户端规则（收件箱私聊行）**：

| 情况                                             | 标题                                         | 头像                             |
| ------------------------------------------------ | -------------------------------------------- | -------------------------------- |
| `peer != null`                                   | `peer.alias ?? peer.loopId`                  | `peer.avatarRef`，否则标题首字母 |
| `peer == null`                                   | 「已注销用户」                               | 占位头像                         |
| Stream 频道的 cid 不在本列表里（尚未加载 / 503） | **不显示任何名字**（占位骨架或 unavailable） | 占位头像                         |

任何情况下都**不得**回退到 Stream 的 `StreamChannelName` / `User.name` / `User.id`
（那就是 `loop_…` 的来源）。列表按 `streamCid` 建索引，Stream 频道列表按 cid 查表。
进入私聊页时把同一个 `peer` 传给 `DirectMessageTarget.identity`，顶栏与 `@`
候选行即刻可用（R14-3）。

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
    "reasonCode": null,
    "viewerPersona": { "alias": "Harbor-4821", "projectionState": "confirmed" }
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

### 成员显示名：社区人格（决策 0055，2026-09-20）

每个 `(社区, 账号)` 有一个**服务端生成、不可变、社区内唯一**的人格
（persona），形如 `Harbor-4821`（中性英文单词 + 4 位数字，不含任何 id 片段、
不含用户别名）。同一个人在不同社区是不同的名字，在同一社区永远是同一个名字，
退出/被封禁/重新加入都不变。

**它投影在 Stream channel member 的 `custom` 上**（与 `POST /v2/chat/groups`
小群的 0024 机制同一 shape，一套渲染代码即可）：

```json
{
  "loop_group_alias": "Harbor-4821",
  "loop_group_alias_id": "b5d6f0c2-2d1e-4c3a-9f6b-7a8c9d0e1f2a",
  "loop_group_alias_version": 1
}
```

客户端渲染规则（**硬规则**，真机验收按此对账）：

| 位置                                   | 画什么                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 群聊气泡上方的发送者名                 | `channel.state.members` 里该 `user.id` 对应 member 的 `custom["loop_group_alias"]`                             |
| 成员名册 / @ 提及 / 系统消息里的成员名 | 同上                                                                                                           |
| member custom 缺 `loop_group_alias` 时 | 固定文案「成员」                                                                                               |
| **永远不画**                           | `user.name`、`user.id`、`message.user.name`、`message.user.id`（它们要么为空、要么是内部主键，两者都不可展示） |

- `loop_group_alias_id` 只用于本地去重/稳定 key，不展示，也不要拿去关联别的接口。
- `GET /v2/communities/{id}` 的 `chat.viewerPersona` 是**当前用户自己**在这个社区
  的名字，用来在输入框附近提示「你在本群显示为 Harbor-4821」；
  `projectionState: "pending"` 表示 LOOP 已生成但 Stream 还没确认，可提示
  「名字同步中」；`null` 表示还没生成（成员同步尚未跑过）或当前用户不是成员。
- 别人的名字只从 member custom 读，不从任何 LOOP 接口读；LOOP 没有「查别人
  persona」的接口，`GET /v2/communities/{id}/members` 里的 `alias` / `loopId`
  是社区公开身份，**不是**群聊显示名，不要把两者拼在一起显示。
- 私聊（`dm`）不受影响，仍显示对方 `alias ?? loopId`。
- Stream member custom 是投影：若某个成员的 custom 还没到（旧成员待回填、或
  投影暂时失败），按「成员」显示即可，不要回退到 `user.id`。

## 5. 语音房（`voiceroom` / `voiceroom-full`）

```text
POST   /v2/communities/{communityId}/voice-rooms          # owner/admin 开房；可选 body {"title": "…"}（决策 0098）
GET    /v2/communities/{communityId}/voice-rooms/current  # 当前直播中的房间
GET    /v2/voice-rooms/{voiceRoomId}
GET    /v2/voice-rooms/{voiceRoomId}/hand-raises
GET    /v2/voice-rooms/{voiceRoomId}/members?role=speaker|listener   # 名单（决策 0052）
POST   /v2/voice-rooms/{voiceRoomId}/join
POST   /v2/voice-rooms/{voiceRoomId}/leave
POST   /v2/voice-rooms/{voiceRoomId}/hand-raise
DELETE /v2/voice-rooms/{voiceRoomId}/hand-raise
POST   /v2/voice-rooms/{voiceRoomId}/speakers/{publicProfileId}   # host 邀请发言
DELETE /v2/voice-rooms/{voiceRoomId}/speakers/{publicProfileId}   # host 移出发言
DELETE /v2/voice-rooms/{voiceRoomId}/speakers/me                  # 发言者自助下麦（决策 0098）
POST   /v2/voice-rooms/{voiceRoomId}/speakers/{publicProfileId}/mute  # host 逐人静音（决策 0052）
DELETE /v2/voice-rooms/{voiceRoomId}/speakers/{publicProfileId}/mute  # 本人或 host 取消静音意图（决策 0053）
POST   /v2/voice-rooms/{voiceRoomId}/mute-all                     # host
POST   /v2/voice-rooms/{voiceRoomId}/end                          # host
```

房间资源：

```json
{
  "room": {
    "voiceRoomId": "<uuid>",
    "communityId": "<uuid>",
    "communityName": "Builders Guild",
    "title": "周五 AMA",
    "callCid": "audio_room:loop_voice_<32 hex>",
    "state": "live",
    "provisionState": "provisioned",
    "backstage": false,
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
    "joinedCount": 46,
    "observed": {
      "status": "available",
      "participantCount": 31,
      "memberCount": 46,
      "observedAt": "…"
    }
  },
  "providerSync": { "status": "confirmed", "reasonCode": null },
  "contractVersion": "2.0"
}
```

规则：

- **`room.communityName`（决策 0052，必填）**：与 `GET /v2/communities/{id}` 的
  `community.name` 同源同值，每次响应从社区行现读。顶部 banner「正在语音房 ·
  <社区名> · N 人在线」直接用它 + `participants.observed.participantCount`，不用再
  读一次社区。它是展示值，关联仍用 `communityId`。**codec 用 `strictMap` 的必须
  把 `communityName` 加进 `room` 的键集合。**
- **权限**：只有 `viewer.role === "host"` 才渲染邀请/移出发言、全体静音、结束
  房间。后端同样只接受 host；非 host 一律 `403 PERMISSION_DENIED`。owner 或
  admin 才能开房。唯一例外是 `DELETE …/speakers/{pid}/mute`：被静音的发言人
  可以对**自己**调用（决策 0053），见名单一节。
- **`provisionState`**：只有 `provisioned` 才能 `join`；`pending` /
  `reconciling` / `failed` 时 `join` 返回 `503 CAPABILITY_UNAVAILABLE`。
- **`backstage`（决策 0054）**：建房时后端先 `create` 再 `go_live`，所以
  provisioned 的房 `backstage` 恒为 `false`，听众和发言人才能在设备上
  `call.join()`（Stream `audio_room` 的 `join-backstage` 只给 host/admin）。
  0054 之前建的房 DB 里是 `true`：下一次 `GET …/voice-rooms/{id}`、
  `GET …/current` 或 `join` 会自动做**一次** `go_live` 并回写；读路径失败不
  阻断（照常 200，`backstage: true`、`providerSync.unconfirmed`
  `STREAM_CALL_GO_LIVE_UNCONFIRMED`）；`join` 失败则 `503 CAPABILITY_UNAVAILABLE`
  且 `detailsSafe.reasonCode = "VOICE_ROOM_BACKSTAGE_NOT_LIVE"`，不写任何
  成员行。页面看到 `backstage: true` 就显示「语音房尚未开播，请刷新重试」，
  不要显示「连接失败」。
- **建房 201 不等于能进（决策 0069）**：`POST …/voice-rooms` 只要 LOOP 行提交
  就是 201，Stream 那两步写的结果在响应体里。**只有
  `room.provisionState === "provisioned" && room.backstage === false` 才
  `call.join()`**；否则（`reconciling` + `providerSync.unconfirmed`，
  `reasonCode` 是 `STREAM_CALL_CREATE_UNCONFIRMED` 或
  `STREAM_CALL_GO_LIVE_UNCONFIRMED`）房间存在但 call 不可用，页面要显示可定位
  的原因文案，不要静默进房失败。恢复只有两条路：**用同一个 `Idempotency-Key`
  重试建房**（后端跳过本地写、重走 create → go_live），或 host 先 `POST …/end`
  再新建。**换一个 key 重建会 `409 RESOURCE_CONFLICT`**——`reconciling` 的房在
  DB 里仍是 `live`，占着"一社区一 live 房"的位置。后端对每一次未确认的 Stream
  写都会记一条 warn（`requestId` = 响应头 `x-request-id`），把它带进反馈。
- **`join` 幂等**：已在房间内会返回当前角色，不会报错，`joinedAt` 不变；
  `leave` 之后再 `join`，名单里的 `joinedAt` 刷新为这次加入的时间（决策
  0054 §2.3，R4-6）。`expiresAt` 是本次入场授权到期时间；到期前用
  `POST /v2/video/token` 换新 token 并重新 `join`。
- **举手队列**：`sequence` 是 PostgreSQL 在房间行锁内分配的**十进制字符串**
  （绝不是 JS number），全序无重复。每人同一时刻只能有一个 `pending` 举手；
  重复举手返回 `409 DATA_STALE`。host 邀请发言会把该用户的 pending 举手置为
  `invited`。队列条目的身份投影与名单同一套（决策 0053，见下一节末尾）；
  **`profile` 已删除**。
- **举手通知走 Stream 自定义 call event（决策 0069）**：`POST …/hand-raise`
  与 `DELETE …/hand-raise` 在 LOOP 队列提交后，用 **host 的 Stream 用户**向
  这个 call 发一次自定义事件，房内所有已连接设备都会收到：

  ```json
  {
    "loop_event_kind": "voiceRoomHandRaise",
    "loop_event_schema_version": 1,
    "voice_room_id": "<uuid>",
    "hand_raise_id": "<uuid>",
    "sequence": "7",
    "state": "pending"
  }
  ```

  `state` 是 `pending`（举手）或 `cancelled`（取消）。事件**只说队列变了**，
  不含 alias / publicProfileId / loopId / Stream 用户 ID（否则匿名举手者会被对应
  到某个 participant tile）。host 端做法：`call.on("custom", e)`，
  `e.custom.loop_event_kind === "voiceRoomHandRaise"` 时重读
  `GET …/hand-raises`（身份、顺序、`invite_speaker` 命令都从那里来），不要从
  事件里拼状态；兜底轮询 ≥ 15 s、只在 host 视角开。举手响应的 `providerSync`
  报的就是这一次发送：`unconfirmed` + `STREAM_CALL_EVENT_UNCONFIRMED` 表示
  **举手已经记上了**，但没有设备被告知——给举手者提示"主持人可能稍后才看到"。
  `state` 只会是本命令产生的状态：同一个 `Idempotency-Key` 重放时，若这条举手
  已被 host 置为 `invited`（或已有更新的一条），后端不再发事件、响应
  `confirmed`；事件永远不会带 `invited`。

- **join 之后名单与人数立即包含新成员（决策 0069 §2.3）**：`join` 在一个事务
  里提交，`GET …/members`、`GET …/voice-rooms/{id}` 每次读 PostgreSQL、没有缓存，
  所以 join 200 之后的下一次读就有这个人（`listenerCount` / `joinedCount` 已加一、
  名单有其行）。主持人端"房内人数"用 `participants.joinedCount`；如果要显示
  "在线 N 人"用 `observed.participantCount`，它要等对方设备真正 `call.join()`
  之后才含该人——在 Stream 的 `call.session_participant_joined|left`、
  `call.member_added|removed` 事件上重读房间资源即可。
- **`leave` 幂等（决策 0069 §2.4）**：在 live 房里，**社区成员**从未加入或已经
  离开时调 `POST …/leave` 得 **`200`**、`viewer.role: null`、
  `providerSync: confirmed`、`participants.observed: unavailable`（后端什么都
  没写、没做 Stream 移除、也没观测——不要把 observed 显示成 0）；不再是
  `409 DATA_STALE`。拒绝顺序与 join 相同：`404` → `403 PERMISSION_DENIED`
  （非社区成员 / 被 ban，不看房间状态；host 调 leave 也是 403，host 只能
  `end`）→ `409 DATA_STALE`（房间已结束，所有写都是），客户端收到 409 就导航
  回社区页。
- **人数（决策 0051，三个口径三个字段，不要混）**：
  - `speakerCount` / `listenerCount`：LOOP 的**角色意图**（`voice_room_members`
    中 `joined` 的 speaker / listener）。**都不含 host**，所以只有主持人的房间是
    `0 / 0`，这不是 bug。
  - `joinedCount`：LOOP 已加入总数，**含 host**（live 房 = 1 + speaker +
    listener）。要显示「LOOP 记录了几个人」用它。
  - `observed.memberCount`：Stream call **被授权成员**数（含从未连上音频的
    host）。它是「能进来的人」，不是在线人数。
  - `observed.participantCount`：Stream 当前 session **在线参与者**数（设备真的
    连着 call）。页面「当前在线人数」**必须**读这个字段；Stream 没有 live
    session 时它是 0，这是真实的 0。
  - `join` 响应里 `listenerCount` / `joinedCount` 一定含本人；`memberCount` 在
    `providerSync.confirmed` 时含本人；`participantCount` 要等设备用 token 真正
    `join` 了 Stream call 之后才会含本人——LOOP `join` 是授权，不是音频连接。
  - `observed` 读不到时整块是
    `{status:"unavailable", reasonCode:"STREAM_PARTICIPANT_COUNT_NOT_OBSERVED"}`，
    不要显示 0。成员分页最多翻 10 页（每页 100）；翻不完、任一 Stream 读失败都
    返回 unavailable，绝不发布半个观测。`join` / `leave` / 举手 / 邀请发言 /
    移出发言 / 全体静音的响应都会在那一次 Stream 写之后再观测一次；
    `POST …/voice-rooms`（刚建）与 `POST …/end`（已结束）固定 unavailable。
  - **客户端 codec 用 `strictMap` 精确键集合的，必须把 `joinedCount` 与
    `observed.participantCount` 加进键集合，否则整个语音房快照会被判为 invalid。**
- **`providerSync`**：`confirmed` 表示这次命令的那一次 Stream 写入被确认；
  `unconfirmed` 表示 LOOP 侧已提交但 Provider 事实未确认（`reasonCode` 取值：
  `STREAM_CALL_CREATE_UNCONFIRMED`、`STREAM_CALL_GO_LIVE_UNCONFIRMED`、
  `STREAM_CALL_MEMBER_UNCONFIRMED`、`STREAM_CALL_PERMISSION_UNCONFIRMED`、
  `STREAM_CALL_MUTE_UNCONFIRMED`、`STREAM_CALL_END_UNCONFIRMED`、
  `STREAM_CALL_EVENT_UNCONFIRMED`（举手事件，决策 0069））。读路径
  只会出现 `STREAM_CALL_GO_LIVE_UNCONFIRMED`（自愈失败）。**不要把 LOOP 提交
  当成 Provider 事实。**
  用同一个 `Idempotency-Key` 重放会跳过本地变更、只重试那一次 Provider 调用。
- **房间结束后所有写操作返回 `409 DATA_STALE`。** 一个社区同时只能有一个
  `live` 房间；重复开房返回 `409 RESOURCE_CONFLICT`。
- `GET .../voice-rooms/current` 在没有直播时返回
  `{current: null, reasonCode: "COMMUNITY_VOICE_ROOM_NOT_LIVE", contractVersion}`。

### 发言人 / 听众名单（决策 0052）

`GET /v2/voice-rooms/{id}/members?role=listener`（或 `role=speaker`），`role` 必填；
`limit`（默认 50、上限 100）与 `cursor` 互斥；`cursor` 绑定视图，换 `role` 续页是
`400 INVALID_REQUEST`。读权限与房间资源相同（社区成员）。

**数据口径**：名单是 LOOP 的「已加入」意图（`voice_room_members` 中 `joined`
的 speaker / listener），host 不在任何视图；**不含 Stream 在线状态**。「N 人在线」
仍读房间资源的 `participants.observed.participantCount`；名单行数 ≈
`speakerCount` / `listenerCount`。

开发库 `builders-guild` 房（host `Voyager_09`）以 host 身份读听众：

```json
{
  "role": "listener",
  "items": [
    {
      "publicProfileId": "8fcb7ade-c1dd-44ee-a6e0-5f80abbdc55e",
      "display": {
        "kind": "alias",
        "alias": "Voyager_344",
        "publicProfileId": "8fcb7ade-c1dd-44ee-a6e0-5f80abbdc55e",
        "audience": "everyone"
      },
      "role": "listener",
      "joinedAt": "2026-09-17T13:45:10.600Z",
      "handRaised": false,
      "muted": false,
      "isSelf": false,
      "commands": ["invite_speaker"]
    },
    {
      "publicProfileId": "4678e354-1e9f-4f6a-8c80-ab9aecbcfe3c",
      "display": {
        "kind": "anonymous",
        "labelKey": "voiceRoom.member.anonymousMember"
      },
      "role": "listener",
      "joinedAt": "2026-09-17T13:45:20.065Z",
      "handRaised": false,
      "muted": false,
      "isSelf": false,
      "commands": ["invite_speaker"]
    },
    {
      "publicProfileId": "2323c2b1-0e71-4e25-8c92-d94bcfec0ef7",
      "display": {
        "kind": "alias",
        "alias": "DeFiMaxi_349",
        "publicProfileId": "2323c2b1-0e71-4e25-8c92-d94bcfec0ef7",
        "audience": "everyone"
      },
      "role": "listener",
      "joinedAt": "2026-09-17T13:45:25.046Z",
      "handRaised": true,
      "muted": false,
      "isSelf": false,
      "commands": ["invite_speaker"]
    }
  ],
  "nextCursor": null,
  "display": {
    "anonymousMemberKey": "voiceRoom.member.anonymousMember",
    "ruleKey": "voiceRoom.member.display.anonymousModeOnly"
  },
  "contractVersion": "2.0"
}
```

同一房间以普通成员 `cy` 读（非 host）：匿名行 `publicProfileId: null`、所有行
`commands: []`：

```json
{
  "publicProfileId": null,
  "display": {
    "kind": "anonymous",
    "labelKey": "voiceRoom.member.anonymousMember"
  },
  "role": "listener",
  "joinedAt": "2026-09-17T13:45:20.065Z",
  "handRaised": false,
  "muted": false,
  "isSelf": false,
  "commands": []
}
```

host 邀请 `Voyager_344` 发言并静音后读 `role=speaker`：

```json
{
  "publicProfileId": "8fcb7ade-c1dd-44ee-a6e0-5f80abbdc55e",
  "display": {
    "kind": "alias",
    "alias": "Voyager_344",
    "publicProfileId": "8fcb7ade-…",
    "audience": "everyone"
  },
  "role": "speaker",
  "joinedAt": "2026-09-17T13:45:10.600Z",
  "handRaised": false,
  "muted": true,
  "isSelf": false,
  "commands": ["remove_speaker", "unmute"]
}
```

同一行由 `Voyager_344` 自己读（非 host，本人 speaker 行已静音）——这是名单里
**唯一**发给非 host 的命令：

```json
{
  "publicProfileId": "8fcb7ade-c1dd-44ee-a6e0-5f80abbdc55e",
  "display": {
    "kind": "alias",
    "alias": "Voyager_344",
    "publicProfileId": "8fcb7ade-…",
    "audience": "everyone"
  },
  "role": "speaker",
  "joinedAt": "2026-09-17T13:45:10.600Z",
  "handRaised": false,
  "muted": true,
  "isSelf": true,
  "commands": ["unmute_self"]
}
```

规则：

- **`display` 沿用挖矿榜（决策 0049）**：`{kind:"alias", alias, publicProfileId, audience}`
  或 `{kind:"anonymous", labelKey}`。对方开了匿名模式就是 `anonymous`；本人永远看到
  自己的别名，开匿名时 `audience:"self"`（可提示"别人看到的是匿名"）。`labelKey`
  用 `display.anonymousMemberKey` 做 i18n。
- **行顶层 `publicProfileId` 可为 null**：host 视角恒非空（命令目标）；非 host
  视角匿名行为 null——不要试图解析、不要跳资料页。
- **`commands[]` 是唯一的行命令来源**（S17 做法）：渲染恰好这些按钮，不要自己
  按 `viewer.role` 推。`invite_speaker` → `POST …/speakers/{pid}`；`remove_speaker`
  → `DELETE …/speakers/{pid}`；`mute` → `POST …/speakers/{pid}/mute`；`unmute`
  与 `unmute_self` → `DELETE …/speakers/{pid}/mute`（决策 0053）。host 视角：
  listener 行 `["invite_speaker"]`，speaker 行未静音 `["remove_speaker","mute"]`、
  已静音 `["remove_speaker","unmute"]`。非 host 视角所有行都是 `[]`，**只有本人
  的 speaker 行且已静音时是 `["unmute_self"]`**。房间非 live 一律 `[]`。
  **枚举集合变大了**：严格 codec 必须加 `unmute` / `unmute_self`。写路径按同一
  谓词复核，不是授权。
- **`handRaised`**：该成员有 pending 举手（listener 视图有意义；speaker 恒 false）。
  举手顺序仍看 `GET …/hand-raises`。
- **`muted` 只是 host 的 LOOP 侧意图**（逐人静音或全体静音后为 true），**不是**
  麦克风状态——Stream 才是媒体状态的真相，被静音者在设备上可以自己开麦。每次角色
  变化（邀请 / 移出 / 离开）清零，或由下面的取消静音清零。
- 逐人静音：`POST /v2/voice-rooms/{id}/speakers/{pid}/mute`，host only；目标是
  listener 或已静音 → `409 DATA_STALE`；对自己 → `403`。响应是房间资源，
  `providerSync` 说明那一次 Stream `muteUsers(user_ids)` 是否确认。
- **取消静音意图（决策 0053）**：`DELETE /v2/voice-rooms/{id}/speakers/{pid}/mute`，
  写头齐全（`Idempotency-Key` 等），无 body。**本人**（`pid` 是自己的档案）或
  **host** 可调，其他人 `403 PERMISSION_DENIED`。目标必须是已静音的 speaker：
  未静音 / listener / 已离开 → `409 DATA_STALE`；目标是 host 行 → `403`；房间已
  结束 → `409 DATA_STALE`。它**只清 LOOP 意图并写审计 `speaker_unmuted`**，
  **不做任何 Stream 调用**（Stream 不允许替别人开麦；开麦由本机 SDK 完成，
  发言人的 `send-audio` 权限在邀请时已授予），所以 `providerSync` 固定
  `confirmed`。推荐做法：用户在设备上开麦成功后再调它，让名单的 `muted`
  归零；调用本身不会打开麦克风。响应是房间资源，`viewer.role` 是调用者的角色。
- 分页：`nextCursor` 非空才有下一页；`limit` 与 `cursor` 同时传是 `400`。没有
  cursor 密钥时需要续页的响应 `503 CAPABILITY_UNAVAILABLE`。

### 举手队列与名单同一投影（决策 0053）

`GET /v2/voice-rooms/{id}/hand-raises` 的条目不再带 `profile`（0032 的
`{publicProfileId, loopId, alias, avatarRef}` 对所有成员可见）；改为与名单行
**同一**身份投影：`publicProfileId`（可 null）、`display`、`isSelf`、`commands[]`，
顶层多一个 `display: {anonymousMemberKey, ruleKey}`。**这是破坏性变化**：codec 里
`profile` 的 `strictMap` 要删掉，`loopId` / `avatarRef` 从这个端点消失（要头像走
资料页）。

host 视角：

```json
{
  "items": [
    {
      "handRaiseId": "<uuid>",
      "sequence": "1",
      "state": "pending",
      "createdAt": "…",
      "publicProfileId": "2323c2b1-0e71-4e25-8c92-d94bcfec0ef7",
      "display": {
        "kind": "alias",
        "alias": "DeFiMaxi_349",
        "publicProfileId": "2323c2b1-0e71-4e25-8c92-d94bcfec0ef7",
        "audience": "everyone"
      },
      "isSelf": false,
      "commands": ["invite_speaker"]
    },
    {
      "handRaiseId": "<uuid>",
      "sequence": "2",
      "state": "pending",
      "createdAt": "…",
      "publicProfileId": "4678e354-1e9f-4f6a-8c80-ab9aecbcfe3c",
      "display": {
        "kind": "anonymous",
        "labelKey": "voiceRoom.member.anonymousMember"
      },
      "isSelf": false,
      "commands": ["invite_speaker"]
    }
  ],
  "display": {
    "anonymousMemberKey": "voiceRoom.member.anonymousMember",
    "ruleKey": "voiceRoom.member.display.anonymousModeOnly"
  },
  "contractVersion": "2.0"
}
```

非 host 视角的第二条：`publicProfileId: null`、`commands: []`（`display` 照旧匿名）。
本人自己的举手行永远显示自己的别名（匿名时 `audience:"self"`）、`isSelf: true`。

规则：

- `display` / 行顶层 `publicProfileId` 的规则与名单完全相同：匿名成员对非 host
  不可寻址；host 恒能看到目标并直接从队列邀请（`invite_speaker` →
  `POST …/speakers/{pid}`）。
- `commands[]`：host 且房间 live 时每条都是 `["invite_speaker"]`（队列里的人都是
  pending 举手的 listener）；其他情况 `[]`。
- 与 0032 的差异：完整身份不再发布；别名只在对方未开匿名或本人时可见。

### 发言者自助下麦、房间 host、名单头像（决策 0098，2026-10-08）

**`DELETE /v2/voice-rooms/{voiceRoomId}/speakers/me`**：写接口 header（Bearer +
`Idempotency-Key` + `X-Loop-Contract-Version: 2.0` + `X-Loop-Client-Version`），无 body。

- 调用者是已加入的发言者：LOOP 先把角色改回 `listener`（清掉静音意图，审计
  `speaker_stepped_down`），再对 Stream 收回 `send-audio` 并把 call 成员角色改回
  listener。返回 `200` 房间资源，`viewer.role = "listener"`，计数已更新；
  `providerSync` 报告 Stream 两步是否确认（失败时 `unconfirmed` +
  `STREAM_PERMISSION_UNCONFIRMED`，命令仍成功，客户端本地关麦即可）。
- 调用者不是发言者（听众 / 已离开 / 没进过房）：`200` 无操作，房间资源原样返回，
  `providerSync` 为 `confirmed`，不写库、不调 Stream（与 `leave` 的 no-op 同风格）。
- host 调用 → `403 PERMISSION_DENIED`（host 不能下麦，只能结束房间）。房间已结束 →
  `409 DATA_STALE`。同 key 重放返回同一结果。
- 底部控制条「下麦」用它；host 移别人下麦仍是 `DELETE …/speakers/{publicProfileId}`。

**房间资源新增顶层 `host`**（与 `room`、`viewer` 平级，所有返回房间资源的接口都有）：

```json
"host": {
  "publicProfileId": "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
  "displayName": "frog_maxi",
  "avatarRef": "avatar:preset/people-03"
}
```

与 `GET /v2/voice-rooms/live` 的 `host` 同一投影：host 对调用者匿名（或没有激活资料）
时三项全 `null`，渲染匿名占位；host 本人永远看到自己。类型是 `object | null`，`null`
目前不会出现，客户端按「三项 null」同样处理即可。主持人区大头像用它。

**名单行新增 `avatarRef`**（`GET /v2/voice-rooms/{id}/members`）：`display.kind =
"alias"`（具名，或调用者自己的行）时是该成员的头像引用（`avatar:preset/...` 或
`avatar:media/{id}`，解析同 profile `avatarRef`），匿名行为 `null`。举手队列条目不变。

### 开房标题：`POST /v2/communities/{communityId}/voice-rooms` 的可选 body（决策 0098，2026-10-08）

```http
POST /v2/communities/3fa85f64-5717-4562-b3fc-2c963f66afa6/voice-rooms
Content-Type: application/json

{ "title": "周五 AMA" }
```

- body 可选：不带 body（也不带 `Content-Type`）、`{}`、`{"title": null}`、或 trim 后为空
  的标题都开一个**无标题**房间（`room.title: null`）。老客户端不带 body 的行为不变。
- 标题 trim 后 1–40 码点，不能含控制 / 格式字符；超长、非字符串、多余键 → `400
INVALID_REQUEST`。标题只能在开房时设置，本步没有改标题接口。
- 幂等：带标题时标题进入请求摘要，同一 `Idempotency-Key` 换标题 → `409
IDEMPOTENCY_CONFLICT`；不带标题时与 0098 之前的摘要相同。
- 返回的房间资源 `room.title` 就是存下的值；`GET /v2/voice-rooms/{id}`、
  `GET …/voice-rooms/current` 与 `GET /v2/voice-rooms/live` 都带同一个 `title`。
- 权限不变：只有 owner / admin 能开房；其它错误码同 §6。

### 广场在线语音房：`GET /v2/voice-rooms/live`（决策 0093，2026-10-08）

广场「语音房」页内 Tab 的跨社区列表。读接口 header（Bearer + `X-Loop-Contract-Version: 2.0` + `X-Loop-Client-Version`），不带 `Idempotency-Key`。

- query：`limit`（1–50，默认 20）与 `cursor` **互斥**（cursor 自带页大小）；其它 query 一律 `400 INVALID_REQUEST`。翻页只传上一页的 `nextCursor`。cursor 绑定账号与路由，换账号或拿名单的 cursor 来用都是 `400`。
- 范围：`live`、已 provisioned、call 已离开 backstage 的房间（即现在能进的房），且社区对调用者可见（已认证社区，或自己创建 / 未被 ban 的成员所在的未认证社区）。按 `startedAt` 倒序。
- `joinable`：调用者是该社区未被 ban 的成员。`false` 时先引导加入社区，不要直接调 `join`（会得到 `403 PERMISSION_DENIED`）。
- `listenerCount` / `speakerCount`：LOOP「已加入」角色计数（决策 0051，**不含 host**），与房间资源 `participants.listenerCount` / `speakerCount` 同口径，**不是 Stream 在线人数**。本接口不调 Stream，`countsObservedAt` 恒为 `null`；要显示「N 人在线」进房后读 `GET /v2/voice-rooms/{id}` 的 `participants.observed`。
- `title`（决策 0098）：主持人开房时填的标题，没填为 `null`；`null` 时 UI 显示
  「{communityName} 语音房」。
- `speakersPreview`（决策 0098）：卡片头像叠放。第一个永远是 host（与 `host` 字段
  同一对象），后面是至多 3 个 LOOP「已加入」的发言者，按加入时间先后；总数 1–4。
  每一项与 `host` 同一显示规则：对调用者匿名（或该账号没有激活资料）的人仍占一个
  位置，但 `publicProfileId` / `displayName` / `avatarRef` 三项全为 `null`，渲染占位
  头像；调用者本人永远看到自己的身份。已离开或被移下麦的人不在里面。
- `communityLogoRef` / `host.avatarRef` 是预设引用（`avatar:preset/...`），与社区资源 `logoRef`、profile `avatarRef` 同一解析方式；不是 URL。
- `host` 按排行榜显示规则：host 开了匿名（且调用者不是 host 本人）或没有别名时，`displayName`、`publicProfileId`、`avatarRef` 全为 `null`，渲染 `voiceRoom.member.anonymousMember` 文案。
- `observedAt`：服务端读取时间。
- 语音房入口仍受 `voiceRooms` capability 与 `evidence.status` 约束（见 §1）。

```json
{
  "items": [
    {
      "voiceRoomId": "8c7b6a59-4d3e-4f21-8a0b-1c2d3e4f5a6b",
      "communityId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "communityName": "Builders Guild",
      "communityLogoRef": "avatar:preset/community-03",
      "title": "周五 AMA",
      "host": {
        "publicProfileId": "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
        "displayName": "frog_maxi",
        "avatarRef": "avatar:preset/people-03"
      },
      "speakersPreview": [
        {
          "publicProfileId": "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
          "displayName": "frog_maxi",
          "avatarRef": "avatar:preset/people-03"
        },
        { "publicProfileId": null, "displayName": null, "avatarRef": null }
      ],
      "listenerCount": 4,
      "speakerCount": 1,
      "countsObservedAt": null,
      "startedAt": "2026-10-08T03:00:00.000Z",
      "joinable": true
    },
    {
      "voiceRoomId": "2b3c4d5e-6f70-4182-9394-a5b6c7d8e9f0",
      "communityId": "4b96a75e-6828-4a6b-8c1d-2e3f4a5b6c7d",
      "communityName": "Frog Holders",
      "communityLogoRef": null,
      "title": null,
      "host": {
        "publicProfileId": null,
        "displayName": null,
        "avatarRef": null
      },
      "speakersPreview": [
        { "publicProfileId": null, "displayName": null, "avatarRef": null }
      ],
      "listenerCount": 0,
      "speakerCount": 0,
      "countsObservedAt": null,
      "startedAt": "2026-10-08T01:00:00.000Z",
      "joinable": false
    }
  ],
  "nextCursor": null,
  "observedAt": "2026-10-08T04:00:00.000Z",
  "contractVersion": "2.0"
}
```

没有在线房间时 `items: []`、`nextCursor: null`（200，不是错误）。错误：

| HTTP | code                                              | 场景                                                                                            |
| ---- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                                 | `limit` 越界 / 非整数、`limit` 与 `cursor` 同传、cursor 无效 / 过期 / 他人 / 他路由、未知 query |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID`                  | 缺少或无效 Privy Bearer                                                                         |
| 404  | `NOT_FOUND`                                       | `communication` 模块未启用                                                                      |
| 409  | `VERSION_CONFLICT` / `ACCOUNT_BOOTSTRAP_REQUIRED` | 合约版本不对 / 账号未 bootstrap                                                                 |
| 503  | `CAPABILITY_UNAVAILABLE`                          | 通信运行时不可用（`voiceRooms.availability: unavailable`）、仓储故障、cursor 密钥未配置         |

unavailable 行为：`503` 时整个语音房 Tab 显示不可用并可重试（`retryable: true`），不要回退 fixture 或缓存的旧列表冒充现状。

### Development 上怎么试（决策 0050）

App 目前**没有开房入口**（`loop_v2_communication_api.dart` 只封装了 `current`、
房间读取、举手队列与房内命令，没有调用 `POST …/voice-rooms`），所以
`voice_rooms` 一直是 0 行、语音房页永远"当前没有进行中的语音房"。开房走
dev-only 运维脚本，它以社区 owner 的身份调用与路由完全相同的
`VoiceRoomService.createRoom`（LOOP 侧先提交 `voice_rooms` + host 成员 + 审计，
再用 server key 创建一次 Stream `audio_room` call 并 `go_live`；不改 Stream
角色权限）：

```sh
pnpm voice-room:open <communityId> --confirm      # NODE_ENV=production 拒绝
```

社区已有 `live` 房时脚本报 `RESOURCE_CONFLICT`；Stream 未确认时房间是
`reconciling`、脚本退出 1，如实打印 `providerSync`。

用户在 App 里的步骤（以 `builders-guild` 为例，走查账号 `cy` 是它的成员）：

1. 社区 Tab → 打开 `builders-guild` 社区主页（`GET /v2/communities/{id}` 的
   `voice.status` 变成 `available`，`currentRoomId` 非空；社区资料页的"语音房"
   行显示"当前有进行中的语音房"）。
2. 点社区主页的「语音房」入口 → 进入语音房页（`GET …/voice-rooms/current`
   返回 `current` 非空）。
3. 点「加入」（`POST /v2/voice-rooms/{id}/join`，需要
   `provisionState: provisioned`）→ `viewer.role: listener`；然后可「举手」。
   host（脚本用的社区 owner，不是 `cy`）才有邀请发言 / 全体静音 / 结束控制。
4. 前端跟进项：给 owner/admin 加"开房"按钮调用
   `POST /v2/communities/{id}/voice-rooms`（`cy` 是 `mock-defi-morning` 的
   owner，可以直接在 App 内开房；后端路由与权限已就绪）。

## 6. 错误码对照

| HTTP | code                             | 场景                                                                                                                                                  |
| ---- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | header/query/body 违规，`Idempotency-Key` 不是规范 UUIDv4                                                                                             |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | 缺少或无效 Privy Bearer                                                                                                                               |
| 403  | `PERMISSION_DENIED`              | 非 host 的房间控制、host 调 `leave` 或 `speakers/me`、非成员读房、创建者退群、非 owner/admin 开房、非群主改群名（决策 0098）                          |
| 404  | `NOT_FOUND`                      | 模块未启用、房间/群/操作不存在或不属于调用者、非好友目标                                                                                              |
| 409  | `DATA_STALE`                     | 已结束房间的写操作（含 `leave`）、重复举手、取消不存在的举手、非法角色迁移；live 房里"不在房间内"的 `leave` 不再是它（200，决策 0069）                |
| 409  | `IDEMPOTENCY_CONFLICT`           | 同一 key 配不同请求内容                                                                                                                               |
| 409  | `PROFILE_ACTIVATION_REQUIRED`    | 账号没有激活的 V2 profile                                                                                                                             |
| 409  | `RESOURCE_CONFLICT`              | 社区已有 `live` 语音房                                                                                                                                |
| 429  | `RATE_LIMITED`                   | Stream token 配额                                                                                                                                     |
| 503  | `CAPABILITY_UNAVAILABLE`         | 模块/仓储/Stream 凭据缺失，或房间未 provisioned；`join` 时 call 仍在 backstage（`detailsSafe.reasonCode = VOICE_ROOM_BACKSTAGE_NOT_LIVE`，决策 0054） |

`POST …/join` 的拒绝优先级固定（决策 0054）：`404 NOT_FOUND`（房不存在）→
`403 PERMISSION_DENIED`（被 ban / 非社区成员，不看房间状态）→ `409 DATA_STALE`
（成员对已结束房）→ `503 CAPABILITY_UNAVAILABLE`（成员对未 provisioned 房，或
backstage 自愈失败）。
| 503 | `PROVIDER_DISCONNECTED` | 退群时 Stream 移除结果未知（未提交，可安全重试） |

错误体固定七字段：`code`、`category`、`retryable`、`userMessageKey`、
`correlationId`、`detailsSafe`、`providerReferenceSafe`。`providerReferenceSafe`
恒为 `null`；`detailsSafe` 除 `join` 的 backstage 拒绝（`{reasonCode}`）外为
`null`。

## 7. 本步不提供的能力

- 聊天搜索、转发、合并长图：全部走 Stream SDK（`client.search`、
  `sendMessage`），后端无接口，聊天内容也永远不进 `GET /v2/search`。
- 群成员管理（踢人、改名）、公告、在线数、未读数：unavailable。
- Community AI：全部功能区 unavailable（`COMMUNITY_AI_RUNTIME_DEFERRED`）。
- 聊天中的 Token Card：保持 identifier-only，渲染为 unavailable 态直到 D11。
- 端到端加密：任何位置都不声明。
