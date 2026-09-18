# 0053 · 发言人自行取消静音、举手队列匿名投影、行情总览 `newPairs.omittedCount`（S34）

- 日期：2026-09-18
- 来源：决策 0052「需要主代理决策」两条待办 + 主代理任务单 S34-backend
- 范围：`DELETE /v2/voice-rooms/{id}/speakers/{pid}/mute`（新）；`GET /v2/voice-rooms/{id}/members` 的 `commands[]`；`GET /v2/voice-rooms/{id}/hand-raises` 的行投影；`GET /v2/market/overview` 的 `newPairs` 可用变体。不改 `/v1`、不改 Stream 角色权限。
- 基线：`integration/v2` = `727f52d`
- **§2 与 §3 是破坏性契约变化**（`profile` 删除 / 必填键新增），前端跟进前不能部署。§1 只增不删（新命令枚举值），但 `commands[]` 的枚举集合变大，严格 codec 必须扩枚举。

## 1. 发言人自行取消静音（`DELETE …/speakers/{pid}/mute`）

### 事实

`voice_room_members.muted_at` 是 host 的 LOOP 侧意图（0052 §2），Stream 才是麦克风真相。被 host 静音的发言人在设备上重新开麦后，名单的 `muted` 一直是 true 直到下一次角色变化——名单对其他成员撒谎。

### 裁决

| 项目         | 裁决                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 端点         | `DELETE /v2/voice-rooms/{voiceRoomId}/speakers/{publicProfileId}/mute`，写头齐全（Bearer + `Idempotency-Key` + `X-Loop-Contract-Version`），无 body。响应是房间资源（与其它命令一致）。                                                                                                                                                                                                                          |
| 谁能调       | **本人**（`publicProfileId` 是调用者自己的档案）或 **host**。其他任何人 `403 PERMISSION_DENIED`。这是语音房里**唯一**非 host 可以对名单行执行的命令。                                                                                                                                                                                                                                                            |
| 状态机       | 目标必须是 `joined` 且 `role='speaker'` 且 `muted_at is not null`，否则 `409 DATA_STALE`（未静音、listener、已离开）。目标是 host 行 → `403`（host 不可能带静音，`voice_room_members_muted_role_check`）。房间非 live → `409 DATA_STALE`。                                                                                                                                                                       |
| 提交         | 同一事务里：`muted_at = null`，审计 `speaker_unmuted`（`from_role = to_role = 'speaker'`，`reason_code` 为 `self_unmute` 或 `host_unmute`，区分谁清的），幂等记录 `voiceRoomSpeakerUnmute`。                                                                                                                                                                                                                     |
| Provider     | **不做 Stream 写**。Stream 不允许 host 替别人开麦；发言人自己开麦由设备 SDK 完成（`send-audio` 权限在邀请发言时已授予）。所以 `providerSync` 固定 `confirmed`（与举手一样：这是一个纯 LOOP 事实，没有 Provider 写要确认）。清意图**不等于**麦克风已经打开——它只是把名单的 `muted` 归零。                                                                                                                         |
| `commands[]` | `voiceRoomMemberRowCommands` 新增输入 `isSelf`。host 视角：speaker 行未静音 `["remove_speaker","mute"]`、已静音 `["remove_speaker","unmute"]`；listener 行 `["invite_speaker"]`。**非 host 视角**：所有行 `[]`，**除了本人 speaker 行已静音时** `["unmute_self"]`。host 自己不在任何视图，所以 host 永远拿不到 `unmute_self`。房间非 live 一律 `[]`。两个新枚举值都指向同一路由 `DELETE …/speakers/{pid}/mute`。 |
| 迁移         | `000030_v2_voice_room_speaker_unmute`：`voice_room_events_type_check` 加 `speaker_unmuted`。无新列。down 在存在 `speaker_unmuted` 审计时拒绝。                                                                                                                                                                                                                                                                   |
| unavailable  | 通信模块未启用 → 路由不注册；仓储不可用 → `503 CAPABILITY_UNAVAILABLE`。                                                                                                                                                                                                                                                                                                                                         |

## 2. 举手队列与名单同一匿名投影（`GET …/hand-raises`）

### 事实

0032 让 `hand-raises` 对社区所有成员发 `profile: {publicProfileId, loopId, alias, avatarRef}`，与 0052 名单的 `display` 规则矛盾：开了匿名模式的成员在名单里是匿名，在举手队列里却露出 loopId 和别名。

### 裁决

| 项目                     | 裁决                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 行                       | `handRaiseId`、`sequence`、`state`、`createdAt`（不变）+ `publicProfileId`（可 null）、`display`、`isSelf`、`commands[]`——与名单行同一投影、同一函数。**`profile` 删除**，`loopId` / `avatarRef` 不再出现在队列里。 |
| `display`                | 与名单同一规则（0049 → 0052 §2）：`{kind:"alias", alias, publicProfileId, audience}` 或 `{kind:"anonymous", labelKey:"voiceRoom.member.anonymousMember"}`；本人永远看到自己的别名（匿名时 `audience:"self"`）。     |
| 行顶层 `publicProfileId` | host 视角恒非空（要从队列直接邀请）；非 host 视角匿名行 `null`。                                                                                                                                                    |
| `commands[]`             | host 且房间 live：`["invite_speaker"]`（队列里的人都是 pending 举手的 listener）；其他 `[]`。用同一 `voiceRoomMemberRowCommands`，输入 `role:"listener", muted:false`。                                             |
| 顶层                     | 加 `display: {anonymousMemberKey, ruleKey}`（与名单相同）。`items` 上限 50 不变。                                                                                                                                   |
| 与 0032 的差异           | 0032：所有社区成员看到完整 `profile`。0053：完整身份不再发布；别名只在对方未开匿名或本人时可见；`loopId`、`avatarRef` 从此路径消失（要头像走资料页）。host 仍能寻址每一行。                                         |
| 仓储                     | `listHandRaises` 返回 `{room: VoiceRoomViewerRecord, items[]}`，行带 `ownerUserId / publicProfileId / alias / anonymousMode`（`privacy_preferences_v2` 左连接），与名单同一列集合。                                 |

## 3. 行情总览 `newPairs.omittedCount`

### 事实

`GET /v2/market/overview` 的 `newPairs` 只是 `{status:"available"}`（0052 §3「只是可用性状态」）；行情 Tab 的新币卡片没有任何可显示的数字。

### 裁决

| 项目        | 裁决                                                                                                                                                                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 可用变体    | `{status:"available", omittedCount}`，`omittedCount` 必填整数 ≥ 0，**与 `GET /v2/market/new-pairs` 同一 fact**（`readNewPools`，同一缓存、同一 TTL），值一致。                                                                                                                                           |
| unavailable | Provider 关闭 → `MARKET_PROVIDER_GECKOTERMINAL_DISABLED`（不变）；Provider 开着但本次 fact 读不到（不可达 / 畸形 / 缓存不可用）→ `{status:"unavailable", reasonCode}`，与 `new-pairs` 端点同一 reasonCode。**不再**在 fact 读不到时仍报 `available`——总览的 `available` 现在意味着新币页此刻确实有数据。 |
| 不做        | 不把 `items` 塞进总览（新币页自己读）；不加 `fetchedAt` / `quality`（卡片只要一个计数）。                                                                                                                                                                                                                |

## 4. 清理

开发库 `mock-defi-morning`（host `cy`）第三轮复验遗留的 live 房，用 `buildApp()` harness 以 `cy` 身份调 `POST /v2/voice-rooms/{id}/end` 结束。`builders-guild` 的演示房（host `Voyager_09`）不动。不是代码变更，见任务回报。
