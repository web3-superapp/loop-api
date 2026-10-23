# 0178 · 发射审核 / 部署进度通知（S291，2026-10-23）

## 1. Status

已实现（分支 `S291-launch-review-inbox`，基线 `integration/v2` `1eb90f4`）。迁移 `000099_launch_review_inbox`。新 env：`LAUNCH_REVIEW_INBOX_EMIT`（API 与 worker，默认 `off`）。不新增路由、不改响应形状、不新增响应键、不改十个偏好类别、不改合约。客户端为 S292（并行）。沿用决策 0177（收件箱）与 0073（社区审核通知）的模式。

## 2. Context

项目方提交发射后的链路：资料审核（`launch_projects.review_status` submitted / in_review → approved | rejected）→ 发射配置审核（`hooks_launch_config_approvals` / `_rejections`，通过即「待签名」）→ 项目方签名（`hooks_launch_deployment_tasks` `awaiting_executor`）→ 执行器 `claimed → broadcast → confirmed → verified → activated`（决策 0112），分支 `failed`（可重试 / 终态）→ launch2 索引 lane 登记实例（`launch2_instances`，此时才有 `instanceId`）。此前整条链路不写任何通知，项目方只能刷「我的项目」。

## 3. Decision

### A. 契约表（S292 照此开发）

收件人 = 项目方账号 `launch_projects.owner_user_id`（即提交该项目、签名部署任务的账号；任务表 `owner_user_id` 与之相同）。

| `eventType`（feed `type`） | 库 `type`      | 触发（写入点）                                                                        | `title` / `body`                                                                   | `entityRef`                 | `contextRoute`          | `contextParams`  | 推送 `type`              | 去重键                                                               |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------- | ----------------------- | ---------------- | ------------------------ | -------------------------------------------------------------------- |
| `launch.review_approved`   | `launch.round` | 配置审核通过（`approveConfig`，API 审核事务内）                                       | 「{项目名} 审核已通过」/「请完成签名，发射才会部署」                               | `launchProject:<projectId>` | `launch2-project-sign`  | `{ projectId }`  | `launch_review_approved` | `launch.review_approved:<projectId>:v<configVersion>`                |
| `launch.review_rejected`   | `launch.round` | 配置驳回（`rejectConfig`）/ 资料驳回（`rejectProject`），审核事务内                   | 「{项目名} 审核未通过」/ `reasonText`                                              | `launchProject:<projectId>` | `launch2-projects-mine` | `{ projectId }`  | `launch_review_rejected` | `…:<projectId>:config:v<n>` / `…:<projectId>:material:<rejectionId>` |
| `launch.activated`         | `launch.round` | 任务 `activated` 且实例已登记（worker `notification_inbox` lane，标记列）             | 「{项目名} 已上链」/「YYYY-MM-DD HH:mm（北京时间）开售」，开售时间已过则「已开售」 | `launch2Instance:<id>`      | `launch2-instance`      | `{ instanceId }` | `launch_activated`       | `launch.activated:<instanceId>`                                      |
| `launch.deploy_failed`     | `launch.round` | 执行器 `transition` 到 `failed` 且 `failure_retryable = false`（worker 执行器事务内） | 「{项目名} 部署失败」/ 按失败码的简短原因                                          | `launchProject:<projectId>` | `launch2-projects-mine` | `{ projectId }`  | `launch_deploy_failed`   | `launch.deploy_failed:<jobId>`                                       |

- `payload`（全部字符串，≤ 16 键，每值 ≤ 512 码点）：`event`、`title`、`body`、`projectName`、`symbol`（有就带）、`taskId`、`projectId`；审核通过 / 配置驳回另带 `configVersion`；驳回带 `reasonCode`、`reasonText`；激活带 `jobId`、`instanceId`、`saleStartAt`（RFC 3339）；失败带 `jobId`、`failureCode`。
- **`taskId` = 项目 ID**（与 `projectId` 同值）：审核事件发生时还没有部署任务，项目是项目方在「我的项目」里看到的那一行，也是签名页的 `id`；部署任务 ID 另以 `jobId` 给出。
- 项目名：审核事件、激活用目录名 / 实例名；失败用该任务所签配置的 `name` / `ticker`（缺省回落目录）。
- `reasonText` = 审核员备注（trim 后非空），否则 `launchReviewReasonText("rejected", reasonCode)`（与「我的项目」页同一份中文）。
- 失败原因：`HOOKS_*` 失败码 → 一句中文（如 `HOOKS_SIGNATURE_EXPIRED`「签名已过期，请重新签名」），未知码「部署未完成，请联系平台」。
- 开售时间按北京时间（UTC+8）格式化，判断「已开售」用写入时刻。
- `contextRoute` 严格照 S291 任务单：`launch2-projects-mine`（不是 manifest slug `launch2-projects`；S292 客户端按契约字面匹配，不得改名）。
- S292 客户端校验（已对齐，否则 fail closed）：项目事件 `entityRef` 只接受 `launchProject:<uuid>`（本服务端只发这个；客户端另认 `launchTask:<uuid>`，服务端不用），`launch.activated` 只接受 `launch2Instance:<uuid>`；签名页先取 `contextParams.projectId`，再取 `launchProject:` 前缀里的 UUID，都没有退到我的项目；`launch.activated` 必带 `contextParams.instanceId`。推送本地化键 `push.launchReviewApproved.*` / `push.launchReviewRejected.*` / `push.launchActivated.*` / `push.launchDeployFailed.*`（`pushEventDictionary` 的 `titleLocKey` / `bodyLocKey`），客户端 iOS / Android 已加。

### B. 存储

同 0177 §A：`notifications.type` 存偏好类别 `launch.round`（十类不变），`event_type` 存细分事件；feed / 单条已读行 `type` = `event_type ?? type`。迁移 000099 把 `notifications_event_type_check` 放宽到八值。

### C. 写入方与幂等（每个事件、每个决策 / 任务最多一行）

- **审核（API 进程）**：`hooks-launch-review-repository` 的 `approveConfig` / `rejectConfig` / `rejectProject` 在业务插入之后、同一事务里调 `src/database/launch-review-inbox-repository.ts` 的写入函数（`insertNotificationRow`，`on conflict (owner_user_id, dedupe_key) do nothing`）。命令失败整体回滚 → 不写；同一 `operationId` 重放走既有 replay 分支，不再插。一个配置版本只能被批准或驳回一次；资料驳回每条驳回记录一行（被驳回后修改重提再驳回 = 第二行，与 0073 一致）。资料**通过**不发通知（还要等配置审核，未进入待签名）。
- **部署失败（worker 执行器）**：`hooks-launch-executor-repository.transition` 在同一事务里，若更新后 `status = 'failed' and failure_retryable = false` 则写一行。可重试失败不写（客户端显示「重试中」）；重试预算耗尽时执行器本身就以 `retryable = false` 落库（`fail()`），因此正好命中。去重键按 `jobId`。
- **激活（worker `notification_inbox` lane，marker 方式）**：执行器激活事务里还没有 `instanceId`（实例由 launch2 索引 lane 在任务 `activated` 后另行登记，随机 UUID），因此按 0177 毕业的做法：新列 `launch2_instances.inbox_activation_settled_at`，lane 每轮取未置标记的实例（`for update skip locked`，每批 20），任务确为 `activated`、实例 `listing = visible`、激活时刻（`coalesce(task.activated_at, registered_at)`）在 24 小时内 → 写项目方一行；然后置标记。标记 + 去重键双保险：重跑、标记丢失都不会写第二行；过期 / 隐藏 / 非 activated 只置标记。
- **不回填**：迁移把既有实例全部预置标记；审核与失败从上线后起算。
- 写库不看偏好与开关（与 0073 / 0177 一致：偏好只管推送，开关只管可见性）。

### D. 开关 `LAUNCH_REVIEW_INBOX_EMIT`（off | on，默认 off）

- 语义同 0177 的 `NOTIFICATION_INBOX_EMIT`，二者**互相独立**：`off` 时四种事件照常写库，但 feed（`items` 与 `unreadCount`）、`GET /v2/notifications/unread-count`、`POST /v2/notifications/read-all`、单条已读都看不见（单条已读 404），worker 不推送。`on` 全部可见并推送。
- 实现：读路径按「当前可见的细分事件集合」过滤（`event_type is null or event_type = any($visible)`），集合 = 0177 四种（`NOTIFICATION_INBOX_EMIT=on`）∪ 0178 四种（`LAUNCH_REVIEW_INBOX_EMIT=on`）。
- API（`config.launchReviewInboxEmit`）与 worker（`notificationInbox.launchReviewEmit`）各读一次同名变量，须同时切换。

### E. 推送

- 新推送事件 4 个：`launch_review_approved`、`launch_review_rejected`、`launch_activated`、`launch_deploy_failed`；类别 `launch.round`，非强制；本地化键 `push.launchReviewApproved.*`、`push.launchReviewRejected.*`、`push.launchActivated.*`、`push.launchDeployFailed.*`。payload 仍四键（`type` / `entityRef` / `contextRoute` / `eventVersion: "1"`）。
- 投递沿用 0177 `notification_inbox` lane：`claimPushes` 新增 `eventTypes` 过滤，只认领开关为 on 的事件（缺省 = 0177 四种）；先置 `push_settled_at` 再发，至多一次；30 分钟新鲜度，过期行每轮置 settled 不发；`eventKey = inbox:<dedupeKey>`。lane 关闭（`NOTIFICATION_INBOX_ENABLED=false`）时不推送也不写激活行。

### F. 迁移 000099

- `notifications_event_type_check` 八值；`launch2_instances.inbox_activation_settled_at` + 部分索引 `launch2_instances_inbox_activation_pending_idx (registered_at) where inbox_activation_settled_at is null`，既有行预置；`push_deliveries_event_type_check` 加 4 个新事件。
- `down`：存在四种新事件行或其推送记录时拒绝回滚。

## 4. Consequences

- 发布顺序：服务端可直接上线（开关 off，只多写库）；S292 客户端把四个新 `type` 加入 feed codec、router 增加 `launchProject` / `launch2Instance` 配对与四组推送本地化键并发版；全部受支持版本能解码后，API 与 worker 同时把 `LAUNCH_REVIEW_INBOX_EMIT` 切 `on`。off 期间写入的行在切 on 后立即出现；推送只补发 30 分钟内的。
- 未覆盖：`pnpm launch:review` 旧脚本（`launch-repository.reviewProject`，IDO 时代目录审核）不写通知；项目方主动取消任务不写通知。
- 证据：`test/launch-review-inbox.integration.test.ts`（真实 PostgreSQL：000099 约束 / 列 / 索引；配置通过一行且重放不重复；配置驳回带备注、资料驳回带原因码中文、失败命令不写；可重试失败不写、终态失败一行、重复写入被去重；激活经 lane 一行、标记丢失不重复；隐藏 / 过期只置标记；开关 off 时 feed / 未读 / 单条已读 / 全部已读不可见、on 可见；推送认领只取开关为 on 的事件且至多一次）、`test/launch-review-inbox.test.ts`（类别 / 路由 / 推送映射 / 四键 payload、四种文案与去重键、两开关分离、lane 推送门控）、`test/v2-notifications-routes.test.ts`（路由层 off 隐藏 / on 可见，且与 `NOTIFICATION_INBOX_EMIT` 互不影响）、`test/hooks-launch-review.test.ts`（审核事务内写通知）、`test/push-channel.test.ts`（推送事件字典）。
