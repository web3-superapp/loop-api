# 前端联调：V2 Hooks 发射配置、签名准备与部署任务（S125 / 决策 0108）

权威机器契约：`openapi/loop-api.v2.json`（operationId 见下）。通用规则（Base URL、
`X-Request-ID`、错误体七字段、Bearer、`X-Loop-Contract-Version: 2.0`、
`X-Loop-Client-Version`）沿用 `docs/frontend-v2-session-api.md` 与
`docs/api-v2-conventions.md`。来源：需求方分支 `codex/integrated-dual-pool-20261008`
（原决策 0090/0095/0097）。仅 BSC 测试网（chainId 97）。S132 / 决策 0112 起，后台执行器
（worker，默认关闭）会认领任务、广播 `deployLaunch`、跟踪确认与重组、逐模块核验后激活；
本文件 §5–§6、§9 描述任务进度字段（**只增字段，S125 字段含义不变**）。

## 0. 启用条件

- 路由属于 `launch` 模块：`V2_MODULES_ENABLED` 不含 `launch` 时全部 `404 NOT_FOUND`。
- 后端开关 `HOOKS_LAUNCH_ENABLED`（默认 `off`）：关闭时六条路由在鉴权后一律
  `503 CAPABILITY_UNAVAILABLE`，`detailsSafe.reasonCode = "HOOKS_LAUNCH_DISABLED"`。
- 签名准备与提交另需测试网 Factory 配置；缺失时
  `503`，`reasonCode = "HOOKS_LAUNCH_FACTORY_UNAVAILABLE"`。
- **S141 / 决策 0119 起，保存草稿（`PUT hooks-config`）也需要 Factory**：服务端在算
  `configHash` 前读目标工厂 `nftSaleDuration()`，写入
  `config.fixedEconomics.nftSaleDurationSeconds`（BSC 测试网 1 小时工厂 = `3600`；主网 / 旧工厂
  = `604800`，此时 `configHash` 与 S141 之前逐字节相同）。工厂未配置或读链失败时保存返回
  `503`，`reasonCode = "HOOKS_LAUNCH_FACTORY_UNAVAILABLE"`（绝不回退到常量）。
- 已保存配置的 `nftSaleDurationSeconds` 与目标工厂不一致（例如工厂由 7 天换成 1 小时后，
  旧的 604800 配置）：签名准备与提交返回 `503`，
  `reasonCode = "HOOKS_FACTORY_TEMPLATE_MISMATCH"`，不签名、不记录任务。处理方式：重新保存
  一版配置（会按新工厂重算 hash）并重新走独立审批；重试同一版本不会成功。
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

200（任务资源，§6 GET/DELETE 同结构；决策 0112 起多出 `txHash` 之后的字段）：

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
  "txHash": null,
  "confirmations": null,
  "activationTxHash": null,
  "addresses": {
    "predicted": { "meme": "0x…6666", "hook": "0x…20cc" },
    "deployed": null
  },
  "failure": null,
  "attemptCount": 0,
  "events": [
    {
      "sequence": 1,
      "fromStatus": null,
      "toStatus": "awaiting_executor",
      "kind": "created",
      "txHash": null,
      "blockNumber": null,
      "blockHash": null,
      "confirmations": null,
      "errorCode": null,
      "createdAt": "2026-10-09T00:00:00.000Z"
    }
  ],
  "createdAt": "2026-10-09T00:00:00.000Z",
  "updatedAt": "2026-10-09T00:00:00.000Z"
}
```

- 最新配置版本必须已被平台独立审批，否则 `403 POLICY_BLOCKED`
  （`detailsSafe.reasonCode = "HOOKS_CONFIG_NOT_APPROVED"`），前端显示「等待平台审批」。
- 同一 `Idempotency-Key` 重放同一请求返回同一任务（超时重试请复用 key 与签名）；同 key
  不同内容 `409 IDEMPOTENCY_CONFLICT`。
- 签名或字段不匹配：`400 INVALID_REQUEST`；配置已变或与已有任务冲突：`409 VERSION_CONFLICT`。
- `awaiting_executor` 只表示「已验签登记」，**不是**已上链；之后由执行器推进（§9）。

## 6. `GET` / `DELETE …/hooks-deployments/{jobId}`

- `GET`（`getV2HooksLaunchDeployment`）：返回 §5 结构（含执行器进度，§9）；非本人 `404`。
  部署页轮询本接口即可（建议 5 s，`activated` / `failed`（`retryable=false`）/ `cancelled`
  后停止）。
- `DELETE`（`cancelV2HooksLaunchDeployment`，需 `Idempotency-Key`）：`awaiting_executor →
cancelled`，已取消再取消返回原状态。**执行器认领之后（`claimed` 及以后）不可取消**：
  `409 VERSION_CONFLICT`，`detailsSafe.reasonCode = "HOOKS_DEPLOYMENT_NOT_CANCELLABLE"`，
  前端隐藏「取消」按钮即可（`status != awaiting_executor` 时）。取消不撤销已给出的链上签名。

## 7. 错误码汇总

| 状态 | code                             | 场景                                                                                                                              |
| ---- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | 结构/字段非法、覆盖经济参数、开售过早、PUT 带 Idempotency-Key、POST/DELETE 缺 key、钱包非本人活跃钱包、签名/deadline/CREATE2 不符 |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | Bearer 缺失或无效                                                                                                                 |
| 403  | `POLICY_BLOCKED`                 | `HOOKS_CONFIG_NOT_APPROVED`                                                                                                       |
| 404  | `NOT_FOUND`                      | 非本人项目 / 无草稿 / 任务不存在                                                                                                  |
| 409  | `VERSION_CONFLICT`               | CAS 过期、配置已变、任务冲突；DELETE 已被执行器认领（`HOOKS_DEPLOYMENT_NOT_CANCELLABLE`）                                         |
| 409  | `IDEMPOTENCY_CONFLICT`           | 同 key 不同请求                                                                                                                   |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED`     | 账号未 bootstrap                                                                                                                  |
| 503  | `CAPABILITY_UNAVAILABLE`         | `HOOKS_LAUNCH_DISABLED` / `HOOKS_LAUNCH_FACTORY_UNAVAILABLE` / `HOOKS_FACTORY_TEMPLATE_MISMATCH`（决策 0119，见 §0）              |
| 500  | `INTERNAL_ERROR`                 | —                                                                                                                                 |

## 8. unavailable 行为

开关关闭：所有页面块显示「Hooks 发射未开放」。开关开但无 Factory（或读链失败）：可编辑草稿
表单，但**保存、签名与提交**均返回 `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`，按钮显示「测试网工厂
未配置」（决策 0119：发售期取自工厂，没有工厂就无法生成 `configHash`）。
`HOOKS_FACTORY_TEMPLATE_MISMATCH`：提示「发射模板已更新，请重新保存配置并重新提交审批」。
NFT 发售时长展示取 `config.fixedEconomics.nftSaleDurationSeconds`，不要写死 7 天。
不得用本地数据伪造任务状态。

## 9. 部署进度（S132 / 决策 0112）

### 9.1 状态

| `status`            | 含义（前端文案建议）                                                                 | 终态 |
| ------------------- | ------------------------------------------------------------------------------------ | ---- |
| `awaiting_executor` | 已验签登记，等待执行器（「排队中」）                                                 | 否   |
| `claimed`           | 执行器已认领，正在复核配置/审批/签名期限/nonce（「准备部署」）                       | 否   |
| `broadcast`         | 部署交易已签名入库并发出，`txHash` 可展示；等待确认（「已上链，等待确认 n/3」）      | 否   |
| `confirmed`         | 达到确认数（默认 3），正在逐模块核验（「核验中」）                                   | 否   |
| `verified`          | 全部模块核验一致，激活交易已发出或即将发出（「激活中」）                             | 否   |
| `activated`         | 链上已激活（`LaunchPublicationGate.published = true`）；`addresses.deployed` 为准    | 是   |
| `failed`            | 见 `failure.code`；`failure.retryable = true` 时执行器会自动重试，前端显示「重试中」 | 视情 |
| `reorged`           | 回执所在区块被重组，执行器将重发同一笔交易（「链上重组，重新确认中」）               | 否   |
| `cancelled`         | 认领前被项目方取消                                                                   | 是   |

- 「部署」不等于「激活」：只有 `activated` 才可向用户展示「已发布」；`verified` 之前的实例
  在链上也不能 mint、买入或卖出（合约层闸门）。
- `confirmations` 是部署交易最近一次观测的确认数（整数，可能落后于链头几秒）。确认阈值是
  后台配置（默认 3），不在接口中下发；前端显示「n 确认」即可，不要自行判断完成。
- `txHash` / `activationTxHash` 可做区块浏览器链接（BscScan Testnet）。
- 地址：`addresses.predicted` 是签名绑定的 CREATE2 预测（S125 的 `memeAddress` /
  `hookAddress` 同值）；`addresses.deployed` 在 `verified` 后才有值，包含 `launchId`（bytes32
  链上事实，不是 LOOP 主键）和 11 个模块地址。展示与交易一律用 `deployed`，且只在
  `activated` 后开放交易入口。

### 9.2 `failure.code`

| code                                   | retryable | 文案建议                                           |
| -------------------------------------- | --------- | -------------------------------------------------- |
| `HOOKS_SIGNATURE_EXPIRED`              | 否        | 签名已过期，请重新签名提交（新 `Idempotency-Key`） |
| `HOOKS_CONFIG_SUPERSEDED`              | 否        | 配置已更新，请重新签名                             |
| `HOOKS_CONFIG_NOT_APPROVED`            | 否        | 配置审批已失效，等待平台审批后重新签名             |
| `HOOKS_AUTHORIZATION_INVALID`          | 否        | 签名无效，请重新签名                               |
| `HOOKS_OWNER_NONCE_CONSUMED`           | 否        | 钱包 nonce 已变化，请重新签名                      |
| `HOOKS_LAUNCH_ALREADY_DEPLOYED`        | 否        | 该版本已在链上部署，联系平台                       |
| `HOOKS_ACTIVATION_WINDOW_CLOSED`       | 否        | 距开售太近无法激活，修改开售时间后重新提交         |
| `HOOKS_DEPLOY_SIMULATION_REVERTED`     | 否        | 链上预执行失败，联系平台                           |
| `HOOKS_DEPLOY_GAS_ABOVE_CAP`           | 否        | 联系平台                                           |
| `HOOKS_VERIFICATION_MISMATCH`          | 否        | 部署核验不一致，**未激活**，联系平台               |
| `HOOKS_ACTIVATION_STATE_UNEXPECTED`    | 否        | 联系平台                                           |
| `HOOKS_ACTIVATION_SIMULATION_REVERTED` | 否        | 联系平台                                           |
| `HOOKS_ACTIVATION_REVERTED`            | 否        | 激活多次失败，联系平台                             |
| `HOOKS_EXECUTOR_FUNDS_INSUFFICIENT`    | 是        | 平台处理中（执行账户余额不足）                     |
| `HOOKS_BROADCAST_REJECTED`             | 是        | 平台处理中                                         |
| `HOOKS_TX_DROPPED`                     | 是        | 平台处理中                                         |
| `HOOKS_DEPLOY_REVERTED`                | 是        | 平台处理中                                         |

`retryable = true` 且尝试次数用尽后会变为 `false`（`attemptCount` 达到后台上限，默认 3）。
未列出的新 code 一律按「联系平台」处理。

### 9.3 `events[]`

最近 100 条，按 `sequence` 升序；`kind` 取值见 OpenAPI 描述（`created`、`claimed`、
`broadcast`、`included`、`confirmed`、`reorg_detected`、`reclaimed_after_reorg`、
`rebroadcast`、`verified`、`activation_broadcast`、`activation_included`、`activated`、
`failed`、`cancelled` 等），未知 kind 按通用文案显示。`blockNumber` 为十进制字符串。事件中
不含签名、原始交易或任何密钥。

### 9.4 unavailable

执行器默认关闭（`HOOKS_LAUNCH_EXECUTOR_ENABLED=off`）：任务停在 `awaiting_executor`，接口
照常返回，不伪造进度。执行器打开但执行账户未被 Factory 授权、Factory code hash 不符或链不是
97 时，执行器空转（任务不被认领），前端同样只看到 `awaiting_executor`。
