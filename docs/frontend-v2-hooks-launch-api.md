# 前端联调：V2 Hooks 发射配置、签名准备与部署任务（S125 / 决策 0108）

权威机器契约：`openapi/loop-api.v2.json`（operationId 见下）。通用规则（Base URL、
`X-Request-ID`、错误体七字段、Bearer、`X-Loop-Contract-Version: 2.0`、
`X-Loop-Client-Version`）沿用 `docs/frontend-v2-session-api.md` 与
`docs/api-v2-conventions.md`。来源：需求方分支 `codex/integrated-dual-pool-20261008`
（原决策 0090/0095/0097）。仅 BSC 测试网（chainId 97），**不广播、不激活**。

## 0. 启用条件

- 路由属于 `launch` 模块：`V2_MODULES_ENABLED` 不含 `launch` 时全部 `404 NOT_FOUND`。
- 后端开关 `HOOKS_LAUNCH_ENABLED`（默认 `off`）：关闭时六条路由在鉴权后一律
  `503 CAPABILITY_UNAVAILABLE`，`detailsSafe.reasonCode = "HOOKS_LAUNCH_DISABLED"`。
- 签名准备与提交另需测试网 Factory 配置；缺失时
  `503`，`reasonCode = "HOOKS_LAUNCH_FACTORY_UNAVAILABLE"`。
- **不新增 capability**；`GET /v2/meta/capabilities` 不变。前端以 503 + reasonCode 判断。

## 1. Headers

| 路由                                         | 必需 headers                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 读（GET）                                    | `Authorization: Bearer <privy token>`、`X-Loop-Contract-Version: 2.0`、`X-Loop-Client-Version` |
| `PUT hooks-config`（CAS）                    | 同上；**不得**带 `Idempotency-Key`（带则 400）                                                 |
| `POST hooks-deployments`、`DELETE …/{jobId}` | 同上 + `Idempotency-Key: <UUIDv4>`                                                             |

所有 200 响应 `Cache-Control: no-store`。

## 2. `GET /v2/launch/projects/{projectId}/hooks-config`（`getV2HooksLaunchProjectConfig`）

只返回调用者自己项目的最新草稿；非本人项目 `404`。

```json
{
  "draft": {
    "projectId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "version": 1,
    "templateVersion": "hooks_launch_v1",
    "config": {
      "templateVersion": "hooks_launch_v1",
      "templateHash": "0x4c5eeccd13cb2cc9f25a99513883917517a4516665e6caed4abe9af70bc351ca",
      "name": "MoonCat",
      "ticker": "MCAT",
      "logoAssetUrl": "https://cdn.example.com/logo.png",
      "description": "A launch project",
      "links": ["https://mooncat.example/"],
      "nftSaleStartAt": "1792000000",
      "buybackRecipient": "0x1234567890123456789012345678901234567890",
      "fixedEconomics": {
        "chainId": "56",
        "memeTotalSupplyRaw": "1000000000000000000000000000",
        "curveSaleSupplyRaw": "800000000000000000000000000",
        "initialLiquiditySupplyRaw": "200000000000000000000000000",
        "graduationReserveUsd1Raw": "133333332000000000000000",
        "nftPriceUsd1Raw": "100000000000000000000",
        "nftSaleDurationSeconds": 604800,
        "earlyRoundDurationSeconds": 3600,
        "perAddressLifetimeBuyCapRaw": "5000000000000000000000000",
        "curveBuyTaxBps": 1000,
        "curveSellTaxBps": 1000,
        "officialPoolBuyTaxBps": 200,
        "officialPoolSellTaxBps": 200,
        "lpFee": 2500,
        "tickSpacing": 60,
        "buybackOrderUsd1Raw": "100000000000000000000",
        "buybackMinIntervalSeconds": 10
      },
      "configHash": "0x7e0a93a9e68cea0e52d82c03c6dcfcdf4f41ec597b2e7ac8931405f24aa1b8dc"
    },
    "updatedAt": "2026-10-09T00:00:00.000Z"
  },
  "contractVersion": "2.0"
}
```

无草稿时 `{"draft": null, "contractVersion": "2.0"}`。所有 `*Raw` 为 18 位小数最小单位
的十进制字符串（展示时自行除以 10^18）；bps/秒为小整数。`fixedEconomics` 由服务端给出，
前端只展示不可编辑。

## 3. `PUT /v2/launch/projects/{projectId}/hooks-config`（`saveV2HooksLaunchProjectConfig`）

请求：

```json
{
  "expectedVersion": 0,
  "config": {
    "name": "MoonCat",
    "ticker": "MCAT",
    "logoAssetUrl": "https://cdn.example.com/logo.png",
    "description": "A launch project",
    "links": ["https://mooncat.example"],
    "nftSaleStartAt": "1792000000",
    "buybackRecipient": "0x1234567890123456789012345678901234567890"
  }
}
```

- `expectedVersion` = 当前最新版本（无则 0）；过期 `409 VERSION_CONFLICT`，重新 GET 后再存。
- `nftSaleStartAt` 为 unix 秒字符串，须 ≥ 当前 + 24 小时；`links` ≤ 8 条且必须 https；
  ticker 2–12 位字母数字（服务端转大写）。
- 任何多余字段（例如想改税率）→ `400 INVALID_REQUEST`。
- 200 返回与 §2 `draft` 相同结构的新版本。保存新版本会使旧版本的审批失效（需重新审批）。

## 4. `GET …/hooks-config/signing-request?walletId=<walletId>`（`getV2HooksLaunchSigningRequest`）

`walletId` 为调用者钱包清单里的不透明 ID（不能传地址）。返回：

```json
{
  "request": {
    "projectOwner": "0x…(钱包地址, 小写)",
    "configVersion": 1,
    "configHash": "0x7e0a…b8dc",
    "name": "MoonCat",
    "ticker": "MCAT",
    "nftSaleStart": "1792000000",
    "buybackRecipient": "0x1234567890123456789012345678901234567890",
    "deadline": "1791000900",
    "memeSalt": "0x…",
    "nonce": "9"
  },
  "typedData": {
    "domain": { "name": "LOOP Launch Factory", "version": "1", "chainId": 97, "verifyingContract": "0x…" },
    "types": { "LaunchRequest": [ … 11 个字段 … ] },
    "primaryType": "LaunchRequest",
    "message": { "…": "uint64/uint256 字段为十进制字符串" }
  },
  "hookDeployer": "0x…", "hookInitCodeHash": "0x…", "hookSalt": "0x…", "hookAddress": "0x…",
  "memeDeployer": "0x…", "memeInitCodeHash": "0x…", "memeAddress": "0x…6666"
}
```

前端用该钱包对 `typedData` 做 EIP-712 签名（`message` 中 `nftSaleStart`、`deadline`、
`nonce` 签名时按 uint 处理）。`deadline` 约 15 分钟；过期、配置版本变化、nonce 变化都要重新
请求并重新签名。只支持 EOA 签名。可能需要数秒（服务端挖盐）；忙时 `503` + `Retry-After: 5`。

## 5. `POST /v2/launch/projects/{projectId}/hooks-deployments`（`submitV2HooksLaunchDeployment`）

请求（`request` 原样回传 §4 的 `request`）：

```json
{
  "walletId": "00000000-0000-4000-8000-000000000099",
  "request": { "…": "同 §4 request" },
  "hookSalt": "0x…",
  "signature": "0x…(65 字节)"
}
```

200：

```json
{
  "jobId": "00000000-0000-4000-8000-000000000011",
  "projectId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "configVersion": 1,
  "chainId": 97,
  "factoryAddress": "0x…",
  "status": "awaiting_executor",
  "memeAddress": "0x…6666",
  "hookAddress": "0x…",
  "createdAt": "2026-10-09T00:00:00.000Z"
}
```

- 最新配置版本必须已被平台独立审批，否则 `403 POLICY_BLOCKED`
  （`detailsSafe.reasonCode = "HOOKS_CONFIG_NOT_APPROVED"`），前端显示「等待平台审批」。
- 同一 `Idempotency-Key` 重放同一请求返回同一任务（超时重试请复用 key 与签名）；同 key
  不同内容 `409 IDEMPOTENCY_CONFLICT`。
- 签名或字段不匹配：`400 INVALID_REQUEST`；配置已变或与已有任务冲突：`409 VERSION_CONFLICT`。
- `awaiting_executor` 只表示「已验签登记」，**不是**已上链；本批无执行器。

## 6. `GET` / `DELETE …/hooks-deployments/{jobId}`

- `GET`（`getV2HooksLaunchDeployment`）：返回 §5 结构；非本人 `404`。
- `DELETE`（`cancelV2HooksLaunchDeployment`，需 `Idempotency-Key`）：`awaiting_executor →
cancelled`，已取消再取消返回原状态。取消不撤销已给出的链上签名。

## 7. 错误码汇总

| 状态 | code                             | 场景                                                                                                                              |
| ---- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | 结构/字段非法、覆盖经济参数、开售过早、PUT 带 Idempotency-Key、POST/DELETE 缺 key、钱包非本人活跃钱包、签名/deadline/CREATE2 不符 |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | Bearer 缺失或无效                                                                                                                 |
| 403  | `POLICY_BLOCKED`                 | `HOOKS_CONFIG_NOT_APPROVED`                                                                                                       |
| 404  | `NOT_FOUND`                      | 非本人项目 / 无草稿 / 任务不存在                                                                                                  |
| 409  | `VERSION_CONFLICT`               | CAS 过期、配置已变、任务冲突                                                                                                      |
| 409  | `IDEMPOTENCY_CONFLICT`           | 同 key 不同请求                                                                                                                   |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED`     | 账号未 bootstrap                                                                                                                  |
| 503  | `CAPABILITY_UNAVAILABLE`         | `HOOKS_LAUNCH_DISABLED` / `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`                                                                      |
| 500  | `INTERNAL_ERROR`                 | —                                                                                                                                 |

## 8. unavailable 行为

开关关闭：所有页面块显示「Hooks 发射未开放」。开关开但无 Factory：可编辑/保存草稿，签名与
提交按钮禁用并显示「测试网工厂未配置」。不得用本地数据伪造任务状态。
