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
