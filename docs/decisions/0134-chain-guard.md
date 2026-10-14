# 0134 · 主网前链上风险监控：chain_guard lane + 部署预检（S174-api，2026-10-14）

依据：主代理 S174 任务单（2026-10-14）；`docs/24-主网部署预演-2026-10-13.md` 第七节（7.1.2 USD1 限制函数、7.1.3 对我们每个合约的影响、7.1.4 建议动作 2/3、7.2 v4 协议费、7.4 未确认项）；Decision 0121（回购 keeper）、0112（Hooks 执行器）、0131（LoopDynamic poke keeper）、0114（launch2 读模型）、0102/0109（运营后台与角色）。
范围：只在 `loop-api`。新增 migration `000079_chain_guard`、一个后台只读接口、一条默认关闭的 worker lane、一个运维脚本。不签名、不广播、不改 `/v1`、不改 App 契约、不改 `ops/*.env`。

## 1. 实体与稳定 ID

| 实体                    | 主键                            | 说明                                                                                                                                                        |
| ----------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain_guard_incidents` | `incident_id`（UUIDv4，opaque） | 一次观察到的风险。`subject` 是链上事实（小写地址或 32 字节 pool id），**不是**任何表的主键 / 外键。`details` 是读数快照（金额一律十进制字符串）。行不删除。 |
| `chain_guard_cursors`   | `chain_id`                      | USD1 / ProxyAdmin 日志已读到的块号（只增不减）。                                                                                                            |

去重：部分唯一索引 `(chain_id, kind, subject) where resolved_at is null`——同一 kind+subject 未解决时只有一行，再次命中只更新 `last_seen_at`（取较大值）和 `details`；解决后再命中开新行。

## 2. kind 全集与状态机

状态只有两个：open（`resolved_at is null`）→ resolved。没有人工确认接口（见 §9 待决）。

| kind                                     | 来源                                                                           | 何时 open                                                                    | 何时 resolved                       | hold |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------- | ---- |
| `usd1_paused`                            | `paused()`；`Paused` 日志                                                      | `paused() = true`，或读到 `Paused` 日志                                      | 下一次 `paused() = false`           | 是   |
| `usd1_address_frozen`                    | `frozen(addr)`；`Freeze(caller, account)` 日志                                 | 监视地址 `frozen = true`，或 `Freeze` 的 account 在监视集合                  | 该地址 `frozen = false`             | 是   |
| `usd1_implementation_changed`            | EIP-1967 实现槽 vs `CHAIN_GUARD_USD1_IMPLEMENTATION`                           | 不相等（含「不是代理」）                                                     | 相等；未配置该 env 时不评估、不解决 | 否   |
| `usd1_address_mismatch`                  | 工厂 `usd1()` vs 配置的 USD1                                                   | 不相等（subject = 工厂地址）                                                 | 相等                                | 否   |
| `usd1_read_unsupported`                  | `paused()` / `frozen()` revert 或无返回                                        | **仅链 56**；链 97（测试网 mock 没有这两个函数）只记入 tick 结果，不开事件   | 读数恢复                            | 否   |
| `protocol_fee_controller_changed`        | `PoolManager.protocolFeeController()` vs `CHAIN_GUARD_PROTOCOL_FEE_CONTROLLER` | 不相等                                                                       | 相等；未配置时不评估                | 否   |
| `pool_protocol_fee_nonzero`              | 每个已毕业池 `slot0` 位 184–207（`extsload(keccak(poolId, 6))`）               | 任一方向 > 0                                                                 | 两个方向都回到 0                    | 否   |
| `pool_protocol_fee_high`                 | 同上                                                                           | 任一方向 ≥ `CHAIN_GUARD_PROTOCOL_FEE_ALERT_PIPS`（默认 500；Hook 容忍 1000） | 低于阈值                            | 否   |
| `account_balance_low`                    | 签名账户 `eth_getBalance`                                                      | < `CHAIN_GUARD_MIN_BNB`（默认 0.05）                                         | ≥ 阈值                              | 否   |
| `usd1_frozen_funds_drained`              | `FrozenAccountDrained(caller, account, amount)`                                | account 在监视集合                                                           | 最后一次看到后 24 小时              | 否   |
| `usd1_frozen_funds_reallocated`          | `FrozenFundsReallocated(caller, from, to, amount)`                             | from 在监视集合                                                              | 24 小时                             | 否   |
| `usd1_upgraded`                          | 代理 `Upgraded(implementation)`                                                | 任一                                                                         | 24 小时                             | 否   |
| `usd1_proxy_admin_changed`               | 代理 `AdminChanged(previousAdmin, newAdmin)`                                   | 任一                                                                         | 24 小时                             | 否   |
| `usd1_proxy_admin_ownership_transferred` | ProxyAdmin（地址取自 EIP-1967 admin 槽）`OwnershipTransferred`                 | 任一                                                                         | 24 小时                             | 否   |
| `usd1_owner_transferred`                 | USD1 自身 `OwnershipTransferred`（TokenGovernor 被换）                         | 任一                                                                         | 24 小时                             | 否   |

事件签名以 BSC USD1 实现 `StablecoinV2`（`0x694A…1F08`，Sourcify `exact_match`，2026-10-14 取 ABI）为准：`Paused(address)`、`Unpaused(address)`、`Freeze(address indexed caller, address indexed account)`、`Unfreeze(…)`、`FrozenAccountDrained(address indexed caller, address indexed account, uint256)`、`FrozenFundsReallocated(address indexed caller, address indexed from, address indexed to, uint256)`；代理与 ProxyAdmin 为 OZ 标准。`Unpaused` / `Unfreeze` 不开事件，由状态读数解决。

一次 tick 里先写日志命中、再写状态命中、再解决：所以「暂停后又在同一窗口内恢复」会留下一行 open 后立即 resolved 的记录（取证用）。

## 3. 监视集合

- 每个 `launch2_instances`（同链）：NftEscrow、ProjectNFT、CurveEngine、GraduationAdapter、BuybackAdapter、BuybackExecutor；已毕业池取 `coalesce(official_pool_id, dynamic_pool_id)`。
- 配置的工厂（`HOOKS_LAUNCH_FACTORY_ADDRESS`、`LAUNCH2_DYNAMIC_FACTORY_ADDRESS`）链上读出：`usd1`、`poolManager`、`platformTaxReceiver`、`primaryKeeper`、`fallbackKeeper`、`deploymentExecutor`，OfficialTax 工厂另有 `feeVault`，LoopDynamic 工厂另有 `loopRouter`（没有该函数时为 null）。
- `LAUNCH2_POOL_ROUTER_ADDRESS`（OfficialPoolRouter）、`CHAIN_GUARD_POOL_MANAGER_ADDRESS`、`CHAIN_GUARD_WATCH_ADDRESSES`（`label:0x…` 列表，补工厂读不到的地址）。
- 签名账户（同时查 `frozen` 与 BNB 余额）：本进程配置的执行器 / 回购 keeper / 快照提交者 / poke keeper 私钥**在本地派生地址**（私钥不出函数、不进日志），加工厂的 primary / fallback keeper 与 deploymentExecutor，加 `CHAIN_GUARD_BALANCE_ACCOUNTS`。
- 同一地址多个角色合并为一个，`labels` 列出全部角色。

RPC：读 launch slot（`LAUNCH_CHAIN_ID` 56 或 97）。日志查询只有 USD1 与 ProxyAdmin 两个地址（远低于 publicnode 10 地址上限），每次 ≤ 2000 块，每 tick ≤ 5 次，落后头部 `confirmations` 块；首启从 `safe − 2000` 开始（停机期间的暂停 / 冻结由状态读数兜底，没收 / 升级事件超过 5×2000 块的积压会分多个 tick 追上）。

## 4. 处置联动（CHAIN_GUARD_HOLD）

`CHAIN_GUARD_ENABLED=true` 且仓库可用时，`launch2_buyback_keeper`、`hooks_launch_executor`、`launch2_dynamic_poke` 三条 lane 每个 tick 开头调用共享只读查询 `listHolds(chainId)`（未解决的 `usd1_paused` / `usd1_address_frozen`）：

- 有 → 本 tick 直接返回 `{kind: "held", reasonCode: "CHAIN_GUARD_HOLD", holdCount}`，不读链、不签名；进入 / 解除各记一行日志（error `LOOP chain guard hold engaged; the lane skips its ticks` / warn `… released`，`reasonCode` `CHAIN_GUARD_HOLD` / `CHAIN_GUARD_HOLD_RELEASED`）。
- 查询失败 → 抛错，lane 走原有退避（宁可不跑，不在无保护时跑）。
- 三条 lane 的其它逻辑未改；`CHAIN_GUARD_ENABLED=false` 时它们不接 hold（行为与之前逐字节相同）。
- hold 是全局的：任一监视地址被冻结就停三条 lane（不区分是哪个项目的托管）。按项目细分见 §9。

## 5. 告警出口

不复用 `createAlertEvaluatorWorker`：它是**用户价格提醒**（写用户通知 / 推送），不适合运维告警。沿用 worker 日志约定：

| 日志 message                         | level | 字段                                                                                                                                                          |
| ------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOOP chain guard incident opened`   | error | `lane=chain_guard`、`reasonCode=CHAIN_GUARD_<KIND 大写>`、`chainGuardIncidentId/Kind/Subject`                                                                 |
| `LOOP chain guard incident resolved` | warn  | `reasonCode=CHAIN_GUARD_INCIDENT_RESOLVED` + 同上                                                                                                             |
| `LOOP chain guard lane is limited`   | warn  | `CHAIN_GUARD_CHECK_NOT_CONFIGURED`（`detailReasonCode` 列出未配置的检查）/ `CHAIN_GUARD_USD1_NOT_CONFIGURED` / `CHAIN_GUARD_CHAIN_MISMATCH`，同一原因只记一次 |
| `LOOP chain guard lane stays idle`   | warn  | `CHAIN_GUARD_REPOSITORY_UNAVAILABLE` / `CHAIN_GUARD_CHAIN_NOT_CONFIGURED`                                                                                     |
| `LOOP chain guard lane enabled`      | info  | `count`（签名账户数）、`confirmations`                                                                                                                        |

worker 日志的 `lane` 白名单补上 `chain_guard` 与此前遗漏的 `launch2_dynamic_poke`（此前 poke 日志的 `lane` 字段被清洗掉）。重复命中不重复打日志。

查询面：`GET /admin/v1/chain-guard/incidents`（运营后台，既有 session cookie 鉴权，`console.read`：platform_admin、auditor；reviewer / testnet_acceptor 403；无 session 401）。未放 `/health/ready`：就绪探针失败会把 API 摘流，而 USD1 暂停不是 API 故障。

## 6. Unavailable 行为

| 情况                                                                           | 表现                                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_GUARD_ENABLED` 未设 / false                                             | lane 不注册，三条签名 lane 不接 hold                                                                                  |
| 无数据库仓库                                                                   | lane `stays idle`（`CHAIN_GUARD_REPOSITORY_UNAVAILABLE`），签名 lane 不接 hold；后台接口 503 `CAPABILITY_UNAVAILABLE` |
| launch slot 无 RPC                                                             | lane `stays idle`（`CHAIN_GUARD_CHAIN_NOT_CONFIGURED`）；**hold 仍接上**，已有未解决事件继续生效（fail closed）       |
| 无 USD1 地址且无工厂                                                           | tick `unavailable`（`CHAIN_GUARD_USD1_NOT_CONFIGURED`），不写库，已有事件保持                                         |
| RPC 返回的链 ≠ 配置                                                            | tick `unavailable`（`CHAIN_GUARD_CHAIN_MISMATCH`）                                                                    |
| RPC 读失败                                                                     | tick 抛错 → 退避重试；已有事件保持（不会误解决）                                                                      |
| 未配 `CHAIN_GUARD_USD1_IMPLEMENTATION` / `CHAIN_GUARD_PROTOCOL_FEE_CONTROLLER` | 该检查不评估、不解决，日志 `CHAIN_GUARD_CHECK_NOT_CONFIGURED`；预检在链 56 上把未配实现地址判为失败                   |
| 测试网 tUSD1 无 `paused` / `frozen` / 事件                                     | lane 正常空转，tick 结果 `unsupported: ["usd1.paused","usd1.frozen"]`，不开事件                                       |

后台接口返回空列表只表示「库里没有 open 事件」，不代表 lane 在跑——lane 是否在跑看 worker 日志（接口描述已写明）。

## 7. 部署预检 `pnpm chain:preflight [--dry] [--json] [--no-database]`

读同一套 env（`.env.local` 或运维传入的环境）：USD1 `paused`、实现地址、ProxyAdmin、每个监视地址 `frozen`、工厂 `usd1()` 一致性、每个 PoolManager 的协议费控制器、每个已毕业池的协议费、签名账户 BNB 余额；`DATABASE_URL` 存在时读已注册实例（否则提示，`--no-database` 关闭提示）。

判定（`chainPreflightReport`，与 lane 共用读数与判断函数）：

- FAIL：暂停、冻结、实现不符、工厂 USD1 不一致、控制器不符（配置了期望值时）、协议费 ≥ 阈值、余额 < 下限；**链 56** 上未配 `CHAIN_GUARD_USD1_IMPLEMENTATION`、`paused` / `frozen` 读不到。
- WARN：协议费 > 0 但低于阈值；未配期望控制器；链 97 上的「读不到」与未配实现地址。
- 退出码：0 全过；1 有 FAIL；2 跑不起来（配置非法、无 RPC、RPC 链不符、无 USD1 地址、读失败）。`--dry` 打印同一张表，有 FAIL 也退出 0（仍打印 “would fail”），用于测试网。
- 输出不含 RPC URL、不含私钥；错误只打印错误类名。

## 8. env（全部可选，只在 worker / 预检进程读）

| env                                   | 默认    | 说明                                                                                                                 |
| ------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_GUARD_ENABLED`                 | `false` | `true` / `false`，其它值拒绝启动                                                                                     |
| `CHAIN_GUARD_INTERVAL_SECONDS`        | `60`    | 15–3600                                                                                                              |
| `CHAIN_GUARD_USD1_ADDRESS`            | —       | 优先；否则 `LAUNCH_USD1_ADDRESS`（属于 0076 四键组）；否则工厂 `usd1()`                                              |
| `CHAIN_GUARD_USD1_IMPLEMENTATION`     | —       | 主网填 `0x694Aa534bdef8eD63244eB902E7914e527891F08`（docs/24 7.5 已人工核实）                                        |
| `CHAIN_GUARD_POOL_MANAGER_ADDRESS`    | —       | 工厂部署前用；主网 `0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF`                                                      |
| `CHAIN_GUARD_PROTOCOL_FEE_CONTROLLER` | —       | 期望的控制器；主网 2026-10-14 读数 `0x66276d2e80784180e4b9b859e4327b9c5646b87c`（与 docs/24 7.2.1 一致；源码未验证） |
| `CHAIN_GUARD_PROTOCOL_FEE_ALERT_PIPS` | `500`   | 1–1000                                                                                                               |
| `CHAIN_GUARD_MIN_BNB`                 | `0.05`  | 十进制 BNB，≤ 18 位小数                                                                                              |
| `CHAIN_GUARD_WATCH_ADDRESSES`         | —       | `label:0x…,label:0x…`                                                                                                |
| `CHAIN_GUARD_BALANCE_ACCOUNTS`        | —       | 同上格式；例如本进程没有私钥的快照发布者                                                                             |

## 9. 需要主代理决定

1. **后台路由位置**：现放 `GET /admin/v1/chain-guard/incidents`（既有后台鉴权）。任务单给的备选 `/v2/meta/chain-guard` 需要在 `/v2` 引入管理员鉴权（目前 `/v2` 只有 Privy Bearer），未采用。
2. **阈值**：协议费告警 500 pips、BNB 下限 0.05。主网回购 keeper / 执行器的 gas 消耗（docs/24 第二节）可能需要更高下限。
3. **hold 粒度**：现为全局（任一监视地址冻结即三条 lane 全停）。若希望只停受影响项目（例如仅某个项目的 Escrow 被冻结），需按 `instanceId` 细分。
4. **实现地址变化 / 协议费 ≥ 阈值是否也要 hold**：现不 hold，只告警。docs/24 7.1.4 写「实现变了先人工复核再继续」——若要强制，可把 `usd1_implementation_changed` 加进 `chainGuardHoldKinds`（一行改动）。
5. **事件类 incident 的确认**：现为看到后 24 小时自动解决，没有人工确认接口。若需要「人工确认后才关闭」，要加一个带审计的后台写接口。
6. 7.2.3 建议的 policy `computeFee(poolKey)` 预警与 PoolManager `ProtocolFeeUpdated` 事件订阅**未做**：policy / controller 源码未验证（7.4 第 3 条），只靠 slot0 读数（每 tick）兜底。
7. App 显示「USD1 暂停 / 地址受限」（7.1.4 第 2 条）未做：本批只到运维面。

## 10. 实测（2026-10-14，只读，未广播）

- `pnpm chain:preflight --dry --no-database`，BSC Testnet publicnode，工厂 v4 `0x28D9…1C07` + OfficialPoolRouter：tUSD1 `0x3a12…0195` 不是代理、`paused` / `frozen` 不支持（WARN），测试网 PoolManager `0xde15…b7da` 的控制器为零地址；**primaryKeeper `0x5f11…e260` 余 0.0498 tBNB、deploymentExecutor `0x7b89…32b8` 余 0.0496 tBNB，低于 0.05（FAIL）**；fallbackKeeper 0.39998992。14 项检查，2 FAIL，9 WARN，`--dry` 退出 0。
- 同一读取器对 BSC 主网 publicnode：USD1 `paused() = false`，实现 `0x694aa534…891f08`、ProxyAdmin `0xa032fe6c…4aece`（均与 docs/24 7.1.1 一致），`frozen(PoolManager) = false`，`protocolFeeController() = 0x66276d2e…5646b87c`；最近 2000 块 USD1 / ProxyAdmin 无受监视事件。
