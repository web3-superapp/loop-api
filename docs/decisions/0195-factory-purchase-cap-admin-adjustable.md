# 决策 0195：工厂内盘单地址上限多签可调——单参数模板哈希、项目级上限读 curve、默认上限只读展示（S340-api，主代理决策 0268）

- 状态：已采纳（S340-api），仅 Development / BSC Testnet；主网工厂未部署
- 日期：2026-11-02
- 基线：`28c2cb9`（integration/v2）
- 依据：`LOOP/docs/54-内盘单地址上限多签可调-2026-11-02.md` §二、§四；loop-contracts main `7bad42a`（contracts 决策 0018，修订 0015）。修订本仓决策 0152 中「上限是工厂模板参数」的部分。

## 1. 合约事实（S340）

- `LoopLaunchFactoryCore.maxCumulativeBuy` 由 immutable 改为存储，getter `maxCumulativeBuy()` `0x4c4d8734` 不变；`setMaxCumulativeBuy(uint256)` `0xcfc64a43` 仅工厂 `admin`（治理 Safe），无时间锁；`(0, 1e9 ether]`、与旧值不同。
- 事件：`MaxCumulativeBuyUpdated(uint256 previousCap, uint256 newCap)` topic0 `0x05779db6…56e4cc`（构造时 previous = 0 也发一次）；`LaunchMaxCumulativeBuy(bytes32 indexed launchId, address indexed curve, uint256 maxCumulativeBuy)` topic0 `0xc6080497…c5fc2d`，`deployLaunch` 在 `LaunchDeployed` 前发出，值 = 该项目 `CurveEngine.maxCumulativeBuy()`。
- `loopDynamicTemplateHash(config)` 单参数（`0x63e51d41`），公式回到 0013/0014 的 11 字段（不含上限）；默认 50 % 费率封顶向量 `0xe07e1859…49db`，20 % 时 = S200 manifest `0x7a0e33b7…5aed`。项目方签名（`LaunchRequest`）不含上限：签后改值，执行时取执行时工厂值，签名仍有效。
- ABI 片段手写在 `src/integrations/launch/hooks-launch-factory-cap-abi.ts`（生成 ABI 源 b440c4c 早于 S340，合约 ABI 导出不覆盖 protocol 工厂），selector / topic 在测试里钉死。

## 2. 实体与 ID

无新表、无迁移。不新增稳定 ID。工厂地址只作为配置值与展示事实，不作关联键；项目级上限挂在已有的部署任务（`hooks_launch_deployment_tasks.job_id`）的 `verification` jsonb 与事件 `details` 上。

## 3. 模板与世代判定（新旧工厂并存）

`HooksLaunchLoopDynamicParams` 新增 `maxCumulativeBuyAdjustable?: true`，世代 = `hooksLaunchLoopDynamicGeneration(params)`：

| 世代   | 判据                                        | 模板哈希                    | 上限                                        |
| ------ | ------------------------------------------- | --------------------------- | ------------------------------------------- |
| `s165` | 无 `maxDynamicFeeWad`                       | 10 字段                     | 常量 500 万                                 |
| `s193` | 有费率封顶、无 `maxCumulativeBuy()`         | 11 字段                     | 常量 500 万                                 |
| `s209` | 有 `maxCumulativeBuy()`，链上哈希 = 12 字段 | 12 字段（含上限，两参数）   | 工厂 immutable，= 模板 = 每个 curve         |
| `s340` | 有 `maxCumulativeBuy()`，链上哈希 = 11 字段 | 11 字段（单参数，不含上限） | 工厂默认值可调；每个项目以自己的 curve 为准 |

- 读工厂（`readHooksLaunchLoopDynamicTemplate`）：有 getter 时先按 S209 公式比 `TEMPLATE_HASH()`，不等再按 S340 公式比；两者都不等 → `HooksLaunchFactoryTemplateMismatchError`（fail closed）。S209 工厂（现 staging A/B `0x0c27…6bf1` / `0xc8f9…A47A`，重部署后进 `LAUNCH2_LEGACY_FACTORIES` 只读）永远按 S209 读，不会被误判成 S340，反之亦然；S209 工厂若上限与哈希不符仍判坏。
- 缓存：模板其余部分不可变照旧缓存；S340 工厂的上限每次重读（API reader TTL 15 s，执行器每 tick 读一次）。
- 部署 manifest 解析同理：S209 键齐全时按哪个公式复现 `templateHash` 判 `s209` / `s340`。
- `fixedEconomics`（configHash）**键集不变**：S340 时 `perAddressLifetimeBuyCapRaw` / `loopDynamic.maxCumulativeBuy` = 保存配置那一刻的工厂默认值（展示给项目方的数），不加新键（App codec 严格，见 /v2 新键须客户端先行）。签名前只校验 `templateHash`（S340 稳定），不因上限变动拒签。

## 4. 项目级上限一律读 curve

- 执行器核验（`verifyHooksLaunchLoopDynamicDeployment`，`curve_caps`）：
  - S209：curve = 工厂 = 模板上限（不变）。
  - S340：不再比工厂现值（可能已被多签改过）；要求 curve 上限在 `(0, 1e27]`、工厂 getter 可读、部署回执里有本工厂的 `LaunchMaxCumulativeBuy` 且 launchId / curve / 值都与 read-back 一致。缺事件或不一致 → `curve_caps` 失败 → `HOOKS_VERIFICATION_MISMATCH`（不激活）。
- 读模型：`launch2_instances.curve_purchase_cap` 取执行器核验的 `verification.curveMaxCumulativeBuy`（curve 读值）；报价 / 持仓 / 公开 meme 接口读 curve `maxCumulativeBuy()`（缺链回落核验值）。逐处核对过，没有把工厂值当项目值的地方，只修正注释与 OpenAPI 描述。

## 5. 部署前后记录（不阻断）

- 部署前：执行器在本 tick 读到的工厂上限写入 `broadcast` 事件 `details.factoryMaxCumulativeBuy`；同时带上项目保存配置时的值 `signedMaxCumulativeBuy`（取自配置 `fixedEconomics.perAddressLifetimeBuyCapRaw`，执行器上下文 SQL 读出）。
- 部署后：`verification` 记 `curveMaxCumulativeBuy`（原有）、`maxCumulativeBuyAdjustable: true`、`signedMaxCumulativeBuy`；`verified` 事件 details 同步记 `curveMaxCumulativeBuy`。
- 两者不同（保存后多签改过）→ 事件 / verification 加 `maxCumulativeBuyChanged: true`，步骤事件带 `noticeCode: HOOKS_MAX_CUMULATIVE_BUY_CHANGED`，worker 记 warn 日志；任务照常推进（合约已保证签名有效）。

## 6. 后台只读字段

`GET /admin/v1/launch/projects` 与 `/{projectId}` 响应顶层加可选键 `factoryPurchaseCap {status, factoryAddress, maxCumulativeBuy, adjustable}`（loop-admin `client.ts` 宽松解析，旧版忽略）。读工厂 `maxCumulativeBuy()` 现值；无 reader / RPC 失败 / 3 s 超时 / 越界 → `status: "unavailable"`、值为 null，不让页面失败，也不回落默认 500 万。后台不发交易。前端交接见 `docs/frontend-admin-launch-factory-cap-api.md`。

## 7. 没做的 / unavailable

- 不订阅 `MaxCumulativeBuyUpdated`：launch2 索引 lane 只按已注册实例扫工厂日志（起点是实例部署块，构造事件扫不到），事件表按实例建模、无工厂级表；做成需要新表 + 迁移 + 重组处理，不算低成本。「最近一次修改」暂不提供，后台按需读现值。
- OfficialTax 线：工厂同样可调，但其 `TEMPLATE_HASH` 为常量、模板 economics 绑定 500 万常量，核验仍要求 curve = 500 万；多签若在 OfficialTax 工厂改值，执行器会 fail closed（`curve_caps`）。当前 staging 只用 LoopDynamic，未改。
- 错误码：无新增 HTTP 错误码；新增内部 notice `HOOKS_MAX_CUMULATIVE_BUY_CHANGED`（日志 / 事件，不面向 App）与日志 reasonCode `ADMIN_FACTORY_PURCHASE_CAP_UNAVAILABLE`。
