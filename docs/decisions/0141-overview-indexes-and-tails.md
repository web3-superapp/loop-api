# 0141 · overview 事实表索引、按工厂核验回购 keeper、control-plane 偶发与日志轮转（S185-api，2026-10-14）

依据：主代理 S185-api 任务单（2026-10-14）；Decision 0139 §3（overview 规模化索引留给下一批）、0121（回购 keeper）、0133 §6（混合部署的两条运维注意）、0135（control-plane 租约偶发未修）。
范围：只在 `loop-api`。新增 migration `000082_launch2_overview_indexes`；回购 keeper 的工厂核验；一处集成测试的迁移步数修正。不改 HTTP 合同（OpenAPI 无变化）、不改 `ops/`、不重启 launchd。

## A. overview 事实表索引（migration 000082）

按 0139 §3 原样建六个按时间倒序的部分索引（列名已逐一核对 000061 / 000068 / 000076）：

| 索引                                  | 表与键                                       | 条件                                         |
| ------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| `launch2_trades_overview_idx`         | `launch2_trades (traded_at desc)`            | `where not removed`                          |
| `launch2_pool_swaps_overview_idx`     | `launch2_pool_swaps (swapped_at desc)`       | `where not removed`                          |
| `launch2_nft_mints_overview_idx`      | `launch2_nft_mints (minted_at desc)`         | `where not removed`                          |
| `launch2_buybacks_overview_idx`       | `launch2_buybacks (executed_at desc)`        | `where not removed and outcome = 'executed'` |
| `launch2_dynamic_claims_overview_idx` | `launch2_dynamic_claims (claimed_at desc)`   | `where not removed`                          |
| `launch2_dynamic_rounds_overview_idx` | `launch2_dynamic_rounds (activated_at desc)` | 无（投影表没有 `removed`）                   |

- 命名用 `_overview_idx`：000068 已有 `launch2_pool_swaps_recent_idx`（`(instance_id, swapped_at)`），`_recent_idx` 会撞名（第一次 `db:migrate:test` 就是这样失败的，事务回滚，无残留）。
- `down` 删除这六个索引，不加数据保护。`latestMigrationName` 升到 `000082_launch2_overview_indexes`；`requiredDatabaseRelations` 只列表 / 视图，不列索引，不用改。
- 外盘分支「同交易无回购」的反查仍走 `launch2_buybacks_pkey` 前缀，不需要新索引（与 0139 一致）。

**EXPLAIN ANALYZE**（共享测试库 `loop_api_test`，一个事务内按现有行复制出合成数据再 `analyze`，最后 `rollback`，库内数据不变）：trades 4 万、swaps 10 万、mints 4 万、buybacks 6 万、claims 5 万、rounds 4 万行，`chain_id = 'eip155:97'`、`limit 30`，SQL 取自 `launch2-repository.ts` 的 `activitySql` 原文。

- 有索引：六个事实分支全部是 `Index Scan using launch2_*_overview_idx` → `Incremental Sort`（同一秒内再按区块 / 日志排序，`Full-sort Groups: 1`）→ `Limit 30`，每个分支只读约 31–62 行；毕业分支来自 `launch2_instances`（实例数级别，不需要索引）。**执行 8.9 ms**（规划 6.1 ms）。
- 同一事务里先删掉这六个索引作对照：六个分支都是 `Seq Scan`（swaps 走 `Parallel Seq Scan`）再 top-N 排序，**执行 157 ms**。
- 结论：索引按预期被各分支使用。索引键只含时间列，同秒内的区块 / 日志序靠 Incremental Sort，每组很小，没有必要把区块 / 日志列也放进索引。

## B. 混合部署时按实例所属工厂核验 keeper（0133 §6 注意 ①）

原状：两种工厂都配时，回购 keeper 只在启动时按 OfficialTax 工厂的 `primaryKeeper()` / `fallbackKeeper()` 核验；key 只在 LoopDynamic 工厂登记时整个 lane 拒绝启动，key 只在 OfficialTax 登记时 LoopDynamic 实例只能在 executor 层面被拒。

改法：

- 配置 `Launch2BuybackKeeperConfig` 新增 `factoryAddresses`：OfficialTax 工厂（地址合法时）在前，完整的 LoopDynamic 对在后，去重、小写。`factoryAddress`（首选工厂，0133 的选择规则）保留，日志字段不变。
- policy 新增可选 `factoryAddresses`（缺省 `[factoryAddress]`，旧调用方与 anvil 套件不变）。
- `verifyKeeper()`：逐个读取已配置工厂的 keeper，key 是**至少一个**工厂的 primary / fallback 即 `ok`，都不是才 `not_keeper`（启动拒绝，reason 不变 `LAUNCH2_BUYBACK_KEEPER_NOT_AUTHORIZED`）。每次调用都重新读取。
- 候选新增 `factoryAddress`（`launch2_instances.factory_address`）。`start()` 在读取 executor 之前先检查「key 是否为该实例所属工厂的 keeper」，否则等待原因为 `LAUNCH2_BUYBACK_NOT_KEEPER`（与 executor 层的拒绝同码，不写 attempt 行、不模拟）。工厂 keeper 的读取结果按工厂缓存（启动时读入；未配置的工厂——例如 legacy 工厂的实例——第一次遇到时读一次）。
- 两工厂 keeper 相同时：启动读两次工厂（原来一次），其余行为不变。无新 reason code、无 HTTP 变化。

测试（`test/launch2-buyback-keeper.test.ts` 新增 5 条）：两工厂不同 keeper，key 只在 LoopDynamic 登记 / 只在 OfficialTax 登记两种情况各自启动通过，本工厂的实例执行到 `broadcast`，另一工厂的实例等待 `LAUNCH2_BUYBACK_NOT_KEEPER` 且不读 executor、不模拟、不写行，工厂 keeper 只在启动时读取；两工厂同一 keeper 时两边实例都执行；两工厂都不认这个 key 时启动 `not_keeper`；未配置的 legacy 工厂实例按该工厂自己的 keeper 核验。`test/launch2-dynamic-only.test.ts` 补 `factoryAddresses` 的两种配置；`test/worker-runtime.test.ts` 断言 policy 带上 `factoryAddresses`。

**水龙头 USD1 来源（注意 ②）**：已确认保持现状不改。两对都配时水龙头仍从 OfficialTax 工厂读 USD1；两工厂 USD1 不同时需显式设 `TESTNET_FAUCET_USD1_ADDRESS`。

## C. control-plane 租约偶发：本批未复现

- 跑法：worktree 内 `node --import tsx scripts/run-integration-tests.ts test/control-plane-repository.integration.test.ts`（`DATABASE_URL_TEST` 取主检出 `.env.local`，库 `loop_api_test`，迁移头 000082），顺序连跑 5 次。
- 当时负载：`uptime` load averages 30.93 / 40.35 / 47.90。
- 结果：5 次全部通过（每次 20/20，耗时 9.0–11.6 s）。
- 处置：没有失败输出，不做猜测性修改（与 0135 的结论一致：租约到期判断用库内 `clock_timestamp()`）。下次在门禁里出现时，请把整段失败输出（用例名、断言、期望 / 实际值）贴回来，再按「可注入时钟 / 『不早于』语义」定修法。

## D. 日志轮转（只调查，未改 ops）

- **已生效**。`~/Library/LaunchAgents/com.loop.log-rotate.plist` 已加载（`launchctl print`：`runs = 3`，`last exit code = 0`），每天 04:10 运行且 `RunAtLoad`，执行 `~/Library/Application Support/LOOP/log-rotate.sh`；该文件与 `ops/log-rotate.sh` 内容一致（`diff` 无差异）。没有 crontab。
- 规则：`api.log`、`worker.log`、`tunnel.log`、`admin-dev.log`、`emulator.log` 超过 20 MB 时 copy-truncate 后 gzip，保留 7 份。2026-10-12 22:05 已轮转过一次（`api.log.20261012-2205.gz` 2.96 MB、`worker.log.20261012-2205.gz` 0.65 MB）。
- 当前大小（2026-10-14 23:08）：`api.log` 2.66 MB、`worker.log` 1.30 MB、`tunnel.log` 4.87 MB，均远低于 20 MB 阈值。
- 建议（不急）：① copy-truncate 在 `cp` 与截断之间写入的行会丢，开发机可接受；② 脚本不覆盖 `emulator-*.log`、`emulator-build-*.log`、`*-watchdog.log` 与 `protocol-*` 目录，它们目前都很小（KB 级），如需清理可在脚本里加通配；③ launchd 的 `StandardOutPath` 以追加方式打开，截断后不会出现空洞文件，无需重启服务。

## E. 其他

- `test/launch2-campaigns.integration.test.ts` 的「down 一步再 up」假定 000081 是迁移头，000082 加入后失败；改为 down 掉 000081 及之后的全部迁移（按目录计数），以后再加迁移也不会坏。该用例在一次性库里跑，不影响共享测试库。
- 共享测试库：本批开始时在 000080，先 `db:migrate:test` 升到 000082（含 000081）跑集成，结束时 down 两步回到 000080。

## F. 测试与门禁

- 单测新增 `test/launch2-overview-indexes-migration.test.ts`（2 条：六个索引的形状与数量；down 删同样六个）；各「最新迁移」断言改为 000082。
- 门禁结果见 S185-api 回报。
