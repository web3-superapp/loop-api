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

- **只有** `LAUNCH_CHAIN_ID=97` 时 `launch` capability 的 `evidence` 多一个 optional
  字段 `launchChainId`（仅 `launch` 有；槽位共享时缺席，`evidence` 与 S7 完全相同）：

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
    "reviewReasonText": null,
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
| `returned`   | 可编辑、可重提；退回原因显示 `reviewReasonText` |
| `approved`   | 只读；`launchId` 非空 → 进入目录                |
| `rejected`   | 只读；不可重提                                  |

### 3.4 `GET /v2/launch/projects?status=&limit=&cursor=`

`status ∈ all|draft|submitted|in_review|returned|approved|rejected`（默认 `all`），
`limit` 1–50（默认 20）；`cursor` 与 `limit` 互斥、绑定 owner/路由/`status`。最后一页
`nextCursor: null`（v2 列表统一语义）。

### 3.5 `GET /v2/launch/projects/{projectId}`

本人可见任何状态；他人只可见 `approved`，且非本人投影中 `reviewReasonCode`、
`reviewReasonText`、`submittedAt`、`reviewedAt`、`version` 一律为 `null`（审核轨迹与 CAS
版本只属于申请人）；否则 `404`。

### 3.6 审核原因：`reviewReasonCode` 与 `reviewReasonText`（决策 0041）

两个字段并列返回，`reviewReasonText` 为 `null` 当且仅当 `reviewReasonCode` 为 `null`：

| 字段               | 用途                                                         |
| ------------------ | ------------------------------------------------------------ |
| `reviewReasonCode` | 机器可读契约：埋点、日志、客户端分支判断。**不得上屏**       |
| `reviewReasonText` | 同一个 code 的展示投影：一句中文，**原样渲染**，不得反向解析 |

`reviewReasonText` 由后端生成，句子内容可能随文案调整而变化；客户端不得从 text 反推 code、
不得按 text 做分支、不得再自行把 code 翻译成人话。需要分支时读 `reviewStatus` 或
`reviewReasonCode`。

后端当前的取值（catalog 内的 code 只在它所属的状态上生效，其余一律落到该状态的兜底句，
因此屏幕上永远不会出现内部标识符）：

| `reviewStatus` | `reviewReasonCode`           | `reviewReasonText`                                               |
| -------------- | ---------------------------- | ---------------------------------------------------------------- |
| 任意           | `null`                       | `null`                                                           |
| `returned`     | `needs_more_material`        | 材料还不完整，补齐后可以重新提交审核。                           |
| `returned`     | `official_links_unreachable` | 官方链接无法访问或核对，换成可访问的链接后可以重新提交。         |
| `returned`     | `material_mismatch`          | 名称、代币符号与简介之间对不上，改一致后可以重新提交。           |
| `returned`     | `ticker_conflict`            | 这个代币符号已被占用，换一个后可以重新提交。                     |
| `rejected`     | `duplicate_submission`       | 同一个项目已经有一份申请在审核，这份重复申请不再处理。           |
| `rejected`     | `policy_violation`           | 材料不符合上线规则，这份申请不会继续；调整后可以新建项目再提交。 |
| `draft`        | 其它任意 code                | 项目还是草稿，材料填完就可以提交审核。                           |
| `submitted`    | 其它任意 code                | 材料已提交，审核期间不能修改，有结果后状态会更新。               |
| `in_review`    | 其它任意 code                | 材料正在审核，这期间不能修改，有结果后状态会更新。               |
| `returned`     | 其它任意 code                | 材料被退回，修改后可以重新提交审核。                             |
| `approved`     | 其它任意 code                | 审核已通过，材料不再可改，可以继续后面的发行安排。               |
| `rejected`     | 其它任意 code                | 审核未通过，这份申请不能再提交，需要的话可以新建项目。           |

"其它任意 code" 包含运维脚本的默认值 `operator_manual_review`：它不带信息，按状态出句子。

## 4. 目录与详情

### 4.1 `GET /v2/launch/overview`（launch）

```json
{
  "segments": { "live": [], "upcoming": [], "awaitingSchedule": [ { …LaunchSummary } ], "ended": [] },
  "graduated": { "status": "unavailable", "reasonCode": "LAUNCH_CONTRACT_BASELINE_PENDING" },
  "myEligibility": { "status": "unavailable", "reasonCode": "TIER_MODE_PENDING" },
  "staking": { "status": "unavailable", "reasonCode": "STAKING_CONTRACT_PENDING" },
  "catalog": { "configVersion": "launchCatalogV1", "source": "loop", "observedAt": "…" },
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
  "source": "loop", "observedAt": "…", "contractVersion": "2.0"
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

## S83a：合约适配层与 `available` 分支（决策 0076）

接口基线改为 `LOOP/docs/06-Launch合约接口需求.md`（LOOP 自定义合约接口）。本节只描述
**线上字节的变化规则**；机器契约仍以 `openapi/loop-api.v2.json` 为准。

### S83a.1 硬规则：`unavailable` 分支字节不变

- 后端四个配置键（`LAUNCH_CONTRACT_ADDRESS` / `LAUNCH_CONTRACT_VERSION` /
  `LAUNCH_CONTRACT_START_BLOCK` / `LAUNCH_USD1_ADDRESS`）**全空**时，下列接口的响应与
  S83a 之前**逐字节相同**（回归测试
  `test/v2-launch-contract-routes.test.ts` › "keeps every Launch response
  byte-identical to 1ab26d7 while no contract is configured"，基线在
  `test/fixtures/s83a-baseline/`）：`GET /v2/launch/overview`、
  `GET /v2/launches/{launchId}`、`GET /v2/launch/{launchId}/eligibility`、
  `…/holders`、`…/history`、`POST …/intents`（`503`）。
- 每个改动的槽位都是**判别联合**：旧对象原样保留为一个分支，新增一个 `available`
  分支。判别字段用旧对象**已有**的字段，所以旧分支不多一个键：

| 槽位                                   | 判别字段         | 旧分支（不变）                                      | 新分支                                           |
| -------------------------------------- | ---------------- | --------------------------------------------------- | ------------------------------------------------ |
| `launch.onChainState`（四轴）          | `source`         | `"unavailable"`                                     | `"chain"`                                        |
| `launch.contractAddress`               | 类型             | `null`                                              | `0x` + 40 位小写十六进制                         |
| `config`（launches 详情）              | `status`         | `pending_confirmation` / `confirmed`（LOOP 配置槽） | `"available"`（合约 `getSaleConfig`）            |
| `rounds[]`（launches 详情）            | `status`         | `pending_confirmation` / `confirmed`（LOOP 轮次槽） | `"available"`（合约 `getRounds`）                |
| eligibility `result`                   | 有无 `status` 键 | `{tier: null, reasonCode, snapshotBlock: null}`     | `{status: "available", …}`（S83b 起）            |
| holders `holders/myPosition/walletCap` | `status`         | `unavailable`                                       | `available`（S83b 起）                           |
| history `source`                       | `status`         | `unavailable`（三个数组恒空）                       | `available`（S83b 起，数组有元素）               |
| `POST …/intents`                       | HTTP 状态        | `503 CAPABILITY_UNAVAILABLE`（错误体七字段不变）    | `201 {launchIntent, contractVersion}`（S83b 起） |

- 解码器要求：**先按判别字段选分支，再严格解码**；两个分支都 `additionalProperties:
false`。金额（`*Usd1`、`*Tokens`、`priceUsd1PerToken`）一律十进制整数字符串（18 位
  最小单位）；区块号是十进制字符串；`bps/seconds/poolFeeTier/roundIndex` 是 JSON 整数
  （uint16/uint24/uint32，不是金额）。

### S83a.2 本单实际会返回 `available` 的只有 `GET /v2/launches/{launchId}`

条件：四个键全配、启动时 `eth_getCode` 看到代码、launch 链槽位 `eth_chainId` 核对通过、
该 launch 行已登记 `saleId` 且登记的合约地址/版本与配置一致。此时四轴、`rounds`、
`config` **在同一个区块**读出（`onChainState.snapshotBlockNumber/Hash`），`configPending`
为 `null`：

```json
{
  "launch": {
    "launchId": "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
    "projectId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "name": "MoonCat",
    "ticker": "MCAT",
    "chainId": "eip155:97",
    "contractAddress": "0x1111111111111111111111111111111111111111",
    "configDigest": null,
    "scheduleStatus": "scheduled",
    "onChainState": {
      "saleState": "LIVE",
      "entitlementState": "NONE",
      "liquidityState": "NOT_STARTED",
      "operationalState": "ACTIVE",
      "stateTupleDigest": "0xcdcd…cdcd",
      "snapshotBlockNumber": "45000000",
      "snapshotBlockHash": "0x1212…1212",
      "configVersion": "0xabab…abab",
      "source": "chain",
      "reasonCode": null
    },
    "configVersion": null,
    "createdAt": "2026-09-08T01:00:00.000Z"
  },
  "config": {
    "status": "available",
    "projectToken": "0x3333333333333333333333333333333333333333",
    "usd1": "0x2222222222222222222222222222222222222222",
    "softCapUsd1": "20000000000000000000000",
    "hardCapUsd1": "100000000000000000000000",
    "walletProjectCapUsd1": "1000000000000000000000",
    "minPurchaseUsd1": "10000000000000000000",
    "protocolFeeBps": 300,
    "liquidityBps": 5000,
    "tgeBps": 2500,
    "cliffSeconds": 0,
    "vestingSeconds": 7776000,
    "poolFeeTier": 2500,
    "lpLockSeconds": 31536000,
    "configVersion": "0xabab…abab"
  },
  "configPending": null,
  "rounds": [
    {
      "status": "available",
      "roundId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      "roundIndex": 1,
      "startAt": "2026-09-21T14:13:20.000Z",
      "endAt": "2026-09-23T14:13:20.000Z",
      "priceUsd1PerToken": "10000000000000000",
      "roundCapUsd1": "40000000000000000000000",
      "walletRoundCapUsd1": "500000000000000000000",
      "allowlistRoot": "0xefef…efef",
      "raisedUsd1": "1234000000000000000000"
    }
  ],
  "graduation": { "…": "不变，四步仍 pending" },
  "market": {
    "status": "unavailable",
    "reasonCode": "LAUNCH_CONTRACT_BASELINE_PENDING"
  },
  "holders": {
    "status": "unavailable",
    "reasonCode": "LAUNCH_CONTRACT_BASELINE_PENDING"
  },
  "contractVersion": "2.0"
}
```

（示例数值取自测试夹具，仅示意格式，不是产品参数。）

- 四轴取值即 06 §2 的名字：`saleState ∈ SCHEDULED|LIVE|ENDED|SUCCEEDED|FAILED|CANCELLED`，
  `entitlementState ∈ NONE|FROZEN|VESTING|COMPLETED|REFUNDING|REFUNDED`，
  `liquidityState ∈ NOT_STARTED|PREPARING|V3_LIVE|LP_LOCKED|COMPLETED|RETRY_SCHEDULED`，
  `operationalState ∈ ACTIVE|PAUSED`。"毕业中/已毕业"只能由前端从四轴只读组合（03 §8.3），
  后端不发第五条轴。
- `stateTupleDigest`、`configVersion` 是合约原值（bytes32），后端不重算。
- **轮次 ID**：合约的 `roundId`（uint16）在线上叫 `roundIndex`；`roundId` 仍是 LOOP 的
  opaque 轮次 ID（与 `launch_rounds.roundIndex` 相同序号的那一行），没有对应行时为
  `null`。`POST …/intents` 请求体里的 `roundId` 继续是 opaque ID。
- `allowlistRoot` 全 0 表示该轮不设资格。
- `startAt/endAt` 由合约 unix 秒转为 RFC 3339 UTC。

### S83a.3 读链失败：回到 `unavailable` 分支，给出原因

合约已配置但读不到时，`onChainState` 仍是 `source: "unavailable"` 的旧形状，
`reasonCode` 说明原因；`rounds`/`config`/`configPending` 回到 LOOP 自己的槽位（与未配置时
相同）；`contractAddress` 为 `null`。

| reasonCode                             | 含义                                               | 前端处理         |
| -------------------------------------- | -------------------------------------------------- | ---------------- |
| `LAUNCH_CONTRACT_BASELINE_PENDING`     | 未配置合约（与之前完全相同）                       | 显示"待确认"     |
| `LAUNCH_CONTRACT_VERIFICATION_PENDING` | 已配置，尚未观察到合约代码                         | 稍后刷新         |
| `LAUNCH_CONTRACT_CODE_MISSING`         | 配置地址上没有合约代码                             | 不可用，联系运营 |
| `LAUNCH_CONTRACT_VERSION_UNSUPPORTED`  | 合约主版本不是 1                                   | 不可用           |
| `LAUNCH_CHAIN_RPC_NOT_CONFIGURED`      | launch 链槽位没有 RPC                              | 不可用           |
| `LAUNCH_CHAIN_ID_MISMATCH`             | RPC 返回的链不是配置的链                           | 不可用           |
| `LAUNCH_CHAIN_RPC_UNREACHABLE`         | RPC 不可达                                         | 可重试           |
| `LAUNCH_SALE_NOT_REGISTERED`           | 该 launch 尚未登记 `saleId`                        | 显示"待上链"     |
| `LAUNCH_SALE_CONTRACT_MISMATCH`        | 登记的合约地址/版本与当前配置不一致                | 不可用           |
| `LAUNCH_SALE_NOT_FOUND`                | 合约上没有这个 `saleId`                            | 不可用           |
| `LAUNCH_CONFIG_VERSION_MISMATCH`       | 链上 `configVersion` 与预期不一致                  | 不可用           |
| `LAUNCH_USD1_ADDRESS_MISMATCH`         | sale 的结算币不是配置的 USD1                       | 不可用           |
| `LAUNCH_CONTRACT_READ_FAILED`          | 读合约失败                                         | 可重试           |
| `LAUNCH_CONTRACT_READ_INVALID`         | 返回值无法解码或越界（枚举超范围等）               | 不可用           |
| `LAUNCH_SNAPSHOT_REORGED`              | 读取期间快照区块被重组                             | 可重试           |
| `LAUNCH_ONCHAIN_STATE_NOT_INDEXED`     | 仅出现在**列表**：列表不逐个读链，等 S83b 事件索引 | 进入详情查看     |

`GET /v2/launch/overview` 永不读链；合约可用且该 launch 已登记时，列表项会带
`contractAddress`，但 `onChainState` 为 `unavailable` + `LAUNCH_ONCHAIN_STATE_NOT_INDEXED`。

### S83a.4 其余接口：只加了 schema，本单行为不变

以下 `available` 分支已进 OpenAPI，便于 S83c 先写解码器；**S83b 之前没有任何路径会返回它们**：

- eligibility `result`：`{status: "available", tier: priority|community|public|null,
reasonCode|null, snapshotBlock: "区块号", roundIndex, allowlistRoot, eligibilityProof: [bytes32…]}`。
  `eligibilityProof` 原样作为 `buy()` 的最后一个参数。
- holders：`holders = {status: "available", holderCount, indexedBlockNumber}`；
  `myPosition = {status: "available", walletId, cumulativeUsd1, purchasedTokens,
entitledTokens, claimableTokens, claimedTokens, refundableUsd1, refundedUsd1,
snapshotBlockNumber, snapshotBlockHash}`（06 `Position`）；`walletCap = {status:
"available", walletProjectCapUsd1, rounds: [{roundIndex, walletRoundCapUsd1,
cumulativeUsd1}], snapshotBlockNumber, snapshotBlockHash}`。
- history：`source = {status: "available", indexedBlockNumber, indexedBlockHash}`；
  `purchaseRecords[] = {purchaseRecordId, walletId, roundId|null, roundIndex, usd1Amount,
tokenAmount, transactionHash, logIndex, blockNumber, blockHash, confirmationState:
pending|confirmed|reorged, observedAt}`；`entitlements[] = {entitlementId, walletId,
entitledTokens, claimedTokens, state: frozen|partially_claimed|claimed, frozenAtBlock}`；
  `refunds[] = {refundLiabilityId, walletId, refundableUsd1, refundedUsd1, state:
frozen|partially_refunded|refunded, frozenAtBlock}`。
- `POST …/intents` `201`：`{launchIntent: {launchIntentId, state, launchId, projectId,
walletId, roundId, roundIndex, chainId, contractAddress, quoteAssetId, usd1Amount,
expectedTokenAmount, minTokenAmount, walletCumulativeUsd1, deadline, eligibilityProof,
configVersion, stateTupleDigest, snapshotBlockNumber, snapshotBlockHash, payloadDigest,
unsignedTransaction: {chainId: 56|97, to, data, value: "0x0"}, expiresAt, createdAt},
contractVersion}`。`data` 为 `buy(saleId, roundId, usd1Amount, minTokenAmount,
deadline, eligibilityProof)`（06 §4.1 顺序）。本单仍恒 `503`。

这些形状是 S83a 的预留，S83b 落地时若需调整会在其决策里明确列出；在此之前请勿假设它们会出现。

### S83a.5 Headers / 错误码

无新增 header、无新增错误码；错误体仍是七字段。S83a 新增的 reasonCode 只出现在
`onChainState.reasonCode`（上表），不会出现在错误体里。

## S83b：事件索引、购买 Intent、资格证明、USD1 授权（决策 0077）

机器契约以 `openapi/loop-api.v2.json` 为准。S83b **只加可选字段**（下文逐项列出），
S83a 的所有 `unavailable` 分支字节不变（回归测试照旧通过）。

### S83b.1 何时会出现 `available`

| 条件                                                                   | 影响                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 四个 `LAUNCH_*` 键全空                                                 | 一切与 S83a 之前相同；Intent 两个路由 `503`；无 `onChain`、无 `usd1`      |
| 键已配，合约代码已观测，sale 已由 `pnpm launch:register-sale` 登记     | 详情页读链（S83a）；其余接口看下一行                                      |
| 另外 worker 开了 `LAUNCH_INDEXER_ENABLED`，`launch_event` 检查点已存在 | overview 四轴、holders.holders、history、economy.onChain 变为 `available` |
| 另外 `BSC_WRITES_ENABLED=true`                                         | `POST …/intents` 与 `…/broadcast-report` 开放                             |

Base URL：`https://api-dev.<域名>`（与其它 V2 模块相同）。Headers：读接口
`Authorization: Bearer <Privy token>`、`X-Loop-Client-Version`、`X-Loop-Contract-Version: 2.0`；
写接口另加 `Idempotency-Key: <UUIDv4>`。

### S83b.2 `GET /v2/launch/overview`

列表项的 `onChainState` 读 `launches` 投影（索引 lane 每段末尾 `getState` 的结果），
`source: "chain"`，形状与详情页相同：

```json
{
  "saleState": "LIVE",
  "entitlementState": "NONE",
  "liquidityState": "NOT_STARTED",
  "operationalState": "ACTIVE",
  "stateTupleDigest": "0xcdcd…cd",
  "snapshotBlockNumber": "950",
  "snapshotBlockHash": "0xbbbb…3b6",
  "configVersion": "0xabab…ab",
  "source": "chain",
  "reasonCode": null
}
```

`unavailable` 的新 reasonCode：`LAUNCH_ONCHAIN_STATE_NOT_INDEXED`（索引 lane 尚无检查点）、
`LAUNCH_ONCHAIN_STATE_NOT_PROJECTED`（有检查点但这个 sale 还没投影到），其余沿用 S83a。
`snapshotBlockNumber` 是投影区块，可能落后链头几个块。

### S83b.3 `GET /v2/launch/{launchId}/holders`

```json
{
  "launchId": "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
  "holders": {
    "status": "available",
    "holderCount": 3,
    "indexedBlockNumber": "950"
  },
  "myPosition": {
    "status": "available",
    "walletId": "d64786bb-408d-415d-8a69-6277d56c921b",
    "cumulativeUsd1": "100000000000000000000",
    "purchasedTokens": "10000000000000000000000",
    "entitledTokens": "0",
    "claimableTokens": "0",
    "claimedTokens": "0",
    "refundableUsd1": "0",
    "refundedUsd1": "0",
    "snapshotBlockNumber": "900",
    "snapshotBlockHash": "0xbbbb…384"
  },
  "walletCap": {
    "status": "available",
    "walletProjectCapUsd1": "1000000000000000000000",
    "rounds": [
      {
        "roundIndex": 1,
        "walletRoundCapUsd1": "500000000000000000000",
        "cumulativeUsd1": "100000000000000000000"
      }
    ],
    "snapshotBlockNumber": "900",
    "snapshotBlockHash": "0xbbbb…384"
  },
  "contractVersion": "2.0"
}
```

- `holderCount` = 该 sale 未被重组掉的 `Purchased` 事件的不同买家地址数（含非 LOOP 钱包），不是代币当前持有人数。
- `myPosition` / `walletCap` 取**当前账户的活跃钱包**，同一区块读 `getPosition` / `getSaleConfig` / `getRounds` / `getRoundPosition`。
- 没有活跃钱包：两块都是 `unavailable` + `LAUNCH_WALLET_NOT_FOUND`。合约不可读：三块都是 `unavailable` + S83a 的原因码。

### S83b.4 `GET /v2/launch/{launchId}/history`

三个数组只含**当前账户**的钱包；`source` 是索引检查点：

```json
{
  "launchId": "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
  "purchaseRecords": [
    {
      "purchaseRecordId": "5b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      "walletId": "d64786bb-408d-415d-8a69-6277d56c921b",
      "roundId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      "roundIndex": 1,
      "usd1Amount": "10000000000000000000",
      "tokenAmount": "1000000000000000000000",
      "transactionHash": "0xaaaa…aa",
      "logIndex": 0,
      "blockNumber": "940",
      "blockHash": "0xbbbb…3ac",
      "confirmationState": "confirmed",
      "observedAt": "2026-09-25T01:00:00.000Z"
    }
  ],
  "entitlements": [],
  "refunds": [],
  "source": {
    "status": "available",
    "indexedBlockNumber": "950",
    "indexedBlockHash": "0xbbbb…3b6"
  },
  "contractVersion": "2.0"
}
```

- `confirmationState`：`pending`（未满确认数）→ `confirmed`；被重组的行保留为 `reorged`。
- `entitlements` 只在 `SaleFinalized(SUCCEEDED)` + `VestingScheduleCreated` 都被索引后出现；
  `entitledTokens` 是冻结总额，**不等于可领取额**（可领取看 holders.myPosition.claimableTokens）。
- `refunds` 只在失败/取消后出现，一钱包一条。
- `source` 为 `unavailable` 时三个数组恒空，空数组不代表"没参与"。

### S83b.5 `GET /v2/launch/{launchId}/eligibility[?roundIndex=n]`

新增可选 query `roundIndex`（0–65535）。缺省：当前时间窗内的轮次，否则下一轮，否则最后一轮。

```json
{
  "launchId": "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
  "mode": "whitelist",
  "result": {
    "status": "available",
    "tier": "priority",
    "reasonCode": null,
    "snapshotBlock": "880",
    "roundIndex": 1,
    "allowlistRoot": "0x5f1c…",
    "eligibilityProof": ["0x8e3a…", "0x12bc…"]
  },
  "configVersion": "launchMoonCatV1",
  "effectiveAt": "2026-09-08T01:00:00.000Z",
  "dependsOnStaking": false,
  "contractVersion": "2.0"
}
```

- 链上该轮 `allowlistRoot` 全零：开放轮，`tier` = 轮次配置的 tier 或 `public`，`eligibilityProof: []`，`snapshotBlock` 为读链区块。
- 开放轮先于模式与名单判定（Decision 0084）：root 全零时即使 `mode: "unavailable"`（`tierModeV1` 未确认）或 LOOP 侧名单未计算，也返回上面的开放分支，不再出现 `TIER_MODE_PENDING` / `LAUNCH_ALLOWLIST_NOT_COMPUTED`；Intent 对开放轮同样不要求 proof 与 LOOP 侧根。无合约配置、读链失败、钱包未找到等拿不到链上 root 的情况，模式未确认时仍返回 `TIER_MODE_PENDING`（字节不变）。
- 不在名单：`status: available`、`tier: null`、`reasonCode: "LAUNCH_WALLET_NOT_ELIGIBLE"`、`eligibilityProof: []`。
- 拒绝（旧结构 `{tier: null, reasonCode, snapshotBlock: null}`）：`TIER_MODE_PENDING`、
  `LAUNCH_ALLOWLIST_NOT_COMPUTED`、`LAUNCH_ALLOWLIST_ROOT_MISMATCH`（链上根与 LOOP 计算的根不一致，
  **此时 Intent 也会被拒**）、`LAUNCH_ALLOWLIST_MODE_MISMATCH`、`LAUNCH_ROUND_NOT_FOUND`、
  `LAUNCH_WALLET_NOT_FOUND`、S83a 的合约原因码。
- `eligibilityProof` 与 Intent 里的同名字段一致，原样作为 `buy()` 最后一个参数（后端已编进 calldata，前端不需自己拼）。

### S83b.6 `POST /v2/launch/{launchId}/intents`

请求（金额是 USD1 十进制字符串，最多 18 位小数；JSON 数字 → `400`）：

```http
POST /v2/launch/9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f/intents
Authorization: Bearer <token>
X-Loop-Client-Version: 1.2.3
X-Loop-Contract-Version: 2.0
Idempotency-Key: 0f8a0c33-6f7e-4f53-9d8f-3b1f5c2e9a10
Content-Type: application/json

{ "walletId": "d64786bb-408d-415d-8a69-6277d56c921b", "roundId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e", "payAmount": "10" }
```

`201`（`*` 为 S83b 新增的可选字段）：

```json
{
  "launchIntent": {
    "launchIntentId": "7a2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
    "state": "awaiting_signature",
    "launchId": "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
    "projectId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "walletId": "d64786bb-408d-415d-8a69-6277d56c921b",
    "roundId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
    "roundIndex": 1,
    "chainId": "eip155:97",
    "contractAddress": "0x1111111111111111111111111111111111111111",
    "quoteAssetId": "eip155:97:0x2222222222222222222222222222222222222222",
    "usd1Amount": "10000000000000000000",
    "expectedTokenAmount": "1000000000000000000000",
    "minTokenAmount": "1000000000000000000000",
    "walletCumulativeUsd1": "100000000000000000000",
    "deadline": "2026-09-22T00:02:00.000Z",
    "eligibilityProof": [],
    "configVersion": "0xabab…ab",
    "stateTupleDigest": "0xcdcd…cd",
    "snapshotBlockNumber": "900",
    "snapshotBlockHash": "0xbbbb…384",
    "payloadDigest": "3f1e…(64 hex)",
    "unsignedTransaction": {
      "chainId": 97,
      "to": "0x1111111111111111111111111111111111111111",
      "data": "0x…buy(saleId, roundId, usd1Amount, minTokenAmount, deadline, eligibilityProof)",
      "value": "0x0",
      "from*": "0x…钱包地址",
      "gas*": "0x1d4c0",
      "nonce*": "0x3",
      "type*": "legacy",
      "maxFeePerGas*": null,
      "maxPriorityFeePerGas*": null,
      "gasPrice*": "0x3b9aca00"
    },
    "expiresAt": "2026-09-22T00:02:00.000Z",
    "createdAt": "2026-09-22T00:00:00.000Z",
    "projectAssetId*": "eip155:97:0x3333333333333333333333333333333333333333",
    "saleId*": "7",
    "walletRoundCapUsd1*": "500000000000000000000",
    "walletProjectCapUsd1*": "1000000000000000000000",
    "transactionHash*": null,
    "simulation*": { "status": "passed", "reasonCode": null },
    "policy*": {
      "configVersion": "bscWriteCanaryV1",
      "canaryMaxUsd": "5",
      "valueUsd": "10",
      "priceSource": "usd1_par"
    },
    "signing*": {
      "mode": "device_eth_send_transaction",
      "allowed": true,
      "reasonCode": null
    }
  },
  "contractVersion": "2.0"
}
```

（示例键名里的 `*` 只是标记，真实键名没有星号。）

- 签名出口：设备把 `unsignedTransaction`（含 `from/gas/nonce/fee`）交给 Privy 嵌入式钱包
  `eth_sendTransaction`；只有 `signing.allowed = true`（`awaiting_signature` 且未过 `expiresAt`）才可签。
- `walletRoundCapUsd1` / `walletProjectCapUsd1` 与所有检查同一快照块，签名前展示用。
- 同一 `Idempotency-Key` 同一请求体：返回同一个 Intent（不再读链）；不同请求体：`409 IDEMPOTENCY_CONFLICT`。
- 模拟失败：仍返回 `201`，`state: "prepared"`，`signing.allowed: false`，
  `reasonCode` 为 `LAUNCH_SIMULATION_REVERTED` / `LAUNCH_SIMULATION_UNAVAILABLE`。
- `state` 可能值：`prepared` / `awaiting_signature` / `submitted`（已回报）/ `confirmed`（索引看到对应 `Purchased`，或回执成功，S83b2）/ `expired`（未回报且过期；或已回报但截止后仍无回执，S83b2）/ `reverted`、`failed`（S83b2，见 S83b2 节）。

错误（七字段错误体，`detailsSafe.reasonCode` 指明规则；除 `detailsSafe` 外字段均为固定值）：

| HTTP / code                  | `detailsSafe.reasonCode`（附加字段）                                                                                                                                                                                                                                                                                                   | 前端建议                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `400 INVALID_REQUEST`        | —                                                                                                                                                                                                                                                                                                                                      | 修正输入                         |
| `404 NOT_FOUND`              | —（launch / 钱包 / 轮次不存在或不属于你）                                                                                                                                                                                                                                                                                              | 刷新                             |
| `409 DATA_STALE`             | `LAUNCH_SALE_NOT_LIVE`（`saleState`）、`LAUNCH_ROUND_NOT_ON_CHAIN`、`LAUNCH_ROUND_NOT_OPEN`、`LAUNCH_SALE_PAUSED`、`LAUNCH_DEADLINE_TOO_CLOSE`、`LAUNCH_CONFIG_VERSION_MISMATCH`                                                                                                                                                       | 刷新状态后重试                   |
| `409 INSUFFICIENT_BALANCE`   | `LAUNCH_USD1_BALANCE_INSUFFICIENT`、`LAUNCH_USD1_ALLOWANCE_INSUFFICIENT`（`allowanceUsd1`）、`LAUNCH_GAS_INSUFFICIENT`                                                                                                                                                                                                                 | 充值 / 先授权（S83b.8）/ 充 tBNB |
| `409 IDEMPOTENCY_CONFLICT`   | —                                                                                                                                                                                                                                                                                                                                      | 新 key                           |
| `422 VALIDATION_FAILED`      | `LAUNCH_BELOW_MIN_PURCHASE`（`minPurchaseUsd1`）、`LAUNCH_WALLET_ROUND_CAP_EXCEEDED`、`LAUNCH_WALLET_PROJECT_CAP_EXCEEDED`、`LAUNCH_ROUND_CAP_EXCEEDED`、`LAUNCH_HARD_CAP_EXCEEDED`（均带 `remainingUsd1`）、`LAUNCH_QUOTE_ZERO`；无 reasonCode = 非嵌入式钱包                                                                         | 调整金额                         |
| `403 POLICY_BLOCKED`         | `LAUNCH_ALLOWLIST_NOT_COMPUTED`、`LAUNCH_ALLOWLIST_ROOT_MISMATCH`、`LAUNCH_ALLOWLIST_MODE_MISMATCH`、`LAUNCH_WALLET_NOT_ELIGIBLE`、`ASSET_NOT_IN_CANARY_ALLOWLIST`、`COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST`、`CANARY_CEILING_EXCEEDED`（`exposureUsd`,`ceilingUsd`）、`CANARY_DAILY_CEILING_EXCEEDED`（另加 `spentUsd`,`remainingUsd`） | 不可重试                         |
| `403 POLICY_BLOCKED`         | `TIER_MODE_PENDING`（S83b6）：该轮链上 `allowlistRoot` 非零且 `tierModeV1` 未确认；与 `GET …/eligibility` 同一原因码；全零根开放轮不受影响                                                                                                                                                                                             | 显示「资格待定」，确认后再试     |
| `503 CAPABILITY_UNAVAILABLE` | 无 `detailsSafe`：写开关关闭或合约键为空（与 S83a 字节相同）；有 reasonCode：S83a 合约原因码、`LAUNCH_SALE_ASSETS_UNREGISTERED`、`LAUNCH_CONTRACT_READ_FAILED`                                                                                                                                                                         | 稍后重试                         |

金额附加字段（`*Usd1`）都是 USD1 最小单位十进制字符串；canary 字段（`*Usd`）是美元十进制字符串（USD1 按 1 USD 计）。

### S83b.7 `POST /v2/launch/{launchId}/intents/{launchIntentId}/broadcast-report`

设备 `eth_sendTransaction` 拿到 hash 后回报（与钱包 Intent 的 broadcast-report 同型，写接口 headers）：

```json
{
  "txHash": "0x7777777777777777777777777777777777777777777777777777777777777777"
}
```

`200` 返回与 `201` 相同形状的 `{launchIntent, contractVersion}`，`state: "submitted"`、
`transactionHash` 为回报值、`signing.allowed: false`（`LAUNCH_INTENT_ALREADY_REPORTED`）。
回报只是 pending 证据：当 `launch_event` 索引到该交易的 `Purchased` 事件后 `state` 变
`confirmed`，history 以索引为准。

| HTTP / code                  | reasonCode                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `200`                        | 同一 hash 重复回报：原样返回（幂等）                                                                                               |
| `400 INVALID_REQUEST`        | hash 不是 32 字节十六进制                                                                                                          |
| `404 NOT_FOUND`              | Intent 不存在或不属于你                                                                                                            |
| `409 DATA_STALE`             | `LAUNCH_INTENT_ALREADY_REPORTED`（另一个 hash）、`LAUNCH_INTENT_NOT_SIGNABLE`、`LAUNCH_INTENT_EXPIRED`（过期且链上还看不到该交易） |
| `422 VALIDATION_FAILED`      | `LAUNCH_TX_PAYLOAD_MISMATCH`（链上交易与签名载荷不一致）                                                                           |
| `503 CAPABILITY_UNAVAILABLE` | 写开关关闭 / 合约键为空（无 detailsSafe）；读链失败（`LAUNCH_CONTRACT_READ_FAILED`）                                               |

### S83b.8 USD1 授权（allowance 不足时）

用现有 `POST /v2/wallet-intents/approve`（`sendApprovals` 模块），**不新增字段**：链由
`assetId` 决定，写成 launch 槽位上的 USD1：

```json
{
  "walletId": "d64786bb-408d-415d-8a69-6277d56c921b",
  "assetId": "eip155:97:0x2222222222222222222222222222222222222222",
  "spenderAddress": "0x1111111111111111111111111111111111111111",
  "allowance": { "mode": "exact", "amount": "10" }
}
```

`201` 是普通钱包 Intent（节选）：

```json
{
  "intentId": "…",
  "kind": "approve",
  "state": "awaiting_signature",
  "walletId": "d64786bb-408d-415d-8a69-6277d56c921b",
  "chainId": "eip155:97",
  "policy": {
    "configVersion": "bscWriteCanaryV1",
    "valueUsd": "10",
    "priceSource": "usd1_par",
    "…": "…"
  },
  "unsignedTransaction": {
    "chainId": 97,
    "from": "0x…",
    "to": "0x2222222222222222222222222222222222222222",
    "data": "0x095ea7b3…",
    "value": "0x0",
    "…": "…"
  },
  "contractVersion": "2.0"
}
```

- 只放行 **USD1 → Launch 合约**这一对；97 上的其他资产、其他 spender、或 launch 槽位与主链相同
  → `422 CHAIN_MISMATCH`（在 canary 之前判断）。revoke（`/v2/wallet-intents/revoke`）同样只放行这一对。
- 走完整 canary：97 的 USD1 资产 ID 必须在 `BSC_WRITE_CANARY_ASSETS`，金额按 1 USD 估值，与 Launch Intent
  共享每日上限。签名后照常调用 `POST /v2/wallet-intents/{intentId}/broadcast-report`；后端按 Intent 记录的链
  （97）读交易和回执。
- 钱包 Intent 的 `unsignedTransaction.chainId` 取值从 `56` 放宽为 `56 | 97`。

### S83b.9 `GET /v2/wallets/{walletId}/balances` → `launchChain.usd1`

形状冻结（决策 0088）：

```json
"launchChain": {
  "chainId": "eip155:97",
  "availability": "available",
  "reasonCode": null,
  "nativeBalance": { "…": "…" },
  "usd1": { "balance": "7000000000000000000", "allowance": "5000000000000000000" }
}
```

- `balance` = USD1 余额，`allowance` = 对 `LAUNCH_CONTRACT_ADDRESS` 的授权额，都是 18 位最小单位十进制字符串。
- 仅当后端配置了 `LAUNCH_USD1_ADDRESS`、`launchChain` 块存在、且两个值在同一区块读到时出现；否则整个 `usd1` 键缺席（不会是 `null`）。自 S86b 起授权额固定在余额读到的那个区块上读取，"同一区块"成为常态；只有端点已无法提供该区块（极少）或任一读失败/超时才缺席。
- 不出现在 Intent `201` 里。

### S83b.10 `GET /v2/launch/economy` → `onChain`

仅在合约键已配置时出现（否则无此键，字节与之前相同）：

```json
"onChain": {
  "status": "available",
  "registeredSaleCount": 1,
  "totalRaisedUsd1": "170000000000000000000",
  "lockedLpCount": 1,
  "source": "loop_indexer",
  "indexedBlockNumber": "950",
  "indexedBlockHash": "0xbbbb…3b6"
}
```

`totalRaisedUsd1` 只计 `SUCCEEDED` 的 `SaleFinalized`；无检查点时为 `{"status": "unavailable", "reasonCode": "LAUNCH_ONCHAIN_STATE_NOT_INDEXED"}`。

### S83b.11 运营脚本（Dev）

- `pnpm launch:register-sale --launch <launchId> --sale-id <n> [--confirm] [--rescan]`：读 `getSaleConfig`
  核对 USD1 与项目代币（取已确认配置里的 `projectTokenAddress`），无 `--confirm` 只演练。
- `pnpm launch:allowlist import <csv> --launch <id> --round <n> [--source <tag>]`：每行一个地址（可有表头 `address`）。
- `pnpm launch:allowlist compute --launch <id> --round <n> --snapshot-block <n> [--confirm]`：输出 Merkle 根，
  由运营写入链上轮次；后端不写链。

## S83b2：购买 Intent 回执对账（决策 0080）

Base URL、headers、路由都不变；本节只说明回报之后 `launchIntent.state` 会怎样变化、在哪里看到。

### S83b2.1 状态机（后端对账 lane 写，前端只读）

| 从          | 到          | 触发                                                                            | `signing.reasonCode`             |
| ----------- | ----------- | ------------------------------------------------------------------------------- | -------------------------------- |
| `submitted` | `confirmed` | 索引到该交易的 `Purchased`，或回执 `status=0x1` 且确认数 ≥ launch 槽位确认数    | `LAUNCH_INTENT_ALREADY_REPORTED` |
| `submitted` | `reverted`  | 回执 `status=0x0` 且确认数足够                                                  | `LAUNCH_TX_REVERTED`             |
| `submitted` | `failed`    | 回报的 hash 在链上是另一笔交易（回报时链上还看不到，事后核对不一致）            | `LAUNCH_TX_PAYLOAD_MISMATCH`     |
| `submitted` | `expired`   | 过了 `deadline`（= `expiresAt`）5 分钟仍无回执（节点仍显示 pending 则 60 分钟） | `LAUNCH_TX_NOT_OBSERVED`         |
| `expired`   | `confirmed` | 之后仍索引到该交易的 `Purchased`（证据优先）                                    | `LAUNCH_INTENT_ALREADY_REPORTED` |

`signing.allowed` 在这些状态下都是 `false`。确认数：测试网（`LAUNCH_CHAIN_ID=97`）默认 5 块，主网槽位与主链一致。
两条路径（索引 / 回执）谁先到谁生效，另一条是空操作，不会来回跳。

### S83b2.2 在哪里看到

- 用同一 hash 重放 `POST …/broadcast-report`（幂等，`200`），或同一 `Idempotency-Key` 重放 `POST …/intents`，返回存储中的最新状态。
- `GET /v2/launch/{launchId}/history` 不变：只列索引到的 `Purchased`；reverted / expired 的购买不会出现在里面。

### S83b2.3 wire 变化

- `state` 枚举不变（`reverted` / `failed` / `expired` 在 S83a 冻结枚举里已有），这是它们第一次真正出现。
- 新增可选字段 `launchIntent.revertReason`：**只在 `state = "reverted"` 时出现**，值为字符串或 `null`；目前恒为 `null`（公共节点拿不到 trace）。其他状态不出现该键，响应字节不变。

`reverted` 示例（节选）：

```json
{
  "launchIntent": {
    "launchIntentId": "0f3d6c1a-8b8e-4c55-9a51-4c1f3e2d7a90",
    "state": "reverted",
    "transactionHash": "0xabababababababababababababababababababababababababababababababab",
    "revertReason": null,
    "signing": {
      "mode": "device_eth_send_transaction",
      "allowed": false,
      "reasonCode": "LAUNCH_TX_REVERTED"
    }
  },
  "contractVersion": "2.0"
}
```

前端建议：`reverted` 显示「交易失败，资金未扣除（仅 gas）」；`expired` 显示「未上链，可重新下单」；`failed` 显示「回报的交易不匹配」。三者都可以直接重新 `POST …/intents`（新 `Idempotency-Key`）。

### S83b2.4 错误码与 unavailable

错误码表不变（S83b.6 / S83b.7）。对账没有配置 launch 槽位 RPC 时后端不推进任何状态，Intent 停在 `submitted`；接口仍 `200`，不会伪造结果。

## S83b3：单个购买 Intent 读取、主链槽位的 USD1 授权、交易 hash 形式（决策 0081）

Base URL 与通用 headers 不变（见文首）。本节新增一个只读路由和一个可选字段，其他响应字节不变。

### S83b3.1 `GET /v2/launch/{launchId}/intents/{launchIntentId}`

读 headers（不带 `Idempotency-Key`）：

```
Authorization: Bearer <Privy access token>
X-Loop-Client-Version: 1.2.3
X-Loop-Contract-Version: 2.0
```

无 query、无 body。`200` 与 `POST …/intents` 的 `201`、`broadcast-report` 的 `200` **完全同形**
（同一个投影函数；同一时刻字节相同），`Cache-Control: no-store`：

```json
{
  "launchIntent": {
    "launchIntentId": "0f3d6c1a-8b8e-4c55-9a51-4c1f3e2d7a90",
    "state": "submitted",
    "launchId": "…",
    "walletId": "…",
    "transactionHash": "0xabababababababababababababababababababababababababababababababab",
    "signing": {
      "mode": "device_eth_send_transaction",
      "allowed": false,
      "reasonCode": "LAUNCH_INTENT_ALREADY_REPORTED"
    },
    "…": "其余字段同 S83b.6"
  },
  "contractVersion": "2.0"
}
```

- `state` 可为 `awaiting_signature` / `submitted` / `confirmed` / `reverted` / `failed` / `expired`（S83b2.1）。
  未回报且过了 `expiresAt` 的 Intent 读出来是 `expired`（`signing.reasonCode = LAUNCH_INTENT_EXPIRED`）。
- `revertReason` 只在 `state = "reverted"` 时出现（目前恒 `null`）；其他状态没有这个键。
- 读取不改变任何状态；状态只由后端索引 / 对账 lane 推进。建议广播后按需轮询（例如 5 s 间隔，
  到 `confirmed` / `reverted` / `failed` / `expired` 停止）。

| HTTP / code                                           | 何时                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `200`                                                 | Intent 属于当前账号                                                                                      |
| `400 INVALID_REQUEST`                                 | `launchId` / `launchIntentId` 不是 UUIDv4；带 query；缺 `X-Loop-Contract-Version` 等 header              |
| `401 AUTH_REQUIRED` / `AUTH_INVALID`                  | 缺少或无效的 Bearer                                                                                      |
| `404 NOT_FOUND`                                       | Intent 不存在、属于其他账号、或不属于这个 `launchId`（三者同一响应，不泄露存在性；`detailsSafe: null`）  |
| `409 ACCOUNT_BOOTSTRAP_REQUIRED` / `VERSION_CONFLICT` | 通用会话规则                                                                                             |
| `500 INTERNAL_ERROR`                                  | 未预期错误                                                                                               |
| `503 CAPABILITY_UNAVAILABLE`                          | 写开关关闭 / 合约键为空 / Intent 存储不可读（均 `detailsSafe: null`，与 prepare / report 的 503 同字节） |
| `503 PROVIDER_DISCONNECTED` / `REQUEST_TIMEOUT`       | 通用                                                                                                     |

### S83b3.2 `GET /v2/wallets/{walletId}/balances` → 根上的 `launchUsd1`（可选）

`launchChain` 只在 launch 槽位与主链**不同**（`LAUNCH_CHAIN_ID=97`）时出现，USD1 读在
`launchChain.usd1`（S83b.9）。当 launch 槽位**就是主链**（`LAUNCH_CHAIN_ID=56`）时 `launchChain` 缺席，
此时同样的数据出现在根上：

```json
{
  "walletId": "d64786bb-408d-415d-8a69-6277d56c921b",
  "snapshot": { "…": "…" },
  "gasReservePolicy": { "…": "…" },
  "balances": [],
  "netWorth": { "…": "…" },
  "launchUsd1": {
    "balance": "9000000000000000000",
    "allowance": "4000000000000000000"
  },
  "contractVersion": "2.0"
}
```

- 形状与 `launchChain.usd1` 完全相同（决策 0088）：18 位最小单位十进制字符串；`allowance` 是对
  `LAUNCH_CONTRACT_ADDRESS` 的授权额。
- 仅当：槽位共享 + 四个 `LAUNCH_CONTRACT_*` 键已配置 + 两个值在同一区块读到（S86b 起授权额固定在余额区块上读，
  同块是常态）。否则整个键缺席（不会是 `null`），读失败不影响页面其余部分。
- `launchUsd1` 与 `launchChain.usd1` 永不同时出现。客户端读法：`launchChain?.usd1 ?? launchUsd1`，都缺席即“未知”，
  不得当作 0。
- 注意：槽位共享时 `POST /v2/wallet-intents/approve` 对 USD1 → Launch 合约仍是 `422 CHAIN_MISMATCH`
  （S83b.8，主网签名关闭），授权额可读但暂时不能在 app 内提高。

### S83b3.3 `transactionHash` 形式

- 所有 Launch Intent 投影（prepare、report、S83b3.1 读取）里的 `transactionHash` 恒为小写 `0x` + 64 位十六进制，
  或回报前为 `null`。
- `broadcast-report` 的 `txHash` 接受任意大小写，存库与响应一律小写；同一 hash 换大小写再回报是同一次回报
  （`200`、同字节），不会是 `LAUNCH_INTENT_ALREADY_REPORTED`。客户端可以直接字节比较。

## S83b4：`launch` 能力的 evidence 何时 `confirmed`（决策 0083）

`GET /v2/meta/capabilities`（无需 headers 以外的输入）里 `capabilityId: "launch"` 的 `evidence`
现在按合约适配器的启动观测投影，不再恒为 `pending`。`availability` 与其它能力不变。

| 后端状态                       | `evidence`                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| 四个 `LAUNCH_*` 键全空         | `{"status":"pending","reasonCode":"LAUNCH_CONTRACT_BASELINE_PENDING"}`（与之前字节相同）          |
| 键已配，合约 ABI 主版本不支持  | `{"status":"pending","reasonCode":"LAUNCH_CONTRACT_VERSION_UNSUPPORTED"}`                         |
| 键已配，地址上无合约代码       | `{"status":"pending","reasonCode":"LAUNCH_CONTRACT_CODE_MISSING"}`                                |
| 启动探测尚未完成（API 刚启动） | `{"status":"pending","reasonCode":"LAUNCH_CONTRACT_VERIFICATION_PENDING"}`                        |
| 链 ID 不符 / RPC 未配或不可达  | `{"status":"pending","reasonCode":"LAUNCH_CHAIN_ID_MISMATCH"}` 等 `LAUNCH_CHAIN_*`                |
| 适配器可用                     | `{"status":"confirmed","reasonCode":"LAUNCH_CONTRACT_CONFIRMED","launchContractVersion":"1.0.0"}` |

- `launchChainId`（仅 `LAUNCH_CHAIN_ID=97` 时出现）规则不变，每一行都可能带。
- `launchContractVersion` 为可选字段，只在 `confirmed` 时出现；与文档顶层的 `contractVersion: "2.0"`（API 契约版本）无关。
- 客户端只需判断 `status == "confirmed"`；任何其它值都按 pending 处理，不要枚举 reasonCode 做业务分支（可用于展示/日志）。
- 这是启动时的一次性观测（决策 0076），不轮询；链上状态变化需 API 重启后反映。单个 launch 的可读性仍以
  `GET /v2/launches/{launchId}` 各字段自身的 `status`/`reasonCode` 为准。
- 无新增错误码。
