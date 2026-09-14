# 前端联调：V2 社区、社交图与搜索（S3 / D3–D6）

本文是 `community` 与 `search` 两个模块（决策 0031）的前端交接契约。权威机器
契约为 `openapi/loop-api.v2.json`。通用规则（Base URL、`X-Request-ID`、错误体
七字段）沿用 `docs/frontend-v2-session-api.md` 与 `docs/api-v2-conventions.md`。

覆盖页面：`community`、`community-discover`、`community-profile`、
`community-members`、`search`、`connections`、`blocklist`、`dm-requests`、
`referral`。

## 1. Base URL、启用条件与 headers

- Development：`https://api-dev.quant-dinger.cc`；本机 `http://127.0.0.1:3000`
  （或 `PORT` 指定端口）。
- 后端 `V2_MODULES_ENABLED` 必须包含 `community`（社区 + 社交图 + referral 规则）
  与 `search`（`GET /v2/search`）。未启用时对应路径全部返回 `404 NOT_FOUND`
  （V2 错误体），且不会校验 Bearer。
- 前端必须先读 `GET /v2/meta/capabilities`：

| capabilityId        | 期望                                                    | UI 含义                                |
| ------------------- | ------------------------------------------------------- | -------------------------------------- |
| `community`         | `available`（模块启用 + 仓储 + cursor 密钥都就绪）      | 社区页可用                             |
| `search`            | `available`（再加公共搜索配额）                         | 搜索页可用                             |
| `communityMining`   | 恒为 `unavailable`（`MINING_FORMULA_BASELINE_PENDING`） | 算力卡片、算力数字一律显示 unavailable |
| `communityPresence` | 恒为 `unavailable`（`STREAM_PRESENCE_NOT_CONNECTED`）   | 在线人数、语音房一律显示 unavailable   |

`unavailable` + `COMMUNITY_RUNTIME_UNAVAILABLE` / `SEARCH_RUNTIME_UNAVAILABLE`
表示模块已启用但后端依赖未配齐；`deferred` 表示模块未启用。两种情况都不要
调用本模块接口，也不要回退 fixture。

- 读接口 header：

```text
Authorization: Bearer <current Privy access token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: 1.0.0
```

- 写接口在上述基础上必须再带**恰好一个**规范小写 UUIDv4：

```text
Idempotency-Key: <canonical lowercase UUIDv4 for this logical operation>
```

- 读接口带 `Idempotency-Key` 返回 `400 INVALID_REQUEST`；写接口缺失、重复或
  非规范 UUIDv4 同样 `400`。未知 `X-Loop-*` header、未知 query、未知 body 字段
  一律 `400 INVALID_REQUEST`。
- 所有响应 `Cache-Control: no-store`，`X-Request-ID` 为服务端生成的 UUID，错误体
  `correlationId` 与之相等。

## 2. 前置条件：必须先激活 V2 资料

社区与社交图的所有写操作（申请社区、加入、退出、治理、关注、屏蔽）都要求当前
账号已经完成 `POST /v2/profile/loop-id`（`profileStatus === "active"`）。否则返回：

```json
{
  "code": "PROFILE_ACTIVATION_REQUIRED",
  "category": "conflict",
  "retryable": false,
  "userMessageKey": "errors.profile.activationRequired",
  "correlationId": "…",
  "detailsSafe": null,
  "providerReferenceSafe": null
}
```

前端应把用户送到 `loop-id-setup` 完成激活后重试，不要当成服务不可用。

另外，`privacy_preferences_v2.discoverable` 默认 `false`（决策 0030 fail-closed）。
**未开启 `discoverable` 的账号无法被关注、也不会出现在 `domain=users` 搜索结果里**
（统一返回 `404 NOT_FOUND`，不可枚举）。`connections` 与 `blocklist` 页面要在文案里
提示用户：想被别人找到需要在隐私设置里打开"可被发现"。
成员目录、取关、屏蔽不受此限制。

## 3. 通用投影

### 身份投影（固定四字段）

所有涉及"另一个人"的地方都是同一个对象，**不下发 `profile_code`、钱包地址、
Privy ID、Stream ID**：

```json
{
  "publicProfileId": "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
  "loopId": "LOOP-7HJKMNPQ",
  "alias": "frog_maxi",
  "avatarRef": "avatar:preset/people-03"
}
```

`publicProfileId` 是唯一可以作为命令目标的稳定 ID。`alias` 与 `avatarRef` 可为
`null`，此时用 `loopId` 兜底显示，禁止显示"—"以外的编造值。

### unavailable 投影

```json
{ "status": "unavailable", "reasonCode": "STREAM_PRESENCE_NOT_CONNECTED" }
```

出现该对象的字段一律显示 unavailable 说明，**不显示 0、不显示假数据**。本模块
用到的 `reasonCode`：

| reasonCode                         | 出现位置                                           |
| ---------------------------------- | -------------------------------------------------- |
| `STREAM_UNREAD_NOT_CONNECTED`      | `home.unread`                                      |
| `STREAM_VOICE_NOT_CONNECTED`       | `home.liveVoice`                                   |
| `STREAM_PRESENCE_NOT_CONNECTED`    | `community.onlineCount`、`members.counts.online`   |
| `MINING_FORMULA_BASELINE_PENDING`  | `community.miningPower`、成员/关注行 `miningPower` |
| `COMMUNITY_ANNOUNCEMENTS_DEFERRED` | `community.announcements`                          |
| `COMMUNITY_LINKS_DEFERRED`         | `community.officialLinks`                          |
| `MESSAGE_PREVIEW_DEFERRED`         | `message-requests[].preview`                       |
| `AI_MODERATION_DEFERRED`           | `message-requests[].aiModeration`                  |
| `ASSET_REGISTRY_DEFERRED`          | `search?domain=assets`                             |
| `LAUNCH_MODULE_DEFERRED`           | `search?domain=launch`                             |
| `DAPP_DIRECTORY_DEFERRED`          | `search?domain=dapps`                              |
| `REFERRAL_GRAPH_DEFERRED`          | `referral.edges`                                   |
| `INVITE_CODE_DEFERRED`             | `referral.inviteCode`                              |

### 社区投影

```json
{
  "communityId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "name": "Frog Holders",
  "slug": "frog-holders",
  "description": null,
  "logoRef": "avatar:preset/community-03",
  "verificationStatus": "verified",
  "boundAssetKey": null,
  "memberCount": 128,
  "createdAt": "2026-09-07T01:00:00.000Z",
  "configVersion": "communityV1"
}
```

- `verificationStatus`：`pending | verified | rejected`。只有 `verified` 显示
  验证 stamp；`pending` 在 `community-discover` 里显示"审核中"，且只有申请人
  自己和已加入者能看到。
- `boundAssetKey`：`null` 表示未绑定资产 → **`community-profile` 不渲染 Token
  Card，显示"未绑定资产"**。非 `null` 时是 `eip155:<chainId>:<0x 小写地址>`，
  D10 之前后端不解析它，前端也不得据此展示价格、市值、持有人等任何事实。
- `memberCount` 来自 PostgreSQL，是唯一可信的成员数字。

### 分页 cursor

列表返回 `nextCursor`（`string | null`）。规则：

- cursor 绑定到"当前账号 + 该路由 + 该筛选组合"，换账号、换路由、换筛选、
  过期（600 秒）都返回 `400 INVALID_REQUEST` → 前端重新从第一页拉取。
- **`cursor` 与 `limit` 互斥**：翻页时只传 `cursor`（页大小已经编码在里面），
  同时传会 `400`。

## 4. 接口清单

### 4.1 `GET /v2/community/home` — `community` 页

无 query。

```json
{
  "joined": {
    "items": [{ "community": { … }, "membership": { "role": "owner", "status": "active", "joinedAt": "…" } }],
    "truncated": false
  },
  "discover": [{ … }],
  "unread": { "status": "unavailable", "reasonCode": "STREAM_UNREAD_NOT_CONNECTED" },
  "liveVoice": { "status": "unavailable", "reasonCode": "STREAM_VOICE_NOT_CONNECTED" },
  "freshness": { "observedAt": "2026-09-08T01:00:00.000Z", "source": "database" },
  "recommendation": { "recommendationId": "…", "ruleVersion": "rule:verified-members-v1" },
  "contractVersion": "2.0"
}
```

`discover` 最多 5 条，只含 `verified` 且当前账号未加入的社区。
`joined.truncated === true` 表示已加入的社区超过本聚合承载量，"查看全部"要走
`GET /v2/communities?membership=joined`（游标分页）。主卡文案只能用
`joined.items.length` 与 `memberCount` 这类真实数字，没有数字时显示 `—`。
消息面板的未读/语音/陌生人请求条目在 D7 之前显示 unavailable。

### 4.2 `GET /v2/communities` — `community-discover` 页

| query          | 取值                  | 默认       |
| -------------- | --------------------- | ---------- |
| `sort`         | `members` \| `newest` | `members`  |
| `verification` | `verified` \| `all`   | `verified` |
| `membership`   | `all` \| `joined`     | `all`      |
| `limit`        | 1–50                  | 20         |
| `cursor`       | 上一页 `nextCursor`   | —          |

四个 seg 只有"成员最多"（`sort=members`）与"新社区"（`sort=newest`）可用；
"算力最高""增长最快""讨论最多"没有后端，seg 置灰并解释原因（D19/D7）。
`verification=all` 额外包含调用者自己创建或已加入的非 verified 社区；
`membership=joined` 把结果收窄到调用者自己的社区，供 `community` 首页
"查看全部已加入"使用。

响应 `{ items[], nextCursor, recommendation, contractVersion }`。
`recommendation.ruleVersion` 固定 `rule:verified-members-v1`，前端如展示"推荐
依据"必须引用它，不得自称算法推荐。

### 4.3 `POST /v2/communities` — 申请社区

写 header + body：

```json
{
  "name": "Frog Holders",
  "slug": "frog-holders",
  "description": null,
  "logoRef": "avatar:preset/community-03",
  "boundAssetKey": null
}
```

五个字段全部必填（可为 `null` 的是后三个）。`name` 1–40 码点、与别名同一套字符
安全与保留词规则；`slug` `^[a-z0-9-]{3,32}$` 且全局唯一；`description` ≤280 码点；
`logoRef` 只接受 `avatar:preset/community-01..12`；`boundAssetKey` 形如
`eip155:56:0x…`（服务端转小写）。

成功 `201`，返回社区资源，`verificationStatus` 恒为 `pending`，申请人即 owner。
**API 没有自助认证路径**，`verified` 只能由运维脚本设置。

错误：`422 ALIAS_RESERVED`（名称撞保留词）、`422 ALIAS_BLOCKED`（撞运营屏蔽词）、
`409 RESOURCE_CONFLICT`（slug 已被别的社区占用，提示用户换一个）、
`422 VALIDATION_FAILED`（归一化后长度越界）、
`400 INVALID_REQUEST`（字段形状不合法）、`409 PROFILE_ACTIVATION_REQUIRED`。

### 4.3b `PATCH /v2/communities/{communityId}` — 编辑社区资料（owner 专属）

写 header + 部分字段 body（至少一个，未出现的字段不变）：

```json
{
  "name": "Frog Holders",
  "description": "Frogs only",
  "logoRef": null,
  "boundAssetKey": null
}
```

校验规则与创建一致。`slug` 与 `verificationStatus` **不可通过本接口修改**
（出现在 body 里 → `400 INVALID_REQUEST`；空 body 同样 `400`）。仅 owner 可调用，
admin/member → `403 PERMISSION_DENIED`。成功返回 4.4 的社区资源，服务端写一条
`community_profile_updated` 审计。

### 4.4 `GET /v2/communities/{communityId}` — `community-profile` 页

```json
{
  "community": { … },
  "viewer": {
    "membership": { "role": "member", "status": "active", "joinedAt": "…" },
    "canInviteAdmin": false,
    "canMute": false,
    "canBan": false
  },
  "miningPower": { "status": "unavailable", "reasonCode": "MINING_FORMULA_BASELINE_PENDING" },
  "onlineCount": { "status": "unavailable", "reasonCode": "STREAM_PRESENCE_NOT_CONNECTED" },
  "announcements": { "status": "unavailable", "reasonCode": "COMMUNITY_ANNOUNCEMENTS_DEFERRED" },
  "officialLinks": { "status": "unavailable", "reasonCode": "COMMUNITY_LINKS_DEFERRED" },
  "contractVersion": "2.0"
}
```

`viewer.membership === null` 表示未加入（显示"加入"按钮）。`status === "muted"`
表示被禁言，`banned` 表示被封禁。

### 4.5 `POST /v2/communities/{id}/join` / `DELETE /v2/communities/{id}/membership`

都是写接口（带 `Idempotency-Key`，无 body），返回同 4.4 的社区资源。

- 重复 join 幂等成功；被封禁账号 join 返回 `403 PERMISSION_DENIED`。
- owner 退出返回 `403 PERMISSION_DENIED`（必须先转让）；本来就不是成员返回
  `409 DATA_STALE`。

### 4.6 `GET /v2/communities/{id}/members` — `community-members` 页

| query    | 取值                                    | 默认  |
| -------- | --------------------------------------- | ----- |
| `role`   | `all` \| `owner` \| `admin` \| `banned` | `all` |
| `q`      | 成员别名前缀，1–40 码点                 | —     |
| `limit`  | 1–50                                    | 20    |
| `cursor` | 上一页 `nextCursor`                     | —     |

```json
{
  "community": { … },
  "viewer": { "membership": { … }, "canInviteAdmin": true, "canMute": true, "canBan": true },
  "counts": {
    "all": 128,
    "owner": 1,
    "admin": 3,
    "online": { "status": "unavailable", "reasonCode": "STREAM_PRESENCE_NOT_CONNECTED" }
  },
  "items": [
    {
      "profile": { … },
      "role": "owner",
      "status": "active",
      "joinedAt": "…",
      "isSelf": false,
      "actions": [],
      "miningPower": { "status": "unavailable", "reasonCode": "MINING_FORMULA_BASELINE_PENDING" }
    }
  ],
  "nextCursor": null,
  "contractVersion": "2.0"
}
```

排序固定 owner → admin → member，同组按 `joinedAt` 升序。seg 计数用
`counts.all/owner/admin`，"在线"seg 禁用。

**`role=banned`（解封入口，2026-09-08 新增）**：`all`/`owner`/`admin` 三种视图
只列 `status` 为 `active`/`muted` 的成员，**不含被封禁者**；要拿到被封禁成员，
必须显式传 `role=banned`，此时 `items[].status` 全部是 `"banned"`。该视图只对
`viewer.canBan === true`（owner/admin）开放，其他调用者返回
`403 PERMISSION_DENIED`。`counts.all/owner/admin` 始终是**非封禁**目录的计数，
不随 `role=banned` 改变（被封禁者不计入），所以"已封禁"seg 不要显示计数徽标，
用翻页结果本身呈现。cursor 与 `role` 绑定，切换 seg 必须丢弃旧 cursor。

**`q` 成员搜索（2026-09-10 新增，决策 0040）**：可选参数，只按**成员别名前缀**
匹配，永远不是子串匹配，也不搜聊天内容、`loopId` 或钱包地址。原始文本先去首尾
空白，再按 NFKC 归一化、转小写、把连续 ASCII 空格折成一个，归一化后必须是
**1–40 个码点**；含控制字符、格式字符（含零宽）、代理项、行/段分隔符的一律
`400 INVALID_REQUEST`。`%`、`_`、`\` 按字面量匹配，不当通配符。没有别名的成员
（`profile.alias === null`）永远不会被命中。

- 归一化与后端 `user_profiles.alias_search_key` 用的是同一个函数
  （`unicode17_nfkc_lower_ws_v1`），所以 `FRO`、`ｆｒｏ`、`  fro  ` 命中同一批人。
- `counts.all/owner/admin` **不随 `q` 变化**，始终是整个非封禁目录的计数；空结果
  只看 `items.length === 0`，不要用 counts 判断。
- `q` 与 `role`、`limit`、`cursor` 可共存。**cursor 同时绑定 `q`**：改了 `q`
  （包括加上或去掉 `q`）后继续用旧 cursor 一律 `400 INVALID_REQUEST`，客户端每次
  改查询词必须丢弃旧 cursor 从第一页重新拉。大小写与首尾空白不同但归一化后相同的
  查询词算同一个 `q`，旧 cursor 仍然有效。
- 带 `q` 的请求消耗与 `GET /v2/search` 同一个公共别名搜索配额（每账号 30/分钟、
  每 IP 60/分钟、每账号 300/天），超限 `429 RATE_LIMITED`；不带 `q` 的普通目录
  翻页不计入配额。客户端必须做 300ms 防抖 + 单飞，不要按键即发。
- 服务端未配置配额密钥时，带 `q` 的请求 `503 CAPABILITY_UNAVAILABLE`（fail
  closed），不带 `q` 的目录仍然可用。

`q` 的完整错误码：`400 INVALID_REQUEST`（长度/字符/cursor 不匹配）、
`401 AUTH_REQUIRED|AUTH_INVALID`、`403 PERMISSION_DENIED`（只在 `role=banned`）、
`404 NOT_FOUND`、`429 RATE_LIMITED`、`503 CAPABILITY_UNAVAILABLE`。

`isSelf === true` 的那一行不可导航。

**`items[].actions` —— 每行的治理动作清单（2026-09-14 新增，必填字段）**

`actions` 是**这一行**当前可执行的治理动作，服务端按 4.7 的 actor × 动作 ×
目标角色权限矩阵，再叠加目标当前状态的前置条件（与写接口执行的是同一对判断）
逐行算出。取值来自固定枚举：

`"assignAdmin"` | `"revokeAdmin"` | `"transferOwnership"` | `"mute"` |
`"unmute"` | `"ban"` | `"unban"`

顺序固定为上表顺序，数组元素不重复。**前端只渲染这个清单，不得再自行推导任何
一个动作的可用性**：

- 空数组 = 这一行不提供任何治理动作。owner 行、`isSelf === true` 的行、
  `profile.publicProfileId === null` 的行、以及权限矩阵不允许的组合（例如
  admin 看另一个 admin）都会返回 `[]`，前端不需要也不应该再写这些判断。
- 被封禁的行只会返回 `["unban"]`。
- 状态前置条件已经算进去了：已禁言的行不会出现 `"mute"`，只会出现 `"unmute"`；
  非活跃成员不会出现 `"transferOwnership"`。
- 动作名到写接口的映射：`assignAdmin` → `POST .../role {"role":"admin"}`，
  `revokeAdmin` → `{"role":"member"}`，`transferOwnership` → `{"role":"owner"}`，
  `mute`/`unmute` → `POST`/`DELETE .../mute`，`ban`/`unban` →
  `POST`/`DELETE .../ban`。
- 这是**投影而不是授权**：写接口仍会用同一张矩阵重新校验。清单只保证前端不再
  给出注定 `403` 的入口。

`viewer.canInviteAdmin/canMute/canBan` 是**观察者级**标记（"这个人在本社区里
是否拥有某项权限"），不带目标维度，只用于决定是否显示"已封禁"seg
（`viewer.canBan`）这类页面级入口。**不要用它们决定任何一行的动作**——之前正是
这么做才让 admin 对另一个 admin 显示了禁言/封禁，点下去必然 403。

成员行的 `profile.publicProfileId` 可能为 `null`（该成员没有资料行）：这种行仍会
列出并计入 `counts`，保证计数与可翻页行数一致，但 **不可作为任何治理动作的目标**，
此时 `actions` 恒为 `[]`，用 `loopId` 显示。

### 4.7 治理写接口

| 方法     | 路径                                                  | body       | 语义                                        |
| -------- | ----------------------------------------------------- | ---------- | ------------------------------------------- |
| `POST`   | `/v2/communities/{id}/members/{publicProfileId}/role` | `{"role"}` | `admin` 任命 / `member` 撤销 / `owner` 转让 |
| `POST`   | `/v2/communities/{id}/members/{publicProfileId}/mute` | 无         | 禁言                                        |
| `DELETE` | `/v2/communities/{id}/members/{publicProfileId}/mute` | 无         | 解除禁言                                    |
| `POST`   | `/v2/communities/{id}/members/{publicProfileId}/ban`  | 无         | 封禁                                        |
| `DELETE` | `/v2/communities/{id}/members/{publicProfileId}/ban`  | 无         | 解除封禁 = 恢复为活跃成员                   |

全部返回 4.6 的成员列表首页，前端直接用它刷新页面。

**封禁 / 解封的成员资格语义（2026-09-08 修订）**：

- 封禁 **不删除**成员行：成员保持在库里，`status` 变成 `banned`，`role` 归为
  `member`，`joinedAt` 不变；被封禁者自己读 `GET /v2/communities/{id}` 仍能看到
  `viewer.membership.status === "banned"`。默认成员目录不含这一行，只有
  `role=banned` 视图能看到。后端同时把该账号从社区官方 Stream 频道移除。
- 解封 **恢复成员资格**：该行变回 `role: "member"`, `status: "active"`，
  `joinedAt` 仍是最初加入时间（不会被重置），**不需要**重新 join；后端同时把该
  账号重新加回官方频道（频道尚未 provisioned 时该动作为空操作）。解封后
  `viewer.membership` 不再是 `null`。
- 封禁与解封都是**社区范围**的：都不改动个人关注图（关注/取关只受
  `POST /v2/blocks` 影响）。

（此前的行为是"解封=删除成员行"，前端必须按上面的新语义实现解封 UI。）

权限矩阵（服务端唯一真相，前端只做可见性）：

| 操作者 \ 动作 | 任命 admin | 撤销 admin | 转让 owner    | 禁言          | 解除禁言      | 封禁          | 解除封禁      | 编辑资料 | 自己退出 |
| ------------- | ---------- | ---------- | ------------- | ------------- | ------------- | ------------- | ------------- | -------- | -------- |
| `owner`       | member     | admin      | admin, member | admin, member | admin, member | admin, member | admin, member | 是       | 否       |
| `admin`       | —          | —          | —             | member        | member        | member        | member        | 否       | 是       |
| `member`      | —          | —          | —             | —             | —             | —             | —             | 否       | 是       |

单元格是"可以作用的目标角色"。owner 永远不能成为任何治理动作的目标；
自己不能对自己执行治理动作；被封禁的操作者没有任何权限；被禁言的操作者
保留治理权限（禁言只影响聊天）。

这张表是服务端的唯一真相，**前端不需要复刻它**：4.6 的 `items[].actions`
就是这张表按行算好的结果，前端照单渲染即可。

错误：越权 `403 PERMISSION_DENIED`；状态不允许（禁言已禁言者、撤销非 admin、
解封未封禁者、转让给非活跃成员）`409 DATA_STALE` → 刷新后重试；目标不在该
社区 `404 NOT_FOUND`。所有动作走 `LoopSheet` 二次确认。

### 4.8 `POST/DELETE /v2/connections/follow/{publicProfileId}` — `connections` 页

写 header，无 body。返回：

```json
{ "profile": { … }, "viewerFollows": true, "contractVersion": "2.0" }
```

关注是单向的、不需要对方同意。目标不存在、未激活资料、未开启 `discoverable`、
是自己、或与自己存在任一方向的屏蔽 → 统一 `404 NOT_FOUND`（不可枚举）。
取关幂等，不做上述可发现性检查。

### 4.9 `GET /v2/connections`

| query       | 取值                       | 默认        |
| ----------- | -------------------------- | ----------- |
| `direction` | `following` \| `followers` | `following` |
| `limit`     | 1–50                       | 20          |
| `cursor`    | 上一页 `nextCursor`        | —           |

```json
{
  "direction": "following",
  "items": [{ "profile": { … }, "createdAt": "…", "viewerFollows": true, "miningPower": { … } }],
  "counts": { "following": 24, "followers": 108 },
  "nextCursor": null,
  "contractVersion": "2.0"
}
```

两个 seg 的计数用 `counts`。行内算力显示 unavailable。被自己屏蔽的账号不出现
在列表里。行点击进入 `dm`（D7 之前 `dm` 是 unavailable 占位并给出说明）。

### 4.10 `GET/POST/DELETE /v2/blocks` — `blocklist` 页

- `GET /v2/blocks?kind=user&limit=&cursor=`：

```json
{
  "kind": "user",
  "items": [{ "kind": "user", "stableId": "…", "profile": { … }, "reasonCode": "user_request", "createdAt": "…" }],
  "counts": { "user": 2 },
  "nextCursor": null,
  "contractVersion": "2.0"
}
```

- `POST /v2/blocks` / `DELETE /v2/blocks` body `{"kind": "user", "stableId": "<publicProfileId>"}`，
  返回 `{ "block": … | null, "contractVersion": "2.0" }`。
- **`kind=contract` 与 `kind=domain` 在三个方法上都返回
  `503 CAPABILITY_UNAVAILABLE`**：两个 seg 置灰并解释，不显示任何条目。
- 屏蔽优先于关注与 DM。本步在**读侧**生效：同一事务里删除双向关注边，并让对方
  在关注/粉丝列表、用户搜索、陌生人请求列表中消失；跨屏蔽 `accept` 陌生人请求
  返回 `409 DATA_STALE`（不会建立关系）。**写侧拦截（阻止对方发起会话/消息）在
  D7 的 v2 发送接口实现**，本步不改 v1 创建路径。
- 解除屏蔽**不会**恢复关注，需要重新关注。
- 封禁成员是社区范围的动作，**不会**改变个人关注关系；只有 `POST /v2/blocks`
  会断开关注边。
- `reasonCode`：`user_request`（用户手动屏蔽）或 `message_request_report`
  （举报陌生人请求产生）。

### 4.11 `GET /v2/message-requests` + 决策 — `dm-requests` 页

```json
{
  "items": [
    {
      "messageRequestId": "…",
      "profile": { … },
      "createdAt": "…",
      "expiresAt": "…",
      "preview": { "status": "unavailable", "reasonCode": "MESSAGE_PREVIEW_DEFERRED" },
      "aiModeration": { "status": "unavailable", "reasonCode": "AI_MODERATION_DEFERRED" }
    }
  ],
  "nextCursor": null,
  "contractVersion": "2.0"
}
```

消息正文预览与 AI 巡查标记本步没有后端，整块显示 unavailable，**不得渲染原型
里的示例文案与"AI 巡查标记为诈骗"卡片**。

`POST /v2/message-requests/{messageRequestId}/decision`，body
`{"decision": "accept" | "ignore" | "report"}`：

```json
{
  "messageRequestId": "…",
  "decision": "report",
  "blocked": true,
  "contractVersion": "2.0"
}
```

- `accept`：接受（后端在 V1 好友表上建立关系）。任一方向存在屏蔽时返回
  `409 DATA_STALE`，不会建立关系。
- `ignore`：拒绝并进入 24 小时冷却。
- `report`：拒绝 + 屏蔽发起人 + 写审计，同一事务；`blocked: true`。成功后 Toast
  "已举报并屏蔽"，并从列表移除。
- 已处理或已过期 → `409 DATA_STALE`；不存在或不属于当前账号 → `404 NOT_FOUND`。

**`POST /v2/message-requests`（2026-09-08 新增，发起陌生人请求）**

body `{"targetPublicProfileId": "…"}`，带 `Idempotency-Key`，返回 200，
响应就是上面 `items[]` 的**单条**加 `contractVersion`：

```json
{
  "messageRequestId": "…",
  "profile": { … },
  "createdAt": "…",
  "expiresAt": "…",
  "preview": { "status": "unavailable", "reasonCode": "MESSAGE_PREVIEW_DEFERRED" },
  "aiModeration": { "status": "unavailable", "reasonCode": "AI_MODERATION_DEFERRED" },
  "contractVersion": "2.0"
}
```

- `profile` 是**对方（收件人）**的身份投影；列表接口里的 `profile` 是发起人，
  因为那是收件人视角。两者字段完全一致。
- 准入与「关注」完全一致：对方资料已激活、`discoverable=true`、双方均未屏蔽、
  不能是自己。**任何不可达都返回同一个 `404 NOT_FOUND`**（不可枚举），前端不要
  据此推断对方是否存在。
- 已是好友、任一方向已有 pending 请求、处于 24 小时拒绝冷却 → `409 DATA_STALE`，
  提示刷新后再试。
- 同一个 `Idempotency-Key` 重放返回**首次创建的那条**请求（即使对方已处理）。
- 请求有效期 7 天（`expiresAt`），由后端固定，前端不要自己算。
- 不要再调用 v1 `POST /v1/friend-requests`：它按 v1 隐私表判定资格，V2 账号一律
  拿到 404。

### 4.12 `GET /v2/search` — `search` 页（`search` 模块）

| query          | 取值                                                        | 默认       |
| -------------- | ----------------------------------------------------------- | ---------- |
| `domain`       | `users` \| `communities` \| `assets` \| `launch` \| `dapps` | 必填       |
| `q`            | 归一化后 2–40 码点的前缀                                    | 必填       |
| `verification` | `verified` \| `all`（仅 `communities`）                     | `verified` |
| `limit`        | 1–20                                                        | 20         |
| `cursor`       | 上一页 `nextCursor`                                         | —          |

```json
{
  "domain": "communities",
  "status": "available",
  "reasonCode": null,
  "results": [
    {
      "resultType": "community",
      "stableId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "displaySnapshot": {
        "title": "Frog Holders",
        "subtitle": "frog-holders",
        "avatarRef": "avatar:preset/community-03",
        "memberCount": 128,
        "verificationStatus": "verified"
      },
      "destination": { "kind": "communityProfile" }
    }
  ],
  "nextCursor": null,
  "contractVersion": "2.0"
}
```

- `assets` / `launch` / `dapps` 返回 **HTTP 200** 且
  `{"status": "unavailable", "reasonCode": …, "results": [], "nextCursor": null}`。
  三个 seg 可切换但显示 unavailable 说明。
- `users`：`resultType: "user"`，`stableId` 是 `publicProfileId`，
  `displaySnapshot.title` 是 alias（无 alias 时是 loopId），`subtitle` 是 loopId，
  `memberCount`/`verificationStatus` 为 `null`。只返回已激活且 `discoverable`
  的账号，排除双向屏蔽。
- `communities`：只返回 `verified`；`verification=all` 只对当前账号已加入的社区
  额外放行。匹配 name 前缀或 slug 前缀。
- **必须用 `destination.kind` 导航**（`publicProfile` / `communityProfile`），
  禁止从 `displaySnapshot` 文案或 ticker 拼路由。
- 前缀太短、含非法字符、未知 `domain` → `400 INVALID_REQUEST`。
- 与 `GET /v1/discovery/users` 共用同一个公共搜索配额桶，超限
  `429 RATE_LIMITED`（`retryable: true`）。三个 unavailable 域不消耗配额。
- 聊天内容不进入本域。

### 4.13 `GET /v2/mining/referral/rules` — `referral` 页（只读）

> 前端第 7 步（S7）起 `referral` 页改读 `GET /v2/referral`（见
> `docs/frontend-v2-mining-api.md` §3.7 与 §4）。本接口保留兼容，形状不变。

```json
{
  "configVersion": "referralRulesV1",
  "effectiveAt": "2026-09-01T00:00:00.000Z",
  "appliesTo": "miningPower",
  "levels": [
    {
      "level": 1,
      "boostPercent": "10",
      "descriptionKey": "mining.referral.level1"
    },
    {
      "level": 2,
      "boostPercent": "5",
      "descriptionKey": "mining.referral.level2"
    },
    {
      "level": 3,
      "boostPercent": "3",
      "descriptionKey": "mining.referral.level3"
    },
    {
      "level": 4,
      "boostPercent": "2",
      "descriptionKey": "mining.referral.level4"
    },
    {
      "level": 5,
      "boostPercent": "1",
      "descriptionKey": "mining.referral.level5"
    }
  ],
  "edges": { "status": "unavailable", "reasonCode": "REFERRAL_GRAPH_DEFERRED" },
  "inviteCode": {
    "status": "unavailable",
    "reasonCode": "INVITE_CODE_DEFERRED"
  },
  "contractVersion": "2.0"
}
```

该接口挂在 `community` 模块下（没有 `mining` 模块）。`boostPercent` 是十进制
字符串，不要转成 JS number 再格式化。五级比例卡与深度说明用 `levels` 渲染，
关系数（L1–L5 人数）与邀请码显示 unavailable，"邀请好友"按钮禁用。必须展示
"只计入 Mining Power，不是收入、佣金或返佣"提示。

## 5. 错误码汇总

| code                             | HTTP | 何时出现                                                  | 前端动作                       |
| -------------------------------- | ---- | --------------------------------------------------------- | ------------------------------ |
| `INVALID_REQUEST`                | 400  | 未知字段/header、非法 cursor、cursor+limit 同传、前缀太短 | 修正请求，列表回到第一页       |
| `AUTH_REQUIRED` / `AUTH_INVALID` | 401  | 缺失或无效 Privy Bearer                                   | 重新登录                       |
| `PERMISSION_DENIED`              | 403  | 越权治理、被封禁者加入、owner 退出                        | 显示无权限，不重试             |
| `POLICY_BLOCKED`                 | 403  | 产品策略拒绝（本步暂未使用）                              | 显示说明                       |
| `NOT_FOUND`                      | 404  | 社区/成员/请求不存在；目标不可发现或被屏蔽；模块未启用    | 统一"找不到"，不可枚举         |
| `ACCOUNT_BOOTSTRAP_REQUIRED`     | 409  | Privy 主体没有 LOOP 账号                                  | 先 bootstrap                   |
| `PROFILE_ACTIVATION_REQUIRED`    | 409  | 账号未完成 LOOP ID 激活                                   | 跳 `loop-id-setup` 后重试      |
| `DATA_STALE`                     | 409  | 状态已变（已禁言/已处理/已过期/非成员）                   | 刷新后重新决定，禁止盲重试     |
| `IDEMPOTENCY_CONFLICT`           | 409  | 同一 key 配不同请求内容                                   | 换新 key 重发                  |
| `RESOURCE_CONFLICT`              | 409  | slug 已被别的社区占用                                     | 提示用户换 slug，不重试同值    |
| `VERSION_CONFLICT`               | 409  | `X-Loop-Contract-Version` 不是 `2.0`                      | 升级客户端                     |
| `VALIDATION_FAILED`              | 422  | 归一化后长度越界                                          | 提示用户改内容                 |
| `ALIAS_RESERVED`                 | 422  | 社区名撞保留词                                            | 提示换名，不重试同名           |
| `ALIAS_BLOCKED`                  | 422  | 社区名撞运营屏蔽词                                        | 同上                           |
| `RATE_LIMITED`                   | 429  | 搜索配额耗尽                                              | 退避后重试                     |
| `CAPABILITY_UNAVAILABLE`         | 503  | 仓储/cursor 密钥未配置；`kind=contract\|domain`           | 显示 unavailable，不回退假数据 |
| `INTERNAL_ERROR`                 | 500  | 服务端异常                                                | 显示错误，可重试               |

## 6. 联调准备（两个账号）

1. 两个账号各自 `POST /v2/session/bootstrap` → `POST /v2/profile/loop-id` 激活。
2. 两个账号各自 `PUT /v2/profile/privacy` 设 `discoverable: true`（否则互相
   搜不到、关注不了）。
3. 账号 A `POST /v2/communities` 申请社区（得到 `pending`）。
4. 运维执行 `pnpm community:verify <communityId>`（`NODE_ENV=production` 会被
   拒绝），社区变 `verified`。
5. 账号 B `GET /v2/search?domain=communities&q=<前缀>` → `POST …/join`。
6. A 任命 B 为 admin → B 禁言第三个成员 → 成员越权 403 → 封禁后取关与 DM 请求
   被拒 → cursor 跨账号失效 → 关闭模块后 404。
