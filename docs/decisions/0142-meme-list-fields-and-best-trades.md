# 0142 · MEME 列表字段核对与每周最佳交易（S187-api-a，2026-10-15）

依据：主代理 S187-api-a 任务单（2026-10-15）；`LOOP/docs/35-代币列表与代币页设计稿-2026-10-15.md`（App 侧 S187-1 列表 A、S187-2 代币页 B、S187-3 首页「每周最佳交易」卡）；Decision 0101（经典 MEME 曲线发射台）、0102（运营隐藏）、0105（hot 页填充）、0095（公开资料 / 隐私）。
范围：只在 `loop-api`。新增 migration `000083_meme_list_volume_best_trades_indexes`（三个索引，无表变化）；新增 `GET /v2/meme/best-trades`；列表 / 详情三个字段只补 OpenAPI 描述。不改 `ops/`、不重启 launchd、不新增 worker lane。

## A. 列表行与详情的三个字段：已存在，只补描述

核对 `src/features/meme/meme-projection.ts` 的 `projectMemeTokenRow`（列表四个 tab 与详情头部共用同一投影）：

| 字段            | 现状（S116 起）                                                                               | 本批                                       |
| --------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `createdAt`     | `chain_created_at ?? created_at`：上链后是 TokenCreated 区块时间，草稿 / 待上链是草稿创建时间 | 不改；OpenAPI 加描述                       |
| `volume24hUsd1` | `(now − 24h, now]` 内非 removed 的内盘 `Trade` 钱包侧 USD1 之和，`formatE18` 十进制字符串     | 不改语义；OpenAPI 写明只算内盘；加覆盖索引 |
| `holderCount`   | `meme_tokens.holder_count`（净持仓为正的钱包数，由 lane 重算，毕业冻结）                      | 不改；OpenAPI 加描述                       |

- 三个字段在列表与详情中都是 required 且恒非空（`volume24hUsd1` 最少 `"0"`）。任务单写的「字段可空」是针对新字段的宽松要求；收紧为非空对客户端是兼容的（可空解码照样能读），因此不改成 nullable。
- **外盘**：经典 MEME 毕业后的 PancakeSwap 外盘成交 LOOP 不索引（`launch2_pool_swaps` 只覆盖 launch2 实例），所以 `volume24hUsd1` 只算内盘，已毕业代币通常为 `"0"`。这一点写进了字段描述和 `docs/frontend-v2-meme-api.md` §3。
- **N+1**：列表是一条 SQL（`statsJoin` 的 `left join lateral` 按页内行数各做一次有界区间聚合，页 ≤ 50 行），没有逐行往返。原来走 `meme_trades_token_time_idx` 还要回表取 `usd1_amount`；000083 加 `meme_trades_token_volume_idx (meme_token_id, traded_at) include (usd1_amount) where not removed`，让这段聚合可以只扫索引。没有把 24h 成交额物化成列：滚动窗口的列需要定时刷新，会让列表与 hot 排名（60 秒快照）出现新的陈旧来源，收益不抵复杂度。

## B. 每周最佳交易 `GET /v2/meme/best-trades?window=7d`

**选择：带缓存的查询，不建 `meme_best_trades` 表、不加 worker。** 理由：本批不能重启 launchd，新 worker lane 上线要另排；数据量（测试网）下一条查询毫秒级；缓存 5 分钟与「每 5 分钟物化一次」对客户端等价。以后量大时改成 worker 物化只需换 repository 实现，HTTP 合同不变。

- 认证与其他 `/v2/meme/*` 一致（Privy Bearer）；「公开读」= 不按调用方区分，所有人看到同一份结果。`window` 只接受 `7d`（默认），其他值或其他参数 400 `INVALID_REQUEST`。合约未配置 / 库不可用同模块其他接口：503 `CAPABILITY_UNAVAILABLE`。
- **计算**（`src/database/meme-repository.ts` 的 `bestTradesSql`，`until` = 计算时刻，`since` = `until − 7 天`）：
  1. `sells`：本合约、`listing = 'listed'`、已上链状态的代币上，`(since, until]` 内非 removed 的内盘卖出，按（钱包, 代币）汇总卖出 USD1 与数量。
  2. `buys`：这些对在 `until` 及以前的全部非 removed 内盘买入（买入 USD1 为钱包侧，含手续费）。
  3. `realized = 卖出 USD1 − ceil(卖出数量 × 买入 USD1 / 买入数量)`；成本向上取整，不夸大收益。没有任何内盘买入的对（代币是转账来的）没有成本基础，不列。
  4. 钱包 → 账号：沿用 `accountJoin` 规则（`account_wallets.status = 'active'`、最早 `first_seen_at` 的那一行）；还要求账号有激活的公开资料，且 `privacy_preferences_v2.trade_history_visibility`（缺省 `everyone`）为 `everyone`。映射不到的钱包（匿名）、无公开资料、交易记录仅自己可见的都不列。
  5. 只列 `realized > 0`，`realized desc, 最后卖出时间 desc, wallet, meme_token_id` 排序，取 10。
- 单位是（钱包, 代币）对，同一用户可多次上榜。均价用「截至计算时刻的全部买入」而不是「每笔卖出当时的移动均价」：简单、可复算；对先卖后再买的少见情形会有偏差，可接受。
- **外盘**：同 A，经典 MEME 外盘不索引，只算内盘。
- **缓存**：服务内存，每个 API 进程一份，`memeRules.bestTradesCacheMs = 300_000`；失败不缓存。运营隐藏代币最长 5 分钟后离榜（hot 是 60 秒，这里接受 5 分钟）。
- **线形**：

```json
{
  "window": "7d",
  "items": [
    {
      "rank": 1,
      "user": {
        "userId": "<publicProfileId>",
        "loopId": "LOOP-XXXXXXXX",
        "alias": "frogmaker",
        "avatar": "avatar:preset/frog"
      },
      "token": {
        "memeTokenId": "<uuid>",
        "symbol": "FROG",
        "logoUrl": "https://…/v2/media/<id>.webp"
      },
      "realizedUsd1": "12.5",
      "observedAt": "2026-10-15T12:00:00.000Z"
    }
  ],
  "observedAt": "2026-10-15T12:00:00.000Z",
  "contractVersion": "2.0"
}
```

- `user.userId` 用**公开资料 ID**（`public_profile_id`），不暴露内部 `loop_users.id`（AGENTS.md：内部 ID 不出边界；公开资料接口也以它为键）。`avatar` 是存储的 avatarRef（`avatar:media/{id}` / `avatar:preset/*`），渲染规则同公开资料。`token.logoUrl` 同列表 `imageUrl` 的绝对地址。`alias` / `avatar` / `logoUrl` 可空。
- 未做：按调用方过滤拉黑关系（榜单是全局缓存结果；被拉黑用户仍可能出现在榜上，点进资料页会按现有规则 404）。

## C. Migration 000083

| 索引                           | 键与覆盖列                                                               | 条件                         | 用途                     |
| ------------------------------ | ------------------------------------------------------------------------ | ---------------------------- | ------------------------ |
| `meme_trades_token_volume_idx` | `(meme_token_id, traded_at) include (usd1_amount)`                       | `not removed`                | 列表 / 详情 24h 成交额   |
| `meme_trades_sell_window_idx`  | `(traded_at) include (wallet, meme_token_id, usd1_amount, token_amount)` | `not removed and not is_buy` | 最佳交易：窗口内卖出     |
| `meme_trades_wallet_buy_idx`   | `(wallet, meme_token_id) include (traded_at, usd1_amount, token_amount)` | `not removed and is_buy`     | 最佳交易：每对的买入成本 |

`down` 删除三个索引。`latestMigrationName` 升到 `000083_meme_list_volume_best_trades_indexes`；`requiredDatabaseRelations` 不列索引，不改。未做规模化 EXPLAIN（测试网数据量小）；量起来后按 0141 的做法补。

## D. 测试

- `test/meme-best-trades-indexes-migration.test.ts`：三个索引的形状与数量；down 删同样三个。
- `test/v2-meme-routes.test.ts`：列表 new / hot / graduating 与详情都带 `createdAt` / `volume24hUsd1` / `holderCount`，`volume24hUsd1` 描述写明不含外盘；`/v2/meme/best-trades` 的完整线形（排名、用户、代币、`realizedUsd1` 十进制、`observedAt`）、7 天窗口参数、5 分钟缓存内不再读库、`window=30d` / `24h` / 多余参数 400、合约未配置 503；OpenAPI 路径清单与 operation 数（192）。
- `test/meme-best-trades.integration.test.ts`（一次性库）：000083 索引存在；24h 成交额边界（恰好 now − 24h 不算、now − 24h + 1s 和 now 都算、removed 不算），列表与详情两条路径一致；最佳交易：均价成本（两次不同价买入后卖出）、两笔卖出合计、窗口外卖出与 removed 卖出不计、只买不卖不列、亏损不列、匿名钱包 / 无公开资料 / 交易记录仅自己可见不列、运营隐藏代币不列、无买入的卖出不列、成本向上取整（raw 级）、`until` 之后的买入不进成本、同一用户两个代币各上榜、降序排序、`limit`、更窄窗口、其他合约为空。
