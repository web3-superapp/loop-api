# 决策 0196：挖矿事实补收毕业后持有人地址（S341-api，主代理决策 0269）

- 状态：已采纳（S341-api），缺陷修复，仅 Development / BSC Testnet
- 日期：2026-11-02
- 基线：`28c2cb9`（integration/v2，= staging 现版本）
- 依据：主代理 docs/52 §十四（S338）排查——LOOP-18XDDK7J 的内置钱包在 13:34 UTC 收到 1,000,000 猫猫（已毕业，绑定 verified 社区「dad」，账号 13:31 已入群），此后快照与结算都没有算力行。
- 编号说明：0194 已被 S339-api（NFT 发送意图）占用，0195 留给并行的 S340-api，本决策取 0196。

## 1. 根因（已核实）

- `readSettlementFacts`（`src/database/mining-settlement-repository.ts`）先拼一个「待查归属地址」集合，再按它查 `account_wallets` 得到 `walletOwners`。集合只收 NFT Transfer 的期初 / 变动、`asset.openingBalances` / `asset.moves`（曲线成交或 v1 成交）、`asset.unknownHolders`，**漏了 `asset.postGraduation.openingBalances` / `asset.postGraduation.moves`**（决策 0125 的毕业后 ERC-20 余额）。
- 运行器（`prepareMiningHour`）对毕业后持仓逐地址 `ownerOf.get(address)`，找不到就记 `unattributedHoldingCount` 并跳过。
- 5 分钟快照的矿池部分（`mining-snapshot-worker.ts` `readPool`）与每小时结算 / 重放共用这个函数，所以三处同时漏算。
- 受影响人群：已毕业 MEME 上**从没在曲线上交易过**、只靠毕业后转账或外盘（池子）买入拿到币的地址。曲线上买过的地址此前碰巧被曲线行带进集合，所以「毕业前后混合持有」不受影响。

## 2. 修复

- 地址集合追加 `postGraduation.openingBalances[].address` 与 `postGraduation.moves[].address`。只多查归属，不改任何余额、权重、门槛、开关。
- 归属仍走原有过滤：`status = 'active'`、`first_seen_at < hourEnd`、`MINING_EMBEDDED_WALLET_ONLY` 时只认 `embedded`；成员门槛（决策 0183）照旧在运行器里按 verified 绑定社区的入群区间截断。非成员、外部钱包（开关开时）、未绑定账号的地址（池子、曲线、交易所）依旧不计，只计入 `unattributedHoldingCount`。

## 3. 其他来源排查（同函数及调用方）

| 来源                          | 结论                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 外盘 Hook / PoolManager 成交  | 索引器把实例 MEME 的**全部** `Transfer` 写进 `launch2_meme_transfers`（不按对手方过滤），外盘买入是 PoolManager → 买家的转账，已在 `postGraduation` 内，本修复一并覆盖。 |
| `erc20` 外部代币（决策 0189） | 持有人由成员钱包反查得出，`openingBalances` / `moves` / `unknownHolders` 都已入集合，无漏。                                                                              |
| `meme_v1`                     | 只有成交行，已入集合；毕业后无 `postGraduation`（按 0126 记 `assetGraduatedBalancePending`），非本缺陷。                                                                 |
| NFT                           | 期初与区间内 Transfer 的 from/to 都已入集合。                                                                                                                            |
| 曲线阶段（未毕业）收到转账    | 决策 0123 口径本就只算曲线净买入，转账不计——这是口径，不是漏收，本批不改。                                                                                               |

## 4. 错误码与 unavailable

无新增错误码、无新接口、无新键。`MiningSettlementInputError`（如 negative MEME balance）行为不变。

## 5. 对已结算小时的影响

- 已结算小时不可变（§9-13），本修复不改写任何 epoch / reward 行。
- 管理端 `GET /admin/v1/mining/epochs/{epochId}/replay` 是按**当前**规则重读事实：修复前结算、且该小时存在「毕业后才持有的成员内置钱包」的 epoch，重放会得到 `digestMatches: false` / `rewardsMatch: false`（多出的归属行）。这是预期差异，不是数据损坏。
- 是否补发由主代理决定；见交付汇报中的建议。

## 6. 测试

- `test/mining-post-graduation-holders.integration.test.ts`（独立临时库 `loop_s341_*`）：已毕业 MEME，成员内置钱包只在毕业后收到转账 + 小时内外盘买入，从未曲线交易。修复前三条用例全红（地址不在 `walletOwners`、快照无行、结算无行）；修复后：快照 1500、结算按时间加权 1375；曲线 + 毕业后混合 400、NFT 3、非成员 0、外部钱包（embedded-only）0；开关关时外部钱包 200；`unattributedHoldingCount = 4`（曲线、池子、外部来源、外部钱包）；重放 digest / rewards 一致。
