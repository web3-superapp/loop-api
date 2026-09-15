# 前端联调：V2 Mining（S7 骨架 + S20 开发基线）与邀请关系

本文是 `mining` 与 `referral` 两个模块（决策 0036、0043）的前端交接契约。权威机器契约为
`openapi/loop-api.v2.json`。通用规则沿用 `docs/frontend-v2-session-api.md` 与
`docs/api-v2-conventions.md`。Base URL 与 headers 同其它 V2 模块：所有请求带
`Authorization: Bearer <Privy access token>`、`X-Loop-Contract-Version: 2.0`、
`X-Loop-Client-Version`；本模块全部为 `GET`，禁止带 `Idempotency-Key`；响应 `Cache-Control: no-store`。

覆盖页面：`mining`、`mining-assets`、`mining-rewards`、`mining-rank`、`mining-community`、
`mining-rules`、`referral`，以及社区详情/成员/关注列表上的 `miningPower`。

## 0. 本步的硬前提（S20，决策 0043）

**产品公式仍未冻结**（03 §19；`miningFormulaV1-draft` 仍是 `pending_approval`）。S20 新增了一个
**自我描述的开发基线版本** `miningFormula-devBaseline-2026-09-15`（`scope: "development_baseline"`），
只在 Development 环境由运维脚本批准；它让页面能算出数，**不代表数是产品口径**：

- 每个已登记资产权重 `1`（算力 = 持仓的美元价值）；
- 社区权重区间 `[0.5, 2]`，只能由运维脚本落值；
- 日产出预算 `1000000`，`budgetStatus: "development_placeholder"`，单位 key
  `mining.rules.dailyOutput.unit.loopTokenPending`（LOOP 奖励代币合约未定）。

**前端必须**：凡 `scope === "development_baseline"` 或 `budgetStatus === "development_placeholder"`
的数字，一律加"开发基线（configVersion）"标签，不得表述为收益或承诺；`claimable`/`accumulated` 恒为
`REWARD_AUTHORITY_PENDING`，领取按钮不可执行。

2026-09-15 Development 实跑事实（可复核）：公式行已批准（`effectiveAt 2026-09-15T14:32:19.999Z`）；
快照 `3d0a9993-fb1f-4cad-b786-04f55b90c106` @ block `122037728`，`priceVersion
dexscreener:2026-09-15T14:32:19.293Z`，6 行算力（2 个钱包 × WBNB/USDT/Cake），**全部为 0**——两只开发钱包在
BSC 主网上持仓为零；原生 BNB 因价格经 WBNB 代理被跳过（`MINING_PRICE_NOT_FRESH`）；13 个社区均未绑定资产
（`COMMUNITY_ASSET_NOT_BOUND`）。要看到非零数字需要真实持仓与绑定资产的社区，后端不会造。

## 1. 启用条件与 capability

| capabilityId      | availability 条件                                                                                                                                                                                                           | evidence（恒定）                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `mining`          | `V2_MODULES_ENABLED` 含 `mining` + 仓储已组装                                                                                                                                                                               | `{status: "pending", reasonCode: "MINING_FORMULA_BASELINE_PENDING"}` |
| `referral`        | 含 `referral` + 仓储已组装                                                                                                                                                                                                  | 同上（加成依赖公式）                                                 |
| `communityMining` | 逐请求读库：无 `mining` 模块 → `deferred(V2_MINING_RUNTIME_DEFERRED)`；仓储缺失/读失败 → `unavailable(MINING_RUNTIME_UNAVAILABLE)`；无已批准且已生效版本 → `unavailable(MINING_FORMULA_BASELINE_PENDING)`；否则 `available` | 同上（02 冻结前恒 pending）                                          |

`communityMining.available` 只说明"本部署有一个生效的 configVersion"，是否产品口径看
`GET /v2/mining/rules.baseline.scope`。未启用模块时对应路径 `404 NOT_FOUND`。capability 总数仍为 **31**。

## 2. 通用投影

- 数字一律为无符号 decimal 字符串（`^(0|[1-9][0-9]{0,77})(\.[0-9]{1,60})?$`），用等宽字体。
- `{status: "available", value}` 与 `{status: "unavailable", reasonCode}` 二选一；前端对 unavailable 显示 `—`
  并按 reasonCode 给文案。
- `snapshot` 有值时为 `{snapshotId, blockNumber, blockHash, formulaVersion, priceVersion, computedAt}`。

### 2.1 全部 reasonCode

| reasonCode                           | 含义                                               | 出现位置                                                          |
| ------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------- |
| `MINING_FORMULA_BASELINE_PENDING`    | 没有已批准且已生效的公式版本                       | 所有数字块、`snapshot`、capability                                |
| `MINING_SNAPSHOT_NOT_AVAILABLE`      | 有生效版本但 lane 尚未算出快照                     | 所有数字块、`snapshot`                                            |
| `MINING_SNAPSHOT_STALE`              | 最新快照是在另一个版本下算的                       | 同上                                                              |
| `MINING_ACCOUNT_NOT_IN_SNAPSHOT`     | 该账号在快照里没有余额行（无激活钱包）             | `power`、`estimatedToday`、`myPosition`、`myContribution`、成员行 |
| `MINING_NETWORK_POWER_ZERO`          | 全网算力为 0，份额无定义                           | `estimatedToday`                                                  |
| `MINING_DAILY_OUTPUT_NOT_CONFIGURED` | 生效版本没有日产出预算（产品草稿）                 | `estimatedToday`                                                  |
| `MINING_RANK_NOT_RANKED`             | 本人算力为 0，没有名次                             | `myPosition`、社区 `rank`                                         |
| `MINING_RANK_NOT_APPLICABLE`         | `scope=communities` 时 `myPosition` 无意义         | `myPosition`                                                      |
| `MINING_POWER_PRIVATE`               | 对方 `miningPowerVisibility: self`                 | 成员行、关注列表 `miningPower`                                    |
| `MINING_RUNTIME_UNAVAILABLE`         | 仓储读失败                                         | 社区侧 `miningPower`、capability                                  |
| `COMMUNITY_ASSET_NOT_BOUND`          | 社区未绑定资产                                     | 社区算力四块、社区详情 `miningPower`                              |
| `COMMUNITY_WEIGHT_PENDING_REVIEW`    | 绑定了资产但生效版本下没有已批准权重               | `weight`、社区算力、`excluded`                                    |
| `COMMUNITY_WEIGHT_AMBIGUOUS`         | 两个社区在同一资产上都有已批准权重（该资产被排除） | `excluded`                                                        |
| `MINING_ASSET_WEIGHT_NOT_CONFIGURED` | 资产不在生效版本的 `assetWeights` 里               | `excluded`                                                        |
| `MINING_PRICE_NOT_FRESH`             | 没有新鲜、非代理的参考价（原生 BNB 目前如此）      | `excluded`                                                        |
| `REWARD_AUTHORITY_PENDING`           | 没有奖励账本/合约                                  | `claimable`、`accumulated`、rewards `source`                      |

HTTP 错误：`400 INVALID_REQUEST`（非法 `scope`、多余 query/body）、`401 AUTH_*`、`404 NOT_FOUND`
（社区不存在）、`503 CAPABILITY_UNAVAILABLE`（仓储不可用）。错误体固定七字段。

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
    "reasonCode": "MINING_FORMULA_BASELINE_PENDING"
  },
  "formula": {
    "status": "approved",
    "configVersion": "miningFormula-devBaseline-2026-09-15",
    "effectiveAt": "2026-09-15T14:32:19.999Z",
    "scope": "development_baseline"
  },
  "snapshot": {
    "snapshotId": "3d0a9993-fb1f-4cad-b786-04f55b90c106",
    "blockNumber": "122037728",
    "blockHash": "0x3decab82b150493d90cb8fe47b3873c6e3b8c72aecf08ce91b4aceb266bda28a",
    "formulaVersion": "miningFormula-devBaseline-2026-09-15",
    "priceVersion": "dexscreener:2026-09-15T14:32:19.293Z",
    "computedAt": "2026-09-15T14:32:21.446Z"
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
  "formulaVersion": "miningFormula-devBaseline-2026-09-15"
}
```

（`value = budget × power ÷ networkPower`，截断到 6 位小数；上例 1000000 × 1000 ÷ 4000。）

没有生效版本时 `formula = {status: "unavailable", reasonCode: "MINING_FORMULA_BASELINE_PENDING", pendingVersion}`，
其余数字块与 `snapshot` 都是 `MINING_FORMULA_BASELINE_PENDING`。

### 3.2 `GET /v2/mining/assets`（mining-assets）

```json
{
  "totalPower": { "status": "available", "value": "0" },
  "included": [
    {
      "assetId": "eip155:56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
      "holding": "0",
      "referencePriceUsd": "2.29",
      "weight": "1",
      "power": "0",
      "blockNumber": "122037728"
    },
    {
      "assetId": "eip155:56:0x55d398326f99059ff775485246999027b3197955",
      "holding": "0",
      "referencePriceUsd": "0.9994",
      "weight": "1",
      "power": "0",
      "blockNumber": "122037728"
    },
    {
      "assetId": "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
      "holding": "0",
      "referencePriceUsd": "719.47",
      "weight": "1",
      "power": "0",
      "blockNumber": "122037728"
    }
  ],
  "excluded": [
    { "assetId": "eip155:56:native", "reasonCode": "MINING_PRICE_NOT_FRESH" }
  ],
  "source": { "…快照…": "" },
  "referencePrice": {
    "status": "available",
    "priceVersion": "dexscreener:2026-09-15T14:32:19.293Z"
  },
  "contractVersion": "2.0"
}
```

`included[].weight` 是生效权重（资产权重 × 已批准社区权重）；`excluded` 是账号持有但快照未计入的资产，
原因按 lane 使用的同一输入重推。无快照时两个列表为空且三块 unavailable。资产名/符号从 Asset Registry 取。

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
        "display": {
          "kind": "alias",
          "alias": "whale",
          "publicProfileId": "…"
        },
        "isSelf": false
      },
      {
        "position": 2,
        "power": "1000",
        "display": {
          "kind": "anonymous",
          "labelKey": "mining.rank.anonymousMember"
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
    "ruleKey": "mining.rank.display.aliasOrAnonymous"
  },
  "contractVersion": "2.0"
}
```

- 只列算力 > 0 的账号/社区，最多 100 行；`rank()` 并列同名次；`participants` 为算力 > 0 的总数。
- `display.kind = "alias"` 仅当对方 `discoverable && !anonymousMode` 且有 alias；否则 `anonymous`（不给 ID）。
- `scope=communities` 时 `items[] = {position, power, community: {communityId, name, boundAssetId}, weight, participants}`，
  `myPosition` 为 `MINING_RANK_NOT_APPLICABLE`。
- 2026-09-15 Development：两种 scope `items: []`、`participants: 0`，`myPosition` 为 `MINING_RANK_NOT_RANKED`。
- `scope` 非法 → `400`。

### 3.5 `GET /v2/mining/communities/{communityId}`（mining-community）

```json
{
  "community": {
    "communityId": "d17b34a6-c3cc-4a24-87dd-dc165c80bd85",
    "name": "DeFi 早读会",
    "boundAssetId": null
  },
  "weight": {
    "status": "unavailable",
    "reasonCode": "COMMUNITY_WEIGHT_PENDING_REVIEW",
    "reviewStatus": "pending_review"
  },
  "communityPower": {
    "status": "unavailable",
    "reasonCode": "COMMUNITY_ASSET_NOT_BOUND"
  },
  "myContribution": {
    "status": "unavailable",
    "reasonCode": "COMMUNITY_ASSET_NOT_BOUND"
  },
  "rank": {
    "status": "unavailable",
    "reasonCode": "COMMUNITY_ASSET_NOT_BOUND"
  },
  "participants": {
    "status": "unavailable",
    "reasonCode": "COMMUNITY_ASSET_NOT_BOUND"
  },
  "snapshot": { "…": "" },
  "contractVersion": "2.0"
}
```

绑定资产且权重已批准时：`weight = {status: "approved", value: "0.5", configVersion, reviewedAt}`，
`communityPower = {status: "available", value}`（未封禁成员在绑定资产上的算力之和），
`myContribution`（本人在该资产上的算力）、`rank = {status: "available", position, power}`、
`participants = {status: "available", count}`。社区不存在 → `404`。

### 3.6 `GET /v2/mining/rules`（mining-rules）

```json
{
  "approved": {
    "configVersion": "miningFormula-devBaseline-2026-09-15",
    "status": "approved",
    "scope": "development_baseline",
    "effectiveAt": "2026-09-15T14:32:19.999Z",
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
    "configVersion": "miningFormula-devBaseline-2026-09-15",
    "effectiveAt": "2026-09-15T14:32:19.999Z",
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

## 4. 社区侧 `miningPower`（决策 0043）

`GET /v2/communities/{id}.miningPower`、`GET /v2/communities/{id}/members.items[].miningPower`、
`GET /v2/connections.items[].miningPower` 形状统一为：

```json
{
  "status": "available",
  "power": "230.5",
  "snapshotId": "…",
  "formulaVersion": "miningFormula-devBaseline-2026-09-15",
  "computedAt": "…"
}
```

或 `{status: "unavailable", reasonCode}`。社区详情为社区算力（同 3.5 的 `communityPower`）；成员/关注为对方个人算力，
对方 `miningPowerVisibility: self` 时为 `MINING_POWER_PRIVATE`（本人自己的行仍可见）。未启用 `mining` 模块的部署恒为
`MINING_FORMULA_BASELINE_PENDING`。

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
  "boost": { "status": "unavailable", "reasonCode": "MINING_FORMULA_BASELINE_PENDING" },
  "rules": { "configVersion": "referralRulesV1", "effectiveAt": "2026-09-01T00:00:00.000Z", "appliesTo": "miningPower", "maximumDepth": 5, "claimWindowDays": 7 },
  "contractVersion": "2.0"
}
```

- 邀请码格式 `LOOP-` + 4 位 Crockford Base32 + 1 位校验位（共 5 位）；复制到系统剪贴板。
- `binding.claimWindow`：`open`（可显示"绑定邀请码"入口）、`closed`（隐藏入口）、
  `{status: "unavailable", reasonCode: "PROFILE_ACTIVATION_REQUIRED"}`（未激活 LOOP ID）。
- 绑定后 `binding.status = "bound"`，`inviter = {depth: 1, validationStatus, lockedAt, effectiveFrom, configVersion}`
  —— **不暴露邀请人身份**。
- `levels[].counts` 按 `validationStatus` 分组；开发基线不验证边为 `valid`，`boost` 仍 unavailable。
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
pnpm mining:approve-formula miningFormula-devBaseline-2026-09-15 --confirm
pnpm mining:community-weight <communityId> <weight> --confirm        # 0.5 ≤ weight ≤ 2，社区须已绑定资产
pnpm mining:snapshot --confirm                                       # 跑一次 lane（需 DexScreener 可达）
```

社区绑定资产走 `POST/PUT /v2/communities` 的 `boundAssetKey`（社区 owner 自助）。
