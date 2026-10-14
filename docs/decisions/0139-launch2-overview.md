# 0139 · 发射台实时流与战绩：`GET /v2/launch2/overview`（S181-api，2026-10-14）

依据：主代理 S181 任务单（2026-10-14）；设计稿 `docs/32-发射台Banner与NFT铸造页设计-2026-10-14.md` §7.1（实时流）与 §7.5（战绩条，设计稿允许把 activity 与 stats 合成 `overview`）；Decision 0114（读模型、阶段推导）、0126 / 0132（外盘成交归属）、0127（回购成交不算市场成交）、0131（LoopDynamic 轮次与领取）。
范围：只在 `loop-api`。不新增迁移、env 或 worker lane；只读已索引的表，不读链。

## 1. 契约

`GET /v2/launch2/overview`。鉴权、headers、`Cache-Control: no-store` 与 `GET /v2/launch2/instances` 相同；无 query（带 query → `400`）；依赖缺失时 `503`，原因同其它 launch2 路由。

```
{
  activity: [{ kind, instanceId, ticker, name, logoUrl, actor, amountUsd1, at, transactionHash }],  // ≤ 30，按 at 倒序
  stats: { liveCount, mintingCount, priorityCount, curveCount, upcomingCount,
           graduatedTotal, graduatedThisWeek, buybackUsd1Total, nftMintedTotal },
  observedAt, contractVersion
}
```

`kind` ∈ `curve_buy | curve_sell | nft_mint | graduated | buyback | round_activated | reward_claimed`。字段名与枚举按任务单原样，App 照此实现。

## 2. 各 kind 的数据来源

可见范围与列表一致：`launch2_instances` 中 `chain_id` = 发射链，且 `activated_at` 不为空或 `hold_reason` 不为空。各分支都排除 `removed` 行（发生过重组的事实）。

| kind                       | 表                                                                 | actor                                                                                            | amountUsd1                                                                                     | at / 哈希                                      |
| -------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `curve_buy` / `curve_sell` | `launch2_trades`（`CurveBought` / `CurveSold`）                    | `trader_address`                                                                                 | 买 = `usd1_gross`（实付，含 10 % 税）；卖 = `usd1_net`（实收）。与持仓 spent / received 同口径 | `traded_at` / `transaction_hash`               |
| `curve_buy` / `curve_sell` | `launch2_pool_swaps`（毕业后官方池的用户成交）                     | `wallet_address`（0126 路由事件 / 0132 `tx.from`）；**未归属 = null**（0132 非 LoopRouter 路径） | 买 = `usd1_amount`（池输入）；卖 = `usd1_amount − tax_amount`（USD1 税 / 动态费）              | `swapped_at` / `transaction_hash`              |
| `nft_mint`                 | `launch2_nft_mints`（`NftMinted`）                                 | `payer_address`                                                                                  | `amount_usd1`（= 100）                                                                         | `minted_at`                                    |
| `graduated`                | `launch2_instances.graduated_at`（lane 对 `Graduated` 的投影）     | null                                                                                             | null                                                                                           | `graduated_at` / `graduation_transaction_hash` |
| `buyback`                  | `launch2_buybacks`，`outcome = 'executed'`                         | null                                                                                             | `usd1_spent`                                                                                   | `executed_at`                                  |
| `round_activated`          | `launch2_dynamic_rounds`（由未删除的 `RoundActivated` 重建的投影） | null                                                                                             | null                                                                                           | `activated_at` / `activated_transaction_hash`  |
| `reward_claimed`           | `launch2_dynamic_claims`（`RewardClaimed`）                        | `buyer_address`                                                                                  | `amount_usd1`                                                                                  | `claimed_at`                                   |

- 外盘成交里排除回购：沿用 0127 的过滤（PoolManager 调用方既不是该实例的回购适配器也不是执行器），**另加**「同一交易里没有 `BuybackCompleted`」。LoopDynamic 的回购经 LoopRouter 进池，调用方是路由，只靠 0127 的过滤排除不掉；这笔回购已经作为 `buyback` 出现过。
- 七类所需的表都存在，没有哪一类因缺表而不出。
- **口径选择（可回退）**：枚举里没有外盘买卖，任务单又明确要求匿名归属（0132）的 `actor` 为 null，而这种情况只会出现在外盘成交上。所以毕业后的官方池用户成交也计入 `curve_buy` / `curve_sell`；不这样做，毕业后的项目在实时流里就看不到任何动静。如果主代理要严格只算内盘，删掉 `activitySql` 里的 `launch2_pool_swaps` 分支即可，App 不用改。

## 3. SQL 形状与耗时

- activity：一条 SQL。CTE `visible` 取可见实例；7 个分支（交易、外盘、铸造、毕业、回购、轮次、领取）各自 `order by <时间> desc, block desc, log desc limit 30` 后 `UNION ALL`，再 join `visible` 取 ticker / name / logo，最后按 `at desc, block desc nulls last, log desc nulls last, kind, hash` 排序取 30 条。服务层用同样的键再排序、截断一次，保持确定性。
- stats：一条 SQL，取可见实例的阶段输入（`nft_sale_start`、`ProjectNFT.saleEnd()` 列（0119）、快照发布时间、毕业时间、hold、零持有人关闭行、`opened_without_holders_at`），以及 `nft_minted_count` 和 `buyback_usd1` 两个投影列。两条 SQL 并发执行。
- 本地测试库 `loop_api_test`（142 个实例，各事实表 5–32 行）：`EXPLAIN ANALYZE` 显示 activity 执行 0.67 ms（规划 0.70 ms），stats 执行 0.31 ms；整个读取（两条并发）连跑 200 次，p50 2.2 ms、p95 5.1 ms、最大 11 ms。目标 < 100 ms 满足。
- 规模化后需要的索引留给下一批（本批不加迁移）。目前每个分支都是先全表扫描再取 top-N 排序。数据量上来后，建议各加一个按时间倒序的部分索引：`launch2_trades (traded_at desc) where not removed`、`launch2_pool_swaps (swapped_at desc) where not removed`、`launch2_nft_mints (minted_at desc) where not removed`、`launch2_buybacks (executed_at desc) where not removed and outcome = 'executed'`、`launch2_dynamic_claims (claimed_at desc) where not removed`、`launch2_dynamic_rounds (activated_at desc)`。外盘分支「同交易无回购」的反查走 `launch2_buybacks` 主键 `(chain_id, transaction_hash, …)` 的前缀，不需要新索引。

## 4. stats 口径

- 阶段计数与列表用**同一个**推导：新增 `deriveLaunch2StageOf(facts, nowSeconds)`（`launch2-stage.ts`），列表 / 详情原来的 `stageOf` 改为调用它，overview 也调用它，没有另写一套。映射：`mintingCount` = `nft_sale`，`priorityCount` = `priority`，`curveCount` = `public`，`upcomingCount` = `upcoming`，`graduatedTotal` = `graduated`，`liveCount` = `nft_sale + priority + public`。`snapshot_pending`、`paused`、`closed_no_holders` 不计入任何计数。
- `graduatedThisWeek`：推导阶段为 `graduated`，且 `graduatedAt` ≥ 服务器 UTC 本周一 00:00（`launch2WeekStart`，边界取闭区间）。
- `buybackUsd1Total` = Σ `launch2_instances.buyback_usd1`（lane 对已执行回购的投影），十进制字符串。`nftMintedTotal` = Σ `nft_minted_count`。

## 5. 测试

- 单测 `test/v2-launch2-overview.test.ts`（7 条）：空库返回全零计数和空数组，键集合与 schema 一致，`no-store`；七种 kind 各一条，金额格式化正确，匿名外盘成交与平台动作的 `actor` 为 null；倒序排序，同秒按区块 / 日志序，空区块排最后，最多 30 条；各阶段计数（存库的阶段过期时以推导为准，hold / 未激活的不计入），本周边界（周一 00:00 那一刻算本周，早 1 秒不算）；`launch2WeekStart` 的边界；未配置时返回 503；带 query 返回 400。
- 集成 `test/launch2-overview.integration.test.ts`：在真库里每张表各插一行事实，另插一笔与回购同交易的池成交（应被排除）、一笔已删除的铸造（不应出现），读出后核对顺序、kind、actor、金额和哈希；并核对 stats 的增量（毕业 +1、本周毕业 +1、铸造 +1、回购 +125）。哈希与时间每次运行都不同（墙钟秒 × 100），持久库上连跑两次都能过。
- 顺带修复：`test/launch2-dynamic.integration.test.ts` 原来用确定性的交易哈希，持久库第二次跑时事实落到上一轮的行上，`dynamicPool` 为 null。现在哈希前缀加了每次运行唯一的 8 位 hex，连跑两次都通过。
