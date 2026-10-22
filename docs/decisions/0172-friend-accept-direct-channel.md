# 0172 · 接受好友后服务端保证私聊频道：`friend_direct_channel` 车道 + 回填（S272-api，2026-10-22）

## 1. Status

已实现（分支 `feat/S272-friend-channel-api`，基线 `integration/v2` `d5ba35a`）。迁移 `000095_friend_direct_channel_jobs`（新表一张）；worker 新车道一条；新 env 三个；**无新路由、无请求 / 响应键变化、无 OpenAPI 变化**（客户端 codec 不受影响）。

## 2. Context

- 需求方反馈「添加好友后没出现在列表」。App 的 聊天 → 好友 筛选列的是 Stream 频道（`loop_direct_<32hex>`），而该频道只由 `POST /v2/chat/direct-channels`（`chat-channel-service.getOrCreateDirect`）创建。
- 接受消息请求（`POST /v2/message-requests/:id/decision`，`community-repository.decideMessageRequest`）与接受好友请求（`POST /v1/friend-requests/:id/decision`，`social-repository.decideFriendRequest`）都只写 `friendships`，不写 `direct_channels`、不建 Stream 频道。
- App 侧（决策 0231，loop-mobile 已合入）接受后会尽力调用一次 get-or-create；但调用失败 / 杀进程 / 旧包、以及本决策之前已接受的好友，都没有频道。
- 现状核对：`direct_get_or_create` 是**同步**执行的 chat operation（`chat_operations` + `direct_channels`，路由内直接写 Stream，未完成时 202 + 轮询）；仓库里没有处理 chat operation 的 worker 车道或作业表。可复用的是 `community_channel_sync_jobs` 的 outbox + 租约模式。

## 3. Decision

### A. Outbox：`friend_direct_channel_jobs`（迁移 000095）

- 主键 `(user_id_low, user_id_high)`，一对好友一行；`owner_user_id`（先以谁的身份建，= 接受方）；`kind` 固定 `direct_get_or_create`；`source` ∈ `accept | backfill`；`state` ∈ `pending | succeeded | skipped | failed`；`attempts`、`next_attempt_at`、租约 `lease_worker_id / lease_expires_at`；`operation_id / operation_owner_user_id`（车道上一次建的 chat operation，未终态时轮询它，不再新建）；`last_error_code`。
- 外键指向 `loop_users` 用 `on delete cascade`：它只是 outbox，删账号时随之删除（dev-reset 也显式删）。
- 不存任何 Stream 状态；`direct_channels` / `chat_operations` 仍是唯一权威。

### B. 接受事务内入队

- `decideMessageRequest`（`accept`）与 `decideFriendRequest`（`accept`）在写 `friendships` 的同一事务里调用 `enqueueFriendDirectChannelJob(client, {ownerUserId: 接受方, peerUserId: 请求方, source: 'accept'})`。
- `on conflict` 时：已结束（`succeeded / skipped / failed`）的行被重新置为 `pending`（attempts 清零、清 operation 与错误码）——用于删好友后再加；`pending` 行原样保留（不打断正在租约中的处理）。
- 入队只是 insert，不调 Stream，不会让接受失败；接受的回复不变。

### C. 车道 `friend_direct_channel`（worker 进程）

- 默认开（`FRIEND_DIRECT_CHANNEL_ENABLED=true`），每 `FRIEND_DIRECT_CHANNEL_INTERVAL_MS`（1 s – 10 min，默认 5 000）一轮；需要 Stream 密钥对，缺失时启动日志 `FRIEND_DIRECT_CHANNEL_STREAM_NOT_CONFIGURED` 后不运行。一轮最多租 20 行（`for update skip locked`，租约 120 s）；满 20 行时不等待立即下一轮。
- 每行处理：
  1. 有 `operation_id` → 以该 owner 身份 `getOperation` 轮询（与 `GET /v2/chat/operations/:id` 同一路径）；该 operation 不存在（prepare 未提交）则清掉重来。
  2. 该对已有 `active` 的 `direct_channels` → 直接 `succeeded`，**不写 Stream**（App 先建好了）。
  3. 否则以接受方为 owner、对方 `public_profile_id` 为 target，调用与路由**完全相同**的 `chatChannelService.getOrCreateDirect`（新 UUID v4 的 operationId / requestId，principal 由 `loop_users.privy_user_id` 组装，Stream ID 仍由 `deriveStreamUserId` 派生）。先把 operationId 记到行上再调用，崩溃后可轮询。
- 拒绝规则与路由相同（就是同一段代码 `resolveDirectTarget`：必须仍是好友，且 target 的 `direct_messages` 为 `friends`，无行视为开放）：接受方方向被拒（`ChatChannelTargetUnavailableError`）→ 反向再试一次；两向都拒、或双方都没有公开资料 → `skipped / direct_target_unavailable`。拉黑在接受时已被拦截，删好友后 friendship 不在 → 同样 skipped。**永不影响接受本身。**
- 结果映射：operation `succeeded` → `succeeded`；终态 `failed / operator_required` → `failed`（错误码取 operation 的 `error.code`，不重试）；非终态 → 15 s 后再轮询；依赖不可用（DB / Stream 网关异常）→ 指数退避 5 s ·2ⁿ⁻¹，上限 10 min；`attempts ≥ 20` → `failed`（`direct_channel_unavailable` 或 `direct_channel_not_settled`）。
- 与 App 自己的调用幂等：两边都是 `direct_get_or_create`，`direct_channels_live_pair_unique` + `loop_users` 行锁保证一对只会有一个活频道，后到的一方收敛到同一 CID（已有 `active` 映射时 prepare 直接返回 `succeeded`，不写 Stream）。

### D. 回填：`FRIEND_CHANNEL_BACKFILL_ENABLED`（默认关）

- 打开后车道每轮先执行一次 `enqueueBackfill(200)`：把「`friendships` 有、`direct_channels` 无 live 行（`pending / active / operator_required`）、`friend_direct_channel_jobs` 也无行」的好友对插入 outbox（`source = 'backfill'`，owner 取原请求的接收方即接受方，未知时取 low），按 `accepted_at` 升序，`on conflict do nothing`。
- 幂等、有界：同一对只会入队一次（已有 job 行即跳过，包括 skipped / failed）；每轮最多 200 对，处理仍按每轮 20 对的节奏。
- 日志（`lane: friend_direct_channel`）：每轮有动作时一行 `LOOP friend direct channel pass completed`，`inserted` = 本轮回填入队数，`count` = 本轮租到的行，`succeededCount / skippedCount / failedCount / retriedCount`；单行失败 `FRIEND_DIRECT_CHANNEL_JOB_FAILED`、重试 `FRIEND_DIRECT_CHANNEL_JOB_RETRY`（`detailReasonCode` 为错误码）。只有计数与错误码，不打账号 ID。
- 回填完成（连续多轮 `inserted` 为 0 且无 `count`）后可关掉该开关，留着也只是每轮一条空查询。

### E. env

| 变量                                | 默认    | 说明                                     |
| ----------------------------------- | ------- | ---------------------------------------- |
| `FRIEND_DIRECT_CHANNEL_ENABLED`     | `true`  | 车道开关（还需 `STREAM_API_KEY/SECRET`） |
| `FRIEND_DIRECT_CHANNEL_INTERVAL_MS` | `5000`  | 轮询间隔，1 000 – 600 000                |
| `FRIEND_CHANNEL_BACKFILL_ENABLED`   | `false` | 回填扫描，每轮最多入队 200 对            |

## 4. Consequences

- 接受后频道最迟一个车道周期（默认 ≤ 5 s + Stream 往返）出现；App 的尽力调用仍是更快的那条路，两者收敛到同一 CID。
- 旧好友需要在 staging / 生产上打开一次回填（步骤见 S272 报告）；不打开时只影响 0172 之前的好友。
- 新表纳入 `requiredDatabaseRelations`、`dev-reset-users` 分类与删除顺序；`latestMigrationName` = `000095_friend_direct_channel_jobs`。
- 不改 `/v2` 合同、不改 OpenAPI，旧包无感。
