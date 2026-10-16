# 0150 · 主网开关 `LAUNCH_MAINNET_ACK`（S214-api，2026-10-16）

- Status: Accepted (S214-api)
- Date: 2026-10-16
- Baseline: `integration/v2` = `069d798`
- Revises: `AGENTS.md` 硬边界第 1、2 条（各加一句）；Decision 0108 / 0112 / 0114 / 0118 / 0121 / 0124 / 0131 / 0116 中「BSC Testnet only / `LAUNCH_CHAIN_ID=97` only」的规则改为「97，或 56 且已 ack」
- Related: 0038（launch 链槽位）、0065（canary）、0134 / 0136（chain guard 与 hold）、0128（测试网水龙头，保持 97 专属）
- Scope: 只在 `loop-api`。新增 migration `000089_launch_slot_mainnet_chain_ids`（放宽两张表的 `chain_id = 97` 检查）；`openapi/loop-api.v2.json` 与 `openapi/loop-admin.v1.json` 只放宽 / 加字段，V1 与 public 工件字节不变。不改 `ops/`、不新增 npm 依赖。

## Context

S212 写 `ops/api-prod.env.example` 时发现（原文）：

> loop-api integration/v2 @466676c refuses to BOOT with LAUNCH_CHAIN_ID=56 and any of HOOKS_LAUNCH_FACTORY__, LAUNCH2_POOL_ROUTER__, LAUNCH2_DYNAMIC_FACTORY_* / _ROUTER_* ("is permitted only when LAUNCH_CHAIN_ID=97"), and refuses every write lane on 56 (executor, snapshot publisher, poke, buyback keeper: "BSC Mainnet signing stays closed"); features/launch/hooks-launch-{executor,deployment,submission}.ts also return idle/refuse off chain 97. A loop-api batch must lift these gates behind an explicit switch before T+0.

另外几处同样写死了 97：launch2 读模型与路由（`LAUNCH2_CHAIN_NOT_CONFIGURED`）、launch2 设备签名 prepare（`LAUNCH2_MAINNET_SIGNING_CLOSED`）、Mining 领取凭证（`MINING_CLAIM_MAINNET_CLOSED`）、各链适配器的 viem `bscTestnet` 与签名用的 EIP-155 `chainId: 97`、以及 `hooks_launch_deployment_tasks` / `hooks_launch_executor_nonces` 两张表的 `check (chain_id = 97)`。

`AGENTS.md` 硬边界：「Mainnet … remain disabled until explicit numbered security/product decisions enable them」。本决策就是那个编号决策，但**默认仍关闭**。

## Decision

### 1. 一个总开关

- 新 env `LAUNCH_MAINNET_ACK`（API 与 worker 共用，属于 0038 的 launch 槽位键组）。**只有**精确等于 `I_UNDERSTAND_THIS_IS_BSC_MAINNET_WITH_REAL_FUNDS` 时才算 ack；不 trim、不忽略大小写。
- 空 / 未设（默认）= 未 ack：`LAUNCH_CHAIN_ID=56` 的一切行为与 0150 之前逐字节相同（同样的拒绝、同样的报错文本）。
- 非空但不等于该句 → 启动拒绝（`LAUNCH_MAINNET_ACK: must be blank or exactly the Decision 0150 acknowledgement phrase`）。一句写错的 ack 永远不会被当成「没写」。
- **97 + ack → 启动拒绝**（`is permitted only when LAUNCH_CHAIN_ID=56`），而不是忽略：测试网的 env 文件里永远不出现主网那句话，主网 env 文件里永远必须有，复制错文件会立刻暴露。
- `LaunchChainConfig.mainnetAcknowledged`（配置对象新字段）= `LAUNCH_CHAIN_ID=56` 且 ack。97 上恒为 `false`。

### 2. 总写开关沿用 `BSC_WRITES_ENABLED`，不新造

- 仓库里只有一个「真钱写开关」：`BSC_WRITES_ENABLED`（0035 / 0065；API 进程，打开时必须有 `BSC_RPC_URLS` 与 canary 资产白名单）。0150 不新增第二套。
- worker 进程之前不读这个键；现在把它读成布尔（默认 `false`），**只**用作 56 上服务端签名 lane 的额外闸门。97 上的 lane 不看它（行为不变）。
- 后果：主网上打开任何服务端签名 lane，同一个 env 文件里的 `BSC_WRITES_ENABLED=true` 也会打开 API 的设备签名写（钱包转账 / 授权 / Swap、launch2 / Mining 的 prepare），二者共用 canary（见 §4）。这是「不要并存两套」的直接代价，运维按「一个开关 = 真钱路径整体打开」理解。

### 3. 开关矩阵

「拒启」= 配置加载抛 `ConfigurationError`，进程不启动；「拒绝」= 运行时 503 / lane idle 并带原因码。

**配置层（启动）**

| 链   | ack        | `BSC_WRITES_ENABLED` | 项                                                                                                           | 结果                                                                                                       |
| ---- | ---------- | -------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 97   | 空         | 任意                 | `HOOKS_LAUNCH_FACTORY_*`、`LAUNCH2_POOL_ROUTER_*`、`LAUNCH2_DYNAMIC_FACTORY_*`、`LAUNCH2_DYNAMIC_ROUTER_*`   | 允许（不变）                                                                                               |
| 97   | 空         | 任意                 | 四条写 lane 各自 enable                                                                                      | 允许（不变；不看 `BSC_WRITES_ENABLED`，chain guard 可选）                                                  |
| 97   | 精确句     | —                    | —                                                                                                            | **拒启**（ack 只许在 56）                                                                                  |
| 任意 | 非空且不等 | —                    | —                                                                                                            | **拒启**                                                                                                   |
| 56   | 空         | 任意                 | 上述四组合约键                                                                                               | **拒启**，报错原文不变 `is permitted only when LAUNCH_CHAIN_ID=97`                                         |
| 56   | 空         | 任意                 | 四条写 lane 任一 enable                                                                                      | **拒启**，报错原文不变 `…: permitted only when LAUNCH_CHAIN_ID=97 (BSC Mainnet signing stays closed)`      |
| 56   | 精确句     | 任意                 | 上述四组合约键                                                                                               | 允许；成对 / 地址格式 / code hash 格式校验照旧                                                             |
| 56   | 精确句     | `false`              | 四条写 lane 任一 enable                                                                                      | **拒启** `…: on LAUNCH_CHAIN_ID=56 also requires BSC_WRITES_ENABLED=true (Decision 0150)`                  |
| 56   | 精确句     | `true`               | Hooks executor / buyback keeper / poke keeper enable，`CHAIN_GUARD_ENABLED` 非 `true`                        | **拒启** `…: on LAUNCH_CHAIN_ID=56 also requires CHAIN_GUARD_ENABLED=true (Decision 0150)`（主网更严，§4） |
| 56   | 精确句     | `true`               | Hooks executor / buyback keeper / poke keeper enable + `CHAIN_GUARD_ENABLED=true`；snapshot publisher enable | 允许（各自的 key / Factory 等原有校验照旧）                                                                |
| 56   | 精确句     | `true`               | lane 的 enable 为 off                                                                                        | lane 不存在（每条 lane 仍需自己的开关，缺一不开）                                                          |
| 任意 | 任意       | —                    | `TESTNET_FAUCET_ENABLED=true` 且链 ≠ 97                                                                      | **拒启**（不变，测试网专属）                                                                               |

**运行层（动作）**

| 路径                                                                   | 97              | 56 无 ack                                                                      | 56 + ack                                                                                       |
| ---------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| launch2 读模型 lane `launch2_event`、`/v2/launch2/*` 读路由、公开页    | 不变            | `LAUNCH2_CHAIN_NOT_CONFIGURED`（不变；实际上配置层已拒启 Factory 键）          | 运行（读主链槽位 RPC，节点链 id 必须 = 56）                                                    |
| Hooks 配置 / 签名请求 / 提交（`hooks-launch-{deployment,submission}`） | 不变            | 503 unavailable（Factory reader 不构建；注入的 reader 链 ≠ 槽位或未 ack 也拒） | 允许；EIP-712 domain `chainId` = reader 链 id = 56                                             |
| Hooks executor lane                                                    | 不变            | 配置拒启；注入时 idle `LAUNCH_MAINNET_NOT_ACKNOWLEDGED`                        | 运行；节点链 ≠ 56 → `HOOKS_EXECUTOR_WRONG_CHAIN`；签名用 EIP-155 56；为别的链签的授权不执行    |
| snapshot publisher / buyback keeper / poke keeper lane                 | 不变            | 配置拒启；注入时 unavailable `LAUNCH_MAINNET_NOT_ACKNOWLEDGED`                 | 运行；链不一致 → 各自原有 `…CHAIN_MISMATCH`                                                    |
| launch2 设备签名 prepare（NFT mint / 曲线 / 官方池）                   | 不变            | 503 `LAUNCH2_MAINNET_SIGNING_CLOSED`（不变）                                   | 仍需 `BSC_WRITES_ENABLED`（否则 `LAUNCH2_WRITES_DISABLED`）+ canary + chain guard hold（0136） |
| Mining 领取凭证 prepare                                                | 不变            | 503 `MINING_CLAIM_MAINNET_CLOSED`（不变）                                      | 仍需合约地址 / 链 / 签名 key / `BSC_WRITES_ENABLED`（否则 `MINING_CLAIM_WRITES_DISABLED`）     |
| 测试网水龙头（0128）                                                   | 不变            | 拒（配置 + 服务 + 适配器三层）                                                 | **仍拒**                                                                                       |
| MEME v1 曲线签名 / 毕业 / 暂停（0101，`MEME_MAINNET_SIGNING_CLOSED`）  | 不变            | 拒                                                                             | **仍拒**（遗留 v1 曲线，主网不部署；不在 0150 范围）                                           |
| `hooks_testnet_acceptances`（测试网验收证据）                          | `chain_id = 97` | —                                                                              | 仍只写 97（定义上就是测试网证据）                                                              |

### 4. canary 与主网额外收紧

- canary（`BSC_WRITE_CANARY_ASSETS` / `_MAX_USD`（默认 20）/ `_DAILY_MAX_USD` / `_RECIPIENT_ALLOWLIST`）在 56 上**不放宽**：launch2 / Mining 的设备签名 prepare 走的就是 0065 那一套，默认值不变。主网的主链写（钱包转账 / Swap）从 0035 起就在 56 上受同一套 canary 约束，0150 不改它。
- 主网更严的一条（新增、只在 56 + ack）：Hooks executor、buyback keeper、poke keeper 三条会接 `CHAIN_GUARD_HOLD`（0134 §4）的服务端签名 lane，必须同时 `CHAIN_GUARD_ENABLED=true`，否则拒启——USD1 暂停 / 冻结时它们一定会停。snapshot publisher 不接 hold（0134 未接），不要求。
- 服务端 lane 自身的上限（gas 价格上限、gas limit 上限、重试次数等）默认值不变。

### 5. 动作层改法

- `features/chain/chain-contract.ts`：`launchMainnetAckPhrase`、`LaunchSlotPolicy { chainReference, mainnetAcknowledged }`、`testnetLaunchSlot`、`launchSlotActionsOpen()`、`launchSlotRefusal(slot, observedChain)`（`wrong_chain` / `not_acknowledged` / null）、原因码 `LAUNCH_MAINNET_NOT_ACKNOWLEDGED`。
- 各动作 / 适配器的 `launchSlot` / `chainReference` / `expectedChainId` 参数**缺省 = 97 测试网**（0150 之前的常量）；生产组合（`app.ts` / `worker-runtime.ts` / `database.ts`）一律显式传配置的槽位。漏传只会在 56 上 fail closed（链不一致），不会在 97 上改变行为。
- SQL：表里的整数 `chain_id` 改为配置槽位（经 `launchSlotChainReference()` 校验只允许 56 / 97 后才内插），nonce advisory lock 键 `hooks_launch_executor_nonce:<chain>:<address>`（97 的键文本不变）。

### 6. 诊断

- 启动日志：56 + ack 时 API 打一条 warn `LAUNCH_MAINNET_ACKNOWLEDGED: the launch slot is BSC Mainnet with real funds (Decision 0150)`（`reasonCode` `LAUNCH_MAINNET_ACKNOWLEDGED`、`launchChainId`），worker 打一条 warn `LOOP launch slot is BSC Mainnet with real funds (LAUNCH_MAINNET_ACKNOWLEDGED, Decision 0150)`（`reasonCode`）。无秘密、无端点。97 与 56 无 ack 不打。
- 诊断字段：`/health/ready` 属于冻结的 V1 工件，不动。改为在后台 `GET /admin/v1/launch/projects/{projectId}` 已有的 `deploymentChainId`（0117，显示当前链）旁加可选字段 `deploymentMainnetAcknowledged`：仅 56 + ack 时出现且为 `true`，其余情况不出现（所有 0150 前的响应字节不变）。

### 附表：硬编码清单（文件:行 → 处理）

行号为本批提交后的位置。

| 位置                                                                                                                                                                    | 原来                                                        | 处理                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/config.ts:479 / 532 / 583`（Factory、官方池 router、LoopDynamic Factory / Router 四对键）                                                                          | `LAUNCH_CHAIN_ID !== "97"` → 拒                             | `!launchSlotActionsPermitted(value)` → 拒（97 或 56+ack 放行），报错原文不变                   |
| `src/config.ts:3027 / 3134 / 3188 / 3253`（四条写 lane）                                                                                                                | `LAUNCH_CHAIN_ID !== "97"` → 拒                             | `launchSlotWriteLaneIssues()`：56 无 ack 原文拒；56+ack 另需 `BSC_WRITES_ENABLED=true`         |
| `src/config.ts:4540` `assertMainnetLaneChainGuard`                                                                                                                      | —                                                           | 新增：56+ack 下三条接 hold 的 lane 需 `CHAIN_GUARD_ENABLED=true`                               |
| `src/config.ts:1019` 水龙头                                                                                                                                             | `LAUNCH_CHAIN_ID !== "97"` → 拒                             | **保留**（测试网专属）                                                                         |
| `src/app.ts:2132`（Hooks Factory reader 构建）                                                                                                                          | `chainId === bscTestnetChainId`                             | `launchSlotOpen`，并传 `chainReference`                                                        |
| `src/app.ts:2275 / 2300 / 2347`（launch2 不可用原因、官方池 / LoopDynamic reader）                                                                                      | `chainId !== / === bscTestnetChainId`                       | `launchSlotOpen`；`createLaunch2Chain` 传 `expectedChainId`，两 reader 传 `chainReference`     |
| `src/app.ts:2368`、`src/features/launch2/launch2-service.ts:1386`                                                                                                       | `chainId === bscChainId` → `LAUNCH2_MAINNET_SIGNING_CLOSED` | 另需 `!mainnetAcknowledged`                                                                    |
| `src/app.ts:2469`、`src/features/mining/hourly-rewards-service.ts:357`                                                                                                  | `chainId === bscChainId` → `MINING_CLAIM_MAINNET_CLOSED`    | 另需 `!mainnetAcknowledged`                                                                    |
| `src/worker-runtime.ts:1227 / 1347 / 1475 / 1618`（launch2_event、publisher、keeper、poke）                                                                             | `chainId !== "eip155:97"` → idle                            | `!launchSlotOpen` → idle                                                                       |
| `src/worker-runtime.ts:1387`（快照签名 EIP-712）                                                                                                                        | `chainId: 97`                                               | `launchChainConfig.chainReference`                                                             |
| `src/worker-runtime.ts:1123 / 1164 / 1249 / 1268 / 1361 / 1400 / 1489 / 1521 / 1638 / 1646`                                                                             | 适配器 / lane 不带链                                        | 传 `chainReference` / `expectedChainId` / `launchSlot` / `mainnetAcknowledged`                 |
| `src/features/launch/hooks-launch-executor.ts:411 / 928 / 1296`                                                                                                         | 授权 / launchId `chainId: 97`；`chainId !== 97` → idle      | 槽位链；`launchSlotRefusal` → `HOOKS_EXECUTOR_WRONG_CHAIN` / `LAUNCH_MAINNET_NOT_ACKNOWLEDGED` |
| `src/features/launch/hooks-launch-deployment.ts:241`、`hooks-launch-submission.ts:258 / 288 / 398`                                                                      | `reader.chainId !== 97`；typed data / launchId `97`         | `launchSlotRefusal(launchSlot, reader.chainId)`；`reader.chainId`                              |
| `src/features/launch/hooks-launch-submission.ts`（`HooksLaunchDeploymentJob.chainId: 97`）                                                                              | 类型 `97`                                                   | `56 \| 97`，取自行                                                                             |
| `src/features/launch2/launch2-{snapshot-publisher:940, buyback-keeper:805, dynamic-poke:102}.ts`                                                                        | 只比链                                                      | 链一致后 56 另需 `mainnetAcknowledged`                                                         |
| `src/integrations/launch/hooks-launch-factory-reader.ts:270 / 283 / 321`                                                                                                | `bscTestnet`、`chainId !== 97`、`chainId: 97`               | `chainReference`（缺省 97）                                                                    |
| `src/integrations/launch/hooks-launch-executor-chain.ts:165 / 265`                                                                                                      | `bscTestnet`、签名 `chainId: 97`                            | `chainReference`（缺省 97）                                                                    |
| `src/integrations/launch2/launch2-dynamic-poke-chain.ts:56 / 106`                                                                                                       | `bscTestnet`、签名 `chainId: 97`                            | `chainReference`（缺省 97）                                                                    |
| `src/integrations/launch2/launch2-{chain, snapshot-publisher-chain, buyback-keeper-chain, meme-asset-chain, pool-chain, dynamic-chain}.ts`                              | viem `bscTestnet`                                           | `viemLaunchChain(期望链)`（新 `src/integrations/bsc/viem-launch-chain.ts`）                    |
| `src/database/hooks-launch-executor-repository.ts:229 / 429 / 437 / 464`                                                                                                | `chain_id = 97`、锁键 `…:97:…`、`values (97, …)`            | 槽位链                                                                                         |
| `src/database/hooks-launch-submission-repository.ts:101 / 257`                                                                                                          | `chainId: 97`、`values(…,97,…)`                             | 行的 `chain_id` / 槽位链                                                                       |
| `src/database/launch2-snapshot-publication-repository.ts:25 / 289`、`launch2-buyback-attempt-repository.ts:105 / 286`                                                   | `chain_id = 97`、锁键 `…:97:…`                              | 槽位链                                                                                         |
| `src/database/launch2-repository.ts:1963`（激活实例登记）                                                                                                               | `t.chain_id = 97`                                           | `$5::integer` = 槽位链                                                                         |
| `migrations/000054`、`000059` 的 `check (chain_id = 97)`                                                                                                                | 只许 97                                                     | 000089 放宽为 `in (56, 97)`                                                                    |
| `src/routes/v2/launch-schemas.ts`（任务 `chainId`、签名请求说明）、`src/routes/admin/admin-role-schemas.ts`（任务 `chainId`）                                           | `const: 97`                                                 | `enum: [56, 97]`（放宽）                                                                       |
| `migrations/000053` / `hooks-launch-review-repository.ts:540` / `admin-role-schemas.ts` 验收 `chainId`                                                                  | `97`                                                        | **保留**（测试网验收证据）                                                                     |
| `src/features/testnet-faucet/testnet-faucet-service.ts:115`、`src/integrations/bsc/testnet-faucet-chain.ts:64 / 235`、`migrations/000073`                               | 只许 97                                                     | **保留**（测试网专属）                                                                         |
| `src/features/meme/meme-intent-service.ts:411`、`src/integrations/meme/meme-{graduation,pause}-sender.ts`                                                               | 56 → `MEME_MAINNET_SIGNING_CLOSED`                          | **保留**（v1 曲线，主网不上）                                                                  |
| `src/features/chain/chain-contract.ts`（`bscTestnetChainId` 等常量）、`src/features/meme/meme-projection.ts`（浏览器链接）、`intent-contract.ts`（launch 槽位授权规则） | 常量 / 按链分支                                             | 不是闸门，保留                                                                                 |

## Consequences

- `AGENTS.md` 硬边界第 1、2 条各加一句：BSC Mainnet 的 launch 槽位动作路径由 0150 的 `LAUNCH_MAINNET_ACK` 控制、默认关闭；提现、自动交易、Pay、支付仍关闭。
- 主网上线前运维要在 env 里写 ack 那句话；忘写 = 启动拒绝（配了 Factory 键时），不会半开。
- 打开任何主网服务端签名 lane 必须同时开 `BSC_WRITES_ENABLED`（也打开设备签名写）和 chain guard。
- worker 现在读 `BSC_WRITES_ENABLED`；它必须是 `true` / `false`（之前 worker 忽略这个键）。API 与 worker 共用 env 文件时无影响。
- 其它并行批次若也加了 migration，`000089` 的编号需在合并时协调。

## Tests

- `test/mainnet-switch.test.ts`：ack 解析（默认、精确句、三种错误写法、97 + ack 拒启）；四组合约键 × {97, 56 无 ack, 56 + ack}（含 worker 的 Factory 键与索引、56 + ack 下格式校验照旧、水龙头仍拒）；四条写 lane × {97 不看写开关, 56 无 ack（写开关 true / false 都拒，原文）, 56 + ack 无写开关, 56 + ack + 写开关（三条接 hold 的 lane 无 chain guard 拒、有则开；publisher 直接开）, lane 关}；`launchSlotRefusal` 全表；Hooks 签名请求 / 提交在 {默认 97 reader, 56 reader 默认槽, 槽 56 + 97 reader, 56 无 ack, 56 + ack} 下的放行与拒绝；poke / publisher lane 的链不一致、56 无 ack、56 + ack；Mining 凭证原因（ack 不替代写开关）。
- `test/hooks-launch-executor.test.ts`：56 无 ack idle `LAUNCH_MAINNET_NOT_ACKNOWLEDGED`、主网槽遇测试网节点 `HOOKS_EXECUTOR_WRONG_CHAIN`、56 + ack 签并广播 56 任务、为 97 签的授权在 56 上不执行。
- `test/launch2-buyback-keeper.test.ts`：56 无 ack / 有 ack / ack 后链不一致。
- `test/v2-launch2-routes.test.ts`：56 无 ack 拒启 launch2 配置；56 + ack 读路由 200、prepare 越过主网闸门、关写开关仍 `LAUNCH2_WRITES_DISABLED`。
- `test/worker-runtime.test.ts`：`LAUNCH_MAINNET_ACKNOWLEDGED` warn 只在 56 + ack 出现一次、不含端点；executor / publisher / keeper / launch2 链适配器收到槽位链。
- `test/hooks-launch-executor-repository.integration.test.ts`（000089）：56 槽写 56 的任务与 nonce、两槽互不租用对方任务、同一账户两链 nonce 各自从 0 开始、其它链仍被 check 拒绝。
- 配置快照（`test/config.test.ts`、`test/reconciliation-worker-config.test.ts`）加 `mainnetAcknowledged: false`；最新 migration 名断言改为 000089；Hooks 路由测试显式 `LAUNCH_CHAIN_ID=97`（注入的是测试网 reader）。
