# 0152 · 同步 loop-contracts 0015：内盘上限参数化 + 外盘买入税改收 USD1（S209-api，2026-10-16）

## 1. Status

已实现（分支 `feat/S209-api-cap-usd1-buy-fee`）。依据：loop-contracts 决策 0015（main `aad61e8`，§6 事件 / ABI 变化表与给 loop-api 的同步清单为准），`protocol/out` 已按该版本 `forge build`；本仓 0131 / 0144 / 0146 / 0147（本决策修订其中对应句，原文加「0152 修订」注）。迁移 **000090**（000089 属 S214）。未部署、未广播，未改 `ops/*.env`、未碰 `src/config.ts` 链 ID 段与 lane 启用逻辑。**不新增 env 键**：代际全部由链上事实（Hook 地址权限位、工厂 / 曲线 getter 是否存在）与 manifest 字段区分。

## 2. Context

0015 一次改了两件事并整套重部署 LoopDynamic 组件：

1. 内盘单地址累计买入上限从 `CurveEngine.MAX_CUMULATIVE_BUY`（常量 500 万枚）变为工厂部署参数 `maxCumulativeBuy`（工厂 + 曲线各一个 getter，`(0, 1e27]`），并进 LoopDynamic `TEMPLATE_HASH`；
2. LoopDynamic 外盘买入 2 % 基础税改为 `beforeSwap` 从 USD1 输入侧扣（`beforeSwapReturnDelta`，权限位 0x10C4 → 0x10CC），与卖出基础税同进 Hook 的 `baseFeesAccrued`；`BuyFeeCharged` 签名变化，MEME 输出不再扣税。

已部署的旧工厂（测试网 `0xd05E…8c4D` 及更早）实例不变，继续发旧事件、答旧 getter。loop-api 必须两代同时支持，旧实例的索引、校验、报价不能断。

## 3. Decision

### 3.1 代际区分表

| 面                            | 旧工厂（S209 之前）                                                                             | 新工厂（S209）                                                                                                                                                                             | 判定依据                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `BuyFeeCharged`               | `(address indexed buyer, uint256 grossMeme, uint256 fee)`，topic0 `0x123655f5…6dfc`，fee = MEME | `(uint256 indexed round, address indexed buyer, uint256 grossQuote, uint256 fee)`，topic0 `0xfae2433f…a13c`，fee = USD1，只在 fee > 0 时发                                                 | topic0 本身；解码后参数名（`grossMeme` / `grossQuote`）                                                        |
| `launch2_dynamic_fees` 买入行 | `fee_token = meme`、`round_id` null、`gross_amount = grossMeme`                                 | `fee_token = usd1`、`round_id = round`（未开轮 0）、`buyer_address` 可为零地址（第 3 档）、`gross_amount = grossQuote`                                                                     | 同上                                                                                                           |
| `launch2_pool_swaps` 买入     | `tax_token = meme`，`usd1_amount` = 池子输入 = 实付                                             | `tax_token = usd1`，`usd1_amount` = 池子输入 + 税 = 实付，`meme_amount` 全额                                                                                                               | lane 配对到的 fee 日志代际（`dynamicFeeToken: usd1`）                                                          |
| Hook 权限位                   | 0x10C4                                                                                          | 0x10CC                                                                                                                                                                                     | Hook 地址低 14 位；工厂侧 `LoopHookDeploymentFactory.REQUIRED_PERMISSION_MASK()` 与适配器 `HOOK_PERMISSIONS()` |
| 模板哈希                      | 0013 十一字段（S165 十字段）                                                                    | 末尾追加 `uint256 maxCumulativeBuy`（十二字段）                                                                                                                                            | 工厂 `maxCumulativeBuy()` 是否存在（revert / 空返回 = 旧代）                                                   |
| fixedEconomics / configHash   | 不变（`perAddressLifetimeBuyCapRaw` 500 万）                                                    | `perAddressLifetimeBuyCapRaw` = 工厂值（原位覆盖），`loopDynamic` 块加 `maxCumulativeBuy`、`buyFeeToken: "usd1"`                                                                           | 模板参数 `maxCumulativeBuy` 是否存在                                                                           |
| 曲线上限读取                  | `MAX_CUMULATIVE_BUY()`（`0xe358ee7c`，冻结 ABI）                                                | `maxCumulativeBuy()`（`0x4c4d8734`）                                                                                                                                                       | 先读新 getter，合约级 revert 才回退旧 getter；RPC 错误照常失败                                                 |
| 外盘买入报价                  | 税 = 毛输出 − 净输出（MEME），`taxToken = meme`                                                 | 税 = ⌊amountIn × buyFeePpm / 1e6⌋（USD1），池子输入 = amountIn − 税，MEME 不扣；`taxToken = usd1`、`taxUsd1 = 税`                                                                          | Hook 地址位（未知位 → 503 `LAUNCH2_DYNAMIC_HOOK_MISMATCH`）                                                    |
| 买入权重                      | 实付 USD1                                                                                       | 实付 USD1（含税，0015 §4.4）                                                                                                                                                               | —                                                                                                              |
| 读面字段                      | `dynamic.buyFeeToken = meme`；`totals.poolBaseBuyFeeMeme`                                       | `dynamic.buyFeeToken = usd1`；`totals.poolBaseBuyFeeUsd1`                                                                                                                                  | 同上                                                                                                           |
| manifest                      | 无新字段                                                                                        | 顶层 `maxCumulativeBuy`、`loopDynamic.maxCumulativeBuy`（十进制字符串，相等）、`loopDynamic.params.{buyFeeToken: "USD1", buyFeeAccrual: "baseFeesAccrued", hookPermissionFlags: "0x10cc"}` | 五个键全有 = S209，全无 = 旧代，部分 = 拒绝                                                                    |

### 3.2 同步清单落实

1. **事件解析**：ABI 由 `pnpm hooks:abi-sync` 从 `aad61e8` 重生成（选择表加 CurveEngine `maxCumulativeBuy` / `MAX_CUMULATIVE_BUY_LIMIT`、LoopDynamicLaunchFactory `maxCumulativeBuy`、LoopHookDeploymentFactory `REQUIRED_PERMISSION_MASK`，删 `MAX_CUMULATIVE_BUY`）；旧 `BuyFeeCharged` 与 `MAX_CUMULATIVE_BUY()` 冻结在 `src/integrations/launch/hooks-launch-protocol-abi-legacy-s200.ts`（与 0122 的 v2 冻结 ABI 同一做法）。`dynamicHook` 角色用「当前 ABI + 冻结旧事件」解码（`launch2DynamicHookDecodeAbi`）。`launch2-repository` 按参数名分两种行；`pairLaunch2DynamicFeeFacts` 返回 fee 与币种，`pairLaunch2DynamicSenders` 对 USD1 税：`amountIn` = 池子输入 + 税、`amountOut` = MEME 全额。
2. **读模型 / 校验**：执行器读曲线上限用 `maxCumulativeBuy()`、旧曲线回退；LoopDynamic 核验 `curve_caps` = 模板 `maxCumulativeBuy ?? 500 万` 且工厂 getter 与模板一致；`hook_permission_bits` / `adapter_params` 用 `hooksLaunchLoopDynamicHookPermissionBits(params)`（0x10CC / 0x10C4），并要求 Hook 工厂 `REQUIRED_PERMISSION_MASK` 同值。工厂读取器要求 `REQUIRED_PERMISSION_MASK` 与代际一致，否则 template mismatch。挖盐 / 提交按模板位（`permissionBits`）；`hooksLaunchHookPermissionBits.loopDynamic` 改为当前构建 0x10CC。OfficialTax：`TEMPLATE_HASH` 不含上限（0015 §5），其 configHash 绑定 500 万，所以 OfficialTax 实例仍要求曲线上限恰好 500 万（非默认上限的 OfficialTax 工厂 fail closed 在 `curve_caps`）。执行器 verified 时把曲线上限写进 `verification.curveMaxCumulativeBuy`；`launch2_instances` 读模型按 0119 `nftSaleEnd` 同一做法派生 `curvePurchaseCap`（缺键 = 500 万，S209 前的执行器只放过恰好 500 万的曲线）。`launch2-contract` 模板卡 `perAddressCap` / `perAddressCapBps` 与持仓 `remainingQuota` 用实例值，内盘报价 / 准备用报价块的链上值（`Launch2CurveState.maxCumulativeBuy`）。
3. **模板哈希 / configHash**：见 3.1；测试向量 = 0015 §5（S200 manifest 参数 + 默认上限 = `0x327aac84…0791`；同参数旧公式 = manifest 记录值 `0x7a0e33b7…5aed`）。
4. **报价**：见 3.1；`dynamic.baseTaxToken` 新增（必填）。`baseBuyFeeBps` / `buyTaxBps` 说明注明 S209 从 USD1 输入侧扣。
5. **公开页**：`totals.poolBaseBuyFeeUsd1`（新）、`poolBaseBuyFeeMeme` 只计 MEME 行，`totalTaxUsd1Equivalent` 两者都计；`instance.perAddressCurveCapMeme`（链上读、进程内按曲线缓存，链不可达用核验值）；`dynamic.buyFeeToken`。`/v2/.../dynamic-pool` 加 `buyFeeToken` 与 `summary.buyFeesUsd1`。`docs/api-inventory.md`、`openapi/loop-api.v2.json`、`openapi/loop-public.v1.json` 同步（v1 冻结产物未动）。
6. **manifest**：`src/features/launch/hooks-launch-manifest.ts` `parseHooksLaunchLoopDynamicManifest`：接受两代、校验新字段（十进制字符串、两处相等、`USD1` / `baseFeesAccrued` / `0x10cc`）、用对应公式复算并断言 `templateHash`。运行时不读 manifest（运行时读链上同一事实）。
7. **env**：不新增键。主代理部署新工厂后只需更新已有键（见 §4）。

### 3.3 迁移 000090

- `launch2_dynamic_fees_side_shape`：卖出行不变；买入行允许 MEME 形状（无 round）或 USD1 形状（有 round、buyer 非空），买入仍无 extra / drop。
- `launch2_pool_swaps_tax_side`：买入可为 USD1 税；卖出仍只能 USD1。
- `down` 恢复原约束（存在 USD1 买入行时失败，需先删，链上可重建）。

## 4. Consequences

- 旧工厂实例零行为变化：事件、表行、报价、核验（0x10C4、十一 / 十字段哈希、500 万）全部照旧；`fixedEconomics` JSON 与 configHash 字节不变。
- 新工厂部署后需更新的 env（键不变，值换）：`HOOKS_LAUNCH_FACTORY_ADDRESS` / `HOOKS_LAUNCH_FACTORY_CODE_HASH`（若当前目标是 LoopDynamic 工厂）、`LAUNCH2_DYNAMIC_FACTORY_ADDRESS` / `LAUNCH2_DYNAMIC_FACTORY_CODE_HASH`、`LAUNCH2_DYNAMIC_ROUTER_ADDRESS` / `LAUNCH2_DYNAMIC_ROUTER_CODE_HASH`（部署脚本每次新部署 LoopRouter）、`LAUNCH2_DYNAMIC_ROUTER_REGISTRY_ADDRESS`（若重部署）；旧工厂继续索引须保留在 `LAUNCH2_LEGACY_FACTORIES`。旧模板保存的草稿在新工厂上 `template_mismatch`，须重新保存再签。
- 旧 Hook 实例的读面 `buyFeeToken = meme`；App 显示买入税币种应以该字段为准（前端同步另批）。
- 0015 §12 风险照搬：USD1 冻结 Hook 时付税买入也会回滚（报价模拟会如实 revert）；带紧限价的第三方部分成交按申报额收税（读模型按事件实值记）。
- 内盘报价改用曲线链上上限，旧实例读到的是 500 万，与之前相同。

## 5. Tests

- `test/launch2-s209-generation.test.ts`（新）：两代 topic0 / selector 钉死；同一 Hook ABI 解码新旧 `BuyFeeCharged`；地址位判代际（含 0015 §7 挖盐向量 `0x9443…10cc`）；USD1 买入拆分公式（含 < 50 wei 无税）；fee 配对币种、发送者归属金额两代对比；模板哈希向量（S200 manifest 旧公式、0015 §5 新向量、上限不同则不同、非法上限 / 无封顶参数拒绝）；fixedEconomics 两代；LoopDynamic 核验两代（0x10CC 通过、0x10C4 位 / 掩码 / 适配器在 S209 模板下失败、上限不符失败）；manifest 解析（真实 S200 manifest = 旧代、S209 形状、缺 / 数字 / 不等上限与错误新字段拒绝、旧公式哈希拒绝）；曲线上限进报价与模板卡。
- `test/hooks-launch-loop-dynamic-signing.test.ts`：S209 工厂读取（上限、0x10CC、十二字段）、四种 mismatch、旧工厂掩码 0x10CC 拒绝、上限读传输失败透传；挖盐默认 0x10CC、旧模板 0x10C4。
- `test/v2-launch2-dynamic-routes.test.ts`：S209 Hook 买入报价（税 0.2 USD1、MEME 不扣、`baseTaxToken`、权重 = 实付）、`dynamic-pool.buyFeeToken`；未知位 Hook → 503。
- `test/public-meme-routes.test.ts`：`buyFeeToken`、`poolBaseBuyFeeUsd1` 计入总税、`perAddressCurveCapMeme` 链上读一次缓存、链失败回退核验值。
- `test/launch2-dynamic.integration.test.ts`：USD1 / MEME 两种买入行入库、汇总拆分、池子 swap `usd1_amount` = 实付且 `tax_token = usd1`、公开页 facts、000090 约束仍拒绝非法形状。
- ABI 一致性：`pnpm hooks:abi-sync --check` 对 `aad61e8` 的 `protocol/out` 通过；anvil 集成套件（真实 S209 合约）通过。
