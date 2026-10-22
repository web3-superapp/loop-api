# 0177 · 通知收件箱：毕业 / 勋章 / 好友申请写入方、未读数与全部已读（S286，2026-10-22）

## 1. Status

已实现（分支 `feat/S286-notification-inbox`，基线 `integration/v2` `78c5f72`）。迁移 `000098_notification_inbox_producers`。新路径 2 条：`GET /v2/notifications/unread-count`、`POST /v2/notifications/read-all`。新 env：`NOTIFICATION_INBOX_EMIT`（API 与 worker，默认 `off`）、`NOTIFICATION_INBOX_ENABLED`（worker，默认 `true`）、`NOTIFICATION_INBOX_INTERVAL_MS`（worker，默认 10000）。不改合约，不改 `/v1` 契约（`/v1/friend-requests` 只在同一事务里多写一行通知）。客户端收件箱页为 S287。

## 2. Context

- 需求方 2026-10-22 反馈第 10 条：没有统一的通知页，无法集中查看代币毕业、勋章铸造完成、好友申请等。
- 表 `public.notifications`（000020）只有安全事件、社区审核、价格提醒三个写入方；`launch.graduation` 类别无人写；勋章铸造、好友申请没有对应事件。
- 十个偏好类别被客户端合同锁死（`notif-settings`，`LoopNotificationCategory`），不能增减。
- 已发布 App 的 feed 解码器严格：`type` 必须是十个类别之一，未知值让整页解码失败；行键集合固定十个（`readAt` 已在其中）。推送 router 只认四键 payload（`type / entityRef / contextRoute / eventVersion: "1"`），未知 `type` 判为 malformed 丢弃。

## 3. Decision

### A. 存储：类别不变，加细分事件列

- `notifications.type` 继续存**偏好类别**（十选一，约束不变）；新列 `event_type`（可空，check 四值）存**细分事件**；旧写入方一律 `null`。
- feed / 单条已读返回的行 `type` = `event_type ?? type`。即新事件在 feed 中以细分值出现：`launch.graduated`、`launch.badge_minted`、`social.friend_request`、`social.friend_accepted`。不新增行键（不加 `category`），`readAt` 沿用既有键。
- 细分事件 → 类别（决定推送开关，写库不看偏好，与既有写入方一致：偏好只管推送）：

| 细分事件                 | 类别                | 理由                                                                                          |
| ------------------------ | ------------------- | --------------------------------------------------------------------------------------------- |
| `launch.graduated`       | `launch.graduation` | 「毕业通知」原意                                                                              |
| `launch.badge_minted`    | `launch.round`      | 「资格快照与开始提醒」：MEME v2 的共识勋章就是快照资格凭证（快照成员 = 持勋章者），比毕业贴切 |
| `social.friend_request`  | `community.mention` | 十类里唯一「直接冲着我」的社交类别（「@我的消息」）；公告/全部消息是群级别                    |
| `social.friend_accepted` | `community.mention` | 同上                                                                                          |

### B. 实体、路由与文案（每行 `payload` 带 `event`、`title`、`body` 与事实字段）

| 细分事件                 | 收件人                                                                                                                | `entityRef`                    | `contextRoute`     | `contextParams`       | 去重键                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------ | --------------------- | -------------------------------------------- |
| `launch.graduated`       | 该实例 `launch2_positions` 中 `curve_bought − curve_sold > 0` 或 `nft_held > 0` 的钱包对应的账号 + 项目方账号（去重） | `launch2Instance:<instanceId>` | `launch2-instance` | `{ instanceId }`      | `launch.graduated:<instanceId>`              |
| `launch.badge_minted`    | 铸造者（`launch2_nft_mints.payer_address`）对应的账号                                                                 | `launch2Instance:<instanceId>` | `launch2-instance` | `{ instanceId }`      | `launch.badge_minted:<instanceId>:<tokenId>` |
| `social.friend_request`  | 被申请人                                                                                                              | `friendRequest:<id>`           | `dm-requests`      | `{ friendRequestId }` | `social.friend_request:<friendRequestId>`    |
| `social.friend_accepted` | 申请人                                                                                                                | `friendRequest:<id>`           | `user-profile`     | `{ publicProfileId }` | `social.friend_accepted:<friendRequestId>`   |

- 钱包 → 账号：`account_wallets`（`address` 小写、`status = 'active'`，走 `account_wallets_active_address_idx`）。地址只用于查找，永不出现在通知里。没有 LOOP 账号的钱包不写。
- 路由用客户端 `LoopRouteManifest` 既有 slug：`launch2-instance`（`/launch2/instance?id=`）、`dm-requests`（`/chat/requests`，陌生人请求页）、`user-profile`（`/profile/user?id=`，对方主页）。
- 文案（服务端写一次中文，放 payload）：
  - 毕业：`title`「<项目名> 已毕业」；`body`「<项目名> 已于 YYYY-MM-DD HH:mm（北京时间）毕业，交易已迁入官方池 0xabcd…ef12。」；另有 `instanceId / projectName / graduatedAt / officialPoolId`。
  - 勋章：`title`「<项目名> 勋章 #<tokenId> 铸造完成」；`body`「你的共识勋章 #<tokenId> 已于 …（北京时间）上链确认。」；另有 `instanceId / projectName / tokenId / mintedAt / transactionHash`。
  - 好友申请：`title`「新的好友申请」；`body`「<申请人昵称> 请求添加你为好友」；另有 `friendRequestId / publicProfileId / alias`。
  - 好友接受：`title`「<昵称> 已接受你的好友申请」；`body`「你们已成为好友，现在可以开始私聊。」；另有 `friendRequestId / publicProfileId / alias`。
  - 昵称 = `user_profiles.alias`（缺省「有人」/「对方」）。项目名 = `launch2_instances.name`。

### C. 写入方与幂等

- **好友申请 / 接受**：`social-repository` 在 `sendFriendRequest` 新建申请、`decideFriendRequest` 接受的**同一事务**里插行（`on conflict (owner_user_id, dedupe_key) do nothing`）；幂等重放走既有 replay 分支不再插；拒绝不写。
- **毕业 / 勋章**：新 worker lane `notification_inbox`（默认开）。每轮：
  1. 取 `graduated_at is not null and inbox_graduation_settled_at is null` 的实例（`for update skip locked`，每批 20），写收件人行，置标记；
  2. 取 `inbox_settled_at is null and not removed` 的铸造（每批 200），写铸造者行，置标记；
  3. 标记 + 去重键双保险：重跑、标记丢失都不会写第二行。
  - 「上链确认」= launch2 索引 lane 已把 `NftMinted` / `Graduated` 落进读模型（与 App 其他 MEME v2 读面同一口径）。重组移除（`removed`）的铸造不处理、标记不置，若重新出现仍会通知；已写的通知不撤回。
  - **新鲜度**：事实在 lane 首次看到时已超过 24 小时 → 只置标记不写行（防止新环境从头索引时刷屏）；实例 `listing = hidden` → 同样只置标记。
- **不回填**：迁移把既有毕业实例、既有全部铸造预先置标记；好友申请从上线后起算。

### D. 开关 `NOTIFICATION_INBOX_EMIT`（默认 `off`）

- `off`：四种细分事件**照常写库**，但 feed（`items` 与 `unreadCount`）、`unread-count`、`read-all`、单条已读一律看不见（单条已读返回 404），worker 不推送。老客户端字节级无变化（新 `type` 值不出现）。
- `on`：上述全部可见；worker 推送新鲜行。
- API 与 worker 各读一次同名变量，须同时切换。

### E. 推送

- 新推送事件 4 个（`push_deliveries` 约束同步放宽）：`launch_graduated`、`launch_badge_minted`、`social_friend_request`、`social_friend_accepted`；各自按 §A 类别受偏好控制，非强制。payload 仍是四键，不加第五键：`type` = 推送事件名，`entityRef` / `contextRoute` 同 feed 行，`eventVersion: "1"`。
- 投递在 `notification_inbox` lane 里统一做（好友事件由 API 写库、lane 推送）：只认 `push_settled_at is null` 且建于 30 分钟内的行，先置 `push_settled_at` 再发（至多一次，失败不重试，feed 行仍是记录）；更老的行每轮直接置 settled 不发。`eventKey = inbox:<dedupeKey>`。
- 本机/staging 无 Firebase 凭据时 `push` 为 null，lane 只写行不发（feed 照常）。设备端需要 4 组本地化键 `push.launchGraduated.*`、`push.launchBadgeMinted.*`、`push.socialFriendRequest.*`、`push.socialFriendAccepted.*`（S287 客户端补；开关 on 前必须到位）。

### F. 新接口

- `GET /v2/notifications/unread-count` → `200 { unread: integer ≥ 0, observedAt: ISO 8601 }`。鉴权与读头同 feed（Bearer、`X-Loop-Contract-Version: 2.0`、`X-Loop-Client-Version`，拒绝 `Idempotency-Key`、拒绝 query/body）。一条计数查询，走既有部分索引 `notifications_owner_unread_idx (owner_user_id) where read_at is null`（不新建索引）。与 feed 的 `unreadCount` 同口径。
- `POST /v2/notifications/read-all` → `200 { marked: integer ≥ 0 }`。写头（`Idempotency-Key` UUIDv4 必带，但同单条已读一样不绑定持久命令：天然幂等，重复返回 `marked: 0`）。只标记当前可见的未读行。
- 响应形状严格按 S287 任务单（不加 `contractVersion`）。错误码集同 feed / 单条已读（`INVALID_REQUEST`、`AUTH_REQUIRED/AUTH_INVALID`、`ACCOUNT_BOOTSTRAP_REQUIRED`、契约版本头不是 `2.0` 时 `409 VERSION_CONFLICT`、`CAPABILITY_UNAVAILABLE` 等），通知运行时缺失 → `503 CAPABILITY_UNAVAILABLE`。

### G. 迁移 000098

- `notifications.event_type`（check 四值或 null）、`notifications.push_settled_at`（check：仅细分事件可置）、部分索引 `notifications_inbox_push_pending_idx`。
- `launch2_instances.inbox_graduation_settled_at` + 部分索引；`launch2_nft_mints.inbox_settled_at` + 部分索引；既有行预置标记（不回填）。
- `push_deliveries_event_type_check` 加 4 个新事件。
- `down`：存在细分事件行或新事件推送记录时拒绝回滚。

## 4. Consequences

- 发布顺序：服务端可直接上线（开关 off，只多写库、多两条新路由）；S287 客户端把四个新 `type` 值加入 feed codec、接入两条新路由与推送本地化键并发版；全部受支持版本能解码后，API 与 worker 同时把 `NOTIFICATION_INBOX_EMIT` 切 `on`。
- 开关 off 期间写入的行在切 on 后立即出现在收件箱（它们本来就在库里）；推送只补发 30 分钟内的。
- 毕业时持仓判定用读模型的曲线净买入与勋章持有数，不含仅通过转账获得 MEME 的地址。
- 收件人是毕业时刻读模型的快照；之后才买入的人不会收到。
- 证据：`test/notification-inbox.integration.test.ts`（真实 PostgreSQL：迁移列/约束/索引；毕业收件人 = 净持仓 + 勋章 + 项目方、排除净零与无账号钱包、重跑与标记丢失不重复；过期与隐藏实例只置标记；勋章每 tokenId 一行、重组行不处理、过期与无账号只置标记、标记丢失不重复；好友申请/接受各一行、幂等重放不重复、拒绝不写；feed/未读数/全部已读的开关可见性；推送认领至多一次与过期 settle）、`test/notification-inbox-service.test.ts`（类别映射与四键、文案与去重键、开关 off 不认领、无推送通道不认领、on 时四键指针与 eventKey、生产者异常记日志不中断、满批 saturated、worker 退避）、`test/v2-notifications-routes.test.ts`（开关 off 时 feed/unreadCount/unread-count/read-all/单条已读都看不见新类型，on 时可见；两条新路由的头、body、query、鉴权与错误体七字段）。
