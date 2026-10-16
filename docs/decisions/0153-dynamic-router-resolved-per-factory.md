# 0153 · LoopDynamic 路由按实例所属工厂解析（S220-api，2026-10-16）

## 1. Status

已实现（分支 `fix/S220-legacy-router-per-factory`，基线 `a31a54f`）。修订 0131 §读模型 / 交易 与 0152 §4 对应句（原文加「0153 修订」注）。无迁移、无 SQL 变化；未部署、未广播，未改 `ops/*.env`。新增一个**可选** env 键 `LAUNCH2_DYNAMIC_LEGACY_ROUTER_CODE_HASHES`（默认空）；API 进程开始读取已有键 `LAUNCH2_LEGACY_FACTORIES`（worker 早已读取，同一校验）。

## 2. Context

- **S215 走查发现**：旧工厂（legacy）的 LoopDynamic 实例在读面上全部 503 `LAUNCH2_DYNAMIC_HOOK_MISMATCH`。例：实例 `2f0d01fa-76fe-4395-9ce8-60799e74453b`，工厂 `0xd05E…8c4D`（`loopRouter()` = `0x135C…A110`，`routerRegistry()` = `0x9BCd…4C15`）；dev 当前配置为新工厂 `0x5725…62cc`（路由 `0x7C79…0C3E`、registry `0x4De3…3fcf`）。受影响：`…/dynamic-pool`、`…/pool/quote`、`…/pool/trade/prepare`、`…/dynamic-pool/claim/prepare`、公开页 `/public/v1/meme/{id}`（503）与列表（`dynamic: null` + `dynamicReasonCode = LAUNCH2_DYNAMIC_HOOK_MISMATCH`）。
- **根因**：`dynamicHookAt` 把实例 Hook 的 `trustedRouter()` 与**唯一配置的** `LAUNCH2_DYNAMIC_ROUTER_ADDRESS`、`routerRegistry()` 与 `LAUNCH2_DYNAMIC_ROUTER_REGISTRY_ADDRESS` 比较。部署脚本每次重部署都新部署 LoopRouter / LoopRouterRegistry（0152 §4 已写明），所以每次换工厂，全部旧实例都会失配。报价 / 交易准备还把 swap 目标与授权 spender 写死为配置路由——即使放过校验，旧实例的交易也会打到新路由并在 Hook 的 `UnauthorizedRouter` 处失败。
- **S203 误判**：S203 时就观察到 dev 两个旧实例 HOOK_MISMATCH，当时判为「旧实例可接受的不可用」。实际这是产品缺陷：旧实例仍在交易、仍有奖励可领，读面与交易面不能因换工厂而整体下线。

## 3. Decision

1. **期望的 router / registry 按实例所属工厂解析**，不再用全局 env：
   - 工厂地址 = 实例注册表 `launch2_instances.factory_address`（lane 注册时写入）。
   - 工厂必须在信任名单内：当前 `LAUNCH2_DYNAMIC_FACTORY_ADDRESS`，或 `LAUNCH2_LEGACY_FACTORIES` 里非 `v2` 的条目（v2 早于 LoopDynamic）。否则 503 **`LAUNCH2_DYNAMIC_FACTORY_UNKNOWN`**（新原因码），且不对该工厂发任何链上读。
   - 从链上读该工厂的 immutable getter：`LoopDynamicLaunchFactory.loopRouter()`、`routerRegistry()`、`loopHookDeploymentFactory()`（`protocol/src/LoopDynamicLaunchFactory.sol` 第 52–57 行，全部代际都有；`hooks-launch-factory-reader.ts` 的模板读取用的也是这三个）。任一 getter revert / 无返回数据（如 OfficialTax v3 工厂 `0xc3ac…d1d2`）= 不是 LoopDynamic 工厂 → `LAUNCH2_DYNAMIC_FACTORY_UNKNOWN`。
   - 进程内按工厂缓存（不过期：全部 immutable）；并发请求共享在途读；读失败（RPC）不缓存，503 `LAUNCH2_CHAIN_READ_FAILED`，下次重读。
   - **当前工厂的一致性断言**：链上 `loopRouter()` 必须等于 `LAUNCH2_DYNAMIC_ROUTER_ADDRESS`；`LAUNCH2_DYNAMIC_ROUTER_REGISTRY_ADDRESS` 已配置时链上 `routerRegistry()` 必须等于它；否则 503 **`LAUNCH2_DYNAMIC_ROUTER_MISMATCH`**（新原因码，配置错要暴露，不绕过）。旧工厂的 registry 不与 env 比较。
2. **Hook 校验对齐所属工厂**：`trustedRouter()` = 该工厂 `loopRouter()`；`routerRegistry()` = 该工厂 `routerRegistry()`（以前只在 env 配置时比较，现在总比较）；`manager()` = 该路由的 `manager()`；`poolId` / `meme` 照旧。新增：该工厂 `loopHook(launchId)`（= 其 Hook 部署工厂 `hookOf(launchId)`）必须等于索引到的绑定 Hook，命中后按 `(factory, launchId, hook)` 缓存。原有的「Hook 由实例自己的毕业适配器 `LoopHookBound` 绑定」（索引器）与「地址权限位判代际」（0152）保留。任一不符仍 503 `LAUNCH2_DYNAMIC_HOOK_MISMATCH`。
3. **路由代码哈希对「该工厂的路由」做**：`verifyRouter(router)` 按路由地址分别缓存；接受的 runtime code hash = `LAUNCH2_DYNAMIC_ROUTER_CODE_HASH` ∪ `LAUNCH2_DYNAMIC_LEGACY_ROUTER_CODE_HASHES`（逗号分隔，可选）。不写死：LoopRouter 的 runtime code 嵌入其 PoolManager（immutable），PoolManager 不同则哈希不同（anvil 两次部署即如此）；BSC Testnet 所有代际共用一个 PoolManager，四个路由（`0x7d15…`、`0x21eE…`、`0x135C…`、`0x7C79…`）哈希均为 `0x2eff…970d`，所以 dev 无需配置该键。
4. **交易用实例自己的路由**：报价 `quote.router`、交易准备 intent 的 `contractAddress` / `calldata.to` / `approval.spender`、模拟 `eth_call` 的 `to` 与授权覆盖的 spender、gas 估算的 spender，全部用该实例工厂的 `loopRouter()`。`…/dynamic-pool` 的 `router`、实例详情 `pool.router` 同样（详情在工厂不可信 / 不可读时为 null，不猜）。
5. 端口变化：`Launch2DynamicChain` 新增 `readFactoryRouting(factory)`、`readFactoryHook({factory, launchId})`，`verifyRouter(router?)`，`Launch2DynamicSwapCall.router`（必填）。

### 影响面逐项

| 面                                                      | 结论                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `…/dynamic-pool`、公开页详情 / 列表 `dynamicReasonCode` | 走 `dynamicHookAt`，按工厂解析；旧实例 200                                                         |
| `…/pool/quote`、`…/pool/trade/prepare`                  | 同上 + swap / 授权目标 = 实例自己的路由                                                            |
| `…/dynamic-pool/claim/prepare`                          | 走 `dynamicHookAt`（不验路由代码哈希，照旧）；目标是 Hook，不经路由                                |
| `…/dynamic-pool/rewards`                                | 只读库，不读链、不校验路由——不受影响                                                               |
| poke 车道                                               | 直接 poke Hook，不读路由——不受影响                                                                 |
| 买回 keeper                                             | 经实例自己的 `LoopDynamicBuybackAdapter` → 其 immutable `router`（部署时绑定的该代路由）——不受影响 |
| 索引器                                                  | 用 Hook 自己的 `trustedRouter()` 归属成交——不受影响                                                |

## 4. 安全边界

- 只信任名单内工厂；名单外工厂的实例 fail closed，且不对其发链上读。名单来自运维 env（与 worker 同值同校验：格式错、重复、与当前工厂相同均拒启动）。
- 路由不是由 Hook 自报：期望值来自受信工厂的 immutable getter，Hook 必须与之一致，且 Hook 必须是该工厂 `loopHook(launchId)`。
- 路由代码哈希校验保留，并扩展到每个工厂的路由；哈希名单只能由 env 扩展。
- 当前工厂与 env 不一致时 503，不静默改用链上值。
- 签名出口的对手方信任仍为「实例合约 + 本次校验过的路由」（`verifiedRouter`），只是路由按实例。

## 5. Tests

- `test/launch2-dynamic-factory-routing.test.ts`（新，单测）：新工厂实例（env 一致）通过；旧工厂实例（不同 router / registry）dynamic-pool / quote / prepare 200，返回并使用该实例自己的路由（swap 模拟、intent `to` / spender、详情 `pool.router`），只验旧路由代码哈希；名单外工厂 503 `FACTORY_UNKNOWN` 且零链上读、详情 `pool.router = null`；名单内但 getter revert 503 `FACTORY_UNKNOWN`；当前工厂链上 router ≠ env、registry ≠ env 均 503 `ROUTER_MISMATCH`，旧工厂 registry 不比 env；旧实例 Hook 指向新路由 / registry 不符 / `loopHook` 不符 503 `HOOK_MISMATCH`；缓存命中不重复读链、失败不缓存；API 配置解析（v2 被排除、哈希大小写 / 空格、非法哈希与与当前工厂相同的 legacy 条目拒启动）。
- `test/public-meme-routes.test.ts`：旧工厂实例公开详情 200（`buyFeeToken = meme`），列表行 `dynamicReasonCode = null`；名单外工厂详情 503 / 列表行 `FACTORY_UNKNOWN`。
- `test/public-meme.integration.test.ts`：种子 LoopDynamic 实例改挂当前 LoopDynamic 工厂（无 SQL 变化，单文件对 `loop_api_test` 跑过）。
- 既有 LoopDynamic 路由 / 公开页 / chain-guard 测试：夹具实例改挂当前 LoopDynamic 工厂（`launch2DynamicFactoryEnv`），S209 / 怪位 Hook 用例给出对应 `loopHook`。
- `test/launch2-dynamic-factory-routing-anvil.integration.test.ts`（新，anvil，无数据库）：同一 anvil 上跑两次 `DeployLoopProtocol` LoopDynamic 组件（两代并存），真实读取器读出两个工厂各自的 router / registry / Hook 部署工厂；token 与 EOA 答 null；配置新路由时旧路由（PoolManager 不同 → 哈希不同）被拒，列入 `legacyRuntimeCodeHashes` 后通过。未做两代实例各自毕业后的端到端报价（需要两套完整发射 + 毕业流程），由上面的单测替身覆盖。
- 实测（dev 库只读 `default_transaction_read_only=on`，worktree API 随机端口）：`/public/v1/meme/2f0d01fa…`（工厂 `0xd05E`）200，`dynamic.buyFeeToken = meme`；dev 3100 上同一请求仍 503 `LAUNCH2_DYNAMIC_HOOK_MISMATCH`（未部署本修复）。
