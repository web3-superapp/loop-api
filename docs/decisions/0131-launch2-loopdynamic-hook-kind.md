# 0131 · launch2 外盘 Hook 种类 `loopDynamic` 后端骨架（S166-api，2026-10-13）

依据：LOOP `docs/26-需求方loop_hook_v1评审-2026-10-13.md` §五（后端改动清单）；loop-contracts 决策 0009（S164 可插拔 Hook 种类，S165 §13 定稿：买卖各 2 % + 动态卖出税、`POST_SWAP`、`Open` 三档路由、回购不计权且免买入税）；主代理 S166 任务单与 S165 合并后的补充。
范围：只在 `loop-api`。**全部默认关闭**：没有 LoopDynamic 工厂 / LoopRouter 配置时，OfficialTax 路径、已部署实例、staging 行为不变（§9 锁定）。未广播任何链，未碰 ops 栈与 dev 库。

## 1. 结论

| 项                  | 做法                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hook 种类是实例事实 | LoopDynamic 工厂在 `deployLaunch` 时不部署 Hook（`LaunchDeployed.hook = 0`），注册行 `hook_address = 0` ⇒ `loopDynamic`。`launch2_instances.pool_hook_kind` 是生成列（`hook_address` 为零地址时 `loopDynamic`，否则 `officialTax`），不新增写路径 |
| 新发射的种类        | `HOOKS_LAUNCH_HOOK_KIND=officialTax                                                                                                                                                                                                               | loopDynamic`（API 与 worker，默认 `officialTax`）。`loopDynamic` 时：Hooks 资料保存 / 审核 / 签名准备 503（没有工厂读取器，`HOOKS_LAUNCH_FACTORY_UNAVAILABLE`）；部署执行器开着则拒绝启动（执行器只会校验 OfficialTax 模块）。configHash 的 LoopDynamic 算法已实现并测试（§6），接线等执行器支持 LoopDynamic 后再做 |
| 索引                | worker 用 `LAUNCH2_DYNAMIC_FACTORY_ADDRESS/_CODE_HASH` 把 LoopDynamic 工厂加入 `launch2_event` lane 的工厂列表（模块代际 v3）。lane 对 `hook = 0` 的实例读其毕业适配器的 `LoopHookBound(hook, poolId)`，得到 Hook 后读 Hook 的全部事件            |
| 读接口              | 新路由 `GET …/dynamic-pool`（任何实例都回答 `hookKind`）、`GET …/dynamic-pool/rewards`                                                                                                                                                            |
| 交易                | `…/pool/quote`、`…/pool/trade/prepare` 按实例种类分流：LoopDynamic 经 `LoopRouter.swapExactInput`，只支持 exactIn                                                                                                                                 |
| 领取                | `POST …/dynamic-pool/claim/prepare`（`claim(roundId)` 意图，kind `dynamic_claim`）、`POST …/dynamic-pool/claim/report`                                                                                                                            |
| keeper              | 回购执行器不变（执行器绑定的适配器即 `LoopDynamicBuybackAdapter`）；keeper 能解码 LoopDynamic 适配器 / LoopRouter / Hook 的错误。新增默认关闭的 `launch2_dynamic_poke` lane                                                                       |
| ABI                 | `pnpm hooks:abi-sync` 到 loop-contracts `f711d58`（S165 合并后的 main）；新增 7 个合约的 ABI 选择                                                                                                                                                 |

## 2. 能力位放在哪里（判断与依据）

- 不新增 `GET /v2/meta/capabilities` 的能力位 id：App 的能力解码是严格的 34 位集合，未知 id 判整份无效。
- `GET /v2/meta/client-policy`：App 用 `LoopV2Contract.strictMap` 解析根与各子对象（`loop_v2_meta_repository.dart`），新增键 = 无效载荷。
- 实例详情 `GET /v2/launch2/instances/{id}`：`loop_v2_launch2_codec.dart` 的 `detail()` 用 `strictMapWithOptional(detailKeys, {'pool'})`，顶层只容忍 `pool`；`pool` 自身也是 `strictMapWithOptional`（`loop_v2_launch2_pool_codec.dart`）。所以 `dynamicPool` 不能放在详情顶层，`pool.hookKind` 也不能加。
- **结论：独立新路由 `GET /v2/launch2/instances/{id}/dynamic-pool`**。旧包不调用它；新包对每个实例调用一次，`hookKind` 决定面板：`officialTax` → `status = not_applicable`（其余字段全 `null`）→ 走原 OfficialTax 面板；`loopDynamic` → `not_graduated` / `active`。详情与 `pool` 的字节对 OfficialTax 实例不变。
- 外盘报价对 LoopDynamic 实例新增可选对象 `quote.dynamic`（OfficialTax 报价不带此键，旧包不受影响；旧包遇到 LoopDynamic 报价会判无效，正好 fail closed——旧包本来也不能在该池按数量交易）。`quote.taxBps` 的 schema 从常量 200 放宽为 0..10000（App 用通用 bps 解析，测试网参数可覆盖）。

## 3. 实体与稳定 ID

| 实体                                          | 键                                                               | 说明                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hook 绑定事实 `launch2_dynamic_hook_bindings` | `(chain_id, transaction_hash, log_index)`                        | `LoopHookBound(hook, poolId)`，只认实例自己毕业适配器发出的日志                                                                                                                                                                                                                                                        |
| 费用事实 `launch2_dynamic_fees`               | 同上                                                             | `side=sell`：`SellFeeCharged(round, grossQuote, baseFee, extraFee, dropWad)`，USD1；`side=buy`：`BuyFeeCharged(buyer, grossMeme, fee)`，MEME（S165）；**0152 修订**：S209 Hook 发 `BuyFeeCharged(round, buyer, grossQuote, fee)`，`fee_token = usd1`、`round_id = round`、`gross_amount = grossQuote`，旧实例照旧 MEME |
| K 线事实 `launch2_dynamic_candles`            | 同上                                                             | 只存 `CandleClosed`；`EmptyCandlesSkipped` 只进原始 `launch2_events`                                                                                                                                                                                                                                                   |
| 领取事实 `launch2_dynamic_claims`             | 同上                                                             | `RewardClaimed(round, buyer, amount)`                                                                                                                                                                                                                                                                                  |
| 轮次投影 `launch2_dynamic_rounds`             | `(instance_id, round_id)`                                        | 起止 K 线、结转、动态费、总权重、分配、下一轮结转、已领、买家数、是否结束；按实例从未删除事实重建                                                                                                                                                                                                                      |
| 权重投影 `launch2_dynamic_buy_weights`        | `(instance_id, round_id, buyer_address)`                         | `BuyCredited` 累加；`BuyNotCredited` 不计                                                                                                                                                                                                                                                                              |
| 领取意图                                      | `launch2_intents.intent_id`（opaque UUID），kind `dynamic_claim` | 沿用 launch2 意图密封 / 摘要 / 金丝雀                                                                                                                                                                                                                                                                                  |
| 领取回报 `launch2_dynamic_claim_reports`      | `intent_id`                                                      | 只追加；同哈希重报幂等，换哈希 409                                                                                                                                                                                                                                                                                     |

钱包地址只作事实里的链上参与方，不作主键；对外的轮次键是链上 `roundId`（十进制字符串），回报按 `intentId`。

## 4. 状态机

- 实例：`hookKind=officialTax` → `dynamic-pool.status = not_applicable`；`loopDynamic` 毕业前 `not_graduated`；毕业且 lane 已索引 `LoopHookBound` → `active`；毕业但未索引 → 503 `LAUNCH2_DYNAMIC_HOOK_NOT_INDEXED`。
- 轮次（投影）：`RoundActivated` → open（`closed=false`）→ `RoundClosed` → closed（`allocation`、`nextCarry`）。重组回滚：事实标 `removed`，投影删除重建，轮次可回到 open、Hook 绑定可回到空。
- 钱包轮次（rewards）：`open` → `claimable`（closed 且 `allocation × weight / totalBuyWeight > 0`，未领）→ `claimed`（已索引 `RewardClaimed`）；或 `no_reward`。
- 领取回报：`submitted`（未索引到该交易的 `RewardClaimed`）→ `confirmed`。回报不动账，索引日志是唯一真相。

## 5. 报价算法（LoopDynamic）

- exactIn only；`mode=exactOut` 在任何链读之前 422 `LAUNCH2_EXACT_OUT_UNSUPPORTED`。
- 一个区块内：读 Hook（`trustedRouter` 必须是配置的 LoopRouter、`manager` = LoopRouter 的 PoolManager、`poolId` = 索引的绑定 = `Graduated.officialPoolId`、`meme` = 实例 MEME；可选 `routerRegistry` = `LAUNCH2_DYNAMIC_ROUTER_REGISTRY_ADDRESS`），否则 503 `LAUNCH2_DYNAMIC_HOOK_MISMATCH`。（**0153 修订**：期望的 router / registry 改为实例所属工厂的 `loopRouter()` / `routerRegistry()`，工厂须在信任名单内（否则 `LAUNCH2_DYNAMIC_FACTORY_UNKNOWN`），Hook 须是该工厂 `loopHook(launchId)`；配置的 LoopRouter / registry 只用于断言当前工厂（不符 `LAUNCH2_DYNAMIC_ROUTER_MISMATCH`）。）
- `eth_call` 模拟 `LoopRouter.swapExactInput(key, zeroForOne, amountIn, 0, MIN/MAX_SQRT_PRICE±1, deadline)`，从钱包发起，输入币余额与对 LoopRouter 的授权只在调用内覆盖（Decision 0124 的 ERC-20 槽位探测，按 spender 参数化后复用）。返回 `(amountSpent, amountReceived)`。
- 买：`taxBps = buyFeePpm / 100`（200），`taxToken = meme`，税 = 由净额反推的 2 %（两个毛额对应同一净额时取较大者，最多差 1 wei）；`rewardWeight` = 本笔 USD1（当这笔交易执行 `_rollCandle` 之后轮次处于激活态，用 `PriceMath` 的 TS 精确移植判断；钱包等于 `rewardExcludedBuyer` 时为 0）。
- 卖：再做一次「中性」模拟——同一调用另外覆盖 Hook 槽位 0（`initialized=1, armed=0`）与槽位 1（`candleId = 2^256−1`，不滚 K 线），只收基础税。池子成交量与 Hook 收费无关（费是 afterSwap 的 delta），所以 `动态税 = 中性净额 − 实际净额` 精确；`dynamicTaxBps = 动态税 × 10000 / 中性净额`（POST_SWAP 时即成交后跌幅）；`taxAmount` = 基础 + 动态。存储布局按 `forge inspect`（f711d58）核对，写在 `launch2DynamicNeutralHookSlots`。
- 交易准备：同上重新模拟，calldata = `swapExactInput(..., minOut, ..., deadline = prepare 时刻 + 180 s)`，授权对象 = LoopRouter，kind 仍是 `pool_buy` / `pool_sell`，对手方信任 = 实例合约 + 经代码哈希校验的 LoopRouter。（**0153 修订**：LoopRouter = 实例所属工厂的 `loopRouter()`，旧工厂实例经其旧路由交易。）

## 6. configHash（S165：`buyFeePpm` 进 `TEMPLATE_HASH`）

- `hooksLaunchLoopDynamicTemplateHash(params)` = `keccak256(abi.encode(keccak256("hooks_launch_v1"), uint8(1), router, uint24 baseSellFeePpm, baseFeeRecipient, uint8 priceTiming, uint8 routingPolicy, routerRegistryAdmin, excludeBuybackFromRewards, uint24 buyFeePpm))`，与 `LoopDynamicLaunchFactory.loopDynamicTemplateHash` 一致（测试向量用 `cast abi-encode` + `cast keccak` 算出）。
- `parseHooksLaunchDraft(..., { loopDynamic })`：模板哈希换成上式；`fixedEconomics` 在 OfficialTax 对象上覆盖 `officialPoolBuyTaxBps / officialPoolSellTaxBps`（ppm / 100），追加 `officialPoolHookKind: "loopDynamic"` 与 `loopDynamic` 参数对象。不传 `loopDynamic` 时字节不变（已有 configHash 测试全过）。
- 尚未接线：参数来源（读 LoopDynamic 工厂 / Hook 部署工厂）随执行器支持一起做；在那之前 `HOOKS_LAUNCH_HOOK_KIND=loopDynamic` 让保存 fail closed（§1）。

## 7. 错误码（`detailsSafe.reasonCode`，中文文案在 `launch2DynamicReasonMessagesZh`）

| HTTP / code                  | reasonCode                                                                                                                                                                                                                      | 来源             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 503 `CAPABILITY_UNAVAILABLE` | `LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED` / `_ROUTER_CODE_MISMATCH` / `_HOOK_NOT_INDEXED` / `_HOOK_MISMATCH` / `_HOOK_NOT_INITIALIZED`（含 `NotInitialized`、`UnsupportedPool`）                                                  | 配置 / 校验      |
| 422 `VALIDATION_FAILED`      | `LAUNCH2_EXACT_OUT_UNSUPPORTED`、`LAUNCH2_DYNAMIC_POOL_NOT_APPLICABLE`、`LAUNCH2_DYNAMIC_ROUND_INVALID`、`LAUNCH2_DYNAMIC_ROUTER_UNAUTHORIZED`（`UnauthorizedRouter`）、`LAUNCH2_DYNAMIC_SWAP_UNSUPPORTED`（`UnsupportedSwap`） | 请求 / 合约      |
| 409 `DATA_STALE`             | `LAUNCH2_DYNAMIC_HOOK_BUSY`（`Busy`）、`LAUNCH2_DYNAMIC_ROUND_NOT_CLOSED`（`RoundNotClosed`）、`LAUNCH2_PRICE_MOVED`（`Slippage`）                                                                                              | 合约             |
| 409 `RESOURCE_CONFLICT`      | `LAUNCH2_DYNAMIC_ALREADY_CLAIMED`（`AlreadyClaimed`）、`LAUNCH2_DYNAMIC_CLAIM_TRANSACTION_CONFLICT`                                                                                                                             | 合约 / 回报      |
| 409 `INSUFFICIENT_BALANCE`   | `LAUNCH2_DYNAMIC_NOTHING_TO_CLAIM`                                                                                                                                                                                              | 领取模拟金额为 0 |
| 404 `NOT_FOUND`              | `LAUNCH2_DYNAMIC_CLAIM_INTENT_NOT_FOUND`                                                                                                                                                                                        | 回报             |
| keeper                       | `LAUNCH2_BUYBACK_HOOK_BUSY`、`LAUNCH2_BUYBACK_ROUTER_UNAUTHORIZED`；`NotGraduated` → `LAUNCH2_BUYBACK_NOT_GRADUATED`                                                                                                            | 回购模拟         |

## 8. 索引细节

- 角色：`dynamicGraduationAdapter`（实例的毕业适配器，只认 `LoopHookBound`）、`dynamicHook`（已索引的 Hook，事件 `SellFeeCharged`、`BuyFeeCharged`、`CandleClosed`、`EmptyCandlesSkipped`、`RoundActivated`、`RoundClosed`、`BuyCredited`、`BuyNotCredited`、`RewardClaimed`）。
- 同一段内绑定的 Hook：第一遍读到 `LoopHookBound` 后，第二遍对同一区间读该 Hook 的日志与它的池子 `Swap`（与 0124 的「同段毕业」二次读取合并）。
- 池子 `Swap`：PoolManager / currency0 从 Hook 的 `manager()` / `min(meme, quote)` 读；每笔 swap 的税 = 同交易里该 Hook 在它之后最近的 `BuyFeeCharged.fee` 或 `SellFeeCharged.baseFee + extraFee`（`pairLaunch2DynamicFees`），没有配对（免税的回购）为 0。`launch2_pool_swaps` 的 `tax_amount` 因此是真实值，`instance.pool` 的统计口径正确。（**0152 修订**：S209 Hook 的买入税是 USD1——`tax_token = usd1`、`usd1_amount` = 池子输入 + 税 = 实付）
- 已知限制：LoopRouter 不发事件，LoopDynamic 池子的成交不归属钱包（`…/pool/trades` 对这些实例为空）；奖励权重以 `BuyCredited` 为准。
- 重组：`launch2_dynamic_hook_bindings / _fees / _candles / _claims` 加入回滚表列表；`reprojectDynamic` 对每个受影响的 LoopDynamic 实例删除并重建绑定列、轮次、权重（OfficialTax 实例直接返回）。

## 9. 默认关闭与锁定

- 新环境变量全部默认空 / `officialTax` / `false`；`LAUNCH2_DYNAMIC_*` 地址 + 代码哈希成对、只允许 `LAUNCH_CHAIN_ID=97`；poke 开着时必须有 32 字节私钥。
- OfficialTax 实例：详情、`pool`、报价、交易准备、成交统计字节不变（原 0124 / 0126 路由测试未改仍全过）；`…/dynamic-pool` 对它们回答 `not_applicable`。
- `launch2_dynamic_claim_reports` 与 `launch2_intents` 一样只追加（触发器）。

## 10. ABI 同步

- `scripts/hooks-launch-abi-selection.ts` 新增 `LoopDynamicHook`、`LoopRouter`、`LoopDynamicGraduationAdapter`、`LoopDynamicBuybackAdapter`、`LoopHookDeploymentFactory`、`LoopDynamicLaunchFactory`、`LoopRouterRegistry`；从 loop-contracts `f711d587`（git archive 到 scratch 后 `forge build`）同步，`--source-commit` 参数记录来源。
- 顺带：基线 efd48df 提交的 `officialTaxHookAbi` 缺 `ProtocolFeeTooHigh` 错误项（S162 的 sync 没吃到新构建），本次同步补上；`test/hooks-launch-protocol-abi.test.ts` 改为只在构建包含全部所选合约时比对（主检出的 `protocol/out` 早于 S164 时跳过而不是 ENOENT）。
