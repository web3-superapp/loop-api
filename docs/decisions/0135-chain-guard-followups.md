# 0135 · chain guard 收尾：PoolManager 事件、费率策略预警、人工关闭、告警出口（S176-api，2026-10-14）

依据：主代理 S176 任务单（2026-10-14）；Decision 0134 §9 待决 5（事件类 incident 人工确认）、6（policy 预警与 `ProtocolFeeUpdated` 订阅）；`docs/24-主网部署预演-2026-10-13.md` 7.2（v4 协议费）、7.4 第 3 条（controller 源码未验证）；Decision 0102 / 0109（运营后台、角色与审计）。
范围：只在 `loop-api`。新增 migration `000080_chain_guard_followups`、一个后台写接口、两个 incident kind、三个可选 env（告警出口）；`launch2_event` lane 的计数拆分。不签名、不广播、不改 `/v1` / `/v2`、不改 App 契约、不改 `ops/*.env`。另修两处偶发测试的根因（§8）。

## 1. PoolManager 事件订阅（§9-6 后半）

日志查询的地址从 USD1 + ProxyAdmin 扩到 **USD1 + ProxyAdmin + 每个 PoolManager**（`CHAIN_GUARD_POOL_MANAGER_ADDRESS` 与各工厂 `poolManager()` 的并集，通常 1 个；合计通常 3 个、至多 5 个地址，仍是一次 `eth_getLogs`，远低于 publicnode 10 地址上限）。游标、范围（≤ 2000 块 × ≤ 5 段 / tick）、落后 `confirmations` 块都沿用 `chain_guard_cursors`，不新增游标。

事件签名取 Uniswap v4-core `IProtocolFees`（topic0 与 indexed 与否无关；`PoolId` 编码为 `bytes32`）：

| 事件                                                                  | 处理                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProtocolFeeUpdated(bytes32 indexed id, uint24 protocolFee)`          | 只认来自监视 PoolManager、`id` 属于我们已毕业池集合（`coalesce(official_pool_id, dynamic_pool_id)`）的记录；按既有阈值开 / 更新 `pool_protocol_fee_nonzero`（任一方向 > 0）与 `pool_protocol_fee_high`（≥ `CHAIN_GUARD_PROTOCOL_FEE_ALERT_PIPS`）。 |
| `ProtocolFeeControllerUpdated(address indexed protocolFeeController)` | 配置了 `CHAIN_GUARD_PROTOCOL_FEE_CONTROLLER` 且新值不等时开 `protocol_fee_controller_changed`（subject = PoolManager）；未配置时不评估（与 0134 状态读一致）。                                                                                      |

`details`：`source: "event"`、`blockNumber`、`transactionHash`，费率事件另有 `instanceId`、`poolManager`、两方向 pips、`alertPips`。

同一 tick 里**日志命中与状态读数确认同一 (kind, subject)** 时合并为一次写入：details 取状态读数并保留日志的 `source/blockNumber/transactionHash`（此前 0134 是先写日志 details 再被状态 details 覆盖，取证信息丢失；这一合并同样适用于 `Paused` / `Freeze`）。日志命中而状态读数已不成立（窗口内开了又关）仍是「open 后立即 resolved」一行，取证用，与 0134 §2 相同。

PoolManager 自身的 `OwnershipTransferred`（solmate `Owned` 与 OZ 同 topic0）会随查询返回，按 0134 规则既不是 USD1 也不是 ProxyAdmin，忽略。

## 2. 费率策略预警（§9-6 前半）

每 tick、每个已毕业池、每个 PoolManager：控制器 `protocolFeeController()` 非零时调用 `IProtocolFeeController.protocolFeeForPool(PoolKey)`（返回打包 uint24，低 12 位 zeroForOne、高 12 位 oneForZero，与 slot0 同编码）。PoolKey 用 `launch2PoolKey`（`src/features/launch2/launch2-pool.ts`，与 `/v2/launch2/*` 池路由同一推导：`min/max(MEME, USD1)`、`launch2Template.lpFee` 2500、`tickSpacing` 60、hook）重建，并要求 `launch2PoolId(key)` 等于库里的 pool id；hook 取 `official_pool_id` 非空时的 `hook_address`，否则 `dynamic_hook_address`（迁移 000076 的列）。

| kind                               | open（条件类，不 hold）                       | resolved                                                             |
| ---------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| `pool_protocol_fee_policy_nonzero` | 策略任一方向 > 0，而 slot0 两方向都还是 0     | 策略回到 0，或 slot0 已经非零（由 `pool_protocol_fee_nonzero` 接手） |
| `pool_protocol_fee_policy_high`    | 策略最大方向 ≥ 阈值，而 slot0 最大方向 < 阈值 | 策略低于阈值，或 slot0 已达到（由 `pool_protocol_fee_high` 接手）    |

读不到时本 tick 结果 `policyLimited: [...]`（去重排序），日志 `LOOP chain guard lane is limited` / `CHAIN_GUARD_POLICY_LIMITED`，`detailReasonCode` 为下列原因；**同一原因集合只记一次**（独立通道，不干扰 0134 的 `CHAIN_GUARD_CHECK_NOT_CONFIGURED` 去重）；不开事件：

| 原因                                  | 情况                                      | 已 open 的策略事件       |
| ------------------------------------- | ----------------------------------------- | ------------------------ |
| `CHAIN_GUARD_POLICY_CONTROLLER_UNSET` | 控制器为零地址（测试网现状）；不调用      | 视为「没有策略」，会解决 |
| `CHAIN_GUARD_POLICY_UNSUPPORTED`      | `protocolFeeForPool` revert / 无返回      | 保留（不因读不到而解决） |
| `CHAIN_GUARD_POLICY_POOL_KEY_UNKNOWN` | 实例的 MEME / hook 重建不出库里的 pool id | 保留                     |

传输错误（RPC 失败）仍是 tick 抛错 → 退避，与 0134 一致。

`pnpm chain:preflight` 每个池加一行 `pool.protocolFeePolicy`：`a/b pips (slot0 c/d, alert ≥ N)`；策略高于 slot0 为 WARN，其余 OK；读不到显示 `not read (<原因>)`，OK（不阻断预检）。

## 3. kind 表增量

| kind                               | 来源 | hold |
| ---------------------------------- | ---- | ---- |
| `pool_protocol_fee_policy_nonzero` | §2   | 否   |
| `pool_protocol_fee_policy_high`    | §2   | 否   |

既有 `pool_protocol_fee_nonzero` / `pool_protocol_fee_high` / `protocol_fee_controller_changed` 新增日志来源（§1），判定与解决不变。迁移 000080 重建 `chain_guard_incidents_kind_check`（17 个 kind）。

## 4. 人工关闭接口（§9-5）

`POST /admin/v1/chain-guard/incidents/{incidentId}/resolve`，body `{ "note": string }`（schema 1..500；服务端 trim 后仍须 1..500，拒绝控制 / 格式 / 分隔符字符，允许换行与 tab；不合格 422 `VALIDATION_FAILED` `CHAIN_GUARD_RESOLUTION_NOTE_INVALID`）。

- **权限**：既有 `console.write`（只 platform_admin 有；auditor / reviewer / testnet_acceptor 403 `PERMISSION_DENIED`；无 session 401）。没有新增权限。
- **结果**：200 `{ incident: {…, resolvedAt, resolution: "manual", resolvedBy, resolutionNote, reopensIfStillTrue}, audit: {auditId, seq, at} }`。`resolvedBy` = 会话的 `admin_accounts.id`；ADMIN_USERNAME 引导管理员没有账号 id，为 null（审计行的 `actor` 仍记用户名）。
- **幂等 / 错误**：已解决（自动或人工）409 `ADMIN_CONFLICT` `CHAIN_GUARD_INCIDENT_ALREADY_RESOLVED`，不写任何东西；不存在 / 非本链（`LAUNCH_CHAIN_ID`）/ 非 UUID 404 `NOT_FOUND` `CHAIN_GUARD_INCIDENT_NOT_FOUND`；无仓库或写失败 503 `CAPABILITY_UNAVAILABLE` `CHAIN_GUARD_REPOSITORY_UNAVAILABLE`。错误模型与既有后台一致。不要求 `Idempotency-Key`（0109 只对账号写接口要求；这里第二次调用天然 409）。
- **审计**：与 0102 的后台写接口相同，在**同一事务**里 `select … for update` → 更新 → 写一行 `admin_audit_log`（`action = chain_guard.incident.resolve`、`target_type = chain_guard_incident`、`target_id = incidentId`、`before = {kind, subject, lastSeenAt, resolvedAt: null}`、`after = {resolvedAt, resolution, note}`、`request_id`）；审计写不进则整个回滚（集成测试覆盖）。`admin-repository.ts` 导出 `insertAdminAuditRow` 供此复用，未复制 SQL。
- **预期行为（写明）**：状态类 kind（`usd1_paused`、`usd1_address_frozen`、`usd1_address_mismatch`、`usd1_implementation_changed`、`usd1_read_unsupported`、`protocol_fee_controller_changed`、`pool_protocol_fee_*`（含 policy）、`account_balance_low`）人工关闭后若事实仍在，**lane 下一 tick 会重新开一条新 incident**——人工关闭不能压住仍成立的条件；对 hold 类而言，关闭后签名 lane 只在下一 tick 前放行。响应里 `reopensIfStillTrue: true` 标出这一点。事件类（drained / reallocated / upgraded / admin / owner changed）关闭后不会重开（日志已在游标之后）。
- `GET …/incidents` 只列未解决行，未加 resolution 字段（既有字段不变）。
- OpenAPI：`pnpm openapi:generate` 重新生成 `openapi/loop-admin.v1.json`（`resolveAdminChainGuardIncident`）；v1 / v2 产物不变。

### 迁移 000080

`chain_guard_incidents` 加 `resolution text check in ('auto','manual')`、`resolved_by uuid`（**不做外键**：与 0110 起所有后台事实一样不引用 `admin_accounts`，避免 TRUNCATE … CASCADE）、`resolution_note text`（1..500）；既有已解决行回填 `auto`。约束 `chain_guard_incidents_resolution_shape`：`resolution` 恰在 `resolved_at` 非空时非空；`auto` 不带 `resolved_by` / note；`manual` 必须有 note。任务单写的「既有行回填 auto」按「既有**已解决**行」执行——open 行的 resolution 为 null，否则与「open 无 resolution」矛盾。lane 的自动解决写 `resolution = 'auto'`。`down` 在存在 policy kind 或 manual 行时拒绝回滚。

## 5. 告警出口（可选）

| env                              | 说明                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `CHAIN_GUARD_WEBHOOK_URL`        | 通用 JSON POST；须 `https://`（`http://` 只允许 localhost / 127.0.0.1），不得带用户名密码 |
| `CHAIN_GUARD_TELEGRAM_BOT_TOKEN` | Bot API token（`<数字>:<20–100 位>`）；与下一项必须同时设或同时不设                       |
| `CHAIN_GUARD_TELEGRAM_CHAT_ID`   | 数字 chat id（可负）或 `@channel`                                                         |

格式不合法拒绝启动（`ConfigurationError` 只写键名，不回显值）。worker 与 API 进程都解析（API 进程用于人工关闭的通知）；两者都未配置时 notifier 为 null，**行为与 0134 逐字节相同**（不发请求、不多打日志；worker 配置对象多一个 `chainGuardAlerts: null` 字段）。

触发点：incident opened、resolved（自动：lane；人工：后台接口，`resolution: "manual"`）、hold engaged / released（每条签名 lane 各自的转换各发一次，消息带 lane 名）。内容：`chainId`、`kind`、`subject`、`incidentId`、details（webhook 原样 + `detailsText`；Telegram 为 JSON 截断到 600 字符）、时间。Webhook body `{"source":"loop.chain_guard","type":…,…}`；Telegram `POST https://api.telegram.org/bot<token>/sendMessage`，`{chat_id, text, disable_web_page_preview: true}`，纯文本（无 `parse_mode`）。

投递规则：每个出口单次尝试、5 s 超时（`AbortSignal.timeout`）、不重试；调用方 `void notify(...)` 不等待，notifier 内部吞掉一切异常——不阻塞、不让 tick 失败。失败只打一条 warn：`LOOP chain guard alert was not delivered`，`reasonCode = CHAIN_GUARD_ALERT_DELIVERY_FAILED`、`chainGuardAlertOutlet`（`webhook` / `telegram`）、`rpcUrlHost`（只有主机名）、`rpcStatus`（HTTP 状态）或 `errorClass`。URL 路径与 bot token 绝不进日志（单测断言）。

## 6. `launch2_event` lane 的 ignored 噪音

- 读取器（`integrations/launch2/launch2-chain.ts`）：地址不在跟踪集合里的日志**在解码前**跳过，计入新的 `skippedForeign`；`ignored` 只剩「跟踪地址、但该角色不认识的 topic / 解码失败」。
- lane（`launch2-indexer-worker.ts`）：读到但不属于任何已登记实例的日志（工厂的外部部署 `LaunchDeployed`、非我们池 / 非路由的 Swap）原来计入 `ignored` 并触发 warn `LAUNCH2_EVENTS_IGNORED`；现计入 `skippedForeign`。tick 结果新增 `skippedForeignCount`；每 tick 有值时 debug 日志 `LOOP launch2_event lane skipped foreign logs`（`count`），不进 warn。`LAUNCH2_EVENTS_IGNORED` warn 只在真正 ignored 时出现。
- 索引语义不变：这些日志此前也不写库、不归属；只是换了计数桶。既有测试 `launch2-indexer-worker.test.ts` 的外部部署断言改为 `ignoredCount 0 / skippedForeignCount 1`。端口 `skippedForeign` 可选（缺省 0），既有 fake 不用改。

## 7. Unavailable 行为增量

| 情况                                    | 表现                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| 控制器零地址 / policy revert / key 不符 | tick `checked`，`policyLimited` 列原因，日志一次，不开事件（§2 表）             |
| PoolManager 日志里的非我们池            | 忽略，不计数、不日志                                                            |
| 告警出口不可达 / 超时 / 非 2xx          | 一条 warn（主机名），tick 与接口结果不受影响                                    |
| 后台 resolve 无仓库                     | 503 `CAPABILITY_UNAVAILABLE`                                                    |
| `CHAIN_GUARD_ENABLED=false`             | worker 不发任何告警；API 进程配了出口时仍会通知人工关闭（关闭的是库里已有的行） |

## 8. 偶发测试

- **admin_accounts 时间戳（根因已定位）**：`admin_accounts` 的 `credentials_changed_at` 与 `created_at` 两列默认值都是 `clock_timestamp()`，而 PostgreSQL 按列序**分别**求值；`credentials_changed_at` 排在前，所以常比 `created_at` 早几微秒，触发 `admin_accounts_timestamp_check (credentials_changed_at >= created_at)`。本机 docker Postgres 实测：同构两列 20 万行批量插入，2.8% 的行前一列 < 后一列，从未出现相反。生产代码（`admin-account-repository.ts`）一直用同一个 `t.now` 显式写两列，不受影响；受影响的是测试里依赖默认值的插入：`admin-console.integration`、`admin-role-separation.integration`、`dev-reset-users.integration`、`mining-settlement.integration`（两处）。改为显式 `created_at, credentials_changed_at = now(), now()`（同一事务时钟，确定相等），与 `admin-formula-approval-lockout.integration` 已有写法一致。没有加 sleep，没有放宽断言。表默认值本身未改（迁移只增不改；没有生产路径依赖它）。
- **control-plane 租约偶发**：未修。`provider_operations` 不存在上述「两列默认值 + 先后约束」的组合，租约测试用库内 `clock_timestamp()` 做到期判断，没有找到便宜且有把握的根因；没有失败日志前不做猜测性修改。

## 9. 测试

- 新增单测 26 条：`test/chain-guard-followups.test.ts` 20 条（费率 / 控制器日志、合并取证、非我们池忽略、policy nonzero / high / 回落 / limited 三原因、preflight 策略行、viem 读 `protocolFeeForPool` 元组编码与 no-data → null、PoolManager 日志解码与单一过滤器、告警出口 JSON / Telegram / 失败只报主机 / 超时 / env 校验不回显、launch2 读取器 foreign 与 ignored 分开、人工关闭后下一 tick 重开），`test/admin-chain-guard-routes.test.ts` +5（200 + 审计 + 从列表消失 + 引导管理员 null、409 / 404、note 校验、401 / 403 / 503、服务层通知），`test/chain-guard-runtime.test.ts` +1（worker 把 opened 与 hold_engaged 发到 webhook，失败一条 warn 不含路径）。
- 新增集成 5 条：`test/chain-guard-followups.integration.test.ts`（迁到 000079 写行再升 000080 验回填、resolution 形状约束与 policy kind、自动解决标 auto、人工解决 + 审计行同事务 + 409 / 404 不写、审计写失败整体回滚）；`chain-guard.integration.test.ts` 的手写插入补 `resolution`。
- 门禁：见提交说明（`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm openapi:check`、`pnpm test`、`pnpm build`、`pnpm test:integration`）。

## 10. 运维注意

- PoolManager 加入日志地址后单次 `eth_getLogs` 通常 3 个地址（USD1、ProxyAdmin、PoolManager；配置的 PoolManager 与两个工厂的都不同时至多 5 个），仍满足 publicnode 10 地址上限；但 PoolManager 是热点合约，过滤器只按 topic0 白名单匹配，返回量取决于这 9 个事件签名在 PoolManager 上的出现频率（`ProtocolFeeUpdated` / `ProtocolFeeControllerUpdated` / `OwnershipTransferred` 都极少），不会把 `Swap` 拉回来。
- `protocolFeeForPool` 每 tick 每池一次 `eth_call`（控制器零地址时不调用）；池数多时与 slot0 读同量级。
- 告警出口的 URL / token 是密钥：放 `api-dev.local.env` / staging 的 `*.local.env`（与其它密钥同处），不进仓库、不进 `ops/*.env`。webhook 路径本身常含密钥，日志只打主机名。
- 主网控制器 `0x66276d2e…5646b87c` 的源码仍未验证（docs/24 7.4-3）：`protocolFeeForPool` 若 revert，会稳定落在 `CHAIN_GUARD_POLICY_UNSUPPORTED`（一次日志），slot0 与 `ProtocolFeeUpdated` 仍兜底。
- 人工关闭 hold 类事件**不是**解除冻结 / 暂停的手段；事实仍在时下一 tick 立刻重开并重新 hold。

## 11. 需要主代理决定

1. hold 转换告警按 lane 各发一次（三条签名 lane 都启用时一次冻结发三条）；若要合并为一条，需要在 worker 里做跨 lane 去重。
2. 是否给 `admin_accounts` 两个时间戳默认值改成同一 `now()`（新迁移 `alter column … set default now()`）以根除 §8 的模式；本批只改了测试。
3. 策略预警是否进 preflight FAIL（现为 WARN）。
