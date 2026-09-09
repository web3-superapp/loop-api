# 前端联调：V2 Launch 链下目录与申请（S7 / D17 槽位）

本文是 `launch` 模块（决策 0036）的前端交接契约。权威机器契约为
`openapi/loop-api.v2.json`。通用规则（Base URL、`X-Request-ID`、错误体七字段、Bearer、
`X-Loop-Contract-Version: 2.0`、`X-Loop-Client-Version`）沿用
`docs/frontend-v2-session-api.md` 与 `docs/api-v2-conventions.md`。

覆盖页面：`launch`、`launch-detail`、`launch-tier`、`loop-stake`、`launch-trade`、
`launch-holders`、`launch-graduation`、`launch-history`、`launch-rounds`、`loop-economy`、
`launch-apply`。

## 0. 本步的硬前提

**02 合约文档未提供。** 一切链上事实（四轴状态、购买、退款、领取、vesting、建池、LP
锁定、质押）后端一律返回 `unavailable` + `LAUNCH_CONTRACT_BASELINE_PENDING`，不构造任何
Launch 交易。前端不得显示原型中的"统一 10 亿总量"、"永久 1% 生态税"、"合约地址尾号
LOOP"、"0.5% 单地址上限"、"三轮 10%/5%" 等口径；所有合约/公式相关数字显示 `—` 并标注
"待确认（configVersion）"。

## 1. 启用条件与 capability

- 后端 `V2_MODULES_ENABLED` 含 `launch`；未启用时所有路径 `404 NOT_FOUND`。
- `GET /v2/meta/capabilities` 的 `launch`：

| availability  | 条件                                   | evidence                                                                       |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `available`   | 模块启用 + 仓储已组装 + 游标密钥已配置 | **永远** `{status: "pending", reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING"}` |
| `unavailable` | `LAUNCH_RUNTIME_UNAVAILABLE`           | 同上                                                                           |
| `deferred`    | `V2_LAUNCH_RUNTIME_DEFERRED`           | 同上                                                                           |

`available` 只表示"目录与申请可用"，不是合约就绪。前端根据 `evidence.reasonCode` 把
`launch-trade` 主动作、`loop-stake` 整页、`launch-holders`/`graduation`/`history` 数据块
渲染为不可执行/unavailable。

### 1.1 Launch 链槽位（S9 / 决策 0038）

Launch 合约先在 **BSC 测试网（`eip155:97`）** 停留一段时间。后端有且只有两个链槽位：
`primary` 恒为 `eip155:56`（钱包、行情、Swap、授权、indexer 全部在此，一字不改）；
`launch` 由后端配置 `LAUNCH_CHAIN_ID` 决定，为 `eip155:56`（默认）或 `eip155:97`。

- `launch` capability 的 `evidence` 多一个字段 `launchChainId`（仅 `launch` 有）：

```json
{
  "status": "pending",
  "reasonCode": "LAUNCH_CONTRACT_BASELINE_PENDING",
  "launchChainId": "eip155:97"
}
```

- 每个 `LaunchSummary`（overview 分段、`GET /v2/launches/{id}.launch`）的 `chainId` 是该
  launch **创建时**写入的链（枚举 `eip155:56 | eip155:97`），不再是常量；未知值按
  strict 解析拒绝。同一目录里可以同时存在两种链的 launch（旧行保持 56）。
- `chainId === "eip155:97"` 时 Launch 相关页面与签名单显示"BSC 测试网"徽标与一次性说明，
  **不阻断**。行情 / Watchlist / Swap 页面永远不会出现 97。
- 测试网 tBNB 余额见 `docs/frontend-v2-wallet-api.md` §6 的 `launchChain`；链健康见
  `docs/frontend-v2-chain-api.md`。
- 本步**没有**任何可执行的 Launch 意图：`POST /v2/launch/{launchId}/intents` 仍恒
  `503 CAPABILITY_UNAVAILABLE`。将来的 Launch 签名意图的 `chainId` 只信后端 canonical
  值，Privy 签名前按意图切链；send/approve/revoke/swap 意图永远是 56。

## 2. Headers

| 接口                                                                                          | 必须                        | `Idempotency-Key`                                                                     |
| --------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| `POST /v2/launch/projects`、`POST …/{projectId}/submit`、`POST /v2/launch/{launchId}/intents` | Bearer + 两个 `X-Loop-*` 头 | **必须**（UUIDv4）；同 key 不同 body → `409 IDEMPOTENCY_CONFLICT`；同 body 回放原结果 |
| `PUT /v2/launch/projects/{projectId}`                                                         | 同上                        | **禁止**（带了 `400`）；通过 `expectedVersion` 幂等                                   |
| 所有 `GET`                                                                                    | 同上                        | **禁止**                                                                              |

`X-Loop-Platform` / `X-Loop-Device-ID` 可选，带了会校验。所有响应 `Cache-Control: no-store`。

## 3. 申请流（launch-apply）

### 3.1 `POST /v2/launch/projects` → `201`

```json
{
  "name": "MoonCat",
  "ticker": "MCAT",
  "narrative": "有故事、有传播、可持续运营的 MEME。",
  "officialLinks": { "website": "https://mooncat.example", "x": null }
}
```

- `name` 1–80 code points（去首尾空白）；`ticker` `^[A-Z0-9]{2,12}$`（前端先大写）；
  `narrative` 1–2000 或 `null`（**键必填**）；`officialLinks` **整个对象可省略**，省略等价于
  四键全 `null`；给了对象时 `website|x|telegram|discord` 各为 `https://` URL（≤512，不含
  凭据）或 `null`，缺省的键视为 `null`。未知键 `400`。
- 附件与 KYB 无 Provider：响应中 `attachments = {status: "unavailable", reasonCode:
"ATTACHMENT_STORAGE_NOT_SELECTED"}`、`kyb = {status: "unavailable", state: "unavailable",
reasonCode: "KYB_PROVIDER_NOT_SELECTED"}`；页面显示"待接入"，不提供上传。

响应（所有项目接口共用）：

```json
{
  "project": {
    "projectId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "name": "MoonCat",
    "ticker": "MCAT",
    "narrative": "…",
    "officialLinks": {
      "website": "https://mooncat.example",
      "x": null,
      "telegram": null,
      "discord": null
    },
    "materialVersion": 1,
    "reviewStatus": "draft",
    "reviewReasonCode": null,
    "kyb": {
      "status": "unavailable",
      "state": "unavailable",
      "reasonCode": "KYB_PROVIDER_NOT_SELECTED"
    },
    "attachments": {
      "status": "unavailable",
      "reasonCode": "ATTACHMENT_STORAGE_NOT_SELECTED"
    },
    "submittedAt": null,
    "reviewedAt": null,
    "launchId": null,
    "version": 1,
    "createdAt": "2026-09-08T01:00:00.000Z",
    "updatedAt": "2026-09-08T01:00:00.000Z",
    "configVersion": "launchCatalogV1"
  },
  "contractVersion": "2.0"
}
```

### 3.2 `PUT /v2/launch/projects/{projectId}`（CAS）

```json
{
  "expectedVersion": 1,
  "project": {
    "name": "…",
    "ticker": "MCAT",
    "narrative": null,
    "officialLinks": {}
  }
}
```

- 只允许 `reviewStatus ∈ {draft, returned}`，否则 `409 DATA_STALE`。
- `expectedVersion` 过期 → `409 VERSION_CONFLICT`（重新 GET 再提交）；每次成功 `version`
  与 `materialVersion` 都 +1。
- `project` 是**整体替换**：`officialLinks` 可省略（= 四键全 `null`），但"没改链接就不传"会
  把链接清空——要保留链接必须原样回传。
- 非本人项目 → `404`。

### 3.3 `POST /v2/launch/projects/{projectId}/submit`

`draft | returned → submitted`；其他状态 `409 DATA_STALE`。提交不代表通过；审核推进仅由
Dev 脚本 `pnpm launch:review`（写审计）完成，前端轮询 `GET` 看 `reviewStatus`：

| reviewStatus | 页面状态                                        |
| ------------ | ----------------------------------------------- |
| `draft`      | 可编辑、可提交                                  |
| `submitted`  | 只读，"审核中"                                  |
| `in_review`  | 只读，"审核中"                                  |
| `returned`   | 可编辑、可重提；`reviewReasonCode` 显示退回原因 |
| `approved`   | 只读；`launchId` 非空 → 进入目录                |
| `rejected`   | 只读；不可重提                                  |

### 3.4 `GET /v2/launch/projects?status=&limit=&cursor=`

`status ∈ all|draft|submitted|in_review|returned|approved|rejected`（默认 `all`），
`limit` 1–50（默认 20）；`cursor` 与 `limit` 互斥、绑定 owner/路由/`status`。最后一页
`nextCursor: null`（v2 列表统一语义）。

### 3.5 `GET /v2/launch/projects/{projectId}`

本人可见任何状态；他人只可见 `approved`，且非本人投影中 `reviewReasonCode`、`submittedAt`、
`reviewedAt`、`version` 一律为 `null`（审核轨迹与 CAS 版本只属于申请人）；否则 `404`。

## 4. 目录与详情

### 4.1 `GET /v2/launch/overview`（launch）

```json
{
  "segments": { "live": [], "upcoming": [], "awaitingSchedule": [ { …LaunchSummary } ], "ended": [] },
  "graduated": { "status": "unavailable", "reasonCode": "LAUNCH_CONTRACT_BASELINE_PENDING" },
  "myEligibility": { "status": "unavailable", "reasonCode": "TIER_MODE_PENDING" },
  "staking": { "status": "unavailable", "reasonCode": "STAKING_CONTRACT_PENDING" },
  "catalog": { "configVersion": "launchCatalogV1", "source": "loop_db", "observedAt": "…" },
  "contractVersion": "2.0"
}
```

`LaunchSummary`：

```json
{
  "launchId": "…",
  "projectId": "…",
  "name": "MoonCat",
  "ticker": "MCAT",
  "chainId": "eip155:56",
  "contractAddress": null,
  "configDigest": null,
  "scheduleStatus": "unscheduled",
  "onChainState": {
    "saleState": "unavailable",
    "entitlementState": "unavailable",
    "liquidityState": "unavailable",
    "operationalState": "unavailable",
    "stateTupleDigest": null,
    "snapshotBlockNumber": null,
    "snapshotBlockHash": null,
    "source": "unavailable",
    "reasonCode": "LAUNCH_CONTRACT_BASELINE_PENDING"
  },
  "configVersion": null,
  "createdAt": "…"
}
```

- 分段只按 `scheduleStatus`：`live` = `live`；`upcoming` = `scheduled`；
  `awaitingSchedule` = `unscheduled`（已批准、未排期，独立分段，**不得**并入"即将开始"）；
  `ended` = `ended`。"已毕业"是流动性轴的投影，本步恒 unavailable，**不要**用
  `scheduleStatus` 推断。
- `contractAddress` 恒 `null`，`configVersion` 为已确认配置版本或 `null`（显示"待确认"）。
- `chainId` 是该 launch 创建时的链槽位（`eip155:56 | eip155:97`，§1.1）；`eip155:97`
  时显示"BSC 测试网"徽标。

### 4.2 `GET /v2/launches/{launchId}`（launch-detail / launch-rounds / launch-graduation）

```json
{
  "launch": { …LaunchSummary },
  "project": { "projectId": "…", "name": "…", "ticker": "…", "narrative": "…", "officialLinks": {…}, "materialVersion": 2 },
  "config": {
    "configVersion": "launchMoonCatV1",
    "status": "pending_confirmation",
    "effectiveAt": null,
    "slots": {
      "walletRoundCap": { "status": "unavailable", "reasonCode": "LAUNCH_CONFIG_PENDING_CONFIRMATION" },
      "walletProjectCap": {…}, "feeBps": {…}, "softCap": {…}, "hardCap": {…}, "tge": {…}, "vesting": {…},
      "tierModeV1": {…}
    }
  },
  "configPending": { "status": "unavailable", "reasonCode": "LAUNCH_CONFIG_PENDING_CONFIRMATION" },
  "rounds": [
    { "roundId": "…", "roundIndex": 1, "configVersion": "launchMoonCatV1", "status": "pending_confirmation",
      "startsAt": null, "endsAt": null, "priceUsd1": null, "eligibilityTier": null, "walletRoundCapRaw": null }
  ],
  "graduation": {
    "steps": [
      { "step": "stop_internal_trading", "status": "pending" },
      { "step": "prepare_pool", "status": "pending" },
      { "step": "add_and_lock_liquidity", "status": "pending" },
      { "step": "open_external_trading", "status": "pending" }
    ],
    "poolEvidence": { "status": "unavailable", "reasonCode": "LAUNCH_POOL_EVIDENCE_UNAVAILABLE" }
  },
  "market": { "status": "unavailable", "reasonCode": "LAUNCH_CONTRACT_BASELINE_PENDING" },
  "holders": { "status": "unavailable", "reasonCode": "LAUNCH_CONTRACT_BASELINE_PENDING" },
  "contractVersion": "2.0"
}
```

- `config` 可为 `null`（无任何配置行）；`configPending` 非 `null` 表示无已确认版本，页面每个
  槽位显示"待确认（configVersion）"。已确认槽位形如 `{status: "confirmed", value: "…"}`，
  值一律字符串。
- `rounds` 从配置槽位渲染 `1..N`，字段为 `null` 即"待确认"。
- 毕业四步恒 `pending`；`LoopTokenCard.graduated` 去掉"生态税"指标。

### 4.3 `GET /v2/launch/{launchId}/eligibility`（launch-tier）

```json
{
  "launchId": "…",
  "mode": "unavailable",
  "result": {
    "tier": null,
    "reasonCode": "TIER_MODE_PENDING",
    "snapshotBlock": null
  },
  "configVersion": null,
  "effectiveAt": null,
  "dependsOnStaking": false,
  "contractVersion": "2.0"
}
```

`mode ∈ whitelist|community|activity|unavailable` 来自已确认配置的 `tierModeV1` 槽位；有模式但
无合约时 `result.reasonCode = LAUNCH_CONTRACT_BASELINE_PENDING`。**资格不依赖质押**。

### 4.4 `GET /v2/launch/stake`（loop-stake）

恒 `{"stake": {"status": "unavailable", "reasonCode": "STAKING_CONTRACT_PENDING"}, "executable": false}`；
整页不可执行。

### 4.5 `POST /v2/launch/{launchId}/intents`（launch-trade）

请求体 `{walletId, roundId, payAmount}`（`payAmount` 为**字符串**，数字 `400`）；
本步**恒 `503 CAPABILITY_UNAVAILABLE`**（reasonCode `LAUNCH_CONTRACT_BASELINE_PENDING` 通过
capability evidence 表达）。表单可见、主动作禁用并说明；未毕业只买不卖，无卖出接口。

### 4.6 `GET /v2/launch/{launchId}/holders`（launch-holders）

`holders`、`myPosition`、`walletCap` 全部 unavailable。

### 4.7 `GET /v2/launch/{launchId}/history`（launch-history）

```json
{
  "launchId": "…",
  "purchaseRecords": [],
  "entitlements": [],
  "refunds": [],
  "source": {
    "status": "unavailable",
    "reasonCode": "LAUNCH_CONTRACT_BASELINE_PENDING"
  },
  "contractVersion": "2.0"
}
```

空列表 + `source: unavailable` 表示"无法证明"，不是"无参与"；显示 unavailable 块。

### 4.8 `GET /v2/launch/projects/{projectId}/milestones`

```json
{
  "projectId": "…",
  "items": [
    {
      "venueMilestoneId": "…",
      "venue": "lbank",
      "marketType": "spot",
      "state": "APPLIED",
      "evidence": {
        "digest": null,
        "recordedAt": null,
        "observedAt": null,
        "reviewer": null
      },
      "version": 2,
      "updatedAt": "…"
    }
  ],
  "contractVersion": "2.0"
}
```

`venue ∈ lbank|binance|bithumb`，`marketType ∈ spot|alpha|perpetual`，
`state ∈ PREPARING|APPLIED|EVIDENCE_PENDING|LISTED|FEATURED|REJECTED|DEFERRED|EVIDENCE_INVALID|DELISTED`。
只有 `LISTED/FEATURED` 带证据 digest/时间/复核人；Alpha 不等于现货，不可互推。
`evidence.recordedAt` = 复核人记录证据时的服务端时钟；`evidence.observedAt` = 操作员提供的
"证据在平台上可核验的时间"（可空，不从 `recordedAt` 推导）；页面把两者分开显示。

**隐式 `PREPARING` 行**：03 §8.4 的五条赛道（`lbank/spot`、`binance/alpha`、`binance/perpetual`、
`binance/spot`、`bithumb/spot`）**总是**出现在 `items` 里。没有落库记录的赛道以隐式行下发：
`venueMilestoneId: null`、`state: "PREPARING"`、`evidence` 四键全 `null`（含 `recordedAt: null`）、
`version: 0`、`updatedAt: null`。已落库的行在前（按更新时间倒序），隐式行随后按上面顺序。
页面因此不需要用"空列表"推断"尚未申请"；`venueMilestoneId === null` 即"尚无记录"。

**状态转换表**（`pnpm launch:milestone` 只接受下面的迁移，否则脚本以
`launch_milestone_failed` 退出；页面不用发起转换，但据此理解为什么某状态"跳不过去"）：

| 当前               | 可转到                                               |
| ------------------ | ---------------------------------------------------- |
| `PREPARING`        | `APPLIED`、`DEFERRED`                                |
| `APPLIED`          | `EVIDENCE_PENDING`、`REJECTED`、`DEFERRED`           |
| `EVIDENCE_PENDING` | `LISTED`、`FEATURED`、`EVIDENCE_INVALID`、`REJECTED` |
| `EVIDENCE_INVALID` | `EVIDENCE_PENDING`、`REJECTED`                       |
| `LISTED`           | `FEATURED`、`DELISTED`                               |
| `FEATURED`         | `LISTED`、`DELISTED`                                 |
| `REJECTED`         | `APPLIED`                                            |
| `DEFERRED`         | `PREPARING`、`APPLIED`                               |
| `DELISTED`         | —（终态）                                            |

`LISTED` / `FEATURED` 必须经过 `EVIDENCE_PENDING`，且记录时必须带证据与复核人（§6）。

### 4.9 `GET /v2/launch/economy`（loop-economy）

```json
{
  "projects": { "draft": 1, "submitted": 0, "in_review": 0, "returned": 0, "approved": 1, "rejected": 0 },
  "launches": { "unscheduled": 1, "scheduled": 0, "live": 0, "ended": 0 },
  "confirmedRoundCount": 0,
  "totalSupply": { "status": "unavailable", "reasonCode": "LAUNCH_ECONOMY_CONTRACT_PENDING" },
  "distributed": {…}, "ecosystemTax": {…},
  "source": "loop_db", "observedAt": "…", "contractVersion": "2.0"
}
```

## 5. 错误码

| 场景                                                  | 状态 / code                  |
| ----------------------------------------------------- | ---------------------------- |
| 缺/多/坏 header、未知字段、坏 ticker/链接、金额为数字 | `400 INVALID_REQUEST`        |
| 项目不存在或不可见、launch 不存在                     | `404 NOT_FOUND`              |
| CAS 版本过期                                          | `409 VERSION_CONFLICT`       |
| 状态不允许（编辑/提交）                               | `409 DATA_STALE`             |
| 同 key 不同 body                                      | `409 IDEMPOTENCY_CONFLICT`   |
| Intent                                                | `503 CAPABILITY_UNAVAILABLE` |
| 仓储/游标密钥缺失                                     | `503 CAPABILITY_UNAVAILABLE` |

## 6. 联调脚本（Dev）

- `pnpm launch:review <projectId> approve` → 目录出现该 launch（`unscheduled`）。
- `pnpm launch:milestone <projectId> lbank spot APPLIED`；`… LISTED --evidence <url> --reviewer ops.alice [--observed-at 2026-09-01T08:00:00+08:00]`。
  - **`--evidence` 与 `--reviewer` 必须成对**出现（缺一即
    `launch_milestone_arguments_invalid`）；`--observed-at` 只有在给了 `--evidence` 时才被
    接受（RFC 3339）。`LISTED` / `FEATURED` 必须带这一对；其他状态可以不带。
  - `--reviewer` 形如 `^[a-z][a-z0-9_.-]{0,63}$`；证据引用只存 SHA-256 digest，原文不落库。
  - 不在上表的迁移（例如 `APPLIED → FEATURED`）→ `launch_milestone_failed`。
- 两者在 `NODE_ENV=production` 下拒绝执行。
