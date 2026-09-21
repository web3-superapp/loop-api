# 前端联调：V2 Mining（S7 骨架 + S20 开发基线 + S22a 走查修正）与邀请关系

本文是 `mining` 与 `referral` 两个模块（决策 0036、0043）的前端交接契约。权威机器契约为
`openapi/loop-api.v2.json`。通用规则沿用 `docs/frontend-v2-session-api.md` 与
`docs/api-v2-conventions.md`。Base URL 与 headers 同其它 V2 模块：所有请求带
`Authorization: Bearer <Privy access token>`、`X-Loop-Contract-Version: 2.0`、
`X-Loop-Client-Version`；本模块全部为 `GET`，禁止带 `Idempotency-Key`；响应 `Cache-Control: no-store`。

覆盖页面：`mining`、`mining-assets`、`mining-rewards`、`mining-rank`、`mining-community`、
`mining-rules`、`referral`，以及社区详情/成员/关注列表上的 `miningPower`。

## 0. 本步的硬前提（S20，决策 0043）

**产品公式仍未冻结**（03 §19；`miningFormulaV1-draft` 仍是 `pending_approval`）。S20 新增了一个
**自我描述的开发基线版本** `miningFormula-devBaseline-2026-09-15-r3`（`scope: "development_baseline"`；r1 因缺 `priceProxies` 已退休，见决策 0044；r2 因缺 `referencePricing` 被 r3 取代，见决策 0059），
只在 Development 环境由运维脚本批准；它让页面能算出数，**不代表数是产品口径**：

- 每个已登记资产权重 `1`（算力 = 持仓的美元价值）；
- 社区权重区间 `[0.5, 2]`，只能由运维脚本落值；
- 日产出预算 `1000000`，`budgetStatus: "development_placeholder"`，单位 key
  `mining.rules.dailyOutput.unit.loopTokenPending`（LOOP 奖励代币合约未定）；
- 原生 BNB 的参考价来自版本声明的代理 WBNB（`priceProxies`），每一行都标 `referencePriceQuality: "proxied"`
  并给出代理资产（决策 0044）；
- USDT 的参考价来自版本声明的稳定币规则（`referencePricing`，peg `1` ± 200bps），行标
  `referencePriceQuality: "derived"` 并给出来源交易对（决策 0059，见 §0.1）。

**前端必须**：凡 `scope === "development_baseline"` 或 `budgetStatus === "development_placeholder"`
的数字，一律加"开发基线（configVersion）"标签，不得表述为收益或承诺；`claimable`/`accumulated` 恒为
`REWARD_AUTHORITY_PENDING`，领取按钮不可执行。

**S22a（决策 0046）对本契约的三处加法**（都是加字段/加码，不改路径、不删字段）：

1. 邀请加成槽位有了自己的码 `MINING_REFERRAL_BOOST_PENDING`（`summary.referralBoost` 与 `GET /v2/referral.boost`）。
   `MINING_FORMULA_BASELINE_PENDING` 从此**只**表示"没有生效的公式版本"；有生效版本时任何槽位都不会再发它。
2. `GET /v2/mining/assets` 的 `included[]`/`excluded[]` 每行多了必填 `symbol`（Registry 的链上 `symbol()`，
   native 行是 `BNB`；仅在 Registry 没有该资产行时为 `null`）；`assets` 与 `rank` 响应顶层多了 `formula`，
   与 `summary.formula` **同一形状同一来源**，用它的 `scope` 打"开发基线"戳。
3. 未绑定资产的社区，`weight` 块改为 `COMMUNITY_ASSET_NOT_BOUND` + `reviewStatus: "not_applicable"`
   （原来错误地说成 `COMMUNITY_WEIGHT_PENDING_REVIEW` / `pending_review`）；`reviewStatus` 枚举现为
   `pending_review | not_applicable`，与 reasonCode 一一对应。

**S51（决策 0057）对本契约的加法——"持仓读不到" ≠ "0"**（只加字段、加码，不改路径、不删字段）：

1. **一次快照里任何一个有正持仓的计权资产读不到参考价，这次快照不发布**（服务端记为 `incomplete` 尝试，
   不写任何算力行）。所有读接口继续返回**上一次完整快照**的数字，并在 `snapshot`（`assets` 是 `source`）
   上带 `stale: true` 与 `latestAttempt`；没有任何完整快照时，所有数字块是 `MINING_SNAPSHOT_INCOMPLETE`。
   **客户端口径：`power` 为 `{status: "available", value: "0"}` 只可能是链上观测到的 0 持仓；读失败永远是
   `unavailable`，绝不显示 0。**
2. `snapshot` / `source` 的 `available` 分支多了两个字段（服务端总是给，schema 里为可选以兼容旧客户端）：
   `stale: boolean`、`latestAttempt: {snapshotId, status: "complete"|"incomplete"|"invalidated", computedAt,
reasonCode: string|null, unreadInputs: [{assetId, reasonCode}]}`。`stale: true` 时页面必须标"数据截至
   `snapshot.computedAt`；最近一次计算（`latestAttempt.computedAt`）未完成：`unreadInputs[].assetId` 读不到价格"。
   `unavailable` 分支可能多一个可选的 `latestAttempt`（同形），解释为什么没有快照。
3. 社区侧 `miningPower` 两个 `available` 分支多了 `stale: boolean`（同义）。
4. 新 reasonCode：`MINING_SNAPSHOT_INCOMPLETE`（生效版本只有未完成尝试、没有完整快照）、
   `MINING_SNAPSHOT_PENDING`（本账号有激活钱包，但还没有任何完整快照包含它——文案"下一次快照后显示"）、
   `MINING_PRICE_PAIR_NOT_FOUND`（Provider 给了新鲜事实，但没有一个以该资产为 base 的交易对；2026-09-20 USDT 的实际情况）、
   `MINING_SNAPSHOT_PUBLISHED_INCOMPLETE`（只出现在 `latestAttempt.reasonCode`：运维作废了一个旧写法发布的、
   缺持仓的快照）。`MINING_ACCOUNT_NOT_IN_SNAPSHOT` 从此**只**表示"没有激活钱包"。
5. **没进过快照的钱包（新注册账号）四个读接口都是 200**：`power`/`estimatedToday`/`totalPower`/`myPosition`/
   `myContribution` 为 `unavailable(MINING_SNAPSHOT_PENDING)`，`networkPower` 与榜单照常。任何 `503
CAPABILITY_UNAVAILABLE` 都不是"账号没数据"，而是仓储/Registry 不可用。

2026-09-15 Development 实跑事实（可复核）：`miningFormula-devBaseline-2026-09-15-r2` 已批准
（`effectiveAt 2026-09-15T14:57:37.026Z`，r1 同时退休）；两个已 verified 社区经产品写路径
（`updateCommunity`，即 `PUT /v2/communities/{id}` 的命令）绑定资产并落权重：`mock-defi-morning → Cake`
权重 `0.8`，`builders-guild → USDT` 权重 `1.5`（`0.49`/`2.01` 被拒，`0.5`/`2` 接受）；快照
`0e358b31-e49f-48b9-89b2-c5c908c3ad5e` @ block `122037728`，`priceVersion dexscreener:2026-09-15T14:58:51.862Z`，
8 行算力（2 个钱包 × Cake/USDT/WBNB/BNB），**全部为 0**——两只开发钱包在 BSC 主网上持仓为零，这是真实读数。
BNB 行 `referencePriceQuality: "proxied"`、代理 WBNB、`713.42`。要看到非零数字需要真实持仓，后端不会造
（`wallet_balance_snapshots` 没有来源字段，写一行等于伪造链上观测）。

## 0.1 S51c（决策 0059）：`referencePriceQuality: "derived"` —— 一个**可能的破坏性变更**

**背景**：DexScreener 自 2026-09-18 起对 BSC USDT 只返回 USDT 作 **quote** 的交易对
（`WBNB/USDT`、`USDT/USDC`），而决策 0036 只认"该资产为 base"的对，于是每次快照都记
`MINING_PRICE_PAIR_NOT_FOUND`、按决策 0057 不发布，页面一直停在 09-20 05:22Z 的 `stale` 快照。

**做法**：公式版本可以按资产声明**参考定价规则**（`referencePricing`）。声明了 `stable` 的资产，在没有
base 对时允许用"该资产为 quote 的最深交易对"反推 `priceUsd / priceNative`，且结果必须落在
`pegUsd ± guardBps` 内才采用。**越界不采用 peg 常数**，仍然记 `MINING_PRICE_PAIR_NOT_FOUND`、该次快照
`incomplete`、页面继续回退到上一次完整快照并带 `stale: true`（决策 0057 的行为一个字都没变）。
未声明规则的资产仍是 base-only 老规则。

**对客户端的两处加法**（都在 `GET /v2/mining/assets` 的 `included[]`）：

| 字段                        | 变化                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `referencePriceQuality`     | 枚举从 `fresh \| proxied` 扩到 `fresh \| proxied \| derived`                                                                         |
| `referencePricePairAddress` | **新增**，`string \| null`（小写 `0x…40`）。`derived` 时必不为 null；`fresh` 时可能有（价格取自版本声明的指定交易对）；历史行为 null |

> **破坏性提示（请点名确认）**：如果客户端把 `referencePriceQuality` 当作**严格封闭枚举**解析
> （例如 Dart 的 `switch` 无 default、或 `enum.byName` 直接抛），那么一旦某行价格是 `derived`，
> `mining-assets` 页会解析失败。**请在本次发版前把未知值降级为"其他/未知来源"分支**。
> `referencePricePairAddress` 是新增字段，忽略它不会出错。

**三种 quality 的含义与展示建议**：

| quality   | 含义                                                                                            | 建议展示                                       |
| --------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `fresh`   | 该资产本身是所读交易对的 base，价格是它自己的直接观测                                           | 正常显示价格                                   |
| `proxied` | 价格来自版本声明的代理资产（原生 BNB ← WBNB，决策 0044），同时给出 `referencePriceProxyAssetId` | "代理价（WBNB）"                               |
| `derived` | 该资产是所读交易对的 **quote**，价格由该对反推得到，且已通过版本声明的偏离守卫（决策 0059）     | "推导价（来源池 `referencePricePairAddress`）" |

`derived` **不是**降级或不可信：它同样来自一次新鲜的 Provider 观测，只是经过一次精确的除法并通过了守卫；
不通过守卫的价格根本不会出现在响应里（那一行会变成"这次快照未发布"）。

## 1. 启用条件与 capability

| capabilityId      | availability 条件                                                                                                                                                                                       | evidence（恒定）                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `mining`          | `V2_MODULES_ENABLED` 含 `mining` + 仓储已组装                                                                                                                                                           | `{status: "pending", reasonCode: "MINING_FORMULA_BASELINE_PENDING"}`            |
| `referral`        | 含 `referral` + 仓储已组装                                                                                                                                                                              | 同上（加成依赖公式）                                                            |
| `communityMining` | 逐请求读库，**永不 `deferred`**：无 `mining` 模块或无已批准且已生效版本 → `unavailable(MINING_FORMULA_BASELINE_PENDING)`；仓储缺失/读失败 → `unavailable(MINING_RUNTIME_UNAVAILABLE)`；否则 `available` | `{status: "notApplicable", reasonCode: null}`（02 冻结看 `mining` 的 evidence） |

`communityMining.available` 只说明"本部署有一个生效的 configVersion"，是否产品口径看
`GET /v2/mining/rules.baseline.scope`。未启用模块时对应路径 `404 NOT_FOUND`。capability 总数仍为 **31**。

**S60（决策 0061）对本契约的加法——一个数字说清它数的是链上持仓还是演示持仓**
（只加一个可选字段，不改路径、不删字段）：

1. `snapshot` / `source` 的 `available` 分支多了 `holdingsSource: "chain" | "mock_seed" | "mixed"`
   （服务端总是给，schema 里为可选以兼容旧客户端）。
   - `chain`：所有算力行都来自链上观测到的余额。**生产环境只可能是这个值。**
   - `mock_seed`：全部来自开发环境 seed 写入的演示持仓（`ops/seed-mock.sh --holdings`）。
   - `mixed`：两者都有。
2. **客户端口径**：`holdingsSource !== "chain"` 时，页面上必须有一处明确说明「含演示持仓」
   （例如快照信息行加一句），不能把它当成链上事实展示。它不改变任何数字的真假：
   演示持仓是真实写入的行、走真实价格与真实公式，只是没人在链上持有它们。
3. 钱包页与本字段无关：钱包只读链，演示持仓在钱包里永远看不到。
4. 开发基线版本号变为 `miningFormula-devBaseline-2026-09-21-r4`（注册了 10 个真实 BSC 代币，
   资产权重在版本写入时固定，所以必须换版本；社区权重按版本重新批准）。

## 2. 通用投影

- 数字一律为无符号 decimal 字符串（`^(0|[1-9][0-9]{0,77})(\.[0-9]{1,60})?$`），用等宽字体。
- `{status: "available", value}` 与 `{status: "unavailable", reasonCode}` 二选一；前端对 unavailable 显示 `—`
  并按 reasonCode 给文案。
- `snapshot` 有值时为 `{snapshotId, blockNumber, blockHash, formulaVersion, priceVersion, computedAt, stale,
latestAttempt, holdingsSource}`（`stale`/`latestAttempt` 是 S51 加法，`holdingsSource` 是 S60 加法，见 §0）。它永远是**最新的完整快照**；`stale: true` 表示之后还有一次未完成
  或已作废的尝试，`latestAttempt` 就是那次尝试。`unavailable` 分支为 `{status, reasonCode}`，在生效版本下有尝试但
  没有完整快照时另带可选 `latestAttempt`。

### 2.1 全部 reasonCode

| reasonCode                             | 含义                                                                                                                     | 出现位置                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `MINING_FORMULA_BASELINE_PENDING`      | 没有已批准且已生效的公式版本（**只**表示这一件事）                                                                       | 无生效版本时的所有数字块、`snapshot`、`formula`、capability                      |
| `MINING_REFERRAL_BOOST_PENDING`        | 邀请加成尚未被生效版本批准（只说加成，不说别的）                                                                         | `summary.referralBoost`、`GET /v2/referral.boost`                                |
| `MINING_SNAPSHOT_NOT_AVAILABLE`        | 有生效版本但 lane 尚未算出快照                                                                                           | 所有数字块、`snapshot`                                                           |
| `MINING_SNAPSHOT_STALE`                | 最新完整快照是在另一个版本下算的                                                                                         | 同上                                                                             |
| `MINING_SNAPSHOT_INCOMPLETE`           | 生效版本下最近一次计算有持仓读不到价、没有发布，且没有任何完整快照可回退（决策 0057）                                    | 所有数字块、`snapshot`（带 `latestAttempt`）、社区侧 `miningPower`               |
| `MINING_SNAPSHOT_PENDING`              | 本账号有激活钱包，但还没有完整快照包含它；文案"下一次快照后显示"（决策 0057）                                            | `power`、`estimatedToday`、`totalPower`、`myPosition`、`myContribution`          |
| `MINING_ACCOUNT_NOT_IN_SNAPSHOT`       | 该账号在快照里没有余额行且**没有激活钱包**                                                                               | `power`、`estimatedToday`、`myPosition`、`myContribution`、成员行                |
| `MINING_NETWORK_POWER_ZERO`            | 全网算力为 0，份额无定义                                                                                                 | `estimatedToday`                                                                 |
| `MINING_DAILY_OUTPUT_NOT_CONFIGURED`   | 生效版本没有日产出预算（产品草稿）                                                                                       | `estimatedToday`                                                                 |
| `MINING_RANK_NOT_RANKED`               | 本人算力为 0，没有名次                                                                                                   | `myPosition`、社区 `rank`                                                        |
| `MINING_RANK_NOT_APPLICABLE`           | `scope=communities` 时 `myPosition` 无意义                                                                               | `myPosition`                                                                     |
| `MINING_POWER_PRIVATE`                 | 对方 `miningPowerVisibility: self`                                                                                       | 成员行、关注列表 `miningPower`                                                   |
| `MINING_RUNTIME_UNAVAILABLE`           | 仓储读失败                                                                                                               | 社区侧 `miningPower`、capability                                                 |
| `COMMUNITY_ASSET_NOT_BOUND`            | 社区未绑定资产（无权重可审）                                                                                             | `weight`（`reviewStatus: not_applicable`）、社区算力四块、社区详情 `miningPower` |
| `COMMUNITY_WEIGHT_PENDING_REVIEW`      | 绑定了资产但生效版本下没有已批准权重                                                                                     | `weight`（`reviewStatus: pending_review`）、社区算力、`excluded`                 |
| `COMMUNITY_WEIGHT_AMBIGUOUS`           | 两个社区在同一资产上都有已批准权重（该资产被排除）                                                                       | `excluded`                                                                       |
| `MINING_ASSET_WEIGHT_NOT_CONFIGURED`   | 资产不在生效版本的 `assetWeights` 里                                                                                     | `excluded`                                                                       |
| `MINING_PRICE_NOT_FRESH`               | 参考价不新鲜（代理价按代理源自己的观测时间判定）                                                                         | `excluded`、`latestAttempt.unreadInputs[]`                                       |
| `MINING_PRICE_PAIR_NOT_FOUND`          | Provider 事实新鲜，但没有一个以该资产为 base 的交易对，且版本声明的参考定价规则也没给出通过守卫的价格（决策 0057、0059） | `excluded`、`latestAttempt.unreadInputs[]`                                       |
| `MINING_PRICE_PROXY_NOT_DECLARED`      | Provider 通过版本未声明的代理资产定价                                                                                    | `excluded`、`latestAttempt.unreadInputs[]`                                       |
| `MINING_SNAPSHOT_PUBLISHED_INCOMPLETE` | 运维作废了旧写法在读价失败时仍发布的快照（决策 0057）                                                                    | 只在 `latestAttempt.reasonCode`（`status: "invalidated"`）                       |
| `REWARD_AUTHORITY_PENDING`             | 没有奖励账本/合约                                                                                                        | `claimable`、`accumulated`、rewards `source`                                     |

HTTP 错误：`400 INVALID_REQUEST`（非法 `scope`、多余 query/body）、`401 AUTH_*`、`404 NOT_FOUND`
（社区不存在）、`503 CAPABILITY_UNAVAILABLE`（挖矿仓储不可用；`assets` 另含 Asset Registry 不可用）。错误体固定七字段。
"账号还没有数据"**从不**是 503：没进过快照的钱包四个读都是 200 + `MINING_SNAPSHOT_PENDING`（有服务端结构性测试）。

### 2.2a `snapshot.stale` / `latestAttempt`（S51，决策 0057）

2026-09-20 Development 的实际状态（`cy` 的 USDT 2.99 在 09-18 起大部分时间读不到以 USDT 为 base 的交易对）：

```json
{
  "power": { "status": "available", "value": "4.482309" },
  "networkPower": { "status": "available", "value": "4.482309" },
  "snapshot": {
    "snapshotId": "43880746-17f3-43c3-8213-9e8033319093",
    "blockNumber": "122998659",
    "blockHash": "0x…",
    "formulaVersion": "miningFormula-devBaseline-2026-09-15-r2",
    "priceVersion": "dexscreener:2026-09-20T05:21:58.558Z",
    "computedAt": "2026-09-20T05:22:10.589Z",
    "stale": true,
    "latestAttempt": {
      "snapshotId": "…",
      "status": "incomplete",
      "computedAt": "2026-09-20T15:05:00.000Z",
      "reasonCode": "MINING_SNAPSHOT_INCOMPLETE",
      "unreadInputs": [
        {
          "assetId": "eip155:56:0x55d398326f99059ff775485246999027b3197955",
          "reasonCode": "MINING_PRICE_PAIR_NOT_FOUND"
        }
      ]
    }
  }
}
```

- 数字来自 `snapshot`（05:22Z 那次完整快照），**不是** 0；`stale: true` 必须在同屏标出"数据截至 05:22Z，最近一次
  计算（15:05Z）未完成：USDT 读不到价格"。`unreadInputs[].assetId` 用 `GET /v2/mining/assets` 的 `symbol` 映射。
- `latestAttempt.status === "complete"` 且 `stale: false`：正常，`latestAttempt.snapshotId === snapshot.snapshotId`。
- `latestAttempt.status === "invalidated"`：运维作废了更新的快照，`reasonCode` 是作废原因，`unreadInputs` 为空。
- 没有完整快照时：`snapshot = {status: "unavailable", reasonCode: "MINING_SNAPSHOT_INCOMPLETE", latestAttempt}`，
  所有数字块同码；页面展示 `—` 并用 `latestAttempt.unreadInputs` 说明原因。

### 2.2 `formula` 块（summary / assets / rank 共用）

```json
{
  "status": "approved",
  "configVersion": "miningFormula-devBaseline-2026-09-15-r2",
  "effectiveAt": "2026-09-15T14:57:37.026Z",
  "scope": "development_baseline"
}
```

或无生效版本时：

```json
{
  "status": "unavailable",
  "reasonCode": "MINING_FORMULA_BASELINE_PENDING",
  "pendingVersion": "miningFormulaV1-draft"
}
```

三个接口同一定义、同一来源（生效版本的 `formula.scope`）。"开发基线"标签只看 `formula.scope`，不要从
`formulaVersion` 字符串猜；`scope: null` 表示产品版本。

## 3. Mining 读接口

### 3.1 `GET /v2/mining/summary`（mining）

有生效版本且有快照时（2026-09-15 Development 实际响应，账号 `3bb58597-…`）：

```json
{
  "power": { "status": "available", "value": "0" },
  "networkPower": { "status": "available", "value": "0" },
  "estimatedToday": {
    "status": "unavailable",
    "reasonCode": "MINING_NETWORK_POWER_ZERO"
  },
  "accumulated": {
    "status": "unavailable",
    "reasonCode": "REWARD_AUTHORITY_PENDING"
  },
  "claimable": {
    "status": "unavailable",
    "reasonCode": "REWARD_AUTHORITY_PENDING"
  },
  "referralBoost": {
    "status": "unavailable",
    "reasonCode": "MINING_REFERRAL_BOOST_PENDING"
  },
  "formula": {
    "status": "approved",
    "configVersion": "miningFormula-devBaseline-2026-09-15-r2",
    "effectiveAt": "2026-09-15T14:57:37.026Z",
    "scope": "development_baseline"
  },
  "snapshot": {
    "snapshotId": "0e358b31-e49f-48b9-89b2-c5c908c3ad5e",
    "blockNumber": "122037728",
    "blockHash": "0x3decab82b150493d90cb8fe47b3873c6e3b8c72aecf08ce91b4aceb266bda28a",
    "formulaVersion": "miningFormula-devBaseline-2026-09-15-r2",
    "priceVersion": "dexscreener:2026-09-15T14:58:51.862Z",
    "computedAt": "2026-09-15T14:58:54.366Z"
  },
  "contractVersion": "2.0"
}
```

网络算力非零时 `estimatedToday` 为：

```json
{
  "status": "available",
  "value": "250000",
  "budget": "1000000",
  "unitKey": "mining.rules.dailyOutput.unit.loopTokenPending",
  "budgetStatus": "development_placeholder",
  "formulaVersion": "miningFormula-devBaseline-2026-09-15-r2",
  "scope": "development_baseline"
}
```

（`value = budget × power ÷ networkPower`，截断到 6 位小数；上例 1000000 × 1000 ÷ 4000。**预算数字必须与
`formulaVersion` 和 `scope` 同屏出现**，版本号本身就是"开发基线"标签。）

`referralBoost` 在两种状态下都是 `MINING_REFERRAL_BOOST_PENDING`——它只说"邀请加成还没批准"，不说页面其它部分；
有生效版本时页面上**不会**出现 `MINING_FORMULA_BASELINE_PENDING`（服务端有结构性测试保证）。

没有生效版本时 `formula = {status: "unavailable", reasonCode: "MINING_FORMULA_BASELINE_PENDING", pendingVersion}`，
其余数字块与 `snapshot` 都是 `MINING_FORMULA_BASELINE_PENDING`。

### 3.2 `GET /v2/mining/assets`（mining-assets）

2026-09-15 Development 实际响应（账号 `cy`；`symbol`/`formula` 为 S22a 加法，值按同一库的 Registry 行与生效版本补入；
`referencePricePairAddress` 为 S51c 加法，该次运行的行全部为 `null`）：

```json
{
  "totalPower": { "status": "available", "value": "0" },
  "included": [
    {
      "assetId": "eip155:56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
      "symbol": "Cake",
      "holding": "0",
      "referencePriceUsd": "2.26",
      "referencePriceQuality": "fresh",
      "referencePriceProxyAssetId": null,
      "referencePricePairAddress": null,
      "weight": "0.8",
      "power": "0",
      "blockNumber": "122037728"
    },
    {
      "assetId": "eip155:56:0x55d398326f99059ff775485246999027b3197955",
      "symbol": "USDT",
      "holding": "0",
      "referencePriceUsd": "0.9994",
      "referencePriceQuality": "fresh",
      "referencePriceProxyAssetId": null,
      "referencePricePairAddress": null,
      "weight": "1.5",
      "power": "0",
      "blockNumber": "122037728"
    },
    {
      "assetId": "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
      "symbol": "WBNB",
      "holding": "0",
      "referencePriceUsd": "713.42",
      "referencePriceQuality": "fresh",
      "referencePriceProxyAssetId": null,
      "referencePricePairAddress": null,
      "weight": "1",
      "power": "0",
      "blockNumber": "122037728"
    },
    {
      "assetId": "eip155:56:native",
      "symbol": "BNB",
      "holding": "0",
      "referencePriceUsd": "713.42",
      "referencePriceQuality": "proxied",
      "referencePriceProxyAssetId": "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
      "referencePricePairAddress": null,
      "weight": "1",
      "power": "0",
      "blockNumber": "122037728"
    }
  ],
  "excluded": [],
  "source": { "…快照…": "" },
  "referencePrice": {
    "status": "available",
    "priceVersion": "dexscreener:2026-09-15T14:58:51.862Z"
  },
  "formula": {
    "status": "approved",
    "configVersion": "miningFormula-devBaseline-2026-09-15-r2",
    "effectiveAt": "2026-09-15T14:57:37.026Z",
    "scope": "development_baseline"
  },
  "contractVersion": "2.0"
}
```

`included[].weight` 是生效权重（资产权重 × 已批准社区权重：Cake `0.8`、USDT `1.5` 来自两个绑定社区）；
`referencePriceQuality: "proxied"` 时界面必须注明"价格来自 WBNB 代理"（`referencePriceProxyAssetId`）。

在 r3 基线（决策 0059）下，USDT 这一行的形状变为（示例，数值随行情变化）：

```json
{
  "assetId": "eip155:56:0x55d398326f99059ff775485246999027b3197955",
  "symbol": "USDT",
  "holding": "2.99",
  "referencePriceUsd": "0.999535369961668021",
  "referencePriceQuality": "derived",
  "referencePriceProxyAssetId": null,
  "referencePricePairAddress": "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
  "weight": "1.5",
  "power": "4.4879099633...",
  "blockNumber": "123001455"
}
```

界面注明"推导价（来源池 …0dae）"即可；`derived` 的完整含义见 §0.1。
`excluded` 是账号持有但快照未计入的资产，原因按 lane 使用的同一输入重推，每行同样带 `symbol`：
`{assetId, symbol, reasonCode}`。无快照时两个列表为空、三块 unavailable，`formula` 照常给出。

- `symbol`（必填）：服务端从 Asset Registry 读（与行情模块同源，一次查询覆盖整页），native 行是 `BNB`。
  只有 Registry 没有该资产行时才是 `null`——此时再退回显示缩略地址；**不要**再从地址或链槽位推名字。
  Registry 读不到时整个接口 `503 CAPABILITY_UNAVAILABLE`（不会给一页没名字的行）。
- `formula`：见 §2.2，与摘要页同一块；本页的"开发基线"戳从这里取。

### 3.3 `GET /v2/mining/rewards`（mining-rewards）

`claimable`/`accumulated`/`source` 恒 `REWARD_AUTHORITY_PENDING`，`claimExecutable: false`，`ledger: []`；
`estimatedToday` 与 summary 相同。

### 3.4 `GET /v2/mining/rank?scope=users|communities`（mining-rank）

```json
{
  "scope": "users",
  "ranking": {
    "status": "available",
    "scope": "users",
    "items": [
      {
        "position": 1,
        "power": "3000",
        "powerVisibility": "everyone",
        "display": {
          "kind": "alias",
          "alias": "whale",
          "publicProfileId": "…",
          "audience": "everyone"
        },
        "isSelf": false
      },
      {
        "position": 2,
        "power": "1000",
        "powerVisibility": "self",
        "display": {
          "kind": "alias",
          "alias": "me",
          "publicProfileId": "…",
          "audience": "self"
        },
        "isSelf": true
      }
    ],
    "participants": 3
  },
  "myPosition": { "status": "available", "position": 2, "power": "1000" },
  "snapshot": { "…": "" },
  "display": {
    "anonymousMemberKey": "mining.rank.anonymousMember",
    "ruleKey": "mining.rank.display.anonymousModeOnly",
    "powerRuleKey": "mining.rank.power.ownerVisibility"
  },
  "formula": {
    "status": "approved",
    "configVersion": "miningFormula-devBaseline-2026-09-15-r2",
    "effectiveAt": "2026-09-15T14:57:37.026Z",
    "scope": "development_baseline"
  },
  "contractVersion": "2.0"
}
```

- 列出快照中的全部账号（或生效版本下全部已绑定且权重已批准的社区），算力 > 0 的按 `rank()` 排在前（并列同名次），
  算力为 0 的排在后且 `position: null`；最多 100 行；`participants` 只数算力 > 0 的。
- **显示名与算力数值由两个独立开关决定（S27c / 决策 0049，替代原"可被发现且非匿名"规则）**：
  - `display`：只看隐私中心的**匿名模式**。别人的行：`!anonymousMode` 且有 alias → `alias`，否则
    `anonymous`（不给 ID）。**本人行永远是 `alias`**（自己不可能对自己匿名）；本人开着匿名模式时
    `audience: "self"`，表示"别人看到的是匿名成员"，前端在本人行加一句"其他人看到的是匿名成员"；
    否则 `audience: "everyone"`。「可被发现 / 显示 LOOP ID」在这里**什么都不决定**。
  - `power`：只看隐私中心的**算力可见范围**（`mining_power_visibility`）。别人的行且行主设为 `self` →
    `power: null`（渲染"仅本人可见"，不是"读不到"）；本人行永远有数值。`powerVisibility` 是行主的设置
    原样下发，本人行为 `self` 时可提示"仅自己可见"。
  - `position`、`participants` 永远公开，不受两个开关影响。
  - 四种组合：

    | `anonymousMode` | 算力可见范围 | 别人看到                 | 本人看到                        |
    | --------------- | ------------ | ------------------------ | ------------------------------- |
    | 关              | everyone     | 别名 + 算力              | 别名（audience everyone）+ 算力 |
    | 关              | self         | 别名 + `power: null`     | 别名（audience everyone）+ 算力 |
    | 开              | everyone     | 匿名成员 + 算力          | 别名（audience self）+ 算力     |
    | 开              | self         | 匿名成员 + `power: null` | 别名（audience self）+ 算力     |

  - `display.ruleKey` 换成了 `mining.rank.display.anonymousModeOnly`（中文：「匿名模式开启时其他人看到的是匿名成员」），
    新增 `display.powerRuleKey = mining.rank.power.ownerVisibility`（「算力数值按对方的可见范围设置显示」）；
    旧键 `mining.rank.display.aliasOrAnonymous` 不再下发。
- `scope=communities` 时 `items[] = {position, power, community: {communityId, name, boundAssetId}, weight, participants}`，
  `myPosition` 为 `MINING_RANK_NOT_APPLICABLE`。
- 2026-09-15 Development 实际响应：`scope=users` 列出 2 个账号（`position: null`、`power: "0"`，一个 alias 一个
  anonymous），`myPosition` 为 `MINING_RANK_NOT_RANKED`；`scope=communities`：

```json
"items": [
  { "position": null, "power": "0",
    "community": { "communityId": "439cabe6-4c98-4f99-860f-192ad52403a1", "name": "Builders Guild",
                   "boundAssetId": "eip155:56:0x55d398326f99059ff775485246999027b3197955" },
    "weight": "1.5", "participants": 0 },
  { "position": null, "power": "0",
    "community": { "communityId": "d17b34a6-c3cc-4a24-87dd-dc165c80bd85", "name": "DeFi 早读会",
                   "boundAssetId": "eip155:56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82" },
    "weight": "0.8", "participants": 0 }
], "participants": 0
```

- 顶层 `scope` 是排行范围（`users | communities`）；版本的 `scope` 在 `formula.scope` 里（§2.2），两者不要混。
  无生效版本时 `ranking`/`myPosition`/`snapshot` 都是 `MINING_FORMULA_BASELINE_PENDING`，`formula` 为 unavailable 分支。
- `scope` 非法 → `400`。

### 3.5 `GET /v2/mining/communities/{communityId}`（mining-community）

2026-09-15 Development 实际响应（`mock-defi-morning`，账号 `cy`）：

```json
{
  "community": {
    "communityId": "d17b34a6-c3cc-4a24-87dd-dc165c80bd85",
    "name": "DeFi 早读会",
    "boundAssetId": "eip155:56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82"
  },
  "weight": {
    "status": "approved",
    "value": "0.8",
    "configVersion": "miningFormula-devBaseline-2026-09-15-r2",
    "reviewedAt": "2026-09-15T14:58:52.089Z"
  },
  "communityPower": { "status": "available", "value": "0" },
  "myContribution": { "status": "available", "value": "0" },
  "rank": { "status": "unavailable", "reasonCode": "MINING_RANK_NOT_RANKED" },
  "participants": { "status": "available", "count": 0 },
  "snapshot": { "…": "" },
  "contractVersion": "2.0"
}
```

`communityPower` 为未封禁成员在绑定资产上的算力之和，`myContribution` 为本人在该资产上的算力，
`participants.count` 为算力 > 0 的成员数；未绑定资产 → 四块 `COMMUNITY_ASSET_NOT_BOUND`；绑定但生效版本下无已批准权重 →
`COMMUNITY_WEIGHT_PENDING_REVIEW`。社区不存在 → `404`。

`weight` 块的三种取值（S22a，决策 0046；与社区侧 `miningPower.weight` 同一函数构造）：

| 情形                         | `weight`                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| 已批准                       | `{status: "approved", value, configVersion, reviewedAt}`                                                 |
| 绑定了资产、无已批准权重     | `{status: "unavailable", reasonCode: "COMMUNITY_WEIGHT_PENDING_REVIEW", reviewStatus: "pending_review"}` |
| **未绑定资产**（无权重可审） | `{status: "unavailable", reasonCode: "COMMUNITY_ASSET_NOT_BOUND", reviewStatus: "not_applicable"}`       |

`reviewStatus` 仍是必填键，枚举 `pending_review | not_applicable`，与 reasonCode 一一对应；未绑定时四个数字块与
`weight` 说的是同一句话，不会再出现"权重待审"。

### 3.6 `GET /v2/mining/rules`（mining-rules）

```json
{
  "approved": {
    "configVersion": "miningFormula-devBaseline-2026-09-15-r2",
    "status": "approved",
    "scope": "development_baseline",
    "effectiveAt": "2026-09-15T14:57:37.026Z",
    "approvedAt": "…",
    "expressionKey": "mining.rules.formula.holdingTimesReferencePriceTimesWeight",
    "dailyOutputKey": "mining.rules.dailyOutput.shareOfNetworkPower",
    "assetWeights": {
      "eip155:56:native": "1",
      "eip155:56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82": "1",
      "eip155:56:0x55d398326f99059ff775485246999027b3197955": "1",
      "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": "1"
    },
    "dailyOutput": {
      "status": "development_placeholder",
      "budget": "1000000",
      "unitKey": "mining.rules.dailyOutput.unit.loopTokenPending"
    },
    "weightRange": {
      "loop": {
        "status": "pending_approval",
        "descriptionKey": "mining.rules.weight.loopFixedMaximum"
      },
      "community": {
        "status": "approved",
        "descriptionKey": "mining.rules.weight.communityReviewed",
        "range": { "min": "0.5", "max": "2" }
      },
      "reviewFactorKeys": ["mining.rules.reviewFactor.communityQuality", "…"]
    },
    "priceGuardRules": [
      {
        "ruleKey": "mining.rules.priceGuard.twap",
        "status": "pending_approval"
      },
      "…"
    ],
    "referralBoost": { "status": "pending_approval" }
  },
  "pendingApproval": [
    {
      "configVersion": "miningFormulaV1-draft",
      "scope": null,
      "assetWeights": {},
      "dailyOutput": null,
      "…": ""
    }
  ],
  "baseline": {
    "status": "approved",
    "configVersion": "miningFormula-devBaseline-2026-09-15-r2",
    "effectiveAt": "2026-09-15T14:57:37.026Z",
    "scope": "development_baseline"
  },
  "referral": {
    "configVersion": "referralRulesV1",
    "effectiveAt": "2026-09-01T00:00:00.000Z",
    "levels": ["…"]
  },
  "contractVersion": "2.0"
}
```

规则页用 key 渲染文案（公式 = 持有量 × 参考价 × 权重；每日产出 = 我的算力 ÷ 全网算力 × 当日产量），
数值只从响应取；`scope: "development_baseline"` 必须以"开发基线"标签展示；产品草稿的 `assetWeights: {}`、
`dailyOutput: null`、`scope: null` 继续渲染为"待批准"。

### 3.7 `GET /v2/mining/referral/rules`

与 S3 相同的静态快照（`edges`/`inviteCode` 恒 unavailable；真实数据走 `GET /v2/referral`）。

## 4. 社区侧 `miningPower`（决策 0043、0045）

`GET /v2/communities/{id}.miningPower`（含 join/leave 等返回社区资源的写接口）、
`GET /v2/communities/{id}/members.items[].miningPower`、`GET /v2/connections.items[].miningPower`
共用**一个**定义（OpenAPI `miningPowerSchema`）。`available` 分支按 `subject` 分两种；除 S51 加的 `stale`
（服务端总是给、schema 可选）外都是**必填字段、无可选项**：

| `subject`   | 谁的数                               | 字段                                                                                              |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `community` | 社区未封禁成员在绑定资产上的算力之和 | `power`、`snapshotId`、`formulaVersion`、`computedAt`、`scope`、`stale`、`weight`、`participants` |
| `account`   | 对方个人总算力（成员行、关注行）     | `power`、`snapshotId`、`formulaVersion`、`computedAt`、`scope`、`stale`                           |

- `stale: true`（决策 0057）：数字来自最新**完整**快照，而之后有一次未完成/已作废的计算；卡片上标"数据截至
  `computedAt`"。社区侧不带 `latestAttempt`，要看原因去 `GET /v2/mining/summary.snapshot.latestAttempt`。
  没有完整快照时整块是 `unavailable(MINING_SNAPSHOT_INCOMPLETE)`。

- `scope` 与摘要页 `formula.scope`、规则页 `baseline.scope` **同一枚举同一来源**（生效版本的 `formula.scope`）：
  `"development_baseline"` 或 `null`（产品版本）。**只用它打"开发基线"标签，不要从 `formulaVersion` 字符串猜**。
- `weight` 与 3.5 的 `GET /v2/mining/communities/{id}.weight` **同一形状同一来源**（同一函数构造）：
  `{status: "approved", value, configVersion, reviewedAt}` 或
  `{status: "unavailable", reasonCode: "COMMUNITY_WEIGHT_PENDING_REVIEW", reviewStatus: "pending_review"}`
  （社区侧 `available` 分支只在有 standing 时出现，standing 只存在于已绑定且权重已批准的社区，所以这里实际只会
  见到 `approved`；`not_applicable` 取值见 §3.5，未绑定社区在社区侧整体是 `unavailable(COMMUNITY_ASSET_NOT_BOUND)`）。
- `participants` 与 3.5 的 `participants` 同形：`{status: "available", count}` 或 `{status: "unavailable", reasonCode}`。
- 成员行 / 关注行是**一个人**跨资产的总算力，没有哪一个社区权重能解释它，所以 `account` 分支不带 `weight`/`participants`，
  也不会用假 `reviewStatus` 凑一个 unavailable。按 `subject` 分支解码即可，不需要判断字段是否存在。
- `unavailable` 分支**逐字节不变**：`{status: "unavailable", reasonCode}`，reasonCode 见 §2.1
  （社区：`MINING_FORMULA_BASELINE_PENDING` / `MINING_SNAPSHOT_*` / `COMMUNITY_ASSET_NOT_BOUND` /
  `COMMUNITY_WEIGHT_PENDING_REVIEW` / `MINING_RUNTIME_UNAVAILABLE`；成员/关注行另有 `MINING_POWER_PRIVATE` /
  `MINING_ACCOUNT_NOT_IN_SNAPSHOT`）。未启用 `mining` 模块的部署恒为 `MINING_FORMULA_BASELINE_PENDING`。

2026-09-16 Development 库实际投影（同一快照 `0e358b31-…`，两只开发钱包持仓为零，所以 `power`/`count` 都是真实的 0）：

`GET /v2/communities/d17b34a6-c3cc-4a24-87dd-dc165c80bd85`（`mock-defi-morning`，Cake，权重 `0.8`）：

```json
{
  "miningPower": {
    "status": "available",
    "subject": "community",
    "power": "0",
    "snapshotId": "0e358b31-e49f-48b9-89b2-c5c908c3ad5e",
    "formulaVersion": "miningFormula-devBaseline-2026-09-15-r2",
    "computedAt": "2026-09-15T14:58:54.366Z",
    "scope": "development_baseline",
    "weight": {
      "status": "approved",
      "value": "0.8",
      "configVersion": "miningFormula-devBaseline-2026-09-15-r2",
      "reviewedAt": "2026-09-15T14:58:52.089Z"
    },
    "participants": { "status": "available", "count": 0 }
  }
}
```

`GET /v2/communities/439cabe6-4c98-4f99-860f-192ad52403a1`（`builders-guild`，USDT，权重 `1.5`）：

```json
{
  "miningPower": {
    "status": "available",
    "subject": "community",
    "power": "0",
    "snapshotId": "0e358b31-e49f-48b9-89b2-c5c908c3ad5e",
    "formulaVersion": "miningFormula-devBaseline-2026-09-15-r2",
    "computedAt": "2026-09-15T14:58:54.366Z",
    "scope": "development_baseline",
    "weight": {
      "status": "approved",
      "value": "1.5",
      "configVersion": "miningFormula-devBaseline-2026-09-15-r2",
      "reviewedAt": "2026-09-15T14:58:53.159Z"
    },
    "participants": { "status": "available", "count": 0 }
  }
}
```

`GET /v2/communities/439cabe6-…/members`（viewer 为 `cy`）两行的 `miningPower`：本人行 `account` 分支，
`Voyager_09` 的 `miningPowerVisibility: self` 所以是 `MINING_POWER_PRIVATE`：

```json
[
  {
    "status": "available",
    "subject": "account",
    "power": "0",
    "snapshotId": "0e358b31-e49f-48b9-89b2-c5c908c3ad5e",
    "formulaVersion": "miningFormula-devBaseline-2026-09-15-r2",
    "computedAt": "2026-09-15T14:58:54.366Z",
    "scope": "development_baseline"
  },
  { "status": "unavailable", "reasonCode": "MINING_POWER_PRIVATE" }
]
```

`GET /v2/connections.items[].miningPower` 与成员行走同一条读取路径、同一形状（`account` 分支）；Development 库
目前没有任何 `follow_edges`，所以该路由对每个 viewer 都是 `items: []`，上面成员行的对象就是关注行会给出的对象。

## 5. 邀请关系（referral）

### 5.1 `GET /v2/referral`

首次读取自动签发本账号邀请码（每账号一个，随机、唯一、不可枚举）。

```json
{
  "inviteCode": { "code": "LOOP-7HJKM", "issuedAt": "…" },
  "binding": {
    "status": "unbound",
    "inviter": null,
    "claimWindow": { "status": "open", "activatedAt": "…", "closesAt": "…" }
  },
  "levels": [
    { "level": 1, "boostPercent": "10",
      "counts": { "pending_activation": 0, "pending_wallet": 2, "pending_mining": 1, "valid": 0, "invalidated": 0 },
      "total": 3 },
    … level 2..5
  ],
  "boost": { "status": "unavailable", "reasonCode": "MINING_REFERRAL_BOOST_PENDING" },
  "rules": { "configVersion": "referralRulesV1", "effectiveAt": "2026-09-01T00:00:00.000Z", "appliesTo": "miningPower", "maximumDepth": 5, "claimWindowDays": 7 },
  "contractVersion": "2.0"
}
```

- 邀请码格式 `LOOP-` + 4 位 Crockford Base32 + 1 位校验位（共 5 位）；复制到系统剪贴板。
- `binding.claimWindow`：`open`（可显示"绑定邀请码"入口）、`closed`（隐藏入口）、
  `{status: "unavailable", reasonCode: "PROFILE_ACTIVATION_REQUIRED"}`（未激活 LOOP ID）。
- 绑定后 `binding.status = "bound"`，`inviter = {depth: 1, validationStatus, lockedAt, effectiveFrom, configVersion}`
  —— **不暴露邀请人身份**。
- `levels[].counts` 按 `validationStatus` 分组；开发基线不验证边为 `valid`，`boost` 仍 unavailable，
  码是 `MINING_REFERRAL_BOOST_PENDING`（与摘要页 `referralBoost` 同一槽位同一码；S22a 前误用 `MINING_FORMULA_BASELINE_PENDING`）。
- 一切表述为 "Mining Power 加成"，禁止"返佣/分红/下线收入"。

### 5.2 `POST /v2/referral/claim`

请求 `{ "inviteCode": "loop-7hjkm" }`（大小写、`I/L→1`、`O→0`、前缀缺省均可，服务端归一化）。

成功 `200`：`{ "binding": {…bound}, "contractVersion": "2.0" }`。

| 场景                          | 状态 / code                                            |
| ----------------------------- | ------------------------------------------------------ |
| 码格式错、缺 Idempotency-Key  | `400 INVALID_REQUEST`                                  |
| 账号未激活 LOOP ID            | `409 PROFILE_ACTIVATION_REQUIRED` → 去 `loop-id-setup` |
| 激活超过 7 天                 | `403 POLICY_BLOCKED`                                   |
| 码不存在                      | `404 NOT_FOUND`（不可枚举）                            |
| 自邀 / 环路（对方是我的下级） | `422 VALIDATION_FAILED`                                |
| 已绑定过                      | `409 DATA_STALE`                                       |
| 同 key 不同码                 | `409 IDEMPOTENCY_CONFLICT`                             |

关系规则：绑定时按邀请人链自动生成 L1..L5 边（第 6 层以上不计入，不拒绝绑定）；边一旦锁定不可删除，
只能作废（`invalidated` + `effectiveTo`）。

## 6. Dev 脚本（全部在 `NODE_ENV=production` 下拒绝）

```sh
pnpm mining:dev-baseline --confirm                                   # 从 registry 生成开发基线（pending_approval）
pnpm mining:approve-formula miningFormula-devBaseline-2026-09-15-r2 --confirm
pnpm mining:community-weight <communityId> <weight> --confirm        # 0.5 ≤ weight ≤ 2，社区须已绑定资产
pnpm mining:snapshot --confirm                                       # 跑一次 lane（需 DexScreener 可达）
```

社区绑定资产走 `POST/PUT /v2/communities` 的 `boundAssetKey`（社区 owner 自助）。
