# 0145 · 钱包净值历史（小时快照）与今日盈亏（S199-api，2026-10-15）

依据：主代理 S199-api 任务单（2026-10-15）；设计稿 `docs/35-代币列表与代币页设计稿-2026-10-15/body4.html`「钱包 C」两个手机框（总资产 + 折算 + 今日盈亏、7 天小折线，点开为带高低点的 1 天 / 7 天 / 30 天 / 180 天 / 360 天面积图；没有历史的区间画「暂无」；汇率没有来源就不画那一行）；Decision 0033（钱包读模型）、0034（估值来源）、0082（价格读失败不拖垮余额）、0100（`netWorth.change24h`）、0143（worker lane 写法）。
范围：只在 `loop-api`。新增 migration `000085_wallet_networth_snapshots`、worker lane `wallet_networth_snapshot`、接口 `GET /v2/wallets/:walletId/networth/history`。**不新增能力位**（TF 21 客户端对第 36 个能力位整份判无效），不可用时用本接口的 503 + reasonCode。不改 `ops/`、不重启 launchd。

## A. 表（migration 000085）

`wallet_networth_snapshots(wallet_id uuid → account_wallets on delete cascade, at timestamptz, net_worth_usd numeric (>= 0), quality text in ('fresh','stale','partial'), created_at, primary key (wallet_id, at))`，索引 `wallet_networth_snapshots_recent_idx (wallet_id, at desc)`。

- `at` 是快照槽的起点（默认整点），不是测量时刻：同一槽重复跑只保留第一条（`on conflict do nothing`），lane 重启不会重复写。
- `partial`：至少一行资产估不了价，值不含它（与 balances `netWorth.status = partial` 同义）；`stale`：全估了价但有过期价格。**一行都估不了的钱包不写**，不记 `0`。
- `down` 删表。`latestMigrationName` 升到 000085，`requiredDatabaseRelations` 加上该表。

## B. 估值复用（与 balances 同一套）

`wallet-read-service.ts` 把原先闭包里的三段提到模块级并导出，`getBalances` 改为调用它们，行为不变（`v2-chain-wallet-routes` 55 条原有用例全过）：

- `projectBalanceAmounts`：一行的 display / available / spendable / gasReserve；
- `valueWalletRow`：只用资产自己（或 WBNB 代理原生币）的 `fresh` / `stale` 价格估值；
- `summarizeWalletNetWorth`：求和、`unavailableCount`、`quality`、`asOf`、24 h 变化。

新增 `measureWalletNetWorth({ readClient, address, assets, prices })`：一次 multicall 读余额 + 上面三段，**不做** Privy 交叉核对、pending、launch 槽、余额审计快照（所以 lane 本身不会让钱包"变活跃"）。总额按 0100 的规则四舍五入到 6 位；`partial` 见 A；全估不了返回 `null`；链读失败抛出。

## C. worker lane `wallet_networth_snapshot`

- env：`WALLET_NETWORTH_SNAPSHOT_ENABLED`（默认 `true`）、`WALLET_NETWORTH_SNAPSHOT_INTERVAL_MS`（默认 3 600 000，60 000–86 400 000）、`WALLET_NETWORTH_SNAPSHOT_BATCH`（默认 200，1–1000）。
- 槽按 epoch 对齐 `floor(now / interval) * interval`，小时槽即整点；一轮跑完睡到下一槽起点 + 30 s（不超过槽长的十分之一）。启动时立即跑一轮，写当前槽（首跑没有历史，就只有这一个点）。
- 候选：`account_wallets.status = 'active'`，且「owner 有 `device_sessions.last_seen_at` 在最近 30 天内」或「该钱包有 `wallet_balance_snapshots.observed_at` 在最近 30 天内」（= 30 天内登录过或读过余额），且本槽还没有快照。按 `wallet_id` keyset 分页，每页 `_BATCH` 条，同页内最多 4 个钱包并行测量。链读失败的钱包本轮跳过（计 `failedCount`），不会在同一轮里被反复选中。
- 价格每轮只读一次（`readAssetPrices`，与 API 同一 fact cache / DexScreener Provider），整轮价格读失败时全部钱包计 `unvaluedCount`、不写行，日志带 `MARKET_PROVIDER_UNREACHABLE`。
- 依赖：`BSC_RPC_URLS`（复用 indexer 的 read client）、chain registry、market fact cache。缺一则 lane 不启动，打一行 `stays idle`（`BSC_RPC_NOT_CONFIGURED` / `WALLET_NETWORTH_HISTORY_UNAVAILABLE`）。数据库错误 1 s → 60 s 退避，不影响其他 lane。
- 每轮一行 info：`count`（候选）、`inserted`（写入）、`unvaluedCount`、`failedCount`（日志字段白名单新增后两个数字字段）；不记地址、金额、钱包 ID。

## D. 接口 `GET /v2/wallets/:walletId/networth/history?range=1d|7d|30d|180d|360d`

Bearer（LOOP 会话），wallet 模块路由。`range` 必填，其他值 / 多余参数 400 `INVALID_REQUEST`；钱包不属于调用方 404 `NOT_FOUND`。

> 修订：`fiat` 的最终形状见 Decision 0149 §4。

```json
{
  "walletId": "…",
  "range": "7d",
  "points": [{ "at": "…", "netWorthUsd": "6500", "quality": "fresh" }],
  "current": {
    "netWorthUsd": "6352.815",
    "at": "…",
    "quality": "fresh",
    "origin": "live"
  },
  "change24h": { "usd": "352.815", "pct": "5.8803", "baselineAt": "…" },
  "high": { "at": "…", "netWorthUsd": "6500" },
  "low": { "at": "…", "netWorthUsd": "6100.5" },
  "fiat": { "currency": "CNY", "rate": "7.113", "amount": "45187.57" },
  "source": "dexscreener",
  "observedAt": "…",
  "contractVersion": "2.0"
}
```

- **降采样**：窗口 `(now − range, now]`，按 `floor(epoch(at) / slot)` 分段取每段最后一个快照：1d 每 1 h、7d 每 4 h、30d 每 1 天、180d 每 3 天、360d 每 7 天（UTC / epoch 对齐，窗口起点那段可能不满，所以 7d 实际 42–43 点、30d 30–31 点），最多取最新的 120 段，旧在前。
- **current**：请求时按 B 实时测量（`origin: live`，`at` = 响应时刻）；实时读失败或估不了价时退回最新快照（`origin: snapshot`，`quality` 至多 `stale`，`partial` 保持）；两者都没有 → 503 `WALLET_NETWORTH_CURRENT_UNAVAILABLE`。`points` 不重复包含 current。
- **change24h**：`current − ` 「`current.at − 24 h` 及之前、且不早于 `current.at − 48 h` 的最新快照」；没有这样的快照为 `null`（早于 48 h 的点不叫"24 h 前"）。`usd` 6 位、`pct` 4 位，四舍五入；基准为 0 时 `pct = null`。附 `baselineAt`。
- **high / low**：窗口内非 `partial` 快照（SQL 取极值，同值取较新的）与非 `partial` 的 current 之间比较；都没有为 `null`。`partial` 点仍出现在 `points` 里（带 quality），但不当极值，避免假低点。
- **fiat**：~~`FIAT_CNY_PER_USD`（API 进程 env）配了才有~~ **已由 Decision 0149 修订（2026-10-16）**：汇率改读 `fiat_fx_rates`（worker lane `fiat_fx_rate`，默认 ECB 参考汇率经 Frankfurter），`fiat` 增加 `source` / `asOf` / `fetchedAt` / `quality`，`FIAT_CNY_PER_USD` 删除；`amount = current × rate` 四舍五入 2 位不变；没有汇率记录为 `null`。
- **503**：快照仓储未组装或任何快照读取失败 → `CAPABILITY_UNAVAILABLE` + `detailsSafe.reasonCode = WALLET_NETWORTH_HISTORY_UNAVAILABLE`（不新增能力位）。
- `cache-control: no-store`；所有金额是十进制字符串。

## E. 与任务单的差异

- 响应多了 `walletId`、`current.origin`、`change24h.baselineAt` 三个字段（只增不改，方便客户端判断"实时 / 快照"和标注基准点）。
- `change24h.pct` 可为 `null`（基准为 0 时没有百分比）。
- 24 h 基准限定在 24–48 h 前；更早的点不算。
- 高低点排除 `partial` 快照。
- 多一个 reasonCode `WALLET_NETWORTH_CURRENT_UNAVAILABLE`（既无实时值也无快照）。

## F. 测试与门禁

- 单测 `test/wallet-networth-snapshot.test.ts`（13 条）：measure 的求和 / 6 位舍入 / stale / partial / 全估不了为 null / 零余额；lane 的分页（`afterWalletId`）、槽起点、价格每轮一次、`unvaluedCount` / `failedCount`、价格读失败不写、数据库错误退避；服务的零基准 `pct = null`、partial current 不当极值、非法 range；五档都 ≤ 120 点；`FIAT_CNY_PER_USD` 与三个 lane env 的解析。
- 契约 `test/v2-chain-wallet-routes.test.ts` 新增 6 条（经 `buildApp` 组装）：完整文档与 OpenAPI 响应 schema、current 与 balances netWorth 同值（6352.815）、`bucketSeconds` / `limit` 传参；无历史只有 current；range 400；401 / 他人钱包 404；表读失败与未组装 503；实时估不了价退回快照、无快照 503 current。
- 集成 `test/wallet-networth-history.integration.test.ts`（一次性库，5 条）：候选选择（30 天内会话 / 余额读取；40 天前的、archived 的不选）、写入值与 quality（`1201` fresh、`1200` partial；估不了与链读失败的不写）、同槽再跑不重复、`on conflict` 保留；40 天小时数据下五档降采样的点数 / 对齐 / 顺序、24 h 变化（`26` / `20.9677%`）、高低点（partial 低点被排除）、无历史时 current、实时失败退回快照、他人钱包 404；超过 48 h 的旧点不算 24 h 基准、无汇率 `fiat: null`；连接池关闭时 503；000085 down / up 与索引形状。
- `test/square-feed.integration.test.ts` 的「down 一步」改为 down 掉 000084 及之后全部（同 0141 E 的写法）；各「最新迁移」断言改为 000085；worker 配置快照加 `walletNetWorthSnapshot` 默认值。
- 8 个集成套件的 `truncate` 清单（含 `account_wallets` 的）加上 `wallet_networth_snapshots`（新表外键引用 `account_wallets`，否则 truncate 被拒）；`scripts/dev-reset-users.ts` 把该表归为 `user` 并随钱包删除；`test/openapi.test.ts` 路径清单与 operationId 数（198）、`test/database-schema.test.ts` 关系清单同步。
- 全量集成套件在 `loop_api_test_s199` 上跑：78 个套件，修完上述 truncate 后全部通过。
- 测试库：按任务单用同一连接串新建 `loop_api_test_s199`（`DATABASE_URL_TEST` 覆盖），未碰共享 `loop_api_test`，结束 drop。
