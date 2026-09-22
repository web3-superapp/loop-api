# 前端联调：V2 资金动作 —— Send / 授权 / Privy Swap / 统一结果（S6 / D15 + D16）

本文是 `sendApprovals` 与 `swap` 两个模块（决策 0035）的前端交接契约。权威机器契约为
`openapi/loop-api.v2.json`。通用规则（Base URL、`X-Request-ID`、错误体七字段、Bearer、
`X-Loop-Contract-Version: 2.0`）沿用 `docs/frontend-v2-session-api.md`、
`docs/frontend-v2-wallet-api.md` 与 `docs/api-v2-conventions.md`。

覆盖页面：`send`、`send-to`、`send-confirm`、`swap`、`swap-route`、`tx-result`、
`approval-guard`、`approvals`，以及 `sign-sheet-states` 的真实弹层。`pay`、`bridge`、
`bridge-status`、`dapp` 本步仍是 unavailable（第 8 步）。

## 1. 启用条件与 capability

- 后端 `V2_MODULES_ENABLED` 必须包含 `sendApprovals`（Send / 授权 / 盘点）与 `swap`
  （报价 / Swap intent / execute）；两者共用 `GET /v2/wallet-intents*`、`cancel`、
  `broadcast-report`。模块未启用时对应路径 `404 NOT_FOUND`。
- 前端必须先读 `GET /v2/meta/capabilities`：

| capabilityId    | `available` 条件                                                                                                     | 典型 reasonCode（unavailable）                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sendApprovals` | 模块启用 + intent 运行时已组装 + RPC 已配置 + `BSC_WRITES_ENABLED=true` + `eth_chainId == 56` 已实测                 | `WALLET_INTENT_RUNTIME_UNAVAILABLE` / `BSC_RPC_NOT_CONFIGURED` / `BSC_WRITES_DISABLED` / `BSC_CHAIN_VERIFICATION_PENDING` / `BSC_RPC_UNREACHABLE` / `BSC_CHAIN_ID_MISMATCH` |
| `privySwap`     | 同上 + Privy 凭据；**`evidence` 永远是 `{status: "pending", reasonCode: "PRIVY_BSC_SWAP_DEVICE_EVIDENCE_PENDING"}`** | 上述 + `PRIVY_NOT_CONFIGURED`                                                                                                                                               |

**Swap 页的确认按钮受 `privySwap.evidence` 门禁**：evidence 仍是 `pending` 时可以报价、
可以展示，但确认按钮必须禁用并显示"真机证据未取得"。`available` 只表示后端配置可用，
不是 Provider 或真机证据。

- 写开关关闭（`BSC_WRITES_ENABLED=false`，默认）时所有 prepare / broadcast-report /
  execute / quote 返回 `503 CAPABILITY_UNAVAILABLE`；`preflight`、`GET` 读接口、
  `GET /v2/approvals*` 不受写开关影响。
- 开启时是 **canary**（Decision 0065）：只允许 `BSC_WRITE_CANARY_ASSETS` 里的资产，
  单笔 USD 价值 ≤ `BSC_WRITE_CANARY_MAX_USD`（Development = 5），同一账号滚动 24 小时
  累计 ≤ `BSC_WRITE_CANARY_DAILY_MAX_USD`（Development = 25；未配置 = 不限），收款方 /
  授权 spender 必须在 `BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST` 内（为空 = 不限收款人；
  revoke 永远放行）。任何一条不满足 → `403 POLICY_BLOCKED`，`detailsSafe.reasonCode`
  说明是哪条规则（见 §7.1）。
  日上限只在 prepare 时判定：已经拿到可签 intent 的设备不会被后来的 prepare 挡住，
  broadcast-report 只复核单笔上限。日上限只累计"可能已花或仍可能花"的 intent
  （`awaiting_signature`/`submitted`/`confirmed`/`reverted`/`unknown`）；被取消、过期、
  被新 intent 取代、或证明未发出的 intent 不占额度。
- Development 上写开关已打开（真钱小额）。**成功返回 intent 不代表链上完成**，
  仍以 `GET /v2/wallet-intents/{intentId}` 的状态机为准。
  价值无法用**新鲜**行情定价（无行情或 stale）→ `503 CAPABILITY_UNAVAILABLE`，不会假定"很小"。

## 2. Headers

| 接口                                                                   | 必须                                                              | `Idempotency-Key`                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /v2/wallet-intents/send` / `approve` / `revoke` / `swap`         | Bearer + `X-Loop-Contract-Version: 2.0` + `X-Loop-Client-Version` | **必须**，绑定请求体（同 key 不同 body → `409 IDEMPOTENCY_CONFLICT`；同 body → `200` 返回原 intent） |
| `POST /v2/wallet-intents/{id}/broadcast-report` / `execute` / `cancel` | 同上                                                              | **必须**（自然幂等，不绑定 body）                                                                    |
| `POST /v2/wallet-intents/send/preflight`、`POST /v2/swap/quote`        | 同上                                                              | **禁止**（带了 `400`）；它们不落库                                                                   |
| `GET /v2/wallet-intents*`、`GET /v2/approvals*`                        | 同上                                                              | **禁止**                                                                                             |

`X-Loop-Platform` / `X-Loop-Device-ID` 可选，带了会校验。金额字段一律 JSON **字符串**
（数字 → `400`）。所有响应 `Cache-Control: no-store`。

## 3. Intent 资源（所有 kind 同一形状）

`POST …/send|approve|revoke|swap`（201 新建 / 200 幂等回放）、`GET /v2/wallet-intents/{intentId}`、
`cancel`、`broadcast-report`、`execute` 都返回：

```json
{
  "intentId": "a83b3f20-8c3a-43dd-bd8a-8433421cbb50",
  "kind": "send",
  "state": "awaiting_signature",
  "walletId": "d64786bb-408d-415d-8a69-6277d56c921b",
  "chainId": "eip155:56",
  "review": {
    "kind": "send",
    "asset": {
      "assetId": "eip155:56:0xbb4c…095c",
      "address": "0xbb4c…095c",
      "symbol": "WBNB",
      "decimals": 18
    },
    "amount": { "raw": "10000000000000000", "display": "0.01" },
    "recipient": {
      "address": "0x0000…dead",
      "checksumAddress": "0x000000000000000000000000000000000000dEaD",
      "isContract": false,
      "isFirstRecipient": true,
      "basis": "indexed_erc20_transfers",
      "screening": {
        "status": "unavailable",
        "reasonCode": "GOPLUS_ADDRESS_SCREENING_NOT_CONFIGURED"
      }
    },
    "spender": null,
    "decodedCall": {
      "functionName": "transfer",
      "selector": "0xa9059cbb",
      "args": { "to": "0x0000…dead", "value": "10000000000000000" }
    },
    "fee": {
      "gasLimit": "41550",
      "type": "eip1559",
      "maxFeePerGas": "50000000",
      "maxPriorityFeePerGas": "50000000",
      "gasPrice": null,
      "maximumFeeRaw": "2077500000000",
      "maximumFee": "0.0000020775",
      "observedAt": "2026-09-08T13:35:29.779Z"
    },
    "balance": {
      "blockNumber": "120695250",
      "blockHash": "0x9469…4034",
      "observedAt": "2026-09-08T13:35:28.315Z",
      "rawBalance": "882006596111096983278",
      "displayBalance": "882.006596111096983278",
      "rawNativeBalance": "87886581198398034814821",
      "gasReserveRaw": "5000000000000000"
    },
    "swap": null
  },
  "reviewSha256": "c5b7ffcb6c5ccc865ff6a133eeee96d9b37b10c5347a958d2129400513715d6c",
  "factsObservedAt": "2026-09-08T13:35:30.323Z",
  "expiresAt": "2026-09-08T13:37:30.323Z",
  "simulation": {
    "status": "passed",
    "source": "rpc_call",
    "observedAt": "2026-09-08T13:35:28.987Z",
    "reasonCode": null
  },
  "policy": {
    "configVersion": "bscWriteCanaryV1",
    "canaryMaxUsd": "20",
    "exposureBasis": "amount",
    "exposureRaw": "10000000000000000",
    "exposureBlockNumber": "120695250",
    "valueUsd": "7.50014",
    "priceSource": "dexscreener",
    "priceFetchedAt": "2026-09-08T13:35:27.916Z"
  },
  "signing": {
    "mode": "device_eth_send_transaction",
    "allowed": true,
    "reasonCode": null
  },
  "unsignedTransaction": {
    "chainId": 56,
    "from": "0x8894…d4e3",
    "to": "0xbb4c…095c",
    "data": "0xa9059cbb…",
    "value": "0x0",
    "gas": "0xa24e",
    "nonce": "0x360f772",
    "type": "eip1559",
    "maxFeePerGas": "0x2faf080",
    "maxPriorityFeePerGas": "0x2faf080",
    "gasPrice": null
  },
  "authorizationPayload": null,
  "result": {
    "transactionHash": null,
    "providerActionId": null,
    "reasonCode": null,
    "receipt": null
  },
  "version": "1",
  "createdAt": "…",
  "updatedAt": "…",
  "contractVersion": "2.0"
}
```

（以上是 2026-09-08 本机对真实 BSC RPC 的 prepare 输出，地址已截断。）

### 3.1 状态机

```text
prepared ────────────────────────────────────────── (模拟失败/不可用，永不可签)
awaiting_signature ──broadcast-report / execute──▶ submitted ──▶ confirmed | reverted | failed | unknown
prepared | awaiting_signature ──cancel──▶ cancelled
prepared | awaiting_signature ──过期 / 同钱包新 intent / 策略版本变化──▶ expired
unknown ──对账 lane──▶ confirmed | reverted | failed（否则锁定给运维）
```

| state                 | tx-result 展示  | 说明                                                                                          |
| --------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| `prepared`            | —（confirm 页） | `simulation.status` 是 `reverted`/`unavailable`（Swap 本步一律如此），`signing.allowed=false` |
| `awaiting_signature`  | —（Sign sheet） | 唯一 `signing.allowed=true` 的状态；过期后 `GET` 直接投影为 `expired`                         |
| `submitted`           | pending         | 已上报哈希 / Privy 已受理；轮询 `GET` 直到终态                                                |
| `confirmed`           | 成功 Toast      | Send：回执 success 且 ≥15 确认；Swap：Privy action `succeeded`                                |
| `reverted`            | 失败            | 链上回执 reverted / Privy step reverted；`result.reasonCode = TX_REVERTED`                    |
| `failed`              | 失败            | Provider 定性拒绝、哈希 payload 不符（`TX_PAYLOAD_MISMATCH`）等                               |
| `unknown`             | 未知（锁定）    | 结果不明；**禁止重复提交**，页面只轮询                                                        |
| `cancelled`/`expired` | 结束            | `result.reasonCode`：`USER_CANCELLED` / `INTENT_EXPIRED` / `INTENT_SUPERSEDED`                |

**签名前必须核对**：把展示用的 `review` 与 `unsignedTransaction`（或 `authorizationPayload`）
视为同一份后端 canonical；`reviewSha256` 是后端 canonical payload 的 SHA-256。客户端
`SigningIntent.origin` 必须是 `backendCanonical`；本地预览对象永不进入钱包。

`signing.reasonCode`（`allowed=false` 时）：`BSC_CALL_REVERTED`、`SIMULATION_UNAVAILABLE`、
`GAS_ESTIMATE_UNAVAILABLE`、`INTENT_EXPIRED`、`INTENT_SUPERSEDED`、`USER_CANCELLED`，
或 `INTENT_<STATE>`。

## 4. Send

### 4.1 `POST /v2/wallet-intents/send/preflight` → `send-to`

请求：`{ "walletId", "address", "chainId"? }`。`address` 可大小写混合，但混合大小写必须是
合法 EIP-55 校验和（错一位 → `400 INVALID_REQUEST`）。

```json
{
  "walletId": "…",
  "chainId": "eip155:56",
  "recipient": {
    "address": "0x…",
    "checksumAddress": "0x…",
    "isContract": false,
    "isFirstRecipient": true,
    "screening": {
      "status": "unavailable",
      "reasonCode": "GOPLUS_ADDRESS_SCREENING_NOT_CONFIGURED"
    }
  },
  "warnings": [
    "send.recipient.firstTime",
    "send.recipient.screeningUnavailable"
  ],
  "contractVersion": "2.0"
}
```

`warnings` 可能还有 `send.recipient.isContract`。筛查 unavailable **不阻断**，但要强提示。
自转（收款方 = 自己）→ `422 VALIDATION_FAILED`。

### 4.2 `POST /v2/wallet-intents/send` → `send-confirm`

请求：`{ "walletId", "assetId", "amount", "recipientAddress", "chainId"? }`，`amount` 是资产显示
单位的正十进制字符串。服务端：写开关 → 链校验 → 钱包必须是 Privy 嵌入式（外部钱包 →
`422 VALIDATION_FAILED`）→ 资产在 canary 名单（否则 `403`）→ USD 价值 ≤ 上限 → 余额快照
（`amount` > 余额 → `409 INSUFFICIENT_BALANCE`）→ `eth_call` + `estimateGas` → 费用 + pending
nonce → 原生转账还要 `amount + 最大费用 ≤ 原生余额` 且 `amount + gasReserve ≤ 原生余额`
（否则 `409 INSUFFICIENT_BALANCE`）。

`unsignedTransaction` 就是交给 Privy `EthereumRpcRequest(eth_sendTransaction, [tx])` 的对象，
**任何字段不得改动**。`expiresAt` = 事实观察 + 120 s；倒计时到 0 必须重新 prepare。
同一钱包再次 prepare 会把上一个未签名 intent 置为 `expired`（`INTENT_SUPERSEDED`）。

### 4.3 `POST /v2/wallet-intents/{intentId}/broadcast-report`

设备广播后上报 `{ "txHash": "0x…" }`。服务端读 `eth_getTransactionByHash` 并比对
from / to / input / value / nonce / chainId：不符 → `422 VALIDATION_FAILED`（并记审计事件，
intent 保持 `awaiting_signature`）；节点尚未看到该哈希 → 接受为 `submitted`，
`result.reasonCode = TX_PENDING_VERIFICATION`，由对账 lane 再核对。
`prepared` 上报 → `409 SIMULATION_FAILED`；同一哈希重复上报 → 200。

**迟到上报**：intent 已 `expired`（`INTENT_EXPIRED` / `INTENT_SUPERSEDED`）或 `cancelled`
（`USER_CANCELLED`）时，若链上已能看到该哈希且 payload 一致 → 仍接受为 `submitted`
（事件 `late_broadcast_report`）；链上看不到 → `409 DATA_STALE`。因此**签名/广播后必须先上报
（或取消），再 prepare 同钱包的新 intent**——新 prepare 会把旧 intent 置为 `expired`。

### 4.4 `GET /v2/wallet-intents/{intentId}` → `tx-result`

轮询建议 3–5 s。`result.receipt` 出现后带 `confirmations`（null 表示当时读不到链头）；
`confirmed` 需要 ≥ 15 确认。成功 Toast **只在** `confirmed`。分享入口沿用 chat 域。

`GET /v2/wallet-intents?cursor=|limit=`（1–50，二选一）列表同形状，最新在前。
**最后一页 `nextCursor: null`**（所有 v2 列表接口统一：服务端多取一行判断是否还有下一页，
`nextCursor` 非 null 当且仅当还有数据；前端以 `nextCursor === null` 作为终止条件即可，
不必再请求一次空页）。

`POST /v2/wallet-intents/{intentId}/cancel`（S6 联调实测，语义按此）：

| 当前状态                                                 | 结果                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `prepared` / `awaiting_signature`                        | `200`，转为 `cancelled`，`result.reasonCode = USER_CANCELLED`      |
| `cancelled`                                              | `200` **幂等**：原样返回，`updatedAt` 不变（重复点击取消是安全的） |
| 已过期但尚未落库                                         | `200`，投影为 `expired`（不是取消）                                |
| `expired`（含被新 intent supersede）/ `submitted` 及之后 | `409 DATA_STALE`（可能已上链，页面重新 `GET`）                     |

## 5. 授权 / 撤销 / 盘点

### 5.1 `POST /v2/wallet-intents/approve` → `approval-guard`

```json
{
  "walletId": "…",
  "assetId": "eip155:56:0x…",
  "spenderAddress": "0x…",
  "allowance": { "mode": "exact", "amount": "5" }
}
```

或 `"allowance": { "mode": "unlimited" }` **加顶层** `"acknowledgeUnlimited": true`
（缺失/false → `422 VALIDATION_FAILED`，这是原型"仍要无限授权"的二次确认）。canary 上限按
**实际敞口** `min(allowance, 当前余额) × 价格` 判定（`policy.exposureBasis =
"balance_at_prepare"`，`exposureRaw`、`exposureBlockNumber` 记录快照），余额超上限 →
`403 POLICY_BLOCKED`，`detailsSafe.reasonCode` 为 `UNLIMITED_EXPOSURE_EXCEEDS_CEILING`
（无限授权）或 `CANARY_CEILING_EXCEEDED`（精确额度），并带 `exposureUsd` / `ceilingUsd`
（§7.1）。`allowance.amount` 必须是字符串（数字 → `400`）。
响应里 `review.spender`（`isContract`、`isUnlimited`）与 `review.decodedCall`
（`approve`，`args.spender/value`）就是原型 approval-guard 要展示的解码字段。

**校验顺序**：请求形状（`400`）→ 资产存在且未 blocked → **原生资产无授权面 →
`422 VALIDATION_FAILED`，`detailsSafe.reasonCode = NATIVE_ASSET_NOT_APPROVABLE`**（在
canary 名单之前判定，所以不管名单里有没有 native 都是 422）→ canary 名单（`403`）→
spender 形状/自授权（`400`/`422`）→ 上限（`403`）。

### 5.2 `POST /v2/wallet-intents/revoke`

`{ "walletId", "assetId", "spenderAddress" }` → `approve(spender, 0)`，`review.amount = {"0","0"}`，
`policy.valueUsd = null`（不定价、不受上限）。授权与业务交易是两个 intent，状态分开显示。

### 5.3 `GET /v2/approvals?walletId=` → `approvals`

**可用条件**：`Approval` 与转账共用 `erc20_transfer` lane 的 checkpoint，但 `Approval` 解码
只覆盖 `[approvalCoverageFromBlockNumber, indexerBlockNumber]`（迁移 000021 之前回填的区间
只有转账没有授权）。以下任一情况 → `503 INDEXING_DELAYED`，页面显示 unavailable、可重试，
**绝不显示"0 个授权"**：

- lane 尚无 checkpoint；
- `approval_coverage_from_block` 为 null（lane 还没在带 Approval 解码的代码下推进过）；
- 覆盖起点**高于该钱包最早被索引到的转账块**（钱包在覆盖之前就有活动，中间可能有授权）。

运维用 `pnpm indexer:backfill --lane erc20_transfer --from <block>` 把覆盖起点向下补到 `<block>`
（只补 `Approval`，不动 checkpoint）。满足条件时：

```json
{
  "walletId": "…",
  "items": [
    {
      "assetId": "eip155:56:0x55d3…7955",
      "symbol": "USDT",
      "decimals": 18,
      "spender": { "address": "0x10ed…024e", "checksumAddress": "0x10ED…024E" },
      "allowance": {
        "status": "available",
        "rawValue": "5000000000000000000",
        "displayValue": "5",
        "isUnlimited": false,
        "blockNumber": "120695250",
        "blockHash": "0x…",
        "observedAt": "…"
      },
      "lastApproval": {
        "transactionHash": "0x…",
        "blockNumber": "…",
        "rawValue": "…",
        "observedAt": "…"
      },
      "riskFacts": {
        "status": "unavailable",
        "reasonCode": "GOPLUS_APPROVAL_FACTS_NOT_CONFIGURED"
      }
    }
  ],
  "summary": { "activeCount": 1, "unlimitedCount": 0 },
  "freshness": {
    "indexerBlockNumber": "…",
    "approvalCoverageFromBlockNumber": "…",
    "headBlockNumber": "…",
    "observedAt": "…"
  },
  "contractVersion": "2.0"
}
```

`freshness.approvalCoverageFromBlockNumber` 是本次盘点的 `Approval` 覆盖起点（页面可显示
"授权记录自区块 N 起"）。候选来自链上 `Approval` 事件（与转账同一 indexer lane、同一 checkpoint），每一行的
`allowance` 都是**当场 RPC 重读**的 `allowance()`；当前额度为 0 的行不列出；读不到 →
`{status: "unavailable", reasonCode}`，绝不显示为 0。`displayValue` 可能是 `"unlimited"`。
"回收"走 §5.2。

`GET /v2/approvals/{assetId}/{spender}?walletId=` 不依赖 indexer，直接读当前值
（`{ walletId, item, contractVersion }`）。

## 6. Privy Swap

### 6.1 `POST /v2/swap/quote` → `swap` / `swap-route`

```json
{
  "walletId": "…",
  "sourceAssetId": "eip155:56:0x…",
  "destinationAssetId": "eip155:56:0x…",
  "amount": "0.005",
  "slippageBps": 50
}
```

`slippageBps` 默认 50，最大 300（超出 `400`）。响应：

```json
{
  "walletId": "…",
  "sourceAsset": { "assetId": "…", "address": "…", "symbol": "WBNB", "decimals": 18 },
  "destinationAsset": { "…" },
  "quote": {
    "quoteId": "…", "provider": "privy", "amountType": "exact_input",
    "inputAmount": { "raw": "…", "display": "…" },
    "estimatedOutputAmount": { "raw": "…", "display": "…" },
    "minimumOutputAmount": { "raw": "…", "display": "…" },
    "slippageBps": 50, "gasEstimateRaw": "…",
    "quotedAt": "…", "expiresAt": "…（quotedAt + 30 s）",
    "priceImpact": { "status": "available", "value": "0.0025", "decision": "allowed", "reasonCode": null,
                     "marketValueUsd": "…", "estimatedOutputValueUsd": "…", "priceSource": "dexscreener" },
    "platformFeeBps": null
  },
  "policy": { "configVersion": "swapPolicyV1", "status": "pendingProductConfirmation",
              "defaultSlippageBps": 50, "maximumSlippageBps": 300,
              "hardBlockPriceImpact": "0.05", "confirmPriceImpact": "0.01", "quoteTtlSeconds": 30 },
  "canary": { "configVersion": "bscWriteCanaryV1", "canaryMaxUsd": "20", "inputValueUsd": "3.75" },
  "contractVersion": "2.0"
}
```

`priceImpact.decision`：`allowed`（<1%）/ `confirm`（1–5%，需二次确认）/ `blocked`（≥5% 或
无法定价，`reasonCode` 为 `PRICE_IMPACT_ABOVE_HARD_LIMIT` / `PRICE_IMPACT_UNAVAILABLE`）。
滑点与价格影响分开显示。30 s 倒计时到 0 重新报价。Privy 定性拒绝 → `422 VALIDATION_FAILED`；
Privy 不可达 → `503 PROVIDER_DISCONNECTED`。

> 本机记录：以真实 Privy 凭据但**非真实嵌入式钱包 id** 调用时，Privy 返回定性 4xx，
> 后端投影为 `422 VALIDATION_FAILED`；真实 quote 响应形状要等真机钱包（Go/No-Go）。

### 6.2 `POST /v2/wallet-intents/swap`

`{ "walletId", "quoteId", "confirmPriceImpact"? }`。`decision=confirm` 必须带
`confirmPriceImpact: true`（否则 `422`）；`blocked` → `403`；quote 过期/未知 →
`409 QUOTE_EXPIRED`。响应是 §3 的 intent，`kind=swap`，`signing.mode =
"privy_authorization_signature"`，`unsignedTransaction=null`，`review.swap` 带 quote 快照与
policy，`expiresAt` = quote 过期时间。**本步 Swap 没有 Provider 侧模拟**：
`simulation = {status: "unavailable", source: "provider_quote", reasonCode:
"SWAP_SIMULATION_PROVIDER_PENDING"}`，intent 停在 `prepared`，`signing.allowed=false`，
`execute` 返回 `409 SIMULATION_FAILED`。Swap 页可以报价、可以展示 review，确认按钮禁用。
一个 quote 只能 prepare 一次（第二次 → `409 QUOTE_EXPIRED`）。

`authorizationPayload` 是设备用 `generateAuthorizationSignature` 签名的对象，原样、不改字段：

```json
{
  "version": 1,
  "method": "POST",
  "url": "https://api.privy.io/v1/wallets/<privyWalletId>/swap",
  "body": {
    "base_amount": "…",
    "source": { "asset_address": "0x…|native", "caip2": "eip155:56" },
    "destination": { "asset_address": "…", "caip2": "eip155:56" },
    "amount_type": "exact_input",
    "slippage_bps": 50
  },
  "headers": {
    "privy-app-id": "…",
    "privy-idempotency-key": "<intentId>",
    "privy-request-expiry": "<expiresAt ms>"
  }
}
```

### 6.3 `POST /v2/wallet-intents/{intentId}/execute`

`{ "authorizationSignature": "<设备签名>" }`。服务端**只执行一次**：intent 先进
`submitted`、journal 记一次尝试，再调 Privy。Privy 受理 → `submitted`（`result.providerActionId`）
或直接终态；定性拒绝 → `failed`（`PRIVY_SWAP_REJECTED`）；超时/5xx/断连 → `unknown`
（`PROVIDER_RESULT_AMBIGUOUS`），**不重试**。再次调用 → `409 SUBMISSION_UNKNOWN`；过期 →
`409 QUOTE_EXPIRED`。之后轮询 `GET /v2/wallet-intents/{intentId}`。

## 7. 错误码速查

| HTTP | code                     | 出现位置                                                                                                                                  | 前端动作                                  |
| ---- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 400  | `INVALID_REQUEST`        | 未知字段、金额是数字、错误校验和、缺/多 `Idempotency-Key`                                                                                 | 修请求                                    |
| 401  | `AUTH_REQUIRED/INVALID`  | Bearer                                                                                                                                    | 重新登录                                  |
| 403  | `POLICY_BLOCKED`         | canary 名单/上限（授权按实际敞口）、价格影响 ≥5%、资产 blocked；`detailsSafe.reasonCode` 区分（§7.1）                                     | 显示策略文案（安全中心 D20 前"暂不可调"） |
| 404  | `NOT_FOUND`              | 模块未启用、钱包/资产/intent 不存在                                                                                                       | 不可枚举                                  |
| 409  | `IDEMPOTENCY_CONFLICT`   | 同 key 不同 body                                                                                                                          | 换 key                                    |
| 409  | `INSUFFICIENT_BALANCE`   | 余额 / gas 储备                                                                                                                           | 提示余额不足                              |
| 409  | `SIMULATION_FAILED`      | 对 `prepared` intent 上报 / execute（含全部 Swap）                                                                                        | 回到确认页，重新 prepare                  |
| 409  | `DATA_STALE`             | intent 过期/已进入后续状态、策略版本变化、钱包变化                                                                                        | 重新 `GET` 或重新 prepare                 |
| 409  | `QUOTE_EXPIRED`          | quote 过期/未知、swap intent 过期                                                                                                         | 重新报价                                  |
| 409  | `SUBMISSION_UNKNOWN`     | 重复 execute                                                                                                                              | 只轮询，不重发                            |
| 422  | `CHAIN_MISMATCH`         | 非 `eip155:56`                                                                                                                            | 修请求                                    |
| 422  | `VALIDATION_FAILED`      | 外部钱包、自转、原生资产授权（`detailsSafe.reasonCode = NATIVE_ASSET_NOT_APPROVABLE`）、未确认无限授权、哈希 payload 不符、Privy 定性拒绝 | 按场景提示                                |
| 503  | `CAPABILITY_UNAVAILABLE` | 写开关关闭、链未校验/不可达、无法定价、RPC 事实读不到                                                                                     | 整块 unavailable，可重试                  |
| 503  | `INDEXING_DELAYED`       | 授权盘点无 checkpoint / 无 Approval 覆盖 / 覆盖晚于钱包最早活动（§5.3）                                                                   | unavailable，可重试                       |
| 503  | `PROVIDER_DISCONNECTED`  | Privy 报价不可达（超时 / 5xx / 429）                                                                                                      | 可重试                                    |
| 503  | `CAPABILITY_UNAVAILABLE` | Privy 对 quote 回 401/403（例如"Swaps are not enabled for this app"）→ 该能力当前不存在，不是用户输入错误（Decision 0065）                | 显示 unavailable，不提示用户改参数        |

### 7.1 `detailsSafe`（策略拒绝的原因槽位）

七字段信封里 `detailsSafe` 平时为 `null`；以下拒绝带一个只含标量的对象，前端按
`reasonCode` 选文案，其余字段用于渲染数字：

| HTTP / code             | `detailsSafe`                                                                                    | 出现位置                               |
| ----------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `403 POLICY_BLOCKED`    | `{ "reasonCode": "ASSET_NOT_IN_CANARY_ALLOWLIST" }`                                              | send / approve / revoke / swap         |
| `403 POLICY_BLOCKED`    | `{ "reasonCode": "CANARY_CEILING_EXCEEDED", "exposureUsd": "5.9976", "ceilingUsd": "5" }`        | send、精确额度 approve、swap（单笔）   |
| `403 POLICY_BLOCKED`    | `{ "reasonCode": "CANARY_DAILY_CEILING_EXCEEDED", "exposureUsd": "27.5", "ceilingUsd": "25" }`   | send / approve / swap（滚动 24 小时）  |
| `403 POLICY_BLOCKED`    | `{ "reasonCode": "COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST" }`                                       | send 收款人、approve spender           |
| `403 POLICY_BLOCKED`    | `{ "reasonCode": "UNLIMITED_EXPOSURE_EXCEEDS_CEILING", "exposureUsd": "…", "ceilingUsd": "20" }` | unlimited approve（按实际敞口）        |
| `403 POLICY_BLOCKED`    | `{ "reasonCode": "ASSET_BLOCKED" }`                                                              | 注册表里 `status = blocked` 的资产     |
| `403 POLICY_BLOCKED`    | `{ "reasonCode": "PRICE_IMPACT_BLOCKED" }`                                                       | swap（价格影响 ≥ 阈值）                |
| `422 VALIDATION_FAILED` | `{ "reasonCode": "NATIVE_ASSET_NOT_APPROVABLE" }`                                                | approve / revoke 的 `eip155:56:native` |

`exposureUsd` / `ceilingUsd` 是十进制字符串（不是数字），`exposureUsd` 就是 prepare 时按
新鲜行情算出的价值 / 实际敞口。其他 `VALIDATION_FAILED`、`POLICY_BLOCKED` 场景 `detailsSafe`
仍为 `null`；前端不得依赖未列出的键。

## 8. 本步明确 unavailable / pending 的项

| 项目                      | 表现                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 收款方恶意地址筛查        | `screening.status=unavailable`，`GOPLUS_ADDRESS_SCREENING_NOT_CONFIGURED`                                                                                                                                     |
| 授权风险事实              | `riskFacts.status=unavailable`，`GOPLUS_APPROVAL_FACTS_NOT_CONFIGURED`                                                                                                                                        |
| Privy BSC Swap 真机证据   | `privySwap.evidence.status=pending`                                                                                                                                                                           |
| Privy Swap 能力本身       | 2026-09-22 实测 Provider 回 `403 Swaps are not enabled for this app`；`POST /v2/swap/quote` → `503 CAPABILITY_UNAVAILABLE`。`privySwap.availability=available` 只说明 LOOP 侧配置齐全，不代表 Provider 已开通 |
| 钱包无 BNB                | prepare 走到 gas 储备校验 → `409 INSUFFICIENT_BALANCE`（不是 500）；文案应说明"需要 BNB 付手续费"                                                                                                             |
| 平台费                    | `platformFeeBps: null`（`LOOP_SWAP_FEE_BPS` 待决策）                                                                                                                                                          |
| 滑点/价格影响策略产品确认 | `policy.status = "pendingProductConfirmation"`                                                                                                                                                                |
| 用户自定义单笔上限（D20） | 只有 canary 上限会触发 `POLICY_BLOCKED`                                                                                                                                                                       |
| 资产变动分析 / 模拟评分   | 不提供；只有 `simulation.status`                                                                                                                                                                              |
