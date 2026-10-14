# 0137 · launch2 接 NFT 托管款两条出口：快照超时开盘 + 未毕业按 NFT 退款（S179-api，2026-10-14）

状态：**依赖合约 S175 合并**（loop-contracts `feat/S175-escrow-exit` 24d6f41，合约 Decision 0011，待需求方拍板）；**现网工厂不支持时行为与 ebf2b36 逐字节一致**（见 §7）。

依据：主代理 S179 任务单（2026-10-14）与 App 侧（S179-mobile）四处对齐；合约 0011 §6 接线清单；Decision 0114（读模型）、0118 / 0122（snapshot publisher 与「别人先开了」）、0133（工厂清单）、0136（chain guard hold）。
范围：只在 `loop-api`。迁移 `000081`、新 env `LAUNCH2_TIMEOUT_OPEN_ENABLED`（worker，默认 false）、实例详情两个新字段、两条新路由、`launch2_event` 与 `launch2_snapshot_publisher` 两条 lane 的增量。未广播任何真实链、未碰 ops 栈 / dev 库。

## 1. 能力探测（fail closed）

- 按**工厂**判定：`LoopLaunchFactory.snapshotTimeout()` 与 `refundDelay()` 都答（且 > 0）→ 支持；合约 revert 或返回空数据（选择器不存在，`ContractFunctionZeroDataError`）→ 不支持；RPC 失败 → 抛错、**不缓存**。
- 结果按工厂地址缓存在进程内（两值是工厂 immutable）：API 的 launch2 service、`launch2_event` lane、publisher 各一份（`createLaunch2ExitProbe`）。实例模块由工厂部署，工厂支持即其 escrow / registry 支持。
- 读取函数是 `Launch2Chain.readExitTiming?` / `Launch2PublisherChain.exitTiming?`（可选）；没有该函数的读取器（旧的测试替身）一律视为不支持。
- ABI：S175 不在 loop-contracts main，`hooks:abi-sync` 及其检查读 main，所以只把需要的函数 / 事件 / 错误**原样**从 S175 forge 产物拷到单独文件 `src/integrations/launch/hooks-launch-protocol-abi-escrow-exit.ts`（工厂 2、registry 8、escrow 13 + `ERC721NonexistentToken`、ProjectNFT `ownerOf`）；生成模块未动。S175 合并后这些条目并入生成选择、删掉该文件。

## 2. 索引与读模型（迁移 000081）

| 对象                                                                | 内容                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch2_events.event_name`                                         | 加 `PublicRoundOpenedAfterTimeout`、`RefundClaimed`                                                                                                                                                   |
| `launch2_instances.opened_after_timeout_{at,block,tx,total_minted}` | 第一条未 removed 的 `PublicRoundOpenedAfterTimeout` 的投影；全有或全无；与 `snapshot_root`、`opened_without_holders_at` 互斥、不出现在 v2 实例（约束 `launch2_instances_opened_after_timeout_shape`） |
| `launch2_nft_refunds`                                               | `RefundClaimed` 的类型化事实：tokenId、owner、amount、remainingRecorded、escrow、tx、block、log、`removed`；部分唯一索引「每实例每 token 至多一条未 removed」；重组 rewind 同其它事实表               |
| `launch2_intents.kind`                                              | 加 `nft_refund`                                                                                                                                                                                       |
| `launch2_nft_refund_reports`                                        | 设备上报的退款交易 hash（intent 主键，append-only 触发器，同 0131 claim report）                                                                                                                      |
| `launch2_snapshot_publications.action`                              | 加 `open_after_timeout`（形状同 `open_without_holders`：无 members / 签名、零 root / dataHash；cutoff 两列存做决定时的 head 块号 / hash）                                                             |

- lane：`snapshots` 角色的 ABI 多解 `PublicRoundOpenedAfterTimeout`（旧 registry 不会发这个 topic）；新角色 `escrow`（只解 `RefundClaimed`）**只对支持出口路径的实例**加进 getLogs 地址表——不支持的实例地址表与以前一字不差。探测 RPC 失败让本 tick 失败（退避重试），不会「当作不支持」而漏掉退款日志。
- 阶段：`PublicRoundOpenedAfterTimeout` 到达即 `public`，无提前购（`deriveLaunch2Stage` 新入参 `openedAfterTimeoutAt`，与 0122 的零持有人开盘同一分支）。链上 `earlyRoundEndsAt = rootPublishedAt`，报价 / prepare 的链上阶段自然一致。
- 实例记录新增 `openedAfterTimeout`、`nftRefundedCount`（未 removed 的 refunds 行数）；lane 实例新增 `factoryAddress`、`openedAfterTimeoutAt`。

## 3. 实例详情 `GET /v2/launch2/instances/{instanceId}`（字段名与枚举按 App 已实现的写法，未改）

```
exitPaths: null | {
  snapshotTimeoutAt, timeoutOpenState: not_applicable | waiting | available | opened_by_timeout,
  refundOpensAt, refundState: not_applicable | waiting | open | closed_graduated,
  refundedCount: integer, totalMinted: integer
}
viewerNftRefunds: null | [{ tokenId, refunded, claimable, amount (十进制 USD1), opensAt }]
```

- `snapshotTimeoutAt = nftSaleEnd + snapshotTimeout`；`refundOpensAt = min(rootPublishedAt, snapshotTimeoutAt) + refundDelay`（rootPublishedAt 只在已开盘时计入；与合约 0011 §2.3-1 的 min 版本一致）。两者是 immutable + 已索引开盘时刻的纯函数，按合约算式在读模型里重算，不每请求读链。`totalMinted` = 已索引 mint 数，`refundedCount` = 已索引退款数。
- `timeoutOpenState`：已超时开盘 → `opened_by_timeout`；发售未结束 / 已按快照或零持有人开盘（含已毕业）→ `not_applicable`；未到 `snapshotTimeoutAt` → `waiting`；到了仍未开盘 → `available`。
- `refundState`：零铸造 → `not_applicable`；已毕业 → `closed_graduated`；未到 `refundOpensAt` → `waiting`；否则 `open`。
- `viewerNftRefunds`：viewer 钱包当前持有的 tokenId 来自已索引的 NFT `Transfer`（每个 token 最新一条的 `to`，升序，最多 50 枚），再在**同一块**读 `refundQuote` / `refunded` / `ownerOf`；链上 owner 不是该钱包的（索引滞后于转让）剔除。`amount` 就是 `refundQuote` 的数，不自算。无钱包或无 NFT → `[]`；工厂不支持 / 能力读不到 → 两字段都 `null`；报价读失败 → `viewerNftRefunds: null`（`exitPaths` 照给）。
- 超时开盘后 `snapshot.earlyRoundEndsAt` = 开盘时刻（同 0122）；`snapshot.status` 枚举**未加值**（仍为 `pending`，App 以 `exitPaths.timeoutOpenState` 与 `stage` 判断，见 §8-2）。
- 列表与 `GET /v2/launch2/me/positions` 不加（§8-4）。

## 4. 退款交易

`POST /v2/launch2/instances/{instanceId}/nft/refund/prepare`，体 `{walletId, tokenId}`（与 `nft/prepare` 同形多一个 tokenId；tokenId 为 uint256 十进制字符串，否则 400）。顺序：`BSC_WRITES` / 主网关闭 → 体校验 → 实例可见 → **0136 hold**（503 `LAUNCH2_USD1_PAUSED` / `LAUNCH2_ADDRESS_FROZEN` / `CHAIN_GUARD_REPOSITORY_UNAVAILABLE`）→ 能力（503 `LAUNCH2_EXIT_PATHS_UNSUPPORTED`；探测 RPC 失败 503 `LAUNCH2_CHAIN_READ_FAILED`）→ 签名钱包 → 幂等 intent（build 内一块读链，按合约自身顺序预检）：

| 条件                                          | 拒绝                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 实例 integrity hold                           | 409 `DATA_STALE` / `LAUNCH2_INSTANCE_PAUSED`                                                                          |
| 钱包 ≠ `ownerOf(tokenId)`（含不存在的 token） | 403 `POLICY_BLOCKED` / `LAUNCH2_REFUND_NOT_OWNER`                                                                     |
| 块时间 < `refundOpensAt()`                    | 409 `DATA_STALE` / `LAUNCH2_REFUND_NOT_OPEN`（`detailsSafe.opensAt`）                                                 |
| 曲线已毕业                                    | 409 `DATA_STALE` / `LAUNCH2_REFUND_GRADUATED`                                                                         |
| `refunded(tokenId)`                           | 409 `DATA_STALE` / `LAUNCH2_REFUND_ALREADY_CLAIMED`                                                                   |
| `refundQuote` 金额 0（托管余额被没收殆尽）    | 409 `INSUFFICIENT_BALANCE` / `LAUNCH2_REFUND_NOTHING_TO_REFUND`（任务单五码之外的第六码，对应合约 `NothingToRefund`） |

通过后走与 `nft/prepare` 相同的 `sealIntent`：kind `nft_refund`、**目标合约 = 实例的 `contracts.escrow`**（`launch2Intent.contractAddress` 与 `calldata.to` 都是 escrow，`claimRefund(tokenId)` 在 NftEscrow 上）、无 approve（`approval: null`）、`expectedOut` = 退款额、eth_call 试算 + 估 gas、canary 资产 / 单笔上限 / 日上限照旧（valueUsd = 退款额，同 0131 claim）、0117 对手方（escrow 属实例 11 个模块之一）。回包 `{launch2Intent, refund: {tokenId, escrow, amountUsd1, opensAt}, contractVersion}`。

`POST …/nft/refund/report`，体 `{intentId, transactionHash, walletId?, tokenId?}`（后两者为可选回显，不符 → 404）。同 0131 claim report：只记一次（同 hash 幂等、另一个 hash 409 `RESOURCE_CONFLICT` / `LAUNCH2_REFUND_TRANSACTION_CONFLICT`、不是调用者的 `nft_refund` intent 404 `LAUNCH2_REFUND_INTENT_NOT_FOUND`）。回包 `{nftRefundReport: {intentId, instanceId, walletId, tokenId, transactionHash, status: submitted | confirmed, amountUsd1, refundedAt, blockNumber, reportedAt}, contractVersion}`；`confirmed` = lane 已索引该交易对 (token, wallet) 的 `RefundClaimed`。report 不受 hold 拒绝（已发出的交易要能对账）。

## 5. 超时开盘兜底（`launch2_snapshot_publisher` lane）

每 tick 对无活动行、未开盘的候选先跑原有 `start()`；它返回等待原因（被封、重试用尽、签名被拒、索引不全等；`ALREADY_ON_CHAIN` / `SALE_OPEN` / `SALE_END_MISMATCH` 除外）时再试兜底：

1. 工厂支持出口路径（探测缓存）、registry `snapshotTimeoutAt()` 可读（缓存），head 时间 ≥ 它；否则保留原原因、什么都不做。
2. `ProjectNFT.totalMinted()`（head）> 0（零铸造归 0122 的零持有人开盘）；`rootPublishedAt() ≠ 0` → `LAUNCH2_SNAPSHOT_ALREADY_ON_CHAIN`。
3. `LAUNCH2_TIMEOUT_OPEN_ENABLED` 关 → 原因 `LAUNCH2_TIMEOUT_OPEN_SKIPPED`（只记日志）；本动作此前已非可重试失败 / mismatch、可重试失败达 `maxAttempts`、或在重试间隔内 → 同样 `_SKIPPED`。
4. 先插 `open_after_timeout` 行，再在同一 `advancePending` 里试算 + 估 gas（`openPublicAfterTimeout()`），在共享 nonce 锁下用本 lane 既有发送账户（submitter，默认 executor 账户）签 legacy 交易、记 hash / nonce / raw，再发送 → 原因 `LAUNCH2_TIMEOUT_OPEN_SENT`；之后 broadcast → confirmed（`confirmations` 深、规范链），lane 索引到事件即完成。
5. 「别人先开了」沿用 0122：回执 revert 且 `rootPublishedAt ≠ 0` → `failed` / `LAUNCH2_SNAPSHOT_OPENED_BY_OTHER`（不可重试）；试算 revert → `failed` / `LAUNCH2_SNAPSHOT_CONTRACT_REVERTED`（只有 `SnapshotNotReady` 可重试）。
6. 候选 SQL 新增 `factoryAddress`、`openedAfterTimeout` 与 `open_after_timeout` 行自己的预算（`timeoutOpen.{retryableFailures, blocked, lastFailedAt}`，按 0120 release 之后计）；已超时开盘的实例不再是候选。

reasonCode 走现有 `onWaiting` 日志（每实例变化时一条）；开关与原因码都不出现在 HTTP。

## 6. `hooksLaunchFixedEconomics` / configHash：**本批不加**

0011 §6.4 建议把 `snapshotTimeoutSeconds` / `refundDelaySeconds` 并入 fixedEconomics。本批决定**不加**，理由：

1. 合约未合并、待需求方拍板，主网 / 测试网都没有 S175 工厂；现在改 hash 只会让本地与未来工厂对不上一次又一次。
2. 正确做法需要贯穿 fixedEconomics 的全部 5 个计算 / 核验点（owner 保存、reviewer 复核、signing-request、submission、executor 复算 configHash），并与 0011 §6.5 的执行器核验（`snapshots.snapshotTimeout()` / `escrow.refundDelay()` 等于工厂值、主网断言 604800 / 2592000、四个 deployer code hash 替换）同批落地；只加哈希不加核验是半成品。
3. 链上安全不依赖它：EIP-712 域绑定工厂地址，两值是该工厂 immutable，同一签名不能挪到另一组参数的工厂上用（0011 §3，与 0004 对 `nftSaleDuration` 的论证同）。
4. 保证「不支持的工厂 JSON / configHash 不变」最直接的方式就是不动。

建议在「切到 S175 工厂」那一批（同时做执行器核验）加入，形式按任务单：只在工厂支持时从链上读入两值、追加两键；不支持的工厂 fixedEconomics 逐字节不变。

## 7. 现网工厂（不支持）下与 ebf2b36 的差异

- 详情多两个恒为 `null` 的键 `exitPaths`、`viewerNftRefunds`（同 0136 的 `tradingHold`）；`/v2/launch2/*` 多两条路由（恒 503 `LAUNCH2_EXIT_PATHS_UNSUPPORTED`，或其之前的既有拒绝）。
- API 与 lane 各对每个工厂多一次 `snapshotTimeout()` eth_call（revert 后缓存，之后零额外读）；publisher 只在原路径已卡住时探测一次。lane 的 getLogs 地址表、事件处理、阶段推导、publisher 的行为、configHash 全部不变。
- 既有测试的改动只有机械项：OpenAPI 路径表 / operationId 计数（+2）、`latestMigrationName`（9 个测试文件）、schema 关系表（+2 张）、12 个集成套件的 TRUNCATE 列表（+2 张表）。行为测试零改动。

## 8. 未做 / 待决

1. S175 合并 / 部署后：ABI 并入生成模块；执行器核验（0011 §6.5）；fixedEconomics 两键（§6）；测试网 manifest（建议 `LOOP_SNAPSHOT_TIMEOUT_SECONDS=3600`、`LOOP_REFUND_DELAY_SECONDS=3600`）。
2. `snapshot.status` 没有为超时开盘加枚举值（避免 App 严格解码失败）；若 App 需要，下一版加 `opened_after_timeout` 并同步 App。
3. 退款后的 NFT 仍可转让（合约不锁）；App 应在 NFT 展示 / 交易处显示 `refunded`（`viewerNftRefunds[].refunded`）。
4. `GET /v2/launch2/me/positions` 行上不加 `viewerNftRefunds`：每行要多一次按实例的链上 `refundQuote` 批读（positions 跨所有实例），与该路由「纯读模型、一页一查」的形态不符；App 可在实例详情读。若要加，建议只给 index 侧的 `refunded` 标记（不含 amount）。
5. 管理后台只在 publication 行上多了 `action = open_after_timeout`，没有退款视图。
6. 已运行实例在本代码上线前若已有 S175 退款（不可能：无 S175 工厂），lane 不会补扫；上线后新注册的实例从部署块起扫，覆盖完整。

## 9. 测试

- 单测：`test/launch2-escrow-exit.test.ts`（两种状态推导的全部分支、tokenId 解析、超时开盘 → public、能力探测支持 / revert / 空数据 / RPC 失败不缓存 / 无读取器、用 S175 forge ABI 编码的真实日志样本解码 `PublicRoundOpenedAfterTimeout` 与 `RefundClaimed`（错角色 topic 记 ignored）、lane 只对支持工厂加 escrow 角色、探测失败 tick 失败）；`test/v2-launch2-escrow-exit.test.ts`（不支持三态 null + 503、waiting / available / opened_by_timeout / closed_graduated / not_applicable、viewer 列表与链上 owner 过滤、报价失败 null、prepare 成功形状（escrow、无 approve、calldata 解码）、六种拒绝 + 400、hold 拒绝、report submitted → confirmed / conflict / 404）；`test/launch2-timeout-open.test.ts`（不支持工厂 / 旧读取器不动作、超时前与零铸造保留原原因、开关关 `_SKIPPED`、开关开 `_SENT` → confirmed → 索引后不重发、别人先开 `ALREADY_ON_CHAIN` / `OPENED_BY_OTHER` 后 `_SKIPPED`、env 解析）。
- 集成：`test/launch2-escrow-exit.integration.test.ts`（投影、refund 事实、持有 token、唯一约束、rewind 撤销、互斥约束、`nft_refund` intent + report append-only、`open_after_timeout` 行与候选预算、形状约束）；`test/launch2-snapshot-publisher-anvil.integration.test.ts` 新增一条 anvil 端到端：用 S175 字节码（`LOOP_PROTOCOL_DIR=…/S175-contracts/protocol`，默认 7 d / 7 d / 30 d，`evm_setNextBlockTimestamp` 推时间）走「未登记签名人 → 正常发布被拒 → 超时开盘（publisher 发送）→ lane 索引 public → 未开窗 prepare 拒绝 → 开窗 prepare / 签名发送 / 持有人到账 100 USD1 → report submitted → lane → confirmed → 链上 `refundedCount` / `refunded` 与读模型一致 → 再 prepare `ALREADY_CLAIMED`」；对 main 的 loop-contracts（工厂无 `snapshotTimeout()`）该用例自动跳过，其余用例两种字节码下都通过。
