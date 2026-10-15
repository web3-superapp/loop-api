# 0146 · LoopDynamic 交割归属读模型：BuyCredited + CreditMoved 合并（S201-api，2026-10-16）

依据：主代理 S201-api 任务单；loop-contracts Decision 0014（main `b325c3f`，**§8 接线清单为准**）与源码 `LoopDynamicHook.sol` / `MemeToken.sol`；本仓 Decision 0131（LoopDynamic 读模型）、0132（tx.from 归属、MEME 覆盖）、0144（上一批接线）。
范围：只在 `loop-api`。迁移 **000086**；无新 env、无新 reason code。HTTP 合同只**加**字段（OpenAPI v2 重新生成）。不改 `ops/`、不重启 launchd、不动 dev 库。合约侧 S200 **未部署**：测试网现有 Hook 全是 S193 及更早代，不发 `CreditMoved`。

## 1. 结论

| 项               | 做法                                                                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 口径             | **任何路由买入都计权重，记给收币地址**（0014 §8.7）。权重 = 实付 USD1；LoopRouter 记调用者、名单路由记 `msgSender()`、其它任何路由记从 PoolManager 收到 MEME 的地址；同一交易里收币地址主动转出的部分，权重跟着转（`CreditMoved`） |
| 每地址权重       | `weight(round, a) = Σ BuyCredited(round, a) + Σ CreditMoved(round, *, a) − Σ CreditMoved(round, a, *)`，与链上 `buyWeight(round, a)` 逐地址相等；`totalBuyWeight(round) = Σ BuyCredited(round, *)`（挪动不改总量）                 |
| `BuyNotCredited` | 照旧只入 `launch2_events`，不计权。`buyer` 可能是回购适配器 / 被排除的收币地址；`buyer = 0` 只在 MEME 未绑定的 Hook（S200 之前）                                                                                                   |
| 旧实例           | S193 及更早 Hook 没有 `rewardHook` 绑定，不发 `CreditMoved`：只有 `BuyCredited`，读模型结果与 0131 相同（`credited = weight`，`moved_* = 0`）。ABI 解码器多认一个事件，不影响旧 Hook 的日志                                        |
| 归属标签         | 每条计权记录带 `attribution`：`loopRouter` / `registryRouter` / `delivery` / `moved` / `unknown`（§3）                                                                                                                             |
| 模板哈希         | 不变（0014 §6.1：无新参数）；本批不改签名 / 执行器                                                                                                                                                                                 |

## 2. ABI 同步

- 从 loop-contracts main `b325c3f` 构建（`forge build --out <scratch>`，不写 loop-contracts 的 `out/`）同步：`MemeToken` 增 `rewardHook()`、`bindRewardHook(address)`、`armAttribution()`、事件 `RewardHookBound`、错误 `RewardHookAlreadyBound`；`LoopDynamicHook` 增 `attributeDelivery(address,address,uint256)`、事件 `CreditMoved`、错误 `OnlyMeme`。其余所选合约（`LoopLaunchFactory`、`LoopDynamicLaunchFactory`、`LoopHookDeploymentFactory`、`LoopDynamicGraduationAdapter`、部署器等）ABI **逐项未变**，只有文件头的来源 commit 变化。
- `pnpm hooks:abi-sync --check --out <scratch>/out` 与 `test/hooks-launch-protocol-abi.test.ts`（`LOOP_PROTOCOL_DIR=<scratch>`）对 `b325c3f` 构建通过。注意：loop-contracts 主检出的 `out/` 仍是旧构建（缺 `CreditMoved`），一致性测试会按 0144 规则跳过；主代理在 loop-contracts 重新 `forge build` 后即恢复比对。
- `test/hooks-launch-loop-dynamic-anvil.integration.test.ts`（真实 S200 合约部署、模板读取、签名、执行器、激活）对 `b325c3f` 源码通过：模板哈希与核验链条不受 S200 影响。
- code hash：0014 §6.2 的新值（`LaunchTokenDeployer`、Hook 工厂、毕业适配器等）只影响**部署后**的 env（`LAUNCH2_DYNAMIC_FACTORY_CODE_HASH` 等），由部署批次填；本批不改 env。

## 3. 归属判定（lane，`classifyLaunch2DynamicCredits`）

`launch2_event` lane 在同一段日志里（MEME `Transfer`、PoolManager `Swap`、Hook 日志已合并排序）看每条 `BuyCredited` **紧前一条日志**（同交易、同区块、`logIndex − 1`）：

| 紧前一条                                                          | 判定             | 依据（合约源码）                                                                                  |
| ----------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| 本池的 PoolManager `Swap`，`sender` = Hook 的 `trustedRouter()`   | `loopRouter`     | 第 1 / 2 档在 `afterSwap` 里先于买入税记权，PoolManager 先发 `Swap` 再调 `afterSwap`              |
| 本池的 PoolManager `Swap`，`sender` 是其它路由                    | `registryRouter` | 同上；`Open` 策略下只有名单路由能在 afterSwap 里给出非零发起人                                    |
| 本实例 MEME 的 `Transfer(PoolManager → buyer)`                    | `delivery`       | `MemeToken._update` 先记余额（发 `Transfer`）再调 `attributeDelivery`，后者紧接着发 `BuyCredited` |
| 其它 / 缺失（`trustedRouter` 未知、该段 MEME 日志不可信、跨区块） | `unknown`        | 不猜                                                                                              |

- 结果写进该 `BuyCredited` 事件 payload 的 `attribution`（`launch2_events.payload`，重扫时覆盖）。0146 之前索引的行没有该键 → 投影为 `unknown`。
- `CreditMoved` 本身就是 `moved`，不需要判定。
- 聚合器「先 take 给自己再转」：聚合器那条 `BuyCredited` 是 `delivery`（收币地址是聚合器），用户那边是 `moved`。

## 4. 投影（迁移 000086）

- `launch2_events.event_name` 接受 `CreditMoved`。
- 新表 `launch2_dynamic_credit_entries`（投影，按实例从未移除的日志重建，与 0131 的其它 LoopDynamic 投影同一纪律，重组自动撤销）：每条 `BuyCredited` 一行 `in`（`attribution` 取 payload，非法 / 缺失 = `unknown`）；每条 `CreditMoved` 两行：`to` 的 `in` + `from` 的 `out`（都是 `moved`，`counterparty_address` = 对方）。主键 `(instance_id, chain_id, transaction_hash, log_index, direction)`；约束：`moved` ⇔ 有 counterparty，`out` 只能是 `moved`。
- `launch2_dynamic_buy_weights` 加 `credited_usd1` / `moved_in_usd1` / `moved_out_usd1`（存量行回填 `credited = weight`），约束 `weight = credited + moved_in − moved_out`；只保留 `weight > 0` 的地址（全部转出的聚合器没有行）。`credit_count` = `in` 条数。
- `launch2_dynamic_rounds.total_buy_weight_usd1` 仍 = Σ `BuyCredited`；`buyer_count` 改为合并后有正权重的地址数（之前 = 发过 `BuyCredited` 的地址数；旧实例两者相同）。
- `down`：已索引 `CreditMoved` 时拒绝。
- `scripts/dev-reset-users.ts` 与各集成套件的清表清单加入新表。

## 5. HTTP（OpenAPI v2，只加字段）

- `GET …/dynamic-pool`：
  - `currentRoundBuyers`（armed 轮才有，否则 null）：`{roundId, buyerCount, buyers[≤20]}`，按合并后权重降序；每项 `address`、`weightUsd1`、`creditedUsd1`、`movedInUsd1`、`movedOutUsd1`、`creditCount`、`attributions`（该地址 `in` 记录的去重归属）、`lastCreditedAt`。
  - `viewer` 增 `indexedCurrentRoundWeightUsd1`（投影的合并权重）与 `weightReconciled`（= 链上 `buyWeight(currentRound, wallet)`，即原 `currentRoundWeightUsd1`）。索引落后于 basis 块时为 false，不是错误；持续 false 才是分歧。
- `GET …/dynamic-pool/rewards`：每轮增 `creditedUsd1`、`movedInUsd1`、`movedOutUsd1`、`credits[≤20]`（`direction` in/out、`attribution`、`counterparty`、`amountUsd1`、`transactionHash`、`logIndex`、`creditedAt`，新到旧）。`weightUsd1` 是合并后的权重，`claimableUsd1` 按它算（与链上 `claim` 按 `msg.sender` 的 `buyWeight` 一致）。
- 路由与 schema 描述写明「任何路由买入都计权重，记给收币地址」，以及合约钱包 / 智能账户收币即记给该地址（领取须该地址调 `claim`，0014 §8.4）。

## 6. 测试

- `test/launch2-indexer-worker.test.ts`：第 1 / 2 档、交割（含买入税 take 与 `BuyFeeCharged` 在前）、聚合器 take 给自己的判定；`trustedRouter` 未知、MEME 段缺失、转给别人、跨区块 → `unknown`；lane 提交时 `BuyCredited` 带 `attribution`，`CreditMoved` 原样通过。
- `test/launch2-dynamic.integration.test.ts`（真实 PostgreSQL，`loop_api_test_s201`）：全额 / 部分（聚合器留 10%）/ 多次与链式挪动、反向挪回；跨轮不挪（第 2 轮挪动不动第 1 轮）；每轮 Σ 权重 = `total_buy_weight_usd1` 且 `buyer_count` = 正权重地址数；重组撤销挪动后权重回到转出方；0014 §7.1 Universal Router 分叉用例的事件序列复现链上 `buyWeight`（BOB 500、CAROL 100、路由 0、ALICE 50、总 650）；旧实例（无 `CreditMoved`、无 `attribution` 键）结果与 0131 相同、记录为 `unknown`；奖励记录 / 轮次买家列表 / 单地址权重读取。
- `test/v2-launch2-dynamic-routes.test.ts`：`currentRoundBuyers` 形状与金额格式；`weightReconciled` true / false；奖励轮次的合并分量与 `credits`。
- `test/launch2-dynamic.test.ts`：000086 的 up / down SQL。

## 7. 未做 / 待办

- **链上对账只在读路径**：`dynamic-pool` 的 `weightReconciled` 逐请求比对当前轮、当前钱包；没有后台逐地址扫 `buyWeight` 的对账 lane。真实 S200 合约上「交割 / 转发 → 索引 → 投影 = `buyWeight`」的 anvil 端到端未做（需要毕业 + 外部路由 swap 的 anvil 夹具，现有 anvil 套件只到激活）；以 0014 §7.1 分叉用例的事件序列代替。
- 部署 S200 合约后：填新 code hash env（0014 §6.2），旧 S193 工厂按 0144 §5 登记 legacy；在 loop-contracts 主检出重新 `forge build` 让 ABI 一致性测试恢复比对。
- 对外文案（LOOP `docs/31` §5.3）由主代理按 0014 §8.7 同步，本仓不改 LOOP/docs。
