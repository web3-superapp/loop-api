# 0051 · 语音房人数：在线参与者 ≠ 被授权成员 ≠ LOOP 角色意图（S31c）

- 日期：2026-09-17
- 来源：用户 2026-09-17 真机原话「我已加入语音房，但是人数还是 0」；主代理任务单 S31c
- 范围：`GET /v2/voice-rooms/{id}`、`GET /v2/communities/{id}/voice-rooms/current`、语音房全部命令响应的 `participants` 块；`StreamCallGateway` 新增一次只读 `getCall` 观测。不加表、不改 migration、不改 `/v1`、不改 Stream 角色权限。
- 基线：`integration/v2` = `bccbf9d`

## 1. 事实（开发库复现，harness 以 `cy` 身份走产品路径）

| 观察                                                                       | 结论                                                                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `builders-guild` 房 `0775e48b…` 复现前 `voice_room_members` 只有 host 一行 | 手机端从未对该房发出 `POST /v2/voice-rooms/{id}/join`（无 `member_joined` 事件、无 join 幂等记录）。API 路径本身可用：harness join 后 `listenerCount 0→1`、Stream 成员 `1→2`。 |
| `cy` 在 09:04 于 `mock-vol-02` 自己开了房 `3094f1ff…`，作为 host           | `speakerCount 0 / listenerCount 0`：host 既不是 speaker 也不是 listener，两项都不含 host。「人数 0」最可能来自这里。                                                           |
| `participants.observed.memberCount` 读的是 `queryMembers`                  | 那是 Stream call **members**（被授权进入的人，含从未连上音频的 host），不是当前连着的人。它对「此刻在房里几个人」是错误的口径。                                                |
| `join` / `leave` 响应固定返回 `observed: unavailable`                      | 命令响应从不带任何 Stream 观测；页面若用命令响应刷新，只能显示「—」。                                                                                                          |

## 2. 裁决：三个口径，三个字段名，互不混用

`participants` 块：

| 字段                              | 口径                                                                                                                                        | 来源       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `speakerCount`                    | LOOP 角色意图：`voice_room_members` 中 `state='joined' and role='speaker'`。不含 host。                                                     | PostgreSQL |
| `listenerCount`                   | LOOP 角色意图：`state='joined' and role='listener'`。不含 host。                                                                            | PostgreSQL |
| `joinedCount`（新）               | LOOP 已加入总数：`state='joined'` 全部行，**含 host**。`= 1 + speakerCount + listenerCount`（live 房）。                                    | PostgreSQL |
| `observed.memberCount`            | Stream call **被授权成员**数（`queryMembers` 分页累加，10 页上限，截断即 unavailable）。                                                    | Stream     |
| `observed.participantCount`（新） | Stream 当前 call session **在线参与者**数（`getCall` → `call.session.participants_count_by_role` 求和；无 session 或 session 已结束 = 0）。 | Stream     |
| `observed.observedAt`             | 两次 Stream 只读调用完成的时间。                                                                                                            | 服务端时钟 |

- 页面「当前在线人数」**必须**读 `observed.participantCount`；「可进入的人」读 `observed.memberCount`；「LOOP 记录了几个人」读 `joinedCount`。
- `observed` 仍是二选一：`{status:"available", participantCount, memberCount, observedAt}` 或 `{status:"unavailable", reasonCode:"STREAM_PARTICIPANT_COUNT_NOT_OBSERVED"}`。两次 Stream 读任一失败、截断或被中止，整块 unavailable；不发布半个观测。
- **join / leave / 举手 / 取消举手 / 邀请发言 / 移出发言 / 全体静音的响应现在都在那一次 Stream 写之后再做一次观测**（room 必须 `provisioned`）。`join` 响应内：`joinedCount`、`listenerCount` 必含本人；`memberCount` 在 `providerSync.confirmed` 时含本人；`participantCount` 只有在设备真正连上 Stream call 之后才含本人——LOOP join 是授权，不是音频连接，后端不会把授权当成在线。
- `createRoom` 与 `endRoom` 响应保持 `observed: unavailable`（刚建的 call 无 session；已结束的房不再观测）。

## 3. leave / host 语义（核对，不改）

- 非 host `leave`：LOOP 行 `state='left'`，`listenerCount`/`joinedCount` 减 1；Stream `updateCallMembers` 移除后 `memberCount` 减 1。
- host `leave`：`403 PERMISSION_DENIED`，host 只能 `POST …/end`；`end` 后 `state='ended'`，后续写一律 `409 DATA_STALE`。host leave 不会结束房间，这是既有裁决（0032）。

## 4. 前端需要跟进

- `loop_v2_communication_codec.dart` 的 `participants` / `observed` 用 `strictMap` 精确键集合：新增 `joinedCount`、`participantCount` 后旧客户端会把整个语音房快照判为 invalid。手机端必须同步更新键集合。
- 「当前在线人数」改读 `participantCount`；「发言人 / 听众」旁展示 `joinedCount`（含 host）或明确写「不含主持人」。
- `builders-guild` 那次「已加入」在 LOOP 侧没有任何 join 命令痕迹，手机端要确认「加入语音房」按钮确实发出了 `POST /v2/voice-rooms/{id}/join` 并处理了响应。
