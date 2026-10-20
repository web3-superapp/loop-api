# 0167 · 钱包交易历史合并 Launch 链 MEME v2 活动（S251-api，2026-10-20）

## 1. Status

已实现（分支 `feat/S251-wallet-activity-launch2`，基线 `integration/v2` `ab9f70d`）。**只读**：无迁移、无新表、无写路径、无新路径、无新错误码。新增 env `WALLET_ACTIVITY_LAUNCH2_EMIT`（`off|on`，默认 `off`，其他值拒绝启动）。OpenAPI 变化：`GET /v2/wallets/{walletId}/activity` 的 `items[]` 变为两种行形状的 `anyOf`，根对象多一个**可选**键 `launch2`。

## 2. Context

- `GET /v2/wallets/{walletId}/activity` 只列主网（chain 56）Asset Registry 资产的 ERC-20 转账（`erc20_transfer` 车道）。staging / 测试阶段所有 MEME v2（launch2）活动都在 Launch 链（BSC Testnet 97），演示账号「晚风」（S221W / S227W 有买卖）的交易历史因此为空，需求方验收看不到记录。
- launch2 读模型（决策 0114 起的 `launch2_*` 事实表）已经有该钱包的全部成交 / 铸造 / 领奖 / 回购事实，无需再上链读。
- 决策 0166 §D：已发布 App 的 V2 解码器严格拒绝未知键（`LoopV2Contract.strictMap`），给既有响应加键必须先在 App codec 落可选键并发版，服务端在此之前用默认 `off` 的开关关掉新键。

## 3. Decision

### A. 开关 `WALLET_ACTIVITY_LAUNCH2_EMIT`（默认 `off`）

- `off`（或未设置）：路由与 `ab9f70d` **逐字节同形**——同样的行、同样的键序、同样的 `(blockNumber, logIndex)` 游标；不读任何 launch2 表、不读 Launch 链 head。测试 `keeps the activity bytes and cursor of before` 用从 `ab9f70d` 捕获的响应体逐字节比对（只遮蔽随机的 `nextCursor` 与 `freshness.observedAt`）。
- `on`：合并该钱包在 Launch 链（`LAUNCH_CHAIN_ID` 对应的 `eip155:97`，主网 Launch 时为 `eip155:56`）上的 launch2 事实，按时间与转账行混排，根对象加 `launch2` 块，换用合并游标（§D）。
- 配置：`config.walletActivityLaunch2Emit` → `createWalletReadService({ launch2ActivityMerge: { chainId: config.launchChain.chainId, repository: database.walletActivityMerge } })`；`off` 时该入参为 `null`，`getActivity` 走原代码路径。

### B. 实体与匹配（钱包地址只作链上事实匹配，不作主键）

`walletId` 先按原规则校验归属（`requireWallet`），再取其地址到 launch2 表里匹配（只取 `not removed`；含隐藏 listing 的实例——持有人看自己的历史，同决策 0163 §3.2 对 `me/positions` 的处理）：

| kind                   | 来源表                              | 匹配                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch2_curve_buy`    | `launch2_trades` side=buy           | `trader_address`                                                                                                                                                                                                                                                                                                                       |
| `launch2_curve_sell`   | `launch2_trades` side=sell          | `trader_address`                                                                                                                                                                                                                                                                                                                       |
| `launch2_pool_buy`     | `launch2_pool_swaps` side=buy       | 用户成交（决策 0127 / 0158 过滤：非 buyback adapter / executor、同交易无 buyback）且 `wallet_address`（决策 0126 / 0132 归属）或 `recipient_address` 为该地址；**或**同交易 Hook 把买入权重记给该地址（`launch2_dynamic_credit_entries` `in`，attribution ≠ `moved`，含 S200 / loop-contracts 0014 的 `delivery` 交割归属，决策 0146） |
| `launch2_pool_sell`    | `launch2_pool_swaps` side=sell      | 同上的用户成交过滤，`wallet_address` 或 `recipient_address`                                                                                                                                                                                                                                                                            |
| `launch2_nft_mint`     | `launch2_nft_mints`                 | `payer_address`                                                                                                                                                                                                                                                                                                                        |
| `launch2_reward_claim` | `launch2_dynamic_claims`            | `buyer_address`                                                                                                                                                                                                                                                                                                                        |
| `launch2_buyback`      | `launch2_buybacks` outcome=executed | 实例的 `buyback_recipient`（回购收币地址，例如 M5）                                                                                                                                                                                                                                                                                    |

金额（18 位小数，人类可读十进制字符串，同 `/v2/launch2/*`；无该金额为 `null`）：

| kind         | amountMeme                                          | amountUsd1                                                    | taxUsd1                       |
| ------------ | --------------------------------------------------- | ------------------------------------------------------------- | ----------------------------- |
| curve_buy    | 曲线买入量                                          | 实付（含税，`usd1_gross`）                                    | `tax_usd1`                    |
| curve_sell   | 曲线卖出量                                          | 实收（`usd1_net`）                                            | `tax_usd1`                    |
| pool_buy     | 实收 MEME（router `amountOut`，否则毛额 − MEME 税） | 实付 USD1（router `amountIn`，否则池子 USD1 输入）            | 税币为 USD1 时的税，否则 null |
| pool_sell    | 实付 MEME（router `amountIn`，否则池子 MEME 输入）  | 实收 USD1（router `amountOut`，否则池子 USD1 输出 − USD1 税） | 同上                          |
| nft_mint     | null                                                | 铸造价                                                        | null                          |
| reward_claim | null                                                | 领取额                                                        | null                          |
| buyback      | 交付的 MEME                                         | 花费的 USD1                                                   | null                          |

数据来源：新只读仓储 `src/database/wallet-activity-merge-repository.ts`（`Database.walletActivityMerge`），不扩大既有 `BscIndexerRepository` / `Launch2Repository` 端口。launch2 一条 SQL：每个事实表一个分支（各自按游标过滤并 `limit n+1`），外层合并排序再 `limit n+1`。

### C. `/v2` 新增键清单（给 loop-mobile）

**根对象**（只在 `on` 时出现）：

| 键        | 形状                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch2` | `{status:"available", chainId, indexerBlockNumber, headBlockNumber}`（四键，`headBlockNumber` 可为 null）或 `{status:"unavailable", reasonCode}`（两键） |

`launch2.reasonCode`：`LAUNCH2_INDEXER_NOT_STARTED`（该链 `launch2_event` 车道从未运行）、`LAUNCH2_ACTIVITY_READ_FAILED`（launch2 读失败，记 warn 日志）。unavailable 时本页只有转账行，**不是**整页失败。

**新行**（同一 `items` 数组，只在 `on` 时出现；有 `kind` 键即为新行，旧转账行**没有** `kind`）——14 个键，全部必带：

| 键                | 类型                   | 说明                                                     |
| ----------------- | ---------------------- | -------------------------------------------------------- |
| `kind`            | string enum            | 上表七种                                                 |
| `chainId`         | string（CAIP-2）       | `eip155:97`（主网 Launch 时 `eip155:56`）                |
| `instanceId`      | string（opaque UUID）  | 打开 `/v2/launch2/instances/{instanceId}`                |
| `ticker`          | string                 | 1–80 字（UTF-8，决策 0164）                              |
| `name`            | string                 | 1–64 字                                                  |
| `logoUrl`         | string \| null         |                                                          |
| `amountMeme`      | decimal string \| null | 见 §B                                                    |
| `amountUsd1`      | decimal string \| null | 见 §B                                                    |
| `taxUsd1`         | decimal string \| null | 见 §B                                                    |
| `transactionHash` | string                 | 沿用旧行同名键（任务单写的 `txHash` 即此键，未另起新名） |
| `logIndex`        | integer                | 沿用旧行同名键                                           |
| `blockNumber`     | string                 | 沿用旧行同名键                                           |
| `occurredAt`      | ISO date-time          | 事实的区块时间                                           |
| `confirmations`   | integer \| null        | 按 Launch 链 head 计；head 读失败为 null                 |

旧转账行的 14 个键、键序与语义**完全不变**（没有 `kind` / `chainId`，仍为主网）。

### D. 合并排序与游标

- 全序（新→旧）：`(occurredAt µs, blockNumber, logIndex, source, transactionHash)` 降序。`source` 只有 `erc20` / `launch2` 两个值，只用于跨链极端并列时保持全序。
- 时间：launch2 行 = 区块时间；转账行 = `indexed_transfers.observed_at`（该表无区块时间，车道观测时间；实时同步时与区块时间相差秒级，回填批次内同批行按插入顺序递增，块号作并列裁决）。
- 比任务单的 `(occurredAt, txHash, logIndex)` 多了 `blockNumber` 作第二键：同一秒内同链多笔，`txHash` 不代表先后，块号才代表。
- 游标 continuation：`{at(微秒整数字符串), block, log, src, tx, limit}`；filter 为 `wallet=<id>;launch2=<chainId>`。**与 `off` 时的旧游标互不通用**：任一方向错用都是 `400 INVALID_REQUEST`（客户端按既有规则从 `limit` 重拉第一页）。旧行在新游标下不是同一顺序（旧游标按块号、新游标按观测时间），因此不能等价复用——这是开关切换的唯一可见副作用。
- 微秒：`observed_at` 是微秒精度而 ISO 只到毫秒，游标存 `extract(epoch)*1e6` 的精确整数，SQL 侧用 `timestamptz 'epoch' + n * interval '1 microsecond'` 还原，不经浮点。
- 每源各取游标之后最新 `n+1` 行，内存合并取前 `n` 行；任一源有更多或合并溢出即有下一页。服务端另做一次防御检查：本页任何行不得不早于游标（否则 503，防止合并错误导致翻页死循环）。

### E. unavailable / 错误

| 情况（`on`）                                  | 行为                                                              |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `erc20_transfer` 车道无 checkpoint            | `503 INDEXING_DELAYED`（同 `off`，不变）                          |
| 合并仓储未组装（无数据库）                    | `503 CAPABILITY_UNAVAILABLE`（fail closed，不回退旧列表）         |
| `launch2_event` 车道在 Launch 链无 checkpoint | `200`，`launch2: unavailable LAUNCH2_INDEXER_NOT_STARTED`         |
| launch2 checkpoint / 事实读失败               | `200`，`launch2: unavailable LAUNCH2_ACTIVITY_READ_FAILED`        |
| Launch 链 head 读失败 / 无该链读客户端        | launch2 行 `confirmations: null`，`launch2.headBlockNumber: null` |

无新错误码；`nativeTransfers` / `crossChain` 两块原样保留。

### F. 对 loop-mobile 的 codec 要求与开启顺序

1. `loop-mobile/lib/integrations/backend/v2/wallet/loop_v2_wallet_api.dart` 的 `getActivity`：根对象从 7 键 `strictMap` 改为 `strictMapWithOptional`，可选键 `launch2`（两种形态都接受）；`items[]` 逐行：**有 `kind` 键**按 §C 的 14 键严格解码为 launch2 行，**否则**按原 14 键解码为转账行；未知 `kind` 值建议跳过该行而非整页失败（以后加 kind 不再破坏）。
2. 键缺省时行为不变：没有 `launch2`、没有带 `kind` 的行时，页面与今天一致。
3. 游标仍是不透明字符串，客户端无需区分新旧；遇 `400` 从第一页重拉（已是既有规则）。
4. **开启顺序**：上述 codec 随 build 32 发布 → 所有仍受支持的已发布版本都 ≥ 32 → 再在目标环境把 `WALLET_ACTIVITY_LAUNCH2_EMIT` 切到 `on`。在此之前 staging / 生产保持 `off`。

## 4. Consequences

- `on` 后「晚风」类账号的交易历史能看到 Launch 链上的 NFT 铸造、曲线买卖、外盘买卖、领奖；回购收币地址能看到回购交付。
- 开关切换会使客户端手里的旧游标失效一次（400 → 重拉第一页）。
- `on` 下转账行按观测时间排序，回填（backfill）产生的历史转账会排在其观测时刻，而非其区块时刻；实时同步的行不受影响。
- 测试：`test/wallet-activity-launch2.test.ts`（排序、页合并、行投影单测）；`test/v2-chain-wallet-routes.test.ts` 的 `Decision 0167` 组（`off` / 未设置逐字节快照与旧游标、混排顺序与键集、逐行翻页无重无漏、游标跨模式 400、launch2 leg 三种 unavailable、缺仓储 503 与 INDEXING_DELAYED、Launch head 不可读）；`test/config.test.ts`（默认值与非法值）；`test/wallet-activity-merge.integration.test.ts`（真实 PostgreSQL：两个实例上铸造 / 曲线买卖 / LoopRouter 与 router 外盘买卖 / delivery 交割归属买入 / 领奖 / 回购 + 主网转账，页大小 1、2、3、4、12、50 都走出同一 12 行顺序；微秒并列；他人钱包互不可见；removed 与回购交易内 swap 被排除）。
