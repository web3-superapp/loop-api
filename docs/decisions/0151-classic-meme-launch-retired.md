# 0151 · 停用经典发射的新建，统一走 Loop Hook（S217-api，2026-10-16）

- Status: Accepted (S217-api)
- Date: 2026-10-16
- Baseline: `integration/v2` = `069d798`
- Revises: Decision 0101 §「create」（`POST /v2/meme/tokens`、create Intent）
- Related: 0101（MEME 曲线发射台 API）、0102 / 0105（运营隐藏 / 暂停）、0104（create Intent 并发与额度）、0114 起的 `launch2`（Loop Hook）
- Scope: 只在 `loop-api`。新增 env `MEME_CLASSIC_CREATE_ENABLED`（默认 `false`）、V2 错误码 `MEME_CLASSIC_LAUNCH_RETIRED`（410）、`V2ErrorStatusCode` 加 410。不改 SQL / migration、不新增能力位、不改 `openapi/loop-api.v1.json`（冻结）、不改 `ops/*.env`。

## Context

需求方 2026-10-16 确认：「正常发射从 App 和 H5 中移除，统一 Loop Hook 发射」。

「经典发射」指 Decision 0101 的 four.meme 式联合曲线发射台：一个 `LoopMemeCurve` 合约用 CREATE2 为每次发射克隆 `LoopMemeToken`，曲线卖完后毕业进 PancakeSwap V3。其合约侧规格是 loop-contracts 的 `docs/decisions/0001-meme-curve.md`（0101 Inputs 里的 `37cb992`）；本仓库的 `docs/decisions/0001-node-fastify-foundation.md` 与它无关。API 侧的新建入口是两步：`POST /v2/meme/tokens` 建草稿（保留 salt、算 `metadataHash`），再 `POST /v2/meme/tokens/{id}/intents` `kind: "create"` 生成 `createToken` 调用让设备签名。

Loop Hook 发射（`/v2/launch2`）已是唯一对外的新建方式；客户端按 0195 的开关隐藏经典入口。但旧客户端（TF 25 及之前）和直接调 API 的人仍能建经典代币，所以服务端也要关。测试网上已有的经典代币仍要能看、能买卖。

## Decision

### 1. 开关

| Key                           | Default | Meaning                                                                                                  |
| ----------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `MEME_CLASSIC_CREATE_ENABLED` | `false` | `true` 时经典新建与改前完全一致；`false` 时两个新建入口返回 410。只接受 `true` / `false`，其它值拒绝启动 |

在 `memeEnvironmentShape` 里（API 与 worker 共用的 MEME 段），进 `MemeConfig.classicCreateEnabled`。默认关，所以 dev / staging 不改 env、重新部署即生效；需要演示旧流程时显式设 `true`。没有碰 `src/config.ts` 的链 ID 校验段。

### 2. 被 410 的端点

| 端点                                                         | 条件                                      |
| ------------------------------------------------------------ | ----------------------------------------- |
| `POST /v2/meme/tokens`                                       | 开关为 `false`                            |
| `POST /v2/meme/tokens/{memeTokenId}/intents`，`kind: create` | 开关为 `false`（`buy` / `sell` 不受影响） |

错误体沿用 V2 七字段模型：

```json
{
  "code": "MEME_CLASSIC_LAUNCH_RETIRED",
  "category": "availability",
  "retryable": false,
  "userMessageKey": "errors.meme.classicLaunchRetired",
  "correlationId": "…",
  "detailsSafe": { "reasonCode": "MEME_CLASSIC_LAUNCH_RETIRED" },
  "providerReferenceSafe": null
}
```

- `userMessageKey` 新增 `errors.meme.classicLaunchRetired`，客户端文案「经典发射已停用，请使用 Loop Hook 发射」。
- 为什么新增一个码而不是 `CAPABILITY_UNAVAILABLE` + reasonCode：503 是 `retryable: true`，客户端会重试或提示「稍后再试」，而这里是永久下线；410 Gone 才说得对。类别用已有的 `availability`，不新增类别（类别枚举仍是八个）。
- 判断在 service 里、在读配置 / 读链 / 写库之前（`createToken` 第一行；`prepareIntent` 对 `kind === "create"` 先判），所以被拒请求不建草稿、不占 salt、不写 Intent、不记幂等键（之后打开开关，同一个 Idempotency-Key 仍可正常使用）。
- 退休先于 503：即使合约未配置，新建也答 410（入口本身已不存在，配置状态无关）。
- 请求体先过 schema 校验，畸形请求仍是 400。

### 3. 不动

- 读：`GET /v2/meme/tokens`、`GET /v2/meme/tokens/{id}`、`/trades`、`/candles`、`/holders`、`GET /v2/meme/best-trades`、`GET /v2/meme/quote`、`GET /v2/meme/intents/{id}`。
- 写：`POST …/intents` 的 `kind: buy | sell`、`POST …/intents/{memeIntentId}/broadcast-report`。
- admin：`GET /admin/v1/meme/tokens`、`POST …/listing`、`POST …/pause` / `unpause`。
- worker：`meme_event`、`meme_salt_pool`、`meme_intent_reconcile`、`meme_graduation_executor` 车道；`category=meme` 的市场候选；公开页。

### 4. 能力位

`/v2/meta/capabilities` 不新增 id（避免扰动 TF 25）。也**不**用 `meme` 能力位的 `reasonCode` 表达「创建已停用」：该字段的约定是「`availability = available` 时为 `null`，非 null 即不可用的原因」，而 `meme` 的读与买卖仍然可用；在 available 时塞一个原因码会被现有客户端误判为整个 MEME 模块不可用。客户端靠 0195 的开关隐藏入口，万一仍调用，按 410 提示上面的文案、不重试。

### 5. OpenAPI

两个路由的 `responses` 加 `410`（只含 `MEME_CLASSIC_LAUNCH_RETIRED`），description 注明 0151。`openapi/loop-api.v2.json` 重生成；`openapi/loop-api.v1.json` 不变。`docs/api-inventory.md` 对应行标 `retired (0151)`，`docs/api-v2-conventions.md` 错误码表加一行，`docs/frontend-v2-meme-api.md` 顶部加说明。

## 恢复方法

- 临时（演示 / 回滚）：在 API 进程 env 设 `MEME_CLASSIC_CREATE_ENABLED=true` 并重启 API，两个入口立即恢复改前行为，无需迁移或数据修复。
- 永久恢复：另起决策撤销本条，把默认改回 `true` 或删掉开关；错误码保留在目录里（目录只增不改）。

## 对测试网历史数据的影响

- 不删、不改任何行：`meme_tokens`、`meme_intents`、`meme_trades`、salt 池等原样保留；已上链的经典代币照常列出、详情、K 线、持仓、报价、买卖、毕业、运营隐藏 / 暂停。
- 已存在但未部署的草稿（`status = draft`）在开关关闭期间无法再发起 create Intent（410），它们留在库里，只有创建者能看到；打开开关后可继续部署。已在途的 create Intent 不受影响（回报与回执对账照常）。
- salt 池补充 lane 仍按 `MEME_SALT_POOL_TARGET` 维持空闲 salt；不新建草稿时池子不会被消耗，无额外成本。

## Tests

- `test/v2-meme-routes.test.ts` · `Decision 0151 classic launch retired`：
  - 不设开关默认 `false`；`"true"` 为 `true`；`"yes"` 启动拒绝。
  - 默认下 `POST /v2/meme/tokens` 与 create Intent 都是 410，七字段错误体、`no-store`；仓库的代币表（含草稿 salt）前后完全相同、Intent 数为 0；开关为 `true` 时同一请求 201。
  - 默认下列表 / 详情 / trades / candles / holders / quote 200，buy 与 sell Intent 201，broadcast-report 200，Intent 读回 200，`meme` 能力位仍 `available`、`reasonCode: null`。
  - 合约未配置时新建答 410（退休先于 503）。
- 其余既有 MEME 用例在 `memeEnv` 里显式 `MEME_CLASSIC_CREATE_ENABLED=true` 运行，未改断言即通过 = 开关为 `true` 时与改前一致。
- `test/v2-error-contract.test.ts`：错误码目录加 `MEME_CLASSIC_LAUNCH_RETIRED`（410 / availability / 不重试），总数 33。
- `test/meme-curve-math.test.ts`：`parseMemeConfig` 透传开关。
- 不改 SQL，不跑集成套件；`test/meme-canary-indexing-fixes.integration.test.ts` 只补了配置字段（类型检查覆盖）。
