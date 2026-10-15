# 0144 · LoopDynamic（方案 B）定稿规则接线：动态税封顶与收平关轮（S193-api，2026-10-15）

依据：主代理 S193-api 任务单与两条补充（2026-10-15）；loop-contracts Decision 0013（main `47d7620`，§7 接线清单为准）与测试网 manifest `factory-20261015T112941Z.json`；LOOP `docs/36-需求方10题答复-2026-10-15.md` 第 10 题与追问答复（需求方选 B；「这根不再跌就关」= 收平也关；动态税封顶 20%）；loop-contracts Decision 0012（`maxDynamicFeeWad`，S179 `51b2acf`）与 0009（LoopDynamic 种类、`TEMPLATE_HASH` 公式）；本仓 Decision 0131 / 0132 / 0133。
范围：只在 `loop-api`。**无迁移**（000085 未建）、无新 env、无新 reason code。HTTP 合同只**加**字段（OpenAPI v2 重新生成）。不改 `ops/`、不重启 launchd、不动 dev 库。合约侧已合入 loop-contracts main（`47d7620` 规则，`eb73dce` 部署记录）并已在测试网重部署：LoopDynamic 工厂 `0xA667…Ce1E`、LoopRouter `0x21eE…943a`（**新路由**）、Hook 工厂 `0x745c…6C61`、registry `0xBb59…Cc4a`，`maxDynamicFeeWad = 0.2e18`。ABI 从 main 构建（`eb73dce`）同步，与 S179 构建相比只差文件头的来源 commit。本批另含主代理补充第 2 条（§8，挖矿领取的配置原因字段）。

## 1. 结论

| 项             | 做法                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 费上限来源     | 链上只读：Hook 工厂 `LoopHookDeploymentFactory.maxDynamicFeeWad()`（模板 / 签名 / 执行器核验）与 Hook `LoopDynamicHook.maxDynamicFeeWad()`（读模型 / 报价）。缺省 0 = 不封顶                                                                |
| 模板哈希       | `LoopDynamicConfig` 末尾追加 `uint256 maxDynamicFeeWad`；**参数存在即编码**（封顶 0 也多一个零字）；S165 工厂（无此 getter）仍按十字段公式                                                                                                  |
| fixedEconomics | LoopDynamic 模板的 `loopDynamic` 块加 `maxDynamicFeeWad`（原始 18 位整数字符串，`"200000000000000000"` = 20%）；S165 模板 JSON 不变（已有 configHash 不变）；OfficialTax 不变                                                               |
| 卖出动态税     | `extra = floor((gross − base) × min(drop, cap) / 1e18)`，`cap = 0` 时 = `drop`                                                                                                                                                              |
| 实收税率反推   | `extraFee × 1e18 / (grossQuote − baseFee)`；`SellFeeCharged.dropWad` 是真实跌幅，**不是**实收税率                                                                                                                                           |
| 关轮规则       | S193 Hook：轮次中第一根**不再下跌**（`close ≥ open`，十字星也关）的 K 线关轮，**含一次结算中被跳过的第一根空 K 线**（0013 §2：激活后下一根就空 = 同一次结算先激活再关轮）；S193 之前的 Hook（legacy 工厂实例）：仍是只有收涨才关            |
| Hook 代际判定  | Hook 能回答 `maxDynamicFeeWad()` = S193 代（收平关）；该调用 revert / 无返回 = S165 代（收涨关、封顶 0）。RPC / 网络错误不当作旧代，照常失败（fail closed）                                                                                 |
| 缓存失效       | 盐与预测地址一直按链上实时 `previewLoopHookInitCodeHash` 现挖、提交时按实时 `hookDeployment` 重算，没有持久化缓存；模板按工厂地址缓存在进程内，换工厂 = 换 env + 重启。按旧模板保存的草稿在新工厂上 `template_mismatch`（必须重新保存再签） |

## 2. 模板哈希

```
TEMPLATE_HASH(S193) = keccak256(abi.encode(
  keccak256("hooks_launch_v1"), uint8(1), router, uint24 baseSellFeePpm, baseFeeRecipient,
  uint8 priceTiming, uint8 routingPolicy, routerRegistryAdmin, bool excludeBuybackFromRewards,
  uint24 buyFeePpm, uint256 maxDynamicFeeWad))
```

- `hooksLaunchLoopDynamicTemplateHash(params)`：`params.maxDynamicFeeWad === undefined` → S165 十字段（测试网 S165 manifest 值 `0x0e61af81…8819` 继续复现，作为回归向量）；有值 → 十一字段。值必须是 `< 1e18` 的十进制整数字符串，否则抛 `InvalidHooksLaunchDraftError`。
- 单测向量用 `cast abi-encode` + `cast keccak` 独立算出（同一组参数）：cap 0 → `0xa0dce14c…a2d1`，cap 0.2e18 → `0x79099800…102e`，与 S165 公式（`0x32ceb3c3…3fd9`）三者两两不同。
- `readHooksLaunchLoopDynamicTemplate`（签名 / 保存用的工厂读取器，执行器共用）：读 Hook 工厂 `maxDynamicFeeWad()`；revert = 不存在（S165）。读到的值 ≥ 1e18 → `HooksLaunchFactoryTemplateMismatchError`。按读到的参数重算的哈希必须等于链上 `TEMPLATE_HASH()`，否则 mismatch——所以「S193 工厂但封顶读失败被当成 S165」不可能静默通过：十字段哈希对不上新工厂的 `TEMPLATE_HASH`。
- 执行器读回（`hooks-launch-executor-chain`）的 `hookFactory` 新增 `maxDynamicFeeWad: string | null`；核验 `hook_factory_params` 增加「Hook 工厂的封顶 = 签名模板的封顶（都没有也算相等）」。
- **测试 fixture 不写死新哈希**：`s193LoopDynamicParams` = 新 manifest 的 `loopDynamic.params`（新路由、金库、registry admin、cap 0.2e18），模板哈希由 `hooksLaunchLoopDynamicTemplateHash(params)` 现算；单测断言现算值 = manifest 记录的 `templateHash` `0xe96acde5…6d67`（链上事实，作为对照向量，与 S165 的 `0x0e61af81…8819` 同等地位）。

## 3. 报价与读模型

- **报价**（`…/pool/quote` 与 `…/pool/trade/prepare` 的 LoopDynamic 分支）：卖出的动态部分仍是「真实模拟 − 只收基础税的中性模拟」，链上 Hook 已按 `min(drop, cap)` 收，所以报价自动封顶，没有在 TS 里重算（POST_SWAP 的成交后跌幅本来就只能靠模拟得到）。`dynamicTaxBps` 的 OpenAPI 描述写明 `min(drop, cap)`。中性模拟覆盖的存储槽（slot 0 / 1）不受影响：`maxDynamicFeeWad` 是 immutable，不占存储。
- **`GET /v2/launch2/instances/{id}/dynamic-pool`** 新增 4 个字段（`not_applicable` / `not_graduated` 时为 null）：
  - `maxDynamicFeeWad`（小数，`"0.2"`；`"0"` = 不封顶）、`maxDynamicFeeBps`；
  - `currentDynamicTaxBps` = `min(currentDropWad, cap)` 的 bps（PRE_SWAP 即下一笔卖出的税率；POST_SWAP 是不计该笔冲击前的值，精确值看报价）；
  - `roundCloseRule`：`closeAtOrAboveOpen`（S193）/ `closeAboveOpen`（旧 Hook）。
- 路由描述与 `rollPending` 描述同步改为「首根不再下跌关轮，收平也关」（旧 Hook 仍需收涨）。
- `armedAfterRoll`（0013 §7.3）：链上 `armed()` 在下一次结算前是旧值。这个字段 = 按 `launch2DynamicRoll` 推演待结算 K 线后的状态：`rollPending = false` 时等于 `armed`；S193 Hook 上 armed 且 `now/300 > candleId + 1`（中间有空 K 线）必定为 false；`now/300 = candleId + 1` 时按上一根是否收跌判断；未开启时上一根跌超 10% 为 true（若其后已有空 K 线则先激活再关轮，仍为 false）。App 的「轮次进行中」与动态税提示应改用它。不用 `currentDropWad() == 0` 推断（0013 §7.3）。
- 纯函数（`launch2-dynamic.ts`）：`launch2DynamicEffectiveRateWad`、`launch2DynamicSellExtraFee`、`launch2DynamicRealizedRateWad`、`launch2DynamicWadBps`、`launch2DynamicIsRed`、`launch2DynamicClosesRound(open, close, memeIs0, rule)`；`launch2DynamicRoll` 按 `state.roundCloseRule` 判断关轮（S193：先按 `_endsRound(open, last)`，再「armed 且有被跳过的 K 线 → 关」，与合约 `_rollCandle` 同序）（`claim` 前的「轮次是否已结束」与读模型的 `rollPending` 都走它）。
- 轮次投影（未改代码，集成测试锁定）：`launch2_dynamic_rounds.end_candle` 取 `RoundClosed.endCandle` 本身，不去匹配 `CandleClosed`，所以「关在没有 `CandleClosed` 的空 K 线」与「同一笔交易 `RoundActivated` → `EmptyCandlesSkipped` → `RoundClosed`（start = end、分配 0）」都按事件原样记。轮次会比原规则短（平静行情 5 分钟内关轮），轮次数 / 平均时长的统计口径变化需告知运营（主代理）。
- 索引：`launch2_dynamic_fees.drop_wad` 照旧存事件的真实跌幅（列语义本来就是 drop），表约束 `base_fee + extra_fee ≤ gross_amount` 在封顶下仍成立；目前没有对外接口按笔展示实收税率，以后展示必须用 `launch2DynamicRealizedRateWad`，不能用 `drop_wad`。

## 4. poke lane

逻辑不变（armed 且当根 K 线已结束、无交易才 poke）。注释改为：S193 Hook 上，结束的那根只要不跌（含没有成交的平 K）就关轮；旧 Hook 仍要收涨。因此 S193 之后「轮次中出现一根无成交的 K 线」会在下一次 poke 时关轮——这是裁决后的预期行为，不是 lane 的变化。

## 5. 换工厂与旧实例（任务第 3 条，确认，未改代码）

- `LAUNCH2_DYNAMIC_FACTORY_ADDRESS / _CODE_HASH`、`LAUNCH2_DYNAMIC_ROUTER_ADDRESS / _CODE_HASH`、`LAUNCH2_LEGACY_FACTORIES` 均已存在，**本批不加 env、不改解析**。
- 旧 S165 动态工厂改登记为 `LAUNCH2_LEGACY_FACTORIES` 的 `v3:<旧地址>`（代际按曲线 / 回购面，S165 与当前同为 v3）。`launch2FactoryEntries` 要求它与新 `LAUNCH2_DYNAMIC_FACTORY_ADDRESS` 不同，否则拒绝启动。legacy 工厂不接新发射（签名 / 执行器只认 `LAUNCH2_DYNAMIC_FACTORY_ADDRESS`），其实例继续被 `launch2_event` lane 索引（`LaunchDeployed` + `LoopHookBound`），奖励列表、活动流、round 投影照常。
- 旧实例的 Hook 没有 `maxDynamicFeeWad()`：读模型报 `maxDynamicFeeWad = "0"`、`roundCloseRule = closeAboveOpen`，`launch2DynamicRoll` 按旧规则判断——与链上一致。
- **LoopRouter**：S193 不改路由合约代码，但部署脚本每次新部署一个，本次重部署得到新路由 `0x21eE…943a`，`LAUNCH2_DYNAMIC_ROUTER_ADDRESS` 要换（code hash 与旧路由相同，0013 §4.2）。换后旧 S165 Hook 的 `trustedRouter` ≠ 配置路由，旧实例的 `dynamic-pool`、报价、交易准备、领取准备按现有规则 503 `LAUNCH2_DYNAMIC_HOOK_MISMATCH`（fail closed）；已索引的数据（奖励列表、轮次、活动流）照常可读。旧实例只是实验性测试网项目，接受这一点；若要继续操作旧实例，需另立批次支持「按实例的 trustedRouter 选路由」。

## 6. 部署顺序

1. **合约**：已完成（main `47d7620`，0013）。
2. **测试网重部署**：已完成（`factory-20261015T112941Z.json`）。本仓已核对 manifest `templateHash` 可由参数复现（单测）。仍待部署后核对：`VerifyLoopProtocol` 核对 `hookFactory.maxDynamicFeeWad() = 0.2e18`；manifest 记录新 `TEMPLATE_HASH`、工厂 code hash。部署后在本仓核对：`hooksLaunchLoopDynamicTemplateHash(manifest.loopDynamic.params ∪ {maxDynamicFeeWad})` = manifest `templateHash`（与 §2 读取器的启动核验同一公式）；`forge inspect LoopDynamicHook storageLayout` 的 slot 0（`initialized` / `armed`）与 slot 1（`candleId`）不变（中性模拟依赖）。
3. **填新 env**（ops，本批不改）：`LAUNCH2_DYNAMIC_FACTORY_ADDRESS = 0xA667e7B8d10D568fbcF89d2166081BD71A1CCe1E`、`_CODE_HASH = 0x6a4bb789…4487`（manifest `launchFactoryCodeHash`）；`LAUNCH2_DYNAMIC_ROUTER_ADDRESS = 0x21eEc27f759B6EFb1E6C9A26a555Ed40F08f943a`、`_CODE_HASH = 0x2eff9c98…970d`；旧动态工厂追加进 `LAUNCH2_LEGACY_FACTORIES`（`v3:<旧地址>`）。
4. **部署后端**（本 commit）：ABI 已含 `maxDynamicFeeWad`；启动后第一次读模板即按新公式核验，旧草稿需重新保存。在步骤 2 之前先部署后端也安全：S165 工厂读不到封顶即按十字段公式，行为与现在相同。
5. ABI：已从 main 构建同步（`eb73dce`），`pnpm hooks:abi-sync --check` 与 `test/hooks-launch-protocol-abi.test.ts` 的构建一致性检查在当前主检出通过。

## 7. 测试

- `test/launch2-dynamic.test.ts`：关轮规则（两种 `memeIsCurrency0` × 涨 / 平 / 跌 × 两种规则；armed 平 K 在 S193 下关轮、旧 Hook 不关；跌 K 两者都不关）；封顶报价表（drop 0.13 + cap 0.2 → 13%，drop 0.6 + cap 0.2 → 20%，drop 0.6 + cap 0 → 60%，drop = cap，drop 0）、`extra` 公式、由金额反推实收税率 = 实际费率、取整误差上界；模板哈希十一字段向量（cap 0 / 0.2e18）、cap 0 ≠ S165、非法 cap 拒绝；fixedEconomics 只在有 cap 时带键、configHash 绑定 cap。
- `test/hooks-launch-loop-dynamic-signing.test.ts`：S193 工厂读 cap 并核验十一字段 `TEMPLATE_HASH`（含 cap 0）；S193 cap + S165 哈希、cap 与哈希不符、cap ≥ 1e18 → mismatch；cap 读取的传输失败原样抛出（不当旧代）；S165 草稿在 S193 工厂上 `template_mismatch`，S193 草稿在 S165 工厂上同样拒绝。
- `test/hooks-launch-loop-dynamic-executor.test.ts`：读回核验 `hook_factory_params` 绑定 cap（相同通过；不同 / 0 / 缺失均失败；S165 模板 + 有 cap 的 Hook 工厂失败）。
- `test/v2-launch2-dynamic-routes.test.ts`：dynamic-pool 新字段；三组封顶在读模型与卖出报价（`dynamicTaxBps` 1300 / 2000 / 6000，金额 12.74 / 19.6 / 58.8）上一致；旧 Hook 报 `closeAboveOpen`。
- `test/hooks-launch-protocol-abi.test.ts`：与 Foundry 构建的一致性检查在「构建缺少所选条目」时跳过（与「缺 artifact」同理）；对当前 loop-contracts main 构建通过。
- `test/launch2-dynamic.test.ts` 另加：armed 红 K 后跳过空 K 线 → 关（旧规则不关）；跌超 10% 后下一根空 → 同次激活并关轮。
- `test/hooks-launch-loop-dynamic-executor.test.ts`：manifest 参数复现 manifest `templateHash`，cap 改 0 则不同。
- `test/launch2-dynamic.integration.test.ts`：关在无 `CandleClosed` 的空 K 线、同次激活即关轮两种事件序列的轮次投影。
- `test/v2-launch2-dynamic-routes.test.ts`：`armedAfterRoll`（待结算且隔了空 K 线：S193 false、旧 Hook true）。
- `test/hooks-launch-loop-dynamic-anvil.integration.test.ts`（真实合约，未改）：对 S165 构建与 S193 main 构建各跑一次，均通过（见回报）。
- 门禁结果见 S193-api 回报。

## 8. 补充：挖矿领取的配置原因（主代理补充第 2 条）

- 背景：App S191（Decision 0184）用领取原因码 `MINING_CLAIM_CONTRACT_NOT_CONFIGURED` 判断「LOOP 代币是否已开挖」，但 `miningClaimGate` 先报账本原因（`PARAMETERS_PENDING` / `NOTHING_SETTLED` / `NOTHING_TO_CLAIM` / `BELOW_MINIMUM` / `IN_FLIGHT`，以及运行时 `SETTLEMENT_UNAVAILABLE`）后报配置，账本原因命中时看不出合约配没配。
- 改法：`GET /v2/mining/rewards` 的 `hourly.claim` 新增必有字段 `configurationReasonCode` = `miningClaimUnavailableReason(deps)`（顺序不变：`SETTLEMENT_UNAVAILABLE`（未配置结算库）→ `CLAIM_MAINNET_CLOSED` → `CLAIM_CONTRACT_NOT_CONFIGURED` → `CLAIM_CHAIN_NOT_CONFIGURED` → `CLAIM_SIGNER_NOT_CONFIGURED` → `CLAIM_WRITES_DISABLED`），已配置时为 null。三个分支（未配置结算库、正常、运行时结算库不可用）都带。`reasonCode` / `executable` 语义不变；合约暂停 / 读失败仍只在 `reasonCode`。
- App 下一批改用 `configurationReasonCode`。OpenAPI v2 重新生成；`test/v2-mining-rewards-routes.test.ts` 新增：四种账本原因 × 合约配 / 不配，五种配置原因，全配置为 null，运行时结算库不可用时仍报配置原因；原有两条精确相等断言补上该字段。
