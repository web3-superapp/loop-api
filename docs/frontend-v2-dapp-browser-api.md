# 前端联调：内置 DApp 浏览器的服务端接口（S342 / 决策 0197，主代理决策 0270）

本文是 S342-mobile 的交接契约，覆盖四个接口：

| 接口                                                  | operationId                     | 用途                                              |
| ----------------------------------------------------- | ------------------------------- | ------------------------------------------------- |
| `POST /v2/wallet-intents/dapp-tx`                     | `prepareV2DappTxIntent`         | 页面的 `eth_sendTransaction` → `dapp_tx` intent   |
| `POST /v2/wallet-intents/dapp-sign`                   | `prepareV2DappSignIntent`       | `personal_sign` / `eth_signTypedData_v4` → intent |
| `POST /v2/wallet-intents/{intentId}/signature-report` | `reportV2WalletIntentSignature` | 回报签名，`dapp_sign` → `confirmed`               |
| `POST /v2/chain/rpc-read`                             | `readV2ChainRpc`                | 页面读方法的只读代理                              |

权威机器契约：`openapi/loop-api.v2.json`。通用规则（七字段错误体、Bearer、intent 资源形状、
`cancel`、`broadcast-report`、`tx-result` 轮询）沿用 `docs/frontend-v2-wallet-intents-api.md`；本文只写差异。

## 1. 启用条件与 unavailable 行为

- Base URL：同其他 `/v2`（Development `https://api-dev…`，staging `https://api-staging…`）。
- 后端 `V2_MODULES_ENABLED` 含 `sendApprovals`（否则路径 404）。
- 服务端开关 `DAPP_BROWSER_ENABLED`，**默认 off**。off 时 `dapp-tx`、`dapp-sign`、`rpc-read` 三条路由一律
  `503 CAPABILITY_UNAVAILABLE`，`detailsSafe = {"reasonCode": "DAPP_BROWSER_DISABLED"}`。
  （`signature-report` 不受开关影响：已签出的签名总能记账。）
- `/v2/meta/capabilities` 新增 `capabilityId: "dappBrowser"`：
  - `available`：开关 on + `sendApprovals` 已组装 + `BSC_WRITES_ENABLED` + launch slot 是独立测试网（staging `eip155:97`）且有 RPC。
  - 否则 `unavailable`，`reasonCode` 依次为 `DAPP_BROWSER_DISABLED` / `SEND_APPROVALS_RUNTIME_DEFERRED` /
    `BSC_WRITES_DISABLED` / `DAPP_BROWSER_CHAIN_UNAVAILABLE`；`evidence` 恒为 `{status: "notApplicable", reasonCode: null}`。
  - App：`unavailable` 时入口降级为原「DApp 网址核对」页（docs/55 §三），不报错。链实时校验仍以各路由的 503 为准。
- 旧的 `dappExecution`（deferred）不变，与本能力无关。

## 2. 通用 headers

| 接口                                         | Headers                                                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dapp-tx` / `dapp-sign` / `signature-report` | `Authorization: Bearer <privy>`、`X-Loop-Contract-Version: 2.0`、`X-Loop-Client-Version`、`Idempotency-Key: <小写 UUIDv4>`（必须）、`Content-Type: application/json` |
| `rpc-read`                                   | 同上但**不得**带 `Idempotency-Key`（带了 400；同 `swap/quote`）                                                                                                      |

## 3. 链与网络规则（App 必须遵守）

- 能签的链只有 launch slot 测试网（staging `eip155:97`）。`eip155:56` 上的任何签名 / 发交易请求：
  服务端 `422 VALIDATION_FAILED` / `CHAIN_SIGNING_DISABLED`；App 直接回页面 EIP-1193 `4100`，
  用户可见「暂不支持在这个网络签名」，**不必**先调服务端。
- 其他链：`422 CHAIN_MISMATCH`。
- 读（`rpc-read`）可以在 `eip155:56` 与 `eip155:97` 上。
- `chainId` 一律 CAIP-2 字符串（`"eip155:97"`）；页面传的 `0x61` 由 App 换算。

## 4. `POST /v2/wallet-intents/dapp-tx`

请求（未知键 400；`tx` 只认 `to` / `data` / `value`——App 把页面的交易对象裁成这三项，`from` 必须等于当前钱包，
`gas` / `gasPrice` / `nonce` 等丢弃，由服务端绑定）：

```json
{
  "walletId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  "chainId": "eip155:97",
  "origin": "https://app.example.org",
  "tx": {
    "to": "0x00000000000000000000000000000000000000D1",
    "data": "0x095ea7b300000000000000000000000000000000000000000000000000000000000000c3ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "value": "0x0"
  }
}
```

- `origin`：页面的 `scheme://host[:port]`。`http:` → 422 `ORIGIN_NOT_HTTPS`；带路径 / query / fragment / 账号 → 400。
  服务端规范化后回显（小写 host、punycode、去 `:443`）。
- `data`：偶数位 hex，≤ 10,000 字节，缺省 `0x`。`value`：JSON-RPC hex quantity（`0x0`、`0xde0b6b3a7640000`），缺省 `0x0`；JSON 数字 400。
- 合约部署（无 `to`）不支持 → App 回页面 `4200`。

响应 `201`（新建）/ `200`（同 key 同 body 重放）——标准 `walletIntentResource`，差异字段：

```json
{
  "intentId": "8c2f…",
  "kind": "dapp_tx",
  "state": "awaiting_signature",
  "walletId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  "chainId": "eip155:97",
  "review": {
    "kind": "dapp_tx",
    "asset": {
      "assetId": "eip155:97:native",
      "address": null,
      "symbol": "tBNB",
      "decimals": 18
    },
    "amount": { "raw": "0", "display": "0" },
    "recipient": null,
    "spender": null,
    "decodedCall": null,
    "fee": {
      "gasLimit": "55200",
      "type": "eip1559",
      "maxFeePerGas": "3000000000",
      "maxPriorityFeePerGas": "1000000000",
      "gasPrice": null,
      "maximumFeeRaw": "165600000000000",
      "maximumFee": "0.0001656",
      "observedAt": "2026-11-03T02:00:00.000Z"
    },
    "balance": {
      "blockNumber": "44000000",
      "blockHash": "0x…",
      "observedAt": "…",
      "rawBalance": "2000000000000000000",
      "displayBalance": "2",
      "rawNativeBalance": "2000000000000000000",
      "gasReserveRaw": "5000000000000000"
    },
    "swap": null,
    "dapp": {
      "origin": "https://app.example.org",
      "method": "eth_sendTransaction",
      "to": {
        "address": "0x00000000000000000000000000000000000000d1",
        "checksumAddress": "0x00000000000000000000000000000000000000D1",
        "isContract": true,
        "isVerified": false,
        "knownContract": null
      },
      "value": { "raw": "0", "display": "0" },
      "decodedCall": {
        "functionName": "approve",
        "selector": "0x095ea7b3",
        "standard": "erc20",
        "args": {
          "spender": "0x00000000000000000000000000000000000000c3",
          "amount": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        },
        "dataLength": 68
      },
      "counterparty": {
        "address": "0x00000000000000000000000000000000000000c3",
        "checksumAddress": "0x00000000000000000000000000000000000000C3",
        "isContract": false,
        "isVerified": false,
        "knownContract": null,
        "role": "spender"
      },
      "message": null,
      "typedData": null,
      "riskFlags": ["UNLIMITED_APPROVAL", "EOA_SPENDER", "UNVERIFIED_CONTRACT"]
    }
  },
  "simulation": {
    "status": "passed",
    "source": "rpc_call",
    "observedAt": "…",
    "reasonCode": null
  },
  "policy": {
    "configVersion": "bscWriteCanaryV1",
    "canaryMaxUsd": "20",
    "exposureBasis": "none",
    "exposureRaw": null,
    "exposureBlockNumber": null,
    "valueUsd": null,
    "priceSource": null,
    "priceFetchedAt": null
  },
  "signing": {
    "mode": "device_eth_send_transaction",
    "allowed": true,
    "reasonCode": null
  },
  "unsignedTransaction": {
    "chainId": 97,
    "from": "0x…a1",
    "to": "0x…d1",
    "data": "0x095ea7b3…",
    "value": "0x0",
    "gas": "0xd7a0",
    "nonce": "0x7",
    "type": "eip1559",
    "maxFeePerGas": "0xb2d05e00",
    "maxPriorityFeePerGas": "0x3b9aca00",
    "gasPrice": null
  },
  "authorizationPayload": null,
  "result": {
    "transactionHash": null,
    "providerActionId": null,
    "reasonCode": null,
    "receipt": null
  },
  "reviewSha256": "…",
  "factsObservedAt": "…",
  "expiresAt": "…（+120 s）",
  "version": "1",
  "createdAt": "…",
  "updatedAt": "…",
  "contractVersion": "2.0"
}
```

`review.dapp` 字段说明（确认页「dApp 版式」只读这里 + `fee` + `unsignedTransaction`）：

- `to` / `counterparty`：`isVerified = true` 仅当 LOOP 自己配置或索引了这个合约（`knownContract.kind`：
  `loopRouter` / `launch2PoolRouter` / `loopRouterRegistry` / `launch2Factory` / `launch2Instance`（`role` = meme / nft / curve / hook …，`label` = 项目名）/
  `launchContract` / `usd1` / `registryAsset`（`label` = 代币符号））。EOA 恒为 `isVerified: false`、`knownContract: null`。
- `counterparty`：解码出的授权对象 / 接收方（`role`: `spender` / `operator` / `recipient`），未解码则 `null`。
- `decodedCall`：`functionName = null` 表示未知方法（仍给 `selector` 与 `dataLength`）；`selector = null` 表示纯转账。
  `standard`：`erc20` / `erc721` / `permit2` / `loop` / `null`。`args` 全是字符串（地址小写、整数十进制、bool `"true"/"false"`、元组为 JSON 串，单值 ≤ 512 字符）。
- `riskFlags`（只在风险时出现，固定顺序；空数组 = 不显示风险条）：

| flag                      | 条件                                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNLIMITED_APPROVAL`      | ERC-20 `approve` / `increaseAllowance`、Permit2 `approve` 金额 ≥ 2^128；Permit 签名同理                                                                                           |
| `APPROVAL_FOR_ALL`        | `setApprovalForAll(operator, true)`                                                                                                                                               |
| `EOA_SPENDER`             | （S346）授权对象（`spender` / `operator`）没有合约代码：ERC-20 `approve` / `increaseAllowance` 金额 > 0、ERC-721 `approve`、`setApprovalForAll(true)`、Permit2 `approve` 金额 > 0 |
| `PERMIT_SIGNATURE`        | （仅 `dapp_sign`）EIP-2612 / DAI Permit、Permit2 签名                                                                                                                             |
| `RAW_HASH_SIGNATURE`      | （S346，仅 personal_sign）payload 是 0x hex、恰好 32 字节、且不是可读文本（`message.encoding = "hex"`）——形如哈希的盲签                                                           |
| `UNRECOGNIZED_TYPED_DATA` | （S346，仅 typed data）`primaryType` 不是 Permit 系（Seaport 订单、ForwardRequest、MetaTransaction、Delegation、登录消息等一律带）                                                |
| `UNVERIFIED_CONTRACT`     | `to` 或 `counterparty` 是合约且 `isVerified = false`；（S346）typed data 的 `domain.verifyingContract` 不在 LOOP 目录                                                             |
| `SIMULATION_FAILED`       | 预执行未通过（此时 `signing.allowed = false`）                                                                                                                                    |

`riskFlags` 是字符串数组；旧客户端遇到不认识的值只是不显示（不应解码失败）。新客户端对 S346 三个新值都应显示风险提示。

**预执行失败**：intent 仍创建（201），`state = "prepared"`、`signing.allowed = false`、`signing.reasonCode` 为
`BSC_CALL_REVERTED` / `GAS_ESTIMATE_UNAVAILABLE` / `SIMULATION_UNAVAILABLE`，`riskFlags` 含 `SIMULATION_FAILED`。
App 不弹签名，回页面 EIP-1193 错误（建议 `-32603`，message 可带 reasonCode）。

之后与 send 完全相同：Privy `eth_sendTransaction(unsignedTransaction)`（字段一个都不能改，`chainId` 是 **97**）→
把 tx hash 回给页面 → `POST /v2/wallet-intents/{intentId}/broadcast-report {txHash}` → 轮询到 `confirmed` / `reverted` / `unknown`。

## 5. `POST /v2/wallet-intents/dapp-sign`

请求：

```json
{
  "walletId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  "chainId": "eip155:97",
  "origin": "https://app.example.org",
  "method": "personal_sign",
  "payload": "0x6578616d706c652e6f72672077616e747320796f7520746f207369676e20696e"
}
```

- `method`：只 `personal_sign` / `eth_signTypedData_v4`。`eth_sign`、`eth_signTransaction` 400——App 应直接回页面 `4200`，不调服务端。
- `payload`：
  - personal_sign：页面 `params[0]` 原样（0x hex = 原始字节；其他字符串 = UTF-8 文本），≤ 16,384 字节；空 → 400。
  - eth_signTypedData_v4：页面 `params[1]`（JSON **字符串**，若页面给的是对象，App 用 `JSON.stringify`），≤ 32,768 字符。
    `domain.chainId` 必须存在（S346；缺失 → 422 `TYPED_DATA_INVALID`）且 = `chainId`（≠ → 422 `TYPED_DATA_CHAIN_MISMATCH`）；
    页面若自带 `types.EIP712Domain`，其字段集必须与 `domain` 中出现的键完全一致、类型为 EIP-712 规定类型（`name`/`version` string、
    `chainId` uint256、`verifyingContract` address、`salt` bytes32）、不重复，否则 422 `TYPED_DATA_INVALID`（S346：防止哈希不含 chainId
    而确认页仍显示 97）；不能按 EIP-712 哈希 → 422 `TYPED_DATA_INVALID`。

响应 `201` / `200`，差异字段：

```json
{
  "kind": "dapp_sign",
  "state": "awaiting_signature",
  "chainId": "eip155:97",
  "simulation": {
    "status": "unavailable",
    "source": "not_applicable",
    "observedAt": "…",
    "reasonCode": "SIGNATURE_NOT_SIMULATED"
  },
  "signing": {
    "mode": "device_personal_sign",
    "allowed": true,
    "reasonCode": null
  },
  "unsignedTransaction": null,
  "signatureRequest": {
    "method": "personal_sign",
    "params": [
      "0x6578616d706c652e6f72672077616e747320796f7520746f207369676e20696e",
      "0x…钱包地址"
    ]
  },
  "review": {
    "kind": "dapp_sign",
    "asset": {
      "assetId": "eip155:97:native",
      "address": null,
      "symbol": "tBNB",
      "decimals": 18
    },
    "amount": { "raw": "0", "display": "0" },
    "fee": null,
    "dapp": {
      "origin": "https://app.example.org",
      "method": "personal_sign",
      "to": null,
      "value": null,
      "decodedCall": null,
      "counterparty": null,
      "message": {
        "encoding": "utf8",
        "text": "example.org wants you to sign in",
        "hex": "0x6578…",
        "byteLength": 32
      },
      "typedData": null,
      "riskFlags": []
    }
  }
}
```

typed data 时 `signing.mode = "device_sign_typed_data_v4"`，`signatureRequest.params = [地址, typedDataJson]`，`review.dapp.typedData`：

```json
{
  "primaryType": "Permit",
  "domain": {
    "name": "USD1",
    "version": "1",
    "chainId": "97",
    "verifyingContract": "0x…d1",
    "salt": null
  },
  "fields": [
    { "path": "owner", "type": "address", "value": "0x…", "truncated": false },
    {
      "path": "spender",
      "type": "address",
      "value": "0x…c3",
      "truncated": false
    },
    {
      "path": "value",
      "type": "uint256",
      "value": "115792…639935",
      "truncated": false
    },
    { "path": "nonce", "type": "uint256", "value": "0", "truncated": false },
    {
      "path": "deadline",
      "type": "uint256",
      "value": "1900000000",
      "truncated": false
    }
  ],
  "fieldsTruncated": false
}
```

此例 `riskFlags = ["UNLIMITED_APPROVAL", "PERMIT_SIGNATURE", "UNVERIFIED_CONTRACT"]`（verifyingContract 是外部代币）。嵌套字段 `path` 为 `details.amount`、数组为 `tokens[0]`；
叶子 ≤ 256 个、单值 ≤ 1,024 字符（超出 `truncated` / `fieldsTruncated` 为 true——确认页可提示「内容过长已截断」，待签原文仍完整在 `signatureRequest`）。

签名：App 把 `signatureRequest` 原样交给 Privy embedded provider（`request(method, params)`），得到签名后：
先回给页面，再调 §6 回报。确认页展示内容与 `signatureRequest` 同源，任何字段都不能改。

注意：同一钱包同一时刻只有一个 open intent。DApp prepare（dapp-tx / dapp-sign）只顶替 open 的 `dapp_tx` / `dapp_sign`
（置为 `expired / INTENT_SUPERSEDED`）——页面并发发起多个签名请求时 App 要排队。**S346**：若钱包上有未过期的 open
send / swap / approve / send_nft（用户正在别处审查），DApp prepare 不顶替它，返回 `409 RESOURCE_CONFLICT` /
`detailsSafe.reasonCode = "INTENT_BUSY"`——App 映射为「钱包有待处理的操作」，回页面 EIP-1193 `4001` 或 `-32603`，
不弹签名。send / swap / approve / send_nft 的 prepare 仍照旧顶替一切 open intent（含 DApp 的）。

## 6. `POST /v2/wallet-intents/{intentId}/signature-report`

请求 `{ "signature": "0x<130 hex>" }`（65 字节；大小写均可）。

- 服务端对 `signatureRequest` ecrecover：签名者 = intent 钱包 → `200`，`state = "confirmed"`（`result.transactionHash = null`）。
- 签名者不符 / 无法恢复 → `422 VALIDATION_FAILED` / `SIGNATURE_MISMATCH`（不改状态）。
- 已 `confirmed` 再报 → `200` 原样（幂等）。intent 已过期 / 被顶替 / 已取消时仍记录为 `confirmed`（签名已存在）。
- 非 `dapp_sign` → `422 VALIDATION_FAILED`；签名格式不对 → `400`。
- 服务端只保存签名的 SHA-256（审计事件），不保存签名本身。回报失败不影响页面已拿到的签名，App 可重试或忽略。

## 7. `POST /v2/chain/rpc-read`

请求：

```json
{
  "chainId": "eip155:97",
  "method": "eth_call",
  "params": [{ "to": "0x…", "data": "0x70a08231…" }, "latest"]
}
```

- `chainId`：`eip155:56` 或 `eip155:97`；其他 422 `CHAIN_MISMATCH`。
- `method` 白名单：`eth_chainId`（服务端本地应答）、`eth_blockNumber`、`eth_call`、`eth_getBalance`、`eth_getCode`、
  `eth_getTransactionReceipt`、`eth_getTransactionByHash`、`eth_estimateGas`、`eth_gasPrice`、`eth_getLogs`、
  `eth_getBlockByNumber`、`eth_feeHistory`（S342 联调补：viem / ethers 估费前必读）。
  其他 → 422 / `RPC_METHOD_NOT_ALLOWED`（App 回页面 `4200`）。`eth_accounts` / `eth_requestAccounts` / `eth_chainId` 的连接语义仍由 App 本地处理。
- `params`：缺省 `[]`，≤ 3 项，逐方法校验（call 对象只认 `from/to/data/input/value/gas/gasPrice/maxFeePerGas/maxPriorityFeePerGas`；
  不支持第 3 参 state override；块参数为标签或 hex）→ 不合格 400。
- `eth_getBlockByNumber`：`[块标签或 hex, fullTransactions?]`——S346 起只转发交易哈希列表：缺省或 `false` 按 `false` 转发，`true` → 400。
- `eth_feeHistory`：`[blockCount（hex 或整数，1…128；S346 由 1,024 收紧）, 块标签或 hex（不收 pending）, rewardPercentiles?（≤ 100 个 0…100 的非递减数）]`，不合格 400。
- `eth_getLogs`：**必须带非空 `address`**（S346；单个地址或 1…20 个的数组；缺失 / `null` / `[]` → 400）；`blockHash` 单独用，或
  `fromBlock` / `toBlock` 跨度 ≤ 1,000 块（标签按服务端 head 解析，`earliest` 视为 0），否则 422 / `RPC_LOG_RANGE_TOO_LARGE`
  （`detailsSafe.maximumBlockSpan = "1000"`）；`topics` ≤ 4 位、每位 ≤ 20 个。S346：服务端把解析出的块号以 hex 写回
  `fromBlock` / `toBlock` 再转发（节点读的就是校验过的区间）。
- 限流：每账户每分钟 `DAPP_RPC_READ_PER_MINUTE`（默认 120）；S346 另有进程级令牌桶 `DAPP_RPC_READ_GLOBAL_PER_MINUTE`
  （默认 1200，所有账户合计、只计真正打到节点的请求，`eth_chainId` 与被拒请求不计）。任一超出 → `429 RATE_LIMITED`（retryable）。App 应合并 / 节流页面轮询。

响应 `200`：

```json
{
  "chainId": "eip155:97",
  "method": "eth_call",
  "result": "0x000…2a",
  "error": null,
  "contractVersion": "2.0"
}
```

节点返回 JSON-RPC 错误时仍是 200：

```json
{
  "chainId": "eip155:97",
  "method": "eth_call",
  "result": null,
  "error": {
    "code": 3,
    "message": "execution reverted",
    "data": "0x08c379a0…"
  },
  "contractVersion": "2.0"
}
```

App 把 `result` 原样交给页面，或把 `error` 作为 EIP-1193 错误（`code` / `message` / `data`）抛给页面。
S346：`error.message` 只在 `code = 3` 或标准节点文案（`execution reverted…` / `insufficient funds…` / `gas required exceeds…` /
`intrinsic gas too low` / `nonce too low|high` / `out of gas` / `invalid opcode` / `header not found`）时原样，其他一律为固定文案
`"RPC request failed"`；`error.data` 只在是 hex 串（revert data）时给出，否则 `null`。
节点不可达 / 链未验证 → `503 CAPABILITY_UNAVAILABLE`（App 回 `-32603`，可重试）。
S346：节点额度 / 限流拒绝（HTTP 429、JSON-RPC `-32005` / `-32016` / `429` 或限流文案），或应答（`result` / `error` 的 JSON）超过
1 MiB → `503 CAPABILITY_UNAVAILABLE` / `RPC_UPSTREAM_LIMITED`（retryable；App 回页面 `-32005` 或 `-32603`，稍后重试）。

## 8. 错误码全集

| HTTP | code                             | `detailsSafe.reasonCode`                             | 出现于                                                                         |
| ---- | -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| 400  | `INVALID_REQUEST`                | —                                                    | 全部（形状 / headers / 参数）                                                  |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | —                                                    | 全部                                                                           |
| 403  | `POLICY_BLOCKED`                 | `COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST`               | dapp-tx（金丝雀对手名单非空时）                                                |
| 404  | `NOT_FOUND`                      | —                                                    | 钱包 / intent 不存在                                                           |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED`     | —                                                    | 全部                                                                           |
| 409  | `IDEMPOTENCY_CONFLICT`           | —                                                    | dapp-tx / dapp-sign                                                            |
| 409  | `INSUFFICIENT_BALANCE`           | —                                                    | dapp-tx（value + 最大 gas 费 > 余额）                                          |
| 409  | `DATA_STALE`                     | —                                                    | signature-report（状态已越过且不可迟到记录）                                   |
| 409  | `RESOURCE_CONFLICT`              | `INTENT_BUSY`                                        | dapp-tx / dapp-sign（S346：钱包上有 open 的 send / swap / approve / send_nft） |
| 422  | `VALIDATION_FAILED`              | `CHAIN_SIGNING_DISABLED`                             | dapp-tx / dapp-sign（eip155:56）                                               |
| 422  | `VALIDATION_FAILED`              | `ORIGIN_NOT_HTTPS`                                   | dapp-tx / dapp-sign                                                            |
| 422  | `VALIDATION_FAILED`              | `TYPED_DATA_CHAIN_MISMATCH` / `TYPED_DATA_INVALID`   | dapp-sign                                                                      |
| 422  | `VALIDATION_FAILED`              | `SIGNATURE_MISMATCH`                                 | signature-report                                                               |
| 422  | `VALIDATION_FAILED`              | `RPC_METHOD_NOT_ALLOWED` / `RPC_LOG_RANGE_TOO_LARGE` | rpc-read                                                                       |
| 422  | `VALIDATION_FAILED`              | `null`                                               | 外部钱包；signature-report 对非 dapp_sign                                      |
| 422  | `CHAIN_MISMATCH`                 | —                                                    | 不支持的链                                                                     |
| 429  | `RATE_LIMITED`                   | —                                                    | rpc-read                                                                       |
| 500  | `INTERNAL_ERROR`                 | —                                                    | 全部                                                                           |
| 503  | `CAPABILITY_UNAVAILABLE`         | `DAPP_BROWSER_DISABLED`                              | dapp-tx / dapp-sign / rpc-read（开关关）                                       |
| 503  | `CAPABILITY_UNAVAILABLE`         | `DAPP_BROWSER_CHAIN_UNAVAILABLE`                     | slot 不是独立测试网 / client 不能转发                                          |
| 503  | `CAPABILITY_UNAVAILABLE`         | `RPC_UPSTREAM_LIMITED`                               | rpc-read（S346：节点额度 / 限流拒绝，或应答 > 1 MiB）                          |
| 503  | `CAPABILITY_UNAVAILABLE`         | `null`                                               | BSC 写开关关、链未验证、RPC 不可达                                             |

错误体恒为七字段：`code / category / retryable / userMessageKey / correlationId / detailsSafe / providerReferenceSafe`。

## 9. 列表兼容

`GET /v2/wallet-intents` 默认不返回 `dapp_tx` / `dapp_sign`；新 App 要看到必须带
`includeKinds=dapp_tx,dapp_sign`（可与 `send_nft` 组合，逗号分隔、不重复；cursor 绑定这个集合）。
新 App 的 intent codec 需要接受：`kind` 新值、`review.dapp`、顶层 `signatureRequest`、`signing.mode` 新值
`device_personal_sign` / `device_sign_typed_data_v4`、`simulation.source` 新值 `not_applicable`。

## 10. 未做 / 限制

- 外部 DApp 合约几乎都会带 `UNVERIFIED_CONTRACT`（LOOP 目录只含自家合约与 Asset Registry `verified` 资产）。
- 不做 ERC-1155 解码、`wallet_sendCalls`、SIWE 域名比对、GoPlus 筛查。
- BSC Mainnet 签名保持关闭，规则解除前不随配置变化。
