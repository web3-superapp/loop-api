# 0069 · 语音房：举手走 Stream 自定义 call event、未确认的 Provider 写入进日志、leave 幂等（S72）

- 日期：2026-09-22
- 来源：真机反馈 `docs/acceptance/2026-09-22-device-feedback-voice-room-push.md` 第 1、4、6b 项与文末 leave 403 复核；主代理任务单 S72-api
- 范围：`StreamCallGateway.sendCallEvent`（新）；`POST|DELETE /v2/voice-rooms/{id}/hand-raise` 的 Provider 写；`VoiceRoomService` 未确认 Provider 写的日志；`POST /v2/voice-rooms/{id}/leave` 对"不在房间内"的语义。不加表、不加迁移、不改 `/v1`、不改 Stream 角色权限、不新增响应字段。
- 基线：`integration/v2` = `9071f95`
- **非破坏性契约变化**：响应不删字段、不改类型。新增 `providerSync.reasonCode` 值 `STREAM_CALL_EVENT_UNCONFIRMED`；`leave` 对"不在房间内"由 `409 DATA_STALE` 改为 `200`；新增一种 Stream 自定义 call event（客户端订阅）。

## 1. 事实

| 观察                                                                                                                                                                                                                                                                                                                                       | 结论                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/Library/Logs/LOOP/api.log` 跨天累积且行内无日期；今日（pid 18250）语音房请求全部 2xx：创建 201（17:01:36、17:06:10，各约 1.3 s）、join 200（17:07:01）、hand-raise 200（17:07:37）、end 200。今日没有任何 `Voice room go_live was not confirmed`。                                                                                      | 今日两次创建的两步 Provider 写（create → go_live）都被确认；17:07:01 的 join 成功也只可能发生在 `provisioned` 房上。"创建 50% 失败"不在 201 之前，也不在 201 之后的服务端 Provider 写，而在客户端阶段。                           |
| `createRoom` 在 `createAudioRoom` 失败时 `void error`，只写 `reconciling` 与 `providerSync.unconfirmed`；`attemptProviderWrite` 对 join / leave / 邀请 / 静音 / 结束的失败同样 `void error`。只有 go-live 失败有 warn。                                                                                                                    | 一个拿到 201 但 call 不存在的房间，在 API 日志里找不到任何痕迹；只能靠客户端把 `providerSync` 报回来。                                                                                                                            |
| 一个 `reconciling` 的房在 DB 里仍是 `state = live`，`voice_rooms_one_live_per_community_idx` 让同社区再次开房 `409 RESOURCE_CONFLICT`；同一 `Idempotency-Key` 重放会跳过本地写、重走两次 Provider 写（Stream `create` 对已存在 call 幂等，`go_live` 对已开播 call 幂等）。                                                                 | 建房未确认时，正确的恢复是**同 key 重试**或 host `end` 后重建；换 key 重建必然 409。这是既有行为，本决策只把它写进契约。                                                                                                          |
| `joinVoiceRoom` 在一个事务里 upsert `voice_room_members` 并返回；`listVoiceRoomMembers`、`getVoiceRoom` 每次都读 PostgreSQL，没有任何缓存层。                                                                                                                                                                                              | join 200 之后的任何一次 `GET members` / `GET {id}` 都包含新成员（`listenerCount`、`joinedCount`、名单行）。主持人端"仍显示 1 人"不是服务端口径问题，而是客户端读的是 `observed.participantCount`（Stream 在线设备数）或没有重读。 |
| 举手是纯 LOOP 队列事实（0032），不做任何 Stream 写；Stream 对 `call.member_*`、`call.session_participant_*`、`call.permissions_updated`、`call.ended` 都有事件，但对 LOOP 的举手队列没有。`@stream-io/node-sdk@0.7.63` 提供 `call.sendCallEvent({ user_id, custom })` → `POST /video/call/{type}/{id}/event`，房内所有已连接设备都会收到。 | 主持人得知举手的唯一途径是轮询 `GET …/hand-raises`。自定义 call event 是零新基础设施的通知通道：它走客户端已经订阅的 call，不需要 push、不需要 WebSocket。                                                                        |
| `leaveVoiceRoom` 对不存在成员行或 `state <> 'joined'` 抛 `CommunicationDataStaleError`（409）；host 行抛 `CommunicationPermissionDeniedError`（403）；房间已结束由 `requireLiveRoom` 抛 409。主代理更正：17:08:01 的 leave 403 是往日记录，今日没有 leave。                                                                                | `leave` 的 403 只有一种来源：host 调 leave。"从未加入 / 已离开"是 409 而不是 403；这两种情况的终态与请求意图一致，拒绝没有保护任何事实。                                                                                          |

## 2. 裁决

### 2.1 举手 / 取消举手发一个 Stream 自定义 call event（`POST|DELETE …/hand-raise`）

| 项目           | 裁决                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 顺序           | LOOP 事务先提交（队列行 + 审计 + 幂等记录），然后**恰好一次** `sendCallEvent`，然后观测。与其它命令的"先本地后 Provider"完全一致。                                                                                                                                                                                                                               |
| 发送者         | `user_id = hostStreamUserId`（房主的 Stream 用户，队列的 owner）。**不用举手者**：匿名成员在名单里对非 host 是 `anonymous` / `publicProfileId: null`，若事件以举手者身份发出，房内任何设备都能把"匿名举手行"对应到某个 participant tile，等于绕过 0052/0053 的显示规则。                                                                                         |
| payload        | `custom = { loop_event_kind: "voiceRoomHandRaise", loop_event_schema_version: 1, voice_room_id, hand_raise_id, sequence, state }`。`sequence` 是十进制字符串；`state` 是 `pending`（POST）或 `cancelled`（DELETE）。**不含** alias、publicProfileId、loopId、Stream 用户 ID。键用 snake_case，与同一 call 上的 `loop_call_kind` 一致。                           |
| 只发不推       | 事件只告诉设备"队列变了"；身份、顺序、命令仍由 `GET …/hand-raises` 给出（host 视角含 `invite_speaker`）。客户端收到事件后重读队列，不从事件拼状态。                                                                                                                                                                                                              |
| `providerSync` | 这次发送就是举手命令的那一次 Provider 写：确认 → `confirmed`；拒绝 / 超时 / 中止 → `{status: "unconfirmed", reasonCode: "STREAM_CALL_EVENT_UNCONFIRMED"}`（新值，pattern 不变）。举手本身已提交，未确认只表示**没有设备被告知**。                                                                                                                                |
| 无 call 时     | 房间不是 `provisioned` + `live`（理论上举手者进不了这种房）或记录里没有 `viewerHandRaise` → 不发、`confirmed`（没有 Provider 写需要确认，与改前相同）。                                                                                                                                                                                                          |
| 幂等重放       | 同 key 重放跳过本地写，然后**只在**记录里的最新举手仍处于本命令产生的状态时才再发一次（POST → `pending`，DELETE → `cancelled`）；否则不发、`confirmed`。记录携带的是 viewer **最新**的举手，重放时它可能已被 host 置为 `invited`，或已经是一条更新的举手——事件永远不宣告本命令没有产生的状态、不指向本命令没有写的条目。事件重复本身对客户端无害：它只触发重读。 |
| 网关           | `sendCallEvent({callId, sentByStreamUserId, custom, signal})`：一次 Provider 调用、3 s 共享预算、失败 sanitize 成 `StreamCallGatewayUnavailableError`。`custom` 必须是扁平 map：≤ 16 项、键 `^[a-z][a-z0-9_]{0,63}$`、值为 string（≤ 256）/ finite number / boolean / null；不合规在触碰 Provider 之前拒绝。                                                     |
| 不做           | join / leave / 邀请 / 移出 / 静音 / 结束**不**加事件：Stream 已对这些发 `call.member_added                                                                                                                                                                                                                                                                       | removed | updated`、`call.session_participant_joined | left`、`call.permissions_updated`、`call.ended`，客户端订阅它们后重读 LOOP 房间资源即可；再加一个 LOOP 事件会让这些命令有两次 Provider 写，`providerSync` 说不清是哪一次。 |

**为什么不是轮询**：轮询能做，但每个房内设备每 3 s 一次 `GET …/hand-raises`（含 `readViewerRecord` 的 4 条查询）是纯粹的负载；事件到达后客户端只在有变化时读一次。轮询保留为客户端的**兜底**（事件未确认、或设备断连重连后），推荐间隔 ≥ 15 s，且只在 host 视角开启。

### 2.2 未确认的 Provider 写入进日志（建房与所有命令）

| 项目 | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 日志 | 每一次未确认的 Stream 写（建房 `create`、join/leave 的 `updateCallMembers`、邀请/移出的权限、静音、结束、举手事件）写一条 `warn`：`"Voice room provider write was not confirmed"`，context 只有 `voiceRoomId`、`callId`、`requestId`（= 响应头 `x-request-id`）、`reasonCode`（= 响应里的 `providerSync.reasonCode`）、`errorName`、`providerReason`（网关的粗粒度分类：`timeout` = SDK 3 s 预算耗尽、`rejected` = Stream/网络给了失败应答、`invalid_input` = 输入未触碰 Provider 即被网关拒绝；失败不是网关抛出的则为 `null`。请求 signal 被中止不属于这三类：它原样抛出，不被 sanitize）。不含 Stream 响应体、不含 token。 |
| 不变 | go-live 未确认仍是 0054 的那一条 `"Voice room go_live was not confirmed"`（`outcome` / `errorName`），两条不合并——两种失败两种恢复。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 响应 | 不变。建房 201 + `provisionState: "reconciling"` + `providerSync.unconfirmed` 早已是契约；本决策只是让它在日志里可查。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**客户端必须做的判断**（第 1 项的服务端结论）：`POST …/voice-rooms` 返回 201 **不等于**能进；只有 `room.provisionState === "provisioned"` 且 `room.backstage === false` 才 `call.join()`。否则按 `providerSync.reasonCode` 显示原因，并用**同一个 `Idempotency-Key`** 重试建房（重走两次 Provider 写），或让 host `end` 后重建；换 key 重建会 `409 RESOURCE_CONFLICT`。

### 2.3 join 之后的名单与人数（第 4 项）

无代码改动；用集成测试固定事实：join 提交后的**下一次**读（`listVoiceRoomMembers`、`getVoiceRoom`）就包含新成员，`listenerCount`、`joinedCount` 已加一。"房内几个人"的三个口径见 0051；**`observed.participantCount` 只在设备真正 `call.join()` 之后才含该人**，主持人端若显示这个数，就要等 Stream 的 `call.session_participant_joined` 再重读。

### 2.4 `leave` 幂等（第 4 项 / 文末 403 复核）

| 情形                                 | 改前                    | 改后                                                                                                                                                                                                |
| ------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 已加入的 listener / speaker          | 200，写 `left`、审计    | 不变                                                                                                                                                                                                |
| 同 key 重放                          | 200（审计重放）         | 不变                                                                                                                                                                                                |
| 社区成员从未加入 / 已离开（live 房） | `409 DATA_STALE`        | **`200` no-op**：仓储返回 `outcome: "no_op"`，服务层不做 `updateCallMembers`、不观测，响应 `viewer.role: null`、`providerSync: confirmed`（没有 Provider 写）、`participants.observed: unavailable` |
| 非社区成员 / 被 ban                  | `409`（无成员行）       | **`403 PERMISSION_DENIED`**，不看房间状态：与 join 同序（404 → 403 → 409），no-op 之前先 `requireCommunityStanding`，房间资源绝不发给非成员                                                         |
| host                                 | `403 PERMISSION_DENIED` | 不变：host 结束房间而不是离开                                                                                                                                                                       |
| 房间已结束（社区成员）               | `409 DATA_STALE`        | 不变：0032 "已结束房间所有写操作 DATA_STALE" 的不变量不动                                                                                                                                           |

仓储 `leaveVoiceRoom` 返回 `VoiceRoomLeaveRecord = VoiceRoomViewerRecord & { outcome: "left" | "no_op" }`：`left`（含同 key 重放）→ 服务层照旧尝试一次 Stream 移除并观测；`no_op` → 什么都不碰。

理由：leave 只要求一个终态"我不在这个房间里"；终态已成立时拒绝没有保护任何事实，只让客户端多处理一个错误分支。已结束的房不同——成员行在结束时冻结，`leave` 没有可提交的事实，与其它写一致地 stale。非社区成员不同——它本来就读不到这个房（GET 是 403），leave 也不能成为读它的后门。

## 3. 契约影响

| 位置                              | 变化                                                                                                                                    | 破坏性                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `providerSync.reasonCode`         | 新值 `STREAM_CALL_EVENT_UNCONFIRMED`（只出现在 `POST                                                                                    | DELETE …/hand-raise`）。pattern 不变。 | 否  |
| `POST …/leave`                    | "不在房间内"由 409 变 200；错误码集合不变（409 仍可能出现：房已结束）。                                                                 | 否                                     |
| Stream call 自定义事件            | 新增 `custom.loop_event_kind = "voiceRoomHandRaise"`。**客户端需要订阅** `call.on("custom", …)` 并按 `loop_event_kind` 过滤后重读队列。 | 否（新增能力）                         |
| `StreamCallGateway.sendCallEvent` | 内部新增；`createUnavailableStreamCallGateway` 同步 reject。                                                                            | 内部                                   |
| OpenAPI                           | leave / hand-raise 三条 description 更新；`pnpm openapi:generate` 重生成。                                                              | 否                                     |

## 4. 需要客户端配合

1. 建房：只在 `provisionState === "provisioned" && backstage === false` 时 `call.join()`；否则显示 `providerSync.reasonCode` 对应文案并用同 key 重试。
2. 举手队列（host 视角）：订阅 call 的 `custom` 事件，`custom.loop_event_kind === "voiceRoomHandRaise"` → 重读 `GET …/hand-raises`；兜底轮询 ≥ 15 s。举手者自己看到 `providerSync.unconfirmed` + `STREAM_CALL_EVENT_UNCONFIRMED` 时提示"已举手，主持人可能稍后才看到"。
3. 人数：主持人端"房内人数"读 `participants.joinedCount`（LOOP 已加入，含 host）或按 0051 明确写"在线 N 人"用 `observed.participantCount`；在 Stream 的 `call.session_participant_joined|left`、`call.member_added|removed` 上重读房间资源。
4. leave：不再需要把 `409 DATA_STALE` 当作"其实已经离开"来特殊处理（房已结束时的 409 仍要处理：导航回社区页）。no-op 的 200 里 `participants.observed` 是 unavailable，不要把它显示成 0。

## 6. 已知未做

- 举手事件无节流（F5）：一个听众反复举手/取消，每次命令都发一个事件（每次都先受 LOOP 写路径的幂等与 DATA_STALE 约束，pending 中不能再举）。先记录，不做。

## 5. 回滚

代码回滚到 `9071f95` 即可：没有迁移、没有新列、没有新表。已发出的 call event 是瞬时的，不留状态。回滚后 `leave` 对"不在房间内"重新回到 409，客户端若已按 200 处理也不会坏（它本来就要处理 409）。
