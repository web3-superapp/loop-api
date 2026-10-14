# 0133 · launch2 只配 LoopDynamic 工厂也可用（S172-api，2026-10-14）

依据：主代理 S172 任务单（2026-10-14）；S171 走查发现——只配 `LAUNCH2_DYNAMIC_FACTORY_*`、不配 `HOOKS_LAUNCH_FACTORY_*` 时 `/v2/launch2/*` 全部 503、`launch2_event` lane 空闲，原因都是 `LAUNCH2_FACTORY_NOT_CONFIGURED`。主网若选需求方的 LoopDynamic 模型就不会部署 OfficialTax 工厂，此限制必须去掉。Decision 0114（launch2 读模型）、0122（工厂代际与 `LAUNCH2_LEGACY_FACTORIES`）、0131（LoopDynamic 索引）、0132（LoopDynamic 执行器 / `HOOKS_LAUNCH_HOOK_KIND`）。
范围：只在 `loop-api`。无 migration、无新接口、无新错误码，App 契约不变。未广播任何链、未用真实私钥、未碰 ops 栈 / dev 库 / staging。

## 1. 「launch2 已配置」的定义

launch2 已配置 = OfficialTax 工厂对（`HOOKS_LAUNCH_FACTORY_ADDRESS` + `_CODE_HASH`）**或** LoopDynamic 工厂对（`LAUNCH2_DYNAMIC_FACTORY_ADDRESS` + `_CODE_HASH`）至少一个完整存在。两对都缺才是 `LAUNCH2_FACTORY_NOT_CONFIGURED`。

- 只有 `LAUNCH2_LEGACY_FACTORIES`（只读旧工厂，不接新发射）不算已配置。
- 半对仍按 0108 / 0131 拒绝启动（不会被当作「已配置」）。
- 其后的判定顺序不变：`LAUNCH2_CHAIN_NOT_CONFIGURED` → `LAUNCH2_REPOSITORY_UNAVAILABLE` → `LAUNCH2_RUNTIME_UNAVAILABLE`。

| 位置                                                   | 改动                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| API `launch2UnavailableReason`（`src/app.ts`）         | `factoryAddress === null && dynamicFactory === null` 才 `LAUNCH2_FACTORY_NOT_CONFIGURED` |
| `meta/capabilities` 的 `launch2`                       | 读同一个 reason，自动一致                                                                |
| worker `launch2_event` lane（`src/worker-runtime.ts`） | 工厂清单由 `launch2IndexerFactories(config)` 给出；null（两对都缺）才空闲                |

## 2. 工厂清单（`launch2FactoryEntries`）

- `current`（OfficialTax 工厂）改为可选。清单顺序：OfficialTax（若有，`current: true`，代际按 `HOOKS_LAUNCH_FACTORY_CODE_HASH` 查表）→ legacy → LoopDynamic（若有，代际 = 构建代际 `v3`，`current: false`，同 0131）。
- 只有 LoopDynamic：清单 = legacy + LoopDynamic，没有 `current: true` 的项。lane 不读 `current` 标志（注册按 `factory_address` 关联、`factory_generation` 取清单里的代际、`pool_hook_kind` 由 `hook_address` 生成列推导——0131 均不变）。
- 两者都缺：函数拒绝（`Launch2LegacyFactoriesInvalidError`）；调用方先用 `launch2IndexerFactories` 判 null，不会走到这里。
- 有 OfficialTax 工厂时输出与之前逐项相同（既有测试断言未改）。lane 启用日志的 `factoryAddress` 仍是 OfficialTax 工厂；只有 LoopDynamic 时是 LoopDynamic 工厂。

## 3. 启动校验（`LAUNCH2_LEGACY_FACTORIES`）

worker 启动时只要任一工厂存在就校验：

- legacy 不得等于 `HOOKS_LAUNCH_FACTORY_ADDRESS`（不变）；
- legacy 不得等于 `LAUNCH2_DYNAMIC_FACTORY_ADDRESS`（新增于启动时；此前只在 lane 构造时抛出，即 worker 跑起来后才崩）；
- `LAUNCH2_DYNAMIC_FACTORY_ADDRESS` 不得等于 `HOOKS_LAUNCH_FACTORY_ADDRESS`（同上，提前到启动）。

违反即 `ConfigurationError` 拒绝启动，信息 `LAUNCH2_LEGACY_FACTORIES: …`。

## 4. 其他只在「有 OfficialTax 工厂」下才有值的读数

逐一检查 `HOOKS_LAUNCH_FACTORY_ADDRESS` 的全部读取点：

| 读数                                      | 处理                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 水龙头 `usd1Source` 的 `factory` 分支     | OfficialTax 工厂优先（不变），否则 LoopDynamic 工厂。两工厂共用 `LoopLaunchFactoryCore.usd1()`（生成 ABI 中 `loopLaunchFactoryAbi` 与 `loopDynamicLaunchFactoryAbi` 的 `usd1() view returns (address)` 一致），读法不变。仍是显式 `TESTNET_FAUCET_USD1_ADDRESS` 最先 |
| 回购 keeper（`LAUNCH2_BUYBACK_KEEPER_*`） | keeper 校验的工厂：OfficialTax 工厂优先（不变），否则 LoopDynamic 工厂（完整对）。两工厂都有 `primaryKeeper()` / `fallbackKeeper()`（共用 core）。两者都缺仍拒绝启动，信息改为 `requires HOOKS_LAUNCH_FACTORY_ADDRESS or LAUNCH2_DYNAMIC_FACTORY_ADDRESS`            |
| Hooks 部署执行器 / 签名链路               | 0132 已按 `HOOKS_LAUNCH_HOOK_KIND` 选工厂，无需改；只配 LoopDynamic 时应设 `HOOKS_LAUNCH_HOOK_KIND=loopDynamic`，否则 officialTax 种类读取器为 null → 503 `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`（fail closed，符合预期）                                                |
| snapshot publisher / 读模型 / 池路由      | 不读 Hooks 工厂地址，不受影响                                                                                                                                                                                                                                        |

## 5. 错误码与 unavailable 行为

- 无新 HTTP 错误码、无新 reason。`LAUNCH2_FACTORY_NOT_CONFIGURED` 只在两对都缺时出现（API 503、capability unavailable、lane 空闲）。
- 只配 LoopDynamic 但缺 launch slot RPC / 链 ≠ 97：照旧 `LAUNCH2_CHAIN_NOT_CONFIGURED`。

## 6. 已知限制 / 需要主代理知悉

- 两对都配时，回购 keeper 只按 OfficialTax 工厂校验 keeper 身份（0121 原行为未改）；若 LoopDynamic 工厂的 keeper 不同，LoopDynamic 实例的 `execute()` 会被链上拒绝。混合部署应让同一 keeper 在两工厂都登记。
- 两对都配时，水龙头仍从 OfficialTax 工厂读 USD1（不按 `HOOKS_LAUNCH_HOOK_KIND` 切换）；两工厂 USD1 不同时需显式设 `TESTNET_FAUCET_USD1_ADDRESS`。

## 7. 证据

`test/launch2-dynamic-only.test.ts`：只配 LoopDynamic 时 `/v2/launch2/instances`、详情 200，capability `available`；无 launch slot 时为 `LAUNCH2_CHAIN_NOT_CONFIGURED`；两对都缺仍 503 `LAUNCH2_FACTORY_NOT_CONFIGURED`；半对拒绝启动；`launch2FactoryEntries` / `launch2IndexerFactories` 只有 LoopDynamic（+legacy）时的清单与拒绝条件；legacy == LoopDynamic 拒绝启动（有 / 无 OfficialTax）；keeper 与水龙头的回落；真实 `runReconciliationWorker` 下 lane 启用并以 `[legacy v2, dynamic v3]` 调 `registerActivatedInstances`，两对都缺时空闲 `LAUNCH2_FACTORY_NOT_CONFIGURED`。
