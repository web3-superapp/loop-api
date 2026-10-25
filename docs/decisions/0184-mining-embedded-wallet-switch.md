# 决策 0184：「只算内置钱包」改为服务端开关，默认关闭（S304-api）

- 状态：已采纳（S304-api），仅 Development / BSC Testnet
- 日期：2026-10-25
- 基线：`42904bd`（integration/v2，已含 S300 / 决策 0183）
- 依据：用户 2026-10-25 裁决。需求方原话「只统计 loop 内部钱包」有歧义，待需求方确认前默认不收窄。
- 修订：决策 0183 的 R3（只算 `account_wallets.kind = 'embedded'`）。0183 的其余规则（R1 只认已验证社区、R2 成员门槛、R4 参数社区校验）不变。
- 范围：新 env `MINING_EMBEDDED_WALLET_ONLY`；结算地址归属与快照余额输入两处查询；结算 `input_summary.walletKinds`。无迁移，不新增 `/v2` 路由或键，App 接口形状不变。

## 歧义

「只统计 loop 内部钱包」至少有两种读法：

1. 只算 LOOP 内置钱包（Privy embedded），用 Reown / WalletConnect 连上的外部钱包不算——决策 0183 按这一读法实现。
2. 只算「在 LOOP 里的钱包」，即账户里登记过的钱包（内置 + 已绑定的外部钱包），未绑定到任何 LOOP 账户的地址不算——这本来就是 0116 起的行为（未归属地址不产生算力）。

两种读法对外部钱包用户的算力差别很大，在需求方确认之前不应默认收窄。

## 规则

| 开关 `MINING_EMBEDDED_WALLET_ONLY` | 钱包口径                                                    | `input_summary.walletKinds` |
| ---------------------------------- | ----------------------------------------------------------- | --------------------------- |
| `false`（默认）                    | 所有 `status = 'active'` 的钱包：内置 + 已绑定外部钱包      | `"all"`                     |
| `true`                             | 只算 `status = 'active' and kind = 'embedded'`（0183 原样） | `"embedded"`                |

- 开关关时与 S300 之前的钱包口径相同（只过滤 `status = 'active'`）。0183 的成员门槛、已验证社区规则在两种模式下都生效：外部钱包持有人同样须是社区成员。
- 布尔严格解析（`true` / `false`，其他值拒绝启动），与其它挖矿开关一致。

## 开关影响的两个查询

1. 结算地址归属：`src/database/mining-settlement-repository.ts` `readSettlementFacts` 的 owners 查询，
   `and ($3::boolean is false or kind = 'embedded')`。开关关时，一个地址若同时作为某人的内置钱包和另一人的外部钱包登记，会出现两个归属人，按 0116 规则记为歧义地址、不归属（`ambiguousAddressCount`）。
2. 快照余额输入：`src/database/mining-repository.ts` `listBalanceInputs`，
   `and ($2::boolean is false or w.kind = 'embedded')`。

## 传递方式

- `src/config.ts`：键放在 API 与 worker 共用的挖矿结算键组（`miningSettlementEnvironmentShape`），解析为 `config.miningSettlement.embeddedWalletOnly`。API（后台回放 / 测试触发结算）与 worker 读同一个键，**两边须设成一样**，否则回放与定时结算口径不同。
- 仓储不读 `process.env`：`readSettlementFacts({ …, embeddedWalletOnly })`、`listBalanceInputs({ includeMockSeedHoldings, embeddedWalletOnly })` 都由调用方显式传入。
- `createMiningSettlementRunner({ …, embeddedWalletOnly })`（必填）：`src/app.ts`、`src/worker-runtime.ts` 从配置传入。
- `createMiningSnapshotWorker({ …, embeddedWalletOnly? })`：可选，缺省 `false`；`src/worker-runtime.ts` 与 `scripts/mining-snapshot.ts` 从配置传入。

## 结算摘要

- 仓储返回的事实集带 `walletKinds: "embedded" | "all"`，`prepareMiningHour` 原样写进 `input_summary.walletKinds`，回放时可据此解释与历史小时的差异。没有该字段的事实集（S304 之前的测试夹具）不写。
- `input_summary.membershipGate` 的值由 `"verified_member_embedded"` 改为 `"verified_member"`（钱包口径不再隐含在这个值里）。
- 计算器与摘要算法（`miningInputDigest`）不变；`walletKinds` 只进摘要说明，不进摘要哈希。

## 何时开

- 需求方确认「内部钱包 = 内置钱包、外部钱包不算」之后，在 API 与 worker 的环境里同时设 `MINING_EMBEDDED_WALLET_ONLY=true` 并重启两个进程。
- 切换只影响切换之后结算的小时与之后的快照；已结算小时不改账本。回放切换前的小时会因口径不同出现 `digestMatches: false`，`input_summary.walletKinds` 可以说明原因。

## 种子脚本

`ops/seed-mock.sh` 中 S300 把 mock 钱包改为 `kind = 'embedded'` 的改动保留：两种模式下 mock 持仓都会计入。

## 测试

- 单测：配置默认值与解析（API / worker）；runner 把开关传给事实读取、摘要记录 `walletKinds`（两种模式）；快照 worker 把开关传给余额读取（缺省 / false / true）。
- 集成：0183 的「外部钱包不归属」「快照只算内置」用例改为两种模式各跑一遍——开 = 0183 原断言；关 = 外部钱包计入（结算侧同地址出现两个归属人，快照侧外部钱包成员计入、非成员仍被门槛挡掉）。
