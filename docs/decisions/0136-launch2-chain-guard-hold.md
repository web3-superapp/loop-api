# 0136 · launch2 写路径接 chain guard hold（S177-api，2026-10-14）

依据：主代理 S177 任务单（2026-10-14）；Decision 0134 §4（`CHAIN_GUARD_HOLD`，hold 为全局）与 §9-3（按实例细分待决）；Decision 0135（hold 状态按链去重）；Decision 0114 / 0124 / 0131（`/v2/launch2/*` 路由与拒绝模型）。
范围：只在 `loop-api`。不新增 env、不新增迁移、不签名、不改 worker lane。`/v2/launch2/instances/{instanceId}` 详情加一个字段，六条写路由加两个 reasonCode。

## 1. 为什么

0134 只让三条签名 lane（keeper / executor / poke）在 USD1 暂停或我方地址被冻结时停下。App 侧的买卖、铸 NFT、领取仍能拿到 prepare，用户签名广播后在链上失败（USD1 `transfer` revert），白白付 gas。本批让 launch2 所有写路径在同一 hold 下直接拒绝，并在实例详情上给 App 一个可展示的提示。

## 2. 契约

### 2.1 实例详情 `GET /v2/launch2/instances/{instanceId}`

`instance` 新增必有字段：

```
tradingHold: null | { kind: "usd1_paused" | "address_frozen", since: string(date-time) }
```

- 数据源：`chainGuard` 仓库 `listHolds(LAUNCH_CHAIN_ID)`（未解决的 `usd1_paused` / `usd1_address_frozen`），每个请求查一次，不缓存（表极小，有部分唯一索引）。
- `usd1_paused` → `kind: "usd1_paused"`；`usd1_address_frozen` → `kind: "address_frozen"`；两种同时存在取 `usd1_paused`；同 kind 多行取最早的 `first_seen_at` 作 `since`。
- 按链、不按实例（与 0134 一致）：任一监视地址被冻结，所有实例都显示 hold。
- 列表 `GET /v2/launch2/instances` 不加（摘要类型不变）。

### 2.2 写路径拒绝

| 路由                                | 说明     |
| ----------------------------------- | -------- |
| `GET …/quote`                       | 内盘报价 |
| `POST …/trade/prepare`              | 内盘买卖 |
| `POST …/nft/prepare`                | 铸 NFT   |
| `GET …/pool/quote`                  | 外盘报价 |
| `POST …/pool/trade/prepare`         | 外盘买卖 |
| `POST …/dynamic-pool/claim/prepare` | 领取     |

hold 存在时：**503 `CAPABILITY_UNAVAILABLE`**，`retryable: true`，`detailsSafe = { reasonCode, since }`：

- `LAUNCH2_USD1_PAUSED`（`since` = 暂停 incident 的 `first_seen_at`）
- `LAUNCH2_ADDRESS_FROZEN`（`since` = 最早的冻结 incident 的 `first_seen_at`）

两种同时存在取 `LAUNCH2_USD1_PAUSED`（与 `tradingHold` 同一选择函数 `launch2TradingHoldOf`）。

检查位置：实例可见性之后（未知 / 未激活实例仍是 404 `LAUNCH2_INSTANCE_NOT_FOUND`），任何链读、幂等记录、阶段 / 余额判断之前；prepare 中 `LAUNCH2_WRITES_DISABLED` / `LAUNCH2_MAINNET_SIGNING_CLOSED` 与请求体校验仍在它之前（原有顺序不变）。同一 `Idempotency-Key` 的重放在 hold 期间也被拒（未签的 intent 签了也会在链上失败）。

不拒绝：实例列表 / 详情、`dynamic-pool`、`dynamic-pool/rewards`、`pool/trades`、`buybacks`、`me/positions`，以及 `dynamic-pool/claim/report`（已广播的交易要能对账）。launch2 没有单独的交易上报路由（成交由 `launch2_event` lane 从链上索引）。

## 3. 为什么选 503 `CAPABILITY_UNAVAILABLE`

项目里「服务端暂停写操作」一类拒绝都是 503 `CAPABILITY_UNAVAILABLE` + reasonCode：`MEME_WRITES_DISABLED`、`BSC_WRITES_DISABLED`、`LAUNCH2_WRITES_DISABLED`、`MINING_CLAIM_WRITES_DISABLED`，以及最贴近的 `MINING_CLAIM_CONTRACT_PAUSED`（外部合约被暂停 → 领取关闭）。hold 的语义正是「依赖（USD1 / 我方托管地址）暂时不可用，服务端暂停写」，与请求本身无关、解除后原样重试即可（`retryable: true`）。

未选 409 `DATA_STALE`（`LAUNCH2_INSTANCE_PAUSED` 用的那一类）：409 表示「这个实例的状态与请求不符，刷新后换个请求」，App 会刷新实例 / 报价；而 hold 是链级外部事件，刷新无用，且与实例的 `stage` 无关（`stage` 不因 hold 变成 `paused`）。六条路由一律 503，App 用 `detailsSafe.reasonCode` 区分，用详情的 `tradingHold` 常驻展示。

## 4. 开关与 Unavailable 行为

| 情况                                           | 写路径                                                       | 详情 `tradingHold` |
| ---------------------------------------------- | ------------------------------------------------------------ | ------------------ |
| `CHAIN_GUARD_ENABLED` 未设 / false             | 不查、不拒（与 0136 前逐字节相同，除详情多一个 `null` 字段） | `null`             |
| 开启但无数据库仓库（`database.chainGuard` 缺） | 不查、不拒                                                   | `null`             |
| 开启、查询正常、无 hold                        | 照常                                                         | `null`             |
| 开启、有 hold                                  | 503 `LAUNCH2_USD1_PAUSED` / `LAUNCH2_ADDRESS_FROZEN`         | `{kind, since}`    |
| 开启、`listHolds` 抛错（库不可用、行形状不对） | 503 `CHAIN_GUARD_REPOSITORY_UNAVAILABLE`（宁可不签）         | `null`，warn 一条  |

- 开关复用 worker 已有的 `CHAIN_GUARD_ENABLED`（API 配置新增只读字段 `chainGuardEnabled`，同一个解析函数；非法值同 worker 一样拒绝启动）。**API 进程的 env 里也必须有 `CHAIN_GUARD_ENABLED=true` 才生效**；本仓库不改 `ops/*.env`。
- warn：`event: launch2.chain_guard_hold_unreadable`、`reasonCode: CHAIN_GUARD_REPOSITORY_UNAVAILABLE`、`errorClass`，消息 `LOOP launch2 could not read the chain guard hold`。一次连续失败只记一条；查询恢复成功后再失败会再记一条。不回显错误消息。
- reasonCode 用 chain guard 自己的 `CHAIN_GUARD_REPOSITORY_UNAVAILABLE`（而不是 `LAUNCH2_REPOSITORY_UNAVAILABLE`），运维能直接看出是 hold 查询而不是 launch2 读模型出了问题。
- 无进程内缓存：每请求一次主键 / 部分索引查询，代价可忽略；不引入缓存就没有「hold 已解除但 5 s 内仍拒绝」或相反的窗口。

## 5. 实现

- `src/features/launch2/launch2-trading-hold.ts`：`launch2TradingHoldOf(incidents)`（选择规则）与 reasonCode 表。
- `launch2-service.ts`：依赖 `chainGuardHolds?: ChainGuardHoldGate | null`（复用 0134 的 `createChainGuardHoldGate`）；`requireNoTradingHold()` 在六个方法里调用；详情并行读 `tradingHoldForView()`。
- `app.ts`：`config.chainGuardEnabled === true && database.chainGuard` 时注入 gate（链 = `config.launchChain.chainId`），否则 null。
- `launch2-schemas.ts`：详情 `instance.tradingHold`（必有，`anyOf [object, null]`，`additionalProperties: false`）；六条路由 description 追加 hold 说明。OpenAPI 产物 `openapi/loop.v2.json` 重新生成。

## 6. 测试

- 新增单测 8 条：`test/v2-launch2-chain-guard-hold.test.ts`
  - 六条写路由在 `usd1_paused` / `usd1_address_frozen` 下各 503 + 对应 reasonCode + `since`，查询的链为 `eip155:97`（2 条）
  - 只读路由（列表、详情、dynamic-pool、rewards、pool/trades、buybacks、me/positions）200，claim/report 不被 hold 拒（1 条）
  - `tradingHold` null → address_frozen → 两者并存取 usd1_paused → 别链的 hold 不算（1 条）
  - `CHAIN_GUARD_ENABLED` 关：不查、外盘报价 200、详情 null（1 条）
  - 无仓库：详情 null、领取 prepare 201（1 条）
  - 查询抛错：六条写 503 `CHAIN_GUARD_REPOSITORY_UNAVAILABLE`、详情 200 + null、warn 只一条，恢复后再失败再记一条（1 条）
  - `launch2TradingHoldOf` 选择规则（1 条）
- 无新增集成测试（不涉及 SQL；`listHolds` 的 SQL 已由 0134 集成测试覆盖）。门禁：`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm openapi:check` 通过；`pnpm test` 311 文件 / 4365 条全过；集成（chain-guard ×2、launch2-creator-followups、launch2-dynamic、mining-launch2-followups、launch2-anvil、launch2-pool-anvil）7 文件 / 36 条全过。

## 7. 未做 / 待决

- 按实例细分 hold（0134 §9-3）仍未做：冻结任一监视地址即全局拒绝。
- 列表摘要不带 hold；App 只在详情展示。
- `usd1_implementation_changed` 等仍不 hold（0134 §9-4）。
