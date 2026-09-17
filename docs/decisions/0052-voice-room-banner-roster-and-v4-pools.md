# 0052 · 语音房社区名、发言人/听众名单、新币发现列出 Uniswap V4 池（S32）

- 日期：2026-09-17
- 来源：用户 2026-09-17 三条裁决「需要加 / 需要加 / 列出来」；主代理任务单 S32-backend
- 范围：`GET /v2/voice-rooms/{id}` 与所有语音房命令响应的 `room` 块；新增 `GET /v2/voice-rooms/{id}/members` 名单端点与 `POST /v2/voice-rooms/{id}/speakers/{pid}/mute`；`GET /v2/market/new-pairs` 的 `items[]` 标识。不改 `/v1`、不改 Stream 角色权限。
- 基线：`integration/v2` = `28bd62a`
- **三条全部是破坏性契约变化**（必填键新增 / 字段改名），前端跟进前不能部署。

## 1. 语音房资源带社区名（`room.communityName`）

### 事实

前端顶部 banner 要印「正在语音房 · <社区名> · N 人在线」。房间资源只有 `communityId`，页面得再打一次 `GET /v2/communities/{id}` 才有名字。

### 裁决

| 项目 | 裁决                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 字段 | `room.communityName`（必填 string，1–512）。`voiceRoomResourceSchema` 与 `current` 内嵌的 body 共用一份 schema，所以 `GET …/current`、`GET /v2/voice-rooms/{id}` 和全部命令响应同时带上。               |
| 同源 | 每次读/写都在同一事务里从 `communities.name` 取值（`voiceRoomColumns` 的标量子查询，`insert … returning` 同样带），与 `GET /v2/communities/{id}` 的 `community.name` 同源同值；社区改名后下一次读即变。 |
| 不做 | 不复制到 `voice_rooms` 表、不加迁移；它是展示值，不是标识——关联仍用 `communityId`。                                                                                                                     |
| 前端 | `loop_v2_communication_codec.dart` 的 `room` 用 `strictMap` 精确键集合的，必须加 `communityName`，否则整个语音房快照判 invalid。                                                                        |

## 2. 发言人 / 听众名单（`GET /v2/voice-rooms/{id}/members`）

### 事实

原型 `voiceroom-full` 有「发言人 12 / 听众 3,238」名单；契约只给聚合计数与 viewer 自己的角色，host 无法「移出发言」——没有目标 `publicProfileId`。

### 裁决

| 项目         | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 端点         | `GET /v2/voice-rooms/{voiceRoomId}/members?role=speaker\|listener&limit=\|cursor=`。`role` 必填；`limit`（默认 50、上限 100）与 `cursor` 互斥；cursor 绑定 owner、路由 `voiceRoomMembers`、filter `${voiceRoomId}:${role}`（换视图续页 = `INVALID_REQUEST`）。读权限 = 社区非 banned 成员（与 `GET /v2/voice-rooms/{id}` 同）。                                                                                                |
| 数据源       | **只**读 `voice_room_members`（`state='joined'`，按 `role`），按 `(date_trunc('ms', joined_at), public_profile_id)` keyset 分页。host 不在任何视图。Stream session participants **不混入**——名单是「已加入（LOOP 授权意图）」，在线人数仍是房间资源的 `observed.participantCount`。                                                                                                                                            |
| 行           | `publicProfileId`（可 null，见隐私）、`display`、`role`、`joinedAt`、`handRaised`（有 pending 举手；speaker 恒 false）、`muted`（host 的 LOOP 侧静音意图；listener 恒 false）、`isSelf`、`commands[]`。                                                                                                                                                                                                                        |
| 显示/隐私    | 沿用挖矿榜规则（决策 0049）：`display` 是 `{kind:"alias", alias, publicProfileId, audience}` 或 `{kind:"anonymous", labelKey:"voiceRoom.member.anonymousMember"}`。`privacy_preferences_v2.anonymous_mode` 单独决定别人看到什么；本人永远看到自己的别名（开匿名时 `audience:"self"`）。**行顶层 `publicProfileId`**：host 视角恒非空（host 必须能对任何人下命令）；非 host 视角在匿名行为 `null`——匿名成员不可被其他成员寻址。 |
| `commands[]` | S17 做法：服务端按 viewer 角色 × 行状态算出可执行命令，写路径用同一谓词复核。host 视角：listener 行 `["invite_speaker"]`；speaker 行 `["remove_speaker","mute"]`，已静音则 `["remove_speaker"]`；房间非 live 或非 host 视角一律 `[]`。枚举：`invite_speaker`→`POST …/speakers/{pid}`、`remove_speaker`→`DELETE …/speakers/{pid}`、`mute`→`POST …/speakers/{pid}/mute`（新）。                                                  |
| 逐人静音     | 新路由 `POST /v2/voice-rooms/{id}/speakers/{pid}/mute`（host only，写头齐全）。LOOP 先提交 `voice_room_members.muted_at`（listener 目标或已静音 → `409 DATA_STALE`；host 自己 → `403`），写审计 `speaker_muted`，再对 Stream 同一 `muteUsers` 端点发一次 `user_ids:[目标]`（`providerSync` 如实报 `STREAM_CALL_MUTE_UNCONFIRMED`）。`mute-all` 现在也把全部 joined speaker 的 `muted_at` 置上，名单的 `muted` 与之一致。       |
| `muted` 语义 | **只是 host 的意图**，不是麦克风状态——Stream 对媒体状态权威，被静音者在设备上可自行开麦，LOOP 不知道。每次角色变化（邀请、移出、离开）清零；`voice_room_members_muted_role_check` 使 listener/host 不可能带静音。没有 unmute 命令（Stream 也不允许 host 替人开麦）。                                                                                                                                                           |
| 迁移         | `000029_v2_voice_room_member_mute`：`voice_room_members.muted_at timestamptz`（可空，无回填），两条 check；`voice_room_events_type_check` 加 `speaker_muted`。down 在存在 `speaker_muted` 审计时拒绝。                                                                                                                                                                                                                         |
| unavailable  | 无 `V2_CURSOR_HMAC_SECRET` 时，需要续页的响应 `503 CAPABILITY_UNAVAILABLE`（与社区目录一致，第一页不需要 codec 时照常返回）。通信模块未启用 → 路由不注册。                                                                                                                                                                                                                                                                     |

### 需要主代理决策

- **是否要 self-unmute 意图**：被 host 静音的发言人在设备上自行开麦后，名单的 `muted` 仍为 true 直到下一次角色变化。若产品要「已重新开麦」，需要一个本人可调用的 `DELETE …/speakers/{pid}/mute`（本步没做，避免超出任务单）。
- 举手队列 `GET …/hand-raises` 仍对所有成员发布完整 `profile`（0032 既有行为），与名单的匿名规则不一致；是否收敛，另议。
