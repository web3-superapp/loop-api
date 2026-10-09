# 0054 · 语音房建房即开播：Stream call 不再停在 backstage（S37）

- 日期：2026-09-18
- 来源：第四轮真机验收 R4-1（听众连不上 Stream 语音）、R4-4（`observed.participantCount` 恒 0）、R4-6（re-join 后 `joinedAt` 不刷新）；主代理任务单 S37
- 范围：`StreamCallGateway` 新增 `goLive`；`POST /v2/communities/{id}/voice-rooms` 的 provisioning 流程；`GET /v2/voice-rooms/{id}`、`GET /v2/communities/{id}/voice-rooms/current`、`POST /v2/voice-rooms/{id}/join` 对既有 backstage 房的自愈；`voice_room_members.joined_at` 在 re-join 时的语义。不加表、不加迁移、不改 `/v1`、不改 Stream 角色权限。
- 基线：`integration/v2` = `498f62d`
- **非破坏性契约变化**：响应不删字段、不改类型；`backstage` 仍是 boolean；新增 `providerSync.reasonCode` 值 `STREAM_CALL_GO_LIVE_UNCONFIRMED`、新增 `join` 的 `detailsSafe.reasonCode` 值 `VOICE_ROOM_BACKSTAGE_NOT_LIVE`。

## 1. 证据

| 观察                                                                                                                                                                           | 结论                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/integrations/stream/call-gateway.ts` 建 call 时 `settings_override: { backstage: { enabled: true } }`；代码库里没有任何地方调用 Stream `go_live`。                        | 每一个 LOOP 语音房的 Stream call 从建立起就一直停在 backstage。                                                                                                    |
| 主代理用 Stream API 直接查 `audio_room` 类型的 grants：`join-backstage` 只授予 `host, admin`；`join-call` 授予 `user, speaker` 等。                                            | backstage 的 call 只有房主（LOOP host → Stream `admin`）能 `call.join()`；听众（`user`）与发言人（`speaker`）在 SDK `join()` 即被拒。这是 R4-1 的根因。            |
| Builders Guild 现存 live 房 `loop_voice_0775e48bdd0e478282e2f77dfdf62a5f` 在 Stream 上 `backstage: true`；开发库 `voice_rooms.backstage` 全部为 true（列默认值，从未被写回）。 | 现存房不能靠重新建房修复；需要一条对既有房的自愈路径。                                                                                                             |
| 同一 call 的 `GetCall` 响应 `session` 为 undefined。                                                                                                                           | 没有人真正连上过这个 call（host 本人的设备也没有形成 session），所以 `participants_count_by_role` 观察不到，`observed.participantCount` 为 0。这是 R4-4 的一部分。 |
| `voice_room_members` 的 join upsert 只写 `state='joined', updated_at`，不动 `joined_at`。                                                                                      | 离开再加入的成员保留上一次的 `joined_at`，名单的 keyset 排序把「刚回来的人」排在最前面。这是 R4-6。                                                                |

## 2. 裁决

### 2.1 建房即开播（`POST /v2/communities/{id}/voice-rooms`）

| 项目           | 裁决                                                                                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider 写    | 两次，顺序固定：`create`（call 类型默认 backstage，保持不变）→ `goLive`（`POST /video/call/audio_room/{id}/go_live`，空 body：不开录制、不开 HLS、不开转写）。`goLive` 是 `StreamCallGateway` 上独立的方法，不藏在 `createAudioRoom` 里——两次写有两种失败，响应必须说清是哪一次没确认。 |
| 成功判定       | 只有 `goLive` 返回且 `call.backstage === false` 才算 `provisioned`。响应 `room.backstage: false`，`providerSync.confirmed`，`recordVoiceRoomProvisioning({provisioned, null, backstage: false})`。                                                                                      |
| create 未确认  | 与 0032 相同：`reconciling`、`last_error_code = stream_call_create_unconfirmed`、`providerSync.reasonCode = STREAM_CALL_CREATE_UNCONFIRMED`、不尝试 `goLive`、`backstage` 保持读到的值（true）。不能加入。                                                                              |
| go-live 未确认 | 拒绝、超时、中止、投影不匹配、**或 Stream 应答了但 `backstage` 仍为 true**，一律：`reconciling`、`last_error_code = stream_call_go_live_unconfirmed`、`providerSync.reasonCode = STREAM_CALL_GO_LIVE_UNCONFIRMED`（新）、`backstage: true`。不能加入。不吞错误、不宣称成功。            |
| 仓储不变量     | `recordVoiceRoomProvisioning` 新增必填 `backstage`；`provisioned` 与 `backstage: true` 同时出现时仓储拒绝写（`CommunicationRepositoryUnavailableError`）——一个 provisioned 房按定义是已开播的 call。                                                                                    |
| 幂等           | 同一 `Idempotency-Key` 重放：仓储已记录 `provisioned` 的直接返回；否则重走两次 Provider 写。Stream 的 `go_live` 对已开播的 call 幂等（返回 `backstage: false`）。                                                                                                                       |

### 2.2 既有房自愈（`GET /v2/voice-rooms/{id}`、`GET …/current`、`POST …/join`）

| 项目       | 裁决                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 触发条件   | `state = live` 且 `provisionState = provisioned` 且 DB `backstage = true`。其他任何状态不触发（pending / reconciling / failed / ended 都走各自既有路径）。                                                                                                                                                                                                                                |
| 次数上限   | **每个请求最多一次 `goLive`**，没有重试、没有后台任务、没有轮询。成功后回写 `backstage=false`，后续请求不再碰 Provider。失败就等下一个请求再试一次。                                                                                                                                                                                                                                      |
| 读路径     | `getRoom` / `getCurrentRoom`：自愈失败**不阻断读**——照常返回房间资源，`room.backstage: true`，`providerSync: {status: "unconfirmed", reasonCode: "STREAM_CALL_GO_LIVE_UNCONFIRMED"}`（读路径首次出现 unconfirmed，schema 本来就允许）。观测块照常做。                                                                                                                                     |
| join       | 先读房（`getVoiceRoom`，同时完成社区身份校验），自愈一次；若 call 仍在 backstage → `503 CAPABILITY_UNAVAILABLE`，`detailsSafe: { reasonCode: "VOICE_ROOM_BACKSTAGE_NOT_LIVE" }`（新），**在 LOOP 提交任何行之前**拒绝：无成员行、无审计、无幂等记录、无 Stream `updateCallMembers`。这不是泛化的 runtime unavailable——reason code 明确说 call 还没开播。                                  |
| 顺序       | join 的调用顺序固定为 `goLive` → `recordVoiceRoomLive` → `joinVoiceRoom` → `updateCallMembers` → 观测。                                                                                                                                                                                                                                                                                   |
| 回写       | `recordVoiceRoomLive`：`update … set backstage=false, last_error_code=null where voice_room_id=$1 and state='live' and provision_state='provisioned' and backstage=true`。0 行 = 已被并发请求治好或房间已结束，不报错，返回房间现状。与建房用的 `recordVoiceRoomProvisioning` 分开：那一条是无条件写 provisioning 结果，自愈不能借用它。                                                  |
| 拒绝优先级 | join 的前置读把身份校验提前了。固定顺序：`404 NOT_FOUND`（房不存在）→ `403 PERMISSION_DENIED`（被 ban / 非社区成员，**不看房间状态**：对已结束房也是 403，之前是 409；对 reconciling 房也是 403，之前是 503）→ `409 DATA_STALE`（成员对已结束房）→ `503 CAPABILITY_UNAVAILABLE`（成员对未 provisioned 房，或 backstage 自愈失败带 `VOICE_ROOM_BACKSTAGE_NOT_LIVE`）。路由测试固定此顺序。 |
| 日志       | 每次未确认的 go-live（建房或自愈）写一条 `warn`：`"Voice room go_live was not confirmed"`，context 只有 `voiceRoomId`、`callId`、`requestId`（= 错误体 `correlationId` / 响应头 `x-request-id`）、`outcome`（`rejected` / `still_backstage`）、`errorName`（错误类名）。不含 Stream 响应体、不含 token。logger 由 `app.log` 注入；脚本与测试可不注入。                                    |
| 不做       | `leave` / 举手 / 邀请 / 静音 / 结束不自愈——这些命令不需要 call 开播；`end` 对 backstage 的 call 照常 `end`。                                                                                                                                                                                                                                                                              |

### 2.3 re-join 刷新 `joined_at`（R4-6）

`joinVoiceRoom` 的 upsert 改为：

```sql
on conflict (voice_room_id, owner_user_id) do update
set state = 'joined',
    joined_at = case when voice_room_members.state = 'joined'
                     then voice_room_members.joined_at
                     else clock_timestamp() end,
    updated_at = clock_timestamp()
```

- 已在房内的幂等 re-join：`joined_at` 不变（不是新到的人）。
- `left` 后再 join：`joined_at` 刷新为现在，名单（0052 的 `(joined_at, public_profile_id)` keyset）把它排为最新到达。
- `leave` 路径不变（`state='left', role='listener', muted_at=null`）；角色在 leave 时已归零，所以 re-join 恒为 listener。

## 3. 契约影响

| 位置                                  | 变化                                                                                                                                                    | 破坏性 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `room.backstage`                      | 类型不变（boolean）。语义：provisioned 房恒为 `false`；`true` + provisioned + live = 一次 go-live 未确认，暂不可加入。                                  | 否     |
| `providerSync.reasonCode`             | 新值 `STREAM_CALL_GO_LIVE_UNCONFIRMED`（建房响应、以及读路径自愈失败时）。pattern 不变。                                                                | 否     |
| `POST …/join` 错误                    | `503 CAPABILITY_UNAVAILABLE` 现在可带 `detailsSafe: { reasonCode: "VOICE_ROOM_BACKSTAGE_NOT_LIVE" }`。前端文档原先写「`detailsSafe` 恒为 null」已更正。 | 否     |
| 读路径 `providerSync`                 | 之前恒 `confirmed`；现在自愈失败时 `unconfirmed`。status 枚举与 pattern 不变。                                                                          | 否     |
| `recordVoiceRoomProvisioning`（内部） | 新增必填 `backstage`。                                                                                                                                  | 内部   |
| OpenAPI                               | 建房 / 读房 / join 的 description 与 `backstage` 的 description 更新；`pnpm openapi:generate` 重生成。                                                  | 否     |

## 4. 部署后对 Builders Guild 现存房要做什么

不需要脚本、不需要迁移。任何成员（含 host 或 `cy`）下一次打开语音房页（`GET /v2/voice-rooms/{id}` 或 `GET /v2/communities/{id}/voice-rooms/current`）或点「加入语音房」（`POST …/join`）都会触发一次 `go_live`；成功后 DB `backstage=false`，响应里 `room.backstage: false`、`providerSync.confirmed`。若响应仍是 `backstage: true` + `STREAM_CALL_GO_LIVE_UNCONFIRMED`，说明 Stream 拒绝了 server key 的 go_live：用响应头 `x-request-id`（join 失败时 = 错误体 `correlationId`）在 API 日志里找 `Voice room go_live was not confirmed` 那一行，`outcome` / `errorName` 说明是拒绝还是应答仍 backstage；再刷新一次即再试一次。开发库其他 `backstage=true` 的 live 房同理。

## 5. 回滚

- 代码回滚到 `498f62d` 即可：没有迁移、没有新列。已被自愈写成 `backstage=false` 的行在旧代码下只是展示值，不影响任何路径。
- Stream 侧已开播的 call 不需要回退；旧代码对已开播的 call 行为与 backstage 的 call 一样（只是听众能连上）。
