# 前端联调：V2 Mining 骨架与邀请关系（S7 / D18 + D19）

本文是 `mining` 与 `referral` 两个模块（决策 0036）的前端交接契约。权威机器契约为
`openapi/loop-api.v2.json`。通用规则沿用 `docs/frontend-v2-session-api.md` 与
`docs/api-v2-conventions.md`。

覆盖页面：`mining`、`mining-assets`、`mining-rewards`、`mining-rank`、`mining-community`、
`mining-rules`、`referral`。

## 0. 本步的硬前提

**没有已批准的 Mining 公式版本**（03 §19）。所有算力、产量、累计、待领取、排行、加成一律
`{status: "unavailable", reasonCode}`；规则页只展示 `pending_approval` 的版本并标注"待批准"。
权重范围与 TWAP 价格保护只有规则 key（文案），没有数值；前端不得写死 1.0×、0.1×–1.0×、
10%/5%/3%/2%/1% 以外的任何比例，也不得显示奖励额、年化或释放承诺。

## 1. 启用条件与 capability

| capabilityId | availability 条件                             | evidence（恒定）                                                     |
| ------------ | --------------------------------------------- | -------------------------------------------------------------------- |
| `mining`     | `V2_MODULES_ENABLED` 含 `mining` + 仓储已组装 | `{status: "pending", reasonCode: "MINING_FORMULA_BASELINE_PENDING"}` |
| `referral`   | 含 `referral` + 仓储已组装                    | 同上（加成依赖公式）                                                 |

未启用时对应路径 `404 NOT_FOUND`。`GET /v2/mining/referral/rules` 已从 `community` 模块移入
`mining` 模块（路径不变）：只启用 `community` 的部署不再有该路径。移动端 capability 枚举需新增
`referral`（S8 合并后共 **31** 项；以 `GET /v2/meta/capabilities` 实际数量为准，不要写死）。

## 2. Headers

`POST /v2/referral/claim` 必须带 UUIDv4 `Idempotency-Key`；所有 `GET` 禁止带。
`X-Loop-Platform` / `X-Loop-Device-ID` 可选。所有响应 `Cache-Control: no-store`。

## 3. Mining 读接口（全部 unavailable）

### 3.1 `GET /v2/mining/summary`（mining）

```json
{
  "power": { "status": "unavailable", "reasonCode": "MINING_FORMULA_BASELINE_PENDING" },
  "networkPower": {…}, "estimatedToday": {…}, "accumulated": {…},
  "claimable": { "status": "unavailable", "reasonCode": "REWARD_AUTHORITY_PENDING" },
  "referralBoost": { "status": "unavailable", "reasonCode": "MINING_FORMULA_BASELINE_PENDING" },
  "formula": { "status": "unavailable", "reasonCode": "MINING_FORMULA_BASELINE_PENDING", "pendingVersion": "miningFormulaV1-draft" },
  "snapshot": { "status": "unavailable", "reasonCode": "MINING_SNAPSHOT_NOT_AVAILABLE" },
  "contractVersion": "2.0"
}
```

`formula.pendingVersion` 用于"待批准（miningFormulaV1-draft）"标注。`snapshot` 一旦存在为
`{snapshotId, blockNumber, blockHash, formulaVersion, priceVersion, computedAt}`（本步不会出现）。

### 3.2 `GET /v2/mining/assets`（mining-assets）

`totalPower`/`source`/`referencePrice` unavailable，`included`/`excluded` 恒为空数组（按契约为空，
不是"无持仓"）。

### 3.3 `GET /v2/mining/rewards`（mining-rewards）

`claimable` `REWARD_AUTHORITY_PENDING`，`claimExecutable: false`（领取按钮禁用），`ledger: []`。

### 3.4 `GET /v2/mining/rank?scope=users|communities`（mining-rank）

```json
{
  "scope": "users",
  "ranking": { "status": "unavailable", "reasonCode": "MINING_FORMULA_BASELINE_PENDING" },
  "myPosition": {…},
  "snapshot": {…},
  "display": { "anonymousMemberKey": "mining.rank.anonymousMember", "ruleKey": "mining.rank.display.aliasOrAnonymous" },
  "contractVersion": "2.0"
}
```

**匿名显示规则（写入契约）**：排行条目将来只在该账号 `discoverable = true` 且
`anonymousMode = false` 时显示 alias，否则显示 `mining.rank.anonymousMember`（"匿名成员"）。
`scope` 非法 → `400`。

### 3.5 `GET /v2/mining/communities/{communityId}`（mining-community）

```json
{
  "community": { "communityId": "…", "name": "Frog Holders", "boundAssetId": null },
  "weight": { "status": "unavailable", "reasonCode": "COMMUNITY_WEIGHT_PENDING_REVIEW", "reviewStatus": "pending_review" },
  "communityPower": {…}, "myContribution": {…}, "rank": {…}, "participants": {…},
  "contractVersion": "2.0"
}
```

审核通过后 `weight = {status: "approved", value: "0.35", configVersion, reviewedAt}`（值为字符串）。
社区不存在 → `404`。

### 3.6 `GET /v2/mining/rules`（mining-rules）

```json
{
  "approved": null,
  "pendingApproval": [
    {
      "configVersion": "miningFormulaV1-draft",
      "status": "pending_approval",
      "effectiveAt": null, "approvedAt": null,
      "expressionKey": "mining.rules.formula.holdingTimesReferencePriceTimesWeight",
      "dailyOutputKey": "mining.rules.dailyOutput.shareOfNetworkPower",
      "weightRange": {
        "loop": { "status": "pending_approval", "descriptionKey": "mining.rules.weight.loopFixedMaximum" },
        "community": { "status": "pending_approval", "descriptionKey": "mining.rules.weight.communityReviewed" },
        "reviewFactorKeys": ["mining.rules.reviewFactor.communityQuality", "…"]
      },
      "priceGuardRules": [
        { "ruleKey": "mining.rules.priceGuard.twap", "status": "pending_approval" },
        { "ruleKey": "mining.rules.priceGuard.multiPeriodMultiSource", "status": "pending_approval" },
        { "ruleKey": "mining.rules.priceGuard.liquidityCap", "status": "pending_approval" }
      ],
      "referralBoost": { "status": "pending_approval" }
    }
  ],
  "baseline": { "status": "unavailable", "reasonCode": "MINING_FORMULA_BASELINE_PENDING" },
  "referral": { "configVersion": "referralRulesV1", "effectiveAt": "2026-09-01T00:00:00.000Z", "levels": [ {"level":1,"boostPercent":"10","descriptionKey":"mining.referral.level1"}, … ] },
  "contractVersion": "2.0"
}
```

前端用 key 渲染文案（公式 = 持有量 × 参考价 × 权重；每日产出 = 我的算力 ÷ 全网算力 × 当日产量），
不得补数字。

### 3.7 `GET /v2/mining/referral/rules`

与 S3 相同的静态快照（`edges`/`inviteCode` 字段仍为 unavailable；真实数据走 `GET /v2/referral`）。

## 4. 邀请关系（referral）

### 4.1 `GET /v2/referral`

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
- `levels[].counts` 按 `validationStatus` 分组；本步不会出现 `valid`（需 D19 公式批准），
  页面统计"有效关系"时只可用 `valid`，其余显示为"待验证"。
- 一切表述为 "Mining Power 加成"，禁止"返佣/分红/下线收入"。

### 4.2 `POST /v2/referral/claim`

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

## 5. Dev 脚本

`pnpm mining:approve-formula <configVersion> --confirm` 是唯一能让 `mining-snapshot` lane 计算的入口，
在 `NODE_ENV=production` 下拒绝执行；本步不会执行它。
