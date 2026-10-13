# 0132 · LoopDynamic 部署执行器接线、成交钱包归属、MEME 转账覆盖按实例降级与余额抽查（S170-api，2026-10-14）

依据：主代理 S170 任务单（2026-10-13）与补充（S168b 对齐后：`…/dynamic-pool` 依赖类 503 带 `hookKind`）；Decision 0131（S166 骨架，本决策取代其 §1 / §6「尚未接线」与执行器拒绝启动）；Decision 0129 §2（审查遗留两条）；loop-contracts `main = 6f7ae0d`（`protocol/src` 与 `f711d58` 相同）——`LoopDynamicLaunchFactory`、`LaunchLoopDynamicDeployer`、`LoopLaunchFactoryCore`、`LoopDynamicDefaults`、`LoopHookDeploymentFactory`、`looplabs/LoopRouter`；BSC Testnet manifest `deployments/bsc-testnet/factory-20261013T134534Z.json`。
范围：只在 `loop-api`。未广播任何链、未用真实私钥、未碰 ops 栈 / dev 库 / staging。App 契约（§3.12 已定稿的响应形状与错误码）不变，唯一可见增量是依赖类 503 的 `detailsSafe.hookKind`（主代理补充要求）。

## 1. 部署执行器与签名链路接线（取代 0131 §1 / §6 的「未接线」）

| 环节       | `HOOKS_LAUNCH_HOOK_KIND=officialTax`（默认，字节不变）                        | `=loopDynamic`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 目标工厂   | `HOOKS_LAUNCH_FACTORY_ADDRESS/_CODE_HASH`                                     | `LAUNCH2_DYNAMIC_FACTORY_ADDRESS/_CODE_HASH`（API 与 worker 都读；缺一对 → 读取器为 null，保存 / 审核 / 签名准备 / 提交全部 503 `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`，绝不回落到 OfficialTax 工厂；执行器开着则拒绝启动）                                                                                                                                                                                                                                                                                                                                      |
| 模板参数   | 常量 `keccak256("hooks_launch_v1")`，不读链                                   | 链上读取并缓存（不可变）：`loopRouter()`；`loopHookDeploymentFactory()` 的 `baseSellFeePpm / baseFeeRecipient / priceTiming / routingPolicy / routerRegistry / excludeBuybackFromRewards / buyFeePpm / router / launchFactory`；`routerRegistry().admin()`（`LoopRouterOnly` 时为 0）。要求 `hookKind() = 1`、Hook 工厂 `router = loopRouter`、`launchFactory = 本工厂`、`routerRegistry` 一致，且 `hooksLaunchLoopDynamicTemplateHash(params) == TEMPLATE_HASH()`，否则「模板不符」                                                                         |
| configHash | 0119 公式不变（已有 byte-identical 测试全过）                                 | `parseHooksLaunchDraft(..., { loopDynamic: params })`：模板哈希 = LoopDynamic 公式（含 `buyFeePpm`），`fixedEconomics` 覆盖池税率并追加 `officialPoolHookKind / loopDynamic`，草稿带 `poolHookKind: "loopDynamic"`                                                                                                                                                                                                                                                                                                                                           |
| 存储       | 不变                                                                          | migration **000078**：`hooks_launch_config_object` 约束允许唯一可选键 `poolHookKind = 'loopDynamic'`（anvil 端到端测出原约束拒收）                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 响应       | 不变                                                                          | 形状不变：`config` 的 schema 是 `additionalProperties: false`，`poolHookKind` 与 `fixedEconomics.loopDynamic` 由序列化器剔除（App 严格解码不受影响）；`templateHash` / `configHash` 即 LoopDynamic 值                                                                                                                                                                                                                                                                                                                                                        |
| 签名准备   | Hook 盐 `0x20CC`，部署者 `hookDeploymentFactory()`，`previewHookInitCodeHash` | Hook 盐按 `0x10C4` 挖，**从 1 开始**（0 对 LoopDynamic 工厂意为「未登记」，Hook 会在毕业时链上另挖、地址不同），部署者 `loopHookDeploymentFactory()`，`previewLoopHookInitCodeHash(request)`；`typedData.message.templateHash` = 工厂 `TEMPLATE_HASH`；`hookAddress` = 毕业时才部署的 Hook 的预测地址                                                                                                                                                                                                                                                        |
| 模板一致性 | 配置若是 LoopDynamic 草稿 → 503 `HOOKS_FACTORY_TEMPLATE_MISMATCH`             | 配置必须 `poolHookKind = loopDynamic` 且 `templateHash` = 工厂模板，否则同上 503                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 提交       | 不变                                                                          | 摘要按工厂模板重算验签；Hook 地址须带 `0x10C4` 且盐 ≠ 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 执行器预检 | 链 97、工厂 codeHash = 配置值、执行器已授权（不变）                           | 另加：客户端与策略 Hook 种类一致、模板可读且复现（不符 → 空闲 `HOOKS_FACTORY_TEMPLATE_MISMATCH`，不领任务；RPC 失败照旧退避）。codeHash 用 `LAUNCH2_DYNAMIC_FACTORY_CODE_HASH`（= manifest `launchFactoryCodeHash`），每个 tick 校验                                                                                                                                                                                                                                                                                                                         |
| 发交易     | `deployLaunch` / `activateLaunch`                                             | 同一编码（两工厂共用 `LoopLaunchFactoryCore`，选择器 / 结构 / `LaunchDeployed` 主题一致，有单测比对生成 ABI）                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 回读校验   | 0112 的 28 项（不变）                                                         | `hooks-launch-loop-dynamic-verification.ts` 的 31 项：`LaunchDeployed.hook = 0` 且 `hookSalt` = 签名盐；`modules.officialHook / priceRecorder = 0`、池键 `hooks = 0`；Hook 工厂 `launchHook(launchId)` 已登记该盐、`initializer = 毕业适配器`、`buybackBuyer = 回购适配器`，`computeAddress(salt, hookInitCodeHash)` = 任务预测地址且低 14 位 `0x10C4`；Hook 工厂参数 = 模板；毕业适配器 `hookFactory / launchId / HOOK_PERMISSIONS / graduationSqrtPriceX96`；回购适配器走 LoopRouter 且已绑执行器；四个部署者代码哈希；其余模板经济项与 OfficialTax 同口径 |
| 激活后     | 不变                                                                          | `deployedAddresses.hook / priceRecorder` 为零地址 → 注册行 `pool_hook_kind = loopDynamic`（0131 生成列），索引器照 S166 读 `LoopHookBound` 绑定 Hook                                                                                                                                                                                                                                                                                                                                                                                                         |

部署任务按 `factory_address` 领取：切到 `loopDynamic` 后，执行器只推进 LoopDynamic 工厂的任务；切换前未完成的 OfficialTax 任务需切回或人工处理（需决策，见 §6）。

## 2. LoopDynamic 池成交的钱包归属（主代理裁决：按 `tx.from`）

- 实体不新增；`launch2_pool_swaps.attribution_source`（migration **000077**）：`router_swap`（0126，OfficialPoolRouter 事件，`router_log_index` 必有）/ `transaction_sender`（本决策，无路由日志，`router_log_index` 为空）/ null（匿名）。形状约束按来源分别要求；已有归属行回填 `router_swap`。
- 规则：LoopDynamic 池的 PoolManager `Swap` 归属 `tx.from` 当且仅当 ① `sender` = 该 Hook 的 `trustedRouter()`（共享 LoopRouter，索引器从 Hook 读，不需新配置）② 交易 `to` = 该 LoopRouter（钱包直接调用）③ 该交易内只有这一笔经该路由的 swap。`amountIn` = 池输入，`amountOut` = 池输出 − 同一 swap 的 Hook 费（`pairLaunch2DynamicFees`，即 LoopRouter 实付给调用者的数）≤ 0 则不归属。
- 不满足的（回购经执行器 / 适配器、外部路由、合约钱包、EntryPoint）只记匿名成交：池统计照计，不出现在任何钱包的 `…/pool/trades`。
- 只对候选交易调用 `eth_getTransaction`（transport 批量）；读取器不报告 `trustedRouter` 或缺 `readTransactionParties` 时一律不归属（fail closed）。
- 历史：S170 之前不可能产生 LoopDynamic 实例（保存 503），无需回填重扫。

## 3. MEME 转账覆盖：按实例降级与第二层余额抽查（0129 §2 审查遗留）

a. **按实例降级**：读取器不再因锚点缺失抛 `LAUNCH2_RPC_LOGS_UNTRUSTED`；它依次问各端点，取缺得最少的回答，返回仍缺锚点的 token（`untrustedTokens`）。整段照常提交；只有缺锚点的实例在同一事务里降级：`meme_transfers_complete_at = null`（结算视其毕业后余额为 pending，`MINING_ASSET_GRADUATED_BALANCE_PENDING`，不进该实例结算）、失败次数 + 1、目标块清空（下 tick 从部署块重扫）；第三次失败 `stalled`（保留目标、不再重扫、error 日志，运维按 0129 §2.3 重置）。

b. **第二层 `balanceOf` 抽查**（所有已跟踪、未 stalled、部署块 ≤ 段末的实例，每段都做，含空回答段）：

- 抽样：热合约优先（毕业前 curve，毕业后该实例池的 PoolManager），再取本段转账涉及金额最大的地址，最多 4 个；外加 `totalSupply()`。
- 账本：库中该实例 `block < fromBlock` 的未删除转账 + 本段转账；链上：段末块 `balanceOf` / `totalSupply`（依次问各端点）。读完再核段末块哈希未变，变了按 `LAUNCH2_BLOCK_MOVED` 整段重来。
- **双向**比较（补「单向缺失」）：账本 > 链 = 缺流出（非负规则看不到）`LEDGER_ABOVE_CHAIN`；账本 < 链 = 缺流入 `LEDGER_BELOW_CHAIN`；铸 − 销 ≠ 供应 `SUPPLY_MISMATCH`。
- 不一致：向每个端点单独重读该 MEME 本段 `Transfer`，与首个回答取并集重算；能对上就用并集提交。仍对不上 → 同 a 的降级（重扫 / 三振 stalled），日志 `LAUNCH2_MEME_COVERAGE_INCOMPLETE` + 缺口码。
- 无端点能给段末状态（裁剪节点）→ 该段「未核验」：只把 `complete_at` 置空（不计失败、不重扫），warn `LAUNCH2_MEME_BALANCE_UNVERIFIABLE`；完整性检查对它回 `pending`（不记录），下一次在可读块抽查通过即重新标记完成。
- 完成判定 = 部署块铸造存在 ∧ 无负余额 ∧ 本 tick 抽查 `verified`。
- 新缺口码：`DEPLOY_MINT_UNTRUSTED`、`LEDGER_ABOVE_CHAIN`、`LEDGER_BELOW_CHAIN`、`SUPPLY_MISMATCH`、`BALANCE_UNVERIFIABLE`（日志 / lane 事件，非 HTTP）。
- 代价与前提：每实例每段 ≤ 5 次 `eth_call`；追历史段需归档状态（NodeReal 付费端点可；纯裁剪端点会让追赶期覆盖暂时「未核验」，结算排除，追平后自愈）。残余风险：两笔互相抵消的缺失转账不改变段末余额，抽查不可见。

## 4. `GET …/dynamic-pool` 依赖类 503 带 `hookKind`（S168b 补充）

注册行读出后（纯库读）的任何 503（`LAUNCH2_CHAIN_READ_FAILED`、`LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED`、`_ROUTER_CODE_MISMATCH`、`_HOOK_NOT_INDEXED`、`_HOOK_MISMATCH`、`_HOOK_NOT_INITIALIZED`、仓储不可用等）在 `detailsSafe` 加 `hookKind`（`pool_hook_kind`）。实例本身读不到时（404 / 仓储 503）没有该键。其余字段、状态码、错误码不变。

领取意图：`launch2Intent.expectedOut` 与 `claim.claimableUsd1` 恒相等（同一 `claim(roundId)` 模拟值、同一格式化；幂等重放取同一已存意图）。链上实付以索引到的 `RewardClaimed` 为准（回报 `confirmed` 的 `amountUsd1`）。

## 5. 错误码与 unavailable 行为

- HTTP 无新错误码。新增执行器空闲原因 `HOOKS_FACTORY_TEMPLATE_MISMATCH`（lane 结果 / 日志）。
- 缺配置一律 fail closed：无 LoopDynamic 工厂对 → 保存 / 签名 503；工厂模板不可读或不符 → 503 / 执行器空闲；读取器无 `trustedRouter` 或交易读取 → 不归属；无余额读取 → 覆盖未核验、结算排除。

## 6. 需要主代理决策

1. 切换 `HOOKS_LAUNCH_HOOK_KIND` 时尚在途的另一种类部署任务：当前执行器只领目标工厂的任务（另一种类的任务原地等待）。是否需要「双工厂执行器」或切换前清空？
2. App 在 `hooks-deployments` 响应里会看到 LoopDynamic 实例 `addresses.deployed.hook = 0x0…0`（Hook 毕业时才部署；预测地址在 `addresses.predicted.hook`）。是否需在 App 文案上区分？
3. 余额抽查对端点的归档要求（§3 b）：dev / staging 的 `LAUNCH_BSC_RPC_URLS` 首位建议放支持历史状态的付费端点。
